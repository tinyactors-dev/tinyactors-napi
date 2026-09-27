# frozen_string_literal: true

require 'json'
require 'pathname'

module NapiGen
  Error = Class.new(StandardError)

  # Read access to tinyactors.api.json, the only input about the C API
  # (ADR 0013). The description is validated against core's schema with
  # core's own validator before anything reads it.
  class API
    FORMAT = 'tinyactors-api/2'
    CORE = Pathname.new(__dir__).join('../../../../tinyactors-core').expand_path
    DESCRIPTION = CORE.join('include/tinyactors.api.json')
    SCHEMA = CORE.join('include/tinyactors.api.schema.json')

    attr_reader :types, :functions

    def self.load(path = DESCRIPTION, schema: SCHEMA)
      description = JSON.parse(File.read(path))
      unless description['format'] == FORMAT
        raise Error, "#{path} is #{description['format'].inspect}; this generator reads #{FORMAT}"
      end

      problems = schema_errors(description, schema)
      raise Error, "#{path} does not match #{schema}:\n#{problems.first(20).join("\n")}" unless problems.empty?

      new(description)
    end

    # Core's schema validator raises API::Error; define it when only the
    # validator is loaded.
    def self.schema_errors(description, schema)
      unless defined?(::API::Schema)
        Object.const_set(:API, Module.new) unless defined?(::API)
        ::API.const_set(:Error, Class.new(StandardError)) unless ::API.const_defined?(:Error)
        require CORE.join('mise/lib/api/schema').to_s
      end
      ::API::Schema.load(schema.to_s).errors(description)
    end

    def initialize(description)
      @types = description.fetch('types')
      @functions = description.fetch('functions')
    end

    def type(name) = @types.fetch(name) { raise Error, "unknown type #{name}" }
    def kind(name) = type(name)['kind']

    # Follows aliases, keeping a const on the alias.
    def resolve(type)
      const = type['const']
      type = @types.fetch(type['type'])['type'] while type['type'] && @types.dig(type['type'], 'kind') == 'alias'
      const && !type['const'] ? type.merge('const' => true) : type
    end

    def pointer?(type) = resolve(type).key?('pointer')
    def pointee(type) = resolve(resolve(type)['pointer'])

    # The C spelling of a type, without const.
    def c_type(type)
      return "#{c_type(type['pointer'])} *" if type.key?('pointer')

      type['type'] || type['builtin'] || raise(Error, "no C spelling for #{type.inspect}")
    end

    # The alias name a field was declared with, before resolving, if any.
    def alias_name(type)
      name = type['type']
      name && kind(name) == 'alias' ? name : nil
    end
  end
end
