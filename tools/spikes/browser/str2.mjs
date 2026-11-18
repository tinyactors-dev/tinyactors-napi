export async function strings(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, { env: { tick: (x) => x } });
  const x = instance.exports; const at = x.buf(); let u8 = new Uint8Array(x.memory.buffer);
  const names = Array.from({ length: 64 }, (_, i) => `order.created.${i}`);
  const N = 1_000_000; const out = {};
  const time = (label, fn) => { fn(10000); const t0 = performance.now(); fn(N); out[label] = +((performance.now() - t0) * 1e6 / N).toFixed(1); };
  const enc = new TextEncoder(); const dec = new TextDecoder();
  time('memory.buffer getter + identity check', (n) => { let c = 0; for (let i = 0; i < n; i++) if (u8.buffer !== x.memory.buffer) c++; return c; });
  time('isWellFormed', (n) => { let c = 0; for (let i = 0; i < n; i++) if (names[i & 63].isWellFormed()) c++; return c; });
  time('in: encodeInto over a subarray', (n) => { for (let i = 0; i < n; i++) enc.encodeInto(names[i & 63], u8.subarray(at, at + 64)); });
  time('in: ASCII loop', (n) => { for (let i = 0; i < n; i++) { const s = names[i & 63]; const L = s.length; let j = 0; for (; j < L; j++) { const c = s.charCodeAt(j); if (c > 127) break; u8[at + j] = c; } } });
  enc.encodeInto('order.created.17', u8.subarray(at, at + 64));
  time('out: TextDecoder over a subarray', (n) => { let s; for (let i = 0; i < n; i++) s = dec.decode(u8.subarray(at, at + 16)); return s; });
  time('out: fromCharCode.apply over a subarray', (n) => { let s; for (let i = 0; i < n; i++) s = String.fromCharCode.apply(null, u8.subarray(at, at + 16)); return s; });
  return out;
}
