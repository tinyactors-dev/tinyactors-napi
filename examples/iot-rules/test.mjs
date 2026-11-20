// The platform's cases on a SimulatedClock: devices and their edge logic,
// a customer's rule raising and clearing, every hostile and buggy upload
// reported to its customer without stopping anyone else's rules; then the
// measurements of measure.mjs at a small size, the same rules on the native
// datamodel, and the demo of main.mjs. Run by `mise run examples`
// (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Host, SimulatedClock } from '@tinyactors/node';
import { escapeXML, image } from './check.mjs';
import { costPerDevice, holdTimes, nativeEscape, nativeRule, neighbourDelay } from './measure.mjs';
import { run } from './main.mjs';
import { Platform, SANDBOX } from './platform.mjs';

const upload = (name) => readFileSync(new URL(`./uploads/${name}`, import.meta.url), 'utf8');

/** Two customers with a device each, and globex's well-behaved rule. */
async function setup(options = {}) {
  const clock = new SimulatedClock();
  const platform = new Platform({ clock, ...options });
  platform.addCustomer('acme');
  platform.addCustomer('globex');
  platform.addDevice({ id: 'acme-oven', customer: 'acme' });
  platform.addDevice({ id: 'globex-boiler', customer: 'globex' });
  assert.deepEqual(platform.addRule('globex', {
    id: 'overheat', when: "reading.metric === 'temp' && reading.value > 80", message: "'hot: ' + reading.value", sustain: 2,
  }), { ok: true });
  await platform.settle();
  return { clock, platform };
}

/** Sends `value` from both devices, `times` times, settling after each. */
async function readings(platform, value, times = 1) {
  for (let i = 0; i < times; i++) {
    platform.sample('acme-oven', 'temp', value + i);
    platform.sample('globex-boiler', 'temp', value + i);
    await platform.settle();
  }
}

const of = (platform, customer, type, rule) =>
  platform.inbox(customer).filter((m) => m.type === type && (rule === undefined || m.rule === rule));

/** Globex's rule still works: two hot readings raise its alert. */
async function globexStillAlerts(platform) {
  const before = of(platform, 'globex', 'alert').length;
  for (const value of [95, 96]) {
    platform.sample('globex-boiler', 'temp', value);
    await platform.settle();
  }
  const alerts = of(platform, 'globex', 'alert').slice(before);
  assert.deepEqual(alerts.map((a) => [a.event, a.data.message]), [['alert.raised', 'hot: 96']]);
}

test('a template rule raises after `sustain` readings and clears; only its customer\'s devices reach it', async () => {
  const { platform } = await setup();
  try {
    await readings(platform, 85, 2); // 85, 86 from both devices: acme's do not reach globex's rule
    await readings(platform, 50);
    assert.deepEqual(of(platform, 'globex', 'alert').map((a) => [a.event, a.device, a.data.value]), [
      ['alert.raised', 'globex-boiler', 86],
      ['alert.cleared', 'globex-boiler', 50],
    ]);
    assert.deepEqual(of(platform, 'acme', 'alert'), []);
    assert.equal((await platform.cost('globex', 'overheat')).devices, 1, 'one actor, for globex-boiler only');
  } finally {
    platform.close();
  }
});

test('devices: a sample within the deadband is dropped, a malformed one reported, silence is offline', async () => {
  const { clock, platform } = await setup();
  try {
    platform.addDevice({ id: 'globex-tank', customer: 'globex', deadband: 5 });
    assert.equal(platform.addRule('globex', { id: 'tank-log', when: 'true', message: "'level ' + reading.value + ' #' + reading.seq", devices: ['globex-tank'] }).ok, true);
    for (const value of [10, 12, 16, 'full', 17, 22]) {
      platform.sample('globex-tank', 'level', value);
      await platform.settle();
    }
    // 12 is within 5 of 10, 17 within 5 of 16: dropped at the device
    assert.deepEqual(of(platform, 'globex', 'alert', 'tank-log').map((a) => a.data.message), ['level 10 #1']);
    assert.deepEqual(of(platform, 'globex', 'device.malformed').map((m) => m.sample), ['{"metric":"level","value":"full"}']);
    const fired = await platform.cost('globex', 'tank-log');
    assert.equal(fired.devices, 1);

    clock.increment(29_999);
    await platform.settle();
    assert.equal(of(platform, 'globex', 'device.offline').length, 0, 'the last sample restarted the watchdog');
    clock.increment(1);
    await platform.settle();
    assert.deepEqual(of(platform, 'globex', 'device.offline').map((m) => m.device).sort(), ['globex-boiler', 'globex-tank']);
    platform.sample('globex-tank', 'level', 40);
    await platform.settle();
    assert.deepEqual(of(platform, 'globex', 'device.online').map((m) => m.device), ['globex-tank']);
  } finally {
    platform.close();
  }
});

