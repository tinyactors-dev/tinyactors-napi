'use strict';

// Step 11: the JavaScript data model (ROADMAP step 11; ADR 0011). Runs on
// Node and Bun.

const assert = require('node:assert/strict');
const native = require('../lib/native');
const { nativeOf } = require('../lib/system');
const { createSystem, statechart, literal, content, TinyactorsError } = require('..');

const { core } = native;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function assertCode(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.code, code, error.message);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return true;
  });
}

// Data, assignments, conditions and event data.
async function counter() {
  const system = createSystem();
  const definition = system.define(
    statechart({ family: 'counter', revision: 'v1' })
      .data('count', 0)
      .data('step', literal(() => 'a function kept as data'))
      .state('idle', (s) => {
        s.on('inc', (t) => t.assign('count', function (context) { return this.count + (context.event.data ?? 1); }));
        s.on('check', (t) => t.when(({ data }) => data.count > 5).target('big'));
      })
      .state('big'),
  );
  assert.equal(definition.inspect().datamodel, 'javascript');
  const actor = system.spawn(definition);
  await system.flush();
  assert.equal(actor.inspect().data.count, 0);
  assert.equal(typeof actor.inspect().data.step, 'function', 'literal() keeps a function as data');
  actor.post('inc');
  actor.post('check');
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['idle'], 'the condition was false');
  actor.post('inc', 10);
  actor.post('check');
  await system.flush();
  assert.equal(actor.inspect().data.count, 11);
  assert.deepEqual(actor.inspect().activeStates, ['big']);
  system.close();
}

// A spawn binding is the actor's data; a bound name skips its initializer.
async function binding() {
  const system = createSystem();
  const definition = system.define(
    statechart({ family: 'bound', revision: 'v1' }).data('name', 'nobody').data('seen', 0).state('idle'),
  );
  const root = { name: 'ada' };
  const actor = system.spawn(definition, { binding: root });
  await system.flush();
  assert.equal(actor.inspect().data, root, 'the data object is shared, not copied');
  assert.deepEqual(root, { name: 'ada', seen: 0 });
  system.close();
}

// The evaluation context: `this`, event fields, system variables, In().
async function context() {
  let kept;
  const seen = {};
  const system = createSystem();
  const definition = system.define(
    statechart({ family: 'context', revision: 'v1', name: 'ctx' })
      .data('mark', 'x')
      .state('idle', (s) => {
        s.on('look', (t) =>
          t.script(function (context) {
            kept = context;
            seen.self = this === context.data;
            seen.event = { name: context.event.name, type: context.event.type, data: context.event.data };
            seen.inIdle = context.inState('idle');
            seen.inMissing = context.inState('missing');
            seen.sessionID = context.sessionID;
            seen.name = context.name;
            seen.processors = Object.keys(context.ioProcessors);
          }),
        );
        s.on('source', (t) => t.when("In('idle')").target('named'));
      })
      .state('named', (s) => s.on('name', (t) => t.when('mark').target('done')))
      .state('done'),
  );
  const actor = system.spawn(definition);
  await system.flush();
  actor.post('look', { payload: 1 });
  await system.flush();
  assert.equal(seen.self, true, 'this is the data');
  assert.deepEqual(seen.event, { name: 'look', type: 'external', data: { payload: 1 } });
  assert.equal(seen.inIdle, true);
  assert.equal(seen.inMissing, false, 'In() of a state the chart does not have is false');
  assert.equal(seen.sessionID, String(actor.inspect().sessionID));
  assert.equal(seen.name, 'ctx');
  assert.ok(seen.processors.includes('scxml'));
  assertCode(() => kept.data, 'invalid', /only while its expression runs/);
  // Source text: In(state) and data names.
  actor.post('source');
  actor.post('name');
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['done']);
  // Other source text is refused when the chart is defined.
  assertCode(
    () => system.define(statechart({ family: 'src', revision: 'v1' }).data('x', 1).state('a', (s) => s.on('e', (t) => t.when('x > 1')))),
    'invalid',
    /condition: the JavaScript data model takes functions/,
  );
  system.close();
}

