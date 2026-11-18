// node:worker_threads in a page (wasm/test/serve.mjs's import map): the names the shared
// tests import, each throwing when used, so a file loads and only the cases
// that need node:worker_threads fail (excluded in the browser: wasm/test/exclusions.mjs).
const missing = (what) => {
  const stub = () => {
    throw new Error(`node:worker_threads's ${what} is node's, not the browser's`);
  };
  return stub;
};
export const Worker = missing('Worker');
export const parentPort = missing('parentPort');
export const workerData = missing('workerData');
export default { Worker, parentPort, workerData };
