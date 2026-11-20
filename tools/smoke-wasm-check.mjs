// The checks of @tinyactors/wasm's smoke test, runtime-neutral: node and
// bun (tools/smoke-wasm.mjs), a Chromium page and a module Worker
// (tools/smoke-wasm-browser.mjs) run them in a fresh project that installed
// the package from its tarball. `load(entry)` answers the module namespace
// of an entry: 'init' (@tinyactors/wasm/init) or '.' (@tinyactors/wasm). It
// imports nothing by a bare name, since a Worker has no import map.
//
// Through the init entry first: a call before init() settles throws
// TA_ERROR_STATE, then init() loads the module beside the package's files.
// Then through each entry: a counter on each datamodel (native, and
// quickjs in the same module), three events, its count from its log line, a typed method's promise (the convenience
// layer), and a value through the codec. Answers the failures, an array of
// strings.

const COUNTER = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="s">
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="s">
    <transition event="inc"><assign location="n" expr="n + 1"/></transition>
    <transition event="report"><log label="count" expr="n"/></transition>
  </state>
</scxml>`;

async function count({ compileCharts, Host }, datamodel) {
  const lines = [];
  const host = new Host([], { system: 'smoke', datamodel, log: (entry) => lines.push(entry.text) });
  try {
    const compiled = compileCharts([{ name: 'counter.scxml', text: COUNTER }]);
    try {
      host.addImage(compiled.image);
    } finally {
      compiled.close();
    }
    const session = host.spawn(host.chart('counter'));
    for (const value of [1, 'two', { three: [3] }]) host.send(session, 'inc', value);
    host.send(session, 'report');
    await host.idle();
    const stats = await host.hostStats();
    if (stats.host.actors !== 1) lines.push(`hostStats answered ${stats.host.actors} actors, not 1`);
  } finally {
    host.close();
  }
  return lines;
}

const bytes = (k, v) => (v instanceof Uint8Array ? [...v] : v);

async function entry(api, name, failures) {
  for (const datamodel of ['native', 'quickjs']) {
    const lines = await count(api, datamodel);
    if (lines.length !== 1 || lines[0] !== '3') failures.push(`${name}, ${datamodel}: the counter logged ${JSON.stringify(lines)}, not 3`);
  }
  const value = { n: [1, 2.5, 'x', null, true, new Uint8Array([0])] };
  const back = api.decode(api.encode(value));
  if (!(back.n[5] instanceof Uint8Array) || JSON.stringify(back, bytes) !== JSON.stringify(value, bytes)) {
    failures.push(`${name}: the codec does not round-trip ${JSON.stringify(back, bytes)}`);
  }
}

export async function check(load) {
  const failures = [];
  const init = await load('init');
  if (typeof init.init !== 'function') failures.push('@tinyactors/wasm/init exports no init()');
  try {
    init.encode(1);
    failures.push('@tinyactors/wasm/init: a call before init() did not throw');
  } catch (error) {
    if (error?.status !== 'TA_ERROR_STATE') failures.push(`@tinyactors/wasm/init: a call before init() threw ${error}, not TA_ERROR_STATE`);
  }
  await init.init();
  await entry(init, '@tinyactors/wasm/init', failures);
  const main = await load('.');
  if (main.Host !== init.Host) failures.push('the two entries export different Host classes');
  await entry(main, '@tinyactors/wasm', failures);
  return failures;
}
