// The API on the null datamodel (docs/plan.xml, p5-api): charts with no
// data and no expressions, so every case runs on both packages before
// @tinyactors/wasm has an ECMAScript datamodel, and the two are held to
// one behaviour. The I/O processors' views and their answers, a handler's
// promise and error, log entries, the typed methods and their promise
// form, delayed sends on a simulated clock, the transport between two
// hosts, invoked services, hibernation, migration, snapshots and
// telemetry, each the null datamodel's part of what the other test files
// show on the ECMAScript datamodels.
import { Address, Host, MemoryStore, SimulatedClock, TinyactorsError } from '@tinyactors/node';
import { ENGINE, equal, image, indexOfBytes, LABEL, named, processor, sameBytes, scxml, status, throws, typeError, until } from './charts.mjs';
import { run, test } from './harness.mjs';

const OUT = 'urn:test:out';
const CONFIG = { system: 't' };
const nullChart = (name, body, initial = 's') => scxml(name, body, { datamodel: 'null', initial });

/** Sends `hello` to the app at entry, ends on `reply`, fails over to `failed`. */
const ASKER = nullChart('asker', `
  <state id="s">
    <onentry><send type="${OUT}" event="hello" target="the-app" id="ask-1"/><log label="asked"/></onentry>
    <transition event="reply" target="done"/>
    <transition event="error.communication" target="failed"/>
  </state>
  <final id="done"/>
  <final id="failed"/>`);

/** Waits for `go`, then ends; `wait` makes it wait for a delayed event. */
const WAITER = nullChart('waiter', `
  <state id="s">
    <transition event="go" target="done"/>
    <transition event="wait"><send event="go" delay="2s" id="later"/></transition>
  </state>
  <final id="done"/>`);

function hostOf(charts, options = {}) {
  return new Host(image(charts), { ...CONFIG, ...ENGINE, ...options });
}

const gone = (host, name) => until(() => named(host, name) === undefined);

test('a send to an I/O processor: a thin view of its fields, answered in its handler', async () => {
  let seen;
  const host = hostOf({ asker: ASKER }, {
    ioProcessors: {
      [OUT]: processor((send) => {
        equal(send.host, host, 'the view has the host');
        seen = {
          session: send.session, event: send.event, target: send.target, sendid: send.sendid, type: send.type,
          origin: send.origin instanceof Address, data: send.data, traceparent: typeof send.traceparent,
        };
        equal(send.answer('reply'), true, 'delivered');
        throws(() => send.answer('reply'), status('TA_ERROR_STATE'), 'a second answer');
      }),
    },
  });
  const session = host.spawn(host.chart('asker'), { name: 'a' });
  if (!(await gone(host, 'a'))) throw new Error('the answer did not reach the actor');
  equal(seen.session, session.id, 'session');
  equal(seen.event, 'hello', 'event');
  equal(seen.target, 'the-app', 'target');
  equal(seen.sendid, 'ask-1', 'sendid');
  equal(seen.type, OUT, 'type');
  equal(seen.origin, true, 'origin, an Address');
  equal(seen.data, undefined, 'no data');
  equal(seen.traceparent, 'string', 'traced');
  host.close();
});

test('a view read after its ack throws TA_ERROR_STALE; what was read stays', async () => {
  let kept, event;
  const host = hostOf({ asker: ASKER }, {
    ioProcessors: { [OUT]: processor((send) => { kept = send; event = send.event; }) },
  });
  host.spawn(host.chart('asker'));
  await host.idle();
  equal(event, 'hello', 'read in the handler');
  equal(kept.event, 'hello', 'cached');
  throws(() => kept.target, status('TA_ERROR_STALE'), 'a field not read before the ack');
  throws(() => kept.answer('reply'), status('TA_ERROR_STALE'), 'an answer after the ack');
  host.close();
});

test('a handler that returns a promise gets a record: it answers after the ack', async () => {
  let record;
  const host = hostOf({ asker: ASKER }, {
    ioProcessors: { [OUT]: processor(async (send) => { record = send; }) },
  });
  host.spawn(host.chart('asker'), { name: 'a' });
  await host.idle();
  equal(record.target, 'the-app', 'a field never read in the handler');
  const message = record.message;
  equal(JSON.stringify(Object.keys(message)), JSON.stringify(['target', 'event', 'data', 'sendid', 'origin', 'traceparent']), 'message keys');
  equal(message.sendid, 'ask-1', 'message sendid');
  equal(record.answer('reply'), true, 'delivered after the ack');
  if (!(await gone(host, 'a'))) throw new Error('the late answer did not reach the actor');
  throws(() => record.fail(), status('TA_ERROR_STATE'), 'a failure after the answer');
  host.close();
});

