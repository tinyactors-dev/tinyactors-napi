// The rules the suite cannot see (AGENTS.md, "Rules the suite cannot see,
// each with a test of its own"; docs/plan.xml, p1-rules) that no other file
// shows: a Host posted to a worker, a worker's teardown freeing its open
// hosts, a payload let go after the call, the host's arena marks nesting
// in an input, a view staying valid across the later calls of its batch,
// sessions as bigints or safe integers that never saturate, and the SimulatedClock's type
// tag. The other rules name their tests in AGENTS.md.
import { readdirSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { Address, decode, encode, Host, SimulatedClock } from '@tinyactors/node';
import { DATAMODEL, ENDER, ENGINE, equal, hostWith, scxml, status, throws, typeError, until } from './charts.mjs';
import { collect, run, test } from './harness.mjs';

/** Counts `inc`, an error.communication included, and keeps running. */
const KEEPER = scxml('keeper', `
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="s">
    <transition event="inc"><assign location="n" expr="n + 1"/></transition>
    <transition event="error.communication"><assign location="n" expr="n + 1"/></transition>
  </state>`);

/** Runs `code` (CommonJS, with `module` the package's URL and `data` the
 * workerData's other fields) in a worker; its messages and exit code. */
function inWorker(code, data = {}) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const m = await import(workerData.module);
      const { data } = workerData;
      ${code}
    })().catch((error) => { parentPort.postMessage({ error: String(error?.stack ?? error) }); process.exit(2); });`;
  return new Promise((resolve, reject) => {
    const messages = [];
    const worker = new Worker(source, {
      eval: true,
      workerData: { module: import.meta.resolve('@tinyactors/node'), data },
      env: { ...process.env, TA_NAPI_DATAMODEL: DATAMODEL },
    });
    worker.on('message', (message) => messages.push(message));
    worker.on('error', reject);
    worker.on('exit', (code) => resolve({ messages, code }));
  });
}

test('a Host posted to a worker arrives as a plain object, which every method refuses', async () => {
  const host = hostWith({ ender: ENDER });
  const session = host.spawn(host.chart('ender'), { name: 'e' });
  const { messages, code } = await inWorker(`
    const posted = data.host;
    const refusals = [];
    for (const [name, call] of [
      ['send', () => m.Host.prototype.send.call(posted, data.session, 'go')],
      ['close', () => m.Host.prototype.close.call(posted)],
      ['idle', () => m.Host.prototype.idle.call(posted)],
      ['hostStats', () => m.Host.prototype.hostStats.call(posted, undefined, () => {})],
      ['closed', () => Object.getOwnPropertyDescriptor(m.Host.prototype, 'closed').get.call(posted)],
    ]) {
      try { call(); refusals.push(name + ': not refused'); } catch (error) { refusals.push(name + ': ' + (error instanceof TypeError)); }
    }
    const own = new m.Host({ systemID: 'w' }, { datamodel: process.env.TA_NAPI_DATAMODEL });
    const ownWorks = own.closed === false;
    own.close();
    parentPort.postMessage({ plain: Object.getPrototypeOf(posted) === Object.prototype, keys: Object.keys(posted).length, refusals, ownWorks });`,
  { host, session });
  equal(code, 0, `the worker's exit code (${JSON.stringify(messages)})`);
  const [result] = messages;
  equal(result.plain, true, 'a structured clone: a plain object');
  equal(result.keys, 0, 'with no own keys');
  // Node refuses a prototype method on another receiver itself (V8's
  // signature check, "Illegal invocation"); Bun leaves it to the type tag
  // ("not a Host"): a TypeError on both
  for (const refusal of result.refusals) if (!refusal.endsWith(': true')) throw new Error(refusal);
  equal(result.ownWorks, true, 'a Host the worker makes is its own');
  equal(host.actorByName('e'), session, 'the posted host is untouched');
  host.close();
});

