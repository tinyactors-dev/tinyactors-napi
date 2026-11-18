// What a wasm module is, as JSON on stdout: its imports and exports (by
// WebAssembly.Module), its sections, the features its target_features
// section names, its initial memory, the shadow stack pointer's start,
// and its size raw, gzip -9 and brotli 11. mise/wasm.rb checks the
// imports and exports and reports the rest.
//
//   node wasm/tools/module.mjs <module.wasm>
import { readFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const bytes = readFileSync(process.argv[2]);
const module = new WebAssembly.Module(bytes);
let at = 8;
const leb = () => {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return value;
  }
};
const sleb = () => {
  let value = 0n;
  let shift = 0n;
  let byte;
  do {
    byte = bytes[at++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  if (byte & 0x40) value -= 1n << shift;
  return value;
};
const name = () => {
  const length = leb();
  const text = bytes.subarray(at, at + length).toString('utf8');
  at += length;
  return text;
};
const sections = [];
const features = [];
let memoryPages = null;
let stackPointer = null;
while (at < bytes.length) {
  const id = bytes[at++];
  const size = leb();
  const end = at + size;
  if (id === 0) {
    const section = name();
    sections.push({ id, name: section, bytes: size });
    if (section === 'target_features') {
      for (let n = leb(); n > 0; n--) {
        const prefix = String.fromCharCode(bytes[at++]);
        features.push(`${prefix}${name()}`);
      }
    }
  } else {
    sections.push({ id, bytes: size });
    if (id === 5 && leb() > 0) { // memory: the first one's limits, its minimum
      at++; // flags
      memoryPages = leb();
    } else if (id === 6 && leb() > 0) { // globals: the first, wasm-ld's __stack_pointer
      at += 2; // type, mutability
      if (bytes[at++] === 0x41) stackPointer = Number(sleb()); // i32.const
    }
  }
  at = end;
}
console.log(JSON.stringify({
  imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`),
  exports: WebAssembly.Module.exports(module).map((e) => e.name),
  sections,
  features,
  memoryPages,
  stackPointer,
  bytes: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length,
}));
