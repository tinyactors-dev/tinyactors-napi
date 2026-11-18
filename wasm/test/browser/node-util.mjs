// node:util in a page (wasm/test/documentation.mjs's import map): the
// names the example applications import for their command lines, each
// throwing when used, so an example's module loads and its test runs.
const missing = (what) => () => {
  throw new Error(`node:util's ${what} is node's, not the browser's`);
};
export const parseArgs = missing('parseArgs');
export const inspect = missing('inspect');
export const format = missing('format');
export default { parseArgs, inspect, format };