test('a worker that ends with its hosts open frees them at its teardown, with no call of JavaScript', async () => {
  const { messages, code } = await inWorker(`
    const chart = '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="keeper" initial="s">'
      + '<datamodel><data id="kept" expr="[1, {a: 2}]"/></datamodel>'
      + '<state id="s"><onentry><send event="later" delay="60s"><param name="v" expr="kept"/></send></onentry></state></scxml>';
    const compiled = m.compileCharts([{ name: 'keeper.scxml', text: chart }]);
    const hosts = [];
    for (let i = 0; i < 3; i++) {
      const host = new m.Host({ systemID: 'w' + i }, { datamodel: process.env.TA_NAPI_DATAMODEL, log: () => { throw new Error('a handler ran at teardown'); } });
      host.addImage(compiled.image);
      for (let j = 0; j < 20; j++) host.spawn(host.chart('keeper'), { params: { kept: { j } } });
      hosts.push(host);
    }
    compiled.close();
    await hosts[0].idle();
    for (const host of hosts) host.hostStats(undefined, () => { throw new Error('a pending handler was called'); });
    globalThis.hosts = hosts; // still reachable: freed by the environment's teardown, not the collector
    parentPort.postMessage({ open: hosts.filter((host) => !host.closed).length });
    process.exit(0);`);
  equal(code, 0, `the worker's exit code (${JSON.stringify(messages)})`);
  equal(messages[0]?.open, 3, 'the hosts were open when the worker ended');
});

test('a payload whose last reference goes is let go after the call: its value is collected', async () => {
  if (DATAMODEL !== 'native') return; // quickjs's payloads are quickjs's values, not the engine's
  // The deferral itself is not observable: neither runtime runs JavaScript
  // when a reference is deleted (a FinalizationRegistry's callback is a
  // task of its own). What the drops hold must go at the flush.
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  const sender = scxml('sender', `
    <state id="s">
      <onentry><send type="urn:out" target="x" event="out"><param name="v" expr="[1, 2, 3]"/></send></onentry>
      <transition target="done"/>
    </state>
    <final id="done"/>`);
  const host = hostWith({ sender }, {
    config: { systemID: 't', ioProcessors: [{ type: 'urn:out' }] },
    // the payload row's value itself (not a copy), released by core after the ack
    ioProcessors: { 'urn:out': (h, send) => { registry.register(send.data, 1); } },
  });
  for (let i = 0; i < 10; i++) host.spawn(host.chart('sender'));
  await host.idle();
  await collect();
  equal(collected, 10, 'every send\'s data collected after its release');
  host.close();
});

test('marks nest in the host\'s arena: an input whose data\'s getter calls the host keeps its own texts', async () => {
  const lines = [];
  // what each event's texts were, checked in the chart and logged short
  // (a log line is a string of core's too)
  const logger = scxml('logger', `
    <state id="s"><transition event="*"><log label="got" expr="[_event.name.slice(0, 5), _event.name.length,
      /^(outer\\.o+|inner\\.i+)$/.test(_event.name), _event.sendid.length, /^(x+|s+)$/.test(_event.sendid),
      JSON.stringify(_event.data).length,
      /^(\\{&quot;before&quot;:&quot;b+&quot;,&quot;nested&quot;:&quot;n&quot;,&quot;after&quot;:&quot;a+&quot;\\}|\\{&quot;deep&quot;:&quot;d+&quot;\\})$/.test(JSON.stringify(_event.data))].join(' ')"/></transition></state>`);
  const host = hostWith({ logger }, { log: (h, entry) => lines.push(entry.text) });
  const session = host.spawn(host.chart('logger'), { name: 'l' });
  // each text under a slab page (core keeps an event's strings in pages of
  // 4096 bytes), together past the arena's first chunk (16 KiB)
  const outer = `outer.${'o'.repeat(3000)}`;
  const inner = `inner.${'i'.repeat(3000)}`;
  const data = {
    before: 'b'.repeat(2000),
    get nested() { // runs while the outer send's texts are in the arena
      host.send(session, inner, { deep: 'd'.repeat(3000) }, { sendid: 's'.repeat(3000) });
      host.actorByName('n'.repeat(3500));
      return 'n';
    },
    after: 'a'.repeat(2000),
  };
  host.send(session, outer, data, { sendid: 'x'.repeat(2500) });
  await host.idle();
  equal(lines.join('|'), ['inner 3006 true 3000 true 3011 true', 'outer 3006 true 2500 true 4037 true'].join('|'),
    'the nested send, then the outer one, each with its own texts');
  host.close();
});

