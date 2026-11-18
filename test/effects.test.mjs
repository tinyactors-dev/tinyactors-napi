// The effects as thin views (docs/plan.xml, p1-effects): a send's fields
// read once and cached, stale after the ack; answer() keeping the send's
// trace; a handler that returns a promise answering after the ack, its
// rejection before an answer failing the send and left unhandled; a
// handler that throws, its send failed and its error reported by the turn;
// the transport, with and without a handler; an I/O processor without one;
// log entries. The actors are observed through their <log> lines.
import { Address, decode, encode, Host, TinyactorsError } from '@tinyactors/node';
import { CONFIG, DATAMODEL, ENGINE, equal, hostWith, image, scxml, sleep, status, throws, typeError, until } from './charts.mjs';
import { run, test } from './harness.mjs';

const OUT = { systemID: 't', ioProcessors: [{ type: 'urn:out' }] };

/** A chart that sends `out` to urn:out (sendid x1, data {n: 1}) and logs
 * how it was answered under the label "outcome", then ends. */
const CALLER = scxml('caller', `
  <state id="s">
    <onentry><send type="urn:out" target="somewhere" event="out" id="x1"><param name="n" expr="1"/></send></onentry>
    <transition event="reply" target="done">
      <log label="outcome" expr="'reply ' + JSON.stringify(_event.data) + ' ' + _event.sendid + ' ' + _event.origintype + ' ' + _event.origin"/>
    </transition>
    <transition event="error.communication" target="done"><log label="outcome" expr="'failed ' + _event.sendid"/></transition>
  </state>
  <final id="done"/>`);

/** A host running CALLER with `processor` for urn:out; `outcomes` gets the
 * caller's outcome lines. */
function caller(processor, options = {}) {
  const outcomes = [];
  const host = hostWith({ caller: CALLER }, {
    config: OUT,
    log: (h, entry) => { if (entry.label === 'outcome') outcomes.push(entry.text); },
    ioProcessors: processor === undefined ? undefined : { 'urn:out': processor },
    ...options,
  });
  host.spawn(host.chart('caller'), { name: 'caller' });
  return { host, outcomes };
}

const stale = status('TA_ERROR_STALE');

test('a send view: each field read on first access and cached, valid until the ack', async () => {
  let seen;
  const { host, outcomes } = caller((h, send) => {
    const data = send.data;
    equal(send.data, data, 'data is cached: the same object');
    h.actorByName('caller'); // a call into the host in the same batch: the view is still valid
    seen = {
      session: send.session, event: send.event, target: send.target, sendid: send.sendid, data,
      type: send.type, origin: send.origin, traceparent: send.traceparent, message: send.message, host: h,
    };
    send.answer('reply', { ok: 1 }, { origin: new Address('tinyactors://t/@back') });
  });
  await host.idle();
  equal(typeof seen.session, 'bigint', 'session');
  equal(seen.event, 'out', 'event');
  equal(seen.target, 'somewhere', 'target: the processor\'s text');
  equal(seen.sendid, 'x1', 'sendid');
  equal(seen.data.n, 1, 'data');
  equal(seen.type, 'urn:out', 'type: the config\'s');
  if (!(seen.origin instanceof Address)) throw new Error('origin is an Address');
  equal(seen.origin.session, seen.session, 'origin: the sender\'s address');
  equal(seen.origin.system, 't', 'origin\'s system');
  if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(seen.traceparent)) throw new Error(`traceparent ${seen.traceparent}`);
  equal(seen.host, host, 'the handler gets the host');
  equal(Object.keys(seen.message).sort().join(), 'data,event,origin,sendid,target,traceparent', 'message keys');
  equal(seen.message.target, 'somewhere', 'message.target');
  equal(seen.message.origin.text, seen.origin.text, 'message.origin');
  // core gives an event origintype only with an origin (src/core/event_pool.c)
  equal(outcomes[0], 'reply {"ok":1} x1 urn:out tinyactors://t/@back', 'the answer: its event, data, sendid, origin, origintype');
  host.close();
});

