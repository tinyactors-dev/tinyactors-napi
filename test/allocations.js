'use strict';

// After warm-up, delivering an event makes no allocator call in core, for
// the chart shapes that once did (napi roadmap "Core findings"): an executed
// <send>, to another actor, to #_internal or delayed with a <cancel>, and a
// chart with a top-level <final>. Each chart must also really send and raise
// no error, so an error path that happens to allocate nothing cannot pass.
// Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart } = require('..');

const ACTORS = 1000;
const ROUNDS = 5;

const charts = {
  'an assign': () =>
    statechart({ family: 'assign', revision: 'v1' })
      .data('n', 0)
      .state('idle', (s) => s.on('ping', (t) => t.assign('n', function () { return this.n + 1; }))),
  'a top-level <final>': () =>
    statechart({ family: 'final', revision: 'v1' })
      .data('n', 0)
      .state('idle', (s) => {
        s.on('ping', (t) => t.target('idle').assign('n', function () { return this.n + 1; }));
        s.on('stop', (t) => t.target('done'));
      })
      .final('done'),
  'a <send> to another actor': () =>
    statechart({ family: 'send', revision: 'v1' })
      .state('idle', (s) => s.on('ping', (t) => t.send('pong', (m) => m.to('#_actor_sink/main')))),
  'a <send> to #_internal': () =>
    statechart({ family: 'internal', revision: 'v1' })
      .state('idle', (s) => {
        s.on('ping', (t) => t.send('pong', (m) => m.to('#_internal')));
        s.on('pong', (t) => t);
      }),
  'a <raise>': () =>
    statechart({ family: 'raise', revision: 'v1' })
      .state('idle', (s) => {
        s.on('ping', (t) => t.raise('pong'));
        s.on('pong', (t) => t);
      }),
  'a delayed <send> re-armed with <cancel>': () =>
    statechart({ family: 'timeout', revision: 'v1' })
      .state('idle', (s) =>
        s.on('ping', (t) => t.cancel('idle').send('timeout', (m) => m.to('#_actor_sink/main').after(60_000).id('idle'))),
      ),
  'a timeout re-armed on entry and cancelled on exit': () =>
    statechart({ family: 'rearm', revision: 'v1' })
      .state('idle', (s) => {
        s.entry((a) => a.send('timeout', (send) => send.id('idle').after(30_000)));
        s.exit((a) => a.cancel('idle'));
        s.on('ping', (t) => t.target('idle'));
        s.on('timeout', (t) => t.target('done'));
      })
      .final('done'),
};

// The sum of a counter's points for one definition family.
function counted(system, name, family) {
  const metric = system.metrics().metrics.find((candidate) => candidate.name === name);
  return (metric?.points ?? [])
    .filter((point) => point.attributes['tinyactors.definition.family'] === family)
    .reduce((sum, point) => sum + (point.value ?? 0), 0);
}

async function steadyState(name, make) {
  const system = createSystem();
  const sink = system.define(statechart({ family: 'sink', revision: 'v1' }).state('idle', (s) => s.on('pong', (t) => t)));
  system.spawn(sink, { name: 'main' });
  const chart = make();
  const definition = system.define(chart);
  const family = definition.inspect().identity.family;
  const actors = [];
  for (let at = 0; at < ACTORS; at += 1) {
    actors.push(system.spawn(definition));
  }
  await system.flush();
  const round = async () => {
    for (const actor of actors) {
      system.post(actor, 'ping');
    }
    await system.flush();
  };
  await round(); // warm-up: queues, caches and timer storage reach their size
  await round();
  const before = system.stats().memory.core;
  for (let at = 0; at < ROUNDS; at += 1) {
    await round();
  }
  const after = system.stats().memory.core;
  assert.equal(after.allocations - before.allocations, 0, `${name}: core allocated after warm-up`);
  assert.equal(after.frees - before.frees, 0, `${name}: core freed after warm-up`);
  assert.equal(counted(system, 'tinyactors.errors', family), 0, `${name}: the chart raised errors`);
  if (/<send>|timeout/.test(name)) {
    const sends = counted(system, 'tinyactors.sends', family) + counted(system, 'tinyactors.sends.delayed', family);
    assert.ok(sends >= ACTORS * ROUNDS, `${name}: expected at least ${ACTORS * ROUNDS} sends, counted ${sends}`);
  }
  system.close();
}

