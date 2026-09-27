'use strict';

// Operating one actor (ADR 0026; core ADRs 0082, 0083, 0084): the mailbox,
// operator transitions in post() and send(), abandoning a macrostep,
// withdrawing a delayed send, and what inspect() and definitions() report.
// Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart, TinyactorsError } = require('..');

const watchdog = setTimeout(() => {
  console.error('operate.js: timed out');
  process.exit(1);
}, 30000);

async function assertRejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function assertThrows(fn, code) {
  assert.throws(fn, (error) => error instanceof TinyactorsError && error.code === code);
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

// a --hook--> b --hook--> a, counting; `spin` starts a macrostep that never
// ends; `arm` sets a delayed send; c and d are only reached by jumps.
const chart = () =>
  statechart({ family: 'account', revision: 'v1' })
    .data('hooks', 0)
    .data('entered', [])
    .state('a', (s) =>
      s
        .on('hook', (t) => t.target('b').assign('hooks', function () { return this.hooks + 1; }))
        .on('spin', (t) => t.target('loop1'))
        .on('arm', (t) => t.send('remind', (send) => send.id('reminder').after('10s'))))
    .state('b', (s) => s.on('hook', (t) => t.target('a').assign('hooks', function () { return this.hooks + 1; })))
    .state('c', (s) => s.entry((e) => e.script(function ({ event }) { this.entered.push(event.name); })))
    .state('d')
    .state('loop1', (s) =>
      s.entry((e) => e.script(function () { this.spins = (this.spins ?? 0) + 1; }).script(function () {}))
        .always((t) => t.target('loop2')))
    .state('loop2', (s) => s.always((t) => t.target('loop1')));

// Operator transitions queue behind real mail; a refused one is a dead
// letter and the actor is not quarantined.
async function transitions() {
  const deadLetters = [];
  const system = createSystem({ clock: 'manual', deadLetter: (record) => deadLetters.push(record) });
  const actor = system.spawn(system.define(chart()));
  await system.flush();
  actor.post('hook', { attempt: 1 });
  const jumped = actor.send('operator.goto', { by: 'test' }, { transition: { targets: ['c'] } });
  // The mailbox, before the pump takes it: oldest first, at most `limit`.
  assert.deepEqual(system.mailbox(actor).map((message) => message.event), ['hook', 'operator.goto']);
  assert.deepEqual(system.mailbox(actor, { limit: 1 }).map((message) => message.data), [{ attempt: 1 }]);
  assertThrows(() => system.mailbox(actor, { limit: -1 }), 'invalid');
  const [queued] = system.mailbox(actor).slice(-1);
  assert.deepEqual(queued.transition, { source: null, targets: ['c'] });
  assert.equal(queued.awaited, true);
  assert.equal((await jumped).status, 'stable');
  assert.deepEqual(actor.inspect().activeStates, ['c']);
  assert.deepEqual(actor.inspect().data.entered, ['operator.goto'], 'onentry sees the operator event');

  // From b, but the actor is in c by the time it arrives: refused.
  await assertRejects(actor.send('operator.goto', undefined, { transition: { targets: ['d'], source: 'b' } }), 'invalid');
  assert.equal(actor.inspect().scheduling, 'idle', 'not quarantined');
  assert.deepEqual(actor.inspect().activeStates, ['c']);
  assert.equal(deadLetters.at(-1).reason, 'refused');

  assertThrows(() => actor.post('operator.goto', undefined, { transition: { targets: ['nowhere'] } }), 'invalid');
  assertThrows(() => actor.post('operator.goto', undefined, { transition: { targets: [] } }), 'invalid');
  assertThrows(() => system.post({ family: 'account', name: 'x' }, 'operator.goto', undefined,
                                 { transition: { targets: ['c'] } }), 'invalid');
  system.close();
}

// Abandoning a macrostep that never ends: the send() rejects with
// `abandoned`, and the actor takes its next message.
async function abandoning() {
  const system = createSystem({ clock: 'manual' });
  const actor = system.spawn(system.define(chart()));
  await system.flush();
  const runaway = actor.send('spin');
  actor.post('operator.goto', undefined, { transition: { targets: ['d'] } });
  let view;
  for (let index = 0; index < 20; index += 1) {
    await turn();
    view = actor.inspect();
    if (view.step.microstep > 0) break;
  }
  assert.equal(view.macrostepInProgress, true);
  assert.ok(view.step.macrostep > 0 && view.step.microstep > 0, 'inspection names the step');
  assert.equal(view.position.at, 'none', 'the system\'s budgets pause it between microsteps');
  system.abandon(actor);
  await assertRejects(runaway, 'abandoned');
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['d'], 'the next message, a jump, was taken');
  assertThrows(() => system.abandon(actor), 'invalid');
  system.close();

  // Inside a microstep core refuses (core ADR 0082): an action budget of 1
  // pauses this loop inside its microsteps.
  const tight = createSystem({ clock: 'manual', scheduling: { actionBudget: 1 } });
  const spinner = tight.spawn(tight.define(chart()));
  await tight.flush();
  spinner.post('spin');
  for (let index = 0; index < 20 && !spinner.inspect().microstepInProgress; index += 1) await turn();
  view = spinner.inspect();
  assert.equal(view.microstepInProgress, true);
  assert.equal(view.position.at, 'enter');
  assert.equal(view.position.state, 'loop1');
  assertThrows(() => tight.abandon(spinner), 'busy');
  tight.close();
}

// Withdrawing one delayed send by the ID inspection shows.
async function withdrawing() {
  const system = createSystem({ clock: 'manual' });
  const actor = system.spawn(system.define(chart()));
  await system.flush();
  actor.post('arm');
  await system.flush();
  const [send] = actor.inspect().delayedSends;
  assert.equal(send.id, 'reminder');
  system.withdrawSend(actor, send.id);
  assert.equal(actor.inspect().delayedSendCount, 0);
  assertThrows(() => system.withdrawSend(actor, 'reminder'), 'not-found');
  assertThrows(() => system.withdrawSend(actor, ''), 'invalid');
  system.close();
}

// What inspect() and definitions() report for a debugger.
async function inspection() {
  const system = createSystem({ clock: 'manual', scheduling: { resumeBudget: 1 } });
  const definition = system.define(chart());
  const actor = system.spawn(definition, { name: 'acct' });
  await system.flush();
  let view = actor.inspect();
  assert.equal(view.step.macrostep, 0);
  assert.equal(view.position.at, 'none');
  assert.equal(view.currentEvent, null);
  assert.deepEqual(view.invocations, []);
  const scope = (system.registerIO('debug', { send() {} }), system.openScope('debug', 'debug://test'));
  actor.post('hook', { n: 1 }, { origin: { type: 'debug', scope } });
  await turn();
  view = actor.inspect();
  assert.equal(view.currentEvent.name, 'hook');
  assert.deepEqual(view.currentEvent.origin,
                   { kind: 'io', scope: { index: scope.index, generation: scope.generation }, type: 'debug', uri: 'debug://test' });
  assert.deepEqual(view.currentEvent.data, { n: 1 });
  await system.flush();
  const [inspected] = system.definitions();
  assert.deepEqual(inspected.identity, { family: 'account', revision: 'v1' });
  assert.equal(inspected.stateCount, 6);
  system.close();
}

(async () => {
  await transitions();
  await abandoning();
  await withdrawing();
  await inspection();
  clearTimeout(watchdog);
  console.log('operate.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
