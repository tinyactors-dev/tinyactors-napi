// A run of the platform on the real clock, in about a second: three
// customers, their devices sampling, and their rules: globex's written as
// conditions, initech's as a chart, and acme's every upload of uploads/,
// most of them buggy or hostile. At the end each customer's inbox is
// summarized, and globex's alerts are checked against the samples its
// devices sent: whatever acme's rules did, globex's ran as if alone.
//
//   node examples/iot-rules/main.mjs [--samples N] [--seed S]
//   node examples/iot-rules/main.mjs --measure [--default-max-ops]
//   node examples/iot-rules/main.mjs --compare
//
// --measure prints how long a `while (true) {}` holds the host and what a
// rule costs per device; with --default-max-ops it also measures the
// engine's default limit, which takes about half a minute. --compare runs
// the hostile rules on the native datamodel.
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { costPerDevice, holdTimes, nativeEscape, nativeRule, neighbourDelay } from './measure.mjs';
import { Platform, SANDBOX } from './platform.mjs';

/** A small seeded generator (mulberry32), so a run can be repeated. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UPLOADS = new URL('./uploads/', import.meta.url);

/** The alerts globex's overheat rule must raise for a device's samples:
 * raised at the second hot reading in a row, cleared at the next cool one. */
function expectedOverheat(values) {
  const events = [];
  let streak = 0;
  let firing = false;
  for (const value of values) {
    const hot = value > 80;
    if (firing && !hot) { firing = false; events.push(`cleared ${value}`); }
    streak = hot ? streak + 1 : 0;
    if (!firing && streak >= 2) { firing = true; events.push(`raised ${value}`); }
  }
  return events;
}

/** Runs the platform for `samples` samples a device; answers a summary. */
export async function run({ samples = 40, seed = 1, quiet = false } = {}) {
  const say = quiet ? () => {} : (...args) => console.log(...args);
  const next = random(seed);
  const platform = new Platform();
  for (const customer of ['acme', 'globex', 'initech']) platform.addCustomer(customer);
  const devices = {
    acme: ['acme-oven', 'acme-door'],
    globex: ['globex-boiler', 'globex-chiller'],
    initech: ['initech-door', 'initech-server'],
  };
  for (const [customer, ids] of Object.entries(devices)) for (const id of ids) platform.addDevice({ id, customer });

  platform.addRule('globex', { id: 'overheat', when: "reading.metric === 'temp' && reading.value > 80", message: "'hot: ' + reading.value", sustain: 2 });
  platform.addRule('globex', { id: 'freezing', when: "reading.metric === 'temp' && reading.value < 0", devices: ['globex-chiller'] });
  platform.uploadChart('initech', { file: 'door-left-open.scxml', text: readFileSync(new URL('door-left-open.scxml', UPLOADS), 'utf8') });
  platform.addRule('initech', { id: 'server-hot', when: "reading.metric === 'temp' && reading.value > 90" });
  for (const file of readdirSync(UPLOADS).sort()) {
    platform.uploadChart('acme', { file, text: readFileSync(new URL(file, UPLOADS), 'utf8') });
  }

  // samples: temperatures wandering from 80, doors opening and closing
  const sent = new Map();
  const temps = new Map();
  const audits = setInterval(() => platform.audit(), 20);
  try {
    for (let i = 0; i < samples; i++) {
      for (const [customer, ids] of Object.entries(devices)) {
        for (const id of ids) {
          let metric;
          let value;
          if (id.endsWith('door')) {
            metric = 'door';
            value = next() < 0.6 ? 1 : 0;
          } else {
            metric = 'temp';
            value = Math.round((temps.get(id) ?? 80) + (next() - 0.5) * 16);
            temps.set(id, value);
          }
          if (!sent.has(id)) sent.set(id, []);
          sent.get(id).push(value);
          platform.sample(id, metric, value);
        }
      }
      await sleep(2);
    }
    await platform.settle();
  } finally {
    clearInterval(audits);
  }

  const summary = { alerts: {}, suspended: [], rejected: [] };
  for (const customer of Object.keys(devices)) {
    const inbox = platform.inbox(customer);
    const count = (type) => inbox.filter((m) => m.type === type).length;
    const violations = new Map();
    summary.alerts[customer] = count('alert');
    say(`${customer}: ${count('rule.installed')} rules installed, ${count('rule.rejected')} rejected; ` +
      `${count('alert')} alerts, ${count('rule.error')} error reports, ${count('rule.violation')} violations, ${count('rule.suspended')} suspended`);
    for (const m of inbox) {
      if (m.type === 'rule.rejected') { summary.rejected.push(m.rule); say(`  rejected ${m.rule}: ${m.diagnostics.join('; ')}`); }
      if (m.type === 'rule.violation') violations.set(`${m.rule}: ${m.what}`, (violations.get(`${m.rule}: ${m.what}`) ?? 0) + 1);
      if (m.type === 'rule.suspended') { summary.suspended.push(m.rule); say(`  suspended ${m.rule}: ${m.reason}`); }
    }
    for (const [what, times] of violations) say(`  violation by ${what}${times > 1 ? ` (${times} times)` : ''}`);
  }

  // globex's alerts, against what its samples say they must be
  for (const device of devices.globex) {
    const got = platform.inbox('globex')
      .filter((m) => m.type === 'alert' && m.rule === 'overheat' && m.device === device)
      .map((m) => `${m.event.split('.')[1]} ${m.data.value}`);
    const want = expectedOverheat(sent.get(device));
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${device}: alerts ${got} but samples say ${want}`);
    say(`globex's ${device}: ${got.length} alerts, each where its samples say`);
  }
  for (const [customer, rule] of [['globex', 'overheat'], ['initech', 'door-left-open']]) {
    const cost = await platform.cost(customer, rule);
    say(`${customer}'s ${rule}: ${cost.devices} devices, ${cost.regionBytes} bytes of region, ${cost.slabBytesUsed} of them in use, fuel ${cost.fuel}`);
  }
  platform.close();
  return summary;
}

