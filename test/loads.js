'use strict';

// Loading unloaded actors when mail arrives for them (napi ADR 0020). Runs
// on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart, decodeTraces, formatTraceparent, TinyactorsError } = require('..');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// counter: logs every `hit`'s data, in order.
const counterChart = () => statechart({ family: 'counter', revision: 'v1' })
  .data('log', [])
  .state('idle', (s) => s.on('hit', (t) => t.assign('log', function ({ event }) { return [...this.log, event.data]; })));

// ticker: a arms `tick` (100 ms) on entry; a --tick--> b.
const tickChart = () => statechart({ family: 'ticker', revision: 'v1' })
  .state('a', (s) => s.entry((x) => x.send('tick', (m) => m.after(100))).on('tick', (t) => t.target('b')))
  .state('b');

const ONE = { family: 'counter', name: 'one' };

// A counter at ONE, unloaded; returns its image.
async function unloaded(system, definition = system.define(counterChart())) {
  const actor = system.spawn(definition, { name: 'one' });
  await system.flush();
  const image = actor.capture();
  actor.unload();
  return image;
}

const logOf = (system, address) => system.findActor(address).inspect().data.log;

// Mail waits while the loader runs, and is delivered in order after the
// load, ahead of mail sent to the actor directly; send() resolves then.
async function waitingMailInOrder() {
  const system = createSystem();
  const image = await unloaded(system);
  const calls = [];
  system.setLoader('counter', async (address, why) => {
    calls.push({ address, why });
    await tick(5);
    return image;
  });
  system.post(ONE, 'hit', 1);
  system.post(ONE, 'hit', 2);
  const sent = system.send(ONE, 'hit', 3);
  await system.flush();
  assert.deepEqual(calls, [{ address: ONE, why: 'mail' }], 'one load for the address');
  assert.deepEqual(logOf(system, ONE), [1, 2, 3]);
  const settled = await sent;
  assert.equal(settled.status, 'stable');
  // Resident again: no loader call.
  system.post(ONE, 'hit', 4);
  await system.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(logOf(system, ONE), [1, 2, 3, 4]);
  const loads = system.metrics().metrics.find((m) => m.name === 'tinyactors.loads');
  assert.equal(loads.points.find((p) => p.attributes['tinyactors.load.outcome'] === 'loaded').value, 1);
  const duration = system.metrics().metrics.find((m) => m.name === 'tinyactors.load.duration');
  assert.equal(duration.points[0].count, 1);
  image.destroy();
  system.close();
}

// A message that arrives while the load runs joins the same waiting mail.
async function secondMessageMidLoad() {
  const system = createSystem();
  const image = await unloaded(system);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  system.setLoader('counter', async () => {
    calls += 1;
    await gate;
    return image;
  });
  system.post(ONE, 'hit', 'a');
  await tick(5); // the turn ran, and the loader is waiting
  assert.equal(calls, 1);
  const waiting = system.metrics().metrics.find((m) => m.name === 'tinyactors.messages.waiting');
  assert.equal(waiting.points[0].value, 1);
  system.post(ONE, 'hit', 'b');
  await tick(5);
  assert.equal(calls, 1, 'still one load');
  release();
  await system.flush();
  assert.deepEqual(logOf(system, ONE), ['a', 'b']);
  image.destroy();
  system.close();
}

// Each failure dead-letters the waiting mail with its reason, and a
// rejection's reason or a thrown error arrives as the letter's detail.
async function failedLoads() {
  const cases = [
    ['not-found', () => 'not-found', 'not-found', undefined],
    ['reject', () => 'reject', 'rejected', undefined],
    ['{ reject }', () => ({ reject: 'shutting down' }), 'rejected', 'shutting down'],
    ['throws', () => { throw new Error('store unavailable'); }, 'load-failed', 'Error: store unavailable'],
    ['bad result', () => 42, 'load-failed', /returned something it cannot/],
  ];
  for (const [label, loader, reason, detail] of cases) {
    const dead = [];
    const system = createSystem({ deadLetter: (letter) => dead.push(letter) });
    const image = await unloaded(system);
    system.setLoader('counter', loader);
    system.post(ONE, 'hit', 1);
    const sent = system.send(ONE, 'hit', 2);
    await assert.rejects(sent, (error) => {
      assert.ok(error instanceof TinyactorsError, label);
      assert.equal(error.detail.reason, reason, label);
      return true;
    });
    await system.flush();
    assert.equal(dead.length, 2, label);
    for (const letter of dead) {
      assert.deepEqual(letter.target, ONE, label);
      assert.equal(letter.reason, reason, label);
      if (detail instanceof RegExp) {
        assert.match(letter.detail, detail, label);
      } else {
        assert.equal(letter.detail, detail, label);
      }
    }
    // The next message starts a new load.
    system.setLoader('counter', () => image);
    system.post(ONE, 'hit', 3);
    await system.flush();
    assert.deepEqual(logOf(system, ONE), [3], label);
    image.destroy();
    system.close();
  }
}

