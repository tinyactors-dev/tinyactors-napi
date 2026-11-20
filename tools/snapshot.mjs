// Snapshots under load: a deploy rehearsed on a copy of a live host, most
// of whose actors sleep in SQLite and some of whose payments are in flight
// (docs/plan.xml, p2-snapshot and p2-services; translated from
// tinyactors-cpython/tools/snapshot.py).
//
//     node tools/snapshot.mjs [--actors N] [--resident R] [--events E] [--datamodel native|quickjs]
//                             [--sample S] [--seed K]
//
// The application's side of snapshots (README, "Snapshots"), as a program
// would write it to try a new chart version on a copy of production before
// deploying it:
//
// 1. live: N order actors of version 1, at most R resident after a turn,
//    the rest hibernated into SQLite by the host (new Host(charts, {store,
//    resident: R}), tools/store.mjs's store); E events to actors drawn at
//    random; every resident actor gets a delayed send due in 10 s, and half
//    of them start paying: each invokes the payment service (<invoke
//    type="urn:example:payment">, its amount as a param), which the live
//    host runs and which has not answered yet;
// 2. snapshot: host.snapshot() of the live host, written to a file, and a
//    copy of its store (a copy writes blobs too: it must not write the live
//    one). The live host is not stopped;
// 3. restore: Host.restore makes the copy from the file, with its own
//    store, clock and handlers, and a stand-in payment service: a copy must
//    never reach the real one. A snapshot of the copy before it runs must
//    be the same bytes. At its first run the copy announces each payment
//    that was in flight; the stand-in gets each (invocation.restored, the
//    same amount) and declines it;
// 4. rehearse: the copy adds version 2 and migrates every actor to it
//    (host.migrate({wake: true}): the copy's host loads the hibernated ones
//    from the copy's store as room allows, as in tools/migration.mjs), with
//    E more events, then runs its clock past the delayed sends;
// 5. verify the copy: the migration migrated every actor, none failed; a
//    sample (all up to 25,000) reports its count (every event, before and
//    after the snapshot), its delayed send, its payment (declined for the
//    payers) and version 2; each payment in flight reached the stand-in
//    once, with its amount, and was cancelled after its decline (stop);
// 6. verify the live host: it goes on with E events of its own; its sample
//    reports version 1, its own counts, payments still in flight; the real
//    service was started once per payer and never stopped, and every blob
//    in the live store is the last one the live host wrote for its session
//    (the copy wrote into its own). After every turn, on both hosts, at
//    most R actors are resident (plus a batch while migrating).
//
// With R = N every actor stays resident, so the datamodel's own state is
// most of the snapshot. Exits with status 1 when a check fails. Prints the
// times, the sizes, the process's peak memory and the hosts' regions per
// actor.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';
import { BATCH, engine, random, Store } from './store.mjs';

// tinyactors-cpython/tools/charts/order-v1.ecmascript.scxml and -v2.
const PAYING = `
    <state id="open">
      <transition event="pay" target="paying" />
    </state>
    <state id="paying">
      <invoke id="payment" type="urn:example:payment" src="payment://live">
        <param name="amount" expr="n" />
      </invoke>
      <transition event="paid" target="open">
        <assign location="paid" expr="1" />
      </transition>
      <transition event="declined" target="open">
        <assign location="paid" expr="0" />
      </transition>
    </state>`;

const ORDER = (version) => `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="order" initial="open">
  <datamodel>
    <data id="n" expr="0" />
    <data id="last" expr="null" />
    <data id="late" expr="0" />
    <data id="paid" expr="-1" />${version === 2 ? '\n    <data id="version" expr="2" />' : ''}
  </datamodel>
  <state id="order" initial="open">${version === 2 ? `
    <transition event="error.platform.upgrade">
      <assign location="n" expr="_event.data.n" />
      <assign location="last" expr="_event.data.last" />
      <assign location="late" expr="_event.data.late" />
      <assign location="paid" expr="_event.data.paid" />
    </transition>` : ''}
    <transition event="inc">
      <assign location="n" expr="n + 1" />
      <assign location="last" expr="_event.data" />
    </transition>
    <transition event="wait">
      <send event="late" delay="10s" />
    </transition>
    <transition event="late">
      <assign location="late" expr="late + 1" />
    </transition>
    <transition event="report">
      <log label="report" expr="_sessionid + ' ' + n + ' ' + late + ' ' + paid + ' ' + ${version === 2 ? 'version' : '1'}" />
    </transition>${PAYING}
  </state>
</scxml>
`;

