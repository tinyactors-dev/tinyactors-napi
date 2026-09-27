'use strict';

// A quarantined invoked child tells its parent (napi ADR 0025): the parent
// gets error.communication.invoke.<id>.quarantined with { code, message },
// the child stays quarantined, and the invocation stays active, so a
// released child that finishes still sends done.invoke. Runs on Node and
// Bun.

const assert = require('node:assert/strict');
const { createSystem, decodeTraces, stepSpanID } = require('..');
const { ecmascript } = require('../tools/ecmascript-datamodel');

const NS = 'xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript"';

// Runs away (80 microsteps against a limit of 50) when it starts, and again
// on `again`; a released run finishes, the second one in a final state.
const TWICE = `<scxml ${NS} name="twice" initial="spin1">
  <datamodel><data id="i" expr="0"/></datamodel>
  <state id="spin1">
    <transition cond="i &lt; 80" target="spin1"><assign location="i" expr="i + 1"/></transition>
    <transition cond="i &gt;= 80" target="idle"/>
  </state>
  <state id="idle">
    <transition event="again" target="spin2"><assign location="i" expr="0"/></transition>
  </state>
  <state id="spin2">
    <transition cond="i &lt; 80" target="spin2"><assign location="i" expr="i + 1"/></transition>
    <transition cond="i &gt;= 80" target="done"/>
  </state>
  <final id="done"/>
</scxml>`;

// Waits in `waiting` for its child `w`, keeping every quarantine report.
function waiter(child) {
  return `<scxml ${NS} name="waiter" initial="waiting">
    <datamodel><data id="errors" expr="[]"/><data id="info" expr="null"/></datamodel>
    <state id="waiting">
      <invoke type="scxml" id="w"><content>${child}</content></invoke>
      <transition event="error.communication.invoke.w.quarantined">
        <assign location="errors" expr="errors.concat([_event.name])"/>
        <assign location="info" expr="_event.data"/>
      </transition>
      <transition event="poke"><send event="again" target="#_w"/></transition>
      <transition event="done.invoke.w" target="finished"/>
      <transition event="leave" target="left"/>
    </state>
    <state id="finished"/>
    <state id="left"/>
  </scxml>`;
}

const REPORT = 'error.communication.invoke.w.quarantined';

function setup(options = {}) {
  const faults = [];
  const system = createSystem({
    scheduling: { microstepLimit: 50 },
    ...options,
    fault: (record) => {
      faults.push(record);
      if (options.onFault) options.onFault(record);
    },
  });
  system.registerDatamodel('ecmascript', ecmascript);
  return { system, faults };
}

// The parent is told, with the fault hook's code and message, and keeps
// waiting; the child stays quarantined.
async function told() {
  const { system, faults } = setup();
  const parent = system.spawn(system.define(waiter(TWICE), { format: 'scxml' }));
  await system.flush();
  assert.equal(faults.length, 1);
  assert.equal(faults[0].code, 'runaway');
  const view = parent.inspect();
  assert.deepEqual(view.data.errors, [REPORT]);
  assert.deepEqual({ ...view.data.info }, { code: 'runaway', message: faults[0].message });
  assert.deepEqual(view.activeStates, ['waiting']);
  assert.equal(faults[0].actor.inspect().scheduling, 'quarantined', 'the child stays quarantined');
  system.close();
}

// A released child carries on: a second runaway reports again, and a child
// that finishes still sends done.invoke.
async function releasedChildFinishes() {
  const { system, faults } = setup();
  const parent = system.spawn(system.define(waiter(TWICE), { format: 'scxml' }));
  await system.flush();
  const child = faults[0].actor;
  system.release(child);
  await system.flush();
  assert.deepEqual(child.inspect().activeStates, ['idle'], 'the released macrostep finished');
  assert.equal(parent.inspect().data.errors.length, 1, 'release itself reports nothing');

  parent.post('poke');
  await system.flush();
  assert.equal(faults.length, 2, 'the child ran away again');
  assert.deepEqual(parent.inspect().data.errors, [REPORT, REPORT], 'each quarantine is reported');

  system.release(child);
  await system.flush();
  assert.deepEqual(parent.inspect().activeStates, ['finished'], 'done.invoke arrived');
  system.close();
}

