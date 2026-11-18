// node:fs for an example application in a page (wasm/test/documentation.mjs's
// import map): readFileSync of a file beside the example, so it reads its
// charts as it does from disk (`readFileSync(new URL('./charts/x.scxml',
// import.meta.url), 'utf8')`), from the files the runner gave the page
// before the example loaded (globalThis.__tinyactors_files: URL path ->
// text); every other use throws, as wasm/test/browser/node-fs.mjs's names do.
import * as stubs from './node-fs.mjs';

export * from './node-fs.mjs';

export function readFileSync(path, options) {
  const url = new URL(path instanceof URL ? path.href : String(path), globalThis.location.href);
  const text = globalThis.__tinyactors_files?.[url.pathname];
  if (text === undefined) throw Object.assign(new Error(`ENOENT: ${url.pathname} is not among the example's files`), { code: 'ENOENT' });
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? text : new TextEncoder().encode(text);
}

export default { ...stubs.default, readFileSync };
