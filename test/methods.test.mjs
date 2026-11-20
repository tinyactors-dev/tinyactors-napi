// The typed methods (docs/plan.xml, p1-methods): one per method of
// tinyactors-core/docs/requests.md but actor.send, shaped
// method(params, onResult, onError?), answered at the REPLY's dispatch in a
// later drain; params passed to core as given, so core checks them; an
// error to onError, or without one to the turn (idle() rejects); pending
// handlers dropped, never called, at close.
import { Host, SimulatedClock, TinyactorsError } from '@tinyactors/node';
import { equal, hostWith, scxml, status, throws, typeError, until, WAITER } from './charts.mjs';
import { run, test } from './harness.mjs';

/** A host running WAITER as one session `w`. */
function waiting(options = {}) {
  const host = hostWith({ waiter: WAITER }, options);
  const session = host.spawn(host.chart('waiter'), { name: 'w' }).id;
  return { host, session };
}

/** Calls host[method](params, ...) and records what answers it. */
function ask(host, method, params) {
  const answer = { result: undefined, error: undefined, calls: 0 };
  host[method](params, (result) => { answer.calls++; answer.result = result; },
    (error) => { answer.calls++; answer.error = error; });
  return answer;
}

test('each typed method is answered once, at a later drain, with the result', async () => {
  const { host, session } = waiting();
  await host.idle(); // the session ran: it is in state s
  const answers = {
    actorState: ask(host, 'actorState', { session }),
    actorContext: ask(host, 'actorContext', { session }),
    actorList: ask(host, 'actorList', undefined),
    actorGet: ask(host, 'actorGet', { session }),
    hostStats: ask(host, 'hostStats', undefined),
    hostConfig: ask(host, 'hostConfig', {}),
    traceConfigure: ask(host, 'traceConfigure', { detail: 'summary' }),
    traceWatch: ask(host, 'traceWatch', { rules: [{ chart: 'waiter' }], seconds: 60 }),
    traceUnwatch: ask(host, 'traceUnwatch', { id: 99 }),
    traceEnd: ask(host, 'traceEnd', undefined),
    traceSpansDecode: ask(host, 'traceSpansDecode', { traces: new Uint8Array() }),
  };
  for (const [method, answer] of Object.entries(answers)) equal(answer.calls, 0, `${method}: not answered during the call`);
  await host.idle();
  for (const [method, answer] of Object.entries(answers)) {
    equal(answer.calls, 1, `${method}: answered once`);
  }
  equal(answers.actorState.result.value, 's', 'actor.state: the configuration');
  equal(JSON.stringify(answers.actorContext.result), '{"variables":{}}', 'actor.context');
  equal(answers.actorList.result.sessions.length, 1, 'actor.list: one session');
  equal(answers.actorList.result.cursor, null, 'actor.list: every session listed');
  equal(answers.actorGet.result.chart, 'waiter', 'actor.get: the chart');
  equal(answers.hostStats.result.host.actors, 1, 'host.stats: one actor');
  equal(answers.hostConfig.result.systemID, 't', 'host.config: the effective config');
  equal(JSON.stringify(answers.traceConfigure.result), '{}', 'trace.configure');
  equal(typeof answers.traceWatch.result.id, 'number', 'trace.watch: a watch id');
  equal(answers.traceUnwatch.error.reason, 'stale', 'trace.unwatch of no watch: stale');
  equal(answers.traceEnd.error.reason, 'state', 'trace.end without telemetry: state');
  equal(answers.traceSpansDecode.result.spans.length, 0, 'trace.spans.decode of nothing');
  host.close();
});

const TIMED = scxml('timed', `
  <state id="work" initial="a">
    <onentry><send id="sla" event="breach" delay="60s"/><send event="tick" delay="1500ms"/></onentry>
    <history id="h" type="deep"><transition target="a"/></history>
    <state id="a" initial="a1"><state id="a1"><transition event="next" target="a2"/></state><state id="a2"/></state>
    <transition event="pause" target="paused"/>
  </state>
  <state id="paused"><transition event="resume" target="h"/></state>`, { initial: 'work' });

