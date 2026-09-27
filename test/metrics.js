'use strict';

// Metrics as plain data (napi ADR 0017 section 7, core ADR 0072): the
// snapshot system.metrics() returns, and its OTLP bytes. Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart, metricsToOTLP, formatTraceparent, TinyactorsError } = require('..');
const { nativeOf } = require('../lib/system');

const point = (snapshot, name, match = {}) => {
  const metric = snapshot.metrics.find((entry) => entry.name === name);
  assert.ok(metric !== undefined, `metric ${name}`);
  return metric.points.find((p) => Object.entries(match).every(([key, value]) => p.attributes[key] === value));
};

// A minimal protobuf walk: every length-delimited field is nested well, and
// the strings it holds are collected.
function strings(bytes, out = []) {
  let at = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = bytes[at++];
      assert.ok(byte !== undefined, 'a varint runs past its message');
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (at < bytes.length) {
    const wire = varint() & 7;
    if (wire === 0) varint();
    else if (wire === 1) at += 8;
    else if (wire === 2) {
      const length = varint();
      const body = bytes.subarray(at, at + length);
      assert.equal(body.length, length, 'a field runs past its message');
      at += length;
      const text = Buffer.from(body).toString('utf8');
      if (/^[\x20-\x7e]+$/.test(text)) out.push(text);
      try {
        strings(body, out);
      } catch {
        // not a message: a string or bytes
      }
    } else if (wire === 5) at += 4;
    else throw new Error(`wire type ${wire}`);
  }
  return out;
}

async function snapshot() {
  const system = createSystem();
  const definition = system.define(
    statechart({ family: 'orders', revision: 'v2' })
      .state('open', (s) => s.on('close', (t) => t.target('closed')))
      .state('closed'),
  );
  const a = system.spawn(definition);
  const b = system.spawn(definition);
  system.spawn(definition);
  await system.flush();
  a.post('close');
  b.post('unknown');
  await system.flush();

  const metrics = system.metrics();
  const family = { 'tinyactors.definition.family': 'orders', 'tinyactors.definition.revision': 'v2' };
  assert.equal(point(metrics, 'tinyactors.actors.spawned', family).value, 3);
  assert.equal(point(metrics, 'tinyactors.events.taken', family).value, 2);
  assert.equal(point(metrics, 'tinyactors.events.ignored', { ...family, 'scxml.event.type': 'external' }).value, 1);
  assert.equal(point(metrics, 'tinyactors.actors.occupancy', { ...family, 'scxml.state': 'open' }).value, 2);
  assert.equal(point(metrics, 'tinyactors.actors.occupancy', { ...family, 'scxml.state': 'closed' }).value, 1);
  assert.equal(metrics.metrics.find((m) => m.name === 'tinyactors.actors.occupancy').kind, 'gauge');
  assert.equal(metrics.metrics.find((m) => m.name === 'tinyactors.macrosteps').kind, 'sum');
  assert.ok(point(metrics, 'tinyactors.messages.delivered').value >= 2);
  assert.ok(point(metrics, 'tinyactors.memory.usage', { 'tinyactors.memory.category': 'core' }).value > 0);
  for (const metric of metrics.metrics) {
    for (const p of metric.points) {
      assert.ok(!('scxml.session_id' in p.attributes), 'no metric names one actor');
    }
  }
  assert.equal(metrics.system.spawned, 3);

  a.destroy();
  const after = system.metrics();
  assert.equal(point(after, 'tinyactors.actors.occupancy', { ...family, 'scxml.state': 'closed' }), undefined,
               'a destroyed actor leaves the occupancy');

  const bytes = metricsToOTLP(after, { resource: { 'service.name': 'orders-service' } });
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  const text = strings(bytes);
  for (const expected of ['service.name', 'orders-service', 'tinyactors', 'tinyactors.actors.occupancy',
                          'tinyactors.definition.family', 'orders', '{actor}']) {
    assert.ok(text.includes(expected), `the OTLP bytes carry ${expected}`);
  }
  assert.throws(() => metricsToOTLP({}), (error) => error instanceof TinyactorsError && error.code === 'invalid');
  system.close();
}

