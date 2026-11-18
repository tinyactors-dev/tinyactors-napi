// Invoked services under load: every actor invokes a service the
// application runs, talks to it, and ends it one of three ways
// (docs/plan.xml, p2-services; translated from
// tinyactors-cpython/tools/services.py).
//
//     node tools/services.mjs [--actors N] [--events E] [--datamodel native|quickjs] [--seed K]
//
// The application's side of invoked services (README, "Invoked services"),
// as a program would write it:
//
// 1. start: N actors of a client chart, each invoking a counter service
//    (<invoke type="urn:example:counter">) with params; the application
//    registered a handler for the type, which makes one object per
//    invocation;
// 2. traffic: E times, a client drawn at random is told to ping its service
//    (<send target="#_counter">); the service counts and sends back a pong
//    with its count (invocation.sendBack); the client counts the pongs;
// 3. end: a third of the clients ask their service to finish, which ends
//    the invocation with done data (invocation.done), so the client gets
//    done.invoke.counter; a third leave the invoking state, so core cancels
//    the invocation and the service is stopped (service.stop); the rest
//    keep theirs;
// 4. verify: every client reports its pongs, the done data it got, and its
//    state; every ping was answered once, every finished client's total is
//    its pongs, every cancelled service was stopped once and no other, and
//    the host holds exactly the services still running (the others'
//    objects are collected).
//
// Exits with status 1 when a check fails. Prints the times, the round
// trips a second, the process's peak memory and the host's region per
// actor.

import { compileCharts, Host } from '@tinyactors/node';
import { BATCH, engine, random } from './store.mjs';

const COUNTER = 'urn:example:counter';

// tinyactors-cpython/tools/charts/client.ecmascript.scxml
const CLIENT = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="client" initial="talking">
  <datamodel>
    <data id="pongs" expr="0" />
    <data id="total" expr="-1" />
    <data id="seed" expr="0" />
  </datamodel>
  <state id="talking">
    <invoke id="counter" type="urn:example:counter" src="counter://local">
      <param name="seed" expr="seed" />
    </invoke>
    <transition event="go">
      <send target="#_counter" event="ping">
        <content expr="({n: pongs})" />
      </send>
    </transition>
    <transition event="pong">
      <assign location="pongs" expr="pongs + 1" />
    </transition>
    <transition event="end">
      <send target="#_counter" event="finish" />
    </transition>
    <transition event="done.invoke.counter" target="finished">
      <assign location="total" expr="_event.data.total" />
    </transition>
    <transition event="leave" target="left" />
    <transition event="report">
      <log label="report" expr="_sessionid + ' ' + pongs + ' ' + total + ' talking'" />
    </transition>
  </state>
  <state id="finished">
    <transition event="report">
      <log label="report" expr="_sessionid + ' ' + pongs + ' ' + total + ' finished'" />
    </transition>
  </state>
  <state id="left">
    <transition event="report">
      <log label="report" expr="_sessionid + ' ' + pongs + ' ' + total + ' left'" />
    </transition>
  </state>
