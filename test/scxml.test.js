'use strict';
// SCXML documents with the ECMAScript datamodel (fromSCXML), next to machines.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fromSCXML, createActor, createMachine, createSystem, assign, sendTo } = require('./binding');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, ms = 2000) => {
  for (const t0 = Date.now(); !f(); await wait(2)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
};

const COUNTER = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="idle">
  <datamodel>
    <data id="count" expr="0"/>
    <data id="items" expr="[]"/>
    <data id="limit" expr="3"/>
  </datamodel>
  <state id="idle">
    <transition event="inc" cond="count &lt; limit">
      <assign location="count" expr="count + (_event.data &amp;&amp; _event.data.by || 1)"/>
      <script>items.push(_event.name)</script>
    </transition>
    <transition event="inc" target="full"/>
    <transition event="check" cond="In('idle')" target="checked"/>
  </state>
  <state id="checked">
    <onentry><log label="checked" expr="{ count: count, session: typeof _sessionid }"/></onentry>
  </state>
  <final id="full">
    <donedata><param name="total" expr="count"/></donedata>
  </final>
</scxml>`;

test('fromSCXML: an ECMAScript document as actor logic', async () => {
  const logs = [];
  const a = createActor(fromSCXML(COUNTER), { logger: (...x) => logs.push(x) }).start();
  assert.equal(a.getSnapshot().value, 'idle');
  assert.deepEqual(a.getSnapshot().context, { count: 0, items: [], limit: 3 });
  a.send({ type: 'inc' });
  a.send({ type: 'inc', by: 2 }); // _event.data: the event's other properties
  await until(() => a.getSnapshot().context.count === 3, 'count 3');
  assert.deepEqual(a.getSnapshot().context.items, ['inc', 'inc']);
  a.send({ type: 'inc' }); // not below the limit: final, with donedata as output
  await until(() => a.getSnapshot().status === 'done', 'done');
  assert.deepEqual(a.getSnapshot().output, { total: 3 });
  assert.equal(logs.length, 0);
});

test('fromSCXML: In(), system variables, log; a starting <data> override from input', async () => {
  const logs = [];
  const a = createActor(fromSCXML(COUNTER), { input: { count: 2 }, logger: (...x) => logs.push(x) }).start();
  assert.equal(a.getSnapshot().context.count, 2);
  a.send({ type: 'check' });
  await until(() => logs.length === 1, 'the log');
  assert.deepEqual(logs[0], ['checked', '{"count":2,"session":"string"}']);
  assert.equal(a.getSnapshot().value, 'checked');
});

test('fromSCXML: error.execution for undeclared locations and read-only system variables', async () => {
  const a = createActor(
    fromSCXML(`<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="s">
      <datamodel><data id="errors" expr="0"/></datamodel>
      <state id="s">
        <onentry>
          <assign location="undeclared" expr="1"/>
        </onentry>
        <transition event="error.execution" cond="errors === 0" target="t"><assign location="errors" expr="1"/></transition>
      </state>
      <state id="t">
        <onentry><assign location="_sessionid" expr="'x'"/></onentry>
        <transition event="error.execution" target="pass"/>
      </state>
      <final id="pass"/>
    </scxml>`),
  ).start();
  await until(() => a.getSnapshot().status === 'done', 'pass');
  assert.equal(a.getSnapshot().value, 'pass');
});

test('fromSCXML: nested and parallel states as state values; foreach; scripts that declare globals', async () => {
  const a = createActor(
    fromSCXML(`<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="p">
      <datamodel><data id="sum" expr="0"/><data id="xs" expr="[1, 2, 3]"/></datamodel>
      <script>var helper = function (x) { return x * 10 }</script>
      <parallel id="p">
        <state id="left" initial="l1"><state id="l1"/></state>
        <state id="right" initial="r1">
          <state id="r1">
            <onentry><foreach array="xs" item="x" index="i"><assign location="sum" expr="sum + helper(x) + i"/></foreach></onentry>
          </state>
        </state>
      </parallel>
    </scxml>`),
  ).start();
  assert.deepEqual(a.getSnapshot().value, { p: { left: 'l1', right: 'r1' } });
  assert.equal(a.getSnapshot().context.sum, 63);
  assert.ok(a.getSnapshot().matches({ p: { right: 'r1' } }));
  assert.equal(globalThis.helper, undefined, 'no leak into the host global object');
});

test('fromSCXML: <invoke> of a document from `documents`; the child replies to #_parent', async () => {
  const parent = createActor(
    fromSCXML(
      `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="s">
        <datamodel><data id="got" expr="null"/></datamodel>
        <state id="s">
          <invoke src="child.scxml" id="kid"><param name="n" expr="21"/></invoke>
          <transition event="answer" target="done"><assign location="got" expr="_event.data.v"/></transition>
        </state>
        <final id="done"/>
      </scxml>`,
      {
        documents: {
          'child.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="c">
            <datamodel><data id="n" expr="0"/></datamodel>
            <state id="c"><onentry><send target="#_parent" event="answer"><param name="v" expr="n * 2"/></send></onentry></state>
          </scxml>`,
        },
      },
    ),
  ).start();
  await until(() => parent.getSnapshot().status === 'done', 'the answer');
  assert.equal(parent.getSnapshot().context.got, 42);
});

test('machines and SCXML documents in one system exchange events', async () => {
  const system = createSystem();
  const echo = createActor(
    fromSCXML(`<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="e">
      <datamodel><data id="seen" expr="0"/></datamodel>
      <state id="e">
        <transition event="ping">
          <assign location="seen" expr="seen + 1"/>
          <send targetexpr="_event.origin" event="pong"><param name="n" expr="_event.data.n + 1"/></send>
        </transition>
      </state>
    </scxml>`),
    { system },
  ).start();
  const asker = createActor(
    createMachine({
      id: 'asker',
      context: { got: null },
      initial: 'a',
      states: {
        a: {
          on: {
            go: { actions: sendTo(() => echo, { type: 'ping', n: 1 }) },
            pong: { actions: assign({ got: ({ event }) => event.data.n }) },
          },
        },
      },
    }),
    { system },
  ).start();
  asker.send({ type: 'go' });
  await until(() => asker.getSnapshot().context.got !== null, 'pong');
  assert.equal(asker.getSnapshot().context.got, 2);
  assert.equal(echo.getSnapshot().context.seen, 1);
  system.stop();
});

test('fromSCXML: unsupported datamodels are named', () => {
  assert.throws(
    () => createActor(fromSCXML('<scxml xmlns="http://www.w3.org/2005/07/scxml" datamodel="xpath" initial="s"><state id="s"/></scxml>')).start(),
    /the "xpath" datamodel is not supported/,
  );
});
