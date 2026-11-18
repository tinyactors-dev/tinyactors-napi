// Bytes per actor at a population of actors of one chart, resident and
// idle, on the native "ecmascript" datamodel and on quickjs, under node and
// bun (docs/plan.xml, p1-measure; translated from
// tinyactors-cpython/tools/measure.py).
//
//     node tools/measure.mjs [--actors N] [--json PATH] [--runtime name=path]...
//
// Each configuration (runtime, datamodel) is measured in a process of its
// own, so none inherits another's heap. A measurement creates a host, adds
// the image, warms the chart (one actor spawned and terminated), takes the
// baselines after a forced collection, spawns N actors (each runs its
// initial macrostep), awaits the idle turn, collects, and reports per
// actor:
//
// - resident: the process's resident set (process.memoryUsage().rss),
//   after minus before;
// - heap: the engine's heap after a forced collection, after minus before:
//   on node V8's heapUsed plus external (the ArrayBuffers' backing stores;
//   Node 22 does not count napi_adjust_external_memory there), on bun
//   JavaScriptCore's heapSize plus extraMemorySize (bun:jsc's heapStats).
//   The native datamodel's scopes, contexts and values are here; quickjs's
//   heap is its own malloc, which only resident shows;
// - region: host.stats' regionBytes after, divided by N: the host's blocks
//   for the segment, sized for the population up front (maxActors), so the
//   share of an actor of what the region holds whatever the datamodel;
// - after one event to each actor ("inc"), which then keeps its _event
//   (SCXML 5.10: until the next event): resident, heap and region again,
//   each from the same baseline.
//
// Run by `mise run measure`, which passes the pinned runtimes; the report
// gives the machine's signature beside the numbers and the four
// configurations side by side from one run (root AGENTS.md, "Benchmarks").

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DATAMODELS = ['native', 'quickjs'];

// The chart of tinyactors-cpython/tools/charts/fit.ecmascript.scxml: three
// <data>, one of them a list.
const CHART = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="fit" initial="idle">
  <datamodel>
    <data id="count" expr="0" />
    <data id="label" expr="'actor'" />
    <data id="items" expr="[]" />
  </datamodel>
  <state id="idle">
    <transition event="inc" cond="count &lt; 100">
      <assign location="count" expr="count + 1" />
    </transition>
    <transition event="add">
      <script>items.push(_event.data)</script>
    </transition>
  </state>