test('a handler that throws has its send failed, and its error rejects idle()', async () => {
  const host = hostOf({ asker: ASKER }, {
    ioProcessors: { [OUT]: processor(() => { throw new Error('from the handler'); }) },
  });
  host.spawn(host.chart('asker'), { name: 'a' });
  let error;
  await host.idle().catch((e) => { error = e; });
  equal(error?.message, 'from the handler', 'the handler\'s error');
  if (!(await gone(host, 'a'))) throw new Error('the failure did not reach the actor');
  host.close();
});

test('a send its processor fails is error.communication; a log entry is a thin view', async () => {
  const entries = [];
  const host = hostOf({ asker: ASKER }, {
    ioProcessors: { [OUT]: processor((send) => send.fail()) },
    log: (entry) => entries.push([entry.session, entry.label, entry.text]),
  });
  const session = host.spawn(host.chart('asker'), { name: 'a' });
  if (!(await gone(host, 'a'))) throw new Error('the failure did not reach the actor');
  equal(JSON.stringify(entries.map(([s, label, text]) => [s === session.id, label, text])), JSON.stringify([[true, 'asked', '']]), 'the entry');
  host.close();
});

test('typed methods: a result, an error to onError, and their promises', async () => {
  const host = hostOf({ waiter: WAITER });
  const session = host.spawn(host.chart('waiter'), { name: 'w' });
  await host.idle();
  let stats, state, error;
  host.hostStats(undefined, (result) => { stats = result; });
  host.actorState({ session: Number(session.id) }, (result) => { state = result; });
  host.actorState({ session: 999 }, () => {}, (e) => { error = e; });
  await host.idle();
  equal(typeof stats.host, 'object', 'host.stats');
  equal(state.value, 's', 'actor.state');
  equal(error instanceof TinyactorsError && error.status === undefined && typeof error.code, 'number', 'a reply\'s error');
  const config = await host.hostConfig();
  equal(config.systemID, 't', 'the promise form');
  const refused = await host.actorState({ session: 999 }).then(() => null, (e) => e);
  equal(refused instanceof TinyactorsError, true, 'a promise rejected');
  throws(() => host.hostStats(undefined, 1), typeError, 'onResult not a function');
  host.close();
  let called = false;
  throws(() => host.hostStats(undefined, () => { called = true; }), status('TA_ERROR_STATE'), 'a closed host');
  equal(called, false, 'nothing called');
});

test('a delayed send on a simulated clock: nextDeadline, increment, no timer', async () => {
  const clock = new SimulatedClock();
  const host = hostOf({ waiter: WAITER }, { clock, config: { system: { ticksPerSecond: 1000 } } });
  host.spawn(host.chart('waiter'), { name: 'w' });
  host.send(named(host, 'w'), 'wait');
  await host.idle();
  equal(host.nextDeadline, 2000, 'the deadline, in milliseconds');
  equal(host.now(), 0, 'the host\'s clock');
  clock.increment(1999);
  await host.idle();
  equal(named(host, 'w') !== undefined, true, 'not yet');
  clock.increment(1);
  await host.idle();
  equal(named(host, 'w'), undefined, 'the delayed event came');
  equal(host.nextDeadline, undefined, 'no deadline');
  host.close();
});

test('the transport: a send to another system\'s address, its message sent on the other side', async () => {
  const sender = nullChart('sender', `
    <state id="s"><onentry><send event="ping" target="tinyactors://b/@echo" id="p-1"/></onentry>
      <transition event="pong" target="done"/></state>
    <final id="done"/>`);
  const echo = nullChart('echo', `
    <state id="s"><transition event="ping"><send event="pong" target="tinyactors://a/@sender"/></transition></state>`);
  let a, b;
  const route = (target) => (send) => {
    equal(send.type, undefined, 'the transport\'s type');
    equal(send.target instanceof Address, true, 'the target an Address');
    target().send(send.message);
  };
  a = hostOf({ sender }, { system: 'a', transport: route(() => b) });
  b = hostOf({ echo }, { system: 'b', transport: route(() => a) });
  b.spawn(b.chart('echo'), { name: 'echo' });
  a.spawn(a.chart('sender'), { name: 'sender' });
  if (!(await until(() => named(a, 'sender') === undefined))) throw new Error('no pong came back');
  a.close();
  b.close();
});

