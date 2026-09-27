# frozen_string_literal: true

require_relative 'api'

module NapiGen
  # The decisions in bindings.rb that the API description cannot make. Every
  # pattern must match something, so the policy cannot go stale unnoticed.
  class Policy
    TABLES = %i[HOOKED_FUNCTIONS PLUMBING_FUNCTIONS OVERRIDE_FUNCTIONS SKIP_FUNCTIONS OVERRIDE_TYPES INJECT_TYPES
                SKIP_TYPES NUMBER_TYPES RECLAIMED_BY_CORE RESULT_CODES].freeze

    def self.load(path)
      mod = Module.new
      mod.module_eval(File.read(path), path.to_s)
      constant = mod.constants.first or raise Error, "#{path} defines no module"
      new(mod.const_get(constant))
    end

    def initialize(mod)
      @mod = mod
      @used = Hash.new { |hash, key| hash[key] = {} }
      TABLES.each { |table| raise Error, "bindings.rb has no #{table}" unless mod.const_defined?(table) }
    end

    def hooked(name) = lookup(:HOOKED_FUNCTIONS, name)
    def plumbing(name) = lookup(:PLUMBING_FUNCTIONS, name)
    def override_function(name) = lookup(:OVERRIDE_FUNCTIONS, name)
    def skip_function(name) = lookup(:SKIP_FUNCTIONS, name)
    def override_type(name) = lookup(:OVERRIDE_TYPES, name)
    def inject_type(name) = lookup(:INJECT_TYPES, name)
    def skip_type(name) = lookup(:SKIP_TYPES, name)
    def number_type(name) = lookup(:NUMBER_TYPES, name)
    def reclaimed_by_core(handle) = lookup(:RECLAIMED_BY_CORE, handle)
    def result_code(symbol) = lookup(:RESULT_CODES, symbol)
    def flatten_parameter = @mod::FLATTEN_PARAMETER

    # Raises when an entry matched nothing during planning.
    def check_used!
      stale = TABLES.flat_map do |table|
        @mod.const_get(table).keys.reject { |pattern| @used[table][pattern] }.map { |pattern| "#{table} #{pattern}" }
      end
      raise Error, "bindings.rb entries match nothing: #{stale.join(', ')}" unless stale.empty?
    end

    private

    def lookup(table, name)
      pattern, value = @mod.const_get(table).find { |each, _| File.fnmatch(each, name, File::FNM_EXTGLOB) }
      return nil unless pattern

      @used[table][pattern] = true
      value
    end
  end
end
