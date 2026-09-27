'use strict';

// Step 10: prove the scale properties (ROADMAP step 10; ADRs 0002, 0003,
// 0005, 0007, 0014; core ADRs 0018, 0063, 0064). Runs on Node and Bun.
//
// A population benchmark in the style of tinyactors-test's scale_test.c. It
// measures 50,000 and 200,000 actors by default. TAT_SCALE_MAX_POPULATION
// raises the cap to 1,000,000 or 4,000,000; a population above 200,000 then
// runs only when its predicted peak fits in three quarters of the memory
// available at that moment.
//
// From one population to the next (a factor of four or five), each of these
// must stay flat per actor, so a walk over the population shows up as a
// ratio near the step against a bound of two:
//   - spawn plus bootstrap, per actor (CPU time);
//   - post plus delivery, per message (CPU time, a fixed sample of actors
//     spread over the table, so the ratio measures work, not cache misses);
//   - inspect, per call (CPU time, the same sample);
//   - one page of actorIDs(), per page (median wall time over a warm pass;
//     bound three, as in scale_test.c);
//   - the end-to-end run (post `work` to every actor, flush once), per actor;
//   - native bytes per actor (bound 1.25), and the largest single block the
//     system allocated, which must not grow at all (core ADR 0063 keeps the
//     actor table in pages).
// After warm-up a round of posts and deliveries makes no allocator call in
// the addon; core's calls are reported beside it (ADR 0014 point 6).
//
// No absolute duration is asserted. At the largest population measured the
// test prints the longest spawn, the longest pump turn, RSS, V8 heap
// and native bytes per actor, and total GC pause time, next to a plain
// JavaScript baseline (one object per actor with a switch-based handler).
//
// Three charts run (SCALE_VARIANTS=plain,data,ws by default):
//   - plain: no data. Step 10 measured it under core's null data model;
//     napi no longer chooses that model by itself, so it runs the
//     JavaScript data model every chart gets, with an empty data object;
//   - data: the JavaScript data model (step 11). Every actor has a data
//     object; every `ping` carries a new object as event data, and a
//     function assigns from it;
//   - ws: the websocket-shaped load (step 13). One actor per simulated
//     connection, with data; every inbound `ping` also sends the payload out
//     through a registered I/O processor (`ws.write` via "ws") and re-arms a
//     30-second idle timeout (a delayed send that exiting the state cancels
//     and entering it arms again), so every actor always holds one delayed
//     send.
//
// Baselines (printed beside tinyactors, never asserted): SCALE_BASELINES
// takes a comma-separated list of
//   - xstate: the same charts as xstate 5 actors (a dev dependency; skipped
//     with a message when it is not installed);
//   - object: the same loads as plain JavaScript objects with a
//     switch-based handler, the ws one with a setTimeout per object.
// They run the charts in SCALE_BASELINE_VARIANTS (plain,data,ws by default)
// at the same populations, capped at 1,000,000 whatever
// TAT_SCALE_MAX_POPULATION says, and a population above 200,000 only when
// its predicted peak fits the memory check (and, on Node, the V8 heap
// limit: raise it with NODE_OPTIONS=--max-old-space-size=...).
// SCALE_VARIANTS= (empty) runs no tinyactors variant, so each
// implementation can be measured in a process of its own.

const assert = require('node:assert/strict');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createSystem, statechart } = require('..');
const { ActorID } = require('../lib/actor');

const IS_BUN = typeof Bun !== 'undefined';
const POPULATIONS = [50_000, 200_000, 1_000_000, 4_000_000];
const DEFAULT_CAP = 200_000;
const COST_RATIO_BOUND = 2.0;
const PAGE_RATIO_BOUND = 3.0;
const BYTES_RATIO_BOUND = 1.25;
const SAMPLE = 1024;          // actors posted to and inspected, spread over the table
const REPEAT = 8;             // messages per sampled actor per round
const ROUNDS = 7;             // measured rounds; the median is kept
const PAGE_SIZE = 1024;
const BASELINE_CAP = 1_000_000;
// RSS at startup: each population's RSS per actor is measured from here,
// since memory freed by a smaller population stays mapped.
const PROCESS_RSS = process.memoryUsage().rss;

// A full garbage collection on either runtime.
const collect = (() => {
  if (IS_BUN) {
    return () => Bun.gc(true);
  }
  require('node:v8').setFlagsFromString('--expose-gc');
  return require('node:vm').runInNewContext('gc');
})();

function cpuMicros() {
  const { user, system } = process.cpuUsage();
  return user + system;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Bytes the JavaScript side holds after a full collection.
function jsRetained() {
  collect();
  const { heapUsed, arrayBuffers = 0 } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

// Allocator calls by the addon (every category but core's), and by core.
function allocatorCalls(system) {
  const memory = system.stats().memory;
  let addon = 0;
  for (const [name, counters] of Object.entries(memory)) {
    if (name !== 'total' && name !== 'core') {
      addon += counters.allocations + counters.frees;
    }
  }
  return { addon, core: memory.core.allocations + memory.core.frees };
}

// Memory that is free or can be reclaimed without swapping, as scale_test.c
// reads it; null when the platform does not say.
function availableBytes() {
  try {
    if (process.platform === 'darwin') {
      const text = execFileSync('vm_stat', { encoding: 'utf8' });
      const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
      let pages = 0;
      for (const label of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
        const match = new RegExp(`${label}:\\s+(\\d+)`).exec(text);
        pages += match ? Number(match[1]) : 0;
      }
      return pages * pageSize;
    }
    if (process.platform === 'linux') {
      const text = require('node:fs').readFileSync('/proc/meminfo', 'utf8');
      const match = /MemAvailable:\s+(\d+) kB/.exec(text);
      return match ? Number(match[1]) * 1024 : null;
    }
  } catch {
    // fall through
  }
  return os.freemem?.() ?? null;
}

const gb = (bytes) => (bytes / 2 ** 30).toFixed(1);

// Whether `population` runs: up to the cap, and above the default cap only
// when the predicted peak fits in three quarters of what is available.
function populationCap() {
  return Number(process.env.TAT_SCALE_MAX_POPULATION ?? DEFAULT_CAP);
}

function shouldRun(population, previous, peakRSS, cap = populationCap()) {
  if (population > cap) {
    return false;
  }
  if (population <= DEFAULT_CAP) {
    return true;
  }
  const available = availableBytes();
  if (available === null) {
    console.log(`scale.js: stopping at ${previous}: this platform does not report available memory`);
    return false;
  }
  const needed = (peakRSS * population) / previous;
  if (needed > available * 0.75) {
    console.log(`scale.js: stopping at ${previous}: ${population} would need about ${gb(needed)} GB, ` +
      `${gb(available)} GB is available (three quarters of it may be used)`);
    return false;
  }
  console.log(`scale.js: measuring ${population}: needs about ${gb(needed)} GB, ${gb(available)} GB available`);
  return true;
}

// `idle` takes `ping` and stays; `work` ends the actor.
const VARIANTS = {
  plain: {
    chart: () =>
      statechart({ family: 'scale', revision: 'v1' })
        .state('idle', (s) => {
          s.on('ping', (t) => t.target('idle'));
          s.on('work', (t) => t.target('done'));
        })
        .final('done'),
    payload: () => undefined,
  },
  data: {
    chart: () =>
      statechart({ family: 'scale-data', revision: 'v1' })
        .data('count', 0)
        .data('last', null)
        .state('idle', (s) => {
          s.on('ping', (t) =>
            t.target('idle')
              .assign('count', function () { return this.count + 1; })
              .assign('last', ({ event }) => event.data),
          );
          s.on('work', (t) => t.target('done'));
        })
        .final('done'),
    payload: (sequence) => ({ sequence, text: 'hello' }),
  },
  ws: {
    chart: () =>
      statechart({ family: 'scale-ws', revision: 'v1' })
        .data('count', 0)
        .data('last', null)
        .state('idle', (s) => {
          s.entry((a) => a.send('timeout', (send) => send.id('idle').after(30_000)));
          s.exit((a) => a.cancel('idle'));
          s.on('ping', (t) =>
            t.target('idle')
              .assign('count', function () { return this.count + 1; })
              .assign('last', ({ event }) => event.data)
              .send('ws.write', (send) => send.via('ws').data(({ event }) => event.data)),
          );
          s.on('timeout', (t) => t.target('done'));
          s.on('work', (t) => t.target('done'));
        })
        .final('done'),
    payload: (sequence) => ({ sequence, text: 'hello' }),
    // The outbound socket: counts the writes it is handed.
    options: (counters) => ({ io: { ws: { send() { counters.outbound += 1; } } } }),
  },
};

// GC pause while a population is measured (Node only): the total, and the
// part spent in minor (scavenge) and major (mark-compact) collections.
function gcObserver() {
  if (IS_BUN) {
    return { total: () => null, minor: () => null, major: () => null, max: () => null, stop() {} };
  }
  const { PerformanceObserver, constants } = require('node:perf_hooks');
  let total = 0;
  let minor = 0;
  let major = 0;
  let max = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      total += entry.duration;
      max = Math.max(max, entry.duration);
      const kind = entry.detail?.kind ?? entry.kind;
      if (kind === constants.NODE_PERFORMANCE_GC_MINOR) {
        minor += entry.duration;
      } else if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
        major += entry.duration;
      }
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  return { total: () => total, minor: () => minor, major: () => major, max: () => max, stop: () => observer.disconnect() };
}

function loopDelayMonitor() {
  try {
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    return {
      maxMs: () => histogram.max / 1e6,
      p99Ms: () => histogram.percentile(99) / 1e6,
      p50Ms: () => histogram.percentile(50) / 1e6,
      stop: () => histogram.disable(),
    };
  } catch {
    return { maxMs: () => null, p99Ms: () => null, p50Ms: () => null, stop() {} };
  }
}

async function measure(population, variant) {
  const gc = gcObserver();
  const jsBefore = jsRetained();
  const { chart, payload, options } = VARIANTS[variant];

  let done = 0;
  const counters = { outbound: 0 };
  const system = createSystem({ ...options?.(counters), done: () => { done += 1; } });
  const definition = system.define(chart());
  const largestBefore = system.stats().memory.total.largestBlock;

  // Spawn, keeping only a sample of views spread over the table.
  const stride = Math.floor(population / SAMPLE);
  const sample = [];
  let longestSpawn = 0n;
  const spawnStarted = cpuMicros();
  for (let at = 0; at < population; at += 1) {
    const started = process.hrtime.bigint();
    const actor = system.spawn(definition);
    const took = process.hrtime.bigint() - started;
    if (took > longestSpawn) {
      longestSpawn = took;
    }
    if (at % stride === 0 && sample.length < SAMPLE) {
      sample.push(actor);
    }
  }
  const spawned = cpuMicros();
  await system.flush();
  const bootstrapped = cpuMicros();
  const largestBlock = system.stats().memory.total.largestBlock;

  const nativeBytes = system.stats().memory.total.bytesInUse;
  const jsAfter = jsRetained();
  const rssAfter = process.memoryUsage().rss;

  // Post plus delivery: rounds of REPEAT pings to every sampled actor.
  let sequence = 0;
  const round = async () => {
    for (let repeat = 0; repeat < REPEAT; repeat += 1) {
      for (const actor of sample) {
        actor.post('ping', payload(sequence += 1));
      }
    }
    await system.flush();
  };
  await round(); // warm-up
  const postCosts = [];
  for (let at = 0; at < ROUNDS; at += 1) {
    const started = cpuMicros();
    await round();
    postCosts.push((cpuMicros() - started) / (sample.length * REPEAT));
  }
  const callsBefore = allocatorCalls(system);
  await round();
  const callsAfter = allocatorCalls(system);

  // Inspect the same sample.
  const inspectCosts = [];
  for (let at = 0; at < ROUNDS; at += 1) {
    const started = cpuMicros();
    for (let repeat = 0; repeat < REPEAT; repeat += 1) {
      for (const actor of sample) {
        system.inspect(actor);
      }
    }
    inspectCosts.push((cpuMicros() - started) / (sample.length * REPEAT));
  }

  // Pages of actorIDs(): walk twice, time the second walk.
  let pageCosts = [];
  let visited = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    pageCosts = [];
    visited = 0;
    const iterator = system.actorIDs({ pageSize: PAGE_SIZE });
    for (;;) {
      const started = process.hrtime.bigint();
      const step = iterator.next();
      const took = Number(process.hrtime.bigint() - started) / 1e3;
      if (step.done) {
        break;
      }
      visited += step.value.length / 2;
      if (step.value.length === PAGE_SIZE * 2) {
        pageCosts.push(took);
      }
    }
  }
  assert.equal(visited, population, 'the walk visits every actor once');

  // End to end: post `work` to every actor, flush once, all done. The
  // event-loop delay is sampled only while the pump runs the flush, so its
  // maximum is the longest pump turn (plus the hooks it calls), not the
  // test's own synchronous post loop.
  const e2eStarted = cpuMicros();
  for (const page of system.actorIDs({ pageSize: PAGE_SIZE })) {
    for (let at = 0; at < page.length; at += 2) {
      system.post(new ActorID(system, page[at], page[at + 1]), 'work');
    }
  }
  const loop = loopDelayMonitor();
  await new Promise((resolve) => setTimeout(resolve, 5)); // the monitor's first sample
  await system.flush();
  const e2eCost = (cpuMicros() - e2eStarted) / population;
  const loopDelayMs = loop.maxMs();
  const loopDelayP99Ms = loop.p99Ms();
  const loopDelayP50Ms = loop.p50Ms();
  loop.stop();
  assert.equal(done, population, 'every actor finished');
  if (options !== undefined) {
    assert.equal(counters.outbound, sequence, 'every inbound message sent one outbound write');
  }
  assert.equal([...system.actorIDs()].length, 0, 'finished actors were destroyed');

  await new Promise((resolve) => setTimeout(resolve, 20)); // GC entries arrive after a timer tick
  const gcPauseMs = gc.total();
  const gcMinorMs = gc.minor();
  const gcMajorMs = gc.major();
  const gcMaxMs = gc.max();
  gc.stop();
  system.close();

  return {
    variant,
    population,
    spawn: (spawned - spawnStarted) / population,
    bootstrap: (bootstrapped - spawned) / population,
    spawnAndBootstrap: (bootstrapped - spawnStarted) / population,
    longestSpawnUs: Number(longestSpawn) / 1e3,
    largestBlock,
    largestBefore,
    post: median(postCosts),
    inspect: median(inspectCosts),
    page: median(pageCosts),
    e2e: e2eCost,
    nativePerActor: nativeBytes / population,
    jsPerActor: (jsAfter - jsBefore) / population,
    rssPerActor: (rssAfter - PROCESS_RSS) / population,
    peakRSS: process.memoryUsage().rss,
    steady: { addon: callsAfter.addon - callsBefore.addon, core: callsAfter.core - callsBefore.core },
    loopDelayMs,
    loopDelayP99Ms,
    loopDelayP50Ms,
    gcPauseMs,
    gcMinorMs,
    gcMajorMs,
    gcMaxMs,
  };
}

// The same load as plain JavaScript objects, printed for comparison only.
function plainBaseline(population) {
  class Conn {
    constructor() {
      this.state = 'idle';
    }
    on(event) {
      switch (this.state) {
        case 'idle':
          if (event === 'work') this.state = 'done';
          break;
        default:
          break;
      }
    }
  }
  const before = jsRetained();
  const objects = new Array(population);
  for (let at = 0; at < population; at += 1) {
    objects[at] = new Conn();
  }
  const bytes = (jsRetained() - before) / population;
  const stride = Math.floor(population / SAMPLE);
  const started = cpuMicros();
  for (let repeat = 0; repeat < REPEAT * ROUNDS; repeat += 1) {
    for (let at = 0; at < SAMPLE; at += 1) {
      objects[at * stride].on('ping');
    }
  }
  const perEvent = (cpuMicros() - started) / (SAMPLE * REPEAT * ROUNDS);
  assert.ok(objects.length === population);
  return { bytes, perEvent };
}

// xstate 5, when it is installed (a dev dependency of this package).
function loadXstate() {
  try {
    return require('xstate');
  } catch {
    return null;
  }
}

// Baselines: the same three charts in other implementations. Each `make`
// returns spawn/send/done over one variant; `counters.outbound` counts the
// ws writes, as the tinyactors I/O processor does.
const BASELINES = {
  xstate: {
    missing: () => (loadXstate() === null ? 'xstate is not installed (pnpm install in tinyactors-napi)' : null),
    version: () => {
      try {
        return require('xstate/package.json').version;
      } catch {
        return 'unknown';
      }
    },
    make(variant, counters) {
      const { setup, assign, createActor } = loadXstate();
      // An external self-transition, as the tinyactors charts' t.target('idle'):
      // it exits and enters `idle`, which re-arms the ws idle timeout.
      const ping = { target: 'idle', reenter: true };
      let machine;
      if (variant === 'plain') {
        machine = setup({}).createMachine({
          id: 'scale',
          initial: 'idle',
          states: { idle: { on: { ping, work: 'done' } }, done: { type: 'final' } },
        });
      } else {
        const update = assign({
          count: ({ context }) => context.count + 1,
          last: ({ event }) => event.data,
        });
        const idle = {
          on: { ping: { ...ping, actions: variant === 'ws' ? [update, 'wsWrite'] : [update] }, work: 'done' },
        };
        if (variant === 'ws') {
          idle.after = { 30_000: 'done' };
        }
        machine = setup({
          // The outbound socket, provided by name like an I/O processor.
          actions: { wsWrite: () => { counters.outbound += 1; } },
        }).createMachine({
          id: `scale-${variant}`,
          context: () => ({ count: 0, last: null }),
          initial: 'idle',
          states: { idle, done: { type: 'final' } },
        });
      }
      return {
        spawn: () => createActor(machine).start(),
        send: (actor, type, data) => actor.send({ type, data }),
        done: (actor) => actor.getSnapshot().status === 'done',
      };
    },
  },
  object: {
    missing: () => null,
    version: () => 'plain JavaScript',
    make(variant, counters) {
      const withData = variant !== 'plain';
      const ws = variant === 'ws';
      const idleTimeout = (conn) => {
        conn.timer = null;
        conn.state = 'done';
      };
      class Conn {
        constructor() {
          this.state = 'idle';
          this.count = withData ? 0 : undefined;
          this.last = withData ? null : undefined;
          this.timer = ws ? setTimeout(idleTimeout, 30_000, this) : null;
        }
        on(type, data) {
          switch (this.state) {
            case 'idle':
              if (type === 'ping') {
                if (withData) {
                  this.count += 1;
                  this.last = data;
                }
                if (ws) {
                  counters.outbound += 1;
                  clearTimeout(this.timer);
                  this.timer = setTimeout(idleTimeout, 30_000, this);
                }
              } else if (type === 'work') {
                this.state = 'done';
                if (ws) {
                  clearTimeout(this.timer);
                  this.timer = null;
                }
              }
              break;
            default:
              break;
          }
        }
      }
      return {
        spawn: () => new Conn(),
        send: (conn, type, data) => conn.on(type, data),
        done: (conn) => conn.state === 'done',
      };
    },
  },
};