function options(argv) {
  const given = { actors: 2_000_000, resident: 1000, events: 200_000, sample: 25_000, datamodel: 'native', seed: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    if (!(name in given) || i + 1 >= argv.length) throw new Error(`unknown option ${argv[i]}`);
    given[name] = name === 'datamodel' ? argv[i + 1] : Number(argv[i + 1]);
  }
  if (!['native', 'quickjs'].includes(given.datamodel)) throw new Error('--datamodel is native or quickjs');
  return given;
}

function add(host, text) {
  const compiled = compileCharts([{ name: 'order.scxml', text }]);
  try {
    return host.addImage(compiled.image);
  } finally {
    compiled.close();
  }
}

// A blob's fingerprint, to tell the live host's last blob of a session from
// another's (FNV-1a, 32 bits; plus one, so 0 is none).
function fingerprint(blob) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < blob.length; i++) hash = Math.imul(hash ^ blob[i], 0x01000193) >>> 0;
  return (hash >>> 0) + 1;
}

const PAYMENT = 'urn:example:payment';

// A payment service: the live host's real one, which has not answered yet,
// or the copy's stand-in, which declines what it is given. Each invocation
// gets a payment object, the service the host keeps, whose stop() is its
// cancel (the payer left paying).
class Payments {
  constructor(decline) {
    this.decline = decline;
    this.started = new Map(); // session -> times started
    this.amounts = new Map();
    this.stopped = new Set();
    this.twice = 0; // stopped more than once
    this.restored = 0;
    this.start = (invocation) => {
      const session = invocation.session;
      this.started.set(session, (this.started.get(session) ?? 0) + 1);
      this.amounts.set(session, invocation.data.amount);
      if (invocation.restored) this.restored++;
      if (this.decline) invocation.sendBack('declined');
      return {
        stop: () => {
          if (this.stopped.has(session)) this.twice++;
          this.stopped.add(session);
        },
      };
    };
  }

  // Started exactly once for each of `payers`, and for no one else.
  onceFor(payers) {
    return this.started.size === payers.length && payers.every((s) => this.started.get(s) === 1);
  }
}

const index = (session) => Number(BigInt(session) & 0xffffffffn) - 1; // segment 0 numbers its sessions 1, 2, ...

// A host's store that remembers, per actor, the fingerprint of the last
// blob it saved (0 once deleted: the actor is resident).
class Written extends Store {
  static async open(file, written) {
    const store = await Store.open(file);
    Object.setPrototypeOf(store, Written.prototype);
    store.written = written;
    return store;
  }

  save(session, blob) {
    this.written[index(session)] = fingerprint(blob);
    super.save(session, blob);
  }

  delete(session) {
    this.written[index(session)] = 0;
    super.delete(session);
  }
}

// One host's actors: its store, the reports, the migration's moves.
class Population {
  constructor(name, store, o, failures) {
    Object.assign(this, { name, store, o, failures });
    this.moved = new Uint8Array(o.actors); // 1: migrated (the MIGRATED effect)
    this.reports = new Map();
    this.moves = 0;
    this.peak = 0;
    this.migrating = false;
    this.migrationDone = undefined;
    this.migrated = (entry) => {
      if (this.moved[index(entry.session)]) failures.push(`${name}: actor ${entry.session} moved twice`);
      this.moved[index(entry.session)] = 1;
      this.moves++;
    };
    this.log = (entry) => {
      const [session, ...numbers] = entry.text.split(' ');
      this.reports.set(BigInt(session), numbers.join(' '));
    };
  }