</scxml>
`;

function options(argv) {
  const parsed = { actors: 10000, json: undefined, one: undefined, runtimes: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (flag === '--actors') parsed.actors = Number(value);
    else if (flag === '--json') parsed.json = value;
    else if (flag === '--one') parsed.one = value;
    else if (flag === '--runtime') {
      const at = value.indexOf('=');
      parsed.runtimes.push({ name: value.slice(0, at), path: value.slice(at + 1) });
    } else throw new Error(`measure: unknown option ${flag}`);
  }
  if (!Number.isSafeInteger(parsed.actors) || parsed.actors < 1) throw new Error('measure: --actors takes a count');
  return parsed;
}

// A full collection, then turns for the finalizers (test/harness.mjs's
// collect): node's gc() is exposed at run time.
async function collector() {
  let gc;
  if (globalThis.Bun) gc = () => globalThis.Bun.gc(true);
  else {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose_gc');
    gc = vm.runInNewContext('gc');
  }
  return async () => {
    for (let i = 0; i < 4; i++) {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

async function engineHeap() {
  if (globalThis.Bun) {
    const { heapStats } = await import('bun:jsc');
    const stats = heapStats();
    return stats.heapSize + stats.extraMemorySize;
  }
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

function region(host) {
  return new Promise((resolve, reject) => {
    host.hostStats(undefined, (_host, result) => resolve(result.host.regionBytes), (_host, error) => reject(error));
  });
}

async function sample(host, collect) {
  const stats = region(host);
  await host.idle();
  await collect();
  return { resident: process.memoryUsage().rss, heap: await engineHeap(), region: await stats };
}

async function measure(datamodel, actors) {
  const { Host, compileCharts } = await import('../index.mjs');
  const collect = await collector();
  // every pool sized for the population, so nothing grows: a segment that grows doubles every pool
  // (quickjs keeps each actor's last event, so maxEvents counts the actors); tracing off
  const config = { systemID: 'measure', system: { maxActors: actors + 16, maxEvents: actors + 4096, tracing: false } };
  const host = new Host(config, { datamodel });
  try {
    const compiled = compileCharts([{ name: 'fit.scxml', text: CHART }]);
    host.addImage(compiled.image);
    compiled.close();
    const chart = host.chart('fit');
    const warm = host.spawn(chart); // the chart's code attached and warmed
    await host.idle();
    host.terminate(warm);
    await host.idle();
    const before = await sample(host, collect);
    const sessions = new BigInt64Array(actors); // 8 B an actor, in heap (external)
    for (let i = 0; i < actors; i++) sessions[i] = host.spawn(chart);
    await host.idle();
    const after = await sample(host, collect);
    for (let first = 0; first < actors; first += 256) { // one event each: each keeps its _event
      const items = [];
      for (let i = first; i < Math.min(actors, first + 256); i++) items.push({ target: sessions[i], event: 'inc' });
      host.sendMany(items);
      await host.idle();
    }
    const evented = await sample(host, collect);
    const per = (to, key) => (to[key] - before[key]) / actors;
    return {
      runtime: globalThis.Bun ? 'bun' : 'node',
      version: globalThis.Bun ? globalThis.Bun.version : process.versions.node,
      engine: globalThis.Bun ? `JavaScriptCore, WebKit ${(process.versions.webkit ?? '?').slice(0, 12)}` : `V8 ${process.versions.v8}`,
      datamodel, actors,
      resident: per(after, 'resident'), heap: per(after, 'heap'), region: after.region / actors,
      residentEvented: per(evented, 'resident'), heapEvented: per(evented, 'heap'),
      regionEvented: evented.region / actors,
    };
  } finally {
    host.close();
  }
}

function signature(results) {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model ?? 'unknown', cpus: cpus.length, arch: os.arch(),
    os: `${os.type()} ${os.release()}`, memory: `${Math.round(os.totalmem() / 2 ** 30)} GiB`,
    runtimes: [...new Map(results.map((r) => [r.runtime, `${r.runtime} ${r.version} (${r.engine})`])).values()],
  };
}

const pad = (text, width) => String(text).padStart(width);

async function main() {
  const parsed = options(process.argv.slice(2));
  if (parsed.one) {
    process.stdout.write(`${JSON.stringify(await measure(parsed.one, parsed.actors))}\n`);
    return;
  }
  const runtimes = parsed.runtimes.length ? parsed.runtimes : [{ name: 'node', path: process.execPath }];
  const results = [];
  for (const runtime of runtimes) {
    for (const datamodel of DATAMODELS) {
      const child = spawnSync(runtime.path, [fileURLToPath(import.meta.url), '--one', datamodel,
                                             '--actors', String(parsed.actors)], { encoding: 'utf8' });
      if (child.status !== 0) {
        process.stderr.write(child.stderr);
        throw new Error(`measure: ${runtime.name} ${datamodel} exited with ${child.status}`);
      }
      results.push(JSON.parse(child.stdout));
    }
  }
  const machine = signature(results);
  console.log(`machine: ${machine.cpu}, ${machine.cpus} CPUs, ${machine.arch}, ${machine.os}, ${machine.memory}`);
  console.log(`runtimes: ${machine.runtimes.join('; ')}`);
  console.log(`bytes per actor at ${parsed.actors} actors of one chart, resident and idle:`);
  console.log(`${'runtime'.padEnd(8)}${'datamodel'.padEnd(10)}${pad('resident', 10)}${pad('heap', 9)}${pad('region', 9)}`
              + ` | after one event each:${pad('resident', 10)}${pad('heap', 9)}${pad('region', 9)}`);
  for (const r of results) {
    const n = (value) => value.toFixed(0);
    console.log(`${r.runtime.padEnd(8)}${r.datamodel.padEnd(10)}${pad(n(r.resident), 10)}${pad(n(r.heap), 9)}`
                + `${pad(n(r.region), 9)} | ${' '.repeat(21)}${pad(n(r.residentEvented), 10)}`
                + `${pad(n(r.heapEvented), 9)}${pad(n(r.regionEvented), 9)}`);
  }
  if (parsed.json) writeFileSync(parsed.json, `${JSON.stringify({ machine, results }, null, 2)}\n`);
}

await main();