test('outputs read in a handler stay valid across the later calls of its batch', async () => {
  // two actors that each send once, spawned together: one run, one batch
  const sender = (name, id) => scxml(name, `
    <state id="s"><onentry><send type="urn:out" target="${name}" event="${name}" id="${id}"/></onentry></state>`);
  let first;
  const seen = [];
  const host = hostWith({ one: sender('one', 'a'), two: sender('two', 'b'), ender: ENDER }, {
    config: { systemID: 't', ioProcessors: [{ type: 'urn:out' }] },
    ioProcessors: {
      'urn:out': (h, send) => {
        if (first === undefined) {
          first = send;
          seen.push(send.target);
          return;
        }
        // the batch's second effect: inputs, a typed method and another
        // view's fields in between, the first view still valid
        h.send(h.actorByName('e'), 'go');
        h.hostStats(undefined, () => {});
        seen.push(send.target, first.sendid, first.traceparent === undefined ? 'untraced' : 'traced');
        first.answer('reply');
      },
    },
  });
  host.spawn(host.chart('ender'), { name: 'e' });
  host.spawn(host.chart('one'));
  host.spawn(host.chart('two'));
  await host.idle();
  equal(seen.join(), 'one,two,a,traced', 'the fields of both views, read across the batch');
  throws(() => first.event, status('TA_ERROR_STALE'), 'the first view after the ack');
  if (!(await until(() => host.actorByName('e') === undefined))) throw new Error('the input made in the batch ran');
  host.close();
});

test('rows are handles: a slot reused under a new generation gives each session and payload its own', async () => {
  const sender = scxml('sender', `
    <datamodel><data id="n" expr="-1"/></datamodel>
    <state id="s">
      <onentry><send type="urn:out" target="x" event="out"><param name="v" expr="[n, n * 2]"/></send></onentry>
      <transition target="done"/>
    </state>
    <final id="done"/>`);
  const seen = [];
  const host = hostWith({ sender }, {
    config: { systemID: 't', ioProcessors: [{ type: 'urn:out' }] },
    ioProcessors: { 'urn:out': (h, send) => { seen.push(send.data.v.join(':')); } },
  });
  // one at a time: each session's and payload's rows go before the next
  // are made, so the next take the same slots
  for (let i = 0; i < 20; i++) {
    host.spawn(host.chart('sender'), { params: { n: i } });
    await host.idle();
  }
  equal(seen.join(), Array.from({ length: 20 }, (_, i) => `${i}:${i * 2}`).join(), 'each its own value, in order');
  host.close();
});

test('a dropped host with rows (charts, sessions, payloads) is collected and frees them in its finalizer', async () => {
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  const keeper = scxml('keeper', `
    <datamodel><data id="kept" expr="[1, {a: 2}]"/></datamodel>
    <state id="s"><onentry><send event="later" delay="60s"><param name="v" expr="kept"/></send></onentry></state>`);
  await (async () => {
    for (let i = 0; i < 10; i++) {
      const host = hostWith({ keeper }, { clock: new SimulatedClock() }); // no timer holds it
      for (let j = 0; j < 5; j++) host.spawn(host.chart('keeper'), { params: { kept: { j } } });
      await host.idle(); // a typed method would schedule a turn, which holds its host: none here
      registry.register(host, i);
    }
  })();
  await collect();
  equal(collected, 10, 'hosts collected');
});

test('sessions are bigints from 1 to 2^64-1 or safe integers from 1, never a number that saturates', async () => {
  const host = hostWith({ ender: ENDER, keeper: KEEPER });
  const session = host.spawn(host.chart('ender'), { name: 'e' });
  equal(typeof session, 'bigint', 'spawn gives a bigint');
  const outside = [0, -1, 1.5, 2 ** 53, 2 ** 64, Number.NaN, Infinity, null, -1n, 0n, 1n << 64n, (1n << 64n) + session];
  for (const value of outside) {
    throws(() => host.send(value, 'go'), typeError, `send(${String(value)})`);
    throws(() => host.terminate(value), typeError, `terminate(${String(value)})`);
    throws(() => host.fail(value, 'x'), typeError, `fail(${String(value)})`);
    throws(() => host.send({ target: value, event: 'go' }), typeError, `send({target: ${String(value)}})`);
    throws(() => host.hibernate(value), typeError, `hibernate(${String(value)})`);
    throws(() => host.wake(value, new Uint8Array(1)), typeError, `wake(${String(value)})`);
    throws(() => host.migrate({ session: value }), typeError, `migrate({session: ${String(value)}})`);
    throws(() => Address.fromSession('t', value), typeError, `Address.fromSession(${String(value)})`);
  }
  for (const take of [(v) => host.terminate(v), (v) => host.hibernate(v), (v) => host.migrate({ session: v })])
    throws(() => take(String(session)), typeError, 'a string where only a session goes');
  equal(host.actorByName('e'), session, 'nothing reached the actor');
  // a safe integer is the same session as its bigint, for every input
  const keeper = host.spawn(host.chart('keeper'));
  const number = Number(keeper);
  host.send(number, 'inc');
  host.send({ target: number, event: 'inc' });
  host.send(Address.fromSession('t', number), 'inc');
  host.fail(number, 'x');
  await host.idle();
  const blob = host.hibernate(number);
  host.wake(number, blob);
  host.migrate({ session: number });
  await host.idle();
  let n;
  host.actorContext({ session: number }, (h, result) => { n = result.variables.n; });
  await host.idle();
  equal(n, 4, 'three events and a failure reached the session given as a number');
  host.send(Number(session), 'go');
  await host.idle();
  equal(host.actorByName('e'), undefined, 'the ender ended');
  host.terminate(number);
  await host.idle();
  throws(() => host.terminate(number), status('TA_ERROR_STALE'), 'the keeper is gone');
  host.close();
  // inside a value: a bigint to 64 bits each way, refused past them
  equal(decode(encode((1n << 64n) - 1n)), (1n << 64n) - 1n, '2^64-1');
  equal(decode(encode(-(1n << 64n))), -(1n << 64n), '-2^64');
  for (const value of [1n << 64n, -(1n << 64n) - 1n]) throws(() => encode(value), status('TA_ERROR_INVALID'), `encode(${value})`);
});

