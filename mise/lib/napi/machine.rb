# frozen_string_literal: true

require 'digest'
require 'json'
require 'open3'

# The machine a benchmark ran on, as a signature: the fields that decide how
# fast the same build runs, and a short hash of them that keys stored
# results (bench/results/<hash>/). The same build measured about 30% apart
# on two days on one machine, so figures are only comparable under one
# signature, and best side by side (`mise run bench-compare`).
#
# Hashed: CPU model, core counts (performance and efficiency where the OS
# says), RAM, OS and version, architecture, the runtime and its version,
# and on macOS the power source and low-power mode. Not hashed, recorded per
# run: load average and thermal state (NapiMachine.conditions).
module NapiMachine
  module_function

  def run(*command)
    output, status = Open3.capture2e(*command)
    status.success? ? output.strip : nil
  rescue SystemCallError
    nil
  end

  def darwin? = RUBY_PLATFORM.include?('darwin')

  def sysctl(name) = run('sysctl', '-n', name)

  # The runtime's version, as `mise exec` resolves it in `dir`.
  def runtime_version(runtime, dir)
    Dir.chdir(dir) { run('mise', 'exec', '--', runtime, '--version') }
  end

  def hardware
    if darwin?
      {
        'cpu' => sysctl('machdep.cpu.brand_string'),
        'cores' => sysctl('hw.physicalcpu')&.to_i,
        'performanceCores' => sysctl('hw.perflevel0.physicalcpu')&.to_i,
        'efficiencyCores' => sysctl('hw.perflevel1.physicalcpu')&.to_i,
        'ramBytes' => sysctl('hw.memsize')&.to_i,
        'os' => "macOS #{run('sw_vers', '-productVersion')}",
        'arch' => run('uname', '-m')
      }
    else
      cpuinfo = File.exist?('/proc/cpuinfo') ? File.read('/proc/cpuinfo') : ''
      meminfo = File.exist?('/proc/meminfo') ? File.read('/proc/meminfo') : ''
      release = File.exist?('/etc/os-release') ? File.read('/etc/os-release')[/^PRETTY_NAME="?([^"\n]*)/, 1] : nil
      {
        'cpu' => cpuinfo[/^model name\s*:\s*(.*)$/, 1],
        'cores' => run('nproc')&.to_i,
        'ramBytes' => meminfo[/^MemTotal:\s*(\d+)/, 1]&.then { |kb| kb.to_i * 1024 },
        'os' => "#{release || run('uname', '-s')} (kernel #{run('uname', '-r')})",
        'arch' => run('uname', '-m')
      }
    end
  end

  # Power source and low-power mode change speed on a laptop.
  def power
    return {} unless darwin?

    source = run('pmset', '-g', 'ps')&.[](/Now drawing from '([^']+)'/, 1)
    low = run('pmset', '-g')&.[](/^\s*lowpowermode\s+(\d+)/, 1)
    { 'powerSource' => source, 'lowPowerMode' => low == '1' }
  end

  # { 'hash' => 12 hex digits, 'fields' => { ... } } for `runtime` in `dir`.
  def signature(runtime, dir)
    fields = hardware.merge(power).merge('runtime' => runtime, 'runtimeVersion' => runtime_version(runtime, dir))
    canonical = JSON.generate(fields.sort.to_h)
    { 'hash' => Digest::SHA256.hexdigest(canonical)[0, 12], 'fields' => fields.sort.to_h }
  end

  # Time-varying conditions, recorded with each run and never hashed.
  def conditions
    load = if darwin?
             sysctl('vm.loadavg')&.scan(/[\d.]+/)&.first(3)&.map(&:to_f)
           elsif File.exist?('/proc/loadavg')
             File.read('/proc/loadavg').split.first(3).map(&:to_f)
           end
    thermal = darwin? ? run('pmset', '-g', 'therm')&.[](/CPU_Speed_Limit\s*=\s*(\d+)/, 1)&.to_i : nil
    { 'loadAverage' => load, 'cpuSpeedLimit' => thermal }
  end
end
