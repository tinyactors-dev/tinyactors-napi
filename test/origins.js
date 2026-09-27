'use strict';

// I/O origins and the processor registry (core ADR 0068). A processor posts
// an event with an origin of one of three classes; a chart answers it with
// send(...).via(event.originType).to(event.origin), and the reply reaches the
// processor that owns the origin. `ioProcessors` lists every processor with
// the location its template renders. Runs on Node and Bun.

const assert = require('node:assert/strict');
const native = require('../lib/native');
const { createSystem, statechart } = require('..');

const LONG_URI = 'http://client.example/callbacks/requests/0123456789abcdef0123456789abcdef';

// Processors that record the replies they get. `ws` refuses a reply to a
// connection that is not open; `http` refuses a second reply to a request.
function processors() {
  const sends = [];
  const open = new Set();
  const answered = new Set();
  return {
    sends,
    open,
    io: {
      peer: {
        location: 'peer://here/{session}',
        origin: 'peer://node/{token}',
        send(request) { sends.push(['peer', request.event, request.target]); },
      },
      ws: {
        location: 'ws://here/{session}',
        send(request) {
          if (!open.has(request.target)) throw new Error('no open connection has that URI');
          sends.push(['ws', request.event, request.target]);
        },
      },
      http: {
        location: 'http://here/{family}/{name}',
        send(request) {
          if (answered.has(request.target)) throw new Error('the request was already answered');
          answered.add(request.target);
          sends.push(['http', request.event, request.target]);
        },
      },
    },
  };
}

function replier() {
  const reply = (send) => send.via(({ event }) => event.originType).to(({ event }) => event.origin ?? '');
  return statechart({ family: 'replier', revision: 'v1' })
    .data('origin', null)
    .data('origintype', null)
    .data('outcome', null)
    .data('processors', null)
    .state('ready', (s) => {
      s.on('ping', (t) =>
        t.assign('origin', ({ event }) => event.origin ?? null)
          .assign('origintype', ({ event }) => event.originType ?? null)
          .send('pong', reply),
      );
      s.on('twice', (t) => t.send('pong', reply).send('pong', reply));
      s.on('probe', (t) => t.assign('processors', ({ ioProcessors }) => JSON.parse(JSON.stringify(ioProcessors))));
      s.on('error.communication', (t) => t.assign('outcome', () => 'error.communication'));
    });
}

async function listsEveryProcessor() {
  const { io } = processors();
  const system = createSystem({ io });
  const definition = system.define(replier());
  const plain = system.spawn(definition);
  const named = system.spawn(definition, { name: 'r1' });
  await system.flush();
  plain.post('probe');
  named.post('probe');
  await system.flush();
  const sessionOf = (actor) => actor.inspect().sessionID;
  const scxml = 'http://www.w3.org/TR/scxml/#SCXMLEventProcessor';
  assert.deepEqual(plain.inspect().data.processors, {
    scxml: { location: `#_scxml_${sessionOf(plain)}` },
    [scxml]: { location: `#_scxml_${sessionOf(plain)}` },
    peer: { location: `peer://here/${sessionOf(plain)}` },
    ws: { location: `ws://here/${sessionOf(plain)}` },
    http: {},
  }, 'an unnamed session has no {family}/{name} location');
  assert.equal(named.inspect().data.processors.http.location, 'http://here/replier/r1');
  system.close();
}

