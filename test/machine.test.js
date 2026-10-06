'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMachine, createActor, setup, assign, raise, sendTo, sendParent, log, cancel,
  stateIn, and, or, not,
} = require('./binding');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('toggle with assign, final output, status', () => {
  const machine = createMachine({
    id: 'toggle',
    initial: 'inactive',
    context: { count: 0 },
    states: {
      inactive: { on: { TOGGLE: { target: 'active', actions: assign({ count: ({ context }) => context.count + 1 }) } } },
      active: { on: { TOGGLE: 'inactive', STOP: 'done' } },
      done: { type: 'final', output: ({ context }) => ({ toggles: context.count }) },
    },
  });
  const actor = createActor(machine).start();
  assert.equal(actor.getSnapshot().value, 'inactive');
  actor.send({ type: 'TOGGLE' });
  assert.equal(actor.getSnapshot().value, 'active');
  assert.deepEqual(actor.getSnapshot().context, { count: 1 });
  actor.send({ type: 'TOGGLE' });
  actor.send({ type: 'TOGGLE' });
  actor.send({ type: 'STOP' });
  const s = actor.getSnapshot();
  assert.equal(s.status, 'done');
  assert.equal(s.value, 'done');
  assert.deepEqual(s.output, { toggles: 2 });
  assert.deepEqual(s.context, { count: 2 });
  actor.send({ type: 'TOGGLE' }); // ignored after done
  assert.equal(actor.getSnapshot().status, 'done');
});

test('context from input, events carry payloads, nested and parallel values', () => {
  const machine = createMachine({
    initial: 'editing',
    context: ({ input }) => ({ text: input.text }),
    states: {
      editing: {
        type: 'parallel',
        states: {
          bold: { initial: 'off', states: { off: { on: { BOLD: 'on' } }, on: { on: { BOLD: 'off' } } } },
          list: { initial: 'none', states: { none: { on: { BULLETS: 'bullets' } }, bullets: {} } },
        },
        on: { TYPE: { actions: assign({ text: ({ context, event }) => context.text + event.chars }) } },
      },
    },
  });
  const actor = createActor(machine, { input: { text: 'a' } }).start();
  assert.deepEqual(actor.getSnapshot().value, { editing: { bold: 'off', list: 'none' } });
  actor.send({ type: 'BOLD' });
  actor.send({ type: 'TYPE', chars: 'bc' });
  const s = actor.getSnapshot();
  assert.deepEqual(s.value, { editing: { bold: 'on', list: 'none' } });
  assert.equal(s.context.text, 'abc');
  assert.ok(s.matches({ editing: { bold: 'on' } }));
  assert.ok(s.matches('editing'));
  assert.ok(!s.matches({ editing: { list: 'bullets' } }));
});

test('guards: inline, named with params, and/or/not, stateIn', () => {
  const machine = setup({
    guards: {
      isAdult: ({ context }) => context.age >= 18,
      above: ({ context }, params) => context.age > params.min,
    },
  }).createMachine({
    initial: 'p',
    context: { age: 20 },
    states: {
      p: {
        type: 'parallel',
        states: {
          a: {
            initial: 'idle',
            states: {
              idle: {
                on: {
                  CHECK: [
                    { guard: and(['isAdult', not({ type: 'above', params: { min: 30 } })]), target: 'adult' },
                    { target: 'minor' },
                  ],
                  CHECK2: { guard: or([({ context }) => context.age > 99, stateIn('p.b.ready')]), target: 'adult' },
                  CHECK3: { guard: stateIn('p.b.ready'), target: 'minor' },
                },
              },
              adult: {},
              minor: {},
            },
          },
          b: { initial: 'ready', states: { ready: {} } },
        },
      },
    },
  });
  const a1 = createActor(machine).start();
  a1.send({ type: 'CHECK' });
  assert.ok(a1.getSnapshot().matches({ p: { a: 'adult' } }));
  const a2 = createActor(machine).start();
  a2.send({ type: 'CHECK2' });
  assert.ok(a2.getSnapshot().matches({ p: { a: 'adult' } }));
  const a3 = createActor(machine).start();
  a3.send({ type: 'CHECK3' });
  assert.ok(a3.getSnapshot().matches({ p: { a: 'minor' } }));
});

test('entry/exit/transition action order, raise, always', () => {
  const trace = [];
  const t = (s) => () => trace.push(s);
  const machine = createMachine({
    initial: 'a',
    context: { n: 0 },
    states: {
      a: {
        entry: t('enter a'),
        exit: t('exit a'),
        on: { GO: { target: 'b', actions: [t('go'), raise({ type: 'NEXT' })] } },
      },
      b: {
        entry: t('enter b'),
        on: { NEXT: { target: 'c', actions: assign({ n: 5 }) } },
      },
      c: {
        entry: t('enter c'),
        always: [{ guard: ({ context }) => context.n > 3, target: 'd', actions: t('always') }],
      },
      d: { entry: t('enter d') },
    },
  });
  const actor = createActor(machine).start();
  actor.send({ type: 'GO' });
  assert.deepEqual(trace, ['enter a', 'exit a', 'go', 'enter b', 'enter c', 'always', 'enter d']);
  assert.equal(actor.getSnapshot().value, 'd');
});

