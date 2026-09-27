'use strict';

// Bench (not part of `mise run test`): what tracing costs (core ADR 0067,
// napi ADRs 0016 and 0017). Runs on Node and Bun.
//
//   node --expose-gc test/bench/tracing.js [population] [--check]
//        [--variants=a,b,...] [--exclusive] [--json=<file>] [--list]
//
// --variants always adds `untraced` for comparison unless --exclusive is
// given; --list prints the variant names as JSON and exits. `mise run
// bench` runs each variant in a process of its own (--exclusive), because
// RSS measured after an earlier variant's system closed reads memory the
// allocator kept, not what this variant needs.
//
// `mise run bench` and `mise run bench-compare` run it and key the results
// by machine signature (bench/results/README.md). --json writes one record
// per variant: throughput and memory together. Memory is measured after
// the actors are spawned and a GC ran (--expose-gc on Node, Bun.gc on Bun):
// core and native bytes per actor by category, RSS and JavaScript heap per
// actor (deltas from before the system was created), allocator calls per
// delivered event over the timed rounds, and the process's peak RSS.
//
// --check fails (exit 1) when a budget of napi ADR 0017 section 2 is
// exceeded: a traceparent on an untraced system, and a sampled-out
// macrostep with a sink installed, each cost at most 40 ns per event more
// than untraced. `mise run bench-check` runs it.
//
// Posts `ping` to every actor and flushes, five rounds, and reports the
// median and best events per second, and core's bytes per idle actor:
// - untraced: no sink, so core runs with its null sink and builds nothing;
// - traceparent: untraced, but every post carries a sampled traceparent,
//   which core parses (core ADR 0073);
// - sampled out: a sink that wants every kind, and every post carries an
//   unsampled traceparent, so core builds nothing;
// - macrosteps: a sink that wants macrostepBegin and macrostepEnd only;
// - every record: a sink that wants every kind; the addon encodes the
//   spans as OTLP protobuf and hands over the bytes, which are dropped:
//   what an exporter pays before it posts them;
// - decoded: every record, and decodeTraces() of each batch, which is what
//   a user who wants span objects in JavaScript pays.
// The configurations a deployment would choose (napi ADR 0017 section 3),
// with no traceparent, so the system starts every trace itself:
// - summary: the default detail (a span per macrostep, lifecycle, failures);
// - decisions: adds microsteps, conditions and raised events;
// - summary 10% and summary 1%: the default detail, sampled at that ratio;
// - full + values: every record, with event data and values as attributes;
// - watch N: nothing sampled, and N actors watched in full (by session;
//   watchTraces has no limit), which is what turning tracing on for a
//   few actors at 3am costs. WATCH (default 1000) sets N;
// - summary without logs: the default detail with the log output switched off.
// For comparison, napi ADR 0016 measured before it (every record): plain
// record objects 0.19M events/s, objects mapped to spans 0.13M, and the
// prototype encoder 0.83M.
// The chart's transition assigns, so every macrostep writes BEGIN,
// MICROSTEP, ASSIGN and END.

const { createSystem, statechart, decodeTraces } = require('../..');

const args = process.argv.slice(2);
const check = args.includes('--check');
const population = Number(args.find((arg) => !arg.startsWith('--')) ?? 100000);
const WATCH = Number(process.env.WATCH ?? 1000);
const exclusive = args.includes('--exclusive');
const jsonPath = args.find((arg) => arg.startsWith('--json='))?.slice('--json='.length);
const only = args.find((arg) => arg.startsWith('--variants='))?.slice('--variants='.length).split(',');
const BUDGET_NS = 40;
const SAMPLED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const UNSAMPLED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
const rounds = 5;
let bytesOut = 0;

function chart() {
  return statechart({ family: 'bench-traced', revision: 'v1' })
    .data('count', 0)
    .state('idle', (s) => { s.on('ping', (t) => t.assign('count', function () { return this.count + 1; })); });
}

const collect = globalThis.gc ?? (typeof Bun !== 'undefined' ? () => Bun.gc(true) : undefined);

function settle() {
  collect?.();
  const { rss, heapUsed } = process.memoryUsage();
  return { rss, heapUsed };
}

