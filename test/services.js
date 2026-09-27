'use strict';

// Step 13: services (ROADMAP step 13): the log sink, I/O processors, JavaScript
// invokers and the in-system SCXML invoker. Runs on Node and Bun.

const assert = require('node:assert/strict');
const native = require('../lib/native');
const { createSystem, statechart } = require('..');

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(system, predicate, what) {
  for (let round = 0; round < 200; round += 1) {
    await system.flush();
    if (predicate()) {
      return;
    }
    await later(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// <log> records reach the sink at the end of the turn, never inside core.
async function logSink() {
  const records = [];
  let insideTurn = true;
  const system = createSystem({
    log: (record) => {
      assert.equal(insideTurn, false, 'the sink runs after spawn() returned');
      records.push(record);
    },
  });
  const definition = system.define(
    statechart({ family: 'logger', revision: 'v1' })
      .data('n', 41)
      .state('idle', (s) => {
        s.entry((a) => a.log('boot').log('value', ({ data }) => data.n + 1));
      }),
  );
  const actor = system.spawn(definition);
  insideTurn = false;
  assert.equal(records.length, 0, 'nothing is logged inside spawn()');
  await system.flush();
  assert.equal(records.length, 2);
  assert.equal(records[0].label, 'boot');
  assert.equal(records[0].hasValue, false);
  assert.equal(records[1].label, 'value');
  assert.equal(records[1].hasValue, true);
  assert.equal(records[1].value, 42);
  assert.equal(records[0].source.slot, actor.slot, 'the source is the actor');
  system.setLogSink(undefined);
  system.close();
}

// An asynchronous I/O processor completes by posting an event back.
async function ioCompletes() {
  const requests = [];
  const system = createSystem({
    io: {
      ws: {
        send(request, context) {
          requests.push(request);
          // Complete later, outside the pump turn.
          setTimeout(() => context.post(request.source, 'ack', { echoed: request.data.text }), 1);
        },
      },
    },
  });
  const definition = system.define(
    statechart({ family: 'client', revision: 'v1' })
      .data('reply', null)
      .state('idle', (s) => {
        s.on('say', (t) =>
          t.target('waiting').send('ws.write', (send) => send.via('ws').to('client-7').data(({ event }) => ({ text: event.data }))),
        );
      })
      .state('waiting', (s) => {
        s.on('ack', (t) => t.target('done').assign('reply', ({ event }) => event.data.echoed));
      })
      .state('done'),
  );
  const actor = system.spawn(definition);
  await system.flush();
  actor.post('say', 'hello');
  await system.flush();
  assert.equal(requests.length, 1, 'the processor ran at the end of the turn');
  const [request] = requests;
  assert.equal(request.type, 'ws');
  assert.equal(request.event, 'ws.write');
  assert.equal(request.target, 'client-7');
  assert.deepEqual(request.data, { text: 'hello' });
  assert.equal(request.source.slot, actor.slot);
  assert.equal(request.sendID, null, 'an unnamed send has no send ID');
  await until(system, () => actor.inspect().activeStates.includes('done'), 'the ack');
  assert.equal(actor.inspect().data.reply, 'hello');
  system.close();
}

// A literal target is the text the chart wrote. It reaches the processor as
// that string, without the data model: under core's null data model, which
// a spec opts into and which has no values, and under the JavaScript one, a
// target that reads as JSON stays text. A send with no data has data undefined, and one
// with only params gets them as an object.
async function ioLiteralTarget() {
  const requests = [];
  const system = createSystem({ io: { ws: { send(request) { requests.push(request); } } } });
  const plain = system.define({
    ...statechart({ family: 'plain-sender', revision: 'v1' })
      .state('idle', (s) => {
        s.on('go', (t) => t.send('ping', (send) => send.via('ws').to('client-7')));
        s.on('later', (t) => t.send('tick', (send) => send.via('ws').to('client-8').after(5)));
        s.on('park', (t) => t.send('parked', (send) => send.via('ws').to('client-9').after(60_000)));
        s.on('error.execution', (t) => t.target('failed'));
      })
      .state('failed')
      .build(),
    datamodel: 'null',
  });
  assert.equal(plain.inspect().datamodel, 'null');
  const sender = system.spawn(plain);
  await system.flush();
  sender.post('go');
  await system.flush();
  assert.deepEqual(sender.inspect().activeStates, ['idle'], 'the send did not fail');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].target, 'client-7');
  assert.equal(requests[0].data, undefined);
  sender.post('later');
  await until(system, () => requests.length === 2, 'the delayed send');
  assert.equal(requests[1].target, 'client-8', 'a delayed send keeps its literal target');
  sender.post('park');
  await system.flush();
  assert.deepEqual(
    sender.inspect().delayedSends.map((send) => send.target),
    ['client-9'],
    'inspection reports a pending literal target as its text',
  );

  const scripted = system.define(
    statechart({ family: 'param-sender', revision: 'v1' })
      .state('idle', (s) => {
        s.on('go', (t) => t.send('call', (send) => send.via('ws').to('42').param('n', () => 1)));
      }),
  );
  assert.equal(scripted.inspect().datamodel, 'javascript');
  const other = system.spawn(scripted);
  await system.flush();
  other.post('go');
  await system.flush();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].target, '42', 'a literal target is text, not parsed as JSON');
  assert.deepEqual(requests[2].data, { n: 1 });
  system.close();
}