test('uploads that do not compile are refused with the compiler\'s line numbers, and the JavaScript is checked too', async () => {
  const { platform } = await setup();
  try {
    assert.deepEqual(platform.uploadChart('acme', { file: 'broken.scxml', text: upload('broken.scxml') }).diagnostics, [
      'broken.scxml:8:38: error: XML: expected quoted attribute value',
    ]);
    // compileCharts parses its JavaScript, at the line and column of the
    // element (the engine's own message follows: V8's and JavaScriptCore's differ)
    const where = (diagnostics) => diagnostics.map((d) => d.slice(0, d.indexOf('SyntaxError: ') + 'SyntaxError'.length));
    assert.deepEqual(where(platform.uploadChart('acme', { file: 'typo.scxml', text: upload('typo.scxml') }).diagnostics), [
      'typo.scxml:8:5: error: cond: SyntaxError',
      'typo.scxml:12:7: error: <script>: SyntaxError',
    ]);
    assert.deepEqual(platform.uploadChart('acme', { file: 'peeker.scxml', text: upload('peeker.scxml') }).diagnostics, [
      'peeker.scxml:5:14: error: src="file:///etc/passwd" requires a resolver',
    ]);
    assert.match(platform.uploadChart('acme', { file: 'x.scxml', text: upload('spin.scxml').replace(' datamodel="ecmascript"', '') }).diagnostics[0], /datamodel="ecmascript"/);
    assert.match(platform.uploadChart('acme', { file: 'x.scxml', text: upload('spin.scxml').replace('name="spin"', 'name="../etc"') }).diagnostics[0], /needs a name/);
    assert.match(platform.uploadChart('acme', { file: 'big.scxml', text: 'x'.repeat(70_000) }).diagnostics[0], /at most 65536 bytes/);

    assert.deepEqual(where(platform.addRule('acme', { id: 'half', when: 'reading.value >' }).diagnostics), ['when:1:1: error: SyntaxError']);
    // an attempt to close the template's attribute is text in it, and not
    // JavaScript either
    const injection = 'true" target="tinyactors://fleet/@globex-boiler';
    assert.match(platform.addRule('acme', { id: 'inject', when: injection }).diagnostics[0], /^when:1:1: error: SyntaxError/);
    assert.ok(escapeXML(injection).includes('&quot;'));
    assert.deepEqual(platform.addRule('acme', { id: 'Bad Name', when: 'true' }).diagnostics, ['not a rule id: "Bad Name"']);
    assert.deepEqual(platform.addRule('acme', { id: 'overheat', when: 'true' }).ok, true, 'rule ids are per customer');
    assert.deepEqual(platform.addRule('acme', { id: 'overheat', when: 'true' }).diagnostics, ['a rule named overheat exists']);

    const rejected = of(platform, 'acme', 'rule.rejected').map((m) => m.rule);
    assert.deepEqual(rejected, ['broken', 'typo', 'peeker', 'spin', 'x.scxml', 'big.scxml', 'half', 'inject', 'Bad Name', 'overheat']);
    await globexStillAlerts(platform);
  } finally {
    platform.close();
  }
});

test('a rule that loops forever is stopped by maxOps, reported and suspended; the other customer\'s rule goes on', async () => {
  const { platform } = await setup();
  try {
    assert.equal(platform.uploadChart('acme', { file: 'spin.scxml', text: upload('spin.scxml') }).ok, true);
    const start = performance.now();
    await readings(platform, 50, 3);
    const held = performance.now() - start;
    assert.deepEqual(of(platform, 'acme', 'rule.error', 'spin').map((m) => [m.error, m.count]), [
      ['error.execution', 1], ['error.execution', 1], ['error.execution', 1],
    ]);
    assert.deepEqual(of(platform, 'acme', 'rule.suspended', 'spin').map((m) => m.reason), ['3 errors']);
    assert.ok(held < 5000, `three spins held the host ${held} ms`);
    await readings(platform, 50); // suspended: nothing more to report
    assert.equal(of(platform, 'acme', 'rule.error', 'spin').length, 3);
    await globexStillAlerts(platform);
  } finally {
    platform.close();
  }
});