test('delayed transitions (after), named delays, cancellation on exit', async () => {
  const machine = setup({ delays: { quick: 20 } }).createMachine({
    initial: 'green',
    states: {
      green: { after: { quick: 'yellow' } },
      yellow: { after: { 30: 'red' }, on: { PANIC: 'blinking' } },
      red: {},
      blinking: {},
    },
  });
  const actor = createActor(machine).start();
  assert.equal(actor.getSnapshot().value, 'green');
  await wait(40);
  assert.equal(actor.getSnapshot().value, 'yellow');
  actor.send({ type: 'PANIC' }); // leaving yellow cancels its timer
  await wait(60);
  assert.equal(actor.getSnapshot().value, 'blinking');
  const a2 = createActor(machine).start();
  await wait(100);
  assert.equal(a2.getSnapshot().value, 'red');
  a2.stop();
  actor.stop();
});

test('invoked child machine: input, sendParent, sendTo, onDone with output', () => {
  const child = createMachine({
    id: 'child',
    initial: 'working',
    context: ({ input }) => ({ base: input.base }),
    states: {
      working: {
        entry: sendParent(({ context }) => ({ type: 'PROGRESS', value: context.base })),
        on: { FINISH: { target: 'finished', actions: assign({ base: ({ context, event }) => context.base + event.add }) } },
      },
      finished: { type: 'final', output: ({ context }) => ({ result: context.base }) },
    },
  });
  const parent = setup({ actors: { child } }).createMachine({
    initial: 'running',
    context: { progress: [], result: null },
    states: {
      running: {
        invoke: {
          id: 'worker',
          src: 'child',
          input: ({ context }) => ({ base: 40 }),
          onDone: { target: 'complete', actions: assign({ result: ({ event }) => event.output.result }) },
        },
        on: {
          PROGRESS: {
            actions: [
              assign({ progress: ({ context, event }) => [...context.progress, event.value] }),
              sendTo('worker', { type: 'FINISH', add: 2 }),
            ],
          },
        },
      },
      complete: {},
    },
  });
  const actor = createActor(parent).start();
  const s = actor.getSnapshot();
  assert.equal(s.value, 'complete');
  assert.deepEqual(s.context.progress, [40]);
  assert.equal(s.context.result, 42);
});

test('history, tags, log, errors in user code, subscribe/unsubscribe, stop', () => {
  const logs = [];
  const machine = createMachine({
    initial: 'player',
    states: {
      player: {
        initial: 'playing',
        tags: ['on'],
        states: {
          playing: { tags: ['audible'], on: { PAUSE: 'paused' } },
          paused: {},
          hist: { type: 'history' },
        },
        on: { POWER: 'off' },
      },
      off: {
        entry: log(({ event }) => `off after ${event.type}`, 'player'),
        on: { POWER: 'player.hist', BOOM: { actions: () => { throw new Error('boom'); } } },
      },
    },
  });
  const seen = [];
  const actor = createActor(machine, { logger: (...a) => logs.push(a.join(' ')) }).start();
  const sub = actor.subscribe((s) => seen.push(s.value));
  assert.ok(actor.getSnapshot().hasTag('audible'));
  actor.send({ type: 'PAUSE' });
  assert.ok(!actor.getSnapshot().hasTag('audible'));
  assert.ok(actor.getSnapshot().hasTag('on'));
  actor.send({ type: 'POWER' });
  assert.deepEqual(logs, ['player off after POWER']);
  actor.send({ type: 'POWER' });
  assert.deepEqual(actor.getSnapshot().value, { player: 'paused' }); // history restored
  sub.unsubscribe();
  actor.send({ type: 'POWER' });
  actor.send({ type: 'BOOM' });
  assert.equal(actor.getSnapshot().error.message, 'boom'); // error.execution, actor keeps running
  assert.equal(actor.getSnapshot().value, 'off');
  assert.deepEqual(seen, [{ player: 'paused' }, 'off', { player: 'paused' }]);
  actor.stop();
  assert.equal(actor.getSnapshot().status, 'stopped');
});

test('a runaway eventless loop does not block the event loop', async () => {
  const machine = createMachine({
    initial: 'a',
    context: { n: 0 },
    states: {
      a: { always: { target: 'b', actions: assign({ n: ({ context }) => context.n + 1 }) } },
      b: { always: 'a', on: { HALT: 'halted' } },
      halted: {},
    },
  });
  const actor = createActor(machine).start();
  try {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 1);
    await wait(50);
    clearInterval(iv);
    assert.ok(ticks > 5, `event loop starved (${ticks} ticks)`);
    assert.ok(actor.getSnapshot().context.n > 100);
    // other actors keep working meanwhile (external events of the looper wait
    // for a stable configuration, per SCXML run-to-completion)
    const other = createActor(createMachine({ initial: 'x', states: { x: { on: { GO: 'y' } }, y: {} } })).start();
    other.send({ type: 'GO' });
    assert.equal(other.getSnapshot().value, 'y');
  } finally {
    actor.stop();
  }
  assert.equal(actor.getSnapshot().status, 'stopped');
});