test('a SimulatedClock\'s methods on another object are refused by its type tag', () => {
  const clock = new SimulatedClock();
  const increment = SimulatedClock.prototype.increment;
  const now = Object.getOwnPropertyDescriptor(SimulatedClock.prototype, 'now').get;
  for (const self of [{}, Object.create(SimulatedClock.prototype), new Host({ systemID: 't' }, ENGINE)]) {
    throws(() => increment.call(self, 1), typeError, 'increment on another object');
    throws(() => now.call(self), typeError, 'now on another object');
    if (self instanceof Host) self.close();
  }
  equal(clock.now, 0, 'the clock untouched');
});

test('the README says what no test can show: charts are trusted, deadlines keep a process alive, errors end it, using', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  for (const [what, said] of [
    ['chart code is trusted, a vm context no boundary, quickjs the sandbox', /Chart code is trusted code\..*not a security boundary.*quickjs, the sandbox/],
    ['a pending deadline keeps the process alive until close()', /pending deadline keeps the process alive.*host\.close\(\)/],
    ['a handler\'s error ends the process by default', /A handler's error ends the process by default.*uncaughtException.*unhandledRejection/],
    ['let, const or class keeps a chart\'s sessions resident', /let`, `const` or `class` keeps its sessions resident/],
    ['the charts of a host share builtins', /The charts of a host share the builtins of its shared context/],
    ['using needs a runtime that parses it', /`using host = new Host\(\.\.\.\)` needs a runtime that parses `using`:\*\* Bun 1\.4 does, Node\.js 22 does not/],
  ]) if (!said.test(readme)) throw new Error(`the README does not say: ${what}`);
});

test('the services guide says a handler returns the service, or a promise of it', () => {
  const guide = readFileSync(new URL('../docs/guide/services.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  if (!/The handler may return a promise of the service.*Or return the service at once/.test(guide))
    throw new Error('the services guide does not say: a service handler may return a promise, or the service at once');
});

test('every rule in AGENTS.md names tests that exist', () => {
  const here = new URL('./', import.meta.url);
  const names = {};
  for (const file of readdirSync(here).filter((name) => name.endsWith('.test.mjs'))) {
    const source = readFileSync(new URL(file, here), 'utf8');
    names[`test/${file}`] = new Set([...source.matchAll(/^test\('((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1].replace(/\\(.)/g, '$1')));
  }
  const rulebook = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const start = rulebook.indexOf('## Rules the suite cannot see');
  const section = rulebook.slice(start, rulebook.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  let file;
  let named = 0;
  for (const [, span] of section.matchAll(/`([^`]+)`/g)) {
    const both = /^(test\/[\w.]+\.test\.mjs): '(.*)'$/.exec(span);
    const alone = /^'(.*)'$/.exec(span);
    if (!both && !alone) continue;
    if (both) file = both[1];
    const name = both ? both[2] : alone[1];
    if (!names[file]?.has(name)) throw new Error(`AGENTS.md names ${file}: '${name}', which is not there`);
    named++;
  }
  if (named < 20) throw new Error(`AGENTS.md names ${named} tests`);
});

await run();
