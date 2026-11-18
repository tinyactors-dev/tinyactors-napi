// The module in Chromium (the pre-installed Playwright's, /opt/pw-browsers,
// as staticjs-js's test finds it): a page and a module Worker import both
// entries over HTTP (index.mjs fetches tinyactors.wasm by its URL with
// top-level await; init.mjs's init() answers the same instance), make a
// host, run a null-datamodel chart and free it, show a throwing import
// leaves no stack behind and a trap poisons only its own instance; the
// native datamodel's realms there, and its refusals under a policy. Where
// no Playwright is installed it says so and passes: the test task
// requires one (mise/tasks/wasm/test).
import assert from 'node:assert/strict';
import { compileCharts, Host } from '@tinyactors/node';
import { run, test } from '../../test/harness.mjs';
import { launch, napi, playwright, serve } from './serve.mjs';

function check(out, where) {
  assert.deepEqual(out.entries, ['function', 'function', 'TA_ERROR_STATE'], where);
  assert.deepEqual(out.nullChart.sends, [{ event: 'hello', target: 'world', processor: 1, session: '1n' }], where);
  assert.equal(out.nullChart.freed, 0, where);
  assert.equal(out.throwing.raised, 200, where);
  assert.equal(out.throwing.after, out.throwing.before, `${where}: the stack is where it was`);
  assert.equal(out.throwing.envDepth, 0, where);
  assert.deepEqual(out.forwarding.logs, [{ label: 'it', text: 'greeting says hello' }], where);
  assert.equal(out.trap.poisoned, true, where);
  for (const seen of out.trap.seen) assert.deepEqual([seen.status, seen.cause], ['TA_ERROR_STATE', 'RuntimeError'], where);
  assert.equal(out.afterTrap, 1, `${where}: the entries' instance is not the poisoned one`);
}

test('the module in a Chromium page and a module Worker, through both entries', async () => {
  const pw = playwright();
  if (pw === null) {
    console.log('skip: no Playwright installed');
    return;
  }
  const server = await serve(new Map([[napi('page.html'), '<!doctype html><title>tinyactors</title>']]));
  const browser = await launch(pw);
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.goto(`http://127.0.0.1:${server.address().port}${napi('page.html')}`);
    check(await page.evaluate(async (url) => (await import(url)).everything(), napi('wasm/test/browser.mjs')), 'page');
    const worker = await page.evaluate((url) => new Promise((resolve) => {
      const w = new Worker(url, { type: 'module' });
      w.onmessage = (event) => resolve(event.data);
      w.onerror = (event) => resolve({ error: event.message });
    }), napi('wasm/test/worker.mjs'));
    assert.equal(worker.error, undefined, worker.error);
    check(worker.out, 'worker');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
});

// The native datamodel's realms (docs/browser.md, M3): a page's charts run
// in a hidden iframe made at the host's first chart and removed at
// close(), or by the FinalizationRegistry for a host nobody closed; a
// Worker's in its own global. Under a policy that refuses string
// evaluation, a host on the native datamodel is refused at its creation,
// naming the directive, and compileCharts skips its syntax check.
const NATIVE_LOGS = ['count=1:1', 'count=2:1', 'realm=iframe', 't=12:2:2', 't=14:3:2'];

