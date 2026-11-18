import { readFileSync } from 'node:fs';
for (const p of process.argv.slice(2)) {
  const m = new WebAssembly.Module(readFileSync(p));
  const b = readFileSync(p); let at = 8; const out = {};
  const leb = () => { let v = 0, s = 0, x; do { x = b[at++]; v |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return v >>> 0; };
  while (at < b.length) { const id = b[at++]; const size = leb(); let name = id;
    if (id === 0) { const save = at; const l = leb(); name = 'custom:' + b.subarray(at, at + l).toString(); at = save; }
    out[name] = (out[name] || 0) + size; at += size; }
  const mem = WebAssembly.Module.exports(m).length;
  console.log(p.split('/').at(-1), b.length, JSON.stringify(out), 'exports', mem);
}