// Exceptions become error.execution with the thrown value as data; an
// undeclared name cannot be assigned; JavaScript inside a callback cannot
// call core, but can post.
async function errors() {
  const system = createSystem();
  const probe = system.define(statechart({ family: 'probe', revision: 'v1' }).state('idle', (s) => s.on('hi', (t) => t.target('greeted'))).state('greeted'));
  const target = system.spawn(probe);
  const definition = system.define(
    statechart({ family: 'errors', revision: 'v1' })
      .data('message', null)
      .data('code', null)
      .state('idle', (s) => {
        s.on('throw', (t) => t.when(() => { throw new Error('boom'); }).target('never'));
        s.on('undeclared', (t) => t.assign('nope', 1));
        s.on('reenter', (t) =>
          t.script(function () {
            try {
              core.system_time(nativeOf(system));
            } catch (error) {
              this.code = error.code;
            }
            target.post('hi');
          }),
        );
        s.on('error.execution', (t) => t.assign('message', ({ event }) => event.data?.message ?? event.name));
      })
      .state('never'),
  );
  const actor = system.spawn(definition);
  await system.flush();
  actor.post('throw');
  await system.flush();
  assert.equal(actor.inspect().data.message, 'boom', 'the thrown value is the error event data');
  assert.deepEqual(actor.inspect().activeStates, ['idle']);
  actor.post('undeclared');
  await system.flush();
  assert.match(actor.inspect().data.message, /error\.execution/);
  assert.equal(actor.inspect().data.nope, undefined);
  // Interning a new event name is a core call, so the name is interned
  // before the callback posts it (a dead letter, here).
  system.post({ family: 'nobody', name: 'here' }, 'hi');
  actor.post('reenter');
  await system.flush();
  assert.equal(actor.inspect().data.code, 'reentrant');
  assert.deepEqual(target.inspect().activeStates, ['greeted'], 'posting from a callback is allowed');
  system.close();
}

// <foreach>, <donedata> and completion data in the done hook.
async function foreachAndDoneData() {
  const done = [];
  const system = createSystem({ done: (record) => done.push(record) });
  const definition = system.define(
    statechart({ family: 'sum', revision: 'v1' })
      .data('sum', 0)
      .state('run', (s) =>
        s.on('go', (t) =>
          t.forEach(({ event }) => event.data, 'item', (b) => b.assign('sum', function () { return this.sum + this.item * this.i; }), 'i')
            .target('end'),
        ),
      )
      .final('end', (f) => f.doneData((d) => d.param('total', function () { return this.sum; }))),
  );
  const actor = system.spawn(definition);
  await system.flush();
  actor.post('go', [1, 2, 3, 4]);
  await system.flush();
  assert.equal(done.length, 1);
  assert.equal(done[0].finalState, 'end');
  assert.deepEqual(done[0].data, { total: 0 * 1 + 1 * 2 + 2 * 3 + 3 * 4 });
  assert.equal(system.exists(actor), false, 'finished: "destroy"');
  system.close();
}

// A <foreach> item or index that is not a variable name is error.execution
// before anything is bound or run (SCXML 4.6).
async function foreachNames() {
  const system = createSystem();
  for (const [item, index] of [["'continue'", undefined], ['item', 'not a name']]) {
    const definition = system.define(
      statechart({ family: 'names', revision: 'v1' })
        .data('runs', 0)
        .data('errors', 0)
        .state('run', (s) => {
          s.on('go', (t) =>
            t.forEach(() => [1, 2, 3], item, (b) => b.assign('runs', function () { return this.runs + 1; }), index));
          s.on('error.execution', (t) => t.assign('errors', function () { return this.errors + 1; }));
        }),
    );
    const actor = system.spawn(definition);
    await system.flush();
    actor.post('go');
    await system.flush();
    assert.deepEqual(actor.inspect().data, { runs: 0, errors: 1 }, `${item} / ${index}`);
  }
  system.close();
}

