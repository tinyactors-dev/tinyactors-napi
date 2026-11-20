// Every operation at two population sizes: a gate against accidentally
// quadratic work (docs/plan.xml, p2-scale).
//
//     node tools/scale.mjs [--actors N] [--datamodel native|quickjs] [--scenario hibernated|resident|all]
//                          [--samples S] [--min-ms M] [--attempts A] [--json FILE]
//
// Each operation of the API is timed on a host holding N actors and on one
// holding 2N, each host in a process of its own (this file again, with
// --child), and the cost at 2N must be within FACTOR of the cost at N:
// per call for an operation on one actor (spawn, send, a typed method, a
// round trip), per actor for an operation on the whole population
// (populate, a full actor.list, a sweep of every actor, migrating a
// chart, snapshot, restore, close). A cost that grows with the population
// shows as a ratio near 2: a scan per call.
//
// Two scenarios, each a host of its own:
//
// - hibernated: N actors of a counter, at most RESIDENT of them in memory,
//   the rest hibernated in the runtime's SQLite (tools/store.mjs, as
//   tools/stress.mjs keeps them), and N/100 actors each running an invoked
//   service, so that core's requests grow with the population too. Every
//   operation of the API runs here.
// - resident: N actors of the counter, all in memory, the segment grown
//   from its default size (so a spawn pays its share of the relocations):
//   the operations whose cost could depend on the resident population.
//
// How a cost is measured: an operation runs in batches (64 calls, say,
// then the turn that answers them); batches add up to a sample of at least
// --min-ms milliseconds; the cost is the least of --samples samples (of
// three for an operation on the whole population): a collection or a
// neighbour only adds time to a sample, a scan adds it to every one. What
// a batch needs first or leaves behind (actors to wake, put back to sleep,
// spawned to be terminated) is done outside the timed part. When an
// operation exceeds the factor and is not a known gap in core (KNOWN), the
// two sizes are measured again, up to --attempts times, each time with the
// next seed, and each size keeps
// each operation's lowest cost: noise only adds time and does not repeat,
// a scan does. From the third attempt the median of the attempts' own
// ratios counts too (see `gate`): a slow minute of the machine slows both
// sizes of one attempt alike.
//
// Prints a table per scenario with the machine's signature and exits 1 when
// an operation exceeds the factor and is not KNOWN. --json writes the
// numbers.

import { spawn as spawnChild } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, compileCharts, compileSystem, Host, SimulatedClock, StaleError, TinyactorsError } from '@tinyactors/node';
import { BATCH, engine, random, Store } from './store.mjs';

/** The most the cost at 2N may be of the cost at N. */
export const FACTOR = 1.5;
/** Actors in memory at most in the hibernated scenario, besides the invokers. */
const RESIDENT = 1000;

/** Operations whose cost grows with the population because of core, each
 * with the request to core that says so (docs/log.xml): reported as
 * failing, never as passing, and not retried. */
export const KNOWN = {};

const COUNTER = (version) => `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="s">
  <datamodel>
    <data id="n" expr="0" />
    <data id="v" expr="${version}" />
  </datamodel>
  <state id="s">${version === 2 ? `
    <transition event="error.platform.upgrade">
      <assign location="n" expr="_event.data.n" />
    </transition>` : ''}
    <transition event="inc">
      <assign location="n" expr="n + 1" />
    </transition>
    <transition event="ask">
      <send type="urn:scale:echo" target="echo" event="ask" />
    </transition>
    <transition event="answer">
      <assign location="n" expr="n + 1" />
    </transition>
    <transition event="arm">
      <send event="tick" delay="10ms" />
    </transition>
    <transition event="tick">
      <assign location="n" expr="n + 1" />
    </transition>
    <transition event="call">
      <send event="ping" targetexpr="_event.data.to" />
    </transition>
    <transition event="pong">
      <assign location="n" expr="n + 1" />
    </transition>
  </state>
</scxml>
`;

const INVOKER = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="invoker" initial="s">
  <datamodel>
    <data id="n" expr="0" />
  </datamodel>
  <state id="s">
    <invoke id="svc" type="urn:scale:service" src="service://local" />
    <transition event="go">
      <send target="#_svc" event="ping" />
    </transition>
    <transition event="pong">
      <assign location="n" expr="n + 1" />
    </transition>
  </state>
</scxml>
`;

// The boot actor: it ends as soon as it starts, so booting again and again
// leaves the population as it was.
const BLIP = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="blip" initial="f">
  <final id="f" />
</scxml>
`;

const SYSTEM = `<system>
  <chart name="counter" src="counter.scxml" />
  <chart name="invoker" src="invoker.scxml" />
  <chart name="blip" src="blip.scxml" />
  <actor name="booted" chart="blip" />
</system>
`;

// The other system of the transport round trip: it answers each ping to
// where it came from.
const ECHO = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="echo" initial="s">
  <state id="s">
    <transition event="ping">
      <send event="pong" targetexpr="_event.origin" />
    </transition>
  </state>