test('provide() overrides implementations; toSCXML exposes the compiled chart', () => {
  const machine = createMachine(
    { initial: 'a', states: { a: { on: { GO: { guard: 'allowed', target: 'b' } } }, b: {} } },
    { guards: { allowed: () => false } },
  );
  const blocked = createActor(machine).start();
  blocked.send({ type: 'GO' });
  assert.equal(blocked.getSnapshot().value, 'a');
  const open = createActor(machine.provide({ guards: { allowed: () => true } })).start();
  open.send({ type: 'GO' });
  assert.equal(open.getSnapshot().value, 'b');
  assert.match(machine.toSCXML(), /<transition event="GO" cond="allowed" target="b"\/>/); // readable chart
});

test('cancel() of a delayed raise', async () => {
  const machine = createMachine({
    initial: 'a',
    states: {
      a: {
        entry: raise({ type: 'LATE' }, { delay: 20, id: 'late' }),
        on: { CANCEL: { actions: cancel('late') }, LATE: 'b' },
      },
      b: {},
    },
  });
  const actor = createActor(machine).start();
  actor.send({ type: 'CANCEL' });
  await wait(40);
  assert.equal(actor.getSnapshot().value, 'a');
  actor.stop();
});

test('contexts compile to one <data> per property, assigns to one <assign> per property', () => {
  let calls = 0;
  const m = createMachine({
    id: 'props',
    context: ({ input = {} }) => ({
      a: (calls++, input.a ?? 1), // it's a comment, with a quote
      b: [],
      /* a block comment, with (parens */ c: `t${input.a}, ${'{'}`,
      d: /[,)}]/.test('x,') ? 'yes' : 'no',
      'e-f': { nested: [1, 2, { x: 3 }] },
      g: input.a > 1 ? 2 / 1 : 0,
    }),
    initial: 's',
    states: {
      s: {
        on: {
          SWAP: { actions: assign(({ context }) => ({ a: context.g, g: context.a })) },
          SWAP2: { actions: assign({ a: ({ context }) => context.g, g: ({ context }) => context.a }) },
          MIXED: { actions: assign(({ context }) => ({ b: 'const', a: context.b })) },
          OPAQUE: {
            actions: assign(({ context }) => {
              const n = context.g + 1;
              return { g: n };
            }),
          },
        },
      },
    },
  });
  const xml = m.toSCXML();
  for (const re of [
    /<data id="a" expr="\(calls\+\+, input.a \?\? 1\)"\/>/,
    /<data id="b" expr="\[\]"\/>/,
    // Bun transpiles the source toString() returns: it folds ${'{'} to {,
    /<data id="c" expr="`t\$\{input.a\}, (\$\{'\{'\}|\{)`"\/>/,
    /<data id="e-f" expr="\{ nested: \[1, 2, \{ x: 3 \}\] \}"\/>/,
    /<assign location="a" expr="context.g"\/>\s*<assign location="g" expr="context.a"\/>/,
    // and rewrites 'const' as "const", which changes the attribute's quotes
    /<assign location="a" expr="context.b"\/>\s*<assign location="b" expr=("'const'"|'"const"')\/>/,
  ])
    assert.match(xml, re);
  assert.doesNotMatch(xml, /<data id="context"/);
  // only an opaque function (a block body) still assigns a partial context
  assert.equal(xml.match(/location="context"/g).length, 1);

  const actor = createActor(m, { input: { a: 5 } }).start();
  assert.equal(calls, 1, 'the context factory runs once per instance');
  assert.deepEqual(actor.getSnapshot().context, {
    a: 5, b: [], c: 't5, {', d: 'yes', 'e-f': { nested: [1, 2, { x: 3 }] }, g: 2,
  });
  actor.send({ type: 'SWAP' }); // both read the previous context
  assert.deepEqual([actor.getSnapshot().context.a, actor.getSnapshot().context.g], [2, 5]);
  actor.send({ type: 'SWAP2' });
  assert.deepEqual([actor.getSnapshot().context.a, actor.getSnapshot().context.g], [5, 2]);
  actor.send({ type: 'MIXED' }); // a sees b before b's constant is assigned
  assert.deepEqual([actor.getSnapshot().context.a, actor.getSnapshot().context.b], [[], 'const']);
  actor.send({ type: 'OPAQUE' });
  assert.equal(actor.getSnapshot().context.g, 3);
  actor.stop();

  const empty = createActor(createMachine({ context: {}, initial: 'x', states: { x: {} } })).start();
  assert.deepEqual(empty.getSnapshot().context, {});
  empty.stop();
});
