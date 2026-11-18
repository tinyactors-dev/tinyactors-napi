// Boundary costs: an export call, an import call, a short string each way,
// and what memory growth does to a view. Runs in node, bun and Chromium.
export async function bench(bytes) {
  let ticks = 0;
  const { instance } = await WebAssembly.instantiate(bytes, { env: { tick: (x) => { ticks++; return x & 1; } } });
  const x = instance.exports;
  const N = 2_000_000;
  const time = (label, fn) => { fn(1000); const t0 = performance.now(); fn(N); const ns = (performance.now() - t0) * 1e6 / N; return [label, +ns.toFixed(2)]; };
  const out = [];
  out.push(time('export call', (n) => { let s = 0; for (let i = 0; i < n; i++) s = x.add(s, 1); return s; }));
  out.push(time('import call (from wasm)', (n) => x.calls(n)));
  const enc = new TextEncoder(); const dec = new TextDecoder('utf-8', { fatal: true });
  const at = x.buf();
  let u8 = new Uint8Array(x.memory.buffer);
  const names = Array.from({ length: 64 }, (_, i) => `order.created.${i}`);
  out.push(time('16 B string in (isWellFormed + encodeInto + view check)', (n) => { for (let i = 0; i < n; i++) { const s = names[i & 63]; if (!s.isWellFormed()) throw 0; if (u8.buffer !== x.memory.buffer) u8 = new Uint8Array(x.memory.buffer); enc.encodeInto(s, u8.subarray(at, at + 64)); } }));
  enc.encodeInto('order.created.17', u8.subarray(at, at + 64));
  out.push(time('16 B string out (TextDecoder over a subarray)', (n) => { let s; for (let i = 0; i < n; i++) s = dec.decode(u8.subarray(at, at + 16)); return s; }));
  const before = new Uint8Array(x.memory.buffer);
  const pages = x.memory.buffer.byteLength / 65536;
  x.grow(1);
  const detach = { pagesBefore: pages, oldViewLengthAfterGrow: before.byteLength, sameBuffer: before.buffer === x.memory.buffer,
    toResizableBuffer: typeof x.memory.toResizableBuffer === 'function', shadowRealm: typeof globalThis.ShadowRealm };
  return { costs: Object.fromEntries(out), detach };
}
