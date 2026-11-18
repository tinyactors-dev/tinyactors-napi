// Invoked services (docs/plan.xml, p2-services; translated from
// tinyactors-cpython/tests/test_services.py): Host's `services`, the
// Invocation record, sendBack and done, a service's receive and stop, on
// the datamodel under test; failures to start, crashes, the services left
// at close, and a restored host announcing each running invocation again.
import { Host, SimulatedClock, TinyactorsError } from '@tinyactors/node';
import { DATAMODEL, ENGINE, equal, hostWith, image, scxml, status, throws, typeError, until } from './charts.mjs';
import { collect, run, test } from './harness.mjs';

const TYPE = 'urn:test:echo'; // the charts' <invoke type="urn:test:echo">

/** tinyactors-cpython/tests/fixtures/test_services/client.ecmascript.scxml */
const CLIENT = scxml('client', `
  <state id="s">
    <invoke id="echo" type="urn:test:echo" src="echo://here">
      <param name="hello" expr="'world'"/>
    </invoke>
    <transition event="ask">
      <send target="#_echo" event="question">
        <content expr="_event.data"/>
      </send>
    </transition>
    <transition event="answer">
      <log label="answer" expr="JSON.stringify(_event.data) + ' ' + _event.invokeid"/>
    </transition>
    <transition event="done.invoke.echo" target="over">
      <log label="done" expr="JSON.stringify(_event.data)"/>
    </transition>
    <transition event="error.communication">
      <log label="error" expr="'communication'"/>
    </transition>
    <transition event="leave" target="over"/>
  </state>
  <state id="over"/>`);

/** test_services/autoforward: every external event of the invoker reaches the service. */
const AUTOFORWARD = scxml('client', `
  <state id="s">
    <invoke id="echo" type="urn:test:echo" src="echo://here" autoforward="true"/>
    <transition event="answer">
      <log label="answer" expr="JSON.stringify(_event.data)"/>
    </transition>
  </state>`);

/** test_services/cancelled: the invocation left in the run that started it. */
const CANCELLED = scxml('client', `
  <state id="s">
    <invoke id="echo" type="urn:test:echo" src="echo://here"/>
    <transition event="leave" target="over"/>
  </state>
  <state id="over">
    <transition event="error.communication">
      <log label="error" expr="'late'"/>
    </transition>
  </state>`);

/** test_services/whoami: an event from a service names it as its origin. */
const WHOAMI = scxml('whoami', `
  <state id="s">
    <invoke id="echo" type="urn:test:echo" src="echo://here"/>
    <transition event="reply">
      <log label="from" expr="_event.origin + ' ' + _event.origintype + ' ' + _event.invokeid"/>
      <send targetexpr="_event.origin" event="thanks"/>
    </transition>
  </state>`);

class Logs {
  constructor() {
    this.lines = [];
    this.handler = (host, entry) => this.lines.push([entry.label, entry.text]);
  }
  labelled(label) {
    return this.lines.filter(([l]) => l === label).map(([, text]) => text);
  }
}

/** A service: answers every question, finishes on 'finish'. */
class Echo {
  constructor(record, invocation) {
    this.record = record;
    this.invocation = invocation;
    record.push(['start', invocation.session, invocation.invokeid, invocation.type, invocation.src, JSON.stringify(invocation.data)]);
  }
  receive(host, send) {
    this.record.push(['receive', send.event, send.data, send.type]);
    if (send.data === 'finish') this.invocation.done({ asked: this.record.filter((r) => r[0] === 'receive').length });
    else this.invocation.sendBack('answer', { echo: send.data });
  }
  stop(host) {
    this.record.push(['stop', this.invocation.session]);
  }
}

const client = (options) => hostWith({ client: CLIENT }, options);
const stops = (record) => record.filter((r) => r[0] === 'stop');

async function rejected(promise) {
  let caught;
  await promise.catch((error) => (caught = error));
  if (caught === undefined) throw new Error('idle() did not reject');
  return caught;
}

/** `actual` and `expected` alike as JSON, bigints and undefined spelled out. */
function same(actual, expected, what) {
  const text = (value) => JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? `${v}n` : v === undefined ? '(undefined)' : v));
  equal(text(actual), text(expected), what);
}