test('actorGet lists the pending delayed sends, due in milliseconds on host.now()\'s clock; actorState the history', async () => {
  const clock = new SimulatedClock();
  const host = hostWith({ timed: TIMED }, { clock });
  const session = host.spawn(host.chart('timed'));
  await host.idle();
  equal(host.now(), 0, 'the clock starts at 0');
  const got = ask(host, 'actorGet', { session });
  await host.idle();
  equal(JSON.stringify(got.result.timers),
    '[{"sendid":null,"event":"tick","due":1500},{"sendid":"sla","event":"breach","due":60000}]', 'earliest first');
  equal(got.result.timersPending, 2, 'all of them');
  clock.increment(1500); // tick fires
  const later = ask(host, 'actorGet', { session });
  await host.idle();
  equal(JSON.stringify(later.result.timers), '[{"sendid":"sla","event":"breach","due":60000}]', 'a fired send is gone');
  host.send(session, 'next');
  host.send(session, 'pause');
  await host.idle(); // a typed method reads the host at its call
  const state = ask(host, 'actorState', { session });
  await host.idle();
  equal(JSON.stringify(state.result), '{"value":"paused","history":{"h":{"work":{"a":"a2"}}}}', 'where h returns');
  host.close();
});

test('a typed method called from a handler is answered in a later take, after the ack', async () => {
  const LOGGER = scxml('logger', `<state id="s"><onentry><log label="hi" expr="1"/></onentry></state>`);
  const order = [];
  let entry;
  const host = hostWith({ logger: LOGGER }, {
    log: (line) => {
      entry = line;
      line.host.hostStats(undefined, (result) => {
        order.push('answered');
        throws(() => entry.label, status('TA_ERROR_STALE'), 'the handler\'s view, at the answer');
        order.push(result.host.actors);
      });
      order.push('handler returned');
    },
  });
  host.spawn(host.chart('logger'));
  await host.idle();
  equal(order.join(), 'handler returned,answered,1', 'answered after the handler, in a later batch');
  host.close();
});

test('a typed method answers its own handle: a second method from onResult is answered too', async () => {
  const { host, session } = waiting();
  await host.idle(); // the session ran: it is in state s
  const seen = [];
  host.actorGet({ session }, (result) => {
    seen.push(result.chart);
    host.actorState({ session }, (state) => seen.push(JSON.stringify(state.value)));
  });
  await host.idle();
  equal(seen.join(), 'waiter,"s"', 'both answered, in order');
  host.close();
});

test('an error goes to onError as a TinyactorsError with code, reason, path and message', async () => {
  const { host } = waiting();
  const answer = ask(host, 'actorGet', { session: 99n });
  await host.idle();
  equal(answer.calls, 1, 'answered once');
  const error = answer.error;
  if (!(error instanceof TinyactorsError)) throw new Error('a TinyactorsError');
  equal(error.code, -32001, 'code');
  equal(error.reason, 'stale', 'reason');
  equal(error.path, 'params.session', 'path');
  equal(typeof error.message, 'string', 'message');
  equal(error.status, undefined, 'no status: it is no call\'s');
  host.close();
});

test('an error without onError is the turn\'s: idle() rejects with it', async () => {
  const { host } = waiting();
  let called = false;
  host.actorGet({ session: 99n }, () => { called = true; });
  let rejected;
  await host.idle().catch((error) => { rejected = error; });
  equal(called, false, 'onResult is not called for an error');
  if (!(rejected instanceof TinyactorsError)) throw new Error(`idle() rejects with a TinyactorsError: ${rejected}`);
  equal(rejected.reason, 'stale', 'the reply\'s error');
  host.actorGet({ session: 99n }, () => {}, null); // null: no onError
  rejected = undefined;
  await host.idle().catch((error) => { rejected = error; });
  equal(rejected?.reason, 'stale', 'null is no onError');
  host.close();
});