test('invoked services: start, receive, sendBack, done, and stop at the UNINVOKE', async () => {
  const client = nullChart('client', `
    <state id="s">
      <invoke id="svc" type="urn:test:svc" src="svc://here"/>
      <transition event="ask"><send target="#_svc" event="question"/></transition>
      <transition event="answer"><log label="answer"/></transition>
      <transition event="done.invoke.svc" target="over"><log label="done"/></transition>
      <transition event="leave" target="over"/>
    </state>
    <state id="over"/>`);
  const labels = [];
  const events = [];
  let invocation, stopped = 0;
  const host = hostOf({ client }, {
    log: (entry) => labels.push(entry.label),
    services: {
      'urn:test:svc': (inv) => {
        invocation = inv;
        return {
          receive(send) { events.push(send.event); inv.sendBack('answer'); },
          stop() { stopped++; },
        };
      },
    },
  });
  const one = host.spawn(host.chart('client'));
  await host.idle();
  equal(invocation.type, 'urn:test:svc', 'type');
  equal(invocation.src, 'svc://here', 'src');
  equal(invocation.invokeid, 'svc', 'invokeid');
  equal(invocation.session, one.id, 'session');
  equal(invocation.restored, false, 'restored');
  equal(invocation.running, true, 'running');
  host.send(one, 'ask');
  await host.idle();
  equal(JSON.stringify(events), '["question"]', 'receive');
  equal(JSON.stringify(labels), '["answer"]', 'sendBack');
  invocation.done();
  await host.idle();
  equal(JSON.stringify(labels), '["answer","done"]', 'done');
  equal(invocation.running, false, 'not running after done');
  throws(() => invocation.sendBack('answer'), status('TA_ERROR_STALE'), 'sendBack after done');
  const two = host.spawn(host.chart('client'));
  await host.idle();
  host.send(two, 'leave');
  await host.idle();
  equal(stopped, 1, 'stopped at the UNINVOKE');
  host.close();
});

test('a service with no handler is a communication error for the invoker, and nothing is thrown', async () => {
  const client = nullChart('client', `
    <state id="s">
      <invoke id="svc" type="urn:test:none" src="x"/>
      <transition event="error.communication" target="done"/>
    </state>
    <final id="done"/>`);
  const host = hostOf({ client });
  host.spawn(host.chart('client'), { name: 'c' });
  await host.idle();
  if (!(await gone(host, 'c'))) throw new Error('no error.communication');
  host.close();
});

test('hibernation: a blob, a WAKE for an event, the actor goes on', async () => {
  const store = new MemoryStore();
  const host = hostOf({ waiter: WAITER }, { store });
  const session = host.spawn(host.chart('waiter'), { name: 'w' });
  await host.idle();
  const blob = host.hibernate(session);
  equal(blob instanceof Uint8Array && blob.length > 0, true, 'a blob');
  store.save(session.id, blob);
  equal(named(host, 'w'), session.id, 'by name while hibernated');
  equal(JSON.stringify(host.sweep(100, 10).map(String)), '[]', 'nothing to sweep: it is out');
  host.send(session, 'go');
  await host.idle();
  equal(store.blobs.size, 0, 'the WAKE loaded the blob, and it is spent');
  if (!(await gone(host, 'w'))) throw new Error('the event did not run after the wake');
  throws(() => host.hibernate(session), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'a session that ended');
  throws(() => host.sweep(-1, 1), typeError, 'a negative maxScan');
  host.close();
});

test('migration: actors move to the new version; MIGRATED views and the result', async () => {
  const v1 = nullChart('m', '<state id="s"><transition event="go" target="done"/></state><final id="done"/>');
  const v2 = nullChart('m', '<state id="s"><transition event="go" target="t"/></state><state id="t"/>');
  const moved = [];
  let result;
  const host = hostOf({ m: v1 }, {
    migrated: (view) => moved.push([view.session, view.segment, view.chart, view.migration]),
    migrationDone: (done) => { result = done; },
  });
  const sessions = [host.spawn(host.chart('m')), host.spawn(host.chart('m'))];
  await host.idle();
  equal(host.addImage(image({ m: v2 })), 1, 'the new version\'s segment');
  const migration = host.migrate({ chart: 'm' });
  await host.idle();
  equal(moved.length, 2, 'two MIGRATED');
  equal(moved.every(([s, segment, chart, id]) => sessions.some((actor) => actor.id === s) && segment === 1 && chart === 'm' && id === migration), true, 'their fields');
  equal(result.migration, migration, 'its id');
  equal(result.migrated, 2, 'migrated');
  equal(Object.isFrozen(result.failed) && result.failed.length, 0, 'failed');
  equal(Object.isFrozen(result.pending) && result.pending.length, 0, 'pending');
  host.send(sessions[0], 'go');
  await host.idle();
  equal(named(host, 'x'), undefined, 'no name');
  throws(() => host.migrate({ chart: '' }), (error) => {
    if (!(error instanceof RangeError)) throw error;
  }, 'an empty chart');
  throws(() => host.migrate({ timeout: 'soon' }), typeError, 'a timeout that is not a number');
  host.close();
});

