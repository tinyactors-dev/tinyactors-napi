'use strict';

// Step 14: persistence and replacement (ROADMAP step 14; core ADRs 0013,
// 0014, 0038, 0043, 0051, 0052, 0066). Runs on Node and Bun.

const assert = require('node:assert/strict');
const native = require('../lib/native');
const { createSystem, statechart, TinyactorsError } = require('..');

const stateOf = (actor) => actor.inspect().activeStates.at(-1);

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

// a arms `tick` (100 ms) on entry; a --tick--> b.
const tickChart = () => statechart({ family: 'ticker', revision: 'v1' })
  .state('a', (s) => s.entry((x) => x.send('tick', (m) => m.after(100))).on('tick', (t) => t.target('b')))
  .state('b');

// An actor with a pending delayed send round-trips through capture, unload
// and load: same session ID, new runtime ID, and the send fires after load.
async function roundTrip() {
  const dead = [];
  const system = createSystem({ clock: 'manual', initialTime: 0, deadLetter: (record) => dead.push(record) });
  const actor = system.spawn(system.define(tickChart()), { name: 'one' });
  await system.flush();
  const before = actor.inspect();
  assert.equal(before.delayedSends.length, 1);

  const image = actor.capture();
  assert.equal(image.sessionID, before.sessionID);
  assert.deepEqual(image.address, { family: 'ticker', name: 'one' });
  assert.equal(image.nextDeadline, 100);
  assert.equal(image.definition.family, 'ticker');
  assert.ok(image.actor.equals(actor));

  actor.unload();
  assert.equal(actor.destroyed, true, 'the runtime ID is stale once unloaded');
  assertCode(() => actor.inspect(), 'not-found');
  assert.equal(system.findActor({ family: 'ticker', name: 'one' }), undefined);

  // Its own delayed send, due while it is offloaded, loads it back from its
  // bytes (core ADR 0074), with no loader, and fires.
  await system.advanceTo(150);
  await system.flush();
  assert.equal(dead.length, 0);
  const loaded = system.findActor({ family: 'ticker', name: 'one' });
  assert.ok(loaded !== undefined && !loaded.equals(actor), 'a new runtime ID');
  assert.equal(loaded.inspect().sessionID, before.sessionID, 'the session ID outlives residency');
  assert.equal(stateOf(loaded), 'b', 'the delayed send fired after load');

  // Mail loads an offloaded actor back, too.
  loaded.unload();
  system.post({ family: 'ticker', name: 'one' }, 'hello');
  await system.flush();
  assert.equal(dead.length, 0);
  assert.equal(stateOf(system.findActor({ family: 'ticker', name: 'one' })), 'b');

  image.destroy();
  image.destroy(); // idempotent
  assert.equal(image.destroyed, true);
  assertCode(() => system.load(image), 'invalid');
  system.close();
}

// unload() refuses an actor with mail waiting, so it never drops accepted
// mail, and an anonymous actor, which has no address to come back to.
// removeUnloaded() drops the offloaded bytes and the address.
async function unloadGuards() {
  const system = createSystem({ clock: 'manual' });
  const definition = system.define(tickChart());
  const actor = system.spawn(definition, { name: 'guarded' });
  await system.flush();
  actor.post('nothing');
  assertCode(() => actor.unload(), 'busy');
  await system.flush();
  const anonymous = system.spawn(definition);
  await system.flush();
  assertCode(() => anonymous.unload(), 'invalid');
  const image = actor.capture();
  actor.unload();
  const address = { family: 'ticker', name: 'guarded' };
  system.removeUnloaded(address);
  assertCode(() => system.load(address), 'not-found'); // the bytes went with the address
  assertCode(() => system.load(image), 'stale'); // its address was released, so the claim no longer matches
  image.destroy();
  system.close();
}

// The JavaScript data root travels with the image: load binds the root the
// actor had at capture, unless another binding is passed.
async function dataTravels() {
  const system = createSystem();
  const definition = system.define(
    statechart({ family: 'counter', revision: 'v1' })
      .data('count', 0)
      .state('idle', (s) => s.on('inc', (t) => t.assign('count', ({ data }) => data.count + 1))),
  );
  const actor = system.spawn(definition, { name: 'c' });
  actor.post('inc');
  actor.post('inc');
  await system.flush();
  const image = actor.capture();
  assert.equal(image.data.count, 2);
  actor.unload();
  const loaded = system.load(image);
  loaded.post('inc');
  await system.flush();
  assert.equal(loaded.inspect().data.count, 3);
  assert.equal(loaded.inspect().data, image.data, 'the same root object');

  const copy = system.reconstruct(image, { binding: { count: 100 } });
  await system.flush();
  assert.equal(copy.inspect().data.count, 100);
  image.destroy();
  system.close();
}

// A delayed send to `#_scxml_<sessionID>`, armed before the receiver is
// unloaded, reaches it after it is loaded again (core ADR 0066).
async function sessionTargetAcrossUnload() {
  const system = createSystem({ clock: 'manual', initialTime: 0, finished: 'retain' });
  const receiver = system.spawn(
    system.define(statechart({ family: 'rx', revision: 'v1' }).state('wait', (s) => s.on('ping', (t) => t.target('got'))).final('got')),
    { name: 'r' },
  );
  await system.flush();
  const session = receiver.inspect().sessionID;
  const sender = system.spawn(system.define(
    statechart({ family: 'tx', revision: 'v1' })
      .state('armed', (s) => s.entry((x) => x.send('ping', (m) => m.to(`#_scxml_${session}`).after(100)))),
  ));
  await system.flush();
  assert.equal(sender.inspect().delayedSends.length, 1);

  await system.advanceTo(10);
  const image = receiver.capture();
  receiver.unload();
  await system.advanceTo(50);
  const loaded = system.load(image);
  await system.flush();
  assert.equal(stateOf(loaded), 'wait');
  await system.advanceTo(150);
  assert.equal(loaded.inspect().finalState, 'got', 'the send reached the reloaded session');
  image.destroy();
  system.close();
}

