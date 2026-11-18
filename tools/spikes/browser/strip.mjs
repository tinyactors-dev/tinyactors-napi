import { readFileSync, writeFileSync } from 'node:fs';
const [inp, outp] = process.argv.slice(2); const b = readFileSync(inp); let at = 8; const parts = [b.subarray(0, 8)];
const leb = () => { let v = 0, s = 0, x; do { x = b[at++]; v |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return v >>> 0; };
while (at < b.length) { const start = at; const id = b[at++]; const size = leb(); const end = at + size; if (id !== 0) parts.push(b.subarray(start, end)); at = end; }
writeFileSync(outp, Buffer.concat(parts));