test('an actor talks to its service and gets its done data', async () => {
  const logs = new Logs();
  const record = [];
  const invocations = [];
  const host = client({ log: logs.handler, services: { [TYPE]: (h, invocation) => (invocations.push(invocation), new Echo(record, invocation)) } });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  equal(invocations[0].running, true, 'running');
  equal(invocations[0].restored, false, 'restored');
  host.send(session, 'ask', 'why');
  await host.idle();
  host.send(session, 'ask', 'finish');
  await host.idle();
  equal(invocations[0].running, false, 'running after done');
  throws(() => invocations[0].sendBack('late'), status('TA_ERROR_STALE'), 'sendBack after done');
  throws(() => invocations[0].done(), status('TA_ERROR_STALE'), 'done after done');
  host.close();
  same(record[0], ['start', session, 'echo', TYPE, 'echo://here', '{"hello":"world"}'], 'the invocation');
  same(record[1], ['receive', 'question', 'why', undefined], 'the first send');
  equal(stops(record).length, 0, 'done, not cancelled');
  same(logs.labelled('answer'), ['{"echo":"why"} echo'], 'the answer');
  same(logs.labelled('done'), ['{"asked":2}'], 'the done data');
});

test('the invocation\'s strings are shared across a population; its traceparent is the invoke\'s', async () => {
  const invocations = [];
  const host = client({ services: { [TYPE]: (h, invocation) => void invocations.push(invocation) } });
  host.spawn(host.chart('client'));
  host.spawn(host.chart('client'));
  await host.idle();
  equal(invocations.length, 2, 'invocations');
  for (const field of ['type', 'src', 'invokeid']) equal(invocations[0][field], invocations[1][field], field);
  if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(invocations[0].traceparent ?? ''))
    throw new Error(`traceparent: ${invocations[0].traceparent}`);
  host.close();
});

test('leaving the invoking state stops the service, once', async () => {
  const record = [];
  const invocations = [];
  const host = client({ services: { [TYPE]: (h, invocation) => (invocations.push(invocation), new Echo(record, invocation)) } });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.send(session, 'leave');
  await host.idle();
  equal(invocations[0].running, false, 'running');
  throws(() => invocations[0].sendBack('late'), status('TA_ERROR_STALE'), 'sendBack after the stop');
  host.close();
  same(stops(record), [['stop', session]], 'stopped once');
});

test('terminating the invoker stops the service', async () => {
  const record = [];
  const host = client({ services: { [TYPE]: (h, invocation) => new Echo(record, invocation) } });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.terminate(session);
  await host.idle();
  host.close();
  same(stops(record), [['stop', session]], 'stopped');
});

test('stop and receive are called on the service, with the host', async () => {
  const seen = [];
  let host;
  const service = {
    receive(h, send) {
      seen.push(['receive', this === service, h === host, send.event]);
    },
    stop(h) {
      seen.push(['stop', this === service, h === host]);
    },
  };
  host = client({ services: { [TYPE]: () => service } });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.send(session, 'ask', 1);
  host.send(session, 'leave');
  await host.idle();
  host.close();
  same(seen, [['receive', true, true, 'question'], ['stop', true, true]], 'the calls');
});

test('a service needs neither receive nor stop', async () => {
  const logs = new Logs();
  const host = client({
    log: logs.handler,
    services: {
      [TYPE]: (h, invocation) => {
        invocation.sendBack('answer', 'hi');
      },
    },
  });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.send(session, 'ask', 'dropped'); // nothing receives it
  host.send(session, 'leave');
  await host.idle();
  host.close();
  same(logs.labelled('answer'), ['"hi" echo'], 'the answer');
  same(logs.labelled('error'), [], 'no error');
});

test('no service for the type is a communication error for the invoker, and nothing is thrown', async () => {
  const logs = new Logs();
  const host = client({ log: logs.handler });
  host.spawn(host.chart('client'));
  await host.idle(); // resolves: no error reaches the application
  host.close();
  same(logs.labelled('error'), ['communication'], 'the invoker\'s error');
});