test('a view read after its ack throws TA_ERROR_STALE; what was read stays', async () => {
  let kept;
  const { host, outcomes } = caller((h, send) => {
    kept = send;
    void send.event;
  });
  await host.idle();
  equal(kept.event, 'out', 'a field read in the handler');
  throws(() => kept.target, stale, 'a field not read before the ack');
  throws(() => kept.message, stale, 'message');
  throws(() => kept.answer('reply'), stale, 'answer after the ack');
  throws(() => kept.fail(), stale, 'fail after the ack');
  equal(outcomes.length, 0, 'the send was neither answered nor failed');
  host.close();
  throws(() => kept.sendid, stale, 'after close');
});

test('a view kept and used from a bare timer is stale there', async () => {
  let late;
  const { host, outcomes } = caller((h, send) => {
    setTimeout(() => {
      try { send.answer('reply'); } catch (error) { late = error; }
    }, 1);
  });
  await host.idle();
  await sleep(20);
  stale(late);
  equal(outcomes.length, 0, 'not answered');
  host.close();
});

test('answer and fail: once, refused after either; options are checked', async () => {
  const refusals = [];
  const { host, outcomes } = caller((h, send) => {
    for (const bad of [() => send.answer(1), () => send.answer('reply', undefined, { traceID: 'x' }),
      () => send.answer('reply', undefined, 'options'), () => send.answer('reply', undefined, { origin: 5 })]) {
      try { bad(); } catch (error) { refusals.push(error instanceof TypeError); }
    }
    send.fail();
    try { send.answer('reply'); } catch (error) { refusals.push(error.status); }
    try { send.fail(); } catch (error) { refusals.push(error.status); }
  });
  await host.idle();
  equal(refusals.join(), 'true,true,true,true,TA_ERROR_STATE,TA_ERROR_STATE', 'refusals');
  equal(outcomes.join(), 'failed x1', 'fail() gave error.communication with the sendid');
  host.close();
});

test('answer() and fail() give true when delivered and false when the sender ended; a closed host still throws', async () => {
  const now = [];
  const first = caller((h, send) => { now.push(send.answer('reply', { n: 2 })); });
  await first.host.idle();
  equal(now.join(), 'true', 'delivered in the handler');
  first.host.close();
  for (const reply of [(send) => send.answer('reply', { late: 1 }), (send) => send.fail()]) {
    let release, view;
    const gate = new Promise((resolve) => { release = resolve; });
    const got = [];
    const { host, outcomes } = caller(async (h, send) => { view = send; await gate; got.push(reply(send)); });
    if (!(await until(() => view !== undefined))) throw new Error('the handler was never called');
    host.terminate(host.actorByName('caller'));
    if (!(await until(() => host.actorByName('caller') === undefined))) throw new Error('the caller did not end');
    release();
    if (!(await until(() => got.length > 0))) throw new Error('the late reply never ran');
    equal(got.join(), 'false', 'not delivered: the sender ended');
    equal(outcomes.length, 0, 'nobody heard it');
    host.close();
    let closed;
    try { reply(view); } catch (error) { closed = error.status; }
    equal(closed, 'TA_ERROR_STATE', 'a closed host refuses');
  }
});

test('answer keeps the send\'s trace; traceparent: null starts a new one', async () => {
  const chart = scxml('tracer', `
    <state id="s">
      <onentry><send type="urn:out" target="a" event="first"/></onentry>
      <transition event="kept" target="t"/>
    </state>
    <state id="t">
      <onentry><send type="urn:out" target="b" event="second"/></onentry>
      <transition event="fresh" target="u"/>
    </state>
    <state id="u"><onentry><send type="urn:out" target="c" event="third"/></onentry></state>`);
  const traces = {};
  const host = hostWith({ tracer: chart }, {
    config: OUT,
    ioProcessors: {
      'urn:out': (h, send) => {
        traces[send.event] = send.traceparent.split('-')[1];
        if (send.event === 'first') send.answer('kept');
        if (send.event === 'second') send.answer('fresh', undefined, { traceparent: null });
      },
    },
  });
  const trace = '0af7651916cd43dd8448eb211c80319c';
  host.spawn(host.chart('tracer'), { traceparent: `00-${trace}-b7ad6b7169203331-01` });
  await host.idle();
  equal(traces.first, trace, 'spawn\'s traceparent is the first step\'s');
  equal(traces.second, trace, 'an answer keeps the trace');
  if (!traces.third || traces.third === trace) throw new Error(`traceparent: null: ${traces.third}`);
  host.close();
});