/** The README's numbers. */
async function measure({ defaultMaxOps }) {
  console.log(`${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.cpus().length} CPUs, ${os.platform()} ${os.release()}; ` +
    `${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`);
  const median = (times) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)].toFixed(1);
  const sandboxes = [['configured', SANDBOX]];
  if (defaultMaxOps) sandboxes.push(['default', {}]);
  for (const [name, sandbox] of sandboxes) {
    for (const loop of ['empty', 'spin']) {
      if (name === 'default' && loop === 'spin') continue; // minutes
      const { times } = await holdTimes(sandbox, name === 'default' ? 1 : 5, { loop });
      console.log(`${loop === 'empty' ? 'while (true) {}' : "spin.scxml's loop"}: held the host ${median(times)} ms on the ${name} maxOps (${sandbox.maxOps ?? 'the engine\'s 1,000,000'})`);
    }
  }
  console.log(`another customer's alert waited ${(await neighbourDelay(SANDBOX)).toFixed(1)} ms behind it`);
  for (const datamodel of ['quickjs', 'native']) {
    for (const declaring of [false, true]) {
      const cost = await costPerDevice(datamodel, 2000, { declaring });
      console.log(`${datamodel}${declaring ? ', a script that declares' : ''}: per device ${cost.regionPerDevice} B of region ` +
        `(${cost.slabBytes} B of its slab in use), ${cost.residentBytes} B resident`);
    }
  }
}

async function compare() {
  const found = await nativeEscape();
  console.log(`nosy on native: globals ${found.globals}; escape: ${found.escape} (this process is ${process.pid})`);
  const spin = await nativeRule('spin', 2000);
  console.log(`spin on native: ${spin.stopped ? 'stopped' : 'still running after 2 s, killed'}`);
  const start = performance.now();
  const hoard = await nativeRule('hoard', 60_000, { heapMB: 128 });
  console.log(`hoard on native: ${hoard.stopped ? 'stopped' : hoard.killed ? 'still running after 60 s, killed' : `the process ended (${hoard.signal ?? `exit ${hoard.code}`}) after ${((performance.now() - start) / 1000).toFixed(1)} s: ${hoard.error}`}`);
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      samples: { type: 'string', default: '40' }, seed: { type: 'string', default: '1' },
      measure: { type: 'boolean' }, 'default-max-ops': { type: 'boolean' }, compare: { type: 'boolean' },
    },
  });
  if (values.measure) await measure({ defaultMaxOps: values['default-max-ops'] });
  else if (values.compare) await compare();
  else await run({ samples: Number(values.samples), seed: Number(values.seed) });
}
