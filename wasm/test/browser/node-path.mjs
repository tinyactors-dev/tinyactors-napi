// node:path in a page (wasm/test/serve.mjs's import map): the names the shared
// tests import, each throwing when used, so a file loads and only the cases
// that need node:path fail (excluded in the browser: wasm/test/exclusions.mjs).
const missing = (what) => {
  const stub = () => {
    throw new Error(`node:path's ${what} is node's, not the browser's`);
  };
  return stub;
};
export const dirname = missing('dirname');
export const join = missing('join');
export const normalize = missing('normalize');
export const relative = missing('relative');
export const resolve = missing('resolve');
export const sep = '/';
export const isAbsolute = missing('isAbsolute');
export default { dirname, join, normalize, relative, resolve, sep, isAbsolute };
