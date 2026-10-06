'use strict';
// Hot reload (CGI style) and live migration: system.reload(machine) and system.migrate().
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, createActor, createSystem, assign, sendTo } = require('./binding');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const counterV1 = () =>
  createMachine({
    id: 'counter',
    context: { count: 0, label: 'v1' },
    initial: 'counting',
    states: {
      counting: {
        on: {
          INC: { actions: assign({ count: ({ context }) => context.count + 1 }) },
          PAUSE: 'paused',
        },
        after: { 60: { actions: assign({ ticked: true }) } },
      },
      paused: { on: { RESUME: 'counting' } },
    },
  });

/* v2: count renamed to total (taken over from the upgrade event), label dropped,
 * a new state, INC counts in tens */
const counterV2 = () =>
  createMachine({
    id: 'counter',
    context: { total: 0, version: 2, ticked: false },
    initial: 'counting',
    on: {
      'error.platform.upgrade': { actions: assign({ total: ({ event }) => event.data.count, previous: ({ event }) => event.data }) },
    },
    states: {
      counting: {
        on: {
          INC: { actions: assign({ total: ({ context }) => context.total + 10 }) },
          PAUSE: 'paused',
        },
        after: { 60: { actions: assign({ ticked: true }) } },
      },
      paused: { on: { RESUME: 'counting', STOP: 'stopped' } },
      stopped: { type: 'final' },
    },
  });