  // The sessions of `sessions` in memory: those without a blob in the store.
  resident(sessions) {
    return sessions.filter((session) => !this.store.written[index(session)]);
  }

  async checkResident(host, slack = 0) {
    const got = (await host.hostStats()).host;
    const live = Number(got.actors) - Number(got.hibernated);
    this.peak = Math.max(this.peak, live);
    if (live > this.o.resident + slack) this.failures.push(`${this.name}: ${live} actors resident, more than ${this.o.resident} + ${slack}`);
    return got;
  }
}

const seconds = (since) => ((performance.now() - since) / 1000).toFixed(2);

async function main() {
  const o = options(process.argv.slice(2));
  const draw = random(o.seed);
  const failures = [];
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tinyactors-snapshot-'));

  const room = Math.min(o.resident, o.actors) + 4 * BATCH;
  // sized as tools/stress.mjs's (instance 128 B and strings 16 B per resident actor, tracing off);
  // events: a delayed send per resident actor, and after the restore the stand-in's declines
  // (quickjs keeps each actor's last event too)
  const config = {
    system: {
      ticksPerSecond: 1000, maxActors: o.actors + 4 * BATCH, maxEvents: 4096 + 3 * room, maxTimers: room, maxRequests: room,
      instanceBytes: 128 * room, stringBytes: 16384 + 16 * room, tracing: false,
    },
  };
  const liveStore = await Written.open(path.join(directory, 'live.db'), new Uint32Array(o.actors));
  const live = new Population('live', liveStore, o, failures);
  const real = new Payments(false);
  const liveClock = new SimulatedClock();
  const v1 = compileCharts([{ name: 'order.scxml', text: ORDER(1) }]);
  const host = new Host(v1, {
    system: 'orders', config, ...engine(o.datamodel), log: live.log, clock: liveClock, services: { [PAYMENT]: real.start },
    store: liveStore, resident: o.resident,
  });
  v1.close();
  const sessions = [];
  const sent = new Uint32Array(o.actors); // events before the snapshot
  const sentLive = new Uint32Array(o.actors); // the live host's after it
  const sentCopy = new Uint32Array(o.actors); // the copy's after it

  const traffic = async (population, h, counts, total) => {
    for (let first = 0; first < total; first += BATCH) {
      const items = [];
      for (let k = 0; k < Math.min(BATCH, total - first); k++) {
        const i = Math.floor(draw() * o.actors);
        counts[i]++;
        items.push({ target: sessions[i], event: 'inc', data: { k: i } });
      }
      if (h.sendMany(items) !== items.length) failures.push(`${population.name}: sendMany refused events`);
      await h.idle();
      await population.checkResident(h, population.migrating ? BATCH : 0);
    }
  };

  // 1. live: populate, events, delayed sends, payments in flight
  let started = performance.now();
  for (let i = 0; i < o.actors; i++) {
    sessions.push(host.spawn('order').id);
    if (i % BATCH === BATCH - 1) await host.idle();
  }
  await host.idle();
  if (o.actors && sessions[o.actors - 1] !== sessions[0] + BigInt(o.actors - 1)) failures.push('the sessions are not numbered 1..N in segment 0: index() is wrong');
  await traffic(live, host, sent, o.events);
  const waiting = live.resident(sessions);
  const payers = waiting.filter((_, i) => i % 2 === 0);
  for (let first = 0; first < waiting.length; first += BATCH) {
    const slice = waiting.slice(first, first + BATCH);
    host.sendMany(slice.map((target) => ({ target, event: 'wait' })));
    host.sendMany(slice.filter((_, i) => i % 2 === 0).map((target) => ({ target, event: 'pay' })));
    await host.idle();
  }
  liveStore.flush();
  let stats = await live.checkResident(host);
  if (real.started.size !== payers.length) failures.push(`live: ${real.started.size} payments started for ${payers.length} payers`);
  const amounts = new Map(payers.map((s) => [s, sent[index(s)]]));
  console.log(`live: ${o.actors} actors and ${o.events} events in ${seconds(started)} s; ${waiting.length} resident ` +
    `with a delayed send, ${payers.length} of them paying; ${stats.hibernated} hibernated`);

  // 2. snapshot, to a file; a copy of the store; the live host goes on
  started = performance.now();
  let blob = host.snapshot();
  const taken = seconds(started);
  const file = path.join(directory, 'orders.snapshot');
  writeFileSync(file, blob);
  const size = blob.length;
  liveStore.copyTo(path.join(directory, 'copy.db'));
  const copyStore = await Written.open(path.join(directory, 'copy.db'), new Uint32Array(liveStore.written));
  console.log(`snapshot: ${(size / 1e6).toFixed(1)} MB in ${taken} s (${Math.round(size / o.actors)} B an actor); the store copied`);
  const digest = createHash('sha256').update(blob).digest('hex'); // one snapshot in memory at a time
  blob = undefined;

  // 3. restore the copy, with a stand-in; its snapshot before it runs is the same bytes
  blob = readFileSync(file);
  const copy = new Population('copy', copyStore, o, failures);
  const standIn = new Payments(true);
  const copyClock = new SimulatedClock(); // a clock of its own: the copy's time is not the live host's
  started = performance.now();
  const rehearsal = Host.restore(blob, [], {
    system: 'orders', config, ...engine(o.datamodel), log: copy.log, migrated: copy.migrated, clock: copyClock,
    services: { [PAYMENT]: standIn.start }, migrationDone: (result) => { copy.migrationDone = result; },
    store: copyStore, resident: o.resident,
  });
  const restored = seconds(started);
  blob = undefined;
  if (createHash('sha256').update(rehearsal.snapshot()).digest('hex') !== digest)
    failures.push("the copy's snapshot differs from the one it was restored from");
  await rehearsal.idle(); // the payments in flight, announced again: the stand-in declines them
  if (!standIn.onceFor(payers) || standIn.restored !== payers.length)
    failures.push(`copy: the stand-in started ${standIn.started.size} payments (${standIn.restored} restored) for ${payers.length} payers`);
  if (payers.some((s) => standIn.amounts.get(s) !== amounts.get(s))) failures.push('copy: a restored payment lost its amount');
  console.log(`restore: in ${restored} s; the copy's snapshot compared; ${standIn.restored} payments in flight started again ` +
    'on the stand-in');

  // 4. rehearse the deploy: version 2, migrate everyone with events meanwhile, the clock past the sends
  started = performance.now();
  add(rehearsal, ORDER(2));
  copy.migrating = true;
  const migration = rehearsal.migrate({ wake: true });
  const gets = copyStore.gets;
  let copyEvents = 0, stalled = 0, before = -1;
  while (copy.migrationDone === undefined) {
    stalled = copy.moves === before ? stalled + 1 : 0;
    before = copy.moves;
    if (stalled > 100) {
      failures.push(`copy: the migration stalled with ${before} actors moved`);
      break;
    }
    if (copyEvents < o.events) {
      const n = Math.min(BATCH, o.events - copyEvents);
      await traffic(copy, rehearsal, sentCopy, n);
      copyEvents += n;
    }
    await rehearsal.idle();
    await copy.checkResident(rehearsal, BATCH);
  }
  copy.migrating = false;
  await traffic(copy, rehearsal, sentCopy, o.events - copyEvents);
  const result = copy.migrationDone ?? { migration: undefined, migrated: 0, failed: [], pending: undefined };
  if (result.migration !== migration || result.migrated !== o.actors || result.failed.length || result.pending?.length !== 0)
    failures.push(`copy: the migration ended ${JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}, not ${o.actors} migrated`);
  console.log(`rehearse: ${copy.moves} actors to version 2 in ${seconds(started)} s, ${o.events} events meanwhile, ` +
    `${copyStore.gets - gets} loaded from the copy's store`);

  // the sample: every actor up to S, and the first payers and waiting ones
  let sample;
  if (o.actors <= o.sample) sample = Array.from({ length: o.actors }, (_, i) => i);
  else {
    const chosen = new Set();
    while (chosen.size < o.sample) chosen.add(Math.floor(draw() * o.actors));
    sample = [...chosen];
  }
  sample = [...new Set([...sample, ...payers.slice(0, 50).map(index), ...waiting.filter((_, i) => i % 2 === 1).slice(0, 50).map(index)])]
    .sort((a, b) => a - b);
  const paying = new Set(payers), late = new Set(waiting);
  const report = async (population, h) => {
    population.reports.clear();
    for (let chunk = 0; chunk < sample.length; chunk += BATCH) {
      h.sendMany(sample.slice(chunk, chunk + BATCH).map((i) => ({ target: sessions[i], event: 'report' })));
      await h.idle();
      await population.checkResident(h);
    }
  };

  // 5. the copy: the clock past the delayed sends, then every count, send, payment and version
  copyClock.increment(10_000);
  await rehearsal.idle();
  const copyRegion = Number((await copy.checkResident(rehearsal)).regionBytes);
  await report(copy, rehearsal);
  const wrong = sample.filter((i) => copy.reports.get(sessions[i]) !==
    `${sent[i] + sentCopy[i]} ${late.has(sessions[i]) ? 1 : 0} ${paying.has(sessions[i]) ? 0 : -1} 2`);
  if (wrong.length) {
    failures.push(`copy: ${wrong.length} of ${sample.length} actors wrong, e.g. actor ${wrong[0]}: ${copy.reports.get(sessions[wrong[0]])}, ` +
      `expected ${sent[wrong[0]] + sentCopy[wrong[0]]} ${late.has(sessions[wrong[0]]) ? 1 : 0} ${paying.has(sessions[wrong[0]]) ? 0 : -1} 2`);
  }
  rehearsal.close();

  // 6. the live host goes on: its own events, the clock past its delayed sends; payments still in flight
  await traffic(live, host, sentLive, o.events);
  liveClock.increment(10_000);
  await host.idle();
  await report(live, host);
  const wrongLive = sample.filter((i) => live.reports.get(sessions[i]) !==
    `${sent[i] + sentLive[i]} ${late.has(sessions[i]) ? 1 : 0} -1 1`);
  if (wrongLive.length) {
    failures.push(`live: ${wrongLive.length} of ${sample.length} actors wrong, e.g. actor ${wrongLive[0]}: ` +
      `${live.reports.get(sessions[wrongLive[0]])}`);
  }
  if (!real.onceFor(payers) || real.restored || real.stopped.size)
    failures.push(`live: the real payment service was started ${real.started.size} times ` +
      `for ${payers.length} payers (${real.restored} restored), stopped ${real.stopped.size} times`);
  if (standIn.stopped.size !== payers.length || standIn.twice || payers.some((s) => !standIn.stopped.has(s)))
    failures.push(`copy: ${standIn.stopped.size} stand-in payments cancelled after their decline, ${payers.length} payers`);
  const liveRegion = Number((await live.checkResident(host)).regionBytes);
  host.close();
  let foreign = 0;
  for (const [session, stored] of liveStore.rows()) if (liveStore.written[index(session)] !== fingerprint(stored)) foreign++;
  if (foreign) failures.push(`live: ${foreign} blobs in the live store are not the live host's last`);
  const peakRSS = process.resourceUsage().maxRSS * 1024; // maxRSS: kilobytes (node, and bun's process.resourceUsage)
  console.log(`verify: ${sample.length} actors on each host, ${wrong.length} wrong on the copy, ${wrongLive.length} on the live host`);
  console.log(`memory: peak resident ${Math.round(peakRSS / 1e6)} MB (${Math.round(peakRSS / o.actors)} B an actor, both hosts); ` +
    `region ${(liveRegion / 1e6).toFixed(1)} MB live, ${(copyRegion / 1e6).toFixed(1)} MB the copy ` +
    `(${Math.round(liveRegion / o.actors)} B an actor); at most ${Math.max(live.peak, copy.peak)} actors resident after a turn`);
  rmSync(directory, { recursive: true, force: true });
  for (const failure of failures.slice(0, 20)) console.log(`FAIL ${failure}`);
  process.exitCode = failures.length ? 1 : 0;
}

await main();
