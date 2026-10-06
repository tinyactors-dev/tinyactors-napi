'use strict';
// Prints the SCXML generated for a representative machine. The charts should
// read like hand-written SCXML (tools/check_layers.py checks that no internal
// expression indices leak into them).
const { setup, assign, raise, sendTo, sendParent, log, stateIn, and, not } = require('..');

const child = setup({}).createMachine({
  id: 'worker',
  initial: 'busy',
  context: ({ input }) => ({ job: input.job }),
  states: {
    busy: { entry: sendParent(({ context }) => ({ type: 'PROGRESS', job: context.job })), on: { STOP: 'finished' } },
    finished: { type: 'final', output: ({ context }) => ({ job: context.job }) },
  },
});

const machine = setup({
  guards: {
    isAdult: ({ context }) => context.age >= 18,
    above: ({ context }, params) => context.age > params.min,
  },
  actions: {
    track: (_, params) => void params,
    reset: assign({ count: 0 }),
  },
  delays: { quick: 250 },
  actors: { worker: child },
}).createMachine({
  id: 'checkout',
  initial: 'idle',
  context: { count: 0, age: 21, items: [] },
  states: {
    idle: {
      entry: [{ type: 'track', params: { tag: 'idle' } }, log(({ context }) => `count=${context.count}`, 'checkout')],
      on: {
        ADD: {
          actions: assign({
            count: ({ context }) => context.count + 1,
            items: ({ context, event }) => [...context.items, event.item],
          }),
        },
        PAY: [
          { guard: and(['isAdult', not({ type: 'above', params: { min: 99 } })]), target: 'paying' },
          { target: 'rejected', actions: raise({ type: 'REJECTED' }) },
        ],
      },
      after: { quick: { guard: stateIn('idle'), actions: 'reset' } },
    },
    paying: {
      invoke: { id: 'job', src: 'worker', input: ({ context }) => ({ job: context.count }), onDone: 'paid' },
      on: { PROGRESS: { actions: sendTo('job', { type: 'STOP' }) } },
    },
    paid: { type: 'final', output: ({ context }) => ({ total: context.count }) },
    rejected: { on: { RETRY: 'idle' } },
  },
});

process.stdout.write(machine.toSCXML() + '\n');