// Whether a baseline population runs: the tinyactors check, capped at
// BASELINE_CAP, and on Node within the V8 heap limit.
function shouldRunBaseline(population, previous) {
  const cap = Math.min(populationCap(), BASELINE_CAP);
  if (!shouldRun(population, previous.population, previous.peakRSS, cap)) {
    return false;
  }
  if (!IS_BUN) {
    const { heap_size_limit: limit } = require('node:v8').getHeapStatistics();
    const needed = previous.jsPerActor * population * 1.25;
    if (needed > limit) {
      console.log(`scale.js: stopping at ${previous.population}: ${population} would need about ${gb(needed)} GB ` +
        `of V8 heap, the limit is ${gb(limit)} GB (NODE_OPTIONS=--max-old-space-size=... raises it)`);
      return false;
    }
  }
  return true;
}

async function measureBaseline(kind, variant, population) {
  const counters = { outbound: 0 };
  const impl = BASELINES[kind].make(variant, counters);
  const { payload } = VARIANTS[variant];
  const gc = gcObserver();
  const jsBefore = jsRetained();

  // Spawn, keeping every actor (the application would keep them, and they
  // are the only way to reach them).
  const actors = new Array(population);
  const spawnStarted = cpuMicros();
  for (let at = 0; at < population; at += 1) {
    actors[at] = impl.spawn();
  }
  const spawn = (cpuMicros() - spawnStarted) / population;
  const jsAfter = jsRetained();
  const rssAfter = process.memoryUsage().rss;

  // Per message: rounds of REPEAT pings to the same spread-out sample as the
  // tinyactors measurement. xstate and the objects process a send
  // synchronously, so the time of the send is the time of the work.
  const stride = Math.floor(population / SAMPLE);
  const sample = [];
  for (let at = 0; at < SAMPLE; at += 1) {
    sample.push(actors[at * stride]);
  }
  let sequence = 0;
  const round = () => {
    for (let repeat = 0; repeat < REPEAT; repeat += 1) {
      for (const actor of sample) {
        impl.send(actor, 'ping', payload(sequence += 1));
      }
    }
  };
  round(); // warm-up
  const postCosts = [];
  for (let at = 0; at < ROUNDS; at += 1) {
    const started = cpuMicros();
    round();
    postCosts.push((cpuMicros() - started) / (sample.length * REPEAT));
  }

  // End to end: `work` to every actor. The loop is synchronous, so it
  // blocks the event loop for its whole duration.
  const e2eStarted = cpuMicros();
  const wallStarted = process.hrtime.bigint();
  for (const actor of actors) {
    impl.send(actor, 'work');
  }
  const blockingMs = Number(process.hrtime.bigint() - wallStarted) / 1e6;
  const e2e = (cpuMicros() - e2eStarted) / population;
  let finished = 0;
  for (const actor of actors) {
    finished += impl.done(actor) ? 1 : 0;
  }
  assert.equal(finished, population, `${kind} ${variant}: every actor finished`);
  if (variant === 'ws') {
    assert.equal(counters.outbound, sequence, `${kind} ${variant}: every inbound message sent one outbound write`);
  }
  await new Promise((resolve) => setTimeout(resolve, 20)); // GC entries arrive after a timer tick
  const result = {
    kind,
    variant,
    population,
    spawn,
    post: median(postCosts),
    e2e,
    blockingMs,
    jsPerActor: (jsAfter - jsBefore) / population,
    rssPerActor: (rssAfter - PROCESS_RSS) / population,
    peakRSS: process.memoryUsage().rss,
    gcPauseMs: gc.total(),
    gcMinorMs: gc.minor(),
    gcMajorMs: gc.major(),
    gcMaxMs: gc.max(),
  };
  gc.stop();
  actors.fill(undefined);
  return result;
}