test('one engine for two rules: a rule that hoards memory makes its neighbour fail, so each rule has a host of its own', async () => {
  // what the platform avoids: two rules' actors in one quickjs host
  const host = new Host([image({ 'hoard.scxml': upload('hoard.scxml') }), image({ 'rolling-average.scxml': upload('rolling-average.scxml') })], {
    system: 'shared', datamodel: 'quickjs', quickjs: SANDBOX, ioProcessors: { 'urn:iot:alert': { receive: () => {} } },
  });
  try {
    const hoard = host.spawn('hoard');
    const average = host.spawn('rolling-average', { params: { device: 'd' } });
    const reading = { device: 'd', metric: 'temp', value: 90, seq: 1 };
    host.send(average, 'reading', reading);
    await host.idle();
    host.send(hoard, 'reading', reading);
    await host.idle();
    host.send(average, 'reading', reading);
    await host.idle();
    const counters = Object.fromEntries((await host.hostStats()).charts.map((c) => [c.name, c.errorsExecution]));
    assert.deepEqual(counters, { hoard: 1, 'rolling-average': 1 }, 'the average failed on memory it did not take');
  } finally {
    host.close();
  }

  // on the platform the hoarder fails alone, and is suspended
  const { platform } = await setup();
  try {
    platform.uploadChart('acme', { file: 'hoard.scxml', text: upload('hoard.scxml') });
    platform.uploadChart('acme', { file: 'rolling-average.scxml', text: upload('rolling-average.scxml') });
    for (const value of [90, 90, 90, 50]) {
      platform.sample('acme-oven', 'temp', value);
      await platform.settle();
    }
    assert.deepEqual(of(platform, 'acme', 'rule.error').map((m) => m.rule), ['hoard', 'hoard', 'hoard']);
    assert.deepEqual(of(platform, 'acme', 'rule.suspended').map((m) => m.rule), ['hoard']);
    assert.deepEqual(of(platform, 'acme', 'alert').map((m) => [m.rule, m.event, m.data?.message]), [
      ['rolling-average', 'alert.raised', 'average 90.0 over 1 readings'],
      ['rolling-average', 'alert.cleared', undefined],
    ]);
  } finally {
    platform.close();
  }
});

test('a rule that throws, or reads what is not there, is reported each time until suspended', async () => {
  const { platform } = await setup({ maxErrors: 4 });
  try {
    platform.uploadChart('acme', { file: 'thrower.scxml', text: upload('thrower.scxml') });
    await readings(platform, 20, 2);
    // the condition throws (no location), so the transition is not taken:
    // one error a reading; the throw in the script is never reached
    assert.deepEqual(of(platform, 'acme', 'rule.error', 'thrower').map((m) => m.count), [1, 1]);
    assert.deepEqual(of(platform, 'acme', 'rule.suspended'), []);
    await readings(platform, 20, 2);
    assert.deepEqual(of(platform, 'acme', 'rule.suspended').map((m) => m.reason), ['4 errors']);
    await globexStillAlerts(platform);
  } finally {
    platform.close();
  }
});

test('a rule that looks for process, require or a way out of the sandbox finds nothing', async () => {
  const { platform } = await setup();
  try {
    platform.uploadChart('acme', { file: 'nosy.scxml', text: upload('nosy.scxml') });
    await readings(platform, 20);
    assert.deepEqual(of(platform, 'acme', 'alert', 'nosy').map((m) => m.data), [{
      globals: 'undefined undefined undefined undefined undefined', escape: 'refused: ReferenceError',
    }]);
    // require(...) in its script: error.execution
    assert.deepEqual(of(platform, 'acme', 'rule.error', 'nosy').map((m) => m.error), ['error.execution']);
  } finally {
    platform.close();
  }
});

