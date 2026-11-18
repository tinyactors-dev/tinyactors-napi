// The convenience layer of @tinyactors/node and @tinyactors/wasm:
// JavaScript over the direct layer's exports only (AGENTS.md, "Layers and
// the resolver"). It adds shapes, not behaviour, and imports nothing but
// `#direct`, the package's direct exports (the lint rule
// convenience-imports-the-direct-layer): package.json's `imports` maps it
// to the addon's lib/direct.mjs, and under the export condition
// `tinyactors-wasm` to the wasm package's wasm/lib/direct.mjs
// (docs/browser.md, "One API"), so the two packages share this file.
//
// Then the shapes chosen for p3-shapes: host.addCharts, host.spawnChart,
// directoryResolver and Address.prototype.toJSON (below). The only
// built-ins it reaches are node:fs and node:path, for directoryResolver,
// through process.getBuiltinModule when the resolver is made: a runtime
// without them (a browser) refuses it there, with TA_ERROR_UNSUPPORTED.
//
// The typed methods return promises when given no handler (the
// maintainer, 2026-11-18): `host.actorState(params)` returns a promise that
// resolves with the result and rejects with the TinyactorsError, while
// `host.actorState(params, onResult, onError?)` is the direct method's call
// and returns nothing. Each direct method on Host.prototype is replaced by a
// function that passes a call with a handler straight to it (one argument
// check and one call more, measured in docs/log.xml,
// l-maint-promises-built) and otherwise calls it with a result handler that
// resolves and an error handler that rejects. The promise settles from the
// handler, in the drain; its continuation runs as a microtask after the
// turn's native call returns, outside the drain, on a result already
// converted. A refusal at the call (a closed host, a `this` that is not a
// Host, params the method cannot write) rejects too, as an async function's
// throw would. A method still pending at `close()` never settles: the
// direct layer drops its handlers uncalled. An `onError` without an
// `onResult` is the direct method's TypeError.
import { Address, compileCharts, Host, ResolveError, TinyactorsError } from '#direct';

/** The direct method `direct` as one that returns a promise of its result
 * when it is given no handler. */
function promising(direct) {
  return function (params, onResult, onError) {
    if (onResult !== undefined || (onError !== undefined && onError !== null)) return direct.call(this, params, onResult, onError);
    return new Promise((resolve, reject) => {
      direct.call(this, params, (host, result) => resolve(result), (host, error) => reject(error));
    });
  };
}

/** The direct typed methods of Host. */
const TYPED_METHODS = [
  'actorState', 'actorContext', 'actorList', 'actorGet', 'hostStats', 'hostConfig',
  'traceConfigure', 'traceWatch', 'traceUnwatch', 'traceEnd', 'traceSpansDecode',
];

for (const name of TYPED_METHODS) {
  const direct = Host.prototype[name];
  if (typeof direct !== 'function') throw new Error(`@tinyactors/node: the direct layer has no Host method ${name}`);
  const method = promising(direct);
  // the direct method's name and length (index.d.ts declares them)
  Object.defineProperty(method, 'name', { value: name });
  Object.defineProperty(method, 'length', { value: direct.length });
  // as a class's methods are: writable, configurable, not enumerable
  Object.defineProperty(Host.prototype, name, { value: method, writable: true, configurable: true, enumerable: false });
}

// ---- shapes a JavaScript programmer would otherwise write (p3-shapes) ----

/** Defines `value` on `target` as a class's method is: writable,
 * configurable, not enumerable, its `name` the property's. */
function method(target, name, value) {
  Object.defineProperty(value, 'name', { value: name });
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

/** The options of addCharts: the compile call's resolver, nothing else. */
const ADD_CHARTS_OPTIONS = new Set(['resolver']);

// host.addCharts({name: text}, {resolver}?) → segment: compileCharts of the
// mapping's entries in their order (the first the boot chart), addImage of
// the image, close of the result, in one call. The result is closed on every
// path, so a refused image leaves nothing behind; a CompileError is
// compileCharts's own, with every diagnostic.
method(Host.prototype, 'addCharts', function (charts, options) {
  if (typeof charts !== 'object' || charts === null || Array.isArray(charts))
    throw new TypeError('addCharts: charts must be an object of document names to texts');
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null) throw new TypeError('addCharts: options must be an object');
    for (const key of Object.keys(options))
      if (!ADD_CHARTS_OPTIONS.has(key)) throw new TypeError(`addCharts: unknown option ${key}`);
  }
  const sources = Object.entries(charts).map(([name, text]) => ({ name, text }));
  const compiled = compileCharts(sources, options?.resolver);
  try {
    return this.addImage(compiled.image);
  } finally {
    compiled.close();
  }
});

// host.spawnChart(name, options?) → session: spawn of the chart's current
// version, host.chart(name) then host.spawn(ref, options).
method(Host.prototype, 'spawnChart', function (name, options) {
  return this.spawn(this.chart(name), options);
});

// Address.prototype.toJSON: its text, so JSON.stringify writes an address
// as the string an Address is made from (new Address(text) reads it back).
method(Address.prototype, 'toJSON', function () {
  return this.text;
});

// directoryResolver(root) → resolver: a resolver for the compile calls that
// reads `source` as a file under `root`, relative to the directory of
// `base` (a document named `charts/order.scxml` asking for `child.scxml`
// reads `root/charts/child.scxml`), and refuses, with a ResolveError, a
// path that leaves `root`: `..`, an absolute path, or a symbolic link
// anywhere on the way that points outside. `root` is resolved through its
// own links once, when the resolver is made (a root that does not exist
// throws there). A file that does not exist is a ResolveError too, so the
// compile call reports it as a diagnostic; any other error of the file
// system (a directory, no permission) is thrown from the compile call as it
// is. The text must be UTF-8: bytes that are not are refused, never
// replaced.
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** node:fs and node:path, from the runtime (node, bun); a runtime without
 * them refuses directoryResolver. */
function builtins() {
  const get = globalThis.process?.getBuiltinModule;
  if (typeof get !== 'function') {
    throw new TinyactorsError('directoryResolver reads files with node:fs, which this runtime does not have', {
      status: 'TA_ERROR_UNSUPPORTED',
    });
  }
  return { fs: get.call(globalThis.process, 'node:fs'), path: get.call(globalThis.process, 'node:path') };
}

/** Whether `file`, absolute, is `root` or under it (`path`: node:path). */
function inside(path, root, file) {
  const rest = path.relative(root, file);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${path.sep}`) && !path.isAbsolute(rest);
}

export function directoryResolver(root) {
  const { fs, path } = builtins();
  const top = fs.realpathSync(root);
  return function resolve(base, source) {
    const file = path.resolve(top, path.dirname(base), source);
    if (!inside(path, top, file)) throw new ResolveError(`${source} (from ${base}) leaves the resolver's root`);
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
        throw new ResolveError(`${source} (from ${base}): no such file under the resolver's root`);
      throw error;
    }
    if (!inside(path, top, real)) throw new ResolveError(`${source} (from ${base}) leaves the resolver's root through a symbolic link`);
    const bytes = fs.readFileSync(real);
    try {
      return UTF8.decode(bytes);
    } catch {
      throw new ResolveError(`${source} (from ${base}) is not UTF-8`);
    }
  };
}
