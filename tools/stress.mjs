// Hibernation under load: many actors, few resident, the rest in SQLite
// (docs/plan.xml, p2-hibernate; translated from
// tinyactors-cpython/tools/stress.py).
//
//     node tools/stress.mjs [--actors N] [--resident R] [--events E] [--datamodel native|quickjs]
//                           [--sample S] [--seed K]
//
// The application's side of hibernation (README, "Hibernation"), as a
// program would write it: a store and a bound, new Host(charts, {store,
// resident: R}), and the host does the rest.
//
// 1. populate: spawn N actors of a counter chart; after each turn the host
//    hibernates the surplus past R into the store (one SQLite row each);
// 2. traffic: E events to actors drawn at random; an event for a
//    hibernated actor makes a WAKE, for which the host loads the blob and
//    wakes it, and after the turn the CLOCK sweep's cold actors go back to
//    the store until R are resident;
// 3. verify: a sample of actors (all of them when N is small) reports its
//    count, which must be the events it was sent; after every turn at most
//    R actors are resident (hostStats).
//
// The store is node:sqlite under node and bun:sqlite under bun, each
// runtime's own SQLite. Exits with status 1 when a check fails. Prints the
// times, the rates, the store's size, the process's peak memory and the
// host's region per actor.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileCharts, Host } from '@tinyactors/node';
import { BATCH, engine, random, Store } from './store.mjs';

// The counter of tinyactors-cpython/tools/charts/counter.ecmascript.scxml.
const COUNTER = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="s">
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
      <log label="count" expr="_sessionid + ' ' + n" />
    </transition>
  </state>
</scxml>
`;

function options(argv) {
  const given = { actors: 2_000_000, resident: 1000, events: 200_000, sample: 10_000, datamodel: 'native', seed: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    if (!(name in given) || i + 1 >= argv.length) throw new Error(`unknown option ${argv[i]}`);
    given[name] = name === 'datamodel' ? argv[i + 1] : Number(argv[i + 1]);
  }
  if (!['native', 'quickjs'].includes(given.datamodel)) throw new Error('--datamodel is native or quickjs');
  return given;
}

async function main() {
  const o = options(process.argv.slice(2));
  const draw = random(o.seed);
  const failures = [];
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tinyactors-stress-'));
  const file = path.join(directory, 'actors.db');
  const store = await Store.open(file);
  const counts = new Map();
  const log = (entry) => {
    const [session, count] = entry.text.split(' ');
    counts.set(BigInt(session), Number(count));
  };

  let peak = 0;
  const checkResident = async () => {
    const got = (await host.hostStats()).host;
    const live = Number(got.actors) - Number(got.hibernated);
    peak = Math.max(peak, live);
    if (live > o.resident) failures.push(`${live} actors resident, more than ${o.resident}`);
    return got;
  };

  // Capacity planning, as Python's: an actor slot for every actor, instance
  // and string memory for the resident ones only, tracing off (nobody
  // exports the traces here). Left to grow, a segment doubles every pool
  // together, instance memory derived from maxActors: size the pools.
  const room = o.resident + 2 * BATCH;
  const config = {
    system: { maxActors: o.actors + 4 * BATCH, maxEvents: 4096, instanceBytes: 128 * room, stringBytes: 16384 + 16 * room, tracing: false },
  };
  const compiled = compileCharts([{ name: 'counter.scxml', text: COUNTER }]);
  const host = new Host(compiled, { system: 'stress', config, ...engine(o.datamodel), log, store, resident: o.resident });
  compiled.close();

  // 1. populate, R resident at most after each turn
  let started = performance.now();
  const sessions = new BigUint64Array(o.actors);
  for (let i = 0; i < o.actors; i++) {
    sessions[i] = host.spawn('counter').id;
    if (i % BATCH === BATCH - 1) {
      await host.idle();
      await checkResident();
    }
    if (i && i % 500_000 === 0) console.log(`  populate: ${i} actors, ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
  await host.idle();
  store.flush();
  const populated = (performance.now() - started) / 1000;
  let got = await checkResident();
  console.log(`populate: ${o.actors} actors in ${populated.toFixed(1)} s (${Math.round(o.actors / populated)} spawned and hibernated a second), ` +
    `${Number(got.actors) - Number(got.hibernated)} resident, ${got.hibernated} hibernated`);

  // 2. traffic: random actors, woken from the store, swept back
  started = performance.now();
  const sent = new Uint32Array(o.actors);
  const gets = store.gets;
  for (let first = 0; first < o.events; first += BATCH) {
    const items = [];
    for (let k = 0; k < Math.min(BATCH, o.events - first); k++) {
      const index = Math.floor(draw() * o.actors);
      sent[index]++;
      items.push({ target: sessions[index], event: 'inc', data: { k: index } });
    }
    if (host.sendMany(items) !== items.length) failures.push('sendMany refused events');
    await host.idle(); // WAKE: loaded from the store, woken, the events run, the surplus swept back
    await checkResident();
  }
  store.flush();
  const traffic = (performance.now() - started) / 1000;
  await checkResident();
  console.log(`traffic: ${o.events} events in ${traffic.toFixed(1)} s (${Math.round(o.events / traffic)} a second): ` +
    `${store.gets - gets} woken from the store`);

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
    const items = sample.slice(chunk, chunk + BATCH).map((index) => ({ target: sessions[index], event: 'report' }));
    host.sendMany(items);
    await host.idle();
    await checkResident();
  }
  const wrong = sample.filter((index) => counts.get(sessions[index]) !== sent[index]);
  if (wrong.length)
    failures.push(`${wrong.length} of ${sample.length} actors counted wrong, e.g. actor ${wrong[0]}: ` +
      `${counts.get(sessions[wrong[0]])}, sent ${sent[wrong[0]]}`);
  got = await checkResident();
  const region = Number(got.regionBytes);
  const verified = (performance.now() - started) / 1000;
  host.close();
  store.flush();
  const size = statSync(file).size;
  // maxRSS: kilobytes (node, and bun's process.resourceUsage)
  const peakRSS = process.resourceUsage().maxRSS * 1024;
  console.log(`verify: ${sample.length} actors' counts in ${verified.toFixed(1)} s, ${wrong.length} wrong`);
  console.log(`store: ${store.puts} puts, ${store.gets} gets, ${(size / 1e6).toFixed(1)} MB (${Math.round(size / o.actors)} B an actor)`);
  console.log(`memory: peak resident ${Math.round(peakRSS / 1e6)} MB (${Math.round(peakRSS / o.actors)} B an actor); ` +
    `region ${(region / 1e6).toFixed(1)} MB (${Math.round(region / o.actors)} B an actor); ` +
    `at most ${peak} actors resident after an eviction`);
  rmSync(directory, { recursive: true, force: true });
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exitCode = failures.length ? 1 : 0;
}

await main();