// Cancelling a send() whose message waits for a load withdraws the
// message, as for one still in a mailbox: it is not delivered after the
// load, and the other waiting mail still is, in order.
async function cancelWhileWaiting() {
  const system = createSystem();
  const image = await unloaded(system);
  let release;
  const loaded = new Promise((resolve) => { release = resolve; });
  system.setLoader('counter', async () => { await loaded; return image; });
  const controller = new AbortController();
  const first = system.send(ONE, 'hit', 'kept-1');
  const cancelled = system.send(ONE, 'hit', 'cancelled', { signal: controller.signal });
  const last = system.send(ONE, 'hit', 'kept-2');
  await tick(10); // not flush(): it waits for the load, which waits for us
  controller.abort();
  await assert.rejects(cancelled, (error) => error.code === 'aborted');
  assert.equal(system.metrics().metrics.find((m) => m.name === 'tinyactors.messages.waiting').points[0].value, 2,
               'the withdrawn message no longer waits');
  release();
  await Promise.all([first, last]);
  await system.flush();
  assert.deepEqual(logOf(system, ONE), ['kept-1', 'kept-2']);
  system.close();
}

// A slow loader within its timeout loads; one past it times out, and the
// image it returns later is destroyed.
async function slowAndTimedOutLoads() {
  let system = createSystem();
  let image = await unloaded(system);
  system.setLoader('counter', async () => { await tick(20); return image; }, { timeout: 1000 });
  system.post(ONE, 'hit', 'slow');
  await system.flush();
  assert.deepEqual(logOf(system, ONE), ['slow']);
  image.destroy();
  system.close();

  const dead = [];
  system = createSystem({ deadLetter: (letter) => dead.push(letter) });
  image = await unloaded(system);
  let late;
  system.setLoader('counter', async () => { await tick(60); late = image; return image; }, { timeout: 10 });
  system.post(ONE, 'hit', 'late');
  await system.flush();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].reason, 'load-timeout');
  assert.match(dead[0].detail, /did not settle within 10 ms/);
  await tick(80);
  assert.equal(late, image);
  assert.equal(image.destroyed, true, 'a result after the timeout is discarded');
  assert.equal(system.findActor(ONE), undefined, 'nothing was loaded');
  const loads = system.metrics().metrics.find((m) => m.name === 'tinyactors.loads');
  assert.equal(loads.points.find((p) => p.attributes['tinyactors.load.outcome'] === 'timed_out').value, 1);
  system.close();
}

// At most maxWaiting messages wait; the rest are dead letters.
async function waitingFull() {
  const dead = [];
  const system = createSystem({ deadLetter: (letter) => dead.push(letter) });
  const image = await unloaded(system);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  system.setLoader('counter', async () => { await gate; return image; }, { maxWaiting: 2 });
  for (let n = 1; n <= 4; n += 1) {
    system.post(ONE, 'hit', n);
  }
  await tick(5);
  release();
  await system.flush();
  assert.deepEqual(logOf(system, ONE), [1, 2]);
  assert.deepEqual(dead.map((letter) => letter.reason), ['waiting-full', 'waiting-full']);
  image.destroy();
  system.close();
}

// A virtual family: a name that has never existed calls the loader, which
// builds the actor from data the application stored ({ spawn, binding }).
async function virtualFamily() {
  const system = createSystem();
  const counter = system.define(counterChart());
  const stored = new Map([['fresh', { log: ['from storage'] }]]);
  system.setLoader('counter', (address) =>
    stored.has(address.name) ? { spawn: counter, binding: stored.get(address.name) } : 'not-found');
  const fresh = { family: 'counter', name: 'fresh' };
  system.post(fresh, 'hit', 'x');
  await system.flush();
  assert.deepEqual(logOf(system, fresh), ['from storage', 'x']);
  system.close();
}

// An unloaded actor's own delayed send wakes it through its loader.
async function timerWakesAnUnloadedActor() {
  const system = createSystem({ clock: 'manual', initialTime: 0 });
  const actor = system.spawn(system.define(tickChart()), { name: 'one' });
  await system.flush();
  const image = actor.capture();
  actor.unload();
  const whys = [];
  system.setLoader('ticker', (address, why) => { whys.push(why); return image; });
  await system.advanceTo(50);
  await system.flush();
  assert.deepEqual(whys, [], 'not before its time');
  await system.advanceTo(150);
  await system.flush();
  assert.deepEqual(whys, ['timer']);
  const loaded = system.findActor({ family: 'ticker', name: 'one' });
  assert.equal(loaded.inspect().activeStates.at(-1), 'b', 'the timer fired after the load');
  // removeUnloaded() forgets the wake-up.
  const again = loaded.capture();
  loaded.unload();
  system.removeUnloaded({ family: 'ticker', name: 'one' });
  await system.advanceTo(1000);
  await system.flush();
  assert.deepEqual(whys, ['timer'], 'a removed actor does not wake');
  again.destroy();
  image.destroy();
  system.close();
}

