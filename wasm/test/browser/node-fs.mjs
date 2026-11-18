// node:fs in a page (wasm/test/serve.mjs's import map): the names the shared
// tests import, each throwing when used, so a file loads and only the cases
// that need node:fs fail (excluded in the browser: wasm/test/exclusions.mjs).
const missing = (what) => {
  const stub = () => {
    throw new Error(`node:fs's ${what} is node's, not the browser's`);
  };
  return stub;
};
export const existsSync = missing('existsSync');
export const mkdirSync = missing('mkdirSync');
export const mkdtempSync = missing('mkdtempSync');
export const readdirSync = missing('readdirSync');
export const readFileSync = missing('readFileSync');
export const realpathSync = missing('realpathSync');
export const rmSync = missing('rmSync');
export const statSync = missing('statSync');
export const symlinkSync = missing('symlinkSync');
export const writeFileSync = missing('writeFileSync');
export default { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync };
