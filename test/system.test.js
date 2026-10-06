'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, createActor, createSystem, assign, sendTo } = require('./binding');

const counter = createMachine({
  id: 'counter',
  initial: 'on',
  context: { n: 0 },
  states: { on: { on: { INC: { actions: assign({ n: ({ context }) => context.n + 1 }) } } } },
});

test('thousands of actors share one native system', () => {
  const system = createSystem();
  const actors = [];
  for (let i = 0; i < 2000; i++) actors.push(createActor(counter, { system }).start());
  for (const a of actors) a.send({ type: 'INC' });
  actors[7].send({ type: 'INC' });
  assert.equal(actors[0].getSnapshot().context.n, 1);
  assert.equal(actors[7].getSnapshot().context.n, 2);
  const stats = system.stats();
  assert.equal(stats.length, 1, 'one segment');
  assert.equal(stats[0].sessions, 2000);
  assert.ok(stats[0].maxActors >= 2000, 'the system grew by relocation');
  for (const a of actors) a.stop();
  assert.equal(system.stats()[0].sessions, 0);
});

test('actors message each other inside the system (sendTo actor / system.get)', () => {
  const system = createSystem();
  const ponger = createMachine({
    id: 'ponger',
    initial: 'waiting',
    context: { pings: 0 },
    states: {
      waiting: {
        on: {
          PING: {
            actions: [
              assign({ pings: ({ context }) => context.pings + 1 }),
              sendTo(({ system }) => system.get('pinger'), ({ context }) => ({ type: 'PONG', n: context.pings })),
            ],
          },
        },
      },
    },
  });
  const pongerActor = createActor(ponger, { system, systemID: 'ponger' }).start();
  const pinger = createMachine({
    id: 'pinger',
    initial: 'go',
    context: { last: 0 },
    states: {
      go: {
        entry: sendTo(pongerActor, { type: 'PING' }),
        on: {
          PONG: [
            { guard: ({ event }) => event.n >= 3, target: 'done', actions: assign({ last: ({ event }) => event.n }) },
            { actions: [assign({ last: ({ event }) => event.n }), sendTo(pongerActor, { type: 'PING' })] },
          ],
        },
      },
      done: { type: 'final', output: ({ context }) => context.last },
    },
  });
  assert.match(pinger.toSCXML(), /<send event="PING" targetexpr='system.get\("ponger"\)'\/>/);
  const pingerActor = createActor(pinger, { system, systemID: 'pinger' }).start();
  const s = pingerActor.getSnapshot();
  assert.equal(s.status, 'done');
  assert.equal(s.output, 3);
  assert.equal(pongerActor.getSnapshot().context.pings, 3);
  // pinger was defined after the system linked ponger: it lives in a second
  // segment and the ping-pong crossed segments through SCXML-to-SCXML sends
  assert.equal(system.stats().length, 2);
  pongerActor.stop();
});

test('identical source text with different closures stays distinct', () => {
  const by = (k) => assign({ n: ({ context }) => context.n + k });
  const m = createMachine({
    initial: 'a',
    context: { n: 0 },
    states: { a: { on: { ONE: { actions: by(1) }, TEN: { actions: by(10) } } } },
  });
  const xml = m.toSCXML();
  assert.match(xml, /<assign location="n" expr="context.n \+ k"\/>/);
  assert.match(xml, /<assign location="n" expr="context.n \+ k \/\* 2 \*\/"\/>/);
  const a = createActor(m, { system: createSystem() }).start();
  a.send({ type: 'ONE' });
  a.send({ type: 'TEN' });
  assert.equal(a.getSnapshot().context.n, 11);
  a.stop();
});

test('generated charts contain no internal expression indices', () => {
  const { execFileSync } = require('node:child_process');
  const xml = execFileSync(process.execPath, [require.resolve('./print-scxml.js')], { encoding: 'utf8' });
  assert.match(xml, /cond='and\(isAdult, not\(above\(\{"min":99\}\)\)\)'/);
  assert.match(xml, /<script>track\(\{"tag":"idle"\}\)<\/script>/);
  assert.doesNotMatch(xml, /="[a-z]{1,3}:\d+"/);
});
