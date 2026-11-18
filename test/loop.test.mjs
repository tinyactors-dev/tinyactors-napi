// The loop on the event loop (docs/plan.xml, p1-loop): idle() as a
// promise of the next idle turn, nextDeadline, close() with a waiting
// idle(), SimulatedClock in milliseconds and the hosts it holds weakly;
// with actors (p1-compile): a send that runs its actor with no driver
// called, the statuses TA_RUN_EFFECTS, TA_RUN_EFFECTS_FULL and
// TA_RUN_YIELDED, the bound that yields to I/O, one timer at a deadline,
// and none on a simulated clock; with handlers (p1-effects): a handler's
// error thrown from the turn's callback when no idle() waits, the host
// going on, and close() from a handler deferred to the end of the turn.
// TA_RUN_EXHAUSTED and TA_RUN_FAULT need an allocator that refuses or a
// run core refuses, which no input of the public API makes (log entry
// l-p1-compile-unreachable-statuses).
import { spawnSync } from 'node:child_process';
import { Host, SimulatedClock, TinyactorsError } from '@tinyactors/node';
import { ENDER, ENGINE, hostWith, scxml, sleep } from './charts.mjs';
import { collect, run, test } from './harness.mjs';
import { macrotask } from './runtime.mjs';

const CONFIG = { systemID: 't' };