// A graceful restart within one process: every named actor is unloaded,
// loaders say "not now" and the refused mail goes to an outbox; then the
// loaders load again, the outbox is replayed in order, and nothing is lost.
// The second round rebuilds the actors from their data ({ spawn, binding }),
// as an application that stored its data model would after a process exit.
async function gracefulRestart() {
  const outbox = [];
  const system = createSystem({
    deadLetter: (letter) => { if (letter.reason === 'rejected') outbox.push(letter); },
  });
  const counter = system.define(counterChart());
  const names = ['a', 'b', 'c'];
  for (const name of names) {
    system.spawn(counter, { name }).post('hit', `${name}0`);
  }
  await system.flush();

  // Drain and unload: images kept in process memory, data kept as the
  // application would store it.
  const images = new Map();
  const data = new Map();
  system.setLoader('counter', () => ({ reject: 'restarting' }));
  for (const name of names) {
    const actor = system.findActor({ family: 'counter', name });
    const image = actor.capture();
    data.set(name, structuredClone(actor.inspect().data));
    actor.unload();
    images.set(name, image);
  }
  // Mail during the restart is refused into the outbox, each letter with
  // its data and, when it had one, its traceparent.
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  for (const name of names) {
    system.post({ family: 'counter', name }, 'hit', `${name}1`);
    system.post({ family: 'counter', name }, 'hit', `${name}2`, { traceparent });
  }
  await system.flush();
  assert.equal(outbox.length, 6);
  assert.ok(outbox.every((letter) => letter.detail === 'restarting'));
  assert.deepEqual(outbox.map((letter) => letter.data), ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);
  assert.deepEqual(outbox.map((letter) => letter.traceparent),
                   [undefined, traceparent, undefined, traceparent, undefined, traceparent]);

  // Load again, and replay the outbox in its order, as it was posted.
  system.setLoader('counter', (address) => images.get(address.name));
  for (const letter of outbox.splice(0)) {
    system.post(letter.target, letter.event, letter.data,
                letter.traceparent === undefined ? undefined : { traceparent: letter.traceparent });
  }
  await system.flush();
  for (const name of names) {
    assert.deepEqual(logOf(system, { family: 'counter', name }), [`${name}0`, `${name}1`, `${name}2`]);
    images.get(name).destroy();
  }

  // Rebuild from the application's data instead of images.
  for (const name of names) {
    const actor = system.findActor({ family: 'counter', name });
    data.set(name, structuredClone(actor.inspect().data));
    actor.destroy();
  }
  system.setLoader('counter', (address) => ({ spawn: counter, binding: data.get(address.name) }));
  for (const name of names) {
    system.post({ family: 'counter', name }, 'hit', `${name}3`);
  }
  await system.flush();
  for (const name of names) {
    assert.deepEqual(logOf(system, { family: 'counter', name }), [`${name}0`, `${name}1`, `${name}2`, `${name}3`]);
  }
  system.close();
}

// The load, and the macrostep of the mail that caused it, are in the
// sender's trace.
async function loadInTheSendersTrace() {
  const system = createSystem();
  const batches = [];
  system.setTraceSink((bytes) => batches.push(bytes), { detail: 'full' });
  const image = await unloaded(system);
  system.setLoader('counter', () => image);
  const traceID = '4bf92f3577b34da6a3ce929d0e0e4736';
  system.post(ONE, 'hit', 1, { traceparent: formatTraceparent({ traceID, spanID: '00f067aa0ba902b7' }) });
  await system.flush();
  const spans = batches.flatMap((bytes) => decodeTraces(bytes));
  const loaded = spans.filter((span) => span.name === 'scxml.loaded');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].traceID, traceID, 'the LOADED span is in the sender\'s trace');
  const macrostep = spans.find((span) => span.name.startsWith('scxml.macrostep hit'));
  assert.equal(macrostep.traceID, traceID);
  image.destroy();
  system.close();
}

// setLoader() checks its arguments; null removes the loader.
async function arguments_() {
  const dead = [];
  const system = createSystem({ deadLetter: (letter) => dead.push(letter) });
  assert.throws(() => system.setLoader('', () => {}), TinyactorsError);
  assert.throws(() => system.setLoader('counter', 42), TinyactorsError);
  assert.throws(() => system.setLoader('counter', () => {}, { timeout: 0 }), TinyactorsError);
  assert.throws(() => system.setLoader('counter', () => {}, { maxWaiting: 1.5 }), TinyactorsError);
  const image = await unloaded(system);
  system.setLoader('counter', () => image);
  system.setLoader('counter', null);
  system.post(ONE, 'hit', 1);
  await system.flush();
  assert.deepEqual(dead, [], 'no loader: the offloaded actor comes back from its bytes (core ADR 0074)');
  assert.deepEqual(logOf(system, ONE), [1]);
  image.destroy();
  system.close();
}

(async () => {
  await waitingMailInOrder();
  await secondMessageMidLoad();
  await failedLoads();
  await cancelWhileWaiting();
  await slowAndTimedOutLoads();
  await waitingFull();
  await virtualFamily();
  await timerWakesAnUnloadedActor();
  await gracefulRestart();
  await loadInTheSendersTrace();
  await arguments_();
  console.log('loads.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
