import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
const m = new WebAssembly.Module(readFileSync(process.argv[2]));
console.log('imports', WebAssembly.Module.imports(m).map((i) => i.name).join(','));
const wasi = new WASI({ version: 'preview1' });
const inst = new WebAssembly.Instance(m, wasi.getImportObject ? wasi.getImportObject() : { wasi_snapshot_preview1: wasi.wasiImport });
wasi.start(inst);