test('reload: new actors run the new version, running ones keep theirs, old versions are freed', async () => {
  const system = createSystem();
  const old = createActor(counterV1(), { system }).start();
  old.send({ type: 'INC' });
  const v = system.reload(counterV2());
  assert.equal(v, 2);
  assert.equal(system.reload(counterV2()), 3);

  const fresh = createActor(counterV1(), { system }).start(); // same id: the current version
  fresh.send({ type: 'INC' });
  assert.equal(fresh.getSnapshot().context.total, 10);
  assert.equal(old.getSnapshot().context.count, 1); // untouched
  old.send({ type: 'INC' });
  assert.equal(old.getSnapshot().context.count, 2);

  // addresses work across versions (one base URI for the whole system)
  assert.match(old.address, /^tinyactors:\/\/[^/]+\/#_scxml_\d+$/);
  const relay = createMachine({
    id: 'relay',
    on: { POKE: { actions: sendTo(({ event }) => system.ref(event.to), { type: 'INC' }) } },
  });
  const r = createActor(relay, { system }).start();
  r.send({ type: 'POKE', to: old.address });
  r.send({ type: 'POKE', to: fresh.address });
  await wait(5);
  assert.equal(old.getSnapshot().context.count, 3);
  assert.equal(fresh.getSnapshot().context.total, 20);

  // version 2 never had actors: freed; version 1 is freed once its last actor stops
  const before = system.stats().length;
  old.stop();
  await wait(5);
  assert.ok(system.stats().length < before);
  system.stop();
});

test('migrate: states by id, context through error.platform.upgrade, same address, timers kept', async () => {
  const system = createSystem();
  const a = createActor(counterV1(), { system }).start();
  a.send({ type: 'INC' });
  a.send({ type: 'INC' });
  const address = a.address;
  system.reload(counterV2());
  const { migrated, pending } = system.migrate();
  assert.deepEqual([migrated.length, pending.length], [1, 0]);
  await wait(5);
  const s = a.getSnapshot();
  assert.equal(s.value, 'counting');
  assert.equal(s.context.total, 2); // taken over by the upgrade handler
  assert.equal(s.context.version, 2); // new <data> initialized
  assert.equal(s.context.count, undefined); // not declared by v2: dropped
  assert.deepEqual(s.context.previous, { count: 2, label: 'v1' });
  assert.equal(a.address, address);
  a.send({ type: 'INC' });
  assert.equal(a.getSnapshot().context.total, 12); // v2 behaviour
  await wait(90); // the delayed transition armed by v1 fires in v2
  assert.equal(a.getSnapshot().context.ticked, true);
  a.send({ type: 'PAUSE' });
  a.send({ type: 'STOP' }); // a state only v2 has
  assert.equal(a.getSnapshot().status, 'done');
  assert.equal(system.migrate().migrated.length, 0); // nothing left on old versions
  system.stop();
});

test('migrate from inside an action waits for a stable point', async () => {
  const system = createSystem();
  let calls = 0;
  const v1 = createMachine({
    id: 'self',
    context: { n: 1 },
    initial: 'a',
    states: { a: { on: { GO: { target: 'b', actions: () => (calls++, system.migrate()) } } }, b: {} },
  });
  const v2 = createMachine({
    id: 'self',
    context: { n: 0 },
    initial: 'a',
    on: { 'error.platform.upgrade': { actions: assign({ n: ({ event }) => event.data.n + 100 }) } },
    states: { a: {}, b: {} },
  });
  const a = createActor(v1, { system }).start();
  system.reload(v2);
  a.send({ type: 'GO' });
  await wait(5);
  assert.equal(calls, 1);
  assert.equal(a.getSnapshot().value, 'b');
  assert.equal(a.getSnapshot().context.n, 101);
  system.stop();
});

test('sends to an address nobody has raise error.communication', async () => {
  const system = createSystem();
  const m = createMachine({
    id: 'sender',
    context: { errors: 0 },
    on: {
      SEND: { actions: sendTo(({ event }) => system.ref(event.to), { type: 'HI' }) },
      'error.communication': { actions: assign({ errors: ({ context }) => context.errors + 1 }) },
    },
  });
  const a = createActor(m, { system }).start();
  const gone = createActor(createMachine({ id: 'gone' }), { system }).start();
  const address = gone.address;
  gone.stop();
  await wait(5);
  a.send({ type: 'SEND', to: address });
  a.send({ type: 'SEND', to: address.replace(/\d+$/, '987654') });
  await wait(5);
  assert.equal(a.getSnapshot().context.errors, 2);
  system.stop();
});

test('reload rejects a machine that does not compile and keeps the current version', () => {
  const system = createSystem();
  createActor(counterV1(), { system }).start();
  const broken = createMachine({ id: 'counter', initial: 'nope', states: { a: {} } });
  assert.throws(() => system.reload(broken));
  const a = createActor(counterV1(), { system }).start();
  assert.equal(a.getSnapshot().context.label, 'v1');
  system.stop();
});

test('migrate works in time slices: the call returns early, done resolves when all moved', async () => {
  const system = createSystem();
  const N = 3000;
  const v1 = createMachine({ id: 'many', context: { n: 1 }, initial: 'a', states: { a: {} } });
  const v2 = createMachine({ id: 'many', context: { n: 0 }, initial: 'a', states: { a: {} } });
  const actors = Array.from({ length: N }, () => createActor(v1, { system }).start());
  system.reload(v2);
  const r = system.migrate();
  assert.ok(r.migrated.length < N, `one slice moved ${r.migrated.length} of ${N}`);
  assert.ok(r.pending.length > 0);
  await r.done;
  assert.equal(r.pending.length, 0);
  assert.ok(actors.every((a) => a.logic === v2 && a.getSnapshot().context.n === 1));
  assert.equal(system.ref(actors[N - 1].address), actors[N - 1]); // ref() by session id
  system.stop();
});

const { createMemoryStore } = require('./binding');

const sleeperV1 = () =>
  createMachine({
    id: 'sleeper',
    context: { count: 7 },
    initial: 'idle',
    states: { idle: { on: { PING: { actions: assign({ count: ({ context }) => context.count + 1 }) } } } },
  });
const sleeperV2 = () =>
  createMachine({
    id: 'sleeper',
    context: { total: 0 },
    initial: 'idle',
    on: { 'error.platform.upgrade': { actions: assign({ total: ({ event }) => event.data.count }) } },
    states: { idle: {} },
  });

test('migrate wakes hibernated actors (async store) by default when the system has a store', async () => {
  const mem = createMemoryStore();
  let reads = 0;
  const store = { // an asynchronous store, like a database
    get: (k) => new Promise((r) => setTimeout(() => (reads++, r(mem.get(k))), 2)),
    set: (k, v) => mem.set(k, v),
    delete: (k) => mem.delete(k),
  };
  const system = createSystem({ hibernation: { store, sweepMs: 0 } });
  const a = createActor(sleeperV1(), { system }).start();
  await wait(5);
  assert.equal(system.hibernate(a), 1);
  assert.equal(a.hibernated, true);
  system.reload(sleeperV2());
  const m = system.migrate();
  assert.equal(m.migrated.length, 0); // asleep: loaded first
  const r = await m.done;
  assert.deepEqual([r.migrated, r.failed, r.pending.length], [1, 0, 0]);
  assert.equal(reads, 1);
  await wait(5);
  assert.equal(a.hibernated, false);
  assert.equal(a.getSnapshot().context.total, 7);
  system.stop();
});

test('migrate({ wake: false, timeoutMs }) leaves sleeping and busy actors behind and says who', async () => {
  const system = createSystem({ hibernation: { store: createMemoryStore(), sweepMs: 0 } });
  const asleep = createActor(sleeperV1(), { system }).start();
  // busy for good: an invoked child that never finishes keeps its parent from moving
  const child = createMachine({ id: 'kid', initial: 'forever', states: { forever: {} } });
  const parentV1 = createMachine({ id: 'parent', initial: 'a', states: { a: { invoke: { src: child } } } });
  const parentV2 = createMachine({ id: 'parent', initial: 'a', states: { a: {} } });
  const parent = createActor(parentV1, { system }).start();
  await wait(5);
  system.hibernate(asleep);
  system.reload(sleeperV2());
  system.reload(parentV2);
  const t0 = Date.now();
  const r = await system.migrate(undefined, { wake: false, timeoutMs: 40 }).done;
  assert.ok(Date.now() - t0 >= 35);
  assert.equal(r.migrated, 0);
  assert.deepEqual(new Set(r.pending), new Set([asleep, parent]));
  assert.equal(asleep.hibernated, true); // untouched, still on version 1
  assert.equal(parent.getSnapshot().value, 'a');
  // it moves once it wakes and a migration is asked for again
  asleep.send({ type: 'PING' });
  await wait(10);
  const r2 = await system.migrate(asleep).done;
  assert.equal(r2.migrated, 1);
  assert.equal(asleep.getSnapshot().context.total, 8);
  system.stop();
});

test('migrate({ wake: true }) needs a hibernation store', () => {
  const system = createSystem();
  assert.throws(() => system.migrate(undefined, { wake: true }), /hibernation store/);
  system.stop();
});
