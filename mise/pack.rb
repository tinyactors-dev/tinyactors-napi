# frozen_string_literal: true

# The npm packages (docs/adr/0001, decisions 10, 11, 14 and 15): one addon
# per native release target, built with the root's zig
# (Toolchain::Target.release) and checked by its symbols, each in a
# platform package, and the main package that lists them. The pack task
# (mise/tasks/pack/) and the release task (mise/tasks/release) both build
# through this file.
#
# - @tinyactors/node: the files package.json's `files` lists (index.mjs,
#   lib/ with the direct layer and the convenience layer, index.d.ts,
#   README.md, LICENSE, and the guides and docs/values.md, which the
#   README links to: test/links.test.mjs checks that every relative link
#   of a shipped document resolves inside the package) and a
#   package.json made from this directory's, with optionalDependencies on
#   every platform package at exactly its own version. They live only in
#   the staged copy: the repository's package.json cannot name packages
#   that are not published.
# - @tinyactors/node-<os>-<cpu>: tinyactors.node, with `os` and `cpu` and
#   no `libc` field (a Linux addon links no C library, so one file serves
#   glibc and musl), a README.md and LICENSE.
# - @tinyactors/wasm: the browser build at the same version (stage_wasm,
#   docs/browser.md, "Packaging and releases"), the WebAssembly module and
#   the layer's JavaScript, made by mise/wasm.rb.
#
# Each is packed with the pinned node's `npm pack`, which writes every
# entry with the same time and mode, so the same commit gives the same
# bytes.
require 'cache'
require 'fileutils'
require 'json'
require 'tmpdir'
require 'release'
require_relative 'napi'
require_relative 'wasm'

