'use strict';
// The procedural API is tested below core.mjs: exact effects, handle ownership,
// snapshot continuations and error recovery must agree on both transports.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { join } = require('node:path');
const { createNative } = require('../../web/native.mjs');
const { createEcmascript } = require('../../shared/ecmascript.mjs');
const { encodeValue, decodeValue } = require('./binding');
const resolver = (_, texts) => texts.map((s) => s === 'seed' ? () => 13
  : s === 'increment' ? ({ context }) => context.count + 2 : undefined);
const web = process.env.TA_BINDING === 'web';
const native = web
  ? createNative((imports) => new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(__dirname, '../../web/tinyactors.wasm'))), imports))
  : require('../build/tinyactors.node');
const codec = { encode: encodeValue, decode: decodeValue };

test('native: legacy instance handles and suspended foreach survive repeated restore', () => {
  // Regions are build/architecture-specific, as before the binding unification.
  const file = web ? 'legacy-snapshot.json.gz' : 'legacy-node-snapshot.json.gz';
  const fixture = decodeValue(gunzipSync(readFileSync(join(__dirname, 'fixtures', file))));
  if (web) {
    assert.equal(fixture.dm.insts[0].handle, fixture.dm.insts[1].handle);
    assert.equal(fixture.dm.iters.length, 1);
  } else assert.ok(fixture.dm.pays.some((p) => Array.isArray(p.value) && p.value.length === 1000));
  const images = fixture.images.map((bytes) => native.openImage(bytes));
  const restore = (snap) => native.restore(resolver, codec, 'legacy', createEcmascript(), images, snap.host, snap.dm);
  let h = restore(fixture);
  try {
    // Resnapshot before the legacy iterator finishes, then reuse low slots for
    // new instances. Neither may alias the restored ES instance or iterator.
    const snap = native.snapshot(h);
    native.destroy(h);
    h = restore(snap);
    const fresh = native.spawn(h, 1, 0);
    assert.ok(fresh > 2 ** 32);
    assert.equal((native.run(h, 100000).errors || []).length, 0);
    assert.equal(native.context(h, fixture.xstate).count, 13);
    assert.equal(native.context(h, fixture.es).n, 500507);
    assert.equal(native.context(h, fresh).n, 500507);
    assert.equal(native.sendMany(h, [fixture.xstate, 999, fixture.es], ['STEP', 'STEP', 'STEP'], [{}, {}, {}]), 2);
    const run = native.run(h, 100000);
    assert.equal(run.logs, undefined, 'lists only what happened');
    assert.equal(run.errors, undefined);
    assert.equal(native.context(h, fixture.xstate).count, 15);
    assert.equal(native.context(h, fixture.es).n, 500510);
    assert.deepEqual(native.snapshot(h).dm.iters, []);
    const blob = native.hibernate(h, fixture.es);
    assert.ok(blob instanceof Uint8Array);
    assert.equal(native.wake(h, fixture.es, blob), true);
    assert.equal(native.context(h, fixture.es).n, 500510);
    assert.equal(native.stats(h).sessions, 3);
    const again = native.snapshot(h);
    native.destroy(h);
    h = restore(again);
    assert.equal(native.send(h, fresh, 'STEP', {}), true);
    native.run(h, 100000);
    assert.equal(native.context(h, fresh).n, 500510);
    assert.equal(native.context(h, fixture.es).n, 500510);
  } finally {
    native.destroy(h);
    native.destroy(h);
    assert.throws(() => native.stats(h), /destroyed/);
  }
});

test('native: UTF-8, typed array subviews and failed compile do not poison later calls', () => {
  assert.throws(() => native.compile([{ name: 'bad', xml: '<scxml>' }]), /compilation failed/);
  const image = native.compile([{ name: '雪-é', xml: '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"><state id="雪"/></scxml>' }]);
  const bytes = native.imageBytes(image), padded = new Uint8Array(bytes.length + 13);
  padded.fill(255);
  padded.set(bytes, 5);
  const copy = native.openImage(padded.subarray(5, 5 + bytes.length));
  assert.deepEqual(native.imageBytes(copy), bytes);
  assert.equal(native.chartIndex(copy, '雪-é'), 0);
  assert.equal(native.states(copy, 0)[1].id, '雪');
});