test('an untraced send has no traceparent', async () => {
  let traceparent = 'unread';
  const { host } = caller((h, send) => {
    traceparent = send.traceparent;
    equal('traceparent' in send.message, true, 'message has the key');
    send.answer('reply');
  }, { config: { ...OUT, system: { tracing: false } } });
  await host.idle();
  equal(traceparent, undefined, 'traceparent');
  host.close();
});

test('a handler returning a promise: its view is filled before the ack and answers after it; idle() waits for it', async () => {
  for (const make of [
    (resolve) => async (h, send) => { await resolve; send.answer('reply', { late: send.sendid }); },
    (resolve) => (h, send) => resolve.then(() => send.answer('reply', { late: send.target })), // a plain function
  ]) {
    let release, called = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const { host, outcomes } = caller((h, send) => { called = true; return make(gate)(h, send); });
    if (!(await until(() => called))) throw new Error('the handler was never called');
    equal(outcomes.length, 0, 'not answered yet');
    setTimeout(release, 20);
    await host.idle(); // the host is idle only once the handler's promise settled and its answer ran
    equal(outcomes.length, 1, 'answered by the time idle() resolved');
    if (!/^reply \{"late":"(x1|somewhere)"\} x1 undefined undefined$/.test(outcomes[0])) throw new Error(outcomes[0]);
    host.close();
  }
});

/** The unhandled rejections while `body` runs. */
async function unhandled(body) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await body();
    await sleep(20);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

test('a promise that rejects before an answer fails the send and stays unhandled', async () => {
  const boom = new Error('boom');
  let outcomes;
  const seen = await unhandled(async () => {
    const made = caller(async () => { await sleep(1); throw boom; });
    outcomes = made.outcomes;
    await made.host.idle();
    // by time, not turns: the rejection comes after the handler's timer
    for (let i = 0; i < 500 && outcomes.length === 0; i++) await sleep(2);
    if (outcomes.length === 0) throw new Error('the send was not failed');
    made.host.close();
  });
  equal(outcomes.join(), 'failed x1', 'error.communication for the sender');
  equal(seen.length, 1, 'one unhandled rejection');
  equal(seen[0], boom, 'the handler\'s error');
});

test('a promise that rejects after an answer fails nothing', async () => {
  let outcomes;
  const seen = await unhandled(async () => {
    const made = caller(async (h, send) => { send.answer('reply'); await sleep(1); throw new Error('late'); });
    outcomes = made.outcomes;
    await made.host.idle();
    await sleep(20);
    await made.host.idle();
    made.host.close();
  });
  equal(outcomes.join(), 'reply undefined x1 undefined undefined', 'answered, not failed');
  equal(seen.length, 1, 'the rejection is still unhandled');
});

test('a handler that throws: error.communication for the sender, the error rejects idle()', async () => {
  const boom = new Error('boom');
  const { host, outcomes } = caller(() => { throw boom; });
  let rejected;
  await host.idle().catch((error) => { rejected = error; });
  equal(rejected, boom, 'idle() rejects with the handler\'s error');
  await host.idle();
  equal(outcomes.join(), 'failed x1', 'the send was failed for it');
  host.close();
});

test('a handler that answers, then throws: the answer stands', async () => {
  const { host, outcomes } = caller((h, send) => { send.answer('reply'); throw new Error('after'); });
  await host.idle().catch(() => {});
  await host.idle();
  equal(outcomes.join(), 'reply undefined x1 undefined undefined', 'answered');
  host.close();
});

