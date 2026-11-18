// The module and its loaders in node and bun (docs/plan.xml, p5-build):
// both entries load it; a host is made, runs a null-datamodel chart and is
// freed; a throwing import leaves no stack behind, while the same throws
// without the guard do; a trap poisons the instance; the native
// datamodel's entries, txml's tree record, a resolver and the CBOR tokens
// cross. The Chromium page and Worker run the same scenarios
// (browser.test.mjs).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { run, test } from '../../test/harness.mjs';
import { load } from '../lib/module.mjs';
import * as scenario from './scenario.mjs';

const WASM = new URL('../tinyactors.wasm', import.meta.url);

test('before init() the instance is refused with TA_ERROR_STATE; init.mjs loads it, from a URL too', async () => {
  const state = await import('../lib/state.mjs?before');
  assert.throws(() => state.instance(), { name: 'TinyactorsError', status: 'TA_ERROR_STATE' });
  const entry = await import('../init.mjs');
  assert.equal(typeof entry.init, 'function');
  await entry.init(WASM);
  const own = await import('../lib/state.mjs');
  assert.equal(own.instance().poisoned, false);
  await entry.init(); // a second call answers the same instance
});

test('index.mjs loads the module with top-level await', async () => {
  const entry = await import('../index.mjs');
  assert.equal(typeof entry.TinyactorsError, 'function');
  const { instance } = await import('../lib/state.mjs');
  assert.ok(instance().call('ta_web_version') > 0);
});

test('a host is made, runs a null-datamodel chart and is freed', async () => {
  const result = scenario.nullChart(await load());
  assert.deepEqual(result.sends, [{ event: 'hello', target: 'world', processor: 1, session: 1n }]);
  assert.deepEqual(result.turns, ['idle']);
  assert.equal(result.ticksPerSecond, 1e9);
  assert.equal(result.freed, 0);
  assert.equal(result.envDepth, 0);
});

test('a throwing import leaves no stack behind: each one caught, kept, and the depths back at 0', async () => {
  const result = scenario.throwingImports(await load(), 200);
  assert.equal(result.raised, 200);
  assert.equal(result.after, result.before);
  assert.deepEqual([result.hostDepth, result.envDepth, result.last], [0, 0, 'idle']);
});

test('without the guard, a throw through wasm frames leaves stack and a depth behind', async () => {
  const result = scenario.unguardedImports(new WebAssembly.Module(await readFile(WASM)), 10);
  assert.ok(result.thrown >= 1);
  assert.ok(result.after < result.before, `the stack pointer moved: ${result.before} to ${result.after}`);
  assert.ok(result.envDepth > 0);
});

test('a trap poisons the instance: that call and every later one refuse, naming the cause', async () => {
  const result = scenario.trap(await load());
  assert.equal(result.poisoned, true);
  for (const seen of result.seen) {
    assert.equal(seen.status, 'TA_ERROR_STATE');
    assert.equal(seen.cause, 'RuntimeError');
    assert.match(seen.message, /load it again/);
  }
});

test('another instance is not poisoned by one that is', async () => {
  const poisoned = await load();
  scenario.trap(poisoned);
  assert.equal(scenario.nullChart(await load()).sends.length, 1);
});

test('the native datamodel\'s entries reach JavaScript, and its output room comes back as the log\'s text', async () => {
  const result = scenario.forwarding(await load());
  assert.deepEqual(result.logs, [{ label: 'it', text: 'greeting says hello' }]);
  assert.deepEqual(result.entries.slice(0, 3), [1, 3, 'session 1']);
});

test('XML content is a tree record of txml\'s, read in document order', async () => {
  const { status, top } = scenario.xmlTree(await load());
  assert.equal(status, 0);
  assert.equal(top[0].name, 'a');
  assert.deepEqual(top[0].attributes, [['xmlns:x', 'urn:x'], ['x:k', 'v']]);
  assert.deepEqual(top[0].children.map((c) => [c.kind, c.name, c.text]), [[3, '', 'hi'], [8, '', 'c'], [1, 'b', '']]);
});

test('a resolver gives a static src at compile time', async () => {
  const result = scenario.resolving(await load());
  assert.deepEqual(result, { status: 0, asked: [['r.scxml', 'lib.js']], compiled: true });
});

test('values cross as CBOR tokens, both ways', async () => {
  const module = await load();
  const value = { a: [1, -2, 2n ** 60n, -(2n ** 63n), 1.5, 'é ✓', null, true, false], b: { c: '' } };
  assert.deepEqual(scenario.roundTrip(module, value), value);
  assert.deepEqual(scenario.roundTrip(module, new Uint8Array([1, 2, 3])), new Uint8Array([1, 2, 3]));
  assert.throws(() => scenario.roundTrip(module, '\ud800'), { status: 'TA_ERROR_INVALID' });
});

test('an arena gives its chunks back past its cap when the outermost call leaves', async () => {
  const module = await load();
  const scratch = module.scratch;
  module.scoped(scratch, () => module.room(scratch, 2 * 1024 * 1024));
  assert.equal(module.call('ta_web_scratch_reserved', scratch), 0);
  module.scoped(scratch, () => module.room(scratch, 1000));
  assert.ok(module.call('ta_web_scratch_reserved', scratch) > 0, 'under the cap, the chunk stays');
});

await run();