// A processor that throws, or rejects, fails the send: the sender gets
// error.communication with { sendID, type, error }.
async function ioFails() {
  const system = createSystem({
    io: {
      broken: { send() { throw new Error('socket closed'); } },
      rejecting: { send: async () => { throw new Error('later'); } },
    },
  });
  const definition = system.define(
    statechart({ family: 'failing', revision: 'v1' })
      .dataExpression('errors', () => [])
      .state('idle', (s) => {
        s.on('go', (t) => t.send('x', (send) => send.via('broken')).send('y', (send) => send.via('rejecting')));
        s.on('error.communication', (t) =>
          t.script(function (context) { this.errors.push(context.event.data.error.message); }),
        );
      }),
  );
  const actor = system.spawn(definition);
  await system.flush();
  actor.post('go');
  await until(system, () => actor.inspect().data.errors.length === 2, 'two error.communication events');
  assert.deepEqual([...actor.inspect().data.errors].sort(), ['later', 'socket closed']);
  system.close();
}

// A delayed send to a custom processor has no resolved destination (step 8's
// leftover): inspection reports null, and the send reaches the processor
// when it falls due.
async function delayedCustomSend() {
  const seen = [];
  const system = createSystem({ clock: 'manual', io: { ws: { send: (request) => seen.push(request) } } });
  const definition = system.define(
    statechart({ family: 'delayed', revision: 'v1' }).state('idle', (s) => {
      s.entry((a) => a.send('ping', (send) => send.via('ws').id('p').after(1000)));
    }),
  );
  const actor = system.spawn(definition);
  await system.flush();
  const [pending] = actor.inspect().delayedSends;
  assert.equal(pending.id, 'p');
  assert.equal(pending.destination, null, 'a custom processor has no resolved destination');
  assert.equal(seen.length, 0);
  await system.advanceBy(1000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sendID, 'p');
  system.close();
}

// A JavaScript invoker: start after the turn, events and done to the parent,
// cancel when the invoking state exits.
async function javascriptInvoker() {
  const log = [];
  let reporter;
  const system = createSystem({
    invokers: {
      ticker: {
        start(request, report) {
          log.push(['start', request.invokeID, request.params]);
          reporter = report;
          return {
            cancel(reason) { log.push(['cancel', reason, report.signal.aborted]); },
          };
        },
      },
    },
  });
  const definition = system.define(
    statechart({ family: 'invoking', revision: 'v1' })
      .data('ticks', 0)
      .data('result', null)
      .state('running', (s) => {
        s.invoke((i) => i.type('ticker').id('clock').param('every', 5));
        s.on('tick', (t) => t.assign('ticks', ({ data }) => data.ticks + 1));
        s.on('done.invoke.clock', (t) => t.target('finished').assign('result', ({ event }) => event.data));
        s.on('stop', (t) => t.target('stopped'));
      })
      .state('finished')
      .state('stopped'),
  );
  const actor = system.spawn(definition);
  await system.flush();
  assert.equal(log.length, 1);
  assert.equal(log[0][0], 'start');
  assert.equal(log[0][1], 'clock');
  assert.deepEqual(log[0][2], { every: 5 });
  reporter.event('tick');
  reporter.event('tick');
  await system.flush();
  assert.equal(actor.inspect().data.ticks, 2);
  reporter.done({ total: 2 });
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['finished']);
  assert.deepEqual(actor.inspect().data.result, { total: 2 });
  assert.equal(reporter.signal.aborted, true, 'done ends the invocation');

  // A second actor is stopped: exiting the state cancels the invocation.
  const second = system.spawn(definition);
  await system.flush();
  second.post('stop');
  await system.flush();
  assert.deepEqual(second.inspect().activeStates, ['stopped']);
  const cancel = log.find((entry) => entry[0] === 'cancel');
  assert.ok(cancel, 'the service was cancelled');
  assert.equal(cancel[2], true, 'its signal aborted first');
  assert.equal(reporter.event('tick'), false, 'a cancelled invocation reports nothing');
  system.close();
}

// A literal <invoke src> reaches the invoker as the text the chart wrote,
// never imported into the data model: a chart that opted into the null data
// model names one too, as it names a literal send target.
async function invokerLiteralSource() {
  for (const datamodel of ['null', 'javascript']) {
    const started = [];
    const system = createSystem({ invokers: { svc: { start(request) { started.push(request); } } } });
    const definition = system.define(`<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
        name="literal-src" datamodel="${datamodel}" initial="running">
      <state id="running">
        <invoke type="svc" id="bySource" src="lit-src" autoforward="true"/>
        <invoke type="svc" id="byContent"><content>chart text</content></invoke>
        <transition event="error.*" target="failed"/>
      </state>
      <state id="failed"/>
    </scxml>`, { format: 'scxml' });
    assert.equal(definition.inspect().datamodel, datamodel);
    const parent = system.spawn(definition);
    await system.flush();
    assert.deepEqual(parent.inspect().activeStates, ['running'], `${datamodel}: no invoke failed`);
    const [bySource, byContent] = started;
    assert.equal(started.length, 2, `${datamodel}: both invocations started`);
    assert.equal(bySource.source, 'lit-src', `${datamodel}: the literal src is its text`);
    assert.equal(bySource.type, 'svc');
    assert.equal(bySource.invokeID, 'bySource');
    assert.equal(bySource.autoforward, true);
    assert.equal(bySource.content, undefined);
    assert.equal(byContent.source, undefined);
    assert.equal(byContent.invokeID, 'byContent');
    assert.equal(byContent.content, 'chart text');
    assert.deepEqual(parent.inspect().invocations.map((invocation) => invocation.type), ['svc', 'svc']);
    system.close();
  }
}

// A done() the parent's mailbox cannot take throws, and the invocation stays
// alive: the service reports again once the mailbox drains, and only that
// report ends the invocation.
async function doneRetried() {
  let reporter;
  const system = createSystem({
    scheduling: { maxQueuedMessages: 2 },
    invokers: { job: { start(_, report) { reporter = report; } } },
  });
  const actor = system.spawn(system.define(
    statechart({ family: 'retrying', revision: 'v1' })
      .data('result', null)
      .state('running', (s) => {
        s.invoke((i) => i.type('job').id('work'));
        s.on('done.invoke.work', (t) => t.target('finished').assign('result', ({ event }) => event.data));
        s.on('noise', (t) => t.internal());
      })
      .state('finished'),
  ));
  await system.flush();
  actor.post('noise');
  actor.post('noise');
  assert.throws(() => reporter.done({ n: 1 }), { code: 'queue-full' });
  assert.equal(reporter.signal.aborted, false, 'a report that was not taken does not end the invocation');
  assert.throws(() => reporter.event('progress'), { code: 'queue-full' });
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['running']);
  assert.equal(reporter.done({ n: 2 }), true, 'the retried report is taken');
  assert.equal(reporter.signal.aborted, true, 'a taken done() ends the invocation');
  assert.equal(reporter.done({ n: 3 }), false, 'an ended invocation reports nothing');
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['finished']);
  assert.deepEqual(actor.inspect().data.result, { n: 2 });
  system.close();
}

// unavailable(): core retires the invocation and the parent gets
// error.communication.
async function unavailableInvoker() {
  const system = createSystem({
    invokers: { flaky: { start() { throw new Error('no backend'); } } },
  });
  const definition = system.define(
    statechart({ family: 'flaky', revision: 'v1' })
      .state('running', (s) => {
        s.invoke((i) => i.type('flaky').id('svc'));
        s.on('error.communication', (t) => t.target('failed'));
      })
      .state('failed'),
  );
  const actor = system.spawn(definition);
  await until(system, () => actor.inspect().activeStates.includes('failed'), 'error.communication');
  system.close();
}

// The in-system SCXML invoker: the child runs in the same system and its
// completion reaches the parent as done.invoke.<id>.
async function scxmlInvoker() {
  const system = createSystem();
  const child = system.define(
    statechart({ family: 'child', revision: 'v1' })
      .data('greeting', 'none')
      .state('work', (s) => {
        s.on('finish', (t) => t.target('over'));
      })
      .final('over', (f) => f.doneData((d) => d.content(({ data }) => `done: ${data.greeting}`))),
  );
  const parent = system.define(
    statechart({ family: 'parent', revision: 'v1' })
      .data('answer', null)
      .state('waiting', (s) => {
        s.invoke((i) => i.type('scxml').id('kid').content(child).param('greeting', 'hi'));
        s.on('poke', (t) => t.send('finish', (send) => send.to('#_kid')));
        s.on('done.invoke.kid', (t) => t.target('happy').assign('answer', ({ event }) => event.data));
      })
      .state('happy'),
  );
  const actor = system.spawn(parent);
  await system.flush();
  const children = [...system.actors()].filter((view) => view.definition.family === 'child');
  assert.equal(children.length, 1, 'the child runs in the same system');
  actor.post('poke');
  await until(system, () => actor.inspect().activeStates.includes('happy'), 'done.invoke.kid');
  assert.equal(actor.inspect().data.answer, 'done: hi', 'params became the child binding');
  system.close();
}

// Exiting the invoking state destroys an SCXML child.
async function scxmlCancel() {
  const system = createSystem();
  const child = system.define(statechart({ family: 'child', revision: 'v1' }).state('forever'));
  const parent = system.define(
    statechart({ family: 'parent', revision: 'v1' })
      .state('waiting', (s) => {
        s.invoke((i) => i.type('scxml').id('kid').content(child));
        s.on('leave', (t) => t.target('gone'));
      })
      .state('gone'),
  );
  const actor = system.spawn(parent);
  await system.flush();
  const count = () => [...system.actors()].filter((view) => view.definition.family === 'child').length;
  assert.equal(count(), 1);
  actor.post('leave');
  await system.flush();
  assert.equal(count(), 0, 'the child was destroyed');
  system.close();
}

// close() aborts the processors' signal and cancels live invocations.
async function closeCancels() {
  let context;
  let cancelled;
  const system = createSystem({
    io: { ws: { send: (request, ctx) => { context = ctx; } } },
    invokers: { svc: { start: () => ({ cancel: (reason) => { cancelled = reason; } }) } },
  });
  const definition = system.define(
    statechart({ family: 'closing', revision: 'v1' }).state('idle', (s) => {
      s.invoke((i) => i.type('svc'));
      s.entry((a) => a.send('x', (send) => send.via('ws')));
    }),
  );
  system.spawn(definition);
  await system.flush();
  assert.equal(context.signal.aborted, false);
  system.close();
  assert.equal(context.signal.aborted, true);
  assert.equal(cancelled, 'closed');
}

// Steady state: an outbound I/O send per message makes no addon allocator call.
async function steadyState() {
  let sent = 0;
  const system = createSystem({ io: { ws: { send: () => { sent += 1; } } } });
  const definition = system.define(
    statechart({ family: 'echo', revision: 'v1' }).state('idle', (s) => {
      s.on('in', (t) => t.send('out', (send) => send.via('ws').data(({ event }) => event.data)));
    }),
  );
  const actors = Array.from({ length: 100 }, () => system.spawn(definition));
  await system.flush();
  const round = async () => {
    for (const actor of actors) {
      actor.post('in', { n: 1 });
    }
    await system.flush();
  };
  for (let warm = 0; warm < 5; warm += 1) {
    await round();
  }
  const addonCalls = () => {
    const { memory } = system.stats();
    let calls = 0;
    for (const [category, counters] of Object.entries(memory)) {
      if (category !== 'total' && category !== 'core') {
        calls += counters.allocations + counters.frees;
      }
    }
    return calls;
  };
  const before = addonCalls();
  const sentBefore = sent;
  for (let rounds = 0; rounds < 10; rounds += 1) {
    await round();
  }
  assert.equal(sent - sentBefore, 1000);
  assert.equal(addonCalls() - before, 0, 'no addon allocator call in steady state');
  system.close();
}

(async () => {
  let current = 'start';
  const watchdog = setTimeout(() => {
    console.error(`services.js: ${current} did not finish in time`);
    process.exit(1);
  }, Number(process.env.SERVICES_TIMEOUT_MS ?? 60_000));
  for (const test of [
    logSink, ioCompletes, ioLiteralTarget, ioFails, delayedCustomSend, javascriptInvoker, invokerLiteralSource, doneRetried, unavailableInvoker, scxmlInvoker, scxmlCancel,
    closeCancels, steadyState,
  ]) {
    current = test.name;
    await test();
  }
  clearTimeout(watchdog);
  const stats = native.environmentStats();
  assert.equal(stats.leakedBytes, 0, 'every system closed without leaking');
  assert.equal(stats.valuesLive, 0, 'no value box outlived its system');
  console.log('services.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
