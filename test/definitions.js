'use strict';

// system.definitions() streams every definition core holds (core ADR 0078):
// builder and imported charts, nested inline children and invoke-time
// children. metrics() and watchTraces({ families }) see the same set, so a
// child chart core registers on its own is reported and watchable. The
// definition lifecycle (core ADR 0079) is counted in metrics() and logged.
// Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart, decodeTraces, TRACE_KINDS } = require('..');
const { ecmascript } = require('../tools/ecmascript-datamodel');

const NS = 'xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript"';

const MAKER = `<script><![CDATA[
  function make(n) {
    return '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="c0">' +
      '<datamodel><data id="n" expr="' + n + '"/></datamodel>' +
      '<state id="c0"><transition event="stop" target="done"/></state><final id="done"/></scxml>';
  }
]]></script>`;

function setup(options = {}) {
  const system = createSystem(options);
  system.registerDatamodel('ecmascript', { compile: (source, role, info) => ecmascript.compile(source, role, info) });
  return system;
}

// A parent whose <invoke> nests an inline child named "kid".
function nesting(system) {
  return system.define(`<scxml ${NS} name="nester" initial="s0">
    <state id="s0">
      <invoke id="kid" type="scxml"><content>
        <scxml ${NS} name="kid" initial="k0">
          <state id="k0"><transition event="stop" target="kdone"/></state>
          <final id="kdone"/>
        </scxml>
      </content></invoke>
      <transition event="stop"><send event="stop" target="#_kid"/></transition>
    </state>
  </scxml>`, { format: 'scxml' });
}

// A parent whose <invoke> compiles its child from <content expr> text.
function making(system) {
  return system.define(`<scxml ${NS} name="maker" initial="s0">
    ${MAKER}
    <state id="s0">
      <invoke type="scxml" id="kid"><content expr="make(1)"/></invoke>
      <transition event="stop"><send event="stop" target="#_kid"/></transition>
      <transition event="done.invoke.kid" target="idle"/>
    </state>
    <state id="idle"/>
  </scxml>`, { format: 'scxml' });
}

const families = (system, options) => [...system.definitions(options)].map((view) => view.identity.family).sort();

// Every kind of definition is streamed, in pages as small as one.
async function streams() {
  const system = setup();
  system.define(statechart({ family: 'built', revision: 'v1' }).state('a'));
  const nester = nesting(system);
  const maker = making(system);
  assert.deepEqual(families(system), ['built', 'kid', 'maker', 'nester']);

  const kid = [...system.definitions()].find((view) => view.identity.family === 'kid');
  const parent = nester.inspect();
  assert.deepEqual(parent.nested, [kid.id], 'the parent names its nested child');
  assert.equal(kid.nestedBy, 1);
  assert.equal(kid.holds, 0, 'nothing but its parent holds it');
  assert.equal(parent.holds, 1);

  system.spawn(maker);
  await system.flush();
  assert.deepEqual(families(system, { pageSize: 1 }), ['built', 'kid', 'maker', 'maker/invoke', 'nester'],
                   'the invoke-time child is listed, and pages of one miss nothing');
  assert.throws(() => system.definitions({ pageSize: 0 }).next(), { code: 'invalid' });
  system.close();
}

// Freed definitions drop out; retired ones in use stay until their last actor.
async function freed() {
  const system = setup();
  const built = system.define(statechart({ family: 'built', revision: 'v1' }).state('a'));
  const actor = system.spawn(built);
  await system.flush();
  built.retire();
  const retired = [...system.definitions()].find((view) => view.identity.family === 'built');
  assert.equal(retired?.retired, true, 'retired but still used: listed');
  system.destroy(actor);
  await system.flush();
  assert.deepEqual(families(system), [], 'freed with its last actor');

  const maker = making(system);
  const parent = system.spawn(maker);
  await system.flush();
  assert.ok(families(system).includes('maker/invoke'));
  system.post(parent, 'stop');
  await system.flush();
  assert.deepEqual(families(system), ['maker'], 'the invoke-time child went with its child');
  system.close();
}