async function measure({ install, traceparent, watch }) {
  const before = settle();
  const system = createSystem();
  install?.(system);
  const definition = system.define(chart());
  const actors = [];
  for (let at = 0; at < population; at += 1) actors.push(system.spawn(definition));
  await system.flush();
  watch?.(system, actors);
  const after = settle();
  const stats = system.stats();
  const idle = stats.memory.core.bytesInUse / population;
  const native = {};
  for (const [category, counters] of Object.entries(stats.memory)) {
    native[category] = counters.bytesInUse / population;
  }
  const memory = {
    coreBytesPerActor: idle,
    nativeBytesPerActor: native,
    rssBytesPerActor: (after.rss - before.rss) / population,
    heapBytesPerActor: (after.heapUsed - before.heapUsed) / population,
  };
  const callsBefore = stats.allocatorCalls;
  const rates = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = process.hrtime.bigint();
    const options = traceparent === undefined ? undefined : { traceparent };
    for (const actor of actors) system.post(actor, 'ping', undefined, options);
    await system.flush();
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    rates.push(population / seconds);
  }
  memory.allocatorCallsPerEvent = (system.stats().allocatorCalls - callsBefore) / (population * rounds);
  system.close();
  memory.peakRSSBytes = process.resourceUsage().maxRSS * 1024;
  rates.sort((a, b) => a - b);
  return { idle, memory, median: rates[Math.floor(rounds / 2)], best: rates.at(-1) };
}

const variants = {
  untraced: {},
  traceparent: { traceparent: SAMPLED },
  'sampled out': { install: (system) => system.setTraceSink(() => {}), traceparent: UNSAMPLED },
  macrosteps: { install: (system) => system.setTraceSink(() => {}, { kinds: ['macrostepBegin', 'macrostepEnd'] }) },
  'every record': { install: (system) => system.setTraceSink((bytes) => { bytesOut += bytes.length; }, { detail: 'full' }) },
  decoded: { install: (system) => system.setTraceSink((bytes) => { decodeTraces(bytes); }, { detail: 'full' }) },
  summary: { install: (system) => system.setTraceSink(count) },
  decisions: { install: (system) => system.setTraceSink(count, { detail: 'decisions' }) },
  'summary 10%': { install: (system) => system.setTraceSink(count, { sample: 0.1 }) },
  'summary 1%': { install: (system) => system.setTraceSink(count, { sample: 0.01 }) },
  'full + values': { install: (system) => system.setTraceSink(count, { detail: 'full', values: true }) },
  [`watch ${WATCH}`]: {
    install: (system) => system.setTraceSink(count, { sample: 0 }),
    watch: (system, actors) =>
      system.watchTraces({ sessions: actors.filter((_, at) => at % Math.ceil(actors.length / WATCH) === 0).slice(0, WATCH) }),
  },
  'summary without logs': { install: (system) => system.setTraceSink(count, { logs: false }) },
};
function count(traces, logs) {
  bytesOut += traces.length + (logs?.length ?? 0);
}
const budgeted = ['traceparent', 'sampled out'];

if (args.includes('--list')) {
  console.log(JSON.stringify(Object.keys(variants)));
  process.exit(0);
}

(async () => {
  const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;
  console.log(`${runtime}, ${population} actors, ${rounds} rounds`);
  console.log('variant          events/s (median)   events/s (best)   ns/event   core bytes/actor');
  const ns = {};
  const records = [];
  for (const [name, variant] of Object.entries(variants)) {
    if (check && name !== 'untraced' && !budgeted.includes(name)) {
      continue;
    }
    if (only && (exclusive || name !== 'untraced') && !only.includes(name)) {
      continue;
    }
    bytesOut = 0;
    let result;
    try {
      result = await measure(variant);
    } catch (error) {
      // An older build (bench-compare) may lack what a variant uses.
      records.push({ variant: name, population, rounds, error: String(error?.message ?? error) });
      console.log(`${name.padEnd(16)} failed: ${error?.message ?? error}`);
      continue;
    }
    const { idle, memory, median, best } = result;
    ns[name] = 1e9 / best;
    const otlpBytesPerEvent = bytesOut === 0 ? null : bytesOut / (population * (rounds + 1));
    if (otlpBytesPerEvent !== null) {
      console.log(`  OTLP bytes per event: ${otlpBytesPerEvent.toFixed(0)}`);
    }
    records.push({
      variant: name,
      population,
      rounds,
      throughput: { eventsPerSecondMedian: median, eventsPerSecondBest: best, nsPerEvent: 1e9 / best },
      memory: { ...memory, otlpBytesPerEvent },
    });
    console.log(`${name.padEnd(16)} ${(median / 1e6).toFixed(2).padStart(10)} M ${(best / 1e6).toFixed(2).padStart(15)} M ` +
                `${ns[name].toFixed(0).padStart(10)} ${idle.toFixed(0).padStart(18)}`);
  }
  // Budgets compare the best rounds: noise only ever adds time.
  let over = false;
  for (const name of budgeted.filter((name) => ns[name] !== undefined)) {
    const extra = ns[name] - ns.untraced;
    const verdict = extra <= BUDGET_NS ? 'within' : 'OVER';
    over ||= extra > BUDGET_NS;
    console.log(`budget: ${name} costs ${extra.toFixed(0)} ns/event over untraced (${verdict} ${BUDGET_NS} ns)`);
  }
  if (check && over) {
    process.exitCode = 1;
  }
  if (jsonPath !== undefined) {
    require('node:fs').writeFileSync(jsonPath, `${JSON.stringify({ runtime, records })}\n`);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
