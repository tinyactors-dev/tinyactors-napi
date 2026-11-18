import { readFileSync } from 'node:fs';
import { bench } from './bench.mjs';
const r = await bench(readFileSync(new URL('./calls.wasm', import.meta.url)));
let napi = null;
try {
  const { createRequire } = await import('node:module');
  const addon = createRequire(import.meta.url)(new URL('../../../build/tinyactors.node', import.meta.url).pathname);
  const N = 1_000_000; const empty = new Uint8Array([0xf6]);
  addon.decode(empty); let t0 = performance.now(); for (let i = 0; i < N; i++) addon.decode(empty);
  napi = { 'addon decode(null), a Node-API call with an arena mark': +((performance.now() - t0) * 1e6 / N).toFixed(2) };
} catch (e) { napi = String(e); }
console.log(JSON.stringify({ runtime: typeof Bun !== 'undefined' ? 'bun ' + Bun.version : 'node ' + process.version, ...r, napi }, null, 1));
