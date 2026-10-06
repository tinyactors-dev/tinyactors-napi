'use strict';
// Moving actors between systems: system.export(actor) -> bytes -> system.adopt(bytes)
// in a fresh system, also in another process (adopt-child.js). Delayed events
// carry their data as values (the datamodels' payload_serialize), so the bytes
// mean the same in any process; timers keep the time they had left.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { createActor, createSystem, createMemoryStore, fromSCXML } = require('./binding');
const { mover, scxmlMover } = require('./movers');

function exported() {
  let now = 0;
  const system = createSystem({ id: 'home', clock: () => now });
  const xstate = createActor(mover, { system }).start();
  const scxml = createActor(scxmlMover, { system }).start();
  system.flush();
  now = 30;
  system.flush();
  const blobs = { xstate: system.export(xstate), scxml: system.export(scxml) };
  return { system, xstate, scxml, blobs };
}

test('export/adopt: another process adopts the actors; delayed events arrive with their data', () => {
  const { system, xstate, blobs } = exported();
  assert.equal(xstate.getSnapshot().status, 'stopped', 'it left');
  assert.equal(xstate.address, undefined);
  assert.equal(system.stats()[0].actors, 0);
  const input = JSON.stringify(Object.fromEntries(Object.entries(blobs).map(([k, b]) => [k, Buffer.from(b).toString('base64')])));
  const out = JSON.parse(execFileSync(process.execPath, [join(__dirname, 'adopt-child.js')], { input, env: process.env }).toString());
  assert.equal(out.before.xstate.value, 'waiting', 'not before its time');
  assert.equal(out.before.scxml.value, 'w');
  assert.deepEqual(out.after.xstate, { value: 'arrived', context: { got: { k: [1, 2], at: 5 }, n: 2 } });
  assert.equal(out.after.scxml.value, 'done');
  assert.deepEqual(out.after.scxml.context.got, { list: [1, 2], when: new Date(7).toJSON() });
  assert.equal(out.after.scxml.context.hits, 1, 'the declared function, re-created there');
  assert.match(out.address, /^tinyactors:\/\/child\/#_scxml_\d+$/);
});

test('export/adopt: in-process round trip, refusals', async () => {
  const { blobs } = exported();
  let now = 1000;
  const b = createSystem({ id: 'b', clock: () => now });
  const x = b.adopt(blobs.xstate);
  const s = b.adopt(blobs.scxml);
  assert.throws(() => b.adopt(blobs.xstate), /already in this system/);
  assert.throws(() => b.adopt(new Uint8Array([1, 2, 3])), TypeError);
  assert.equal(x.getSnapshot().value, 'waiting');
  now += 70;
  b.flush();
  assert.deepEqual(x.getSnapshot().context.got, { k: [1, 2], at: 5 });
  assert.equal(s.getSnapshot().context.hits, 1);
  /* and on again: the adopted actors export like any other */
  const c = createSystem({ id: 'c' });
  const x2 = c.adopt(b.export(x));
  x2.send({ type: 'INC' });
  c.flush();
  assert.deepEqual(x2.getSnapshot().context, { got: { k: [1, 2], at: 5 }, n: 2 });
  /* what cannot be stored is named, and the actor stays */
  const bad = createActor(
    fromSCXML(`<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="a">
<datamodel><data id="cb" expr="[1, function () {}]"/></datamodel><state id="a"/></scxml>`),
    { system: c },
  ).start();
  c.flush();
  assert.throws(() => c.export(bad), /variable 'cb' cannot be stored: cb\[1\] is a function \(line 2\)/);
  assert.equal(bad.getSnapshot().status, 'active');
  /* hibernated actors are woken first */
  const h = createSystem({ hibernation: { store: createMemoryStore(), sweepMs: 0 } });
  const sleepy = createActor(mover, { system: h }).start();
  h.flush();
  assert.equal(h.hibernate(sleepy), 1);
  assert.throws(() => h.export(sleepy), /hibernated/);
  for (const sys of [b, c, h]) sys.stop();
});
