// node:child_process in a page (wasm/test/serve.mjs's import map): the names the shared
// tests import, each throwing when used, so a file loads and only the cases
// that need node:child_process fail (excluded in the browser: wasm/test/exclusions.mjs).
const missing = (what) => {
  const stub = () => {
    throw new Error(`node:child_process's ${what} is node's, not the browser's`);
  };
  return stub;
};
export const spawn = missing('spawn');
export const spawnSync = missing('spawnSync');
export const execFileSync = missing('execFileSync');
export default { spawn, spawnSync, execFileSync };