// A named actor is replaced in place with no lost messages: mail accepted
// for the address before activation, including a send() in flight, reaches
// the replacement; later mail follows the address.
async function replacementLosesNothing() {
  const system = createSystem();
  const v1 = system.define(
    statechart({ family: 'worker', revision: 'v1' })
      .data('seen', 0)
      .state('idle', (s) => s.on('job', (t) => t.assign('seen', ({ data }) => data.seen + 1))),
  );
  const v2 = system.define(
    statechart({ family: 'worker', revision: 'v2' })
      .data('seen', 0)
      .data('v2', 0)
      .state('idle', (s) => s.on('job', (t) => t
        .assign('seen', ({ data }) => data.seen + 1)
        .assign('v2', ({ data }) => data.v2 + 1))),
  );
  const address = { family: 'worker', name: 'w' };
  const incumbent = system.spawn(v1, { name: 'w' });
  system.post(address, 'job');
  await system.flush();
  assert.equal(incumbent.inspect().data.seen, 1);

  const prepared = incumbent.prepareReplacement(v2);
  await system.flush(); // the replacement bootstraps unpublished
  assert.equal(prepared.published, false);
  assert.ok(system.findActor(address).equals(incumbent), 'the address stays with the incumbent');

  // Accepted for the address before activation: they wait in the incumbent's mailbox.
  system.post(address, 'job');
  system.post(address, 'job');
  const inflight = system.send(address, 'job');
  const replacement = prepared.activate();
  system.post(address, 'job');

  assert.equal(incumbent.destroyed, true);
  assert.ok(system.findActor(address).equals(replacement));
  const result = await inflight;
  assert.equal(result.status, 'stable');
  assert.ok(result.actor.equals(replacement), 'the send() settled on the replacement');
  await system.flush();
  const data = replacement.inspect().data;
  assert.equal(data.seen, 5, 'the incumbent root carried over, and no job was lost');
  assert.equal(data.v2, 4, 'the replacement handled the four later jobs');
  assert.equal(system.stats().messages.deadLetters, 0);
  system.close();
}

// activate() waits for an incumbent that is inside a macrostep.
async function activateWhileBusy() {
  const system = createSystem({ scheduling: { actionBudget: 1 } });
  // a --go--> b, whose entry handler is ten actions: with an action budget of
  // 1 its macrostep spans several turns.
  const chart = (revision) => statechart({ family: 'slow', revision })
    .state('a', (s) => s.on('go', (t) => t.target('b')))
    .state('b', (s) => s.entry((x) => { for (let i = 0; i < 10; i += 1) x.log(`step${i}`); }));
  const incumbent = system.spawn(system.define(chart('v1')), { name: 's' });
  await system.flush();
  const prepared = incumbent.prepareReplacement(system.define(chart('v2')));
  await system.flush();
  incumbent.post('go');
  await new Promise((resolve) => setImmediate(resolve)); // one pump turn: go is delivered
  assert.equal(incumbent.inspect().scheduling, 'runnable');
  assertCode(() => prepared.activate(), 'busy');
  assert.ok(system.findActor({ family: 'slow', name: 's' }).equals(incumbent), 'nothing changed');
  await system.flush();
  const replacement = prepared.activate();
  assert.equal(replacement.inspect().published, true);
  system.close();
}

// An invocation that was active at capture does not come back: the loaded
// actor gets error.communication.invoke.<id>.unavailable (core ADR 0038).
async function invocationsAcrossLoad() {
  let started = 0;
  const system = createSystem({
    invokers: { svc: { start() { started += 1; return { cancel() {} }; } } },
  });
  const actor = system.spawn(system.define(
    statechart({ family: 'inv', revision: 'v1' })
      .state('using', (s) => s
        .invoke((i) => i.type('svc').id('job'))
        .on('error.communication', (t) => t.target('lost')))
      .state('lost'),
  ), { name: 'i' });
  await system.flush();
  assert.equal(started, 1);
  const image = actor.capture();
  actor.unload();
  const loaded = system.load(image);
  await system.flush();
  assert.equal(stateOf(loaded), 'lost');
  image.destroy();
  system.close();
}

// Images still alive in JavaScript when the system closes leak nothing, and
// read as destroyed.
async function closeWithImages() {
  const system = createSystem();
  const definition = system.define(
    statechart({ family: 'kept', revision: 'v1' })
      .data('payload', null)
      .state('idle', (s) => s.on('set', (t) => t.assign('payload', ({ event }) => event.data))),
  );
  const images = [];
  for (let index = 0; index < 5; index += 1) {
    const actor = system.spawn(definition);
    actor.post('set', { index, text: 'x'.repeat(100) });
    await system.flush();
    actor.post('set', { index }); // queued events travel in the image too
    images.push(actor.capture());
  }
  system.close();
  for (const image of images) {
    assert.equal(image.destroyed, true);
    image.destroy(); // harmless after close
  }
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error('persist.js: timed out');
    process.exit(1);
  }, 30000);
  await roundTrip();
  await unloadGuards();
  await dataTravels();
  await sessionTargetAcrossUnload();
  await replacementLosesNothing();
  await activateWhileBusy();
  await invocationsAcrossLoad();
  await closeWithImages();
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
  const stats = native.environmentStats();
  assert.equal(stats.leakedBytes, 0, 'every system closed without leaking');
  assert.equal(stats.valuesLive, 0, 'no value box outlived its system');
  clearTimeout(watchdog);
  console.log('persist.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
