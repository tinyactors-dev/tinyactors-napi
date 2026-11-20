// Live migration under load: every actor moves to a new chart version
// while events keep coming, most of them asleep in SQLite (docs/plan.xml,
// p2-migrate; translated from tinyactors-cpython/tools/migration.py).
//
//     node tools/migration.mjs [--actors N] [--resident R] [--events E] [--datamodel native|quickjs]
//                              [--sample S] [--seed K]
//
// The application's side of migration (README, "Migration"), as a program
// would write it, with the host's store and resident bound (new
// Host(charts, {store, resident: R}), tools/store.mjs's store):
//
// 1. populate: N actors of version 1 of a counter chart, at most R
//    resident after each turn, the rest hibernated into SQLite; then E
//    events to actors drawn at random;
// 2. migrate: version 2 of the chart is added, and host.migrate({wake:
//    true}) moves every actor of version 1 to it. Version 2 takes the count
//    from error.platform.upgrade (version 1's bindings) and knows its
//    version. The migration asks for each hibernated actor with a WAKE; the
//    host loads those while fewer than R are resident and keeps the rest for
//    a later turn with room, so the population moves R at a time. An
//    event's WAKE loads its actor at once. Meanwhile E more events go to
//    random actors, a batch a round: the migration is live;
// 3. verify: the migration ended with every actor migrated, none failed,
//    none left; a sample of actors (all when N is small) reports its count
//    and version, which must be the events it was sent and 2; the old
//    version's segment was retired; after every turn at most R actors were
//    resident, plus a batch (the actors a round's events woke).
//
// Exits with status 1 when a check fails. Prints the times, the rates, the
// store's size, the process's peak memory and the host's region per actor.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileCharts, Host } from '@tinyactors/node';
import { BATCH, engine, random, Store } from './store.mjs';

// tinyactors-cpython/tools/charts/counter-v1.ecmascript.scxml and -v2.
const V1 = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="s">
  <datamodel>
    <data id="n" expr="0" />
    <data id="last" expr="null" />
  </datamodel>
  <state id="s">
    <transition event="inc">
      <assign location="n" expr="n + 1" />
      <assign location="last" expr="_event.data" />
    </transition>
    <transition event="report">
      <log label="count" expr="_sessionid + ' ' + n + ' 1'" />
    </transition>
  </state>
</scxml>
`;

const V2 = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="s">
  <datamodel>
    <data id="n" expr="0" />
    <data id="last" expr="null" />
    <data id="version" expr="2" />
  </datamodel>
  <state id="s">
    <transition event="error.platform.upgrade">
      <assign location="n" expr="_event.data.n" />
      <assign location="last" expr="_event.data.last" />
    </transition>
    <transition event="inc">
      <assign location="n" expr="n + 1" />
      <assign location="last" expr="_event.data" />
    </transition>
    <transition event="report">
      <log label="count" expr="_sessionid + ' ' + n + ' ' + version" />
    </transition>
  </state>
</scxml>
`;

function options(argv) {
  const given = { actors: 1_000_000, resident: 1000, events: 100_000, sample: 25_000, datamodel: 'native', seed: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    if (!(name in given) || i + 1 >= argv.length) throw new Error(`unknown option ${argv[i]}`);
    given[name] = name === 'datamodel' ? argv[i + 1] : Number(argv[i + 1]);
  }
  if (!['native', 'quickjs'].includes(given.datamodel)) throw new Error('--datamodel is native or quickjs');
  return given;
}

function add(host, text) {
  const compiled = compileCharts([{ name: 'counter.scxml', text }]);
  try {
    return host.addImage(compiled.image);
  } finally {
    compiled.close();
  }
}

