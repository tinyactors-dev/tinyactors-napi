// The types of @tinyactors/wasm/init: the package's names (index.d.ts, one
// API for both packages) and init(), which loads the WebAssembly module
// that @tinyactors/wasm's default entry loads with top-level await.
export * from '../index.js';

/** Loads the WebAssembly module, once: every later call answers the same
 * instance, whatever it passes. `source` is where the module is: the
 * package's own `tinyactors.wasm` beside its files when absent, a URL (a
 * string relative to the package's files), a `Response` or a promise of
 * one, the bytes, or a compiled `WebAssembly.Module`. Use this entry where
 * a module graph cannot hold top-level await (a Service Worker) or a
 * bundler does not place `tinyactors.wasm`; until the promise settles,
 * every call of the package throws `TinyactorsError` with
 * `TA_ERROR_STATE`. A load that fails rejects, and a later call may try
 * again. */
export function init(source?: string | URL | Response | PromiseLike<Response> | BufferSource | WebAssembly.Module): Promise<void>;
