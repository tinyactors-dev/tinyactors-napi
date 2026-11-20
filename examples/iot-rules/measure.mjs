// The measurements the README states: how long a `while (true) {}` holds
// the host, what a rule costs per device, and what the same rules do on
// the native datamodel. `main.mjs --measure` and `--compare` print them;
// test.mjs runs small versions of each.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Host, SimulatedClock } from '@tinyactors/node';
import { fillTemplate, image } from './check.mjs';
import { Platform } from './platform.mjs';

const TEMPLATE = readFileSync(new URL('./charts/rule-template.scxml', import.meta.url), 'utf8');

const upload = (name) => readFileSync(new URL(`./uploads/${name}`, import.meta.url), 'utf8');

/** Milliseconds from a reading to the spin rule's next idle turn, each of
 * `runs` readings (`loop`: spin.scxml's own, or the empty one): how long one `while (true) {}` holds the host, and the
 * thread every host of the process shares. `sandbox` is the quickjs
 * options; `{}` is the engine's default. */
export async function holdTimes(sandbox, runs = 3, { loop = 'spin' } = {}) {
  // spin.scxml's loop reads a property in each round; 'empty' is the
  // quickjs guide's `while (true) {}`
  const spin = loop === 'empty' ? upload('spin.scxml').replace('while (_event.data.value !== null) {}', 'while (true) {}') : upload('spin.scxml');
  const host = new Host(image({ 'spin.scxml': spin }), { system: 'hold', datamodel: 'quickjs', quickjs: sandbox });
  const session = host.spawn('spin');
  await host.idle();
  const times = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    host.send(session, 'reading', { device: 'd', metric: 'temp', value: run, seq: run });
    await host.idle();
    times.push(performance.now() - start);
  }
  const stats = await host.hostStats();
  host.close();
  return { times, errorsExecution: stats.charts[0].errorsExecution };
}

/** A reading for each of two customers at once: one customer's spin rule
 * and the other's well-behaved rule. Answers how long the well-behaved
 * rule's alert waited: the spin holds the thread, not only its own host. */
export async function neighbourDelay(sandbox) {
  const platform = new Platform({ sandbox });
  platform.addCustomer('acme');
  platform.addCustomer('globex');
  platform.addDevice({ id: 'acme-oven', customer: 'acme' });
  platform.addDevice({ id: 'globex-boiler', customer: 'globex' });
  platform.uploadChart('acme', { file: 'spin.scxml', text: upload('spin.scxml') });
  platform.addRule('globex', { id: 'overheat', when: 'reading.value > 80' });
  await platform.settle({ rounds: 1 });
  const start = performance.now();
  let delay;
  const inbox = platform.inbox('globex');
  platform.sample('acme-oven', 'temp', 99);
  platform.sample('globex-boiler', 'temp', 99);
  while (delay === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
    if (inbox.some((m) => m.type === 'alert')) delay = performance.now() - start;
  }
  platform.close();
  return delay;
}

/** The bytes a template rule costs per device it watches, from the rule
 * host's counters: `devices` actors, one reading each. The region is
 * sized up front (`maxActors`), so its growth is the actors' own, not a
 * pool doubling. Also the process's resident growth, which includes the
 * engine's heap: hostStats does not count quickjs's
 * (`host.quickjsHeapBytes` does). */
export async function costPerDevice(datamodel, devices = 1000, { declaring = false } = {}) {
  const clock = new SimulatedClock();
  let text = fillTemplate(TEMPLATE, { id: 'overheat', when: "reading.metric === 'temp' && reading.value > 80", message: "'hot: ' + reading.value" });
  // a chart-level script that declares a name: a context per actor
  if (declaring) text = text.replace('</datamodel>', "</datamodel>\n  <script>var unit = 'C';</script>");
  const ruleHost = (maxActors) => new Host(image({ 'overheat.scxml': text }), {
    system: 'cost', config: { system: { maxActors } }, clock, datamodel, ...(datamodel === 'quickjs' ? { quickjs: { maxOps: 200, memoryLimit: 1 << 30 } } : {}),
    ioProcessors: { 'urn:iot:alert': { receive: () => {} } },
  });
  // the region of a host sized for one actor, against one sized for all
  const probe = ruleHost(1);
  const smallest = (await probe.hostStats()).host.regionBytes;
  probe.close();
  const host = ruleHost(devices + 1);
  await host.idle();
  globalThis.gc?.();
  const before = { stats: await host.hostStats(), rss: process.memoryUsage().rss };
  for (let i = 0; i < devices; i++) {
    const session = host.spawn('overheat', { name: `d${i}`, params: { device: `d${i}`, sustain: 2 } });
    host.send(session, 'reading', { device: `d${i}`, metric: 'temp', value: 50 + (i % 60), seq: 1 });
  }
  await host.idle();
  globalThis.gc?.();
  const after = { stats: await host.hostStats(), rss: process.memoryUsage().rss };
  host.close();
  const per = (f) => Math.round((f(after) - f(before)) / devices);
  return {
    datamodel,
    declaring,
    devices,
    slabBytes: per((m) => m.stats.pools[0].slabBytes.used),
    actorsCapacity: after.stats.pools[0].actors.capacity,
    regionPerDevice: Math.round((after.stats.host.regionBytes - smallest) / devices),
    residentBytes: per((m) => m.rss),
  };
}

/** The nosy rule (uploads/nosy.scxml) on the native datamodel: what its
 * alert found. On native it reaches the process. */
export async function nativeEscape() {
  const found = [];
  const host = new Host(image({ 'nosy.scxml': upload('nosy.scxml') }), {
    system: 'native-nosy',
    datamodel: 'native',
    ioProcessors: { 'urn:iot:alert': { receive: (send) => found.push({ ...send.data }) } },
  });
  host.send(host.spawn('nosy'), 'reading', { device: 'd', metric: 'temp', value: 1, seq: 1 });
  await host.idle();
  host.close();
  return found[0];
}

/** An upload on the native datamodel, in a child process
 * (native-rule.mjs): answers whether the rule's evaluation ended within
 * `waitMs`, and how the child ended (killed after `waitMs`). No limit
 * stops the spin: the thread is lost. The hoard runs until the engine's
 * heap is exhausted, which ends the process: `heapMB` caps Node.js's heap
 * so that it comes soon (Bun takes no such flag). */
export function nativeRule(name, waitMs, { heapMB } = {}) {
  return new Promise((resolve, reject) => {
    const flags = heapMB && !process.versions.bun ? [`--max-old-space-size=${heapMB}`] : [];
    const script = new URL('./native-rule.mjs', import.meta.url).pathname;
    const child = spawn(process.execPath, [...flags, script, name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let timer;
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('started') && !timer) timer = setTimeout(() => child.kill('SIGKILL'), waitMs);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ stopped: output.includes('stopped'), killed: signal === 'SIGKILL', code, signal, error: errors.split('\n').find((line) => line.includes('FATAL ERROR')) ?? '' });
    });
  });
}