test('a handler that throws is a communication error; a send to it fails too, until the UNINVOKE', async () => {
  const logs = new Logs();
  const host = client({
    log: logs.handler,
    services: {
      [TYPE]: () => {
        throw new RangeError('cannot start');
      },
    },
  });
  const session = host.spawn(host.chart('client'));
  const error = await rejected(host.idle());
  equal(error?.message, 'cannot start', 'the handler\'s error');
  host.send(session, 'ask', 'anyone');
  await host.idle();
  host.send(session, 'leave');
  await host.idle();
  host.close();
  same(logs.labelled('error'), ['communication', 'communication'], 'the invoker\'s errors');
});

/** A service handler that resolves with the service once `release()` is
 * called, as one whose start awaits a connection would. */
function gate() {
  let release;
  const opened = new Promise((resolve) => (release = resolve));
  return { opened, release };
}

/** Collects the unhandled rejections while `body` runs. */
async function withRejections(body) {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason?.message);
  process.on('unhandledRejection', onRejection);
  try {
    await body(rejections);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

const later = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('a handler that returns a promise of the service: what comes while it starts is given to it in order', async () => {
  const logs = new Logs();
  const record = [];
  const { opened, release } = gate();
  const host = client({
    log: logs.handler,
    services: {
      [TYPE]: async (h, invocation) => {
        invocation.sendBack('answer', { echo: 'starting' }); // the invocation answers while it starts
        await opened;
        return new Echo(record, invocation);
      },
    },
  });
  const session = host.spawn(host.chart('client'));
  await later(); // turns run; idle() would wait for the start
  host.send(session, 'ask', 'first');
  host.send(session, 'ask', 'second');
  await later(); // turns run; idle() would wait for the start
  same(record, [], 'nothing received before it started');
  release();
  await later();
  await host.idle();
  same(record.map((r) => [r[0], r[0] === 'start' ? r[1] : r[2]]), [['start', session], ['receive', 'first'], ['receive', 'second']], 'the queued sends, in order');
  host.send(session, 'ask', 'third');
  await host.idle();
  host.send(session, 'ask', 'finish');
  await host.idle();
  host.close();
  same(logs.labelled('answer'), ['{"echo":"starting"} echo', '{"echo":"first"} echo', '{"echo":"second"} echo', '{"echo":"third"} echo'], 'every answer');
  same(logs.labelled('done'), ['{"asked":4}'], 'done once started');
  same(logs.labelled('error'), [], 'no error');
});

test('an UNINVOKE while it starts stops the service once it resolves; the sends before it are dropped', async () => {
  const record = [];
  const { opened, release } = gate();
  const host = client({
    services: {
      [TYPE]: async (h, invocation) => {
        await opened;
        return new Echo(record, invocation);
      },
    },
  });
  const session = host.spawn(host.chart('client'));
  await later(); // turns run; idle() would wait for the start
  host.send(session, 'ask', 'before');
  host.send(session, 'leave');
  await later(); // turns run; idle() would wait for the start
  release();
  await later();
  await host.idle();
  same(record.map((r) => r[0]), ['start', 'stop'], 'stopped, the send dropped: nothing could answer it');
  host.close();
});

test('a handler\'s promise that rejects is a failed start: the invoker and each queued send are told', async () => {
  await withRejections(async (rejections) => {
    const logs = new Logs();
    const { opened, release } = gate();
    const host = client({
      log: logs.handler,
      services: {
        [TYPE]: async () => {
          await opened;
          throw new Error('no connection');
        },
      },
    });
    const session = host.spawn(host.chart('client'));
    await later(); // turns run; idle() would wait for the start
    host.send(session, 'ask', 'queued');
    await later(); // turns run; idle() would wait for the start
    release();
    await later();
    await host.idle();
    host.send(session, 'ask', 'after'); // the entry stays failed until the UNINVOKE
    await host.idle();
    host.close();
    same(logs.labelled('error'), ['communication', 'communication', 'communication'], 'the start, the queued send, the later send');
    same(rejections, ['no connection'], 'the rejection stays unhandled');
  });
});

test('a promise that settles after close, or after the invocation was cancelled, tells nobody', async () => {
  await withRejections(async (rejections) => {
    const logs = new Logs();
    const record = [];
    const gates = [gate(), gate()];
    let started = 0;
    const host = client({
      log: logs.handler,
      services: {
        [TYPE]: async (h, invocation) => {
          const which = started++;
          await gates[which].opened;
          if (which === 1) throw new Error('late');
          return new Echo(record, invocation);
        },
      },
    });
    const first = host.spawn(host.chart('client'));
    await later(); // turns run; idle() would wait for the start
    host.send(first, 'leave'); // cancelled while it starts; it rejects later
    host.spawn(host.chart('client')); // the second starts, then the host closes
    await later(); // turns run; idle() would wait for the start
    gates[0].release();
    await later();
    await later(); // turns run; idle() would wait for the start
    host.close();
    gates[1].release();
    await until(() => rejections.length > 0); // bun reports a rejection a few turns later
    same(record.map((r) => r[0]), ['start', 'stop'], 'the first stopped once it resolved');
    same(logs.labelled('error'), [], 'nobody told');
    same(rejections, ['late'], 'the rejection after close still unhandled');
  });
});

test('a failure to start an invocation cancelled in the same run is not reported to the invoker', async () => {
  const logs = new Logs();
  const host = hostWith({ client: CANCELLED }, {
    log: logs.handler,
    services: {
      [TYPE]: () => {
        throw new Error('cannot start');
      },
    },
  });
  const session = host.spawn(host.chart('client'));
  host.send(session, 'leave'); // INVOKE and UNINVOKE in one batch
  const error = await rejected(host.idle());
  equal(error?.message, 'cannot start', 'the handler\'s error');
  await host.idle();
  host.close();
  same(logs.labelled('error'), [], 'nobody told');
});

test('services left at close are dropped, not stopped, and collected', async () => {
  const record = [];
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  let host = client({
    services: {
      [TYPE]: (h, invocation) => {
        const service = new Echo(record, invocation);
        registry.register(service, 'service');
        return service;
      },
    },
  });
  host.spawn(host.chart('client'));
  await host.idle();
  host.close();
  host = undefined;
  await collect();
  equal(stops(record).length, 0, 'stops');
  equal(collected, 1, 'the service collected');
});

test('a dropped host whose running services close over it is collected', async () => {
  let collected = 0, started = 0;
  const registry = new FinalizationRegistry(() => collected++);
  (() => {
    for (let i = 0; i < 10; i++) {
      const host = client({
        services: {
          // service -> invocation -> host -> handlers -> invocations -> service
          [TYPE]: (h, invocation) => (started++, { host: h, invocation, receive: () => host }),
        },
      });
      host.spawn(host.chart('client'));
      registry.register(host, 'host');
    }
  })();
  for (let i = 0; i < 20 && collected < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collect(2);
  }
  equal(started, 10, 'services started');
  equal(collected, 10, 'hosts collected');
});

test('a service done in its handler is neither kept nor stopped', async () => {
  const logs = new Logs();
  const record = [];
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  const host = client({
    log: logs.handler,
    services: {
      [TYPE]: (h, invocation) => {
        const service = new Echo(record, invocation);
        registry.register(service, 'service');
        invocation.done({ at: 'start' });
        return service;
      },
    },
  });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  await collect();
  equal(collected, 1, 'the host does not hold it');
  host.send(session, 'leave');
  await host.idle();
  host.close();
  equal(stops(record).length, 0, 'stops');
  same(logs.labelled('done'), ['{"at":"start"}'], 'the done data');
});

test('autoforward reaches the service, and its own answers too', async () => {
  const logs = new Logs();
  const record = [];
  class Forwarded {
    constructor(invocation) {
      this.invocation = invocation;
    }
    receive(h, send) {
      record.push([send.event, send.data]);
      if (send.event === 'hello') this.invocation.sendBack('answer', { echo: send.data });
    }
  }
  const host = hostWith({ client: AUTOFORWARD }, { log: logs.handler, services: { [TYPE]: (h, i) => new Forwarded(i) } });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.send(session, 'hello', 'there');
  await host.idle();
  host.close();
  same(record, [['hello', 'there'], ['answer', { echo: 'there' }]], 'what reached the service');
  same(logs.labelled('answer'), ['{"echo":"there"}'], 'the answer');
});

test('a receive that throws is a crash: error.communication with the sendid, dropped not stopped', async () => {
  const logs = new Logs();
  const stopped = [];
  const host = client({
    log: logs.handler,
    services: {
      [TYPE]: () => ({
        receive() {
          throw new Error('crashed');
        },
        stop() {
          stopped.push(true);
        },
      }),
    },
  });
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.send(session, 'ask', 'first');
  const error = await rejected(host.idle());
  equal(error?.message, 'crashed', 'the receive\'s error');
  await host.idle();
  host.send(session, 'ask', 'second');
  await host.idle();
  host.send(session, 'leave');
  await host.idle();
  host.close();
  same(logs.labelled('error'), ['communication', 'communication'], 'the invoker\'s errors');
  same(stopped, [], 'dropped, not stopped');
});

test('an async receive reads its send after the ack; its rejection is a crash', async () => {
  const logs = new Logs();
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason?.message);
  process.on('unhandledRejection', onRejection);
  try {
    const host = client({
      log: logs.handler,
      services: {
        [TYPE]: (h, invocation) => ({
          async receive(h2, send) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            if (send.data === 'boom') throw new Error('late crash');
            invocation.sendBack('answer', { echo: send.data });
          },
        }),
      },
    });
    const session = host.spawn(host.chart('client'));
    await host.idle();
    host.send(session, 'ask', 'later');
    await host.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.idle();
    host.send(session, 'ask', 'boom');
    await host.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await host.idle();
    host.close();
    same(logs.labelled('answer'), ['{"echo":"later"} echo'], 'the late answer');
    same(logs.labelled('error'), ['communication'], 'the crash told');
    same(rejections, ['late crash'], 'the rejection stays unhandled');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('an event from a service names it as its origin, which reaches the service', async () => {
  const logs = new Logs();
  const received = [];
  const host = hostWith({ whoami: WHOAMI }, {
    log: logs.handler,
    services: {
      [TYPE]: (h, invocation) => {
        invocation.sendBack('reply');
        return { receive: (h2, send) => received.push(send.event) };
      },
    },
  });
  host.spawn(host.chart('whoami'));
  host.spawn(host.chart('whoami'));
  await host.idle();
  host.close();
  same(logs.labelled('from'), Array(2).fill('#_echo http://www.w3.org/TR/scxml/#SCXMLEventProcessor echo'), 'the origin');
  same(received, ['thanks', 'thanks'], 'the sends back');
});

test('sendBack and done refuse what they cannot take', async () => {
  const invocations = [];
  const host = client({ services: { [TYPE]: (h, invocation) => void invocations.push(invocation) } });
  host.spawn(host.chart('client'));
  await host.idle();
  const [invocation] = invocations;
  throws(() => invocation.sendBack(1), typeError, 'an event that is not a string');
  throws(() => invocation.sendBack('x', null, { other: 1 }), typeError, 'an unknown option');
  throws(() => invocation.done(undefined, 'x'), typeError, 'options that are not an object');
  throws(() => invocation.sendBack.call({}, 'x'), typeError, 'another object');
  const Invocation = invocation.constructor;
  throws(() => new Invocation(), typeError, 'made by the host only');
  invocation.sendBack('answer', undefined, { traceparent: null }); // a new trace: accepted
  host.close();
  throws(() => invocation.sendBack('late'), status('TA_ERROR_STALE'), 'sendBack after close');
  equal(invocation.running, false, 'running after close');
});

test('services must be an object of functions', () => {
  throws(() => new Host({ systemID: 't' }, { ...ENGINE, services: [() => 0, 1] }), typeError, 'not functions');
  throws(() => new Host({ systemID: 't' }, { ...ENGINE, services: 'urn:x' }), typeError, 'a string');
});

// ---- snapshots with running services -------------------------------------------

const CONFIG = { systemID: 't', system: { ticksPerSecond: 1000 } };

async function snapshotWithAService() {
  const record = [];
  const host = new Host(CONFIG, { ...ENGINE, clock: new SimulatedClock(), services: { [TYPE]: (h, i) => new Echo(record, i) } });
  host.addImage(image({ client: CLIENT }));
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.send(session, 'ask', 'before');
  await host.idle();
  const blob = host.snapshot();
  host.close();
  return { session, blob };
}

const restore = (blob, options = {}) => Host.restore(blob, CONFIG, { ...ENGINE, clock: new SimulatedClock(), ...options });

test('a restored host announces each running invocation again, and its service is started', async () => {
  const { session, blob } = await snapshotWithAService();
  const logs = new Logs();
  const record = [];
  const invocations = [];
  const host = restore(blob, { log: logs.handler, services: { [TYPE]: (h, i) => (invocations.push(i), new Echo(record, i)) } });
  await host.idle();
  host.send(session, 'ask', 'after');
  await host.idle();
  host.send(session, 'ask', 'finish');
  await host.idle();
  host.close();
  equal(invocations.length, 1, 'started once');
  equal(invocations[0].restored, true, 'restored');
  same(record[0], ['start', session, 'echo', TYPE, 'echo://here', '{"hello":"world"}'], 'the invocation again');
  same(record[1].slice(0, 3), ['receive', 'question', 'after'], 'the send after');
  equal(logs.labelled('answer').length, 1, 'answers');
  equal(logs.labelled('done').length, 1, 'done');
});

test('a restore with a stand-in service: the copy never reaches the real one', async () => {
  const { session, blob } = await snapshotWithAService();
  const logs = new Logs();
  class StandIn {
    constructor(invocation) {
      this.invocation = invocation;
    }
    receive() {
      this.invocation.sendBack('answer', 'stand-in');
    }
  }
  const host = restore(blob, { log: logs.handler, services: { [TYPE]: (h, i) => new StandIn(i) } });
  host.send(session, 'ask', 'after');
  await host.idle();
  host.close();
  same(logs.labelled('answer'), ['"stand-in" echo'], 'the stand-in\'s answer');
});

test('a restore without the service tells the invoker, and throws nothing', async () => {
  const { session, blob } = await snapshotWithAService();
  const logs = new Logs();
  const host = restore(blob, { log: logs.handler });
  await host.idle(); // no error: not starting it is the application's choice
  host.send(session, 'ask', 'anyone');
  await host.idle();
  host.close();
  same(logs.labelled('error'), ['communication', 'communication'], 'the invoker\'s errors');
});

test('a restore of a restore reports a missing service once', async () => {
  const { blob } = await snapshotWithAService();
  const logs = new Logs();
  const started = [];
  let host = restore(blob, { log: logs.handler });
  await host.idle();
  const again = host.snapshot();
  host.close();
  host = restore(again, { log: logs.handler, services: { [TYPE]: (h, i) => void started.push(i) } });
  await host.idle();
  host.close();
  same(logs.labelled('error'), ['communication'], 'told once');
  equal(started.length, 0, 'not started again');
});

test('a service done before the snapshot is not started again: its done.invoke is delivered', async () => {
  const invocations = [];
  const started = [];
  let host = new Host(CONFIG, { ...ENGINE, clock: new SimulatedClock(), services: { [TYPE]: (h, i) => void invocations.push(i) } });
  host.addImage(image({ client: CLIENT }));
  host.spawn(host.chart('client'));
  await host.idle();
  invocations[0].done({ paid: 1 }); // the service settles; the actor has not run since
  const blob = host.snapshot();
  host.close();
  const logs = new Logs();
  host = restore(blob, { log: logs.handler, services: { [TYPE]: (h, i) => void started.push(i) } });
  await host.idle();
  host.close();
  equal(started.length, 0, 'not started again');
  same(logs.labelled('done'), ['{"paid":1}'], 'the done data');
});

test('a service that crashed is not started again', async () => {
  const logs = new Logs();
  const started = [];
  let host = new Host(CONFIG, {
    ...ENGINE,
    clock: new SimulatedClock(),
    log: logs.handler,
    services: {
      [TYPE]: () => ({
        receive() {
          throw new Error('crashed');
        },
      }),
    },
  });
  host.addImage(image({ client: CLIENT }));
  const session = host.spawn(host.chart('client'));
  await host.idle();
  host.send(session, 'ask', 'first');
  await rejected(host.idle());
  await host.idle();
  const blob = host.snapshot();
  host.close();
  const restoredLogs = new Logs();
  host = restore(blob, { log: restoredLogs.handler, services: { [TYPE]: (h, i) => void started.push(i) } });
  await host.idle();
  host.close();
  same(logs.labelled('error'), ['communication'], 'the crash told');
  equal(started.length, 0, 'not started again');
  same(restoredLogs.labelled('error'), [], 'nothing told again');
});

console.log(`# services on ${DATAMODEL}`);
await run();