// Allocator calls the addon itself makes (every category but core's, which
// core's own tests cover), for one tracing setup: `first`, the first round
// of messages, where pools reach their size; `steady`, ROUNDS rounds after
// warm-up. `install` sets a sink up, or not.
function addonAllocatorCalls(system) {
  let calls = 0;
  for (const [category, counters] of Object.entries(system.stats().memory)) {
    if (category !== 'total' && category !== 'core') {
      calls += counters.allocations + counters.frees;
    }
  }
  return calls;
}

async function addonCalls({ install, traceparent }) {
  const system = createSystem();
  install?.(system);
  const definition = system.define(charts['an assign']());
  const actors = [];
  for (let at = 0; at < ACTORS; at += 1) {
    actors.push(system.spawn(definition));
  }
  await system.flush();
  const options = traceparent === undefined ? undefined : { traceparent };
  const round = async () => {
    for (const actor of actors) {
      system.post(actor, 'ping', undefined, options);
    }
    await system.flush();
  };
  const start = addonAllocatorCalls(system);
  await round();
  const first = addonAllocatorCalls(system) - start;
  await round();
  const before = addonAllocatorCalls(system);
  for (let at = 0; at < ROUNDS; at += 1) {
    await round();
  }
  const steady = addonAllocatorCalls(system) - before;
  system.close();
  return { first, steady };
}

// Installing a trace sink costs no allocator call per event after warm-up
// (napi ADR 0017 section 2): sampled out, and at a low sample rate with the
// default detail, the addon allocates no more than it does untraced.
async function tracedSteadyState() {
  const UNSAMPLED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
  const untraced = await addonCalls({});
  const sampledOut = await addonCalls({ install: (system) => system.setTraceSink(() => {}), traceparent: UNSAMPLED });
  const lowRate = await addonCalls({ install: (system) => system.setTraceSink(() => {}, { sample: 0.01 }) });
  assert.equal(sampledOut.steady, untraced.steady,
               `sampled out: ${sampledOut.steady} allocator calls after warm-up, untraced ${untraced.steady}`);
  assert.equal(lowRate.steady, untraced.steady,
               `summary at 1%: ${lowRate.steady} allocator calls after warm-up, untraced ${untraced.steady}`);
  // Warming up, the trace parents messages carry come in chunks, as
  // envelopes do: a few calls for the round, not one per message.
  const extra = sampledOut.first - untraced.first;
  assert.ok(extra <= ACTORS / 50,
            `sampled out: the first round made ${extra} more allocator calls than untraced for ${ACTORS} messages`);
}

// Native bytes after spawning `count` actors in one turn, with or without a sink.
async function nativeBytes(count, withSink) {
  const system = createSystem();
  if (withSink) {
    system.setTraceSink(() => {});
  }
  const definition = system.define(charts['an assign']());
  for (let at = 0; at < count; at += 1) {
    system.spawn(definition);
  }
  await system.flush();
  const bytes = system.stats().memory.total.bytesInUse;
  system.close();
  return bytes;
}

// An installed sink keeps no per-actor memory once the turn that traced a
// burst of spawns has handed its bytes over: the encoder keeps at most 1 MiB
// of staging capacity between turns (napi ADR 0017 implementation notes).
async function idleSinkMemory() {
  const COUNT = 50000;
  const KEPT = 1 << 20;
  const PER_ACTOR = 16;
  const extra = (await nativeBytes(COUNT, true)) - (await nativeBytes(COUNT, false));
  assert.ok(extra <= KEPT + PER_ACTOR * COUNT,
            `an idle sink kept ${extra} bytes for ${COUNT} actors, more than ${KEPT} + ${PER_ACTOR} per actor`);
}

(async () => {
  for (const [name, make] of Object.entries(charts)) {
    await steadyState(name, make);
  }
  await tracedSteadyState();
  await idleSinkMemory();
  console.log('allocations.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