// A small actionBudget splits a <foreach> over a large array across turns,
// and other actors run between them (core ADR 0061; left by step 5).
async function foreachAcrossTurns() {
  const system = createSystem({ scheduling: { actionBudget: 50 } });
  const busy = system.spawn(
    system.define(
      statechart({ family: 'busy', revision: 'v1' })
        .data('items', literal(Array.from({ length: 1000 }, (_, index) => index)))
        .data('count', 0)
        .state('start', (s) => s.always((t) => t.target('busy')))
        .state('busy', (s) => s.entry((a) => a.forEach('items', 'item', (b) => b.assign('count', function () { return this.count + 1; })))),
    ),
  );
  const other = system.spawn(system.define(statechart({ family: 'other', revision: 'v1' }).state('idle')));
  await tick();
  await tick();
  assert.equal(busy.inspect().macrostepInProgress, true, 'paused inside the foreach');
  assert.deepEqual(other.inspect().activeStates, ['idle'], 'another actor ran meanwhile');
  let turns = 2;
  while (busy.inspect().scheduling === 'runnable') {
    await tick();
    turns += 1;
    assert.ok(turns < 1000);
  }
  assert.equal(busy.inspect().data.count, 1000);
  assert.ok(turns >= 20, `1000 iterations at 50 actions per resume took ${turns} turns`);
  system.close();
}

// Each callback opens its own handle scope, so garbage an expression makes
// can be collected before the turn ends (ADR 0007).
async function handleScopes() {
  const gc = globalThis.gc ?? (typeof Bun === 'undefined'
    ? (require('node:v8').setFlagsFromString('--expose-gc'), require('node:vm').runInNewContext('gc'))
    : () => Bun.gc(true));
  const heap = [];
  const system = createSystem({ scheduling: { actionBudget: 0 } });
  const definition = system.define(
    statechart({ family: 'garbage', revision: 'v1' })
      .data('items', literal(Array.from({ length: 20000 }, (_, index) => index)))
      .data('last', null)
      .state('start', (s) => s.always((t) => t.target('run')))
      .state('run', (s) =>
        s.entry((a) =>
          a.forEach('items', 'item', (b) =>
            b.assign('last', function () {
              if (this.item % 5000 === 0) {
                gc();
                heap.push(process.memoryUsage().heapUsed);
              }
              return 'x'.repeat(1000) + this.item; // about 1 KB of garbage per call
            }),
          ),
        ),
      ),
  );
  system.spawn(definition);
  await system.flush();
  assert.equal(heap.length, 4);
  const growth = heap[3] - heap[0];
  assert.ok(growth < 8 * 1024 * 1024, `heap grew ${growth} bytes over 15,000 expressions in one turn`);
  system.close();
}

// Values return to zero after close (ADR 0011 point 7).
async function valuesAfterClose() {
  const live = () => native.environmentStats().valuesLive;
  const start = live();
  const system = createSystem();
  const definition = system.define(statechart({ family: 'held', revision: 'v1' }).data('list', []).state('idle'));
  const actors = Array.from({ length: 10 }, () => system.spawn(definition));
  await system.flush();
  for (const actor of actors) {
    actor.post('ignored', { payload: true });
  }
  assert.ok(live() > start);
  const { values } = system.stats();
  assert.equal(values.live, live() - start, 'stats() counts the same boxes');
  assert.ok(values.made >= values.live);
  system.close();
  assert.equal(live(), start, 'close releases every value');
  assert.equal(native.environmentStats().leakedBytes, 0);
}

// The ping-pong player chart from docs/design.md, as written there. Two named
// players rally a ball through delayed sends until each has hit `limit`
// volleys.
const player = () =>
  statechart({ family: 'player', revision: 'player/v1', name: 'player' })
    .data('partner', '#_actor_player/nobody')
    .data('volleys', 0)
    .data('limit', 15)
    .data('rallying', false)
    .data('server', false)
    .initial('idle')
    .state('idle', (idle) => {
      idle.always((transition) => {
        transition.when(({ data }) => data.rallying && data.server).target('rallying');
      });
      idle.on('serve', (transition) => {
        transition.target('rallying').assign('volleys', 1).assign('rallying', true).assign('server', true);
      });
    })
    .state('rallying', (rallying) => {
      rallying.entry((actions) => {
        actions
          .log('hit', ({ data }) => `RALLY volley ${data.volleys} -> ${data.partner}`)
          .send('ball', (send) => {
            send.id('ball').to(({ data }) => data.partner).after('1s');
          });
      });
      rallying.exit((actions) => {
        actions.cancel('ball');
      });
      rallying.on('ball', (transition) => {
        transition
          .when(({ data }) => data.volleys < data.limit)
          .target('rallying')
          .assign('volleys', ({ data }) => data.volleys + 1);
      });
    });