test('a handler that throws: the error rejects idle(), and the host goes on', async () => {
  const { host } = waiting();
  const boom = new Error('boom');
  host.hostStats(undefined, () => { throw boom; });
  let rejected;
  await host.idle().catch((error) => { rejected = error; });
  equal(rejected, boom, 'the handler\'s error');
  const answer = ask(host, 'hostStats', undefined);
  await host.idle();
  equal(answer.calls, 1, 'the next method is answered');
  host.close();
});

test('params pass to core as given: core refuses a bad one in the reply', async () => {
  const { host } = waiting();
  const unknown = ask(host, 'actorList', { x: 1 });
  const type = ask(host, 'actorList', { limit: 'x' });
  const range = ask(host, 'actorList', { limit: 0 });
  const notMap = ask(host, 'actorList', null);
  const config = ask(host, 'hostConfig', { onError: 1 });
  await host.idle();
  equal(`${unknown.error.code} ${unknown.error.reason} ${unknown.error.path}`, '-32602 unknown params.x', 'a param the method does not take');
  equal(`${type.error.reason} ${type.error.path}`, 'type params.limit', 'a param of the wrong type');
  equal(`${range.error.reason} ${range.error.path}`, 'range params.limit', 'a param out of range');
  equal(`${notMap.error.code} ${notMap.error.reason} ${notMap.error.path}`, '-32600 type params', 'params not a map');
  equal(config.error.path, 'params.onError', 'onError is never taken from params');
  host.close();
});

test('the arguments are checked at the call, and a refused call leaves nothing pending', async () => {
  const { host, session } = waiting();
  throws(() => host.hostStats(undefined, undefined, () => {}), typeError, 'an onError without an onResult');
  throws(() => host.hostStats(undefined, 1), typeError, 'onResult not a function');
  throws(() => host.hostStats(undefined, () => {}, 'x'), typeError, 'onError not a function');
  let called = false;
  throws(() => host.actorState({ session, f() {} }, () => { called = true; }), (error) => {
    if (!(error instanceof TinyactorsError) && !(error instanceof TypeError)) throw error;
  }, 'params that cannot be written');
  throws(() => Host.prototype.hostStats.call({}, undefined, () => {}), typeError, 'not a Host');
  const answer = ask(host, 'actorState', { session });
  await host.idle();
  equal(called, false, 'the refused call is never answered');
  equal(answer.calls, 1, 'the next call is');
  host.close();
});

test('a getter of params may call the host again: both methods are answered', async () => {
  const { host, session } = waiting();
  await host.idle();
  const seen = [];
  const params = {
    get session() {
      host.actorGet({ session }, (result) => seen.push(`get ${result.chart}`));
      return session;
    },
  };
  host.actorState(params, (result) => seen.push(`state ${JSON.stringify(result.value)}`));
  await host.idle();
  equal(seen.sort().join(), 'get waiter,state "s"', 'the nested and the outer method');
  host.close();
});

test('pending handlers are never called after close; a method on a closed host throws', async () => {
  const { host } = waiting();
  let called = 0;
  host.hostStats(undefined, () => { called++; }, () => { called++; });
  host.actorGet({ session: 99n }, () => { called++; }, () => { called++; });
  host.close();
  await until(() => false, 20);
  equal(called, 0, 'dropped, never called');
  throws(() => host.hostStats(undefined, () => {}), status('TA_ERROR_STATE'), 'closed');
});

test('close from a handler waits for the end of the turn: a reply the turn takes is still answered', async () => {
  const LOGGER = scxml('logger', `<state id="s"><onentry><log label="hi" expr="1"/></onentry></state>`);
  const seen = [];
  const host = hostWith({ logger: LOGGER }, {
    log: (entry) => {
      entry.host.hostStats(undefined, (result) => seen.push(`answered, closed ${host.closed}`));
      entry.host.close();
      seen.push(`asked, closed ${entry.host.closed}`);
    },
  });
  host.spawn(host.chart('logger'));
  await until(() => host.closed);
  equal(seen.join(), 'asked, closed false,answered, closed false', 'the turn goes on to its end');
  equal(host.closed, true, 'closed at the end of the turn');
});

await run();
