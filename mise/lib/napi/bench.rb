# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'open3'
require 'time'
require 'tmpdir'
require_relative 'machine'

# Runs test/bench/tracing.js and turns its --json output into records keyed
# by machine signature (bench/results/README.md), for `mise run bench` and
# `mise run bench-compare`. Every record carries throughput and memory
# together; a report never gives one without the other.
module NapiBench
  ROOT = File.expand_path('../../..', __dir__)
  RESULTS = File.join(ROOT, 'bench', 'results')
  SCRIPT = File.join(ROOT, 'test', 'bench', 'tracing.js')
  RUNTIMES = %w[node bun].freeze

  module_function

  def git(*args, dir: ROOT)
    output, status = Open3.capture2('git', *args, chdir: dir)
    status.success? ? output.strip : nil
  end

  def commit(dir = ROOT) = git('rev-parse', '--short=7', 'HEAD', dir: dir)
  def dirty?(dir = ROOT) = !git('status', '--porcelain', dir: dir).to_s.empty?

  # Runs the bench `script` against the package in `dir`, with `runtime`:
  # each variant in a process of its own, because RSS measured after an
  # earlier variant's system closed reads memory the allocator kept. Returns
  # { 'runtime', 'records' } with one record per variant. `variants` is a
  # comma-separated filter (nil: every variant the script defines).
  def run(dir:, runtime:, population:, variants: nil, script: SCRIPT)
    Dir.mktmpdir('tinyactors-bench') do |tmp|
      local = File.join(dir, 'test', 'bench', '.bench-run.js')
      # The script requires '../..': run a copy inside `dir`, so an older
      # build is measured by today's script.
      FileUtils.cp(script, local)
      begin
        command = ['mise', 'exec', '--', runtime]
        command << '--expose-gc' if runtime == 'node'
        listed, status = Open3.capture2(*command, local, '--list', chdir: dir)
        abort "tinyactors-napi: listing the bench's variants failed (#{runtime})" unless status.success?
        wanted = variants&.split(',')&.map(&:strip)
        names = JSON.parse(listed).select { |name| wanted.nil? || name == 'untraced' || wanted.include?(name) }
        results = names.map.with_index do |name, at|
          out = File.join(tmp, "#{at}.json")
          log, status = Open3.capture2e(*command, local, population.to_s, "--variants=#{name}", '--exclusive',
                                        "--json=#{out}", chdir: dir)
          abort "tinyactors-napi: bench failed (#{runtime}, #{population}, #{name}):\n#{log}" unless status.success? && File.exist?(out)
          JSON.parse(File.read(out))
        end
        { 'runtime' => results.first&.fetch('runtime'), 'records' => results.flat_map { |result| result['records'] } }
      ensure
        FileUtils.rm_f(local)
      end
    end
  end

  # One stored record per variant: the signature, the build, the
  # conditions around the run, and the bench's throughput and memory.
  def records(result, signature:, commit:, dirty:, before:, after:)
    result['records'].map do |record|
      {
        'machine' => signature['hash'],
        'commit' => commit,
        'dirty' => dirty,
        'time' => Time.now.utc.iso8601,
        'runtime' => result['runtime'],
        'conditionsBefore' => before,
        'conditionsAfter' => after
      }.merge(record)
    end
  end

  # Appends records to bench/results/<signature>/<commit>.jsonl, and writes
  # the signature's readable fields beside them once.
  def store(records, signature)
    dir = File.join(RESULTS, signature['hash'])
    FileUtils.mkdir_p(dir)
    machine = File.join(dir, 'machine.json')
    File.write(machine, "#{JSON.pretty_generate(signature['fields'])}\n") unless File.exist?(machine)
    records.group_by { |record| record['commit'] }.each do |commit, group|
      File.open(File.join(dir, "#{commit}.jsonl"), 'a') do |file|
        group.each { |record| file.puts(JSON.generate(record)) }
      end
    end
    dir
  end

  # A number with thousands separators, or "-" when absent.
  def num(value, digits = 0)
    return '-' if value.nil?

    whole, fraction = format("%.#{digits}f", value).split('.')
    sign = whole.start_with?('-') ? '-' : ''
    grouped = whole.delete_prefix('-').reverse.scan(/\d{1,3}/).join(',').reverse
    fraction ? "#{sign}#{grouped}.#{fraction}" : "#{sign}#{grouped}"
  end

  COLUMNS = [
    ['events/s', ->(r) { num(r.dig('throughput', 'eventsPerSecondBest')) }],
    ['ns/event', ->(r) { num(r.dig('throughput', 'nsPerEvent')) }],
    ['core B/actor', ->(r) { num(r.dig('memory', 'coreBytesPerActor')) }],
    ['native B/actor', ->(r) { num(r.dig('memory', 'nativeBytesPerActor', 'total')) }],
    ['RSS B/actor', ->(r) { num(r.dig('memory', 'rssBytesPerActor')) }],
    ['heap B/actor', ->(r) { num(r.dig('memory', 'heapBytesPerActor')) }],
    ['alloc/event', ->(r) { num(r.dig('memory', 'allocatorCallsPerEvent'), 2) }],
    ['OTLP B/event', ->(r) { num(r.dig('memory', 'otlpBytesPerEvent')) }]
  ].freeze

  # A table of throughput and memory side by side, one row per variant.
  def table(records)
    rows = records.map do |record|
      next [record['variant'], "failed: #{record['error']}"] if record['error']

      [record['variant'], *COLUMNS.map { |_, value| value.call(record) }]
    end
    header = ['variant', *COLUMNS.map(&:first)]
    widths = header.each_index.map { |at| ([header] + rows).map { |row| row[at].to_s.length }.max }
    lines = [header, *rows].map do |row|
      row.each_with_index.map { |cell, at| at.zero? ? cell.to_s.ljust(widths[at]) : cell.to_s.rjust(widths[at]) }.join('  ')
    end
    lines.insert(1, widths.map { |width| '-' * width }.join('  '))
    lines.join("\n")
  end

  # Splits `args` into populations and a --variants filter.
  def parse(args)
    variants = args.find { |arg| arg.start_with?('--variants=') }&.delete_prefix('--variants=')
    runtimes = args.find { |arg| arg.start_with?('--runtimes=') }&.delete_prefix('--runtimes=')&.split(',')
    populations = args.reject { |arg| arg.start_with?('--') }
    populations = ['100000'] if populations.empty?
    { populations: populations.map(&:to_i), variants: variants, runtimes: runtimes || RUNTIMES }
  end
end