test('an I/O processor without a handler fails each send to it', async () => {
  const { host, outcomes } = caller(undefined);
  await host.idle();
  equal(outcomes.join(), 'failed x1', 'error.communication');
  host.close();
});

/** A chart that sends `ping` to the address `to` holds (another system's). */
const REMOTE = scxml('remote', `
  <datamodel><data id="to"/></datamodel>
  <state id="s">
    <transition event="go" target="t"><assign location="to" expr="_event.data.to"/></transition>
  </state>
  <state id="t">
    <onentry><send event="ping" targetexpr="to" id="p1"><param name="n" expr="2"/></send></onentry>
    <transition event="error.communication" target="done"><log label="outcome" expr="'failed ' + _event.sendid"/></transition>
  </state>
  <final id="done"/>`);

const PONG = scxml('pong', `
  <state id="s">
    <transition event="ping" target="done"><log label="outcome" expr="'ping ' + _event.data.n + ' ' + _event.origin + ' ' + _event.sendid"/></transition>
  </state>
  <final id="done"/>`);

test('the transport without a handler fails each send to another system', async () => {
  const outcomes = [];
  const host = hostWith({ remote: REMOTE }, { log: (h, entry) => outcomes.push(entry.text) });
  const session = host.spawn(host.chart('remote'));
  host.send(session, 'go', { to: 'tinyactors://elsewhere/#_scxml_5' });
  await host.idle();
  equal(outcomes.join(), 'failed p1', 'error.communication');
  host.close();
});

test('the transport: send.target and send.origin are Addresses, send.message crosses to the other host', async () => {
  const lines = [];
  const other = new Host({ systemID: 'other' }, { ...ENGINE, log: (h, entry) => lines.push(entry.text) });
  other.addImage(image({ pong: PONG }));
  const pong = other.spawn(other.chart('pong'), { name: 'pong' });
  let seen;
  const host = hostWith({ remote: REMOTE }, {
    transport: (h, send) => {
      seen = { type: send.type, target: send.target, origin: send.origin };
      other.send(send.message);
    },
  });
  const session = host.spawn(host.chart('remote'));
  host.send(session, 'go', { to: Address.fromSession('other', pong).text });
  await host.idle();
  equal(seen.type, undefined, 'the transport\'s type');
  if (!(seen.target instanceof Address) || !(seen.origin instanceof Address)) throw new Error('Addresses');
  equal(seen.target.system, 'other', 'target system');
  equal(seen.target.session, pong, 'target session');
  equal(seen.origin.session, session, 'origin session');
  await other.idle();
  equal(lines.join(), `ping 2 ${seen.origin.text} p1`, 'the other side got it, with origin and sendid');
  host.close();
  other.close();
});

test('send.message: a text field the send lacks is null, so encoded it is absent to every binding', async () => {
  const chart = scxml('bare', `
    <state id="s"><onentry><send event="hello" target="tinyactors://other/@x"/></onentry></state>`);
  let message;
  const host = hostWith({ bare: chart }, {
    config: { ...CONFIG, system: { tracing: false } },
    transport: (h, send) => { message = send.message; },
  });
  host.spawn(host.chart('bare'));
  await host.idle();
  equal(Object.keys(message).join(), 'target,event,data,sendid,origin,traceparent', 'every key');
  equal(message.sendid, null, 'no sendid: null');
  equal(message.traceparent, null, 'untraced: null');
  equal(message.data, undefined, 'no data: undefined, a value');
  const read = decode(encode({ ...message, target: String(message.target), origin: String(message.origin) }));
  equal(read.sendid, null, 'encoded and read back, still null');
  host.close();
});

test('log entries: session, label, text, stale after the ack; none without a handler', async () => {
  const chart = scxml('logger', `
    <state id="s"><onentry><log label="greeting" expr="'hello'"/><log expr="'bare'"/></onentry></state>`);
  const entries = [];
  let kept;
  const host = hostWith({ logger: chart }, {
    log: (h, entry) => {
      kept = entry;
      entries.push([entry.session, entry.label, entry.text]);
    },
  });
  const session = host.spawn(host.chart('logger'));
  await host.idle();
  equal(entries.length, 2, 'two lines');
  equal(entries[0][0], session, 'session');
  equal(entries[0][1], 'greeting', 'label');
  equal(entries[0][2], 'hello', 'text');
  equal(entries[1][1], '', 'no label');
  equal(kept.text, 'bare', 'a field read in the handler stays');
  host.close();
  const quiet = hostWith({ logger: chart });
  quiet.spawn(quiet.chart('logger'));
  await quiet.idle();
  quiet.close();
});

