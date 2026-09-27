'use strict';

// Step 8: time (ROADMAP step 8; ADR 0007 point 3, core ADRs 0012 and 0054).
// Runs on Node and Bun.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createSystem, statechart } = require('..');

const stateOf = (actor) => actor.inspect().activeStates.at(-1);

// wait arms b (2×unit) then a (unit) on entry; wait --a--> one --b--> two.
// Reaching `two` means a fired before b.
function orderChart(unit) {
  return statechart({ family: 'order', revision: 'v1' })
    .state('wait', (s) => s
      .entry((a) => a.send('b', (m) => m.after(2 * unit).id('late')).send('a', (m) => m.after(unit)))
      .on('a', (t) => t.target('one')))
    .state('one', (s) => s.on('b', (t) => t.target('two')))
    .final('two');
}

// wait arms z (50ms, id "x"); wait --go/cancel x--> left --z--> bad.
const cancelChart = () => statechart({ family: 'cancel', revision: 'v1' })
  .state('wait', (s) => s
    .entry((a) => a.send('z', (m) => m.after(50).id('x')))
    .on('go', (t) => t.target('left').cancel('x')))
  .state('left', (s) => s.on('z', (t) => t.target('bad')))
  .state('bad');

// wait --go/send t after `delay`--> armed --t--> fired (final).
function idleChart(delay) {
  return statechart({ family: 'idle', revision: 'v1' })
    .state('wait', (s) => s.on('go', (t) => t.target('armed').send('t', (m) => m.after(delay))))
    .state('armed', (s) => s.on('t', (t) => t.target('fired')))
    .final('fired');
}

// Manual clock: nothing fires early, deadlines fire in order, and time never
// moves back. inspect() lists the pending sends.
async function manualOrder() {
  const system = createSystem({ clock: 'manual', initialTime: 1000, finished: 'retain' });
  assert.equal(system.clock, 'manual');
  assert.equal(system.time, 1000);
  const actor = system.spawn(system.define(orderChart(100)));
  await system.flush();
  const sends = actor.inspect().delayedSends;
  assert.deepEqual(sends.map(({ id, due, event, submitted }) => ({ id, due, event, submitted })), [
    { id: null, due: 1100, event: 'a', submitted: false },
    { id: 'late', due: 1200, event: 'b', submitted: false },
  ]);
  assert.equal(sends[0].destination, 'self', 'a send to self names the actor itself');
  assert.equal(actor.inspect().delayedSendCount, 2);

  await system.advanceBy(99);
  assert.equal(system.time, 1099);
  assert.equal(stateOf(actor), 'wait');
  // One step past both deadlines: they still fire in deadline order.
  await system.advanceTo(1300);
  assert.equal(actor.inspect().finalState, 'two');
  assert.deepEqual(actor.inspect().delayedSends, []);
  assert.throws(() => system.advanceTo(1299), { code: 'invalid' });
  system.close();
}

// A cancelled send never fires, under either clock.
async function cancelled() {
  const manual = createSystem({ clock: 'manual' });
  const first = manual.spawn(manual.define(cancelChart()));
  await manual.flush();
  first.post('go');
  await manual.flush();
  assert.deepEqual(first.inspect().delayedSends, []);
  await manual.advanceBy(1000);
  assert.equal(stateOf(first), 'left');
  manual.close();

  const realtime = createSystem();
  const second = realtime.spawn(realtime.define(cancelChart()));
  await realtime.flush();
  second.post('go');
  await realtime.flush();
  await new Promise((resolve) => setTimeout(resolve, 120));
  await realtime.flush();
  assert.equal(stateOf(second), 'left');
  realtime.close();
}

// Many sends due at once are dispatched at most dueBudget per turn, all of them eventually.
async function dueBudget() {
  const system = createSystem({ clock: 'manual', scheduling: { dueBudget: 3 } });
  const definition = system.define(idleChart(10));
  const actors = Array.from({ length: 20 }, () => system.spawn(definition));
  await system.flush();
  for (const actor of actors) {
    actor.post('go');
  }
  await system.flush();
  await system.advanceBy(10);
  assert.ok(actors.every((actor) => !system.exists(actor)), 'every send fired and every actor finished');
  assert.throws(() => createSystem({ scheduling: { dueBudget: 0 } }), { code: 'invalid' });
  assert.throws(() => createSystem({ clock: 'sundial' }), { code: 'invalid' });
  assert.throws(() => createSystem({ initialTime: -1 }), { code: 'invalid' });
  system.close();
}

// Realtime: sends fire from the native timer, in deadline order, with no
// flush() or post in between.
async function realtimeOrder() {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const system = createSystem({ done: (record) => resolveDone(record.finalState) });
  assert.equal(system.clock, 'realtime');
  system.spawn(system.define(orderChart(20)));
  assert.equal(await done, 'two');
  assert.throws(() => system.advanceTo(5), { code: 'invalid' });
  system.close();
}

// Realtime: after an idle period, the first message arms a send that fires
// no earlier than its delay, measured from that message (ADR 0007 point 3:
// core's time is set at the start of every turn, not only by the timer).
async function realtimeAfterIdle() {
  const delay = 100;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const system = createSystem({ done: () => resolveDone(performance.now()) });
  const actor = system.spawn(system.define(idleChart(delay)));
  await system.flush();
  await new Promise((resolve) => setTimeout(resolve, 300)); // idle: no turn, no timer
  const posted = performance.now();
  actor.post('go');
  await system.flush();
  const [send] = actor.inspect().delayedSends;
  assert.ok(send.due >= 300 + delay, `the deadline counts from the post (due ${send.due})`);
  const elapsed = (await done) - posted;
  // Core's time is whole milliseconds, so allow one millisecond of flooring.
  assert.ok(elapsed >= delay - 1, `fired ${elapsed.toFixed(1)}ms after the post, not before ${delay}ms`);
  system.close();
}

// An idle realtime system with a far-future send does not keep the process alive.
function idleExits() {
  const child = path.join(__dirname, 'fixtures', 'time_idle_child.js');
  const started = Date.now();
  const result = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, `the child exits cleanly: ${result.stderr}`);
  assert.match(result.stdout, /armed tick due 36000\d\d/);
  assert.ok(Date.now() - started < 15_000, 'the child did not wait for its timer');
}

(async () => {
  // A clock bug shows up as a system that never fires or never goes quiet: fail, don't hang.
  let current = 'start';
  const watchdog = setTimeout(() => {
    console.error(`time.js: ${current} did not finish in time`);
    process.exit(1);
  }, Number(process.env.TIME_TIMEOUT_MS ?? 60_000));
  for (const test of [manualOrder, cancelled, dueBudget, realtimeOrder, realtimeAfterIdle, idleExits]) {
    current = test.name;
    await test();
  }
  clearTimeout(watchdog);
  console.log('time.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