function reportBaseline(result) {
  const f = (value, digits = 3) => (value === null || value === undefined ? 'n/a' : value.toFixed(digits));
  console.log(
    `scale.js ${IS_BUN ? 'bun' : 'node'} baseline ${result.kind} ${result.variant} ${result.population}: ` +
      `spawn ${f(result.spawn)} us/actor, post ${f(result.post)} us/msg, end-to-end ${f(result.e2e)} us/actor ` +
      `(blocks the event loop ${f(result.blockingMs, 1)} ms), js ${f(result.jsPerActor, 1)} B/actor, ` +
      `rss ${f(result.rssPerActor, 1)} B/actor, gc pause ${f(result.gcPauseMs, 1)} ms ` +
      `(minor ${f(result.gcMinorMs, 1)}, major ${f(result.gcMajorMs, 1)}, longest ${f(result.gcMaxMs, 1)})`,
  );
}

async function runBaselines(setCurrent) {
  const kinds = (process.env.SCALE_BASELINES ?? '').split(',').filter(Boolean);
  const variants = (process.env.SCALE_BASELINE_VARIANTS ?? 'plain,data,ws').split(',').filter(Boolean);
  for (const kind of kinds) {
    const baseline = BASELINES[kind];
    assert.ok(baseline, `unknown baseline ${kind} (known: ${Object.keys(BASELINES).join(', ')})`);
    const missing = baseline.missing();
    if (missing !== null) {
      console.log(`scale.js: skipping the ${kind} baseline: ${missing}`);
      continue;
    }
    console.log(`scale.js: ${kind} baseline (${baseline.version()})`);
    for (const variant of variants) {
      let previous;
      for (const population of POPULATIONS) {
        if (previous && !shouldRunBaseline(population, previous)) {
          break;
        }
        if (population > BASELINE_CAP) {
          break;
        }
        setCurrent(`${kind} ${variant} with ${population} actors`);
        previous = await measureBaseline(kind, variant, population);
        reportBaseline(previous);
      }
    }
  }
}

