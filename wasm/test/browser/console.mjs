// console.log in a page as node prints it (wasm/test/documentation.mjs):
// the documentation's examples are compared with the output their blocks
// show, which node printed, so the page formats its arguments the way
// node's util.inspect does for what the examples print: text as it is,
// bigints with their `n`, arrays and objects in node's spacing, nested
// text quoted. Each line goes to `send`; console.error stays the page's.
function inspect(value, depth, top) {
  switch (typeof value) {
    case 'string': return top ? value : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
    case 'bigint': return `${value}n`;
    case 'number': return Object.is(value, -0) ? '-0' : String(value);
    case 'function': return value.name ? `[Function: ${value.name}]` : '[Function (anonymous)]';
    case 'symbol': return value.toString();
    case 'undefined': return 'undefined';
    case 'boolean': return String(value);
    default: break;
  }
  if (value === null) return 'null';
  if (value instanceof Error) return value.stack ?? String(value);
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';
  const list = (open, items, close) => (items.length === 0 ? `${open}${close}` : `${open} ${items.join(', ')} ${close}`);
  if (Array.isArray(value)) return list('[', value.map((item) => inspect(item, depth + 1, false)), ']');
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.length}) ${list('[', Array.from(value, String), ']')}`;
  if (value instanceof Map) return `Map(${value.size}) ${list('{', [...value].map(([k, v]) => `${inspect(k, depth + 1, false)} => ${inspect(v, depth + 1, false)}`), '}')}`;
  if (value instanceof Set) return `Set(${value.size}) ${list('{', [...value].map((v) => inspect(v, depth + 1, false)), '}')}`;
  const prototype = Object.getPrototypeOf(value);
  const name = prototype === null ? '[Object: null prototype] ' : prototype === Object.prototype ? '' : `${prototype.constructor?.name ?? ''} `;
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);
  return `${name}${list('{', Object.keys(value).map((k) => `${key(k)}: ${inspect(value[k], depth + 1, false)}`), '}')}`;
}

/** Makes console.log send each line it prints, formatted as node's. */
export function capture(send) {
  console.log = (...args) => send(args.map((arg) => inspect(arg, 0, true)).join(' '));
}