</scxml>
`;

function options(argv) {
  const given = { actors: 200_000, events: 1_000_000, datamodel: 'native', seed: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    if (!(name in given) || i + 1 >= argv.length) throw new Error(`unknown option ${argv[i]}`);
    given[name] = name === 'datamodel' ? argv[i + 1] : Number(argv[i + 1]);
  }
  if (!['native', 'quickjs'].includes(given.datamodel)) throw new Error('--datamodel is native or quickjs');
  return given;
}

// A full collection (node: gc exposed at run time, as test/harness.mjs
// does; bun: Bun.gc), then a turn for the finalizers.
async function collect() {
  let gc;
  if (globalThis.Bun) gc = () => globalThis.Bun.gc(true);
  else {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose_gc');
    gc = vm.runInNewContext('gc');
  }
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A service: one object per invocation, counting the pings it gets. */
class Counter {
  constructor(invocation, world) {
    this.invocation = invocation;
    this.count = 0;
    this.world = world;
  }

  receive(host, send) {
    if (send.event === 'ping') {
      this.count++;
      if (send.data.n > this.count - 1) // never more pongs counted than sent (some may be on their way)
        this.world.failures.push(`session ${this.invocation.session} pinged with n=${send.data.n} after ${this.count - 1} pongs`);
      this.invocation.sendBack('pong', { n: this.count });
    } else if (send.event === 'finish') {
      this.invocation.done({ total: this.count });
      this.world.done.add(this.invocation.session);
    }
  }

  stop(host) {
    const session = this.invocation.session;
    if (this.world.stopped.has(session)) this.world.failures.push(`session ${session} stopped twice`);
    this.world.stopped.add(session);
  }
}

class World {
  constructor() {
    this.failures = [];
    this.started = new Map();
    this.done = new Set();
    this.stopped = new Set();
    this.reports = new Map();
    this.alive = []; // weak references to every service: the host holds the running ones only
    this.start = (host, invocation) => {
      if (this.started.has(invocation.session)) this.failures.push(`session ${invocation.session} invoked twice`);
      if (invocation.type !== COUNTER || invocation.src !== 'counter://local' || invocation.invokeid !== 'counter')
        this.failures.push(`an invocation of ${invocation.type} ${invocation.src} ${invocation.invokeid}`);
      this.started.set(invocation.session, invocation.data.seed);
      const service = new Counter(invocation, this);
      this.alive.push(new WeakRef(service));
      return service;
    };
    this.log = (host, entry) => {
      const [session, pongs, total, state] = entry.text.split(' ');
      this.reports.set(BigInt(session), `${pongs} ${total} ${state}`);
    };
  }
}

async function main() {
  const o = options(process.argv.slice(2));
  const draw = random(o.seed);
  const world = new World();
  const room = o.actors + 4 * BATCH;
  // Capacity planning, as Python's: an invocation is a request of core's
  // (maxRequests); quickjs keeps each actor's last event in core's pool (its
  // datamodel does not detach _event), so on quickjs maxEvents counts the
  // actors too. The counter's instance fits in 128 B, its strings in 16;
  // tracing off (nobody exports the traces here).
  const events = 16384 + (o.datamodel === 'quickjs' ? room : 0);
  const config = {
    systemID: 'services',
    system: { maxActors: room, maxRequests: room, maxEvents: events, instanceBytes: 128 * room, stringBytes: 16384 + 16 * room, tracing: false },
  };
  const host = new Host(config, { ...engine(o.datamodel), log: world.log, services: { [COUNTER]: world.start } });
  const compiled = compileCharts([{ name: 'client.scxml', text: CLIENT }]);
  host.addImage(compiled.image);
  compiled.close();
  const chart = host.chart('client');

  // 1. start: every actor invokes a counter
  let started = performance.now();
  const sessions = new BigUint64Array(o.actors);
  for (let i = 0; i < o.actors; i++) {
    sessions[i] = host.spawn(chart, { params: { seed: i } });
    if (i % BATCH === BATCH - 1) await host.idle();
  }
  await host.idle();
  const startTime = (performance.now() - started) / 1000;
  if (world.started.size !== o.actors) world.failures.push(`${world.started.size} invocations started for ${o.actors} actors`);
  let wrongSeed = 0;
  for (let i = 0; i < o.actors; i++) if (world.started.get(sessions[i]) !== i) wrongSeed++;
  if (wrongSeed) world.failures.push(`${wrongSeed} invocations got another actor's params`);
  console.log(`start: ${o.actors} actors, each with an invoked service, in ${startTime.toFixed(1)} s ` +
    `(${Math.round(o.actors / startTime)} a second)`);

  // 2. traffic: pings and pongs
  started = performance.now();
  const gos = new Uint32Array(o.actors);
  for (let first = 0; first < o.events; first += BATCH) {
    const items = [];
    for (let k = 0; k < Math.min(BATCH, o.events - first); k++) {
      const i = Math.floor(draw() * o.actors);
      gos[i]++;
      items.push({ target: sessions[i], event: 'go' });
    }
    if (host.sendMany(items) !== items.length) world.failures.push('sendMany refused events');
    await host.idle();
  }
  const traffic = (performance.now() - started) / 1000;
  console.log(`traffic: ${o.events} round trips (actor -> service -> actor) in ${traffic.toFixed(1)} s ` +
    `(${Math.round(o.events / traffic)} a second)`);

  // 3. end: a third finish (done.invoke), a third leave (cancelled), the rest keep theirs
  started = performance.now();
  const finishing = new Set();
  const leaving = new Set();
  for (let i = 0; i < o.actors; i += 3) finishing.add(sessions[i]);
  for (let i = 1; i < o.actors; i += 3) leaving.add(sessions[i]);
  const ends = [...[...finishing].map((s) => ({ target: s, event: 'end' })), ...[...leaving].map((s) => ({ target: s, event: 'leave' }))];
  for (let first = 0; first < ends.length; first += BATCH) {
    const items = ends.slice(first, first + BATCH);
    if (host.sendMany(items) !== items.length) world.failures.push('sendMany refused events');
    await host.idle();
  }
  const ending = (performance.now() - started) / 1000;
  console.log(`end: ${finishing.size} finished with done data, ${leaving.size} cancelled, in ${ending.toFixed(1)} s`);

  // 4. verify
  for (let first = 0; first < o.actors; first += BATCH) {
    const items = [];
    for (let i = first; i < Math.min(first + BATCH, o.actors); i++) items.push({ target: sessions[i], event: 'report' });
    host.sendMany(items);
    await host.idle();
  }
  const wrong = [];
  for (let i = 0; i < o.actors; i++) {
    const session = sessions[i];
    const state = finishing.has(session) ? 'finished' : leaving.has(session) ? 'left' : 'talking';
    const expected = `${gos[i]} ${finishing.has(session) ? gos[i] : -1} ${state}`;
    if (world.reports.get(session) !== expected) wrong.push([i, world.reports.get(session), expected]);
  }
  if (wrong.length)
    world.failures.push(`${wrong.length} of ${o.actors} actors wrong, e.g. actor ${wrong[0][0]}: ${wrong[0][1]}, expected ${wrong[0][2]}`);
  if (world.done.size !== finishing.size || [...finishing].some((s) => !world.done.has(s)))
    world.failures.push(`${world.done.size} services finished, ${finishing.size} asked to`);
  const strays = [...world.stopped].filter((s) => !leaving.has(s)).length;
  if (world.stopped.size !== leaving.size || strays)
    world.failures.push(`${world.stopped.size} services stopped (${strays} of them not cancelled), ${leaving.size} cancelled`);
  await collect();
  const running = world.alive.filter((ref) => ref.deref() !== undefined).length;
  const expectedRunning = o.actors - finishing.size - leaving.size;
  if (running !== expectedRunning) world.failures.push(`the host holds ${running} services, ${expectedRunning} still run`);
  let got;
  host.hostStats(undefined, (h, result) => (got = result.host));
  await host.idle();
  const region = Number(got.regionBytes);
  host.close();
  // maxRSS: kilobytes (node, and bun's process.resourceUsage)
  const peakRSS = process.resourceUsage().maxRSS * 1024;
  console.log(`verify: ${o.actors} actors' pongs, done data and states, ${wrong.length} wrong; ${running} services still running`);
  console.log(`memory: peak resident ${Math.round(peakRSS / 1e6)} MB (${Math.round(peakRSS / o.actors)} B an actor with its service); ` +
    `region ${(region / 1e6).toFixed(1)} MB (${Math.round(region / o.actors)} B an actor)`);
  for (const failure of world.failures.slice(0, 20)) console.log(`FAIL ${failure}`);
  process.exitCode = world.failures.length ? 1 : 0;
}

await main();