// metrics() reports a nested child's counters and occupancy under its family.
async function metrics() {
  const system = setup();
  const nester = nesting(system);
  system.spawn(nester);
  system.spawn(nester);
  await system.flush();
  const snapshot = system.metrics();
  const occupancy = snapshot.metrics.find((metric) => metric.name === 'tinyactors.actors.occupancy');
  const kid = occupancy.points.find((point) => point.attributes['tinyactors.definition.family'] === 'kid' &&
                                               point.attributes['scxml.state'] === 'k0');
  assert.equal(kid?.value, 2, 'two nested children in k0');
  const macrosteps = snapshot.metrics.find((metric) => metric.name === 'tinyactors.macrosteps');
  assert.ok(macrosteps.points.some((point) => point.attributes['tinyactors.definition.family'] === 'kid' &&
                                                point.value > 0), 'the nested child counts its macrosteps');
  system.close();
}

// watchTraces({ families }) catches invoke-time children, registered by core
// after the watch began.
async function watch() {
  const system = setup();
  const batches = [];
  system.setTraceSink((traces) => batches.push(traces), { sample: 0, logs: false });
  const handle = system.watchTraces({ families: ['maker/invoke'] });
  const maker = making(system);
  const parent = system.spawn(maker);
  await system.flush();
  const child = [...system.actors()].find((view) => view.definition.family === 'maker/invoke');
  assert.ok(child, 'the child is resident');
  batches.length = 0;
  system.post(parent, 'stop');
  await system.flush();
  const spans = batches.flatMap((bytes) => decodeTraces(bytes));
  const of = (session) => spans.filter((span) => span.attributes['scxml.session_id'] === String(session));
  assert.ok(of(child.sessionID).length > 0, 'the watched child was traced');
  // The parent's own delivery of "stop" is not watched; only what the
  // watched child causes in it (done.invoke) is, as napi ADR 0017 says.
  const parentEvents = of(system.inspect(parent).sessionID).map((span) => span.attributes['scxml.event.name'])
    .filter((name) => name !== undefined);
  assert.ok(!parentEvents.includes('stop'), `the unwatched parent's delivery was not traced (${parentEvents})`);
  handle.stop();
  system.close();
}

// The strings in an OTLP protobuf message, nested messages included: enough
// to read log bodies and attributes without a decoder.
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
    } else throw new Error('wire type');
  }
  return out;
}

// metrics() counts the definition lifecycle (core ADR 0079), and says who
// registered each definition still alive: the host, a parent (nested) or an
// invoke.
async function lifecycleMetrics() {
  const system = setup();
  const read = () => {
    const snapshot = system.metrics().metrics;
    const sum = (name) => snapshot.find((metric) => metric.name === name).points[0].value;
    const alive = {};
    for (const point of snapshot.find((metric) => metric.name === 'tinyactors.definitions').points) {
      alive[`${point.attributes['tinyactors.definition.origin']}/${point.attributes['tinyactors.definition.state']}`] =
        point.value;
    }
    return { registered: sum('tinyactors.definitions.registered'), retired: sum('tinyactors.definitions.retired'),
             freed: sum('tinyactors.definitions.freed'), alive };
  };
  const empty = read();
  assert.deepEqual(empty, { registered: 0, retired: 0, freed: 0,
    alive: { 'host/live': 0, 'host/retired': 0, 'nested/live': 0, 'nested/retired': 0, 'invoke/live': 0,
             'invoke/retired': 0 } }, 'every point is there from the first snapshot');

  const built = system.define(statechart({ family: 'built', revision: 'v1' }).state('a'));
  nesting(system);
  const maker = making(system);
  let counts = read();
  assert.equal(counts.registered, 4, 'built, nester, its nested kid, maker');
  assert.equal(counts.alive['host/live'], 3);
  assert.equal(counts.alive['nested/live'], 1);

  // Invoke-time children come and go: registered and freed keep pace (churn).
  for (let round = 0; round < 5; round += 1) {
    const parent = system.spawn(maker);
    await system.flush();
    assert.equal(read().alive['invoke/live'], 1, 'the live invoke-time child');
    system.post(parent, 'stop');
    await system.flush();
    system.destroy(parent);
    await system.flush();
  }
  counts = read();
  assert.equal(counts.alive['invoke/live'], 0);
  assert.equal(counts.registered - counts.freed, 4, 'churn: registrations and frees kept pace');
  assert.ok(counts.freed >= 1, 'invoke-time children were freed');

  // A retired definition still in use counts as retired until its last actor goes.
  const actor = system.spawn(built);
  await system.flush();
  built.retire();
  counts = read();
  assert.equal(counts.retired, 1);
  assert.equal(counts.alive['host/retired'], 1);
  system.destroy(actor);
  await system.flush();
  assert.equal(read().alive['host/retired'], 0, 'freed with its last actor');
  system.close();
}