async function repliesPerClass() {
  const { io, sends, open } = processors();
  const system = createSystem({ io });
  const definition = system.define(replier());
  const actor = system.spawn(definition);
  await system.flush();

  // Computed: rendered from the token by the native adapter.
  system.post(actor, 'ping', undefined, { origin: { type: 'peer', token: 7 } });
  await system.flush();
  assert.equal(actor.inspect().data.origin, 'peer://node/7');
  assert.equal(actor.inspect().data.origintype, 'peer');

  // Scoped: a connection's URI, stored once.
  const scope = system.openScope('ws', 'ws://client/1');
  open.add('ws://client/1');
  system.post(actor, 'ping', undefined, { origin: { type: 'ws', scope } });
  await system.flush();

  // Per message: a request's reply URI, a long one included.
  system.post(actor, 'ping', undefined, { origin: { type: 'http', uri: LONG_URI } });
  system.post(actor, 'twice', undefined, { origin: { type: 'http', uri: 'http://client/r/2' } });
  await system.flush();
  assert.deepEqual(sends, [
    ['peer', 'pong', 'peer://node/7'],
    ['ws', 'pong', 'ws://client/1'],
    ['http', 'pong', LONG_URI],
    ['http', 'pong', 'http://client/r/2'],
  ]);
  assert.equal(actor.inspect().data.outcome, 'error.communication', 'a request is answered once');

  // A late reply: the event waits while its connection closes.
  const late = system.openScope('ws', 'ws://client/2');
  open.add('ws://client/2');
  system.post(actor, 'ping', undefined, { origin: { type: 'ws', scope: late } });
  system.closeScope(late);
  open.delete('ws://client/2');
  system.closeScope(late); // closing again does nothing
  await system.flush();
  assert.equal(actor.inspect().data.origin, null, 'a closed scope renders no origin');
  assert.equal(actor.inspect().data.origintype, 'ws', 'the processor is still named');
  assert.throws(() => system.post(actor, 'ping', undefined, { origin: { type: 'ws', scope: late } }),
    (error) => error.code === 'stale');
  assert.throws(() => system.post(actor, 'ping', undefined, { origin: { type: 'ws', token: 1 } }),
    (error) => error.code === 'invalid', 'ws has no origin template');
  assert.throws(() => system.post(actor, 'ping', undefined, { origin: { type: 'nope', uri: 'x' } }),
    (error) => error.code === 'invalid');
  system.closeScope(scope);
  system.close();
}

// SCXML 6.4: a chart sends to an invoked service with the invoke's type
// and #_<invokeid>, and an event from the service names that type as its
// origintype, before and after the invocation ended.
async function invokedService() {
  const sends = [];
  let reporter;
  const system = createSystem({
    io: { svc: { send(request) { sends.push([request.event, request.type, request.target]); } } },
    invokers: { svc: { start(request, report) { reporter = report; } } },
  });
  const reply = (send) => send.via(({ event }) => event.originType).to(({ event }) => event.origin);
  const definition = system.define(
    statechart({ family: 'client', revision: 'v1' })
      .data('origin', null)
      .data('origintype', null)
      .state('using', (s) => {
        s.invoke((i) => i.type('svc').id('svc'));
        s.on('svc.hello', (t) =>
          t.assign('origin', ({ event }) => event.origin)
            .assign('origintype', ({ event }) => event.originType)
            .send('reply', reply)
            .send('direct', (send) => send.via('svc').to('#_svc')),
        );
        s.on('done.invoke.svc', (t) => t.target('after').send('bye', reply));
      })
      .state('after'),
  );
  const actor = system.spawn(definition);
  await system.flush();
  reporter.event('svc.hello');
  await system.flush();
  assert.equal(actor.inspect().data.origin, '#_svc');
  assert.equal(actor.inspect().data.origintype, 'svc');
  reporter.done();
  await system.flush();
  assert.deepEqual(sends, [
    ['reply', 'svc', '#_svc'],
    ['direct', 'svc', '#_svc'],
    ['bye', 'svc', '#_svc'],
  ]);
  system.close();
}

