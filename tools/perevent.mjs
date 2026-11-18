// The per-event benchmark (docs/allocation.md, "Cost per event"), for
// either package: 10,000 actors of a chart, rounds of one `inc` to each, the
// least time per event of the rounds, and a round of spawns and
// terminations; with the memory it took beside it (resident and the
// engine's heap per actor, and for @tinyactors/wasm its linear memory).
// `node tools/perevent.mjs --chart null|fit [--actors N] [--rounds R]
// [--datamodel native|quickjs]` (the host's datamodel, for `fit`);
// the package is the one `@tinyactors/node` resolves to (the export
// condition `tinyactors-wasm` picks @tinyactors/wasm). `fit` is
// tinyactors-cpython/tools/charts/fit.ecmascript.scxml (a cond and an
// assign per event: the native datamodel's work); `null` the same shape on
// the null datamodel (a transition per event, no evaluation), which both
// packages run, so it compares the binding and core alone. `mise run
// perevent` runs both packages under both runtimes, alternating, and
// prints them side by side. A measurement, not a test.
//
// After the rounds it measures memory twice more: with every actor resident
// after its events (each keeps its last `_event`), and after every actor
// was hibernated (two sweeps, then `hibernate` of each, the blobs dropped
// as a store would take them away): what a process keeps per actor once
// its population is out of memory. WebAssembly memory never shrinks, so
// the wasm package keeps its linear memory's peak; the addon's region is
// malloc'd once and stays too, but the engine gives back what the
// sessions held.
import { Host, compileCharts } from '@tinyactors/node';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const N = Number(option('actors', 10000));
const ROUNDS = Number(option('rounds', 30));
const CHART_NAME = option('chart', 'null');
const DATAMODEL = option('datamodel', 'native');
const wasm = process.env.TA_NAPI_PACKAGE === 'wasm';

const CHARTS = {
  null: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="null" name="fit" initial="idle">
  <state id="idle"><transition event="inc"/><transition event="add"/></state>
</scxml>`,
  fit: null, // read from the Python binding's tools
};

async function chartText() {
  if (CHART_NAME !== 'fit') return CHARTS.null;
  const fs = process.getBuiltinModule('node:fs');
  const text = fs.readFileSync(new URL('../../tinyactors-cpython/tools/charts/fit.ecmascript.scxml', import.meta.url), 'utf8');
  return text.replace('count &lt; 100', 'count &lt; 1000000');
}

async function collector() {
  if (globalThis.Bun) return () => globalThis.Bun.gc(true);
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose_gc');
  return vm.runInNewContext('gc');
}

async function linearMemory() {
  if (!wasm) return 0;
  const { instance } = await import('../wasm/lib/state.mjs');
  return instance().bytes().byteLength;
}

const jsc = globalThis.Bun ? await import('bun:jsc') : null;
function heap() {
  if (jsc !== null) {
    const stats = jsc.heapStats();
    return stats.heapSize + stats.extraMemorySize;
  }
  return process.memoryUsage().heapUsed;
}

const gc = await collector();
const host = new Host({ systemID: 'm', system: { maxActors: 2 * N + 16, maxEvents: N + 4096, tracing: false } }, { datamodel: DATAMODEL });
const compiled = compileCharts([{ name: 'fit.scxml', text: await chartText() }]);
host.addImage(compiled.image);
compiled.close();
const chart = host.chart('fit');
gc();
const quickjsHeap = () => host.quickjsHeapBytes ?? 0;
const before = { rss: process.memoryUsage().rss, heap: heap(), linear: await linearMemory(), quickjs: quickjsHeap() };
const sessions = [];
for (let i = 0; i < N; i++) sessions.push(host.spawn(chart));
await host.idle();
gc();
const after = { rss: process.memoryUsage().rss, heap: heap(), linear: await linearMemory(), quickjs: quickjsHeap() };
let best = Infinity, bestSpawn = Infinity;
for (let r = 0; r < ROUNDS; r++) {
  const t = performance.now();
  for (let i = 0; i < N; i++) host.send(sessions[i], 'inc');
  await host.idle();
  best = Math.min(best, ((performance.now() - t) * 1000) / N);
  const t2 = performance.now();
  const made = [];
  for (let i = 0; i < 2000; i++) made.push(host.spawn(chart));
  await host.idle();
  for (const m of made) host.terminate(m);
  await host.idle();
  bestSpawn = Math.min(bestSpawn, ((performance.now() - t2) * 1000) / 2000);
}
gc();
const resident = { rss: process.memoryUsage().rss, heap: heap(), linear: await linearMemory(), quickjs: quickjsHeap() };
host.sweep(2 * N + 16, 2 * N + 16); // marks: every actor ran since the last sweep
let blobBytes = 0, hibernated = 0;
for (const session of host.sweep(2 * N + 16, 2 * N + 16)) {
  blobBytes += host.hibernate(session).length;
  hibernated++;
}
gc();
await new Promise((resolve) => setTimeout(resolve, 50));
gc();
const asleep = { rss: process.memoryUsage().rss, heap: heap(), linear: await linearMemory(), quickjs: quickjsHeap() };
host.close();
const per = (key, at = after) => (at[key] - before[key]) / N;
const os = process.getBuiltinModule('node:os');
const cpus = os.cpus();
console.log(JSON.stringify({
  machine: `${os.type()} ${os.release()} ${os.arch()}, ${cpus[0]?.model ?? 'cpu unknown'}, ${cpus.length} CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GiB`,
  package: wasm ? '@tinyactors/wasm' : '@tinyactors/node',
  runtime: globalThis.Bun ? `bun ${globalThis.Bun.version}` : `node ${process.versions.node}`,
  chart: CHART_NAME, datamodel: DATAMODEL, actors: N, rounds: ROUNDS,
  eventMicroseconds: Number(best.toFixed(3)), spawnTerminateMicroseconds: Number(bestSpawn.toFixed(3)),
  residentBytesPerActor: Math.round(per('rss')), heapBytesPerActor: Math.round(per('heap')),
  linearBytesPerActor: wasm ? Math.round(per('linear')) : undefined, linearMemoryBytes: wasm ? after.linear : undefined,
  residentAfterEventsBytesPerActor: Math.round(per('rss', resident)), heapAfterEventsBytesPerActor: Math.round(per('heap', resident)),
  hibernated, blobBytesPerActor: Math.round(blobBytes / Math.max(hibernated, 1)),
  residentHibernatedBytesPerActor: Math.round(per('rss', asleep)), heapHibernatedBytesPerActor: Math.round(per('heap', asleep)),
  linearHibernatedBytes: wasm ? asleep.linear : undefined,
  quickjsHeapBytesPerActor: DATAMODEL === 'quickjs' ? Math.round(per('quickjs')) : undefined,
  quickjsHeapAfterEventsBytesPerActor: DATAMODEL === 'quickjs' ? Math.round(per('quickjs', resident)) : undefined,
}));
