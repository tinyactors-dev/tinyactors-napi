// Reproduce legacy-snapshot.json.gz with the pre-unification web native.mjs
// and glue.c (from this change's parent), compiled to legacy.wasm:
// node legacy-snapshot.mjs /absolute/legacy-native.mjs /absolute/legacy.wasm > legacy-snapshot.json.gz
// For a native fixture, zero fresh glibc allocations so unused pool storage
// contains no process heap residue:
// MALLOC_PERTURB_=255 node legacy-snapshot.mjs /absolute/legacy.node > legacy-node-snapshot.json.gz
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createEcmascript } from '../../../shared/ecmascript.mjs';
import { createRuntime } from '../../../shared/core.mjs';

export const resolver = (_, texts) => texts.map((s) => s === 'seed' ? () => 13
  : s === 'increment' ? ({ context }) => context.count + 2 : undefined);

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let native;
  if (process.argv[3]) {
    const { createNative } = await import(pathToFileURL(process.argv[2]));
    const module = new WebAssembly.Module(readFileSync(process.argv[3]));
    native = createNative((imports) => new WebAssembly.Instance(module, imports));
  } else native = createRequire(import.meta.url)(process.argv[2]);
  const { encodeValue, decodeValue } = createRuntime({ native, platform: {} });
  const codec = { encode: encodeValue, decode: decodeValue };
  const h = native.createHost(resolver, codec, 'legacy', createEcmascript());
  const sources = [
    `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="xstate" initial="idle">
      <datamodel><data id="count" expr="seed"/></datamodel>
      <state id="idle"><transition event="STEP"><assign location="count" expr="increment"/></transition></state>
    </scxml>`,
    `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="idle">
      <datamodel><data id="n" expr="7"/><data id="item"/>
        <data id="items" expr="Array.from({length:1000}, (_,i) => i+1)"/></datamodel>
      <state id="idle"><onentry><foreach array="items" item="item"><assign location="n" expr="n+item"/></foreach></onentry>
        <transition event="STEP"><assign location="n" expr="n+3"/></transition></state>
    </scxml>`,
  ];
  const images = sources.map((xml, i) => native.compile([{ name: `chart${i}`, xml }]));
  native.addImage(h, images[0]);
  const xstate = native.spawn(h, 0, 0);
  native.run(h, 10000);
  native.addImage(h, images[1]);
  const es = native.spawn(h, 1, 0);
  const inLoop = (dm) => dm.iters.length || dm.pays.some((p) => Array.isArray(p.value) && p.value.length === 1000);
  let snap;
  for (let i = 0; i < 200; i++) {
    native.run(h, 1);
    snap = native.snapshot(h);
    if (inLoop(snap.dm)) break;
  }
  if (!inLoop(snap.dm)) throw new Error('did not stop in foreach');
  process.stdout.write(gzipSync(encodeValue({ images: images.map((im) => native.imageBytes(im)), xstate, es, ...snap })));
  native.destroy(h);
}