module NodeAPI
  module Pack
    NAME = '@tinyactors/node'
    # The browser build (docs/browser.md, "Packaging and releases"): a
    # sibling package at the same version, released with the addon's.
    WASM = '@tinyactors/wasm'
    # The release line's tags (the changelog component `napi`).
    TAG_PREFIX = 'tinyactors-napi/'
    PACKAGE_JSON = ROOT.join('package.json')
    LICENSE = ROOT.join('../LICENSE').expand_path
    # Where the release addons and their objects go, and the tarballs.
    RELEASE = BUILD.join('release')
    PACKAGES = BUILD.join('packages')
    # Each native release target: npm's os and cpu (process.platform and
    # process.arch, which lib/direct.mjs names the package by).
    TARGETS = {
      'aarch64-macos' => %w[darwin arm64],
      'x86_64-macos' => %w[darwin x64],
      'x86_64-linux' => %w[linux x64],
      'aarch64-linux' => %w[linux arm64]
    }.freeze
    # What the addon exports: the runtime that loads it finds it by these
    # names (NAPI_MODULE_INIT, Node.js's include/node/node_api.h).
    EXPORTS = %w[napi_register_module_v1 node_api_module_get_api_version_v1].freeze
    # The C library functions it calls, which the runtime's process has:
    # each has the same name in glibc and musl, so a Linux addon that links
    # no C library binds to either. The math functions (quickjs's) are in
    # glibc's libm, which node and bun link. On macOS libSystem has them,
    # malloc_size in place of malloc_usable_size; Darwin's clang calls bzero
    # and the fortified __memcpy_chk and __memmove_chk, and dyld binds
    # lazily. A new one fails the build until it is checked and listed (ADR
    # 0001, "Consequences").
    LIBC = %w[abort acos acosh asin asinh atan atan2 atanh bcmp calloc cbrt ceil clock_gettime cos cosh exp expm1
              fclose floor fmod fopen fprintf fputc fread free frexp fseek ftell fwrite gettimeofday hypot
              localtime_r log log10 log1p log2 malloc malloc_usable_size memchr memcmp memcpy memmove memset pow
              printf qsort realloc round scalbn sin sinh snprintf sscanf strchr strcmp strlen strncmp strrchr
              strstr strtod tan tanh trunc vsnprintf].freeze
    DARWIN = %w[bzero __bzero __memcpy_chk __memmove_chk malloc_size dyld_stub_binder].freeze
    # Node-API's functions, which the runtime provides.
    NODE_API_SYMBOL = /\A(napi_|node_api_)/

    module_function

    def fail!(message)
      abort "pack: #{message}"
    end

    def target_names = TARGETS.keys

    def manifest = JSON.parse(PACKAGE_JSON.read)

    # The main package's files and directories, beside its package.json:
    # package.json's `files`, which the link test reads too.
    def files = manifest.fetch('files')

    def platform_name(target) = "#{NAME}-#{TARGETS.fetch(target).join('-')}"

    def names = [NAME, *target_names.map { |target| platform_name(target) }, WASM]

    # npm pack's file name for `name` at `version`.
    def tarball_name(name, version) = "#{name.delete_prefix('@').tr('/', '-')}-#{version}.tgz"

    # zig cc writes debug information unless told not to, and the Mach-O
    # linker then records each object's absolute path and time in the addon
    # (its OSO stabs), so two builds of one commit differed: the packages
    # carry no debug information (-g0), on every target alike.
    RELEASE_FLAGS = %w[-g0].freeze

    def compile(target, source, object, flags)
      command = target.compile_command(*RELEASE_FLAGS, *flags)
      outcome, output = Cache.compile(command, source, object)
      return object unless outcome == :failed

      warn output
      fail!("#{Pathname.new(source).relative_path_from(ROOT)} does not compile for #{target}")
    end

    # The addon for one release target, build/release/<target>/tinyactors.node:
    # core's amalgamation, txml and src/ compiled with zig for the target
    # and linked as a module the runtime loads (Target#plugin), then
    # checked. Answers its path.
    def build(name)
      target = Toolchain::Target.release(name)
      dir = RELEASE.join(name)
      core = CORE_SOURCES.map do |file, flags|
        compile(target, CORE_BUILD.join(file), dir.join('objects/core', file.sub(/\.c\z/, '.o')),
                [*flags, "-I#{CORE_BUILD}"])
      end
      txml = compile(target, TXML.join('txml.c'), dir.join('objects/txml/txml.o'), [*TXML_FLAGS, "-I#{TXML}"])
      generated = NodeAPI.embed_realm.dirname
      own = NodeAPI.sources.map do |source|
        object = dir.join('objects/addon', source.relative_path_from(ROOT.join('src')).sub_ext('.o'))
        compile(target, source, object, [*ADDON_FLAGS, "-I#{CORE_BUILD}", "-I#{TXML}", "-I#{generated}",
                                         "-I#{NodeAPI.node_headers}"])
      end
      addon = dir.join('tinyactors.node')
      target.plugin([*core, txml, *own].map(&:to_s), into: addon.to_s)
      verify!(target, addon)
      addon
    end

    # The addon is for its target, loads no shared library (the C library
    # and Node-API are the process's, which is what lets one Linux file
    # serve glibc and musl), exports only the module's entry points, and
    # leaves undefined only Node-API and the listed C library functions.
    def verify!(target, addon)
      binary = Toolchain::Binary.new(addon)
      binary.must_be_for!(target)
      binary.must_load_only!([])
      binary.must_export_exactly!(EXPORTS)
      libc = target.format.links_libc ? LIBC + DARWIN : LIBC
      binary.must_leave_undefined_only!(binary.undefined.to_a.grep(NODE_API_SYMBOL) + libc)
      node_api = binary.undefined.count { |symbol| symbol.match?(NODE_API_SYMBOL) }
      puts "pack: #{target}: exports #{EXPORTS.join(', ')}; #{node_api} Node-API and " \
           "#{binary.undefined.size - node_api} C library imports"
    rescue Toolchain::Binary::Mismatch => e
      fail!("#{addon.relative_path_from(ROOT)}: #{e.message}. A C library function joins LIBC (mise/pack.rb) " \
            'once it has the same name, arguments and types in glibc and musl, and exists in libSystem')
    end

    # The fields every package shares, from this directory's package.json.
    def shared(manifest, version) = { 'version' => version, **manifest.slice('license', 'homepage', 'repository', 'bugs', 'engines') }

    # The export condition `tinyactors-wasm` maps the package's name and
    # `#direct` to the wasm package's files in the repository, for the
    # shared tests (docs/browser.md, "One API"); @tinyactors/node ships
    # without them, so the staged package drops it.
    def without_wasm(map)
      map.transform_values { |conditions| conditions.is_a?(Hash) ? conditions.except('tinyactors-wasm') : conditions }
    end

    # Stages the main package in `dir`: its files and a package.json listing
    # every platform package at `version`.
    def stage_main(dir, version)
      FileUtils.mkdir_p(dir)
      files.each do |file|
        FileUtils.mkdir_p(dir.join(file).dirname)
        FileUtils.cp_r(file == 'LICENSE' ? LICENSE : ROOT.join(file), dir.join(file))
      end
      staged = manifest.merge(
        'version' => version,
        'exports' => without_wasm(manifest.fetch('exports')),
        'imports' => without_wasm(manifest.fetch('imports')),
        'optionalDependencies' => target_names.to_h { |target| [platform_name(target), version] }
      )
      dir.join('package.json').write("#{JSON.pretty_generate(staged)}\n")
    end

    # Stages the platform package of `target` in `dir`, with `addon`.
    def stage_platform(dir, target, addon, version)
      os, cpu = TARGETS.fetch(target)
      name = platform_name(target)
      FileUtils.mkdir_p(dir)
      FileUtils.cp(addon, dir.join('tinyactors.node'))
      FileUtils.cp(LICENSE, dir.join('LICENSE'))
      package = {
        'name' => name,
        'description' => "The #{os}-#{cpu} addon of #{NAME}",
        **shared(manifest, version),
        'os' => [os],
        'cpu' => [cpu],
        'main' => 'tinyactors.node',
        'files' => %w[tinyactors.node LICENSE README.md]
      }
      dir.join('package.json').write("#{JSON.pretty_generate(package)}\n")
      dir.join('README.md').write(<<~README)
        # #{name}

        The #{os}-#{cpu} addon of [#{NAME}](https://www.npmjs.com/package/#{NAME}).
        Install `#{NAME}`, not this package: it lists the addon of each
        platform as an optional dependency, and npm, pnpm and Bun install only
        the one that matches.
      README
    end

    # npm pack of the staged directory `dir` into `out`; answers the tarball.
    def npm_pack(dir, out)
      name = JSON.parse(dir.join('package.json').read).values_at('name', 'version')
      # it prints the tarball's name, which build_all prints with its size
      ok = system(NodeAPI.pinned('npm'), 'pack', '--silent', '--pack-destination', out.to_s, dir.to_s,
                  chdir: ROOT.to_s, out: File::NULL)
      fail!("npm pack #{dir} failed") unless ok
      tarball = out.join(tarball_name(*name))
      fail!("npm pack did not write #{tarball.basename}") unless tarball.file?
      tarball
    end

    # The packages for `version`: every target of `names` built and
    # checked, its platform package and the main package packed into
    # `out`, platform packages first (the order they are published in),
    # and @tinyactors/wasm at the same version. Answers {target name, NAME
    # or WASM => tarball}, after checking that every tarball holds `version`.
    def build_all(names, version:, out:)
      Release.parse_version(version)
      fail!("#{LICENSE} is missing") unless LICENSE.file?
      addons = names.to_h { |name| [name, build(name)] }
      FileUtils.rm_rf(out)
      FileUtils.mkdir_p(out)
      Dir.mktmpdir('tinyactors-pack') do |staging|
        staging = Pathname.new(staging)
        tarballs = addons.to_h do |name, addon|
          dir = staging.join(name)
          stage_platform(dir, name, addon, version)
          [name, npm_pack(dir, out)]
        end
        stage_main(staging.join('main'), version)
        tarballs[NAME] = npm_pack(staging.join('main'), out)
        tarballs[WASM] = pack_wasm(version, staging.join('wasm'), out)
        same_version!(tarballs, version)
        tarballs.each_value { |tarball| puts format('pack: %8.1f KiB  %s', tarball.size / 1024.0, tarball.relative_path_from(ROOT)) }
        tarballs
      end
    end

    # The manifest inside a tarball, as npm will read it.
    def packed_manifest(tarball) = JSON.parse(Toolchain::Tool[:tar].run('-xzOf', tarball.to_s, 'package/package.json'))

    # Every tarball holds `version`: the packages are one release.
    def same_version!(tarballs, version)
      tarballs.each_value do |tarball|
        found = packed_manifest(tarball).fetch('version')
        fail!("#{tarball.basename} holds version #{found}, not #{version}") unless found == version
      end
      puts "pack: #{tarballs.size} packages, all at #{version}"
    end

    # @tinyactors/wasm, staged from wasm/ (docs/browser.md, "Packaging and
    # releases"): the module and the layer's files at the package's root,
    # where wasm/lib/module.mjs finds tinyactors.wasm beside lib/, and the
    # convenience layer beside the direct one. A page and a module Worker
    # read no package.json, so the subpath import `#direct` that
    # lib/convenience.mjs names is written as the relative path of the
    # direct layer (a Worker has no import map either), and the entries'
    # `../lib/convenience.mjs` as `./lib/convenience.mjs`. The realm's
    # script (lib/realm-script.mjs) and the module are generated by the
    # build (WebModule.build), not in git.
    WASM_FILES = %w[index.mjs init.mjs init.d.ts].freeze
    WASM_README = WebModule::ROOT.join('README.md')

    def rewrite!(path, from, to)
      text = path.read
      fail!("#{path.basename}: no #{from.inspect} to rewrite") unless text.include?(from)
      path.write(text.gsub(from, to))
    end

    def stage_wasm(dir, version)
      FileUtils.mkdir_p(dir.join('lib'))
      WASM_FILES.each { |file| FileUtils.cp(WebModule::ROOT.join(file), dir.join(file)) }
      WebModule::ROOT.glob('lib/*.mjs').each { |file| FileUtils.cp(file, dir.join('lib', file.basename)) }
      FileUtils.cp(ROOT.join('lib/convenience.mjs'), dir.join('lib/convenience.mjs'))
      FileUtils.cp(WebModule::MODULE, dir.join('tinyactors.wasm'))
      FileUtils.cp(ROOT.join('index.d.ts'), dir.join('index.d.ts'))
      FileUtils.cp(WASM_README, dir.join('README.md'))
      FileUtils.cp(LICENSE, dir.join('LICENSE'))
      rewrite!(dir.join('lib/convenience.mjs'), "from '#direct'", "from './direct.mjs'")
      %w[index.mjs init.mjs].each { |entry| rewrite!(dir.join(entry), "'../lib/convenience.mjs'", "'./lib/convenience.mjs'") }
      rewrite!(dir.join('init.d.ts'), "from '../index.js'", "from './index.js'")
      fail!('lib/realm-script.mjs was not generated (WebModule.build)') unless dir.join('lib/realm-script.mjs').file?
      leftover = dir.glob('**/*.mjs').select { |file| file.read.match?(/from '(#direct|\.\.\/)/) }
      fail!("staged files still import outside the package: #{leftover.map(&:basename).join(', ')}") unless leftover.empty?
      package = {
        'name' => WASM,
        'version' => version,
        'description' => 'SCXML statecharts as actors on the tinyactors host, in the browser, Node.js and Bun ' \
                         '(WebAssembly; the API of @tinyactors/node)',
        'keywords' => %w[actor actors statechart scxml state-machine wasm webassembly browser],
        **manifest.slice('homepage', 'repository', 'bugs', 'license', 'engines'),
        'type' => 'module',
        'types' => './index.d.ts',
        'exports' => {
          '.' => { 'types' => './index.d.ts', 'default' => './index.mjs' },
          './init' => { 'types' => './init.d.ts', 'default' => './init.mjs' },
          './tinyactors.wasm' => './tinyactors.wasm',
          './package.json' => './package.json'
        },
        'sideEffects' => false,
        'files' => [*WASM_FILES, 'lib', 'tinyactors.wasm', 'index.d.ts', 'README.md', 'LICENSE']
      }
      dir.join('package.json').write("#{JSON.pretty_generate(package)}\n")
    end

    # Builds the module (WebModule.build: its imports and exports checked),
    # stages and packs @tinyactors/wasm into `out`; answers the tarball.
    def pack_wasm(version, dir, out)
      report = WebModule.build
      puts "pack: tinyactors.wasm #{report.fetch('bytes')} B"
      stage_wasm(dir, version)
      npm_pack(dir, out)
    end

    # The sizes of a packed @tinyactors/wasm: the tarball, its files
    # unpacked, and the module raw, gzip -9 and brotli 11 (what a server
    # sends), as npm and a CDN would see them. Answers a Hash.
    def wasm_sizes(tarball)
      list = Toolchain::Tool[:tar].run('-tzvf', tarball.to_s)
      unpacked = list.lines.sum { |line| line.split[2].to_i }
      wasm = Toolchain::Tool[:tar].run('-xzOf', tarball.to_s, 'package/tinyactors.wasm', binary: true)
      compressed = IO.popen([NodeAPI.pinned('node'), '-e', <<~JS], 'r+b') do |io|
        const z = require('node:zlib'); const b = require('node:fs').readFileSync(0);
        const brotli = z.brotliCompressSync(b, { params: { [z.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
        process.stdout.write(JSON.stringify({ gzip: z.gzipSync(b, { level: 9 }).length, brotli }));
      JS
        io.write(wasm)
        io.close_write
        JSON.parse(io.read)
      end
      { 'packed' => tarball.size, 'unpacked' => unpacked, 'wasm' => wasm.bytesize, **compressed }
    end

    def print_wasm_sizes(tarball)
      sizes = wasm_sizes(tarball)
      kib = ->(bytes) { format('%.1f KiB', bytes / 1024.0) }
      puts "pack: #{WASM}: packed #{kib.(sizes['packed'])}, unpacked #{kib.(sizes['unpacked'])}; " \
           "tinyactors.wasm #{kib.(sizes['wasm'])} raw, #{kib.(sizes['gzip'])} gzip -9, #{kib.(sizes['brotli'])} brotli 11"
      sizes
    end

    # @tinyactors/wasm installed by path into a fresh project outside the
    # repository, once with npm and run by node, once with bun and run by
    # bun (tools/smoke-wasm.mjs, both entries), and the npm project served
    # to Chromium, a page and a module Worker under the guide's policy
    # (tools/smoke-wasm-browser.mjs), then bundled by esbuild and by Vite
    # from npm, each bundle in Chromium (tools/smoke-wasm-bundlers.mjs).
    def smoke_wasm!(tarball)
      npm = NodeAPI.pinned('npm')
      [
        [[npm, 'install', '--no-audit', '--no-fund', '--silent'], NodeAPI.pinned('node'), true],
        [[NodeAPI.pinned('bun'), 'add', '--silent'], NodeAPI.pinned('bun'), false]
      ].each do |install, runtime, browser|
        Dir.mktmpdir('tinyactors-smoke-wasm') do |dir|
          File.write(File.join(dir, 'package.json'), "{\"name\": \"smoke\", \"private\": true, \"type\": \"module\"}\n")
          %w[smoke-wasm.mjs smoke-wasm-check.mjs].each { |file| FileUtils.cp(ROOT.join('tools', file), dir) }
          NodeAPI.run(*install, tarball.to_s, chdir: dir)
          NodeAPI.run(runtime, 'smoke-wasm.mjs', chdir: dir)
          next unless browser

          chromium = Pathname.new('/opt/pw-browsers/chromium')
          env = chromium.executable? ? { 'PLAYWRIGHT_CHROMIUM' => chromium.to_s } : {}
          NodeAPI.run(NodeAPI.pinned('node'), ROOT.join('tools/smoke-wasm-browser.mjs').to_s, dir, env: env)
          NodeAPI.run(NodeAPI.pinned('node'), ROOT.join('tools/smoke-wasm-bundlers.mjs').to_s, dir, env: env)
        end
      end
    end

    # The smoke tests resolve every symbol when the addon is loaded, not
    # when a function is first called: a C library function the runtime's
    # process lacks fails the import, not a later run. macOS's dyld ignores it.
    BIND_NOW = { 'LD_BIND_NOW' => '1' }.freeze

    # The main package and this machine's platform package, installed by
    # path into a fresh project outside the repository, once with npm and
    # run by node, once with bun and run by bun: tools/smoke.mjs there. The
    # other platform packages are optional and skipped, as in a real
    # install on this machine.
    def smoke_here!(tarballs)
      here = Toolchain::Host.current.target.name
      platform = tarballs[here] or fail!("this machine's target (#{here}) was not packed: no smoke test")
      main = tarballs.fetch(NAME)
      npm = NodeAPI.pinned('npm')
      [
        [[npm, 'install', '--no-audit', '--no-fund', '--silent'], NodeAPI.pinned('node')],
        [[NodeAPI.pinned('bun'), 'add', '--silent'], NodeAPI.pinned('bun')]
      ].each do |install, runtime|
        Dir.mktmpdir('tinyactors-smoke') do |dir|
          File.write(File.join(dir, 'package.json'), "{\"name\": \"smoke\", \"private\": true, \"type\": \"module\"}\n")
          FileUtils.cp(ROOT.join('tools/smoke.mjs'), dir)
          NodeAPI.run(*install, main.to_s, platform.to_s, chdir: dir)
          NodeAPI.run(runtime, 'smoke.mjs', env: BIND_NOW, chdir: dir)
        end
      end
    end

    # The containers a Linux package is smoke-tested in: Node.js on glibc
    # and musl, and Bun on Debian, on each architecture (the other one
    # under emulation, a smoke test only: decision 14). Bun on musl x64 is
    # left out: its build needs AVX, which an emulated x64 lacks.
    CONTAINERS = {
      'node-bookworm' => ['node:22-bookworm-slim', :npm],
      'node-alpine' => ['node:22-alpine', :npm],
      'bun-debian' => ['oven/bun:1', :bun],
      'bun-alpine' => ['oven/bun:1-alpine', :bun]
    }.freeze

    def smoke_in_containers!(tarballs)
      main = tarballs.fetch(NAME)
      tarballs.each do |name, tarball|
        next if name == NAME

        platform = Toolchain::Target.release(name).container_platform or next
        CONTAINERS.each do |label, (image, engine)|
          next if label == 'bun-alpine' && platform == 'linux/amd64'

          install = engine == :npm ? 'npm install --no-audit --no-fund --silent' : 'bun add --silent'
          run = engine == :npm ? 'node smoke.mjs' : 'bun smoke.mjs'
          script = 'set -e; mkdir /work; cd /work; echo \'{"name":"smoke","private":true,"type":"module"}\' > package.json; ' \
                   "cp /t/smoke.mjs .; #{install} /p/#{main.basename} /p/#{tarball.basename}; #{run}"
          NodeAPI.run('docker', 'run', '--rm', '--platform', platform, '-e', 'LD_BIND_NOW=1',
                      '-v', "#{tarball.dirname}:/p:ro", '-v', "#{ROOT.join('tools')}:/t:ro", image, 'sh', '-c', script)
          puts "pack: #{name} in #{label} (#{image}, #{platform}): ok"
        end
      end
    end
  end
end
