'use strict';

// Step 6: post events through mailboxes (ROADMAP step 6; ADRs 0004, 0005,
// 0008, 0014). Runs on Node and Bun.

const assert = require('node:assert/strict');
const native = require('../lib/native');
const { nativeOf } = require('../lib/system');
const { createSystem, statechart, TinyactorsError } = require('..');

function assertCode(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.code, code, error.message);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return true;
  });
}

// a --x--> b --y--> c --z--> end (a top-level final).
const steps = (family = 'steps') =>
  statechart({ family, revision: 'v1' })
    .state('a', (s) => s.on('x', (t) => t.target('b')))
    .state('b', (s) => s.on('y', (t) => t.target('c')))
    .state('c', (s) => s.on('z', (t) => t.target('end')))
    .final('end');

const stateOf = (actor) => actor.inspect().activeStates.at(-1);

// Per-target FIFO holds when a turn stops at its message budget.
async function fifoAcrossTheBudget() {
  const system = createSystem({ scheduling: { messageBudget: 2 } });
  const definition = system.define(steps());
  const actors = Array.from({ length: 20 }, () => system.spawn(definition));
  await system.flush();
  for (const actor of actors) {
    actor.post('x');
    actor.post('y');
    assert.equal(actor.inspect().scheduling, 'ready');
  }
  assert.equal(system.stats().messages.queued, 40);
  await system.flush();
  for (const actor of actors) {
    assert.equal(stateOf(actor), 'c');
  }
  assert.deepEqual(system.stats().messages, { queued: 0, delivered: 40, deadLetters: 0 });
  system.close();
}

// Nothing runs inside post(); mail posted before bootstrap waits for it.
async function mailBeforeBootstrap() {
  const faults = [];
  const system = createSystem({ fault: (record) => faults.push(record) });
  const actor = system.spawn(system.define(steps()));
  actor.post('x');
  assert.equal(actor.inspect().scheduling, 'runnable', 'post only collects mail');
  assert.deepEqual(actor.inspect().activeStates, [], 'nothing ran inside post()');
  await system.flush();
  assert.equal(stateOf(actor), 'b');
  assert.equal(faults.length, 0, 'no TA_ERR_BUSY, no fault');
  system.close();
}

// A stale ID's mail is a dead letter and never reaches the slot's next actor.
async function staleIDs() {
  const dead = [];
  const system = createSystem({ deadLetter: (record) => dead.push(record) });
  const definition = system.define(steps());
  const old = system.spawn(definition);
  await system.flush();
  old.destroy();
  const next = system.spawn(definition);
  assert.equal(next.slot, old.slot, 'the slot is reused');
  await system.flush();
  old.post('x');
  await system.flush();
  assert.equal(stateOf(next), 'a', 'the new actor got nothing');
  assert.equal(dead.length, 1);
  assert.ok(dead[0].target.equals(old));
  assert.equal(dead[0].event, 'x');
  assert.equal(dead[0].reason, 'not-found');
  system.close();
}

// A delivery core refuses faults that actor only; a quarantined actor with an
// empty mailbox stays out of scheduling when mail arrives; release() brings it
// back. JavaScript cannot post a malformed event, so the test posts an event
// name core never issued through the native method.
async function faultsQuarantineAndRelease() {
  const faults = [];
  const dead = [];
  const system = createSystem({
    fault: (record) => faults.push(record),
    deadLetter: (record) => dead.push(record),
  });
  const definition = system.define(steps());
  const bad = system.spawn(definition);
  const good = system.spawn(definition);
  await system.flush();
  nativeOf(system).post(bad.slot, bad.generation, 0x7fffffff);
  good.post('x');
  await system.flush();
  assert.equal(faults.length, 1);
  assert.ok(faults[0].actor.equals(bad));
  assert.equal(faults[0].operation, 'deliver');
  assert.equal(faults[0].code, 'invalid');
  assert.deepEqual(dead.map((record) => record.reason), ['refused'], 'the refused message, not the mailbox');
  assert.equal(stateOf(good), 'b', 'the other actor ran');
  assert.equal(bad.inspect().scheduling, 'quarantined');

  bad.post('x'); // an empty mailbox gets mail: the actor stays out
  await system.flush();
  assert.equal(bad.inspect().scheduling, 'quarantined');
  assert.equal(stateOf(bad), 'a');
  system.release(bad);
  await system.flush();
  assert.equal(stateOf(bad), 'b');
  assert.equal(bad.inspect().scheduling, 'idle');
  assert.equal(faults.length, 1);
  system.close();
}

// Mail for a finished or destroyed actor becomes a dead letter; without a
// hook, dead letters are still counted.
async function finishedAndDestroyedTargets() {
  const dead = [];
  const system = createSystem({ finished: 'retain', deadLetter: (record) => dead.push(record) });
  const definition = system.define(steps());
  const actor = system.spawn(definition);
  actor.post('x');
  actor.post('y');
  actor.post('z');
  actor.post('x'); // after the final state
  await system.flush();
  assert.equal(actor.inspect().finalState, 'end');
  actor.post('y');
  await system.flush();
  assert.deepEqual(dead.map((record) => [record.event, record.reason]), [['x', 'done'], ['y', 'done']]);

  const other = system.spawn(definition);
  await system.flush();
  other.post('x');
  other.post('y');
  other.destroy();
  await system.flush();
  assert.deepEqual(dead.slice(2).map((record) => [record.event, record.reason]), [['x', 'destroyed'], ['y', 'destroyed']]);
  system.close();

  const quiet = createSystem();
  const gone = quiet.spawn(quiet.define(steps()));
  await quiet.flush();
  gone.destroy();
  gone.post('x');
  await quiet.flush();
  assert.equal(quiet.stats().messages.deadLetters, 1, 'counted without a hook');
  quiet.close();
}