async function main() {
  const o = options(process.argv.slice(2));
  const draw = random(o.seed);
  const failures = [];
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tinyactors-migration-'));
  const file = path.join(directory, 'actors.db');
  const store = await Store.open(file);
  const moved = new Uint8Array(o.actors); // 1: migrated to version 2 (the MIGRATED effect)
  const counts = new Map();
  let moves = 0;
  const current = { id: undefined, result: undefined }; // the migration: its id, then migrationDone's result
  const index = (session) => Number(session & 0xFFFFFFFFn) - 1; // segment 0 numbers its sessions 1, 2, ...

  const migrated = (entry) => {
    if (moved[index(entry.session)]) failures.push(`actor ${entry.session} moved twice`);
    moved[index(entry.session)] = 1;
    moves++;
  };
  const migrationDone = (result) => {
    current.result = result;
  };
  const log = (entry) => {
    const [session, count, version] = entry.text.split(' ');
    counts.set(BigInt(session), [Number(count), Number(version)]);
  };

  let peak = 0;
  const checkResident = async (slack) => {
    const got = (await host.hostStats()).host;
    const live = Number(got.actors) - Number(got.hibernated);
    peak = Math.max(peak, live);
    if (live > o.resident + slack) failures.push(`${live} actors resident, more than ${o.resident} + ${slack}`);
    return got;
  };

  // sized as tools/stress.mjs's (instance 128 B and strings 16 B per resident actor, tracing off)
  const room = o.resident + 4 * BATCH;
  const config = {
    system: { maxActors: o.actors + 4 * BATCH, maxEvents: 4096, instanceBytes: 128 * room, stringBytes: 16384 + 16 * room, tracing: false },
  };
  const compiled = compileCharts([{ name: 'counter.scxml', text: V1 }]);
  const host = new Host(compiled, {
    system: 'migration', config, ...engine(o.datamodel), log, migrated, migrationDone, store, resident: o.resident,
  });
  compiled.close();

  // 1. populate, R resident at most after each turn, and events
  let started = performance.now();
  const sessions = new BigUint64Array(o.actors);
  const sent = new Uint32Array(o.actors);
  for (let i = 0; i < o.actors; i++) {
    sessions[i] = host.spawn('counter').id;
    if (i % BATCH === BATCH - 1) await host.idle();
  }
  await host.idle();
  if (o.actors && sessions[o.actors - 1] !== sessions[0] + BigInt(o.actors - 1)) failures.push('the sessions are not numbered 1..N in segment 0: index() is wrong');
  const traffic = (count) => {
    const items = [];
    for (let k = 0; k < count; k++) {
      const i = Math.floor(draw() * o.actors);
      sent[i]++;
      items.push({ target: sessions[i], event: 'inc', data: { k: i } });
    }
    if (host.sendMany(items) !== items.length) failures.push('sendMany refused events');
  };
  for (let first = 0; first < o.events; first += BATCH) {
    traffic(Math.min(BATCH, o.events - first));
    await host.idle();
  }
  store.flush();
  let got = await checkResident(0);
  const populated = (performance.now() - started) / 1000;
  console.log(`populate: ${o.actors} actors of version 1 and ${o.events} events in ${populated.toFixed(1)} s, ` +
    `${Number(got.actors) - Number(got.hibernated)} resident, ${got.hibernated} hibernated`);

  // 2. migrate, live
  started = performance.now();
  const gets = store.gets;
  add(host, V2);
  let regionBoth;
  current.id = host.migrate({ wake: true });
  let live = 0, stalled = 0, before = -1;
  while (current.result === undefined) {
    stalled = moves === before ? stalled + 1 : 0;
    before = moves;
    if (stalled > 100) {
      failures.push(`the migration stalled: nothing moved in 100 rounds, ${before} actors moved`);
      break;
    }
    if (live < o.events) {
      traffic(Math.min(BATCH, o.events - live));
      live += Math.min(BATCH, o.events - live);
    }
    await host.idle();
    got = await checkResident(BATCH);
    regionBoth ??= Number(got.regionBytes);
  }
  while (live < o.events) { // the rest after the migration, so every run has its E events
    traffic(Math.min(BATCH, o.events - live));
    live += Math.min(BATCH, o.events - live);
    await host.idle();
  }
  store.flush();
  const migration = (performance.now() - started) / 1000;
  const result = current.result ?? { migration: undefined, migrated: 0, failed: [], pending: undefined };
  if (result.migration !== current.id || result.migrated !== o.actors || result.failed.length || result.pending?.length !== 0)
    failures.push(`the migration ended ${JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}, not ${o.actors} migrated`);
  if (moves !== o.actors) failures.push(`${moves} MIGRATED effects for ${o.actors} actors`);
  await checkResident(0);
  console.log(`migrate: ${moves} actors to version 2 in ${migration.toFixed(1)} s (${Math.round(moves / migration)} a second), ` +
    `${o.events} events meanwhile, ${store.gets - gets} loaded from the store`);

  // 3. verify a sample
  started = performance.now();
  let sample;
  if (o.actors <= o.sample) sample = Array.from({ length: o.actors }, (_, i) => i);
  else {
    const chosen = new Set();
    while (chosen.size < o.sample) chosen.add(Math.floor(draw() * o.actors));
    sample = [...chosen];
  }
  for (let chunk = 0; chunk < sample.length; chunk += BATCH) {
    host.sendMany(sample.slice(chunk, chunk + BATCH).map((i) => ({ target: sessions[i], event: 'report' })));
    await host.idle();
    await checkResident(0);
  }
  const wrong = sample.filter((i) => {
    const count = counts.get(sessions[i]);
    return count === undefined || count[0] !== sent[i] || count[1] !== 2;
  });
  if (wrong.length)
    failures.push(`${wrong.length} of ${sample.length} actors wrong, e.g. actor ${wrong[0]}: ` +
      `${JSON.stringify(counts.get(sessions[wrong[0]]))}, sent ${sent[wrong[0]]}`);
  got = await checkResident(0);
  if (Number(got.segments) !== 1) failures.push(`${got.segments} segments live after the migration: version 1's was not retired`);
  const region = Number(got.regionBytes);
  const verified = (performance.now() - started) / 1000;
  host.close();
  store.flush();
  const size = statSync(file).size;
  const peakRSS = process.resourceUsage().maxRSS * 1024; // maxRSS: kilobytes (node, and bun's process.resourceUsage)
  console.log(`verify: ${sample.length} actors' counts and versions in ${verified.toFixed(1)} s, ${wrong.length} wrong`);
  console.log(`store: ${store.puts} puts, ${store.gets} gets, ${(size / 1e6).toFixed(1)} MB`);
  console.log(`memory: peak resident ${Math.round(peakRSS / 1e6)} MB (${Math.round(peakRSS / o.actors)} B an actor); ` +
    `region ${((regionBoth ?? 0) / 1e6).toFixed(1)} MB with both versions, ${(region / 1e6).toFixed(1)} MB after ` +
    `(${Math.round(region / o.actors)} B an actor); at most ${peak} actors resident after an eviction`);
  rmSync(directory, { recursive: true, force: true });
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exitCode = failures.length ? 1 : 0;
}

await main();
