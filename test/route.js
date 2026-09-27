'use strict';

// Step 7: route actor-to-actor events (ROADMAP step 7; ADR 0006, core ADRs
// 0065 and 0066). Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart } = require('..');

const stateOf = (actor) => actor.inspect().activeStates.at(-1);

const addonCalls = (system) => {
  const { memory } = system.stats();
  let calls = 0;
  for (const [category, counters] of Object.entries(memory)) {
    if (category !== 'total' && category !== 'core') {
      calls += counters.allocations + counters.frees;
    }
  }
  return calls;
};

const coreCalls = (system) => {
  const { core } = system.stats().memory;
  return core.allocations + core.frees;
};

// ping: s0 --ball/send ball to pong--> s1 ... s(n-1) --ball--> `last`. When
// `last` is the final `end`, that last transition sends too; when it is `s0`
// it does not, so a round stops with ping waiting in s0.
// pong: loop --ball/send ball to ping--> loop.
function pingPong(n, { family = 'pp', last = 'end', ping = `#_actor_${family}/ping`, pong = `#_actor_${family}/pong` } = {}) {
  let pinger = statechart({ family, revision: 'ping' });
  for (let index = 0; index < n; index += 1) {
    const next = index + 1 < n ? `s${index + 1}` : last;
    const sends = index + 1 < n || last === 'end';
    pinger = pinger.state(`s${index}`, (s) =>
      s.on('ball', (t) => (sends ? t.target(next).send('ball', (m) => m.to(pong)) : t.target(next))));
  }
  if (last === 'end') {
    pinger = pinger.final('end');
  }
  const ponger = statechart({ family, revision: 'pong' })
    .state('loop', (s) => s.on('ball', (t) => t.target('loop').send('ball', (m) => m.to(ping))));
  return { pinger, ponger };
}

// A named ping-pong pair exchanges its messages with no JavaScript between
// post and flush. When ping finishes (and is destroyed), pong's last ball to
// the name has nowhere to go: pong gets error.communication (napi ADR 0022),
// which it ignores, and nothing becomes a dead letter.
async function namedPingPong() {
  const n = 100;
  const hooks = [];
  const system = createSystem({
    done: (record) => hooks.push(['done', record]),
    fault: (record) => hooks.push(['fault', record]),
    deadLetter: (record) => hooks.push(['deadLetter', record]),
  });
  const { pinger, ponger } = pingPong(n);
  const ping = system.spawn(system.define(pinger), { name: 'ping' });
  const pong = system.spawn(system.define(ponger), { name: 'pong' });
  await system.flush();
  assert.ok(system.findActor({ family: 'pp', name: 'ping' }).equals(ping));
  assert.ok(system.findActor({ family: 'pp', name: 'pong' }).equals(pong));
  assert.equal(system.findActor({ family: 'pp', name: 'nobody' }), undefined);

  system.post({ family: 'pp', name: 'ping' }, 'ball');
  await system.flush();
  // ping got n balls (one from here, n - 1 from pong); pong got n.
  assert.equal(system.stats().messages.delivered, 2 * n);
  assert.equal(system.exists(ping), false, 'ping finished and was destroyed');
  assert.equal(system.findActor({ family: 'pp', name: 'ping' }), undefined);
  assert.deepEqual(hooks.map(([kind]) => kind), ['done']);
  assert.equal(system.metrics().system.errors_communication, 1, "pong's last ball raised error.communication");
  assert.equal(stateOf(pong), 'loop');
  system.close();
}

// A send to `#_scxml_<sessionID>` reaches that session (core ADR 0066).
async function runtimeTargets() {
  const system = createSystem({ fault: (record) => assert.fail(`fault: ${record.code}`) });
  const receiver = system.spawn(system.define(
    statechart({ family: 'rx', revision: 'v1' })
      .state('wait', (s) => s.on('hit', (t) => t.target('got')))
      .state('got')));
  const session = receiver.inspect().sessionID;
  const sender = system.spawn(system.define(
    statechart({ family: 'tx', revision: 'v1' })
      .state('a', (s) => s.on('go', (t) => t.target('b').send('hit', (m) => m.to(`#_scxml_${session}`))))
      .state('b')));
  await system.flush();
  sender.post('go');
  await system.flush();
  assert.equal(stateOf(receiver), 'got');
  assert.equal(system.stats().messages.delivered, 2);
  system.close();
}

// Sends to a named address follow the directory: after the actor at the
// name is replaced by a new one, the next send reaches the new one.
async function namesFollowTheDirectory() {
  const system = createSystem();
  const receiverChart = system.define(
    statechart({ family: 'rx', revision: 'v1' })
      .state('wait', (s) => s.on('hit', (t) => t.target('got')))
      .state('got'));
  const sender = system.spawn(system.define(
    statechart({ family: 'tx', revision: 'v1' })
      .state('a', (s) => s.on('go', (t) => t.target('a').send('hit', (m) => m.to('#_actor_rx/target'))))));
  const first = system.spawn(receiverChart, { name: 'target' });
  await system.flush();
  sender.post('go');
  await system.flush();
  assert.equal(stateOf(first), 'got');

  system.destroy(first);
  const second = system.spawn(receiverChart, { name: 'target' });
  await system.flush();
  assert.ok(system.findActor({ family: 'rx', name: 'target' }).equals(second));
  sender.post('go');
  await system.flush();
  assert.equal(stateOf(second), 'got');

  // post() to an address resolves it the same way.
  const third = system.spawn(receiverChart, { name: 'other' });
  await system.flush();
  system.post({ family: 'rx', name: 'other' }, 'hit');
  await system.flush();
  assert.equal(stateOf(third), 'got');
  system.close();
}