async function pingPong() {
  const system = createSystem({ clock: 'manual' });
  const definition = system.define(player());
  const ping = system.spawn(definition, { name: 'ping', binding: { partner: '#_actor_player/pong' } });
  const pong = system.spawn(definition, { name: 'pong', binding: { partner: '#_actor_player/ping' } });
  await system.flush();
  assert.deepEqual(ping.inspect().activeStates, ['idle']);
  ping.post('serve');
  pong.post('serve');
  await system.flush();
  for (let second = 0; second < 40; second += 1) {
    await system.advanceBy(1000);
  }
  assert.equal(ping.inspect().data.volleys, 15);
  assert.equal(pong.inspect().data.volleys, 15);
  assert.deepEqual(ping.inspect().activeStates, ['rallying']);
  system.close();
}

// A receiver reads _event.origin of a message whose named sender finished
// and was destroyed before delivery, and replies to it (core ADR 0065): the
// sender's name has no actor now, so the receiver gets error.communication
// with the reason and the target (napi ADR 0022), and no dead letter.
async function originOfADestroyedSender() {
  const dead = [];
  const system = createSystem({ scheduling: { messageBudget: 1 }, deadLetter: (record) => dead.push(record) });
  const receiver = system.spawn(
    system.define(
      statechart({ family: 'receiver', revision: 'v1' })
        .data('origin', null)
        .data('failure', null)
        .state('idle', (s) => {
          s.on('hello', (t) =>
            t.assign('origin', ({ event }) => event.origin).send('reply', (send) => send.to(({ event }) => event.origin)),
          );
          s.on('error.communication', (t) => t.assign('failure', ({ event }) => event.data));
        }),
    ),
    { name: 'b' },
  );
  receiver.post('first');
  receiver.post('second');
  const sender = system.spawn(
    system.define(
      statechart({ family: 'sender', revision: 'v1' })
        .data('unused', 0)
        .state('start', (s) => {
          s.entry((a) => a.send('hello', (send) => send.to('#_actor_receiver/b')));
          s.always((t) => t.target('done'));
        })
        .final('done'),
    ),
    { name: 'a' },
  );
  await system.flush();
  assert.equal(system.exists(sender), false, 'the sender finished and was destroyed');
  assert.equal(receiver.inspect().data.origin, '#_actor_sender/a');
  assert.deepEqual(receiver.inspect().data.failure, { reason: 'not-found', target: { family: 'sender', name: 'a' } });
  assert.equal(dead.find((record) => record.event === 'reply'), undefined, 'the reply is not a dead letter');
  system.close();
}

// When core cannot render a system variable for lack of memory, reading it
// throws and the expression fails as error.execution (core ADR 0070, open
// point 1). It never reads as undefined, and catching the exception in the
// chart's code does not hide the failure.
async function failedSystemVariable() {
  const system = createSystem();
  const definition = system.define(
    statechart({ family: 'unrendered', revision: 'v1' })
      .data('seen', null)
      .data('caught', null)
      .data('errors', [])
      .state('idle', (s) => {
        s.on('long', (t) => t.assign('seen', ({ event }) => event.name));
        s.on('quiet', (t) =>
          t.script(function (context) {
            try {
              this.caught = context.event.name;
            } catch (error) {
              this.caught = error.code;
            }
          }),
        );
        s.on('error.execution', (t) =>
          t.assign('errors', function ({ event }) { return [...this.errors, event.data?.message]; }),
        );
      }),
  );
  const actor = system.spawn(definition);
  await system.flush();
  // One segment far larger than any scratch block: joining `long.` and it
  // is the only allocation of 100 KB or more the delivery makes, because
  // the name is interned when it is posted.
  const segment = 'x'.repeat(200_000);
  const nativeSystem = nativeOf(system);

  actor.post(`long.${segment}`);
  nativeSystem.refuseAllocationsFrom(100_000);
  await system.flush();
  nativeSystem.refuseAllocationsFrom(0);
  let data = actor.inspect().data;
  assert.equal(data.seen, null, 'a failed rendering is not read as undefined');
  assert.equal(data.errors.length, 1, 'the failure is error.execution');
  assert.match(data.errors[0], /could not render a system variable/);

  actor.post(`quiet.${segment}`);
  nativeSystem.refuseAllocationsFrom(100_000);
  await system.flush();
  nativeSystem.refuseAllocationsFrom(0);
  data = actor.inspect().data;
  assert.equal(data.caught, 'out-of-memory', 'the getter threw');
  assert.equal(data.errors.length, 2, 'catching the exception does not hide the failure');

  // With memory again, the same variable renders.
  actor.post(`long.${segment}`);
  await system.flush();
  assert.equal(actor.inspect().data.seen, `long.${segment}`);
  assert.equal(actor.inspect().data.errors.length, 2);
  system.close();
  assert.equal(native.environmentStats().leakedBytes, 0);
}

