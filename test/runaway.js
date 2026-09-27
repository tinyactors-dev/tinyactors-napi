'use strict';

// Runaway macrosteps (core ADR 0075). An actor whose macrostep runs its
// microstep limit is quarantined with fault code `runaway`: the fault hook,
// the faults metric and a WARN log say so. release() lets that macrostep
// finish; the next one has the limit again. A definition can override the
// system's limit. Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart } = require('..');

// Counts to `to` through an eventless self-transition, then goes idle.
function counter(family, to) {
  return statechart({ family, revision: 'v1' })
    .data('n', 0)
    .data('to', to)
    .state('idle', (s) => s.on('go', (t) => t.assign('n', () => 0).target('spin')))
    .state('spin', (s) => {
      s.always((t) => t.when(({ data }) => data.n < data.to).assign('n', function () { return this.n + 1; }).target('spin'));
      s.always((t) => t.target('idle'));
    });
}

// The printable strings of an OTLP message: enough to check logs without a
// decoder (as test/tracing.js does).
function protobufStrings(bytes, out = []) {
  let at = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = bytes[at++];
      if (byte === undefined) throw new Error('truncated');
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (at < bytes.length) {
    const wire = varint() & 7;
    if (wire === 0) varint();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const length = varint();
      const body = bytes.subarray(at, at + length);
      if (body.length !== length) throw new Error('truncated');
      at += length;
      const text = Buffer.from(body).toString('utf8');
      if (/^[\x20-\x7e]+$/.test(text)) out.push(text);
      try { protobufStrings(body, out); } catch { /* a string */ }
    } else throw new Error(`wire ${wire}`);
  }
  return out;
}

const metricValue = (snapshot, name, attributes = {}) =>
  snapshot.metrics
    .find((metric) => metric.name === name)
    ?.points.filter((point) => Object.entries(attributes).every(([key, value]) => point.attributes[key] === value))
    .reduce((sum, point) => sum + point.value, 0) ?? 0;

async function quarantinedThenReleased() {
  const faults = [];
  const logs = [];
  const system = createSystem({ scheduling: { microstepLimit: 100 }, fault: (fault) => faults.push(fault) });
  system.setTraceSink((traces, batch) => { if (batch !== undefined) logs.push(batch); });
  const definition = system.define(counter('rw-loop', 150));
  const actor = system.spawn(definition);
  await system.flush();

  actor.post('go');
  await system.flush();
  assert.equal(faults.length, 1, 'one fault');
  assert.equal(faults[0].code, 'runaway');
  assert.equal(system.inspect(actor).scheduling, 'quarantined');
  assert.equal(system.inspect(actor).data.n, 99, 'stopped at the limit: the go microstep, then 99 turns');

  const text = logs.flatMap((bytes) => protobufStrings(bytes));
  assert.ok(text.includes('tinyactors.macrostep.long'), `a warning at a tenth of the limit: ${text}`);
  assert.ok(text.includes('tinyactors.actor.runaway'), 'a runaway log');
  // The body names the loop's transition, with an arrow the ASCII scan skips.
  const raw = Buffer.concat(logs.map((bytes) => Buffer.from(bytes))).toString('utf8');
  assert.ok(/100 microsteps in one macrostep, the last through spin → spin/.test(raw), 'the body names the loop');

  const metrics = system.metrics();
  assert.equal(metricValue(metrics, 'tinyactors.faults', { 'tinyactors.fault.code': 'runaway' }), 1);
  assert.equal(metricValue(metrics, 'tinyactors.actors.quarantined'), 1);
  assert.equal(metricValue(metrics, 'tinyactors.macrosteps.runaway'), 1);
  assert.equal(metricValue(metrics, 'tinyactors.macrosteps.long'), 1);

  // release() lets this macrostep finish.
  system.release(actor);
  await system.flush();
  assert.equal(system.inspect(actor).data.n, 150, 'the released macrostep finished');
  assert.deepEqual(system.inspect(actor).activeStates, ['idle']);
  assert.equal(faults.length, 1);

  // The next macrostep has the limit again.
  actor.post('go');
  await system.flush();
  assert.equal(faults.length, 2, 'limited again');
  assert.equal(faults[1].code, 'runaway');
  system.close();
}