// maxQueuedMessages refuses new mail with queue-full; accepted mail is kept.
async function backpressure() {
  const system = createSystem({ scheduling: { maxQueuedMessages: 2 } });
  const actor = system.spawn(system.define(steps()));
  await system.flush();
  actor.post('x');
  actor.post('y');
  assertCode(() => actor.post('z'), 'queue-full');
  await system.flush();
  assert.equal(stateOf(actor), 'c', 'both accepted messages were delivered');
  actor.post('z');
  await system.flush();
  system.close();
}

// A name seen before does no string work: one native intern per name.
async function namesAreInternedOnce() {
  const system = createSystem();
  const proto = native.System.prototype;
  const intern = proto.internEvent;
  let calls = 0;
  proto.internEvent = function internEvent(...args) {
    calls += 1;
    return intern.apply(this, args);
  };
  try {
    const actor = system.spawn(system.define(statechart({ family: 'loop', revision: 'v1' }).state('idle', (s) => s.on('tick', (t) => t.target('idle')))));
    for (let index = 0; index < 100; index += 1) {
      actor.post('tick');
    }
    actor.post('other.name');
    assert.equal(calls, 2);
    await system.flush();
  } finally {
    proto.internEvent = intern;
  }
  const target = system.spawn(system.define(steps('bad-names')));
  assertCode(() => target.post('a..b'), 'invalid', /event name/);
  assertCode(() => target.post(''), 'invalid', /event name/);
  assertCode(() => target.post(42), 'invalid');
  system.close();
}

// After warm-up, posting and delivering without data makes no allocator call
// in the addon (ADR 0014).
async function steadyState() {
  const system = createSystem();
  const definition = system.define(statechart({ family: 'ping', revision: 'v1' }).state('idle', (s) => s.on('ping', (t) => t.target('idle'))));
  const actors = Array.from({ length: 500 }, () => system.spawn(definition));
  const addonCalls = () => {
    const { memory } = system.stats();
    let calls = 0;
    for (const [category, counters] of Object.entries(memory)) {
      if (category !== 'total' && category !== 'core') {
        calls += counters.allocations + counters.frees;
      }
    }
    return calls;
  };
  for (let round = 0; round < 3; round += 1) {
    await system.flush();
    for (const actor of actors) {
      actor.post('ping');
    }
  }
  await system.flush();
  const before = addonCalls();
  for (let round = 0; round < 5; round += 1) {
    for (const actor of actors) {
      actor.post('ping');
    }
    await system.flush();
  }
  assert.equal(addonCalls(), before, 'no allocator call in the addon');
  system.close();
}

// Event data is a value box while it waits (ADR 0011): delivery, a dead
// letter and close() each give it back.
async function dataIsReleased() {
  const live = () => native.environmentStats().valuesLive;
  const before = live();
  // Retained, so a finished actor keeps its data root, which is a box too.
  const system = createSystem({ finished: 'retain' });
  const actor = system.spawn(system.define(steps('data')));
  const gone = system.spawn(system.define(steps('data-gone')));
  const waiting = system.spawn(system.define(steps('data-waiting')));
  gone.destroy();
  const start = live();
  actor.post('x', { some: 'data' });
  actor.post('y', 'text');
  actor.post('z', 42);
  assert.equal(live(), start + 2, 'an object and a string are boxed; a number rides inline');
  await system.flush();
  assert.equal(live(), start, 'delivered data is released');
  gone.post('x', { lost: true });
  system.post({ family: 'nobody', name: 'here' }, 'x', ['lost']);
  await system.flush();
  assert.equal(live(), start, 'dead letters release their data');
  waiting.post('x', { waiting: true });
  assert.equal(live(), start + 1);
  system.close();
  assert.equal(live(), before, 'close releases queued data');
}

// Malformed targets.
async function refusals() {
  const system = createSystem();
  const actor = system.spawn(system.define(steps()));
  assertCode(() => system.post({ family: 'steps', name: '' }, 'x'), 'invalid');
  assertCode(() => system.post({ family: 1, name: 'n' }, 'x'), 'invalid');
  assertCode(() => system.post({}, 'x'), 'invalid');
  const other = createSystem();
  assertCode(() => other.post(actor, 'x'), 'invalid');
  other.close();
  const controller = new AbortController();
  controller.abort();
  assertCode(() => actor.post('x', undefined, { signal: controller.signal }), 'aborted');
  assertCode(() => createSystem({ scheduling: { messageBudget: 0 } }), 'invalid');
  system.close();
  assertCode(() => actor.post('x'), 'closed');
}

(async () => {
  await fifoAcrossTheBudget();
  await mailBeforeBootstrap();
  await dataIsReleased();
  await staleIDs();
  await faultsQuarantineAndRelease();
  await finishedAndDestroyedTargets();
  await backpressure();
  await namesAreInternedOnce();
  await steadyState();
  await refusals();
  console.log('post.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
