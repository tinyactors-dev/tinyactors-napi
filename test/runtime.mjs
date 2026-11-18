// What the shared tests ask of the runtime that runs them (docs/browser.md,
// "One API"), in one place, so the test files and their helpers run the
// same in node, bun and a Chromium page: which datamodel and which package
// are under test, the test file's name, a macrotask, a full collection,
// and how a failed run says so. In node and bun these come from the
// process (TA_NAPI_DATAMODEL, the --conditions=tinyactors-wasm the test
// task passes for @tinyactors/wasm); in a page from the object the runner's
// page sets before it imports a test file, globalThis.__tinyactors_test:
// {datamodel, file, done(failed)}, with Chromium's gc() exposed.
const page = globalThis.__tinyactors_test;
const processOf = globalThis.process;

export const runtime = globalThis.Bun ? 'bun' : processOf?.versions?.node ? 'node' : 'browser';

/** The datamodel under test: "native" unless the runner names another. */
export const datamodel = page?.datamodel ?? processOf?.env?.TA_NAPI_DATAMODEL ?? 'native';

/** Whether the package under test is @tinyactors/wasm: a page's runner
 * runs it only; node and bun are told by the test task (TA_NAPI_PACKAGE,
 * beside the --conditions=tinyactors-wasm that picks it). */
export const wasm = page !== undefined || processOf?.env?.TA_NAPI_PACKAGE === 'wasm';

/** The test file being run: its name, as the exclusions list it. */
export const file = page?.file ?? (processOf?.argv?.[1] ?? '').split(/[\\/]/).pop();

/** A macrotask, after the event loop ran: setImmediate where it exists,
 * else a MessageChannel message (a page). */
export function macrotask() {
  if (typeof globalThis.setImmediate === 'function') return new Promise((resolve) => globalThis.setImmediate(resolve));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

// A full collection: Bun's collector is Bun.gc(true); node's gc() is
// exposed at run time (v8.setFlagsFromString, then a new context's
// global), so the test task passes no flag; a page's is Chromium's gc(),
// exposed by the flag the runner launches it with.
let gc;
export async function fullCollection() {
  if (gc === undefined) {
    if (globalThis.Bun) gc = () => globalThis.Bun.gc(true);
    else if (typeof globalThis.gc === 'function') gc = globalThis.gc;
    else if (runtime === 'node') {
      const v8 = await import('node:v8');
      const vm = await import('node:vm');
      v8.setFlagsFromString('--expose_gc');
      gc = vm.runInNewContext('gc');
    } else throw new Error('no collector to call: run the page with --js-flags=--expose-gc');
  }
  gc();
}

/** A text file's contents: node:fs where the runtime has it, else
 * fetched (a page, served by its runner). */
export async function readText(url) {
  const get = processOf?.getBuiltinModule;
  if (typeof get === 'function') return get.call(processOf, 'node:fs').readFileSync(url, 'utf8');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

/** A run with failures: the process's exit code, or the page's runner told. */
export function failed(count) {
  if (page !== undefined) page.done(count);
  else if (count > 0 && processOf !== undefined) processOf.exitCode = 1;
}