// inspect() reports each event's origin as a tagged EventOrigin, with the
// type and URI the receiver's expressions see: seen while the macrostep that
// takes the event is paused after its first microstep.
async function inspectedOrigins() {
  const { io } = processors();
  let reporter;
  const system = createSystem({
    clock: 'manual',
    scheduling: { resumeBudget: 1 },
    io,
    invokers: { svc: { start(_, report) { reporter = report; } } },
  });
  const receiver = system.spawn(system.define(
    statechart({ family: 'receiver', revision: 'v1' })
      .state('a', (s) => s.invoke((invoke) => invoke.type('svc').id('feed')).on('*', (t) => t.target('b')))
      .state('b', (s) => s.always((t) => t.target('a'))),
  ), { name: 'r' });
  await system.flush();
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const originOf = async (post) => {
    post();
    await turn();
    await turn();
    const { origin } = receiver.inspect().currentEvent;
    await system.flush();
    return origin;
  };

  assert.deepEqual(await originOf(() => receiver.post('byURI', undefined, { origin: { type: 'http', uri: 'http://c/r/1' } })),
                   { kind: 'io', type: 'http', uri: 'http://c/r/1' });
  assert.deepEqual(await originOf(() => receiver.post('byToken', undefined, { origin: { type: 'peer', token: 7 } })),
                   { kind: 'io', type: 'peer', uri: 'peer://node/7' });
  const scope = system.openScope('ws', 'ws://client/9');
  assert.deepEqual(await originOf(() => receiver.post('byScope', undefined, { origin: { type: 'ws', scope } })),
                   { kind: 'io', scope: { index: scope.index, generation: scope.generation }, type: 'ws', uri: 'ws://client/9' });
  // A closed scope keeps its type, and has no URI any more.
  assert.deepEqual(await originOf(() => {
    receiver.post('late', undefined, { origin: { type: 'ws', scope } });
    system.closeScope(scope);
  }), { kind: 'io', scope: { index: scope.index, generation: scope.generation }, type: 'ws' });
  assert.equal(await originOf(() => receiver.post('plain')), undefined);

  const [invocation] = receiver.inspect().invocations;
  assert.deepEqual(await originOf(() => reporter.event('fromService')),
                   { kind: 'invocation', invocation: invocation.id, type: 'svc', uri: '#_feed' });
  const origin = await originOf(() => system.spawn(system.define(
    statechart({ family: 'sender', revision: 'v1' })
      .state('a', (s) => s.entry((e) => e.send('hello', (send) => send.to('#_actor_receiver/r')))),
  ), { name: 's' }));
  assert.deepEqual(origin, { kind: 'actor', actor: { family: 'sender', name: 's' },
                             type: 'http://www.w3.org/TR/scxml/#SCXMLEventProcessor', uri: '#_actor_sender/s' });
  system.close();
}

// A per-message origin in a queued, dead-lettered or dropped message is
// released with it; close() leaves nothing (checked below).
async function originsAreReleased() {
  const { io } = processors();
  const system = createSystem({ io, finished: 'retain' });
  const definition = system.define(
    statechart({ family: 'stopper', revision: 'v1' })
      .state('ready', (s) => s.on('stop', (t) => t.target('stopped')))
      .final('stopped'),
  );
  const actor = system.spawn(definition);
  system.post(actor, 'noise', undefined, { origin: { type: 'http', uri: LONG_URI } });
  system.post(actor, 'stop', undefined, { origin: { type: 'http', uri: 'http://c/r/stop' } });
  system.post(actor, 'late', undefined, { origin: { type: 'http', uri: LONG_URI } });
  await system.flush();
  assert.equal(actor.inspect().activeStates.length, 0);
  system.close();
}

(async () => {
  let current = 'start';
  const watchdog = setTimeout(() => {
    console.error(`origins.js: ${current} did not finish in time`);
    process.exit(1);
  }, Number(process.env.ORIGINS_TIMEOUT_MS ?? 60_000));
  for (const test of [listsEveryProcessor, repliesPerClass, invokedService, inspectedOrigins, originsAreReleased]) {
    current = test.name;
    await test();
  }
  clearTimeout(watchdog);
  const stats = native.environmentStats();
  assert.equal(stats.leakedBytes, 0, 'every system closed without leaking');
  assert.equal(stats.valuesLive, 0, 'no value box outlived its system');
  console.log('origins.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
