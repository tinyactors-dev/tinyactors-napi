// node:process in the page that runs conform.mjs (wasm/test/conform.mjs):
// standard input is what the bridge gives the page (globalThis's
// __tinyactors_stdin and __tinyactors_stdin_end, called by Playwright),
// standard output and error go back through the functions the bridge
// exposed (__tinyactors_stdout, __tinyactors_stderr, __tinyactors_exit);
// unhandledRejection is the window's unhandledrejection.
import { Buffer } from './node-buffer.mjs';

const listeners = { data: [], end: [] };
const toBase64 = (bytes) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

globalThis.__tinyactors_stdin = (base64) => {
  const text = atob(base64);
  const chunk = new Buffer(text.length);
  for (let i = 0; i < text.length; i++) chunk[i] = text.charCodeAt(i);
  for (const listener of listeners.data) listener(chunk);
};
globalThis.__tinyactors_stdin_end = () => {
  for (const listener of listeners.end) listener();
};

const process = {
  exitCode: undefined,
  stdin: {
    on(event, listener) {
      listeners[event]?.push(listener);
      return this;
    },
  },
  stdout: { write: (bytes) => globalThis.__tinyactors_stdout(toBase64(bytes)) },
  stderr: { write: (text) => globalThis.__tinyactors_stderr(String(text)) },
  exit: (code) => globalThis.__tinyactors_exit(code ?? process.exitCode ?? 0),
  on(event, listener) {
    if (event !== 'unhandledRejection') throw new Error(`process.on('${event}') is node's`);
    globalThis.addEventListener('unhandledrejection', (e) => {
      e.preventDefault();
      listener(e.reason, e.promise);
    });
    return this;
  },
};
export default process;