// What only the host knows (napi ADR 0017 section 7): turn duration, the run
// queues, quarantine and faults by code, dead letters by reason, and how
// late timers fire; the quarantine and the dead letter also arrive as WARN
// logs, and a histogram bucket links to the trace of a sampled step.
async function hostMetrics() {
  const logs = [];
  const system = createSystem({ clock: 'manual', fault: () => {}, deadLetter: () => {} });
  system.setTraceSink((traces, batch) => {
    if (batch !== undefined) logs.push(...strings(batch));
  });
  const definition = system.define(
    statechart({ family: 'timers', revision: 'v1' })
      // Mail between actors goes through the host's router, as a timer firing does.
      .state('idle', (s) => s.on('arm', (t) => t.target('armed').send('ring', (m) => m.to('#_actor_timers/clock').after(100))))
      .state('armed', (s) => s.on('ring', (t) => t.target('idle'))),
  );
  const timer = system.spawn(definition, { name: 'clock' });
  const bad = system.spawn(definition);
  const gone = system.spawn(definition);
  await system.flush();

  // A sampled trace: the turn that runs it is that bucket's exemplar.
  const traceID = '4bf92f3577b34da6a3ce929d0e0e4736';
  timer.post('arm', undefined, { traceparent: formatTraceparent({ traceID, spanID: '00f067aa0ba902b7' }) });
  await system.flush();
  // The timer was due at 100 and fires at 350: 250 ms late.
  await system.advanceTo(350);
  // A delivery core refuses quarantines its actor (faults "invalid").
  nativeOf(system).post(bad.slot, bad.generation, 0x7fffffff);
  // Mail to a destroyed actor is a dead letter ("not-found").
  gone.destroy();
  gone.post('arm');
  await system.flush();

  const metrics = system.metrics();
  const turn = point(metrics, 'tinyactors.pump.turn.duration');
  assert.equal(metrics.metrics.find((m) => m.name === 'tinyactors.pump.turn.duration').kind, 'histogram');
  assert.ok(turn.count >= 3, `turns were timed: ${turn.count}`);
  assert.equal(turn.buckets.length, turn.bounds.length + 1, 'one bucket past the last bound');
  assert.equal(turn.buckets.reduce((a, b) => a + b, 0), turn.count);
  assert.ok(turn.min >= 0 && turn.max >= turn.min && turn.sum >= turn.max);
  assert.ok(turn.exemplars.some((e) => e.traceID === traceID && /^[0-9a-f]{16}$/.test(e.spanID)),
            `a turn links to the sampled trace: ${JSON.stringify(turn.exemplars)}`);

  const lateness = point(metrics, 'tinyactors.timers.lateness');
  assert.equal(lateness.count, 1, 'one timer fired');
  assert.ok(Math.abs(lateness.sum - 0.25) < 1e-9, `250 ms late: ${lateness.sum}`);
  assert.ok(lateness.exemplars.some((e) => e.traceID === traceID), 'the late timer links to the trace that set it');
  assert.equal(point(metrics, 'tinyactors.timers.overdue').value, 0, 'nothing is overdue now');

  assert.equal(point(metrics, 'tinyactors.actors.quarantined').value, 1);
  assert.equal(point(metrics, 'tinyactors.faults', { 'tinyactors.fault.code': 'invalid' }).value, 1);
  assert.equal(point(metrics, 'tinyactors.messages.dead_lettered', { 'tinyactors.dead_letter.reason': 'not-found' }).value, 1);
  assert.equal(point(metrics, 'tinyactors.messages.dead_lettered', { 'tinyactors.dead_letter.reason': 'refused' }).value, 1);
  assert.equal(typeof point(metrics, 'tinyactors.scheduler.runnable').value, 'number');
  assert.equal(typeof point(metrics, 'tinyactors.scheduler.ready').value, 'number');
  system.release(bad);
  assert.equal(point(system.metrics(), 'tinyactors.actors.quarantined').value, 0, 'release leaves quarantine');

  // The OTLP bytes carry the histograms, bounds, exemplars and doubles.
  const text = strings(metricsToOTLP(metrics));
  for (const name of ['tinyactors.pump.turn.duration', 'tinyactors.timers.lateness', 'tinyactors.timers.overdue',
                      'tinyactors.faults', 'tinyactors.fault.code', 'tinyactors.dead_letter.reason', 's']) {
    assert.ok(text.includes(name), `the OTLP bytes carry ${name}`);
  }

  // The quarantine and the dead letter, as WARN logs.
  assert.ok(logs.includes('tinyactors.actor.quarantined') && logs.includes('actor quarantined: deliver failed: invalid'),
            `a quarantine log: ${logs}`);
  assert.ok(logs.includes('tinyactors.message.dead_lettered') && logs.includes('arm dead-lettered: not-found'),
            `a dead-letter log: ${logs}`);
  system.close();
}

(async () => {
  await snapshot();
  await hostMetrics();
  console.log('metrics.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