</scxml>
`;

const FILES = { 'counter.scxml': COUNTER(1), 'invoker.scxml': INVOKER, 'blip.scxml': BLIP };

function options(argv) {
  const given = {
    actors: 2_000_000, 'resident-actors': 0, datamodel: 'native', scenario: 'all', samples: 5, 'min-ms': 200, attempts: 2,
    json: '', child: '', seed: 1,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    if (!(name in given) || i + 1 >= argv.length) throw new Error(`unknown option ${argv[i]}`);
    given[name] = typeof given[name] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!['native', 'quickjs'].includes(given.datamodel)) throw new Error('--datamodel is native or quickjs');
  if (!['hibernated', 'resident', 'all'].includes(given.scenario)) throw new Error('--scenario is hibernated, resident or all');
  return given;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Distinct members of a dense set, drawn at random. */
class IndexSet {
  constructor(capacity) {
    this.items = new Int32Array(capacity);
    this.position = new Int32Array(capacity).fill(-1);
    this.size = 0;
  }

  has(i) {
    return this.position[i] >= 0;
  }

  add(i) {
    if (this.position[i] >= 0) return;
    this.position[i] = this.size;
    this.items[this.size++] = i;
  }

  delete(i) {
    const at = this.position[i];
    if (at < 0) return;
    const last = this.items[--this.size];
    this.items[at] = last;
    this.position[last] = at;
    this.position[i] = -1;
  }

  /** `k` distinct members drawn at random (all of them when there are fewer). */
  pick(k, draw) {
    const chosen = new Set();
    k = Math.min(k, this.size);
    while (chosen.size < k) chosen.add(this.items[Math.floor(draw() * this.size)]);
    return [...chosen];
  }
}

/** Times the operations of one host: each one's batches, its samples, their least. */
class Clock {
  constructor(o, results) {
    this.o = o;
    this.results = results;
  }

  /** `batch()` runs one batch and returns {ms, calls} of its timed part; at
   * most `batches` of them make a sample. */
  async time(name, unit, batch, { batches = Infinity, samples = this.o.samples } = {}) {
    const costs = [];
    let calls = 0;
    for (let s = 0; s < samples; s++) {
      let ms = 0;
      let n = 0;
      for (let b = 0; b < batches && (b === 0 || ms < this.o['min-ms']); b++) {
        const got = await batch();
        ms += got.ms;
        n += got.calls;
      }
      costs.push((ms * 1000) / n); // microseconds per call or per actor
      calls += n;
    }
    this.record(name, unit, costs, calls);
  }

  // the least of the samples, per call as per actor (a whole population
  // at a time, where the first sample pays for room the later ones reuse
  // and gigabytes of pages fault in): the median let a collection in
  // three samples of five decide a cost, and the fast pass failed in 3 of
  // 8 runs on operations nobody touched (docs/log.xml,
  // l-p2-decisions-scale-gate-noise)
  record(name, unit, costs, calls) {
    const cost = Math.min(...costs);
    this.results[name] = { unit, cost, costs, calls };
    console.log(`  ${name}: ${cost.toFixed(3)} µs ${unit} (${calls} ${unit === 'per actor' ? 'actors' : 'calls'}, ` +
      `samples ${costs.map((c) => c.toFixed(3)).join(' ')})`);
  }
}

/** The actors `host` holds, resident and hibernated (host.stats). */
async function actorsOf(host) {
  let got;
  host.hostStats(undefined, (result) => (got = Number(result.host.actors)), (error) => { throw error; });
  await host.idle();
  return got;
}

/** The milliseconds `body` takes. */
async function elapsed(body) {
  const t0 = performance.now();
  await body();
  return performance.now() - t0;
}

/** The answers to `count` calls of a typed method, made by `call(i, onResult, onError)`. */
function answering(count) {
  const answers = { results: [], errors: [] };
  answers.onResult = (result) => answers.results.push(result);
  answers.onError = (error) => answers.errors.push(error);
  answers.all = () => answers.results.length + answers.errors.length === count;
  return answers;
}

/** The sweep of every actor, timed: the sweep that finds each of them
 * idle. One sweep, untimed, first marks every actor that ran since the
 * last (core's CLOCK sweep), so each timed one scans every actor and
 * returns each that can be hibernated. A sample is sweeps until it takes
 * --min-ms: a sample of one sweep of 40,000 actors (a tenth of a
 * millisecond) was the timer's noise, and the fast pass failed in two
 * runs of six (docs/log.xml, l-p2-scale-rerun).
 *
 * A sweep reads each actor's slot, so it costs what the memory it reads
 * costs: sweep after sweep, 2,000,000 hibernated actors stay in this
 * machine's cache of 260 MB (3 ns an actor) and 4,000,000 do not (7 to 8
 * ns), and the gate failed by the cache, not by the work (docs/log.xml,
 * l-p2-scale-sweep-cache). So when the marking sweep takes COLD_MS or
 * more (a population whose slots are megabytes), each timed sweep starts
 * from memory: EVICT bytes of other data are written before it, untimed,
 * as a sweep between an application's other work does. Below COLD_MS both
 * sizes stay in the cache, and evicting before each of hundreds of short
 * sweeps would take minutes. The hibernated scenario times it; the
 * resident one times a sweep of a page. */
const COLD_MS = 2;
const EVICT = 768e6;

async function timeSweep(clock, host, total) {
  const all = total + 1024;
  const t0 = performance.now();
  host.sweep(all, all);
  let evict = performance.now() - t0 >= COLD_MS ? new Uint8Array(EVICT) : null;
  let round = 0;
  await clock.time('sweep (every actor)', 'per actor', async () => {
    if (evict) evict.fill(++round & 0xff);
    const t = await elapsed(() => host.sweep(all, all));
    return { ms: t, calls: total };
  });
  evict = null;
}

// ---- the hibernated scenario ----------------------------------------------

async function hibernated(o, results, failures) {
  const draw = random(o.seed);
  const clock = new Clock(o, results);
  const N = o.actors;
  const I = Math.max(64, Math.floor(N / 100)); // invokers, each with a running service
  const Q = Math.max(64, Math.floor(N / 100)); // hibernated actors woken with an event waiting
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tinyactors-scale-'));
  const store = await Store.open(path.join(directory, 'actors.db'));

  // the counters are indexes 0..N-1; their sessions are numbered from `base`
  const HIBERNATED = 0;
  const RESIDENT_ = 1;
  const GONE = 2;
  const DYING = 3; // terminated while hibernated: ends when woken
  const state = new Uint8Array(N);
  const sessions = new BigUint64Array(N);
  const resident = new IndexSet(N);
  let base = 0n;
  const index = (session) => {
    const i = Number(session - base);
    return i >= 0 && i < N && sessions[i] === session ? i : -1;
  };
  // the host's store: a WAKE loads the blob (the host wakes the actor and
  // deletes the blob); what the gate keeps of each actor follows
  const tracked = {
    save: (session, blob) => store.save(session, blob),
    load: (session) => {
      const i = index(session);
      const blob = store.load(session);
      if (i >= 0 && state[i] === DYING) state[i] = GONE;
      else if (i >= 0) {
        state[i] = RESIDENT_;
        resident.add(i);
      }
      return blob;
    },
    delete: (session) => store.delete(session),
  };
  const putBack = (list) => { // hibernate again, into the store
    for (const i of list) {
      if (state[i] !== RESIDENT_) continue;
      try {
        store.save(sessions[i], host.hibernate(sessions[i]));
      } catch (error) {
        if (!(error instanceof TinyactorsError) || error.status !== 'TA_ERROR_STATE') throw error;
        continue;
      }
      state[i] = HIBERNATED;
      resident.delete(i);
    }
  };
  const pickHibernated = (k) => {
    const chosen = new Set();
    while (chosen.size < k) {
      const i = Math.floor(draw() * N);
      if (state[i] === HIBERNATED) chosen.add(i);
    }
    return [...chosen];
  };

  // services: one per invoker, answering each ping with a pong
  const services = { started: 0, pings: 0 };
  const startService = (invocation) => {
    services.started++;
    return {
      receive(send) {
        services.pings++;
        invocation.sendBack('pong');
      },
    };
  };
  const ioProcessed = { count: 0 };
  const migrationsDone = { count: 0, failed: 0 };

  const room = RESIDENT + 2 * I + Q + 16 * BATCH;
  const events = 16384 + Q + (o.datamodel === 'quickjs' ? room : 0);
  const config = {
    telemetry: {}, // metrics(), and trace.end with something to end
    system: {
      maxActors: N + room, maxEvents: events, maxRequests: I + 4096, maxTimers: 4096,
      instanceBytes: 256 * room, stringBytes: 16384 + 64 * room, tracing: false,
    },
  };
  // the other system of the transport round trip
  let host;
  let returned = 0;
  const other = new Host([], { system: 'other', 
    ...engine(o.datamodel),
    transport: (send) => {
      host.send(send.message);
      returned++;
    },
  });
  {
    const compiled = compileCharts([{ name: 'echo.scxml', text: ECHO }]);
    other.addImage(compiled.image);
    compiled.close();
  }
  const echo = Address.fromSession('other', other.spawn(other.chart('echo')).id).text;
  await other.idle();

  const simulated = new SimulatedClock();
  const handlers = {
    ...engine(o.datamodel),
    clock: simulated,
    telemetry: () => {}, // exported nowhere
    store: tracked,
    services: { 'urn:scale:service': startService },
    ioProcessors: { 'urn:scale:echo': { receive: (send) => { ioProcessed.count++; send.answer('answer'); } } },
    transport: (send) => other.send(send.message),
    migrationDone: (result) => { migrationsDone.count++; migrationsDone.failed += result.failed.length; },
  };
  host = new Host([], { system: 'scale', config, ...handlers });
  const compiled = compileSystem({ name: 'system.xml', text: SYSTEM }, { resolver: (b, source) => FILES[source] });
  const segment = host.addImage(compiled.image);
  compiled.close();
  const counter = host.chart('counter');

  // populate: N counters, RESIDENT at most in memory, the rest in the store
  console.log(`hibernated: ${N} actors, ${RESIDENT} resident, ${I} invokers, the rest in SQLite`);
  let ms = await elapsed(async () => {
    let oldest = 0;
    for (let i = 0; i < N; i++) {
      sessions[i] = host.spawn(counter).id;
      state[i] = RESIDENT_;
      if (i - oldest + 1 >= RESIDENT + BATCH) {
        await host.idle();
        for (const end = oldest + BATCH; oldest < end; oldest++) {
          store.save(sessions[oldest], host.hibernate(sessions[oldest]));
          state[oldest] = HIBERNATED;
        }
      }
    }
    await host.idle();
    for (let i = oldest; i < N; i++) resident.add(i);
    store.flush();
  });
  base = sessions[0];
  if (N > 1 && sessions[N - 1] !== base + BigInt(N - 1)) failures.push('the counters\' sessions are not consecutive');
  clock.record('populate (spawn and hibernate)', 'per actor', [(ms * 1000) / N], N);

  // the invokers, each running a service; a named actor at the end of the table
  const invokers = [];
  for (let i = 0; i < I; i++) {
    invokers.push(host.spawn(host.chart('invoker')));
    if (i % BATCH === BATCH - 1) await host.idle();
  }
  const probe = host.spawn(counter, { name: 'probe' });
  await host.idle();
  if (services.started !== I) failures.push(`${services.started} services started for ${I} invokers`);
  let total = N + I + 1; // the actors the host holds, counted again before the whole-population operations

  // one actor each: spawn, send, terminate, wake, hibernate
  await clock.time('spawn', 'per call', async () => {
    const spawned = [];
    const t = await elapsed(async () => {
      for (let k = 0; k < 64; k++) spawned.push(host.spawn(counter));
      await host.idle();
    });
    for (const s of spawned) host.terminate(s);
    await host.idle();
    return { ms: t, calls: 64 };
  });
  await clock.time('terminate', 'per call', async () => {
    const spawned = [];
    for (let k = 0; k < 64; k++) spawned.push(host.spawn(counter));
    await host.idle();
    const t = await elapsed(async () => {
      for (const s of spawned) host.terminate(s);
      await host.idle();
    });
    return { ms: t, calls: 64 };
  });
  await clock.time('send', 'per call', async () => {
    const targets = resident.pick(64, draw).map((i) => sessions[i]);
    const t = await elapsed(async () => {
      for (const s of targets) host.send(s, 'inc');
      await host.idle();
    });
    return { ms: t, calls: targets.length };
  });
  await clock.time('sendMany', 'per event', async () => {
    const items = [];
    for (let k = 0; k < BATCH; k++) items.push({ target: sessions[resident.items[Math.floor(draw() * resident.size)]], event: 'inc' });
    const t = await elapsed(async () => {
      if (host.sendMany(items) !== items.length) failures.push('sendMany refused events');
      await host.idle();
    });
    return { ms: t, calls: items.length };
  });
  await clock.time('send (hibernated: woken from the store)', 'per call', async () => {
    const chosen = pickHibernated(32);
    const t = await elapsed(async () => {
      for (const i of chosen) host.send(sessions[i], 'inc');
      await host.idle();
    });
    if (chosen.some((i) => state[i] !== RESIDENT_)) failures.push('an event did not wake its actor');
    putBack(chosen);
    return { ms: t, calls: chosen.length };
  });
  await clock.time('hibernate', 'per call', async () => {
    const chosen = resident.pick(32, draw);
    const blobs = [];
    const t = await elapsed(() => {
      for (const i of chosen) blobs.push(host.hibernate(sessions[i]));
    });
    chosen.forEach((i, k) => host.wake(sessions[i], blobs[k]));
    await host.idle();
    return { ms: t, calls: chosen.length };
  });
  await clock.time('wake', 'per call', async () => {
    const chosen = pickHibernated(32);
    const blobs = chosen.map((i) => store.load(sessions[i]));
    const t = await elapsed(async () => {
      chosen.forEach((i, k) => host.wake(sessions[i], blobs[k]));
      await host.idle();
    });
    for (const i of chosen) {
      state[i] = RESIDENT_;
      resident.add(i);
    }
    putBack(chosen);
    return { ms: t, calls: chosen.length };
  });
  // Q hibernated actors get an event each, so each waits in core's queue of
  // wakes; the last 128 sent are woken (or terminated) by the application
  // before core asks for them
  const queued = async (act) => {
    const chosen = pickHibernated(Q);
    for (let first = 0; first < chosen.length; first += BATCH)
      host.sendMany(chosen.slice(first, first + BATCH).map((i) => ({ target: sessions[i], event: 'inc' })));
    const last = chosen.slice(-Math.min(128, chosen.length >> 1));
    const blobs = last.map((i) => store.load(sessions[i]));
    const t = await elapsed(() => act(last, blobs));
    await host.idle(); // the rest: asked for, woken from the store
    putBack(chosen);
    return { ms: t, calls: last.length };
  };
  await clock.time('wake (an event waiting)', 'per call', () => queued((last, blobs) => {
    last.forEach((i, k) => {
      host.wake(sessions[i], blobs[k]);
      state[i] = RESIDENT_;
      resident.add(i);
    });
  }), { batches: 1 });
  await clock.time('terminate (hibernated, an event waiting)', 'per call', () => queued((last) => {
    for (const i of last) {
      host.terminate(sessions[i]);
      state[i] = DYING;
    }
  }), { batches: 8 }); // its calls are short: a few rounds make a sample
  await clock.time('terminate (hibernated)', 'per call', async () => {
    const chosen = pickHibernated(64);
    const t = await elapsed(async () => {
      for (const i of chosen) {
        state[i] = DYING; // its WAKE comes in this turn: woken, it ends
        host.terminate(sessions[i]);
      }
      await host.idle();
    });
    if (chosen.some((i) => state[i] !== GONE)) failures.push('a terminated hibernated actor was not asked for');
    return { ms: t, calls: chosen.length };
  }, { batches: 4 }); // each batch ends 64 actors
  await clock.time('actor (by name)', 'per call', async () => {
    let found;
    let missing;
    const t = await elapsed(() => {
      found = host.actor('probe');
      try {
        missing = host.actor('nobody');
      } catch (error) {
        if (!(error instanceof StaleError)) throw error;
      }
    });
    if (!found.equals(probe) || missing !== undefined) failures.push(`actor by name: ${found}, ${missing}`);
    return { ms: t, calls: 2 };
  });
  await clock.time('boot', 'per call', async () => {
    const t = await elapsed(async () => {
      for (let k = 0; k < 16; k++) host.boot(segment);
      await host.idle();
    });
    return { ms: t, calls: 16 };
  });

  // the typed methods, each answered at the turn after the call
  const method = (name, params, count = 64) => async () => {
    const answers = answering(count);
    const list = Array.from({ length: count }, () => params());
    const t = await elapsed(async () => {
      for (const p of list) host[name](p, answers.onResult, answers.onError);
      await host.idle();
    });
    if (!answers.all()) failures.push(`${name}: ${answers.results.length + answers.errors.length} answers of ${count}`);
    return { ms: t, calls: count, answers };
  };
  const someone = () => ({ session: sessions[resident.items[Math.floor(draw() * resident.size)]] });
  await clock.time('actorState', 'per call', method('actorState', someone));
  await clock.time('actorContext', 'per call', method('actorContext', someone));
  await clock.time('actorGet', 'per call', method('actorGet', someone));
  await clock.time('hostStats', 'per call', method('hostStats', () => undefined));
  await clock.time('hostConfig', 'per call', method('hostConfig', () => ({})));
  await clock.time('actorList (a page)', 'per call', method('actorList', () => ({ limit: 256 }), 16));
  await clock.time('traceConfigure', 'per call', method('traceConfigure', () => ({ detail: 'summary' })));
  await clock.time('traceWatch', 'per call', async () => {
    const got = await method('traceWatch', () => ({ rules: [{ chart: 'counter' }], seconds: 60 }))();
    for (const result of got.answers.results) host.traceUnwatch({ id: result.id }, () => {}, () => {});
    await host.idle();
    return got;
  });
  await clock.time('traceUnwatch', 'per call', async () => {
    const watches = answering(64);
    for (let k = 0; k < 64; k++) host.traceWatch({ rules: [{ chart: 'counter' }], seconds: 60 }, watches.onResult, watches.onError);
    await host.idle();
    const ids = watches.results.map((result) => result.id);
    while (ids.length < 64) ids.push(99); // tracing refused the watch: an unknown id, answered stale
    return method('traceUnwatch', () => ({ id: ids.pop() }))();
  });
  await clock.time('traceEnd', 'per call', method('traceEnd', () => undefined));
  await clock.time('traceSpansDecode', 'per call', method('traceSpansDecode', () => ({ traces: new Uint8Array() })));
  await clock.time('metrics', 'per call', async () => {
    const t = await elapsed(() => {
      for (let k = 0; k < 64; k++) host.metrics();
    });
    return { ms: t, calls: 64 };
  });

  // round trips
  await clock.time('I/O processor round trip', 'per call', async () => {
    const targets = resident.pick(64, draw).map((i) => sessions[i]);
    const before = ioProcessed.count;
    const t = await elapsed(async () => {
      for (const s of targets) host.send(s, 'ask');
      await host.idle();
    });
    if (ioProcessed.count - before !== targets.length) failures.push(`I/O processor: ${ioProcessed.count - before} of ${targets.length}`);
    return { ms: t, calls: targets.length };
  });
  await clock.time('transport round trip', 'per call', async () => {
    const targets = resident.pick(32, draw).map((i) => sessions[i]);
    const before = returned;
    const t = await elapsed(async () => {
      for (const s of targets) host.send(s, 'call', { to: echo });
      for (let turns = 0; returned - before < targets.length && turns < 1000; turns++) {
        await host.idle();
        await other.idle();
      }
      await host.idle();
    });
    if (returned - before !== targets.length) failures.push(`transport: ${returned - before} pongs of ${targets.length}`);
    return { ms: t, calls: targets.length };
  });
  await clock.time('delayed send and its timer', 'per call', async () => {
    const targets = resident.pick(64, draw).map((i) => sessions[i]);
    const t = await elapsed(async () => {
      for (const s of targets) host.send(s, 'arm');
      await host.idle();
      simulated.increment(20);
      await host.idle();
    });
    if (host.nextDeadline !== undefined) failures.push('a delayed send did not fire');
    return { ms: t, calls: targets.length };
  });
  await clock.time('invoked service round trip', 'per call', async () => {
    const targets = [];
    for (let k = 0; k < 64; k++) targets.push(invokers[Math.floor(draw() * invokers.length)]);
    const before = services.pings;
    const t = await elapsed(async () => {
      for (const s of targets) host.send(s, 'go');
      await host.idle();
    });
    if (services.pings - before !== targets.length) failures.push(`service: ${services.pings - before} pings of ${targets.length}`);
    return { ms: t, calls: targets.length };
  });

  // the whole population: a full listing, a sweep of every actor
  total = await actorsOf(host);
  await clock.time('actorList (every actor)', 'per actor', async () => {
    let listed = 0;
    const t = await elapsed(async () => {
      let cursor = 0;
      while (cursor !== null) {
        let page;
        host.actorList({ limit: 512, cursor }, (result) => (page = result), (error) => { throw error; });
        await host.idle();
        listed += page.sessions.length;
        cursor = page.cursor;
      }
    });
    if (listed !== total) failures.push(`actorList: ${listed} sessions of ${total}`);
    return { ms: t, calls: listed };
  }, { batches: 1, samples: Math.min(3, o.samples) });
  await timeSweep(clock, host, total);

  // migration of one session at a time, to version 2
  {
    const v2 = compileCharts([{ name: 'counter.scxml', text: COUNTER(2) }]);
    host.addImage(v2.image);
    v2.close();
  }
  const moved = new Uint8Array(N);
  await clock.time('migrate (one session)', 'per call', async () => {
    const chosen = resident.pick(resident.size, draw).filter((i) => !moved[i]).slice(0, 16);
    const before = migrationsDone.count;
    const t = await elapsed(async () => {
      for (const i of chosen) host.migrate({ session: sessions[i] });
      for (let turns = 0; migrationsDone.count - before < chosen.length && turns < 1000; turns++) await host.idle();
    });
    if (migrationsDone.count - before !== chosen.length) failures.push(`migrate: ${migrationsDone.count - before} done of ${chosen.length}`);
    for (const i of chosen) moved[i] = 1;
    return { ms: t, calls: chosen.length };
  }, { batches: 8 }); // each batch moves 16 of the resident actors for good
  if (migrationsDone.failed) failures.push(`${migrationsDone.failed} sessions failed to migrate`);

  // snapshot, restore, close: per actor
  total = await actorsOf(host);
  store.flush();
  await snapshots(host, config, { ...handlers, store: undefined, services: { 'urn:scale:service': () => ({}) } }, clock, total, o);
  other.close();
  rmSync(directory, { recursive: true, force: true });
}

/** The end of a scenario: snapshot (per actor), then restore with its
 * first turn (per actor) and the restored host's close (per actor), again
 * and again. The host is closed before the first restore, so that at most
 * one population is in memory at a time. With `then`, the last restored
 * host is handed to it before its close is timed.
 *
 * A snapshot's cost is its time less the system time of the process
 * during it: the kernel's, faulting in the pages of the Buffer core
 * writes into (and of the room the datamodel's state is written in). The
 * faults per actor are the same at both sizes, but each costs what the
 * runtime and the machine make it: on bun a Buffer made after one was
 * collected reuses its pages some of the time, so one sample of three
 * paid no faults (docs/log.xml, l-p2-scale-snapshot-pages); and on this
 * virtual machine a fault costs two to five times as much in a process
 * that holds 6 GB as in one that holds 3 GB (l-p2-scale-snapshot-faults).
 * A sample is snapshots until it takes --min-ms, as a sweep's is: the
 * system time is charged in steps of about 4 ms (the kernel's tick), and
 * the fast pass's snapshot of a hibernated population takes 4 to 15 ms,
 * so one call less its own system time was anywhere from 0.06 to 0.41 us
 * an actor (docs/log.xml, l-p2-w3c-snapshot-samples); over a sample of
 * many calls the steps average out. Under --full (--min-ms 200) a sample
 * is one snapshot of an all-resident population and two of a hibernated
 * one at two million actors (90 to 124 ms each), one or two at four
 * million (180 to 216 ms). */
async function snapshots(host, config, handlers, clock, total, o, then) {
  const closes = [];
  let blob;
  await clock.time('snapshot', 'per actor', async () => {
    const before = process.resourceUsage().systemCPUTime;
    const t = await elapsed(() => {
      blob = host.snapshot();
    });
    const kernel = (process.resourceUsage().systemCPUTime - before) / 1000; // microseconds to milliseconds
    return { ms: Math.max(t - kernel, 0), calls: total };
  }, { samples: Math.min(3, o.samples) });
  host.close(); // a host after every operation: the restored ones' closes are timed, each a population as large
  const samples = Math.min(3, o.samples);
  let round = 0;
  await clock.time('restore (and its first turn)', 'per actor', async () => {
    let restored;
    const t = await elapsed(async () => {
      restored = Host.restore(blob, [], { system: 'scale', config, ...handlers, clock: new SimulatedClock() });
      await restored.idle();
    });
    if (++round === samples && then) {
      blob = undefined;
      await then(restored);
    }
    closes.push((await elapsed(() => restored.close())) * 1000 / total);
    return { ms: t, calls: total };
  }, { batches: 1, samples });
  blob = undefined;
  clock.record('close', 'per actor', closes, closes.length * total);
}

// ---- the resident scenario ------------------------------------------------

async function residentScenario(o, results, failures) {
  const draw = random(o.seed);
  const clock = new Clock(o, results);
  const N = o.actors;
  const migrationsDone = { count: 0, failed: 0, migrated: 0 };
  const handlers = {
    ...engine(o.datamodel),
    clock: new SimulatedClock(),
    migrationDone: (result) => { migrationsDone.count++; migrationsDone.failed += result.failed.length; migrationsDone.migrated += result.migrated; },
  };
  // no pools sized: the segment grows from core's defaults as the actors come
  const config = { system: { tracing: false } };
  const host = new Host([], { system: 'scale', config, ...handlers });
  const compiled = compileSystem({ name: 'system.xml', text: SYSTEM }, { resolver: (b, source) => FILES[source] });
  host.addImage(compiled.image);
  compiled.close();
  const counter = host.chart('counter');
  const sessions = new BigUint64Array(N);
  const live = new IndexSet(N);

  console.log(`resident: ${N} actors, all in memory`);
  const ms = await elapsed(async () => {
    for (let i = 0; i < N; i++) {
      sessions[i] = host.spawn(counter).id;
      live.add(i);
      if (i % 4096 === 4095) await host.idle();
    }
    await host.idle();
  });
  clock.record('populate (spawn, the segment growing)', 'per actor', [(ms * 1000) / N], N);
  const probe = host.spawn(counter, { name: 'probe' });
  await host.idle();
  let total = N + 1;

  await clock.time('spawn', 'per call', async () => {
    const spawned = [];
    const t = await elapsed(async () => {
      for (let k = 0; k < 64; k++) spawned.push(host.spawn(counter));
      await host.idle();
    });
    for (const s of spawned) host.terminate(s);
    await host.idle();
    return { ms: t, calls: 64 };
  });
  await clock.time('send', 'per call', async () => {
    const targets = live.pick(64, draw).map((i) => sessions[i]);
    const t = await elapsed(async () => {
      for (const s of targets) host.send(s, 'inc');
      await host.idle();
    });
    return { ms: t, calls: targets.length };
  });
  await clock.time('sendMany', 'per event', async () => {
    const items = [];
    for (let k = 0; k < BATCH; k++) items.push({ target: sessions[live.items[Math.floor(draw() * live.size)]], event: 'inc' });
    const t = await elapsed(async () => {
      if (host.sendMany(items) !== items.length) failures.push('sendMany refused events');
      await host.idle();
    });
    return { ms: t, calls: items.length };
  });
  await clock.time('terminate', 'per call', async () => {
    const chosen = live.pick(64, draw);
    const t = await elapsed(async () => {
      for (const i of chosen) host.terminate(sessions[i]);
      await host.idle();
    });
    for (const i of chosen) sessions[i] = host.spawn(counter).id; // the population stays as large
    await host.idle();
    return { ms: t, calls: chosen.length };
  });
  // N/10 actors runnable, each with an event waiting; the last 256 of them
  // terminated before the run
  await clock.time('terminate (runnable)', 'per call', async () => {
    const Q = Math.max(512, Math.floor(N / 10));
    const chosen = live.pick(Q, draw);
    for (let first = 0; first < chosen.length; first += BATCH) {
      const items = chosen.slice(first, first + BATCH).map((i) => ({ target: sessions[i], event: 'inc' }));
      for (let sent = 0; sent < items.length;) sent += host.sendMany(items.slice(sent)) || (await host.idle(), 0);
    }
    const last = chosen.slice(-256);
    const t = await elapsed(() => {
      for (const i of last) host.terminate(sessions[i]);
    });
    await host.idle();
    for (const i of last) live.delete(i);
    total -= last.length;
    return { ms: t, calls: last.length };
  }, { batches: 1 });
  await clock.time('actor (by name)', 'per call', async () => {
    let found;
    let missing;
    const t = await elapsed(() => {
      found = host.actor('probe');
      try {
        missing = host.actor('nobody');
      } catch (error) {
        if (!(error instanceof StaleError)) throw error;
      }
    });
    if (!found.equals(probe) || missing !== undefined) failures.push(`actor by name: ${found}, ${missing}`);
    return { ms: t, calls: 2 };
  });
  await clock.time('hostStats', 'per call', async () => {
    const answers = answering(64);
    const t = await elapsed(async () => {
      for (let k = 0; k < 64; k++) host.hostStats(undefined, answers.onResult, answers.onError);
      await host.idle();
    });
    return { ms: t, calls: 64 };
  });
  await clock.time('actorList (every actor)', 'per actor', async () => {
    let listed = 0;
    const t = await elapsed(async () => {
      let cursor = 0;
      while (cursor !== null) {
        let page;
        host.actorList({ limit: 512, cursor }, (result) => (page = result), (error) => { throw error; });
        await host.idle();
        listed += page.sessions.length;
        cursor = page.cursor;
      }
    });
    if (listed !== total) failures.push(`actorList: ${listed} sessions of ${total}`);
    return { ms: t, calls: listed };
  }, { batches: 1, samples: Math.min(3, o.samples) });
  // Every resident actor is idle, so after the first sweep each sweep
  // finds all it scans: one that returns every actor makes a bigint for
  // each, and its cost at 2,000,000 was the engine's collector (0.22 then
  // 0.35 µs an actor on node with quickjs; docs/log.xml,
  // l-p2-scale-sweep-cache). An application sweeps a page at a time, from
  // where the last sweep stopped (core's cursor): that is timed per call,
  // and the scan of every actor in the hibernated scenario.
  host.sweep(total + 1024, total + 1024); // marks every actor that ran
  await clock.time(`sweep (a page of ${BATCH})`, 'per call', async () => {
    let found = 0;
    const t = await elapsed(() => {
      for (let k = 0; k < 16; k++) found += host.sweep(total + 1024, BATCH).length;
    });
    if (found !== 16 * BATCH) failures.push(`sweep: ${found} sessions in 16 pages of ${BATCH}`);
    return { ms: t, calls: 16 };
  });
  await clock.time('hibernate', 'per call', async () => {
    const chosen = live.pick(32, draw);
    const blobs = [];
    const t = await elapsed(() => {
      for (const i of chosen) blobs.push(host.hibernate(sessions[i]));
    });
    chosen.forEach((i, k) => host.wake(sessions[i], blobs[k]));
    await host.idle();
    return { ms: t, calls: chosen.length };
  });
  await clock.time('wake', 'per call', async () => {
    const chosen = live.pick(32, draw);
    const blobs = chosen.map((i) => host.hibernate(sessions[i]));
    const t = await elapsed(async () => {
      chosen.forEach((i, k) => host.wake(sessions[i], blobs[k]));
      await host.idle();
    });
    return { ms: t, calls: chosen.length };
  });


  // snapshot and restore, then every actor of the last restored host moved
  // to version 2 (per actor): one population in memory at a time
  await snapshots(host, config, handlers, clock, total, o, async (restored) => {
    const v2 = compileCharts([{ name: 'counter.scxml', text: COUNTER(2) }]);
    restored.addImage(v2.image);
    v2.close();
    const moving = await elapsed(async () => {
      restored.migrate({ chart: 'counter' });
      for (let turns = 0; migrationsDone.count === 0 && turns < 1e6; turns++) await restored.idle();
    });
    if (migrationsDone.failed || migrationsDone.migrated !== total)
      failures.push(`migrate: ${migrationsDone.migrated} of ${total} moved, ${migrationsDone.failed} failed`);
    clock.record('migrate (a chart, every actor)', 'per actor', [(moving * 1000) / total], total);
  });
}

// ---- one process: one scenario at one size ----------------------------------

async function child(o) {
  const results = {};
  const failures = [];
  if (o.child === 'hibernated') await hibernated(o, results, failures);
  else await residentScenario(o, results, failures);
  const peak = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(`RESULT ${JSON.stringify({ results, failures, peak })}\n`);
}

/** Runs one scenario at one size in a process of its own; its result. */
function measure(scenario, actors, o) {
  const args = [...(globalThis.Bun ? [] : ['--disable-warning=ExperimentalWarning']), fileURLToPath(import.meta.url),
    '--child', scenario, '--actors', String(actors), '--datamodel', o.datamodel, '--samples', String(o.samples),
    '--min-ms', String(o['min-ms']), '--seed', String(o.seed)];
  return new Promise((resolve, reject) => {
    const process_ = spawnChild(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffered = '';
    let result;
    process_.stdout.setEncoding('utf8');
    process_.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
        else if (o.verbose) console.log(`  [${scenario} ${actors}] ${line.trim()}`);
      }
    });
    process_.on('error', reject);
    process_.on('close', (code, signal) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`scale: ${scenario} at ${actors} actors exited with ${signal ?? code}`));
    });
  });
}

export function signature() {
  const cpus = os.cpus();
  const runtime = globalThis.Bun ? `bun ${globalThis.Bun.version}` : `node ${process.versions.node}`;
  return `${cpus[0]?.model ?? 'unknown'}, ${cpus.length} CPUs, ${os.arch()}, ${os.type()} ${os.release()}, ` +
    `${Math.round(os.totalmem() / 2 ** 30)} GiB; ${runtime}`;
}

/** The gate: every operation of each scenario at `actors` and twice that;
 * {scenarios: {name: {small, large, ratios}}, failures, known}. */
export async function gate(given = {}) {
  const o = { ...options([]), attempts: 3, ...given };
  const scenarios = o.scenario === 'all' ? ['hibernated', 'resident'] : [o.scenario];
  const report = { machine: signature(), datamodel: o.datamodel, actors: o.actors, factor: FACTOR, scenarios: {}, failures: [], known: [] };
  for (const scenario of scenarios) {
    const sizes = scenario === 'resident' && o['resident-actors'] ? o['resident-actors'] : o.actors;
    let best;
    for (let attempt = 1; attempt <= o.attempts; attempt++) {
      // each attempt another seed: the same seed is the same run, whose
      // collections fall in the same operation each time; a scan repeats
      // whatever the seed (docs/log.xml, l-p2-scale-fast-noise)
      const run = { ...o, seed: o.seed + attempt - 1 };
      const small = await measure(scenario, sizes, run);
      const large = await measure(scenario, 2 * sizes, run);
      for (const failure of [...small.failures, ...large.failures]) report.failures.push(`${scenario}: ${failure}`);
      // each size keeps each operation's lowest cost of every attempt: noise
      // only ever adds time, so a slow process does not fail the gate
      if (!best) best = { small, large, ratios: {}, paired: {}, attempts: attempt };
      else {
        best.attempts = attempt;
        best.small.peak = Math.max(best.small.peak, small.peak);
        best.large.peak = Math.max(best.large.peak, large.peak);
        for (const [at, now] of [[best.small, small], [best.large, large]])
          for (const [name, result] of Object.entries(now.results))
            if (!at.results[name] || result.cost < at.results[name].cost) at.results[name] = result;
      }
      // and each attempt's own ratio, of the two processes measured one
      // after the other: a slow minute of the machine slows both, while the
      // least costs may pair a calm minute's small size with a slow
      // minute's large one (a full run once found every process of the
      // larger size slower in three operations for eight attempts in a row,
      // 1.67 times the least small cost: docs/log.xml,
      // l-p2-allocation-scale-slow-minutes). From the third attempt an
      // operation is over only when the median of its attempts' ratios is
      // over too: a scan is over in every attempt, noise in a few.
      for (const [name, at] of Object.entries(small.results))
        if (large.results[name]) (best.paired[name] ??= []).push(large.results[name].cost / at.cost);
      for (const [name, at] of Object.entries(best.small.results)) {
        if (!best.large.results[name]) continue;
        const pairs = best.paired[name] ?? [];
        best.ratios[name] = Math.min(best.large.results[name].cost / at.cost, pairs.length >= 3 ? median(pairs) : Infinity);
      }
      const over = Object.entries(best.ratios).filter(([name, ratio]) => ratio > FACTOR && !KNOWN[name]);
      if (!over.length) break;
      if (attempt < o.attempts) console.log(`scale: ${scenario}: ${over.map(([n, r]) => `${n} ${r.toFixed(2)}`).join(', ')} over ${FACTOR}: measuring again`);
    }
    report.scenarios[scenario] = { actors: sizes, ...best };
    print(scenario, sizes, best, o);
    for (const [name, ratio] of Object.entries(best.ratios)) {
      if (ratio <= FACTOR) continue;
      if (KNOWN[name]) report.known.push(`${scenario}: ${name} ${ratio.toFixed(2)} (${KNOWN[name]})`);
      else report.failures.push(`${scenario}: ${name}: ${ratio.toFixed(2)} times the cost at twice the actors`);
    }
  }
  return report;
}

function print(scenario, actors, best, o) {
  const us = (value) => (value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(3));
  console.log(`scale: ${scenario}, ${o.datamodel}, ${actors} and ${2 * actors} actors (${best.attempts} attempts); ${signature()}`);
  console.log(`  ${'operation'.padEnd(44)}${'unit'.padEnd(11)}${`at ${actors}`.padStart(14)}${`at ${2 * actors}`.padStart(14)}${'ratio'.padStart(8)}`);
  for (const [name, ratio] of Object.entries(best.ratios)) {
    const verdict = ratio <= FACTOR ? 'ok' : KNOWN[name] ? `FAIL (known: ${KNOWN[name]})` : 'FAIL';
    const { unit } = best.small.results[name];
    console.log(`  ${name.padEnd(44)}${unit.padEnd(11)}${`${us(best.small.results[name].cost)} µs`.padStart(14)}` +
      `${`${us(best.large.results[name].cost)} µs`.padStart(14)}${ratio.toFixed(2).padStart(8)}  ${verdict}`);
  }
  console.log(`  peak resident: ${Math.round(best.small.peak / 1e6)} MB at ${actors}, ${Math.round(best.large.peak / 1e6)} MB at ${2 * actors}`);
}

async function main() {
  const o = options(process.argv.slice(2));
  if (o.child) {
    await child(o);
    return;
  }
  const report = await gate({ ...o, verbose: true });
  if (o.json) writeFileSync(o.json, `${JSON.stringify(report, null, 2)}\n`);
  for (const known of report.known) console.log(`KNOWN ${known}`);
  for (const failure of report.failures) console.log(`FAIL ${failure}`);
  process.exitCode = report.failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