function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: ${actual}, expected ${expected}`);
}

function throws(body, check, what) {
  try {
    body();
  } catch (error) {
    check(error);
    return;
  }
  throw new Error(`${what}: not refused`);
}

const typeError = (error) => {
  if (!(error instanceof TypeError)) throw error;
};
const rangeError = (error) => {
  if (!(error instanceof RangeError)) throw error;
};
const stateError = (error) => {
  if (!(error instanceof TinyactorsError)) throw error;
  equal(error.status, 'TA_ERROR_STATE', 'status');
};

const tick = () => macrotask();

test('idle() on a fresh host settles at the next turn, with no driver called', async () => {
  const host = new Host(CONFIG, ENGINE);
  const first = host.idle();
  if (!(first instanceof Promise)) throw new Error('idle() gave no promise');
  equal(host.idle(), first, 'the same promise until it settles');
  equal(await first, undefined, 'its value');
  const second = host.idle();
  if (second === first) throw new Error('a settled promise was given again');
  await second;
  host.close();
});

test('nextDeadline is undefined with nothing due, and on a closed host', async () => {
  const host = new Host(CONFIG, ENGINE);
  equal(host.nextDeadline, undefined, 'before a turn');
  await host.idle();
  equal(host.nextDeadline, undefined, 'after an idle turn with no deadline');
  host.close();
  equal(host.nextDeadline, undefined, 'closed');
});

test('idle() on a closed host returns a rejected promise', async () => {
  const host = new Host(CONFIG, ENGINE);
  host.close();
  const promise = host.idle(); // no throw at the call
  let error;
  try { await promise; } catch (caught) { error = caught; }
  stateError(error, 'idle() after close');
});

test('idle() waits for the promises handlers return: a log handler\'s, a typed method\'s, a service\'s', async () => {
  const chart = scxml('waits', `
    <state id="s">
      <onentry><log label="hello" expr="1"/></onentry>
      <invoke type="urn:test:slow" id="slow" src="x"/>
      <transition event="done.invoke.slow" target="end"/>
    </state>
    <final id="end"/>`);
  const seen = [];
  const later = (what) => sleep(20).then(() => seen.push(what));
  const host = hostWith({ waits: chart }, {
    log: () => later('log'),
    services: { 'urn:test:slow': (h, invocation) => later('service').then(() => { invocation.done(); return {}; }) },
  });
  const session = host.spawn(host.chart('waits'), { name: 'w' });
  host.actorState({ session }, () => later('onResult'));
  await host.idle();
  equal(seen.sort().join(), 'log,onResult,service', 'every promise settled');
  equal(host.actorByName('w'), undefined, 'the done the service gave ran too');
  // a promise that rejects is still an unhandled rejection, and idle() resolves
  const reasons = [];
  const listener = (reason) => reasons.push(reason?.message);
  process.on('unhandledRejection', listener);
  try {
    const other = hostWith({ waits: chart }, {
      log: () => sleep(5).then(() => { throw new Error('late'); }),
      services: { 'urn:test:slow': (h, invocation) => { invocation.done(); } },
    });
    other.spawn(other.chart('waits'));
    await other.idle();
    await sleep(20);
    other.close();
  } finally {
    process.off('unhandledRejection', listener);
  }
  equal(reasons.join(), 'late', 'the rejection');
  host.close();
});

test('close() rejects a waiting idle() and clears its turn', async () => {
  const host = new Host(CONFIG, ENGINE);
  const waiting = host.idle();
  host.close();
  let rejected;
  try {
    await waiting;
  } catch (error) {
    rejected = error;
  }
  if (rejected === undefined) throw new Error('idle() settled after close');
  stateError(rejected);
  await tick(); // the cleared turn does not run on a freed host
  await tick();
  equal(host.closed, true, 'closed');
});

test('idle() on another object is refused by the type tag', () => {
  for (const self of [{}, Object.create(Host.prototype), new SimulatedClock()]) {
    throws(() => Host.prototype.idle.call(self), typeError, 'idle on another object');
  }
});

test('SimulatedClock: milliseconds, moved only by increment', () => {
  const clock = new SimulatedClock();
  equal(clock.now, 0, 'a new clock');
  clock.increment(1000);
  equal(clock.now, 1000, 'after 1000 ms');
  clock.increment(0.5);
  equal(clock.now, 1000.5, 'fractions of a millisecond');
  clock.increment(0);
  equal(clock.now, 1000.5, 'after 0 ms');
  throws(() => clock.increment(-1), rangeError, 'a negative increment');
  throws(() => clock.increment(Number.NaN), rangeError, 'NaN');
  throws(() => clock.increment(Number.POSITIVE_INFINITY), rangeError, 'infinity');
  throws(() => clock.increment('1'), typeError, 'a string');
  throws(() => clock.increment(), typeError, 'no argument');
  throws(() => clock.increment(1n), typeError, 'a bigint');
  equal(clock.now, 1000.5, 'unchanged by the refusals');
  throws(() => SimulatedClock(), typeError, 'a call without new');
  throws(() => SimulatedClock.prototype.increment.call({}, 1), typeError, 'increment on another object');
  throws(() => new Host(CONFIG, { ...ENGINE, clock: {} }), typeError, 'a clock that is not a SimulatedClock');
});

test('increment schedules a turn on each host made with the clock', async () => {
  const clock = new SimulatedClock();
  const hosts = [new Host(CONFIG, { ...ENGINE, clock }), new Host(CONFIG, { ...ENGINE, clock })];
  clock.increment(250);
  for (const host of hosts) {
    await host.idle();
    equal(host.nextDeadline, undefined, 'no deadline');
  }
  hosts[0].close();
  clock.increment(250); // a closed host is forgotten, the open one turns
  await hosts[1].idle();
  hosts[1].close();
  clock.increment(1);
});

test('a clock holds its hosts weakly', async () => {
  const clock = new SimulatedClock();
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  (() => {
    for (let i = 0; i < 10; i++) registry.register(new Host(CONFIG, { ...ENGINE, clock }), i);
  })();
  await collect();
  equal(collected, 10, 'hosts collected while their clock lives');
  clock.increment(1000); // their WeakRefs are empty: nothing to schedule
  equal(clock.now, 1000, 'the clock goes on');
});

// ---- with actors -----------------------------------------------------------

/** Polls `done` every 5 ms for at most `ms`: for what a timer brings. */
async function within(ms, done) {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await sleep(5);
  return done();
}

test('a send runs its actor with no driver called', async () => {
  const host = hostWith({ ender: ENDER });
  const session = host.spawn(host.chart('ender'), { name: 'e' });
  host.send(session, 'go');
  // only the event loop turns: no idle(), no call of the host
  for (let i = 0; i < 5; i++) await tick();
  equal(host.actorByName('e'), undefined, 'the actor ended');
  host.close();
});

// A send to an I/O processor leaves the system: its sender waits for the
// batch's ack (TA_RUN_EFFECTS), then goes on.
const SENDER = scxml('sender', `
  <state id="s">
    <onentry><send type="urn:out" target="somewhere" event="out"/></onentry>
    <transition target="done"/>
  </state>
  <final id="done"/>`);

test('TA_RUN_EFFECTS: a sender goes on after the drain acknowledged its send', async () => {
  const host = hostWith({ sender: SENDER }, { config: { systemID: 't', ioProcessors: [{ type: 'urn:out' }] } });
  host.spawn(host.chart('sender'), { name: 'sender' });
  await host.idle();
  equal(host.actorByName('sender'), undefined, 'the sender ended');
  host.close();
});

test('TA_RUN_EFFECTS_FULL: an outbox of one is drained and run again', async () => {
  const host = hostWith({ sender: SENDER }, {
    config: { systemID: 't', ioProcessors: [{ type: 'urn:out' }], system: { outbox: 1 } },
  });
  for (let i = 0; i < 8; i++) host.spawn(host.chart('sender'), { name: `sender${i}` });
  await host.idle();
  for (let i = 0; i < 8; i++) equal(host.actorByName(`sender${i}`), undefined, `sender${i} ended`);
  host.close();
});

// An actor that never rests: each macrostep raises the next event.
const SPINNER = scxml('spinner', `
  <state id="s">
    <onentry><raise event="again"/></onentry>
    <transition event="again" target="s"/>
  </state>`);

test('TA_RUN_YIELDED and the turn\'s bound: the event loop runs between turns', async () => {
  const host = hostWith({ spinner: SPINNER });
  const session = host.spawn(host.chart('spinner'), { name: 'spin' });
  let timers = 0;
  let io = 0;
  const started = Date.now();
  // a timer and I/O get their turns while the actor spins
  await new Promise((resolve) => setTimeout(() => { timers++; resolve(); }, 1));
  await macrotask().then(() => { io++; });
  await sleep(20);
  equal(timers, 1, 'the timer ran');
  equal(io, 1, 'the immediate ran');
  equal(host.actorByName('spin'), session, 'the actor still spins');
  let settled = false;
  host.idle().then(() => { settled = true; }, () => { settled = true; });
  await sleep(10);
  equal(settled, false, 'never idle while it spins');
  host.terminate(session);
  await host.idle();
  equal(host.actorByName('spin'), undefined, 'terminated');
  if (Date.now() - started > 10000) throw new Error('the turns starved the event loop');
  host.close();
});

// An actor that ends `ms` after it starts, by a delayed send to itself.
const delayed = (ms) => scxml('later', `
  <state id="s">
    <onentry><send event="later" delay="${ms}ms"/></onentry>
    <transition event="later" target="done"/>
  </state>
  <final id="done"/>`);

test('one timer at the deadline: the actor runs when it comes', async () => {
  const host = hostWith({ later: delayed(60) });
  const before = timeouts();
  host.spawn(host.chart('later'), { name: 'later' });
  await host.idle();
  const deadline = host.nextDeadline;
  if (!(deadline > 0 && deadline <= 60)) throw new Error(`nextDeadline ${deadline}`);
  if (before !== undefined) equal(timeouts() - before, 1, 'one timer armed');
  host.spawn(host.chart('later'), { name: 'second' }); // a second deadline: the timer is replaced
  await host.idle();
  if (before !== undefined) equal(timeouts() - before, 1, 'still one timer');
  if (!(await within(5000, () => host.actorByName('second') === undefined))) throw new Error('the deadline never ran the actor');
  equal(host.actorByName('later'), undefined, 'the first deadline ran too');
  await host.idle();
  equal(host.nextDeadline, undefined, 'nothing due');
  if (before !== undefined) equal(timeouts() - before, 0, 'no timer left');
  host.close();
});

test('close() clears the timer at a deadline', async () => {
  const host = hostWith({ later: delayed(10000) });
  const before = timeouts();
  host.spawn(host.chart('later'));
  await host.idle();
  if (before !== undefined) equal(timeouts() - before, 1, 'one timer armed');
  host.close();
  if (before !== undefined) equal(timeouts() - before, 0, 'cleared');
});

test('a host on a simulated clock arms no timer', async () => {
  const clock = new SimulatedClock();
  const host = hostWith({ later: delayed(1000) }, { clock });
  const before = timeouts();
  host.spawn(host.chart('later'), { name: 'later' });
  await host.idle();
  equal(host.nextDeadline, 1000, 'the deadline, in the clock\'s milliseconds');
  if (before !== undefined) equal(timeouts() - before, 0, 'no timer');
  await sleep(20);
  clock.increment(999);
  await host.idle();
  equal(typeof host.actorByName('later'), 'bigint', 'not yet due');
  clock.increment(1);
  await host.idle();
  equal(host.actorByName('later'), undefined, 'due: the actor ran');
  host.close();
});

// ---- with handlers ---------------------------------------------------------

const LOGGER = scxml('logger', `
  <state id="s"><onentry><log label="a" expr="'first'"/><log label="b" expr="'second'"/></onentry></state>`);

test('close() from a handler is deferred to the end of the turn', async () => {
  const seen = [];
  const host = hostWith({ logger: LOGGER }, {
    log: (h, entry) => {
      if (entry.label === 'a') h.close();
      seen.push([entry.text, h.closed, typeof h.actorByName('nobody')]);
    },
  });
  host.spawn(host.chart('logger'));
  await host.idle();
  equal(JSON.stringify(seen), '[["first",false,"undefined"],["second",false,"undefined"]]', 'the turn went on, the host open');
  equal(host.closed, true, 'closed at the end of the turn');
});

test('a handler\'s error, with no idle() waiting, is thrown from the turn\'s callback; the host goes on', () => {
  const index = new URL('../index.mjs', import.meta.url).href;
  const code = `import(${JSON.stringify(index)}).then(async (m) => {
    process.on('uncaughtException', (error) => console.log('uncaught', error.message));
    const charts = [
      { name: 'logger.scxml', text: ${JSON.stringify(LOGGER)} },
      { name: 'ender.scxml', text: ${JSON.stringify(ENDER)} },
    ];
    const compiled = m.compileCharts(charts);
    const host = new m.Host({ systemID: 't' }, { datamodel: process.env.TA_NAPI_DATAMODEL ?? 'native', log: (h, entry) => { throw new Error('from ' + entry.label); } });
    host.addImage(compiled.image);
    compiled.close();
    host.spawn(host.chart('logger'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ender = host.spawn(host.chart('ender'), { name: 'e' });
    host.send(ender, 'go');
    await host.idle();
    console.log('ended', host.actorByName('e') === undefined);
    host.close();
  });`;
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 });
  const output = `${result.stdout}${result.stderr}`;
  equal(result.status, 0, `exit status (${output})`);
  equal((output.match(/uncaught /g) ?? []).length, 1, `one uncaught error, the first (${output})`);
  if (!output.includes('uncaught from a')) throw new Error(`the first handler's error: ${output}`);
  if (!output.includes('ended true')) throw new Error(`the host went on: ${output}`);
});

test('a handler\'s error is whatever it threw: a string, a number, undefined and null reject idle() too', async () => {
  for (const thrown of [new Error('e'), 'a string', 42, undefined, null]) {
    const host = hostWith({ logger: LOGGER }, { log: () => { throw thrown; } });
    host.spawn(host.chart('logger'));
    let rejected = false;
    let reason;
    await host.idle().catch((error) => { rejected = true; reason = error; });
    equal(rejected, true, `idle() rejects when a handler throws ${String(thrown)}`);
    equal(reason, thrown, 'with what it threw');
    host.close();
  }
});

/** The runtime's pending Timeout handles (node's process.getActiveResourcesInfo);
 * undefined on a runtime that does not list them. */
function timeouts() {
  if (globalThis.Bun || typeof process.getActiveResourcesInfo !== 'function') return undefined;
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

await run();