// Definition churn is logged, DEBUG and INFO, rate-limited per family so a
// family that registers a child for every invoke stays within logLimit.
async function lifecycleLogs() {
  const system = setup();
  const batches = [];
  system.setTraceSink((traces, logs) => { if (logs !== undefined) batches.push(logs); }, { logLimit: 2, sample: 0 });
  const built = system.define(statechart({ family: 'built', revision: 'v1' }).state('a'));
  nesting(system);
  const maker = making(system);
  for (let round = 0; round < 10; round += 1) {
    const parent = system.spawn(maker);
    await system.flush();
    system.post(parent, 'stop');
    await system.flush();
    system.destroy(parent);
  }
  built.retire();
  const actor = system.spawn(nesting(system));
  await system.flush();
  system.destroy(actor);
  await system.flush();
  const text = batches.flatMap((bytes) => protobufStrings(bytes));
  assert.ok(text.includes('registered built v1 (host)'), `the host's registration: ${text.filter((t) => t.startsWith('reg'))}`);
  assert.ok(text.some((t) => /^registered kid [0-9a-f]+ \(nested\)$/.test(t)), 'the nested child, by origin');
  assert.ok(text.includes('retired built v1 (host)') && text.includes('INFO'), 'retiring is INFO');
  assert.ok(text.includes('DEBUG') && text.includes('tinyactors.definition.origin'), 'DEBUG, with the origin');
  const invokeRegistered = text.filter((t) => /^registered maker\/invoke /.test(t)).length;
  assert.ok(invokeRegistered >= 1 && invokeRegistered <= 4,
            `ten invoke-time children, at most logLimit a second of them logged: ${invokeRegistered}`);
  system.close();

  // logs: false writes none.
  const quiet = setup();
  const none = [];
  quiet.setTraceSink((traces, logs) => { if (logs !== undefined) none.push(logs); }, { logs: false });
  quiet.spawn(quiet.define(statechart({ family: 'quiet', revision: 'v1' }).state('a')));
  await quiet.flush();
  assert.equal(none.length, 0);
  quiet.close();
}

// Core's definition records (core ADR 0080) are trace kinds a follower of
// core's record stream reads. The addon's OTLP output reports definitions
// once, as the definition sink's logs: no preset asks core for the records,
// and naming them in `kinds` adds no span and no second log.
async function definitionRecords() {
  const first = TRACE_KINDS.indexOf('definitionRegistered');
  assert.deepEqual(TRACE_KINDS.slice(first, first + 3), ['definitionRegistered', 'definitionRetired', 'definitionFreed']);
  const system = setup();
  const traces = [];
  const logs = [];
  system.setTraceSink((trace, log) => {
    traces.push(trace);
    if (log !== undefined) logs.push(log);
  }, { kinds: ['spawned', 'destroyed', 'definitionRegistered', 'definitionRetired', 'definitionFreed'], logLimit: 100 });
  const built = system.define(statechart({ family: 'recorded', revision: 'v1' }).state('a'));
  const actor = system.spawn(built);
  await system.flush();
  built.retire();
  system.destroy(actor);
  await system.flush();
  const text = logs.flatMap((bytes) => protobufStrings(bytes));
  for (const event of ['registered', 'retired', 'freed']) {
    assert.equal(text.filter((t) => t === `${event} recorded v1 (host)`).length, 1, `one ${event} log, not two`);
  }
  const names = traces.flatMap((bytes) => decodeTraces(bytes)).map((span) => span.name);
  assert.ok(names.length > 0, 'the actor spans are there');
  assert.ok(!names.some((name) => name.includes('definition')), `no definition spans: ${names}`);
  system.close();
}

(async () => {
  await definitionRecords();
  await lifecycleMetrics();
  await lifecycleLogs();
  await streams();
  await freed();
  await metrics();
  await watch();
  console.log('definitions.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