// A parent that leaves the invoking state cancels, and destroys, the child.
async function parentLeaves() {
  const { system, faults } = setup();
  const parent = system.spawn(system.define(waiter(TWICE), { format: 'scxml' }));
  await system.flush();
  const child = faults[0].actor;
  parent.post('leave');
  await system.flush();
  assert.deepEqual(parent.inspect().activeStates, ['left']);
  assert.equal(child.destroyed, true, 'the quarantined child is destroyed with its invocation');
  assert.equal([...system.actors()].length, 1);
  system.close();
}

// A parent destroyed from the fault hook: the report was already taken, and
// nothing crashes or waits.
async function parentDestroyed() {
  let parent = null;
  const { system, faults } = setup({ onFault: () => system.destroy(parent) });
  parent = system.spawn(system.define(waiter(TWICE), { format: 'scxml' }));
  await system.flush();
  assert.equal(faults.length, 1);
  assert.equal(parent.destroyed, true);
  assert.equal([...system.actors()].length, 0, 'the child went with its parent');
  system.close();
}

// Only the direct parent is told: a grandchild's quarantine reaches the
// child, which runs normally, and not the top-level actor.
async function nested() {
  const { system, faults } = setup();
  const middle = `<scxml ${NS} name="middle" initial="m0">
    <datamodel><data id="errors" expr="[]"/></datamodel>
    <state id="m0">
      <invoke type="scxml" id="g"><content>${TWICE}</content></invoke>
      <transition event="error.communication.invoke.g.quarantined">
        <assign location="errors" expr="errors.concat([_event.name])"/>
      </transition>
    </state>
  </scxml>`;
  const top = system.spawn(system.define(waiter(middle), { format: 'scxml' }));
  await system.flush();
  assert.equal(faults.length, 1, 'only the grandchild faulted');
  assert.deepEqual(top.inspect().data.errors, [], 'the top-level actor is not told');
  const middleView = [...system.actors()].find((view) => view.definition.family === 'middle');
  assert.ok(middleView, 'the middle child is resident');
  assert.deepEqual(middleView.data.errors, ['error.communication.invoke.g.quarantined']);
  system.close();
}

// The report runs under the child's faulting step (core ADR 0067): the
// parent's macrostep that takes it is in the trace the child ran in, and
// its parent span is the child's step where the limit stopped it
// (macrostep 1, microstep 50).
async function traced() {
  const { system, faults } = setup();
  const batches = [];
  system.setTraceSink((bytes) => batches.push(bytes), { detail: 'full' });
  system.spawn(system.define(waiter(TWICE), { format: 'scxml' }));
  await system.flush();
  assert.equal(faults.length, 1);
  const spans = batches.flatMap((bytes) => decodeTraces(bytes));
  const bootstrap = spans.find((span) => span.name === 'scxml.macrostep bootstrap');
  const taken = spans.find((span) => span.name === `scxml.microstep ${REPORT}`);
  assert.ok(bootstrap && taken, `spans: ${JSON.stringify(spans.map((span) => span.name))}`);
  const macrostep = spans.find((span) => span.spanID === taken.parentSpanID);
  assert.ok(macrostep, 'the microstep that took the report has its macrostep');
  assert.equal(macrostep.traceID, bootstrap.traceID, 'the report stays in the trace of the step that invoked');
  const session = faults[0].actor.inspect().sessionID;
  assert.equal(macrostep.parentSpanID, stepSpanID(session, 1, 50), 'its parent span is the child\'s faulting step');
  system.close();
}

(async () => {
  await told();
  await traced();
  await releasedChildFinishes();
  await parentLeaves();
  await parentDestroyed();
  await nested();
  console.log('quarantine.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