test('a log entry not read in its handler is stale after the ack', async () => {
  let kept;
  const host = hostWith({ logger: scxml('logger', `<state id="s"><onentry><log label="l" expr="'x'"/></onentry></state>`) }, {
    log: (h, entry) => { kept = entry; },
  });
  host.spawn(host.chart('logger'));
  await host.idle();
  throws(() => kept.text, stale, 'text after the ack');
  host.close();
});

test('views are made by the host only', () => {
  let made;
  const { host } = caller((h, send) => { made = send; send.answer('reply'); });
  return host.idle().then(() => {
    throws(() => new made.constructor(), typeError, 'new Send()');
    throws(() => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(made), 'event').get.call({}), typeError, 'a getter on another object');
    throws(() => made.answer.call({}, 'x'), typeError, 'answer on another object');
    if (!(made.constructor.name === 'Send')) throw new Error('the class is Send');
    host.close();
  });
});

void TinyactorsError;
test('send.data is the application\'s: its arrays are Arrays here, and XML content is its text', async () => {
  const chart = scxml('realm', `
    <state id="s">
      <onentry>
        <send type="urn:out" event="values"><content expr="({ items: [1, { k: 'v' }], bytes: new Uint8Array([1, 2]) })"/></send>
        <send type="urn:out" event="xml"><content><metadata xmlns="" id="doc-1"><title>Budget &amp; plan</title></metadata></content></send>
      </onentry>
    </state>`);
  const got = {};
  const host = hostWith({ realm: chart }, {
    config: OUT,
    ioProcessors: {
      'urn:out': (h, send) => {
        try { got[send.event] = send.data; } catch (error) { got[send.event] = error.status; }
      },
    },
  });
  host.spawn(host.chart('realm'));
  await host.idle();
  host.close();
  const { items, bytes } = got.values;
  equal(items instanceof Array && items[1] instanceof Object, true, 'instanceof holds');
  equal(Object.getPrototypeOf(got.values), Object.prototype, 'a plain object of this realm');
  equal(bytes instanceof Uint8Array && bytes.length === 2, true, 'bytes are this realm\'s Uint8Array');
  equal(JSON.stringify(got.values), '{"items":[1,{"k":"v"}],"bytes":{"0":1,"1":2}}', 'the values');
  equal(typeof got.xml, 'string', 'XML content is text, on both datamodels');
  if (!got.xml.includes('<metadata xmlns="" id="doc-1"><title>Budget &amp; plan</title></metadata>')) throw new Error(got.xml);
});

test('send.data and undefined: kept on the native datamodel, JSON\'s rules on quickjs', async () => {
  const chart = scxml('holes', `
    <state id="s">
      <onentry><send type="urn:out" event="holes"><content expr="({ a: undefined, b: [undefined, 1] })"/></send></onentry>
    </state>`);
  let data;
  const host = hostWith({ holes: chart }, { config: OUT, ioProcessors: { 'urn:out': (h, send) => { data = send.data; } } });
  host.spawn(host.chart('holes'));
  await host.idle();
  host.close();
  if (DATAMODEL === 'quickjs') {
    // quickjs's to_wire: a key holding undefined is dropped, an array's undefined is null
    equal('a' in data, false, 'the key holding undefined is dropped');
    equal(data.b[0], null, 'an array\'s undefined is null');
  } else {
    equal('a' in data && data.a === undefined, true, 'the key holding undefined is kept');
    equal(data.b[0], undefined, 'an array\'s undefined stays undefined');
  }
  equal(data.b[1], 1, 'the rest of the array');
});

await run();
