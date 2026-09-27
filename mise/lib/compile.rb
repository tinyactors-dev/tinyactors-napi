# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'pathname'
require 'rbconfig'
require 'shellwords'
require 'cache'
require 'toolchain'

# The one compile command for the addon's C sources, the core amalgamation and
# the native tests. Every translation unit is compiled once to its own object
# under build/obj (Cache.compile reuses it while its inputs are unchanged), so
# `build` and `test-native` share objects instead of compiling core twice.
module NapiCompile
  ROOT = Cache::ROOT
  BUILD = ROOT.join('build')
  # TNA_SANITIZE=1 builds with AddressSanitizer and UBSan, into separate
  # object and binary directories so the two modes never evict each other.
  SANITIZE = ENV['TNA_SANITIZE'] == '1'
  SANITIZE_FLAGS = %w[-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=all -g].freeze
  # TNA_VALUES_MODEL=table builds value boxes as a handle table (ADR 0011
  # model B) instead of one napi_ref each, for the A/B measurement, into its
  # own object directory. The addon it links replaces the default one.
  VALUES_TABLE = ENV['TNA_VALUES_MODEL'] == 'table'
  OBJECTS = BUILD.join(SANITIZE ? 'obj-asan' : (VALUES_TABLE ? 'obj-table' : 'obj'))
  NATIVE = BUILD.join(SANITIZE ? 'native-asan' : 'native')
  CORE_DIR = ROOT.join('../tinyactors-core/include').expand_path
  CORE_SOURCE = CORE_DIR.join('tinyactors.c')
  # The SCXML codec and the XML reader it runs on, linked into the addon so
  # define() can import SCXML documents (napi ADR 0019). tinyxml's
  # amalgamation is committed, like core's.
  SCXML_DIR = ROOT.join('../tinyactors-scxml').expand_path
  XML_DIR = ROOT.join('../tinyxml/include').expand_path
  CODEC_SOURCES = [SCXML_DIR.join('src/ta_scxml.c'), XML_DIR.join('txml.c')].freeze

  module_function

  # The pinned Node-API headers (vendor/node-api-headers), not the ones of
  # the Node mise installed: every target compiles against the same
  # declarations, at NAPI_VERSION 10.
  NODE_API_INCLUDE = ROOT.join('vendor/node-api-headers/include')

  def version = JSON.parse(ROOT.join('package.json').read).fetch('version')

  def compiler = Shellwords.split(ENV.fetch('CC', 'cc'))

  # The warnings every build of the addon holds itself to.
  WARNINGS = %w[-std=c11 -Wall -Wextra -Werror -pedantic].freeze

  def defines_and_includes
    [
      '-DNAPI_VERSION=10',
      "-DTINYACTORS_NAPI_VERSION=\"#{version}\"",
      "-I#{NODE_API_INCLUDE}",
      "-I#{CORE_DIR}",
      "-I#{SCXML_DIR.join('include')}",
      "-I#{XML_DIR}",
      "-I#{ROOT.join('src')}"
    ]
  end

  # The compile command: for the host with $CC and $CFLAGS, as development
  # and the tests build; for a release target (mise/lib/toolchain.rb) with
  # the pinned `zig cc` and that target's fixed flags. A Linux target
  # compiles against musl's headers (ADR 0001 decision 10).
  def command(target = nil)
    @commands ||= {}
    @commands[target&.name] ||=
      if target.nil?
        [
          *compiler,
          *Shellwords.split(ENV.fetch('CFLAGS', "#{WARNINGS.join(' ')} -O2")),
          *(SANITIZE ? SANITIZE_FLAGS : []),
          *(VALUES_TABLE ? ['-DTNA_VALUES_TABLE'] : []),
          '-fPIC',
          *defines_and_includes
        ]
      else
        [Toolchain.zig, 'cc', '-target', target.triple, *Toolchain.cflags(target), *WARNINGS, *defines_and_includes]
      end
  end

  # The addon's own sources, adapters included.
  def sources = Cache.files('src/**/*.c')

  # Where a release target's objects and addon go: build/<target>/.
  def target_dir(target) = BUILD.join(target.name)

  def object_for(source, target = nil)
    source = Pathname.new(source)
    base = target.nil? ? OBJECTS : target_dir(target).join('obj')
    return base.join('core/tinyactors.o') if source == CORE_SOURCE
    return base.join('codec', source.basename.sub_ext('.o')) if CODEC_SOURCES.include?(source)

    base.join(source.relative_path_from(ROOT).sub_ext('.o'))
  end

  # Compiles each source for `target` (nil: the host), reusing cached
  # objects, and returns the objects.
  def objects(sources, target = nil)
    sources.map do |source|
      object = object_for(source, target)
      state, output = Cache.compile(command(target), source, object)
      if state == :failed
        warn output
        abort "tinyactors-napi: compiling #{source.relative_path_from(ROOT)} failed"
      end
      puts "compiled #{source.relative_path_from(ROOT)}" if state == :compiled
      object
    end
  end

  def core_object(target = nil) = objects([CORE_SOURCE], target).first

  def codec_objects(target = nil) = objects(CODEC_SOURCES, target)

  # Every object of the addon for `target`: its own sources, core and the
  # codec.
  def addon_objects(target = nil) = objects(sources, target) + [core_object(target)] + codec_objects(target)

  # Links the addon for a release target into build/<target>/tinyactors.node.
  # macOS leaves Node-API to the process that loads it (`-undefined
  # dynamic_lookup`) and links libSystem; Linux links no C library
  # (`-nostdlib`, no DT_NEEDED), so its libc functions bind to the libc Node
  # itself runs on, glibc or musl (ADR 0001 decision 10).
  def link_target(target)
    out = target_dir(target).join('tinyactors.node')
    FileUtils.rm_f(out)
    # Linux: -S drops the debug info zig cc emits by default (it is most of
    # the file); a Mach-O link keeps it out of the dylib on its own.
    flags = target.macos? ? %w[-Wl,-undefined,dynamic_lookup] : %w[-Wl,-S]
    Toolchain.shared(target, addon_objects(target), out, name: 'tinyactors.node', libc: target.macos?, flags: flags)
    puts "linked #{out.relative_path_from(ROOT)}"
    out
  end

  # Links `objects` into `output`, unless the same objects were linked the same
  # way last time and the output is still there.
  def link(objects, output, flags: [])
    link_command = [*compiler, *(SANITIZE ? SANITIZE_FLAGS : []), *flags, *objects.map(&:to_s), '-o', output.to_s]
    name = "link-#{output.relative_path_from(BUILD).to_s.tr('/', '_')}"
    key = Cache.digest(objects, link_command.join(' '), Cache.tool_id(compiler.first(1)))
    return if output.file? && Cache.stamped?(name, key)

    Cache.unstamp(name)
    FileUtils.rm_f(output)
    FileUtils.mkdir_p(output.dirname)
    puts link_command.shelljoin
    pid = Process.spawn(*link_command, chdir: ROOT.to_s)
    _pid, status = Process.wait2(pid)
    exit(status.exitstatus || 1) unless status.success?
    Cache.stamp(name, key)
  end

  # Whether the object's translation unit included node_api.h, directly or
  # through another header. Such an object cannot link outside a Node process.
  def uses_node_api?(object)
    dep = object.sub_ext('.d')
    Cache.dependencies(dep).any? { |header| File.basename(header) == 'node_api.h' }
  end

  # The only sources allowed to include node_api.h, directly or through a
  # header. Every other source is portable plumbing for a future host kernel
  # (docs/proposals/host-kernel.md) and must link, and be tested, without Node.
  NODE_API_SOURCES = %w[
    src/addon.c
    src/gen/ta_napi.c
    src/napi_children.c
    src/napi_datamodel.c
    src/napi_loads.c
    src/napi_services.c
    src/napi_system.c
    src/napi_trace.c
    src/pump.c
    src/runtime.c
    src/runtime_codecs.c
    src/values.c
  ].freeze

  # Splits the addon's objects into [portable, node_api] and aborts if the
  # split differs from NODE_API_SOURCES in either direction.
  def partition_node_api(sources)
    node_api, portable = sources.zip(objects(sources)).partition { |_source, object| uses_node_api?(object) }
    found = node_api.map { |source, _| source.relative_path_from(ROOT).to_s }.sort
    unexpected = found - NODE_API_SOURCES
    stale = NODE_API_SOURCES - found
    unless unexpected.empty?
      abort "tinyactors-napi: these sources include node_api.h but are not in " \
            "NapiCompile::NODE_API_SOURCES (mise/lib/compile.rb):\n  #{unexpected.join("\n  ")}\n" \
            'Keep Node-API out of the portable plumbing, or add the file to the list on purpose.'
    end
    unless stale.empty?
      abort "tinyactors-napi: these sources in NODE_API_SOURCES (mise/lib/compile.rb) no longer " \
            "include node_api.h; remove them from the list:\n  #{stale.join("\n  ")}"
    end
    [portable.map(&:last), node_api.map(&:last)]
  end

  def addon_link_flags
    case RbConfig::CONFIG.fetch('host_os')
    when /darwin/ then %w[-bundle -undefined dynamic_lookup]
    when /linux|bsd/ then %w[-shared]
    else abort 'tinyactors-napi: the build supports macOS, Linux, and BSD'
    end
  end
end