test('snapshots: a restored host goes on; another system and another program\'s pack are refused', async () => {
  const host = hostOf({ waiter: WAITER }, { clock: new SimulatedClock() });
  host.spawn(host.chart('waiter'), { name: 'w' });
  await host.idle();
  const blob = host.snapshot();
  equal(blob instanceof Uint8Array && blob.length > 0, true, 'a snapshot');
  host.close();
  const restored = Host.restore(blob, [], { ...CONFIG, ...ENGINE, clock: new SimulatedClock() });
  const session = named(restored, 'w');
  equal(typeof session, 'bigint', 'the actor is there');
  equal(sameBytes(restored.snapshot(), blob), true, 'the snapshot of a restored host is the same bytes');
  restored.send(session, 'go');
  if (!(await gone(restored, 'w'))) throw new Error('the restored actor did not run');
  restored.close();
  throws(() => Host.restore(blob, [], { system: 'other', ...ENGINE }), status('TA_ERROR_INVALID'), 'another system');
  const label = new TextEncoder().encode(LABEL);
  const at = indexOfBytes(blob, label);
  if (at < 0) throw new Error('the pack does not hold its label');
  const relabelled = new Uint8Array(blob);
  relabelled[at] = 'x'.charCodeAt(0);
  throws(() => Host.restore(relabelled, [], { ...CONFIG, ...ENGINE }), status('TA_ERROR_INVALID'), 'another program\'s pack');
  throws(() => Host.restore(new Uint8Array([1, 2, 3]), [], { ...CONFIG, ...ENGINE }), status('TA_ERROR_INVALID'), 'no pack');
  throws(() => Host.restore('pack', [], { ...CONFIG, ...ENGINE }), typeError, 'not bytes');
});

test('a snapshot from a handler is refused; one with a reply pending is refused', async () => {
  let refused;
  const host = hostOf({ asker: ASKER }, {
    ioProcessors: {
      [OUT]: processor((send) => {
        try { send.host.snapshot(); } catch (error) { refused = error.status; }
        send.answer('reply');
      }),
    },
  });
  host.spawn(host.chart('asker'));
  await host.idle();
  equal(refused, 'TA_ERROR_STATE', 'from a handler');
  host.hostStats(undefined, () => {});
  throws(() => host.snapshot(), status('TA_ERROR_STATE'), 'a reply pending');
  await host.idle();
  host.close();
});

test('telemetry: traces and logs to the handler as Uint8Arrays, metrics(), the last take at close', async () => {
  const clock = new SimulatedClock();
  const got = [];
  const host = hostOf({ waiter: WAITER }, {
    clock,
    config: { system: { ticksPerSecond: 1000 }, telemetry: { flushInterval: 100 } },
    telemetry: (signal, data) => got.push([signal, data]),
  });
  host.spawn(host.chart('waiter'));
  await host.idle();
  clock.increment(200);
  await host.idle();
  equal(got.some(([signal, data]) => signal === 'traces' && data instanceof Uint8Array && data.length > 0), true, 'traces');
  const metrics = host.metrics();
  equal(metrics instanceof Uint8Array && metrics.length > 0, true, 'metrics');
  got.length = 0;
  host.spawn(host.chart('waiter'));
  await host.idle();
  host.close();
  equal(got.some(([signal]) => signal === 'traces'), true, 'the last take at close');
  const plain = hostOf({ waiter: WAITER });
  throws(() => plain.metrics(), status('TA_ERROR_STATE'), 'no telemetry in the config');
  plain.close();
});

test('a closed host refuses its inputs, and idle() rejects', async () => {
  const host = hostOf({ waiter: WAITER });
  host.close();
  for (const call of [() => host.snapshot(), () => host.migrate(), () => host.sweep(1, 1), () => host.hibernate(1n), () => host.wake(1n, new Uint8Array(1)), () => host.now()]) {
    throws(call, status('TA_ERROR_STATE'), 'a closed host');
  }
  const error = await host.idle().then(() => null, (e) => e);
  equal(error?.status, 'TA_ERROR_STATE', 'idle() on a closed host');
  equal(host.nextDeadline, undefined, 'no deadline');
});

await run();
