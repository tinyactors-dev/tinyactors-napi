# frozen_string_literal: true

require 'set'
require_relative 'api'
require_relative 'policy'

module NapiGen
  # Every decision the Node-API binding makes, taken from the API description
  # and the policy before any C is written (ADR 0013): which category each
  # function and type is in, how every argument is decoded and every output
  # encoded, what is released, and which hooks run. The emitter only formats
  # this plan. Anything the plan cannot map is an error that names the item.
  class Plan
    # How a value converts between JavaScript and C.
    #   :int      integers that cross as numbers (name = C type)
    #   :bigint   64-bit integers that cross as bigints
    #   :u64n     64-bit integers that cross as numbers (NUMBER_TYPES)
    #   :bool
    #   :enum     a symbol string (name = enum type)
    #   :runtime  ta_str and ta_bytes, hand-written in the runtime
    #   :override hand-written in the runtime (OVERRIDE_TYPES)
    #   :adapter  injected on input, described on output (INJECT_TYPES)
    #   :struct   generated
    Codec = Struct.new(:kind, :name, :ctype) do
      def id
        case kind
        when :u64n then 'u64n'
        else name
        end
      end
    end

    INTEGERS = %w[uint8_t uint16_t uint32_t int32_t int].freeze
    RUNTIME_SEMANTICS = { 'string' => 'ta_str', 'bytes' => 'ta_bytes' }.freeze
    RUNTIME_OVERRIDES = %w[ta_actor_id ta_actor_ref ta_value ta_expression ta_origin].freeze
    RUNTIME_ADAPTERS = %w[ta_allocator ta_datamodel].freeze

    # One member of a struct, or one argument. form:
    #   :value   by value (codec)
    #   :pointer a single `in` pointer (codec of the pointee)
    #   :handle  an `in` handle (handle name)
    #   :list    a terminated list (element codec, terminator condition)
    #   :array   a counted array (element codec, count member)
    #   :inject  an adapter the runtime fills (codec)
    #   :arena   the call arena
    #   :record  an anonymous struct inside a tagged union (fields)
    #   :output  an `out` member, only meaningful in a flattened params struct
    #   :derived a count, capacity or needed member of another member
    Field = Struct.new(:name, :form, :codec, :optional, :handle, :terminator, :count, :fields, :slot, :element_ctype,
                       keyword_init: true)

    Record = Struct.new(:name, :fields, :tagged, :zero_is_absent, :problems, keyword_init: true)
    Tagged = Struct.new(:tag, :enum, :union, :members, keyword_init: true)
    Member = Struct.new(:constant, :symbol, :field, keyword_init: true)

    # A function binding.
    Function_ = Struct.new(:name, :js, :category, :reason, :receiver, :args, :params_struct, :outputs, :buffer,
                           :result, :retire, :hook, :call, keyword_init: true)
    # A positional argument: `target` is the C lvalue it decodes into.
    Arg = Struct.new(:path, :field, :target, :pair, :decl, :required, keyword_init: true)
    # An output: `storage` is its local, `bind` how the call sees it.
    Output = Struct.new(:key, :form, :codec, :storage, :ctype, :bind, :valid, :releases, :handle, keyword_init: true)

    attr_reader :api, :policy, :records, :enums, :functions, :handles, :report, :decoders, :encoders, :list_decoders,
                :list_encoders, :array_decoders, :array_encoders, :result_codes

    def initialize(api, policy)
      @api = api
      @policy = policy
      @errors = []
      @records = {}
      @enums = []
      @functions = []
      @handles = {}
      @report = Hash.new { |hash, key| hash[key] = [] }
      @decoders = {}
      @encoders = {}
      @list_decoders = {}
      @list_encoders = {}
      @array_decoders = {}
      @array_encoders = {}
      plan_types
      plan_functions
      plan_result_codes
      reach_everything
      begin
        policy.check_used!
      rescue Error => e
        @errors << e.message
      end
      raise Error, @errors.uniq.join("\n") unless @errors.empty?
    end

    def record(name) = @records.fetch(name)

    private

    def error(path, message)
      @errors << "#{path}: #{message}"
      nil
    end

    # ------------------------------------------------------------------
    # Types

    def plan_types
      @api.types.each do |name, entry|
        case entry['kind']
        when 'alias' then @report[:types_alias] << name
        when 'handle'
          @report[:types_handle] << name
          @handles[entry['handle']] = handle_plan(name, entry)
        when 'view' then @report[:types_view] << name
        when 'enum'
          if (reason = @policy.skip_type(name)) then @report[:types_skipped] << [name, reason]
          else
            @enums << name
            @report[:types_bound] << name
          end
        when 'struct' then classify_struct(name, entry)
        else error(name, "unknown type kind #{entry['kind']}")
        end
      end
    end

    def handle_plan(name, entry)
      release = entry.fetch('destroyed_by', []).first&.fetch('function')
      { type: name, name: entry['handle'], release: release,
        reclaimed: !@policy.reclaimed_by_core(entry['handle']).nil? }
    end

    def classify_struct(name, entry)
      if (reason = @policy.skip_type(name))
        @report[:types_skipped] << [name, reason]
      elsif (reason = @policy.override_type(name))
        error(name, 'the runtime has no hand-written codec for this type') unless RUNTIME_OVERRIDES.include?(name)
        @report[:types_overridden] << [name, reason]
      elsif (reason = @policy.inject_type(name))
        error(name, 'the runtime cannot inject this type') unless RUNTIME_ADAPTERS.include?(name)
        @report[:types_injected] << [name, reason]
      elsif (runtime = RUNTIME_SEMANTICS[entry['semantic']])
        error(name, "the runtime has no #{entry['semantic']} codec for this type") unless runtime == name
        @report[:types_runtime] << name
      elsif entry['semantic'] == 'host_value'
        error(name, 'host values are overridden; name the type in OVERRIDE_TYPES')
      elsif %w[vtable adapter].include?(entry['semantic'])
        error(name, "#{entry['semantic']} types cannot cross into JavaScript; skip it in bindings.rb")
      else
        @records[name] = record_plan(name, entry)
        @report[:types_bound] << name
      end
    end

    def record_plan(name, entry)
      problems = []
      tagged = entry['tagged']
      common = entry['fields'].reject { |slot| tagged && [tagged['tag'], tagged['union']].include?(slot['name']) }
      fields = common.map { |slot| field_plan("#{name}.#{slot['name']}", slot, common, problems) }
      record = Record.new(name: name, fields: fields, zero_is_absent: entry['zero_is_absent'] == true, problems: problems)
      record.tagged = tagged_plan(name, entry, problems) if tagged
      error(name, "cannot cross into JavaScript: #{problems.join('; ')}; skip it in bindings.rb") unless problems.empty?
      record
    end

    def tagged_plan(name, entry, problems)
      tagged = entry['tagged']
      union = entry['fields'].find { |slot| slot['name'] == tagged['union'] }['type']['record']['fields']
      members = @api.type(tagged['enum'])['constants'].map do |constant|
        member = tagged['members'][constant['name']]
        field = if member
                  slot = union.find { |each| each['name'] == member }
                  field_plan("#{name}.#{tagged['union']}.#{member}", slot, union, problems)
                end
        Member.new(constant: constant['name'], symbol: constant['symbol'], field: field)
      end
      Tagged.new(tag: tagged['tag'], enum: tagged['enum'], union: tagged['union'], members: members)
    end

    # The plan of one struct member. `siblings` resolves counts.
    def field_plan(path, slot, siblings, problems)
      name = slot['name']
      return Field.new(name: name, form: :derived, slot: slot) if slot['count_of'] || slot['capacity_of'] || slot['needed_of']
      return Field.new(name: name, form: :output, slot: slot) if slot['direction'] == 'out'
      return Field.new(name: name, form: :arena, slot: slot) if slot['shape'] == 'arena'

      type = slot['type']
      if (record = type['record'])
        return problem(problems, path, 'an anonymous union outside a tagged struct') unless record['kind'] == 'struct'

        fields = record['fields'].map { |each| field_plan("#{path}.#{each['name']}", each, record['fields'], problems) }
        return Field.new(name: name, form: :record, fields: fields, slot: slot)
      end
      return value_field(path, name, type, slot, problems) unless @api.pointer?(type)

      target = @api.pointee(type)
      declared = @api.resolve(type)['pointer']
      case slot['shape']
      when 'single'
        codec = value_codec(path, declared, problems) or return nil
        Field.new(name: name, form: :pointer, codec: codec, optional: slot['optional'] == true, slot: slot)
      when 'handle'
        handle = @api.type(target['type'])['handle']
        Field.new(name: name, form: :handle, handle: handle, optional: slot['optional'] == true, slot: slot)
      when 'terminated'
        codec = value_codec(path, target, problems) or return nil
        Field.new(name: name, form: :list, codec: codec, terminator: terminator(target, slot['terminator']),
                  optional: slot['optional'] == true, slot: slot)
      when 'counted'
        codec = value_codec(path, target, problems) or return nil
        count = siblings.find { |each| each['name'] == slot['count'] } or return problem(problems, path, 'count member not found')
        Field.new(name: name, form: :array, codec: codec, count: slot['count'], optional: slot['optional'] == true,
                  element_ctype: @api.c_type(count['type']), slot: slot)
      else
        problem(problems, path, "a #{slot['shape'] || 'bare'} pointer")
      end
    end

    def value_field(path, name, type, slot, problems)
      resolved = @api.resolve(type)
      if (adapter = resolved['type']) && @api.kind(adapter) == 'struct' && @policy.inject_type(adapter)
        return Field.new(name: name, form: :inject, codec: Codec.new(:adapter, adapter, adapter), slot: slot)
      end

      codec = value_codec(path, type, problems) or return nil
      Field.new(name: name, form: :value, codec: codec, slot: slot)
    end

    def problem(problems, path, message)
      problems << "#{path}: #{message}"
      nil
    end

    # The codec for a value of `type` (not a pointer), or nil with a problem.
    def value_codec(path, type, problems)
      declared = type['type']
      resolved = @api.resolve(type)
      if declared && @policy.override_type(declared)
        return Codec.new(:override, declared, declared)
      end

      if (builtin = resolved['builtin'])
        return Codec.new(:bool, 'bool', 'bool') if builtin == 'bool'
        return Codec.new(:int, builtin, builtin) if INTEGERS.include?(builtin)
        return number_or_bigint(declared, builtin) if %w[uint64_t size_t].include?(builtin)

        return problem(problems, path, "no codec for #{builtin}")
      end
      name = resolved['type'] or return problem(problems, path, "no codec for #{resolved.inspect}")
      return Codec.new(:override, name, name) if @policy.override_type(name)

      entry = @api.type(name)
      return problem(problems, path, "#{name} is skipped") if @policy.skip_type(name)

      case entry['kind']
      when 'enum' then Codec.new(:enum, name, name)
      when 'struct'
        return Codec.new(:runtime, name, name) if RUNTIME_SEMANTICS.value?(name)
        return Codec.new(:adapter, name, name) if @policy.inject_type(name)
        return problem(problems, path, "#{name} is a #{entry['semantic']}") if entry['semantic']

        Codec.new(:struct, name, name)
      else problem(problems, path, "no codec for #{entry['kind']} #{name}")
      end
    end

    def number_or_bigint(declared, builtin)
      number = (declared && @policy.number_type(declared)) || @policy.number_type(builtin)
      return Codec.new(:int, 'size_t', 'size_t') if builtin == 'size_t' && number
      return Codec.new(:u64n, builtin, builtin) if number

      Codec.new(:bigint, builtin, builtin)
    end

    def terminator(target, member)
      type = @api.type(target['type'])['fields'].find { |each| each['name'] == member }['type']
      name = @api.resolve(type)['type']
      if @api.pointer?(type) then "item->#{member} == NULL"
      elsif name && RUNTIME_SEMANTICS.value?(name) then "item->#{member}.ptr == NULL"
      else "item->#{member} == 0"
      end
    end

    # ------------------------------------------------------------------
    # Functions

    def plan_functions
      @api.functions.each do |function|
        name = function['name']
        next unless function['public'] || function['static_inline']

        category, reason = classify_function(name)
        @report[:"functions_#{category}"] << [name, reason]
        next unless %i[bound hooked].include?(category)

        plan = function_plan(function, category, reason)
        @functions << plan if plan
      end
    end

    def classify_function(name)
      categories = []
      categories << [:skipped, @policy.skip_function(name)] if @policy.skip_function(name)
      categories << [:plumbing, @policy.plumbing(name)] if @policy.plumbing(name)
      categories << [:overridden, @policy.override_function(name)] if @policy.override_function(name)
      categories << [:hooked, @policy.hooked(name)] if @policy.hooked(name)
      error(name, "is in several categories: #{categories.map(&:first).join(', ')}") if categories.size > 1
      categories.first || [:bound, nil]
    end

    def function_plan(function, category, reason)
      name = function['name']
      result = result_plan(name, function['returns']) or return nil
      plan = Function_.new(name: name, js: name.delete_prefix('ta_'), category: category, reason: reason, args: [],
                           outputs: [], retire: [], result: result, call: [])
      function['params'].each do |param|
        path = "#{name}(#{param['name']})"
        if receiver?(param)
          error(path, 'the receiver must be the first parameter') unless plan.args.empty? && plan.receiver.nil?
          plan.receiver = param['name']
          plan.call << 'c->core'
        elsif flatten?(param)
          flatten(plan, path, param) or return nil
        else
          parameter(plan, path, param) or return nil
        end
      end
      plan.hook = hook_plan(plan, reason) if category == :hooked
      plan.buffer = plan.outputs.find { |output| output.form == :buffer }
      if plan.buffer && plan.outputs.size != 1
        return error(name, 'a caller buffer is supported only as the one output of a function')
      end

      plan
    end

    def receiver?(param)
      param['shape'] == 'handle' && @api.pointee(param['type'])['type'] == 'ta_system'
    end

    def flatten?(param)
      param['name'] == @policy.flatten_parameter && param['shape'] == 'single' && param['direction'] == 'in' &&
        param['optional'] != true && (struct = @api.pointee(param['type'])['type']) && @api.kind(struct) == 'struct'
    end

    def flatten(plan, path, param)
      struct = @api.pointee(param['type'])['type']
      record = @records[struct] or return error(path, "#{struct} is not bound, so #{plan.name} cannot be; classify one of them")
      return error(path, 'a tagged params struct cannot be flattened') if record.tagged

      plan.params_struct = struct
      plan.call << "&#{param['name']}"
      record.fields.each do |field|
        next unless field

        member = "#{param['name']}.#{field.name}"
        case field.form
        when :derived then next
        when :output then output(plan, "#{path}.#{field.name}", field.slot, member, struct) or return nil
        else input(plan, "#{path}.#{field.name}", field, member) or return nil
        end
      end
      true
    end

    def parameter(plan, path, param)
      name = param['name']
      if param['direction'] == 'out' || %w[handle_out view_out buffer].include?(param['shape'])
        output(plan, path, param, nil, nil) or return nil
        plan.call << "&o_#{name}"
        return true
      end

      problems = []
      field = field_plan(path, param, [], problems)
      return error(path, problems.join('; ')) unless problems.empty? && field

      input(plan, path, field, "a_#{name}")
      plan.args.last.decl = declaration(param['type'], "a_#{name}")
      plan.args.last.required = param['optional'] != true
      plan.call << "a_#{name}"
      if param['destroys']
        plan.retire << { index: plan.args.size - 1, on: nil }
      elsif param['consumed_on']
        plan.retire << { index: plan.args.size - 1, on: param['consumed_on'] }
      end
      true
    end

    # Adds the positional argument(s) that decode into `target`.
    def input(plan, path, field, target)
      case field.form
      when :inject, :arena
        plan.args << Arg.new(path: path, field: field, target: target, pair: false)
        return true
      when :value
        pair = field.codec.kind == :override && field.codec.name == 'ta_actor_id'
        plan.args << Arg.new(path: path, field: field, target: target, pair: pair, required: false)
      when :pointer, :handle, :list, :array
        plan.args << Arg.new(path: path, field: field, target: target, pair: false)
      else
        return error(path, "a #{field.form} member cannot be an argument")
      end
      true
    end

    def output(plan, path, slot, member, _struct)
      name = slot['name']
      storage = "o_#{name}"
      bind = member ? "#{member} = &#{storage};" : nil
      valid = valid_condition(slot)
      case slot['shape']
      when 'single'
        target = @api.resolve(slot['type'])['pointer']
        problems = []
        codec = value_codec(path, target, problems) or return error(path, problems.join('; '))
        plan.outputs << Output.new(key: name, form: :value, codec: codec, storage: storage, ctype: @api.c_type(target),
                                   bind: bind, valid: valid, releases: releases(slot, target, storage, valid))
      when 'handle_out'
        target = @api.resolve(@api.resolve(slot['type'])['pointer'])['pointer']
        handle = @api.type(target['type'])['handle']
        plan.outputs << Output.new(key: name, form: :handle, storage: storage, ctype: "#{target['type']} *", bind: bind,
                                   valid: valid, releases: [], handle: handle)
      when 'view_out'
        target = @api.resolve(@api.resolve(slot['type'])['pointer'])['pointer']
        problems = []
        codec = value_codec(path, target, problems) or return error(path, problems.join('; '))
        plan.outputs << Output.new(key: name, form: :view, codec: codec, storage: storage,
                                   ctype: "const #{@api.c_type(target)} *", bind: bind, valid: valid, releases: [])
      when 'buffer'
        return error(path, 'a caller buffer must be a params member') unless member

        buffer_output(plan, path, slot, member)
      else
        return error(path, "#{slot['shape']} outputs cannot cross into JavaScript")
      end
      true
    end

    def buffer_output(plan, path, slot, member)
      element = @api.resolve(slot['type'])['pointer']
      base = member.split('.').first
      problems = []
      codec = element['builtin'] == 'char' ? nil : value_codec(path, element, problems)
      return error(path, problems.join('; ')) unless problems.empty?

      plan.outputs << Output.new(key: slot['name'], form: :buffer, codec: codec, storage: member,
                                 ctype: @api.c_type(element), valid: nil, releases: [],
                                 bind: { capacity: "#{base}.#{slot['capacity']}", needed: "#{base}.#{slot['needed']}",
                                         text: element['builtin'] == 'char' })
    end

    # A C declaration of `name` with `type`, keeping the pointee's const.
    def declaration(type, name)
      resolved = @api.resolve(type)
      return "#{@api.c_type(type)} #{name}" unless resolved.key?('pointer')

      "#{resolved['pointer']['const'] ? 'const ' : ''}#{@api.c_type(resolved['pointer'])} *#{name}"
    end

    def valid_condition(slot)
      case slot['valid_on']
      when nil, 'success' then 'r == TA_OK'
      when 'always' then nil
      else "r == #{slot['valid_on']}"
      end
    end

    # Releases for an owned output value: the slot's own release, and owned
    # members held by value.
    def releases(slot, target, storage, _valid)
      list = []
      list << "#{slot['release']}(&#{storage});" if slot['release']
      list.concat(owned_members(target, storage))
      list
    end

    def owned_members(type, storage)
      name = @api.resolve(type)['type'] or return []
      entry = @api.type(name)
      return [] unless entry['kind'] == 'struct' && entry['semantic'].nil?

      entry['fields'].flat_map do |field|
        access = "#{storage}.#{field['name']}"
        if (release = field['release_if'])
          ["if (#{storage}.#{release['flag']}) #{release['function']}(&#{access});"]
        elsif field['release']
          ["#{field['release']}(&#{access});"]
        elsif !@api.pointer?(field['type']) && field['type']['type'] && @api.kind(field['type']['type']) == 'struct'
          owned_members(field['type'], access)
        else []
        end
      end
    end

    def result_plan(name, returns)
      type = returns['type']
      return { kind: :void } if type == { 'builtin' => 'void' }
      return error(name, 'returned pointers cannot cross into JavaScript; classify the function') if @api.pointer?(type)
      return { kind: :status } if returns['success'] == 'TA_OK' && type['type'] == 'ta_result'
      return error(name, "status results other than ta_result are not supported (#{type})") if returns['success']

      problems = []
      codec = value_codec(name, type, problems) or return error(name, problems.join('; '))
      { kind: :value, codec: codec, ctype: @api.c_type(type) }
    end

    def hook_plan(plan, entry)
      actor = entry.fetch(:actor)
      target = if actor == @policy.flatten_parameter
                 "&#{actor}" # the hook takes the whole params struct
               elsif actor.start_with?("#{@policy.flatten_parameter}.")
                 member = actor.split('.', 2).last
                 output = plan.outputs.find { |each| each.key == member }
                 output ? output.storage : "#{@policy.flatten_parameter}.#{member}"
               else
                 "a_#{actor}"
               end
      { name: "tna_hook_actor_#{entry.fetch(:hook)}", actor: target }
    end

    # ------------------------------------------------------------------
    # Results

    def plan_result_codes
      @result_codes = @api.type('ta_result')['constants'].map do |constant|
        symbol = constant['symbol']
        code = @policy.result_code(symbol) || symbol.delete_prefix('err_').tr('_', '-')
        [constant['name'], code]
      end
    end

    # ------------------------------------------------------------------
    # Reachability: which codecs the bound functions need.

    def reach_everything
      @functions.each do |function|
        function.args.each { |arg| reach_field_decode(arg.field) }
        function.outputs.each do |output|
          case output.form
          when :value, :view then reach_encode(output.codec)
          when :buffer then reach_array_encode(output.codec, 'uint32_t') if output.codec
          end
        end
        reach_encode(function.result[:codec]) if function.result[:kind] == :value
      end
    end

    def reach_field_decode(field)
      return unless field

      case field.form
      when :value, :pointer then reach_decode(field.codec)
      when :list
        reach_decode(field.codec)
        @list_decoders[field.codec.id] = [field.codec, field.terminator]
      when :array
        reach_decode(field.codec)
        @array_decoders[field.codec.id] = [field.codec, field.element_ctype]
      when :record then field.fields.each { |each| reach_field_decode(each) }
      end
    end

    def reach_decode(codec)
      return if @decoders.key?(codec.id)

      @decoders[codec.id] = codec
      return unless codec.kind == :struct

      record = @records[codec.name]
      record.fields.each { |field| check_nested(record.name, field, :decode) && reach_field_decode(field) }
      return unless record.tagged

      reach_decode(Codec.new(:enum, record.tagged.enum, record.tagged.enum))
      record.tagged.members.each { |member| reach_field_decode(member.field) }
    end

    def reach_field_encode(field)
      return unless field

      case field.form
      when :value, :pointer, :inject then reach_encode(field.codec)
      when :list
        reach_array_encode(field.codec, 'uint32_t')
        @list_encoders[field.codec.id] = [field.codec, field.terminator]
      when :array then reach_array_encode(field.codec, field.element_ctype)
      when :record then field.fields.each { |each| reach_field_encode(each) }
      end
    end

    def reach_array_encode(codec, count_ctype)
      reach_encode(codec)
      @array_encoders[codec.id] = [codec, count_ctype]
    end

    def reach_encode(codec)
      return if @encoders.key?(codec.id)

      @encoders[codec.id] = codec
      return unless codec.kind == :struct

      record = @records[codec.name]
      record.fields.each { |field| check_nested(record.name, field, :encode) && reach_field_encode(field) }
      return unless record.tagged

      reach_encode(Codec.new(:enum, record.tagged.enum, record.tagged.enum))
      record.tagged.members.each { |member| reach_field_encode(member.field) }
    end

    # Outputs and handles are only meaningful at the top level of a call.
    def check_nested(owner, field, direction)
      return false unless field
      return true unless %i[output handle].include?(field.form) || (field.form == :inject && direction == :decode && false)
      return false if field.form == :output && direction == :encode
      return true if field.form == :handle && direction == :decode

      error("#{owner}.#{field.name}", "a #{field.form} member cannot be #{direction}d inside another value")
      false
    end
  end
end