async function overrides() {
  const faults = [];
  const system = createSystem({ scheduling: { microstepLimit: 100 }, fault: (fault) => faults.push(fault) });
  const unlimited = system.define(counter('rw-none', 500), { microstepLimit: 0 });
  const roomy = system.define(counter('rw-roomy', 500), { microstepLimit: 1000 });
  const tight = system.define(counter('rw-tight', 50), { microstepLimit: 10 });
  const actors = [unlimited, roomy, tight].map((definition) => system.spawn(definition));
  await system.flush();
  for (const actor of actors) actor.post('go');
  await system.flush();
  assert.equal(system.inspect(actors[0]).data.n, 500, 'no limit');
  assert.equal(system.inspect(actors[1]).data.n, 500, 'a higher limit');
  assert.equal(faults.length, 1, 'only the tight one is a runaway');
  assert.equal(system.inspect(actors[2]).scheduling, 'quarantined');
  assert.throws(() => system.define(counter('rw-bad', 1), { microstepLimit: -1 }), /microstepLimit/);
  system.close();

  // The system's limit off: nothing is limited.
  const open = createSystem({ scheduling: { microstepLimit: 0 } });
  const actor = open.spawn(open.define(counter('rw-open', 300)));
  await open.flush();
  actor.post('go');
  await open.flush();
  assert.equal(open.inspect(actor).data.n, 300);
  open.close();
}

// A <foreach> is one microstep however many turns it pauses across.
async function longForeach() {
  const faults = [];
  const system = createSystem({ scheduling: { microstepLimit: 5, actionBudget: 10 }, fault: (fault) => faults.push(fault) });
  const definition = system.define(
    statechart({ family: 'rw-foreach', revision: 'v1' })
      .data('n', 0)
      .data('items', Array.from({ length: 2000 }, (_, i) => i))
      .data('item', null)
      .state('idle', (s) =>
        s.on('go', (t) => t.forEach(({ data }) => data.items, 'item', (b) => b.assign('n', function () { return this.n + 1; })))),
  );
  const actor = system.spawn(definition);
  await system.flush();
  actor.post('go');
  await system.flush();
  assert.equal(system.inspect(actor).data.n, 2000);
  assert.equal(faults.length, 0, 'a long <foreach> is not a runaway');
  system.close();
}

// An operator abandons a runaway's macrostep (core ADR 0082) instead of
// letting it go on: the send() waiting for it already rejected with the
// fault, the actor keeps the configuration of its last microstep, and after
// release() the next macrostep is limited again, as the lifted limit went
// with the abandoned macrostep.
async function abandoned() {
  const faults = [];
  const system = createSystem({ scheduling: { microstepLimit: 100 }, fault: (fault) => faults.push(fault) });
  const actor = system.spawn(system.define(counter('rw-abandon', 150)));
  await system.flush();
  const waiting = actor.send('go');
  await system.flush();
  assert.equal(system.inspect(actor).scheduling, 'quarantined');
  await assert.rejects(waiting, (error) => error.code === 'runaway');
  system.abandon(actor);
  assert.deepEqual(system.inspect(actor).activeStates, ['spin']);
  assert.equal(system.inspect(actor).macrostepInProgress, false);
  system.release(actor);
  await system.flush();
  assert.equal(system.inspect(actor).scheduling, 'idle');
  assert.equal(faults.length, 1);
  actor.post('operator.goto', undefined, { transition: { targets: ['idle'] } });
  await system.flush();
  actor.post('go');
  await system.flush();
  assert.equal(faults.length, 2, 'the next macrostep is limited again');
  assert.equal(faults[1].code, 'runaway');
  system.close();
}

(async () => {
  await quarantinedThenReleased();
  await abandoned();
  await overrides();
  await longForeach();
  console.log('runaway.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
