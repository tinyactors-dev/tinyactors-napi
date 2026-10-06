'use strict';
// Whole-system snapshot/restore, and system images (compileSystem, loadImage, boot).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, createActor, createSystem, fromSCXML, compileSystem, loadImage, assign, encodeValue, decodeValue } = require('./binding');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, what, ms = 3000) => {
  for (const t0 = Date.now(); !f(); await wait(2)) if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
};

const counter = () =>
  createMachine({
    id: 'counter',
    context: { count: 0, tags: new Set(['a']) },
    initial: 'counting',
    states: {
      counting: {
        on: { INC: { actions: assign({ count: ({ context, event }) => context.count + (event.by || 1) }) } },
        after: { 150: 'rested' },
      },
      rested: { on: { INC: { target: 'counting', actions: assign({ count: ({ context }) => context.count + 100 }) } } },
    },
  });

const TIMER_DOC = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="ticker" initial="wait">
  <datamodel><data id="log" expr="[]"/></datamodel>
  <state id="wait">
    <onentry><send event="ring" delay="120ms"/></onentry>
    <transition event="note"><script>log.push(_event.data.text)</script></transition>
    <transition event="ring" target="rang"/>
  </state>
  <state id="rang"/>
</scxml>`;

test('snapshot/restore: machines and SCXML documents go on in a new system (contexts, timers, queued events)', async () => {
  const machine = counter();
  const a = createSystem({ id: 'snap' });
  const c = createActor(machine, { system: a, systemID: 'c' }).start();
  const t = createActor(fromSCXML(TIMER_DOC), { system: a, systemID: 't' }).start();
  c.send({ type: 'INC', by: 2 });
  t.send({ type: 'note', text: 'before' });
  await until(() => c.getSnapshot().context.count === 2 && t.getSnapshot().context.log.length === 1, 'the first events');
  const bytes = a.snapshot();
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  a.stop();

  const b = createSystem({ restore: bytes, machines: [machine] });
  assert.equal(b.id, 'snap', 'the same system id: addresses stay valid');
  const c2 = b.get('c'), t2 = b.get('t');
  assert.ok(c2 && t2, 'actors come back with their systemIDs');
  assert.equal(c2.getSnapshot().context.count, 2);
  assert.ok(c2.getSnapshot().context.tags instanceof Set);
  assert.deepEqual(t2.getSnapshot().context.log, ['before']);
  c2.send({ type: 'INC' });
  t2.send({ type: 'note', text: 'after' });
  await until(() => c2.getSnapshot().context.count === 3, 'an event after the restore');
  // the timers armed before the snapshot fire in the restored system
  await until(() => t2.getSnapshot().value === 'rang' && c2.getSnapshot().value === 'rested', 'timers');
  assert.deepEqual(t2.getSnapshot().context.log, ['before', 'after']);
  b.stop();
});

test('restore finds machines by id and compiled SCXML; a machine that changed is an error', () => {
  const machine = counter();
  const a = createSystem();
  createActor(machine, { system: a }).start();
  const bytes = a.snapshot();
  a.stop();
  // machines defined in the process are found without options.machines
  createSystem({ restore: bytes }).stop();
  // a snapshot of a machine whose SCXML no machine here compiles to
  const rec = decodeValue(bytes);
  rec.segments[0].sources[0].xml = rec.segments[0].sources[0].xml.replace('counting', 'counted');
  assert.throws(() => createSystem({ restore: encodeValue(rec) }), /machine "counter" as of the snapshot is not defined/);
  assert.throws(() => createSystem({ restore: new TextEncoder().encode('{"x":1}') }), /not a system snapshot/);
});

const PING = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="idle">
  <datamodel><data id="hits" expr="0"/></datamodel>
  <state id="idle">
    <transition event="ping"><assign location="hits" expr="hits + 1"/>
      <send targetexpr="_event.origin" event="pong"/></transition>
  </state>
</scxml>`;
const ASKER = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="ask">
  <datamodel><data id="answers" expr="0"/></datamodel>
  <state id="ask">
    <transition event="go"><send targetexpr="'#_scxml_' + _event.data.to" event="ping"/></transition>
    <transition event="pong"><assign location="answers" expr="answers + 1"/></transition>
  </state>
</scxml>`;
const MANIFEST = `<system>
  <chart name="pinger" src="ping.scxml"/>
  <chart name="asker" src="asker.scxml"/>
  <actor name="server" chart="pinger"/>
  <actor name="client" chart="asker"/>
</system>`;

test('system images: compileSystem, boot, image bytes, loadImage, chart logic', async () => {
  const image = compileSystem(MANIFEST, { files: { 'ping.scxml': PING, 'asker.scxml': ASKER } });
  assert.deepEqual(image.charts.map((c) => [c.name, c.datamodel]), [['pinger', 'ecmascript'], ['asker', 'ecmascript']]);
  assert.deepEqual(image.actors, [{ name: 'server', chart: 0 }, { name: 'client', chart: 1 }]);
  const system = createSystem();
  const { server, client } = system.boot(image);
  assert.equal(system.get('server'), server);
  const session = Number(server.address.split('#_scxml_')[1]);
  client.send({ type: 'go', to: session });
  await until(() => client.getSnapshot().context.answers === 1, 'the pong');
  assert.equal(server.getSnapshot().context.hits, 1);
  // more actors of an image chart; the image as bytes, loaded elsewhere
  const extra = createActor(image.chart('pinger'), { system }).start();
  assert.equal(extra.getSnapshot().value, 'idle');
  const again = loadImage(image.bytes);
  const other = createSystem();
  const booted = other.boot(again);
  assert.deepEqual(Object.keys(booted), ['server', 'client']);
  assert.throws(() => loadImage(new Uint8Array([1, 2, 3])), /not a valid tinyactors image/);
  assert.throws(() => compileSystem('<system><actor name="x" chart="nope"/></system>'), /system compilation failed/);
  system.stop();
  other.stop();
});

test('a snapshot carries booted images too', async () => {
  const image = compileSystem(MANIFEST, { files: { 'ping.scxml': PING, 'asker.scxml': ASKER } });
  const a = createSystem();
  const { server, client } = a.boot(image);
  const session = Number(server.address.split('#_scxml_')[1]);
  client.send({ type: 'go', to: session });
  await until(() => client.getSnapshot().context.answers === 1, 'the pong');
  const bytes = a.snapshot();
  a.stop();
  const b = createSystem({ restore: bytes });
  const c2 = b.get('client');
  assert.equal(c2.getSnapshot().context.answers, 1);
  c2.send({ type: 'go', to: session });
  await until(() => c2.getSnapshot().context.answers === 2, 'a pong after the restore');
  assert.equal(b.get('server').getSnapshot().context.hits, 2);
  b.stop();
});