function requireFlat(what, small, large, bound) {
  const ratio = small.value > 0 ? large.value / small.value : 0;
  assert.ok(
    ratio <= bound,
    `${what} measures ${small.value.toFixed(3)} at ${small.population} actors and ` +
      `${large.value.toFixed(3)} at ${large.population}, a ratio of ${ratio.toFixed(2)} against a bound of ${bound}`,
  );
  return ratio;
}

function report(result) {
  const f = (value, digits = 3) => (value === null || value === undefined ? 'n/a' : value.toFixed(digits));
  console.log(
    `scale.js ${IS_BUN ? 'bun' : 'node'} ${result.variant} ${result.population}: ` +
      `spawn ${f(result.spawn)} us + bootstrap ${f(result.bootstrap)} us/actor, ` +
      `longest spawn ${f(result.longestSpawnUs, 1)} us, largest block ${result.largestBlock} B, ` +
      `post+delivery ${f(result.post)} us/msg, inspect ${f(result.inspect)} us, ` +
      `page(${PAGE_SIZE}) ${f(result.page, 1)} us, end-to-end ${f(result.e2e)} us/actor, ` +
      `native ${f(result.nativePerActor, 1)} B/actor, js ${f(result.jsPerActor, 1)} B/actor, ` +
      `rss ${f(result.rssPerActor, 1)} B/actor, steady-state calls addon ${result.steady.addon} core ${result.steady.core}, ` +
      `turns (event-loop delay during flush) p50 ${f(result.loopDelayP50Ms, 1)} p99 ${f(result.loopDelayP99Ms, 1)} max ${f(result.loopDelayMs, 1)} ms, ` +
      `gc pause ${f(result.gcPauseMs, 1)} ms (minor ${f(result.gcMinorMs, 1)}, major ${f(result.gcMajorMs, 1)}, ` +
      `longest ${f(result.gcMaxMs, 1)})`,
  );
}

