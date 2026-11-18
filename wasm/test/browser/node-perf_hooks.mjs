// node:perf_hooks in a page (wasm/test/documentation.mjs's import map):
// its `performance` is the page's.
export const { performance } = globalThis;
export default { performance };
