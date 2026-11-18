// The module instance the package's classes use: loaded once by init(),
// which both entries share (index.mjs awaits it at the top level;
// init.mjs leaves it to the application, for a Service Worker or a
// bundler without top-level await). A call before it settles throws
// TA_ERROR_STATE.
import { TinyactorsError } from './errors.mjs';
import { load } from './module.mjs';

let current = null;
let loading = null;

// Loads the module once: the bundled tinyactors.wasm, or `source` (a URL,
// a Response, bytes or a WebAssembly.Module). Later calls answer the same
// instance, whatever they pass.
export function init(source) {
  if (loading === null) {
    loading = load(source).then((module) => {
      current = module;
      return module;
    }, (error) => {
      loading = null;
      throw error;
    });
  }
  return loading.then(() => undefined);
}

// The instance, once init() settled.
export function instance() {
  if (current === null) throw new TinyactorsError('@tinyactors/wasm is not loaded: await init() first', { status: 'TA_ERROR_STATE' });
  return current;
}