test('the native datamodel in a page (an iframe per host) and a Worker (its own global)', async () => {
  const pw = playwright();
  if (pw === null) {
    console.log('skip: no Playwright installed');
    return;
  }
  const server = await serve(new Map([[napi('page.html'), '<!doctype html><title>tinyactors</title><body>']]));
  const browser = await launch(pw);
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}${napi('page.html')}`);
    const url = napi('wasm/test/native.mjs');
    const out = await page.evaluate(async (u) => (await import(u)).nativeScenario(), url);
    assert.deepEqual(out.logs.sort(), NATIVE_LOGS, 'a page'); // two actors: their lines interleave
    assert.deepEqual(out.frames, [0, 1, 0], 'its iframe, made at the first chart, removed at close()');
    const dropped = await page.evaluate(async (u) => (await import(u)).droppedHost(globalThis.gc), url);
    assert.deepEqual(dropped, [0, 1, 0], 'a host nobody closed: its iframe goes with it');
    const worker = await page.evaluate((u) => new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob([`import(${JSON.stringify(new URL(u, location.href).href)}).then((m) => m.nativeScenario()).then((out) => postMessage({ out }), (error) => postMessage({ error: String(error?.stack ?? error) }));`], { type: 'text/javascript' })), { type: 'module' });
      w.onmessage = (event) => resolve(event.data);
      w.onerror = (event) => resolve({ error: event.message });
    }), url);
    assert.equal(worker.error, undefined, worker.error);
    assert.deepEqual(worker.out.logs.sort(), NATIVE_LOGS.map((line) => (line === 'realm=iframe' ? 'realm=no window' : line)).sort(), 'a Worker');
    assert.deepEqual(worker.out.frames, [null, null, null], 'no iframe in a Worker');
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
});

test('under a policy that refuses string evaluation, a native host is refused at its creation, naming it; a quickjs host runs', async () => {
  const pw = playwright();
  if (pw === null) {
    console.log('skip: no Playwright installed');
    return;
  }
  const body = (scenario) => `<!doctype html><title>policy</title><body><script type="module">
import(${JSON.stringify(napi('wasm/test/native.mjs'))}).then((m) => m.underPolicy()).then((out) => { window.__out = out; }, (error) => { window.__out = { error: String(error?.stack ?? error) }; });
</script>`;
  const pages = {
    'no-unsafe-eval': ["script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'", /'unsafe-eval'/],
    'trusted-types': ["script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; require-trusted-types-for 'script'", /Trusted Types/],
    sandbox: ['sandbox allow-scripts', /sandbox/],
  };
  const served = new Map(Object.entries(pages).map(([name, [policy]]) => [napi(`${name}.html`), { headers: { 'content-security-policy': policy }, body: body(name) }]));
  const server = await serve(served);
  const browser = await launch(pw);
  try {
    for (const [name, [, named]] of Object.entries(pages)) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}${napi(`${name}.html`)}`);
      await page.waitForFunction(() => window.__out !== undefined, null, { timeout: 30000 });
      const out = await page.evaluate(() => window.__out);
      assert.equal(out.error, undefined, `${name}: ${out.error}`);
      assert.equal(out.host[0], 'TA_ERROR_UNSUPPORTED', `${name}: ${out.host}`);
      if (!named.test(out.host[1])) throw new Error(`${name}: the message does not name it: ${out.host[1]}`);
      assert.equal(out.syntaxChecked, false, `${name}: compileCharts skips its syntax check`);
      assert.deepEqual(out.quickjs, ['[2,4,6]'], `${name}: a quickjs host`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
});

// Nothing a host packs crosses between the packages (test/crossing.test.mjs
// in node and bun): a snapshot of @tinyactors/node, made here with the
// addon, is refused in a page by its label, naming the package, and the
// page's snapshot is refused by the addon, naming @tinyactors/wasm.
test('a snapshot crosses neither way between the addon and a page: each refuses the other\'s, naming it', async () => {
  const pw = playwright();
  if (pw === null) {
    console.log('skip: no Playwright installed');
    return;
  }
  const compiled = compileCharts([{ name: 'c.scxml', text: '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="c" initial="s"><state id="s"/></scxml>' }]);
  const addon = new Host({ systemID: 't' });
  addon.addImage(compiled.image);
  compiled.close();
  addon.spawn(addon.chart('c'));
  await addon.idle();
  const snapshot = Array.from(addon.snapshot());
  addon.close();
  const server = await serve(new Map([[napi('page.html'), '<!doctype html><title>tinyactors</title><body>']]));
  const browser = await launch(pw);
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}${napi('page.html')}`);
    const out = await page.evaluate(async ([u, bytes]) => (await import(u)).crossing(bytes), [napi('wasm/test/native.mjs'), snapshot]);
    assert.equal(out.refused?.[0], 'TA_ERROR_INVALID', String(out.refused));
    assert.match(out.refused[1], /^a snapshot of @tinyactors\/node: /);
    assert.throws(() => Host.restore(new Uint8Array(out.own), { systemID: 't' }), (error) => error.status === 'TA_ERROR_INVALID' &&
      /^a snapshot of @tinyactors\/wasm: /.test(error.message));
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
});

await run();