test('a rule that sends to a device, to another customer\'s rule or to a server is refused and reported', async () => {
  const { platform } = await setup();
  try {
    platform.uploadChart('acme', { file: 'rogue.scxml', text: upload('rogue.scxml') });
    await readings(platform, 20);
    assert.deepEqual(of(platform, 'acme', 'rule.violation', 'rogue').map((m) => m.what), [
      'sent reboot to tinyactors://fleet/@globex-boiler',
      'sent reading to tinyactors://rule-globex-overheat/@globex-boiler',
    ]);
    // the two refused sends are error.communication; the BasicHTTP send,
    // to a type the rule's host does not have, error.execution
    const errors = {};
    for (const m of of(platform, 'acme', 'rule.error', 'rogue')) errors[m.error] = (errors[m.error] ?? 0) + m.count;
    assert.deepEqual(errors, { 'error.execution': 1, 'error.communication': 2 });
    assert.deepEqual(of(platform, 'acme', 'rule.suspended', 'rogue').map((m) => m.reason), ['3 errors']);
    assert.deepEqual(of(platform, 'globex', 'alert'), [], 'the forged reading of 1000 never reached globex');
  } finally {
    platform.close();
  }
});

test('a rule that invokes a service does not end the process: its invoker gets error.communication', async () => {
  const { platform } = await setup();
  try {
    platform.uploadChart('acme', { file: 'invoker.scxml', text: upload('invoker.scxml') });
    await readings(platform, 20);
    assert.deepEqual(of(platform, 'acme', 'rule.error', 'invoker').map((m) => [m.error, m.count]), [['error.communication', 1]]);
    assert.deepEqual(of(platform, 'acme', 'rule.violation', 'invoker'), []);
    await globexStillAlerts(platform);
  } finally {
    platform.close();
  }
});

test('a rule that keeps its host busy for ever is found by its fuel and suspended', async () => {
  const { platform } = await setup();
  try {
    platform.uploadChart('acme', { file: 'busy.scxml', text: upload('busy.scxml') });
    await readings(platform, 20); // settle cannot wait for its host: it waits its patience, then audits
    assert.deepEqual(of(platform, 'acme', 'rule.suspended', 'busy').map((m) => m.reason.split(':')[0]), ['busy']);
    assert.deepEqual(of(platform, 'acme', 'rule.error', 'busy'), [], 'no limit of the sandbox applies');
    await globexStillAlerts(platform);
  } finally {
    platform.close();
  }
});

test('measured: how long a while (true) holds the host, and every host of the thread', async () => {
  const { times, errorsExecution } = await holdTimes(SANDBOX, 2);
  assert.equal(errorsExecution, 2);
  for (const ms of times) assert.ok(ms < 2000, `a spin held the host ${ms} ms on maxOps ${SANDBOX.maxOps}`);
  const delay = await neighbourDelay(SANDBOX);
  assert.ok(delay < 2000, `the other customer's alert waited ${delay} ms`);
});

test('measured: a rule\'s bytes per device in its host\'s region', async () => {
  const cost = await costPerDevice('quickjs', 200);
  assert.equal(cost.actorsCapacity, 201);
  assert.ok(cost.slabBytes > 0 && cost.slabBytes < 1024, `${cost.slabBytes} B of slab a device`);
  assert.ok(cost.regionPerDevice > 0 && cost.regionPerDevice < 4096, `${cost.regionPerDevice} B of region a device`);
});

test('the same rules on the native datamodel: one reaches the process, one never stops', async () => {
  const found = await nativeEscape();
  assert.equal(found.globals, 'undefined undefined undefined undefined undefined', 'no globals of the process');
  assert.equal(found.escape, `pid ${process.pid}`, 'but the outer realm\'s Function constructor is the process\'s');
  const spin = await nativeRule('spin', 300);
  assert.deepEqual([spin.stopped, spin.killed], [false, true]);
});

test('main.mjs: a day of the platform on the real clock', async () => {
  const summary = await run({ samples: 30, quiet: true });
  assert.ok(summary.alerts.globex > 0, 'globex got its alerts');
  assert.deepEqual(summary.suspended.sort(), ['busy', 'hoard', 'nosy', 'rogue', 'spin', 'thrower']);
  assert.deepEqual(summary.rejected.sort(), ['broken', 'peeker', 'typo']);
});
