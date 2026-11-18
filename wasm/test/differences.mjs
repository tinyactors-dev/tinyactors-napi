// What differs between @tinyactors/node and @tinyactors/wasm, and between
// a package and index.d.ts, that tools/parity.mjs accepts, each with its
// reason. An entry's `path` is a path of tools/shape.mjs's document, `*`
// any run of characters; `runtimes` and `packages` narrow it (all when
// absent). Any other difference fails the check, and so does an entry
// that matches none.
export const DIFFERENCES = [
  {
    path: 'objects.*.own.[tinyactors.*]',
    reason: 'the addon keeps a view\'s, an invocation\'s and a clock\'s state under a symbol of its own on the object (C has no ' +
      'private fields; AGENTS.md, "napi_type_tag_object on every wrapped object"), the wasm package in a private field; ' +
      'nobody is given the symbol, so no program reaches it but by Object.getOwnPropertySymbols',
  },
  {
    path: 'exports.*.static.arguments',
    runtimes: ['node'],
    reason: 'V8 gives a function made from a FunctionTemplate (napi_define_class) the own `arguments` and `caller` of a sloppy ' +
      'function, null and not configurable; a class has neither. Nothing in the API reads them',
  },
  {
    path: 'exports.*.static.caller',
    runtimes: ['node'],
    reason: 'the same: V8\'s own `caller` of a native constructor',
  },
  {
    path: 'objects.image.constructor',
    reason: 'what the host hands out is a Buffer from the addon (napi_create_buffer_copy) and a Uint8Array from the wasm package, ' +
      'which has no Buffer in a browser; a Buffer is a Uint8Array, and index.d.ts says Uint8Array (docs/guide/browser.md)',
  },
  { path: 'objects.snapshot', reason: 'snapshot(): a Buffer, or a Uint8Array (as objects.image)' },
  { path: 'objects.metrics', reason: 'metrics(): a Buffer, or a Uint8Array (as objects.image)' },
];

// What index.d.ts declares that a package does not have, or the reverse.
export const DECLARED = [];

const pattern = (path) => new RegExp(`^${path.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** Whether `entry` accepts `difference` ({runtime, package?, path}). */
export function matches(entry, difference) {
  if (entry.runtimes && !entry.runtimes.includes(difference.runtime)) return false;
  if (entry.packages && difference.package !== undefined && !entry.packages.includes(difference.package)) return false;
  entry.regex ??= pattern(entry.path);
  return entry.regex.test(difference.path);
}
