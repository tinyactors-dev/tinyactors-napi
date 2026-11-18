// @tinyactors/wasm/init: the package's names and `await init(url?)`, for a
// Service Worker (which refuses a module graph with top-level await) and
// for bundlers that do not handle it. A call before init() settles throws
// TA_ERROR_STATE.
export { init } from './lib/state.mjs';
export * from './lib/direct.mjs';
export * from '../lib/convenience.mjs';
