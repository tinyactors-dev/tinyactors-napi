'use strict';

// Finds the compiled addon (docs/adr/0001-packaging-and-releases.md). An npm
// install brings one platform package, the optional dependency whose `os`
// and `cpu` match: `@tinyactors/node-<platform>-<arch>`, whose `main` is its
// `tinyactors.node`. In the repository there is none, and the addon is the
// one `mise run build` wrote. No libc is detected: the Linux addon links no
// C library and serves glibc and musl alike.

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const REPOSITORY_BUILD = path.join(__dirname, '..', 'build', 'tinyactors_napi.node');

function packageName(platform, arch) {
  return `@tinyactors/node-${platform}-${arch}`;
}

// Where `name` is installed, seen from `paths` (default: this package), or
// undefined when it is not. A package counts as installed when its
// package.json resolves, so one whose addon is missing or broken fails
// loudly instead of falling back.
function installed(name, paths) {
  try {
    return require.resolve(`${name}/package.json`, paths === undefined ? undefined : { paths });
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Loads the addon: the platform package for `platform` and `arch` when it
 * is installed, else the repository build. An installed package that fails
 * to load throws its own error. With neither, one error names the package
 * looked for and the platforms there are packages for. The options exist
 * for tests.
 */
function loadAddon({
  platform = process.platform,
  arch = process.arch,
  paths = undefined,
  repositoryBuild = REPOSITORY_BUILD,
} = {}) {
  const name = packageName(platform, arch);
  const manifest = installed(name, paths);
  if (manifest !== undefined) {
    return require(path.dirname(manifest));
  }
  if (fs.existsSync(repositoryBuild)) {
    return require(repositoryBuild);
  }
  const supported = SUPPORTED.includes(`${platform}-${arch}`);
  const error = new Error(
    `tinyactors: no native addon for ${platform}-${arch}: ${name} is not installed` +
      (supported
        ? ' (it is an optional dependency of @tinyactors/node: install without --no-optional or --omit=optional)'
        : ' (there is no package for this platform)') +
      `. Platforms with a package: ${SUPPORTED.join(', ')}.`,
  );
  error.code = 'ERR_TINYACTORS_NO_ADDON';
  throw error;
}

module.exports = { loadAddon, packageName, SUPPORTED };
