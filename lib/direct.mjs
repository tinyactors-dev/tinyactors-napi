// The direct layer of @tinyactors/node: loads the addon and re-exports it,
// nothing else (AGENTS.md, "Layers and the resolver"). The application
// layer (lib/convenience.mjs) imports this module only, and index.mjs
// exports what that layer exports: the direct Host and Send are its. In the repository the addon is
// build/tinyactors.node, which `mise run build` makes; an installed package
// has no build/, and its addon is this platform's package,
// @tinyactors/node-<platform>-<arch>, which an install of @tinyactors/node
// brings as an optional dependency at exactly its own version (npm, pnpm
// and Bun install only the one whose os and cpu match).
//
// The development build comes first: Bun, run where no node_modules is
// (the repository), installs a package it cannot resolve from the
// registry, so asking for the platform package there would load the last
// release's addon. The platform package's version must be this package's
// for the same reason.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const platformPackage = `@tinyactors/node-${process.platform}-${process.arch}`;

function notFound(error) {
  return error?.code === 'MODULE_NOT_FOUND';
}

function load() {
  try {
    return require('../build/tinyactors.node');
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  const { version } = require('../package.json');
  let installed;
  try {
    installed = require(`${platformPackage}/package.json`).version;
  } catch (error) {
    if (!notFound(error)) throw error;
    throw new Error(
      `@tinyactors/node: no addon for ${process.platform}-${process.arch}: ${platformPackage} is not installed ` +
        '(an install of @tinyactors/node brings it where the platform has one), and this is not a build in the ' +
        'repository (mise run build); @tinyactors/wasm runs the same API on any platform, without an addon',
      { cause: error },
    );
  }
  if (installed !== version) {
    throw new Error(`@tinyactors/node: ${platformPackage} is ${installed}, not ${version}: reinstall @tinyactors/node`);
  }
  return require(platformPackage);
}

const addon = load();

export const {
  encode,
  decode,
  decodeTraces,
  TinyactorsError,
  StaleError,
  StateError,
  InvalidError,
  UnsupportedError,
  CompileError,
  ResolveError,
  compileCharts,
  compileSystem,
  Host,
  Send,
  SimulatedClock,
  Address,
  encodeHTTPPost,
  parseHTTPRequest,
} = addon;
