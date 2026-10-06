'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, createActor, createSystem, createMemoryStore, assign } = require('./binding');

const tick = () => new Promise((r) => setTimeout(r, 5));

const counter = createMachine({
  id: 'sleepy',
  initial: 'on',
  context: { n: 0, seen: new Map(), at: new Date(0) },
  states: {
    on: {
      on: {
        INC: {
          actions: assign(({ context, event }) => {
            const seen = new Map(context.seen);
            seen.set(event.by || 'anon', (seen.get(event.by || 'anon') || 0) + 1);
            return { n: context.n + 1, seen };
          }),
        },
        LATER: 'waiting',
      },
    },
    waiting: { after: { 30: 'on' }, exit: assign({ woke: true }) },
  },
});

test('hibernate: unloaded to the store, woken by the next event, state intact', async () => {
  const store = createMemoryStore();
  const system = createSystem({ hibernation: { store, sweepMs: 0 } });
  const a = createActor(counter, { system }).start();
  a.send({ type: 'INC', by: 'x' });
  assert.equal(system.hibernate(a), 1);
  assert.equal(a.hibernated, true);
  assert.equal(store.size, 1);
  assert.equal(system.stats()[0].hibernated, 1);
  // snapshots are answered from cache while asleep
  assert.equal(a.getSnapshot().context.n, 1);
  assert.equal(a.getSnapshot().value, 'on');
  a.send({ type: 'INC', by: 'x' }); // queued in its mailbox; the system asks for the blob
  await tick();
  assert.equal(a.hibernated, false);
  assert.equal(store.size, 0);
  const s = a.getSnapshot();
  assert.equal(s.context.n, 2);
  assert.ok(s.context.seen instanceof Map, 'Map survives');
  assert.equal(s.context.seen.get('x'), 2);
  assert.ok(s.context.at instanceof Date);
  assert.equal(system.stats()[0].wakes, 1);
});

test('hibernate: a pending timer wakes the actor', async () => {
  const system = createSystem({ hibernation: { store: createMemoryStore(), sweepMs: 0 } });
  const a = createActor(counter, { system }).start();
  a.send({ type: 'LATER' });
  assert.equal(a.getSnapshot().value, 'waiting');
  assert.equal(system.hibernate(a), 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(a.hibernated, false);
  assert.equal(a.getSnapshot().value, 'on');
  assert.equal(a.getSnapshot().context.woke, true);
});

test('hibernate: async stores, the CLOCK sweep, and data that cannot be stored', async () => {
  const mem = new Map();
  const store = {
    get: async (k) => (await tick(), mem.get(k)),
    set: async (k, v) => (await tick(), void mem.set(k, v)),
    delete: async (k) => void mem.delete(k),
  };
  const system = createSystem({ hibernation: { store, sweepMs: 0 } });
  const actors = Array.from({ length: 50 }, () => createActor(counter, { system }).start());
  const fn = createActor(
    createMachine({ id: 'holdsFn', initial: 'a', context: {}, entry: assign({ f: () => () => 1 }), states: { a: {} } }),
    { system },
  ).start();
  assert.equal(system.hibernate(), 0, 'everything just ran (second chance)');
  assert.equal(system.hibernate(), 50, 'idle since the last sweep; the function-holder stays');
  assert.equal(fn.hibernated, false);
  for (const a of actors.slice(0, 10)) a.send({ type: 'INC' }); // blobs may still be in flight
  await tick();
  await tick();
  await tick();
  assert.deepEqual(actors.slice(0, 10).map((a) => a.getSnapshot().context.n), Array(10).fill(1));
  assert.equal(actors.filter((a) => a.hibernated).length, 40);
  assert.equal(system.stats()[0].hibernated, 40);
});

test('hibernate: a background sweep unloads idle actors by itself', async () => {
  const system = createSystem({ hibernation: { store: createMemoryStore(), sweepMs: 20 } });
  const a = createActor(counter, { system }).start();
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(a.hibernated, true);
  a.send({ type: 'INC' });
  await tick();
  assert.equal(a.getSnapshot().context.n, 1);
});