// An external send to self waits in the mailbox while its macrostep runs
// and is delivered in a later macrostep, with no TA_ERR_BUSY.
async function sendToSelf() {
  const faults = [];
  const system = createSystem({ fault: (record) => faults.push(record) });
  const actor = system.spawn(system.define(
    statechart({ family: 'me', revision: 'v1' })
      .state('a', (s) => s
        .entry((e) => e.send('again'))
        .on('again', (t) => t.target('b').send('again')))
      .state('b', (s) => s.on('again', (t) => t.target('c')))
      .state('c')));
  await system.flush();
  assert.deepEqual(faults, []);
  assert.equal(stateOf(actor), 'c');
  assert.equal(system.stats().messages.delivered, 2);
  system.close();
}

// After warm-up, a named ping-pong pair makes no allocator call in the
// addon.
async function steadyState() {
  const n = 50;
  const system = createSystem();
  const { pinger, ponger } = pingPong(n, { family: 'ss', last: 's0' });
  system.spawn(system.define(pinger), { name: 'ping' });
  system.spawn(system.define(ponger), { name: 'pong' });
  await system.flush();
  system.post({ family: 'ss', name: 'ping' }, 'ball'); // warm-up
  await system.flush();
  const addon = addonCalls(system);
  const delivered = system.stats().messages.delivered;
  for (let round = 0; round < 5; round += 1) {
    system.post({ family: 'ss', name: 'ping' }, 'ball');
    await system.flush();
  }
  // Each round: n balls to ping (one from here), n - 1 to pong.
  assert.equal(system.stats().messages.delivered - delivered, 5 * (2 * n - 1));
  assert.equal(addonCalls(system), addon, 'no allocator call in the addon');
  system.close();
}

// No address is copied: routing to a name costs core exactly what routing
// to a session URI costs, and the addon nothing (core ADR 0065).
async function namesCopyNothing() {
  const perSend = async (target) => {
    const system = createSystem();
    const receiver = system.spawn(system.define(
      statechart({ family: 'rx', revision: 'v1' }).state('w', (s) => s.on('hit', (t) => t.target('w')))), { name: 'r' });
    const sender = system.spawn(system.define(
      statechart({ family: 'tx', revision: 'v1' })
        .state('a', (s) => s.on('go', (t) => t.target('a').send('hit', (m) => m.to(target(receiver)))))));
    await system.flush();
    for (let round = 0; round < 5; round += 1) {
      sender.post('go');
      await system.flush();
    }
    const addon = addonCalls(system);
    const core = coreCalls(system);
    const rounds = 100;
    for (let round = 0; round < rounds; round += 1) {
      sender.post('go');
      await system.flush();
    }
    assert.equal(system.stats().messages.delivered, 2 * (rounds + 5));
    assert.equal(addonCalls(system), addon, 'no allocator call in the addon');
    const calls = (coreCalls(system) - core) / rounds;
    system.close();
    return calls;
  };
  const named = await perSend(() => '#_actor_rx/r');
  const session = await perSend((receiver) => `#_scxml_${receiver.inspect().sessionID}`);
  assert.equal(named, session, 'a named target costs core no more than a session target');
}

// Mail JavaScript posts to a name with no actor is a dead letter that keeps
// the name; a chart's send to one raises error.communication in the chart
// instead (napi ADR 0022).
async function unknownNames() {
  const dead = [];
  const system = createSystem({ deadLetter: (record) => dead.push(record) });
  const sender = system.spawn(system.define(
    statechart({ family: 'tx', revision: 'v1' })
      .state('a', (s) => s.on('go', (t) => t.target('a').send('hit', (m) => m.to('#_actor_rx/nobody'))))));
  await system.flush();
  sender.post('go');
  system.post({ family: 'rx', name: 'ghost' }, 'boo');
  await system.flush();
  assert.deepEqual(dead, [{ target: { family: 'rx', name: 'ghost' }, event: 'boo', reason: 'not-found' }]);
  assert.equal(system.metrics().system.errors_communication, 1);
  system.close();
}

(async () => {
  // A routing bug shows up as a system that never goes quiet: fail, don't hang.
  let current = 'start';
  const watchdog = setTimeout(() => {
    console.error(`route.js: ${current} did not finish in time`);
    process.exit(1);
  }, Number(process.env.ROUTE_TIMEOUT_MS ?? 60_000));
  for (const test of [
    namedPingPong, runtimeTargets, namesFollowTheDirectory, sendToSelf, steadyState, namesCopyNothing, unknownNames,
  ]) {
    current = test.name;
    await test();
  }
  clearTimeout(watchdog);
  console.log('route.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
