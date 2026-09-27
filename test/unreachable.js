'use strict';

// Mail a chart sends to a target that does not exist (napi ADR 0022): the
// sender gets error.communication with { reason, target } (SCXML 6.2.4),
// while mail posted from JavaScript stays a dead letter (ADR 0008), and a
// family with a loader still loads. Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart } = require('..');

// A chart that sends `ping` to `target` on `go` (after `delay` ms when given)
// and keeps what error.communication said.
function sender(system, family, target, delay) {
  return system.define(
    statechart({ family, revision: 'v1' })
      .data('failure', null)
      .data('failures', 0)
      .state('idle', (s) => {
        s.on('go', (t) =>
          t.send('ping', (m) => {
            m.to(target);
            if (delay !== undefined) m.after(delay);
          }),
        );
        s.on('error.communication', (t) =>
          t
            .assign('failure', ({ event }) => event.data)
            .assign('failures', function () { return this.failures + 1; }),
        );
      }),
  );
}

function receiver(system, family) {
  return system.define(
    statechart({ family, revision: 'v1' })
      .data('pings', 0)
      .state('idle', (s) => s.on('ping', (t) => t.assign('pings', function () { return this.pings + 1; }))),
  );
}

function sum(system, name, attributes = {}) {
  const metric = system.metrics().metrics.find((m) => m.name === name);
  return (metric?.points ?? [])
    .filter((p) => Object.entries(attributes).every(([k, v]) => p.attributes[k] === v))
    .reduce((total, p) => total + p.value, 0);
}

// An unknown name in a family with no loader: the chart gets the error, and
// JavaScript's post to the same name is still a dead letter.
async function unknownName() {
  const dead = [];
  const system = createSystem({ deadLetter: (record) => dead.push(record) });
  const actor = system.spawn(sender(system, 'sender', '#_actor_nobody/here'));
  await system.flush();
  actor.post('go');
  await system.flush();
  assert.deepEqual(actor.inspect().data.failure, { reason: 'not-found', target: { family: 'nobody', name: 'here' } });
  assert.equal(dead.length, 0, 'the chart\'s mail is not a dead letter');
  assert.equal(system.metrics().system.errors_communication, 1);
  assert.equal(sum(system, 'tinyactors.messages.dead_lettered'), 0);

  system.post({ family: 'nobody', name: 'here' }, 'ping');
  await system.flush();
  assert.equal(dead.at(-1)?.reason, 'not-found', 'mail from JavaScript stays a dead letter');
  system.close();
}

// A session ID that no actor has any more: the chart gets the error.
async function unknownSession() {
  const system = createSystem();
  const gone = system.spawn(receiver(system, 'receiver'));
  await system.flush();
  const session = gone.inspect().sessionID;
  system.destroy(gone);
  await system.flush();
  const actor = system.spawn(sender(system, 'sender', `#_scxml_${session}`));
  await system.flush();
  actor.post('go');
  await system.flush();
  assert.equal(actor.inspect().data.failure?.reason, 'not-found');
  assert.equal(actor.inspect().data.failures, 1);
  system.close();
}

// A family with a loader: an unknown name loads. The loader's "not-found"
// comes after the mail was accepted, so it is a dead letter, not an error.
async function loaderFamily() {
  const dead = [];
  const system = createSystem({ deadLetter: (record) => dead.push(record) });
  const loaded = [];
  const definition = receiver(system, 'lazy');
  system.setLoader('lazy', async (address) => {
    loaded.push(address.name);
    return address.name === 'known' ? { spawn: definition } : 'not-found';
  });
  const known = system.spawn(sender(system, 'sender', '#_actor_lazy/known'), { name: 'k' });
  const unknown = system.spawn(sender(system, 'sender', '#_actor_lazy/unknown'), { name: 'u' });
  await system.flush();
  known.post('go');
  unknown.post('go');
  await system.flush();
  assert.deepEqual(loaded.sort(), ['known', 'unknown']);
  assert.equal(known.inspect().data.failures, 0);
  assert.equal(unknown.inspect().data.failures, 0, 'a loader\'s answer is not the sender\'s error');
  assert.equal(dead.find((record) => record.event === 'ping')?.reason, 'not-found');
  system.close();
}

// A delayed send whose target is destroyed before it comes due: the error
// reaches the sender when the timer fires.
async function delayedSendToADestroyedTarget() {
  const system = createSystem({ clock: 'manual' });
  const target = system.spawn(receiver(system, 'receiver'), { name: 'r' });
  const actor = system.spawn(sender(system, 'sender', '#_actor_receiver/r', 100));
  await system.flush();
  actor.post('go');
  await system.flush();
  system.destroy(target);
  await system.flush();
  assert.equal(actor.inspect().data.failures, 0, 'nothing is due yet');
  await system.advanceTo(system.time + 200);
  assert.deepEqual(actor.inspect().data.failure, { reason: 'not-found', target: { family: 'receiver', name: 'r' } });
  system.close();
}

// A resident target still gets its mail.
async function residentTarget() {
  const system = createSystem();
  const target = system.spawn(receiver(system, 'receiver'), { name: 'r' });
  const actor = system.spawn(sender(system, 'sender', '#_actor_receiver/r'));
  await system.flush();
  actor.post('go');
  await system.flush();
  assert.equal(target.inspect().data.pings, 1);
  assert.equal(actor.inspect().data.failures, 0);
  system.close();
}

(async () => {
  await unknownName();
  await unknownSession();
  await loaderFamily();
  await delayedSendToADestroyedTarget();
  await residentTarget();
  console.log('unreachable.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
