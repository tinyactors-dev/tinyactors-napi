// node:url in a page (wasm/test/serve.mjs's import map): the names the shared
// tests import, each throwing when used, so a file loads and only the cases
// that need node:url fail (excluded in the browser: wasm/test/exclusions.mjs).
const missing = (what) => {
  const stub = () => {
    throw new Error(`node:url's ${what} is node's, not the browser's`);
  };
  return stub;
};
export const fileURLToPath = missing('fileURLToPath');
export const pathToFileURL = missing('pathToFileURL');
export default { fileURLToPath, pathToFileURL };