// content(): literal SCXML <content> from the builder. An I/O processor and
// an invoker get it as text with its media type; anywhere else it is a
// value, JSON when it parses and space-normalized text otherwise, which the
// JavaScript data model every builder chart gets can make of it.
async function literalContent() {
  const requests = [];
  const started = [];
  const finished = [];
  const system = createSystem({
    clock: 'manual',
    io: { cap: { send(request) { requests.push(request); } } },
    invokers: { svc: { start(request) { started.push(request); } } },
    done: (record) => finished.push(record.data),
  });
  const csv = content('a,b\n1,2', { mediaType: 'text/csv' });
  const json = content('{"n": 1}', { mediaType: 'application/json' });

  const receiver = system.spawn(system.define(statechart({ family: 'receiver', revision: 'v1' })
    .data('got', null)
    .state('a', (s) => s.on('m', (t) => t.assign('got', ({ event }) => event.data)))), { name: 'r' });
  // No data, script or function, and still the JavaScript data model.
  const sender = system.define(statechart({ family: 'sender', revision: 'v1' })
    .state('a', (s) => s
      .entry((e) => e
        .send('raw', (send) => send.via('cap').to('x').data(csv))
        .send('params', (send) => send.via('cap').to('x').param('p', csv))
        .send('m', (send) => send.to('#_actor_receiver/r').data(json)))
      .invoke((invoke) => invoke.type('svc').content(csv).param('p', json))));
  assert.equal(sender.inspect().datamodel, 'javascript');
  system.spawn(sender);
  await system.flush();
  assert.deepEqual(requests.map(({ event, content: text, contentType, data }) => ({ event, text, contentType, data })), [
    { event: 'raw', text: 'a,b\n1,2', contentType: 'text/csv', data: undefined },
    { event: 'params', text: undefined, contentType: undefined, data: { p: 'a,b 1,2' } },
  ]);
  assert.deepEqual(receiver.data().got, { n: 1 });
  assert.equal(started[0].content, 'a,b\n1,2');
  assert.equal(started[0].contentType, 'text/csv');
  assert.deepEqual(started[0].params, { p: { n: 1 } });

  const values = system.spawn(system.define(statechart({ family: 'values', revision: 'v1' })
    .data('parsed', json)
    .data('text', content('  hello \n  world '))
    .data('bytes', content(new Uint8Array([91, 49, 93])))
    .data('assigned', null)
    .data('raised', null)
    .state('a', (s) => s
      .entry((e) => e.assign('assigned', csv).raise('r', json))
      .on('r', (t) => t.assign('raised', ({ event }) => event.data)))));
  system.spawn(system.define(statechart({ family: 'finishing', revision: 'v1' })
    .initial('z')
    .final('z', (f) => f.doneData((d) => d.content(csv)))));
  await system.flush();
  assert.deepEqual(values.data(), { parsed: { n: 1 }, text: 'hello world', bytes: [1], assigned: 'a,b 1,2', raised: { n: 1 } });
  assert.deepEqual(finished, ['a,b 1,2']);

  // The bytes are copied, and only text or bytes with a non-empty media type are content.
  const source = new Uint8Array([104, 105]);
  const copied = content(source);
  source[0] = 0;
  assert.deepEqual([...copied.bytes], [104, 105]);
  assertCode(() => content(5), 'invalid', /string or a Uint8Array/);
  assertCode(() => content('x', { mediaType: '' }), 'invalid', /mediaType/);
  system.close();
}

(async () => {
  await counter();
  await failedSystemVariable();
  await pingPong();
  await originOfADestroyedSender();
  await binding();
  await context();
  await errors();
  await foreachAndDoneData();
  await foreachNames();
  await foreachAcrossTurns();
  await handleScopes();
  await valuesAfterClose();
  await literalContent();
  console.log('datamodel.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