(async () => {
  let current = 'start';
  const watchdog = setTimeout(() => {
    console.error(`scale.js: ${current} did not finish in time`);
    process.exit(1);
  }, Number(process.env.SCALE_TIMEOUT_MS ?? 30 * 60_000));

  const variants = (process.env.SCALE_VARIANTS ?? 'plain,data,ws').split(',').filter(Boolean);
  let largest;
  for (const variant of variants) {
    const results = [];
    for (const population of POPULATIONS) {
      const previous = results.at(-1);
      if (previous && !shouldRun(population, previous.population, previous.peakRSS)) {
        break;
      }
      current = `${variant} with ${population} actors`;
      const result = await measure(population, variant);
      report(result);
      assert.equal(result.steady.addon, 0, `after warm-up the addon made ${result.steady.addon} allocator calls`);
      assert.equal(result.steady.core, 0, `${variant}: after warm-up core made ${result.steady.core} allocator calls`);
      results.push(result);
    }

    for (let at = 1; at < results.length; at += 1) {
      const small = results[at - 1];
      const large = results[at];
      const pair = (key) => [
        { population: small.population, value: small[key] },
        { population: large.population, value: large[key] },
      ];
      const what = (text) => `${variant}: ${text}`;
      requireFlat(what('spawn plus bootstrap (us per actor)'), ...pair('spawnAndBootstrap'), COST_RATIO_BOUND);
      requireFlat(what('post plus delivery (us per message)'), ...pair('post'), COST_RATIO_BOUND);
      requireFlat(what('inspect (us per call)'), ...pair('inspect'), COST_RATIO_BOUND);
      requireFlat(what(`a page of ${PAGE_SIZE} actor IDs (us)`), ...pair('page'), PAGE_RATIO_BOUND);
      requireFlat(what('end to end (us per actor)'), ...pair('e2e'), COST_RATIO_BOUND);
      requireFlat(what('native bytes per actor'), ...pair('nativePerActor'), BYTES_RATIO_BOUND);
      assert.ok(
        large.largestBlock <= small.largestBlock,
        `${variant}: the largest block grew from ${small.largestBlock} B at ${small.population} actors ` +
          `to ${large.largestBlock} B at ${large.population}`,
      );
    }
    largest = results.at(-1);
  }

  if (largest !== undefined) {
    const baseline = plainBaseline(largest.population);
    console.log(
      `scale.js ${IS_BUN ? 'bun' : 'node'} plain-object baseline at ${largest.population}: ` +
        `${baseline.bytes.toFixed(1)} B/object (JS heap), ${baseline.perEvent.toFixed(3)} us/event (direct call)`,
    );
  }

  await runBaselines((what) => { current = what; });

  clearTimeout(watchdog);
  console.log('scale.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
