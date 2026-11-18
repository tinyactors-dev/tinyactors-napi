// The part of node's `process` the shared tests use that a page can give
// (wasm/test/serve.mjs's test page installs it before a test file loads):
// listeners for unhandledRejection and uncaughtException, over the
// window's unhandledrejection and error events, and an empty env. The rest
// of node's process (memoryUsage, execPath) is not here: the cases that use
// it are excluded in the browser (wasm/test/exclusions.mjs).
export function install() {
  const listeners = new Map();
  const events = {
    unhandledRejection: ['unhandledrejection', (fn) => (event) => {
      event.preventDefault();
      fn(event.reason, event.promise);
    }],
    uncaughtException: ['error', (fn) => (event) => {
      event.preventDefault();
      fn(event.error);
    }],
  };
  globalThis.process = {
    env: {},
    on(name, fn) {
      const [type, wrap] = events[name] ?? [];
      if (type === undefined) throw new Error(`process.on('${name}') is node's, not the browser's`);
      const listener = wrap(fn);
      listeners.set(fn, listener);
      globalThis.addEventListener(type, listener);
      return this;
    },
    off(name, fn) {
      const [type] = events[name] ?? [];
      const listener = listeners.get(fn);
      if (type !== undefined && listener !== undefined) globalThis.removeEventListener(type, listener);
      listeners.delete(fn);
      return this;
    },
  };
}
