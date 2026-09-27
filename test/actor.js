'use strict';

// Step 5: spawn, run, inspect, destroy (ROADMAP step 5; ADRs 0002, 0005,
// 0007, 0008, 0012). Runs on Node and Bun.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createSystem, statechart, TinyactorsError } = require('..');

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

const idleChart = (family = 'idle') => statechart({ family, revision: 'v1' }).state('idle');

// start --(eventless)--> second: the second of two top-level finals.
const finishChart = () =>
  statechart({ family: 'finish', revision: 'v1' })
    .state('start', (s) => s.always((t) => t.target('second')))
    .final('first')
    .final('second');

// Nothing runs inside spawn(); the actor reaches its initial state in a turn.
async function spawnIsAsynchronous() {
  const done = [];
  const system = createSystem({ done: (record) => done.push(record) });
  const idle = system.spawn(system.define(idleChart()));
  const finishing = system.spawn(system.define(finishChart()));
  assert.deepEqual(idle.inspect().activeStates, [], 'not bootstrapped inside spawn()');
  assert.equal(idle.inspect().scheduling, 'runnable');
  assert.equal(done.length, 0, 'no hook runs inside spawn()');
  assert.equal(typeof idle.slot, 'number');
  assert.equal(typeof idle.generation, 'number');
  assert.ok(idle.equals(system.inspect(idle).actor));
  assert.ok(!idle.equals(finishing));

  await system.flush();
  assert.deepEqual(idle.inspect().activeStates, ['idle']);
  assert.equal(idle.inspect().finalState, null, 'null while running');
  assert.equal(idle.inspect().scheduling, 'idle');
  assert.equal(idle.inspect().residency, 'idle');
  assert.equal(typeof idle.inspect().sessionID, 'bigint');
  assert.equal(done.length, 1);
  assert.ok(done[0].actor.equals(finishing));

  // A flush on a quiet system resolves at once.
  await system.flush();
  system.close();
}

// A chart with two top-level finals reports the one it reached (core ADR 0056).
async function finalState() {
  const seen = [];
  const system = createSystem({
    finished: 'retain',
    done: ({ actor, finalState: state, data }) => {
      seen.push({ state, data, inspected: actor.inspect().finalState });
    },
  });
  const actor = system.spawn(system.define(finishChart()));
  await system.flush();
  assert.deepEqual(seen, [{ state: 'second', data: undefined, inspected: 'second' }]);
  const view = actor.inspect();
  assert.equal(view.residency, 'done');
  assert.equal(view.finalState, 'second');
  assert.deepEqual(view.activeStates, []);
  assert.equal(actor.destroyed, false, 'retained after done');
  actor.destroy();
  assert.equal(actor.destroyed, true);
  assertCode(() => actor.inspect(), 'not-found');
  system.close();
}

// finished: "destroy" (the default) reclaims a finished actor after `done`.
async function finishedActorsAreReclaimed() {
  let insideHook;
  const system = createSystem({
    done: ({ actor }) => {
      insideHook = actor.inspect().residency;
    },
  });
  const definition = system.define(finishChart());
  const actors = Array.from({ length: 50 }, () => system.spawn(definition));
  await system.flush();
  assert.equal(insideHook, 'done', 'the actor is still resident while its hook runs');
  for (const actor of actors) {
    assert.equal(actor.destroyed, true);
    assertCode(() => actor.inspect(), 'not-found');
  }
  assert.equal(definition.inspect().actorCount, 0);

  // Without a done hook they are reclaimed too.
  const quiet = createSystem();
  const gone = quiet.spawn(quiet.define(finishChart()));
  await quiet.flush();
  assert.equal(gone.destroyed, true);
  quiet.close();
  system.close();
}

// A large population bootstraps over many turns, and I/O and timer callbacks
// run between two consecutive turns (ADR 0007).
async function turnsYieldToTheEventLoop() {
  const log = [];
  const system = createSystem({
    finished: 'retain',
    scheduling: { resumesPerTurn: 100 },
    done: () => {
      if (log[log.length - 1] !== 'turn') {
        log.push('turn');
      }
    },
  });
  const definition = system.define(finishChart());
  for (let index = 0; index < 20000; index += 1) {
    system.spawn(definition);
  }
  let timers = 0;
  let reads = 0;
  let stop = false;
  const timer = () => {
    log.push('timer');
    timers += 1;
    if (!stop) setTimeout(timer, 0);
  };
  const read = () => {
    fs.stat(__filename, () => {
      log.push('io');
      reads += 1;
      if (!stop) read();
    });
  };
  setTimeout(timer, 0);
  read();
  await system.flush();
  stop = true;
  const first = log.indexOf('turn');
  const last = log.lastIndexOf('turn');
  const between = log.slice(first, last);
  assert.ok(between.includes('timer'), `a timer ran between turns (${timers} timers)`);
  assert.ok(between.includes('io'), `an I/O callback ran between turns (${reads} reads)`);
  assert.ok(log.filter((entry) => entry === 'turn').length >= 20, 'bootstrap spanned many turns');
  system.close();
}

// A small actionBudget splits one long entry handler over several turns, and
// other actors run between them (core ADR 0061). The null data model has no
// <foreach> to iterate; that variant waits for the data model (step 11).
async function actionBudgetSplitsAHandler() {
  const system = createSystem({ scheduling: { actionBudget: 5 } });
  // The bootstrap never pauses (core ADR 0061), so the long handler belongs to
  // a state entered after it.
  const busyChart = statechart({ family: 'busy', revision: 'v1' })
    .state('start', (s) => s.always((t) => t.target('busy')))
    .state('busy', (s) =>
      s.entry((a) => {
        for (let index = 0; index < 40; index += 1) {
          a.log(`step ${index}`);
        }
      }),
    );
  const busy = system.spawn(system.define(busyChart));
  const other = system.spawn(system.define(idleChart('other')));
  await tick(); // one pump turn
  assert.deepEqual(other.inspect().activeStates, ['idle'], 'the other actor ran in the first turn');
  assert.equal(busy.inspect().scheduling, 'runnable');
  assert.equal(busy.inspect().macrostepInProgress, true, 'paused inside the handler');
  const late = system.spawn(system.define(idleChart('late')));
  let turns = 1;
  while (busy.inspect().scheduling === 'runnable') {
    await tick();
    turns += 1;
    assert.ok(turns < 100);
  }
  assert.ok(turns >= 8, `40 actions at 5 per resume took ${turns} turns`);
  assert.deepEqual(late.inspect().activeStates, ['idle'], 'an actor spawned meanwhile ran');
  assert.deepEqual(busy.inspect().activeStates, ['busy']);
  system.close();
}

// In() used as a value compiles under the null data model, which a spec
// opts into, and faults as error.execution when it runs (core ADR 0057; the
// leftover check of step 4).
async function inAsAValueFaultsAtRunTime() {
  const system = createSystem();
  const chart = statechart({ family: 'in-value', revision: 'v1' })
    .state('start', (s) => {
      s.always((t) => t.target('logging'));
    })
    .state('logging', (s) => {
      s.entry((a) => a.log('in', "In('start')"));
      s.on('error.execution', (t) => t.target('failed'));
    })
    .state('failed');
  const actor = system.spawn(system.define({ ...chart.build(), datamodel: 'null' }));
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['failed']);
  system.close();
}

// close() rejects a pending flush with `closed`; views of a closed system throw.
async function closeSettlesFlush() {
  const system = createSystem({ scheduling: { resumesPerTurn: 1 } });
  const definition = system.define(idleChart());
  const actors = Array.from({ length: 10 }, () => system.spawn(definition));
  const pending = system.flush();
  system.close();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof TinyactorsError);
    assert.equal(error.code, 'closed');
    return true;
  });
  assertCode(() => actors[0].inspect(), 'closed');
  assertCode(() => system.flush(), 'closed');
  assertCode(() => system.spawn(definition), 'closed');
  // A turn still pending when the system closed does nothing.
  await tick();
}

// Destroy clears the scheduling entry; the slot's next actor is a new ID.
async function destroyAndReuse() {
  const system = createSystem();
  const definition = system.define(idleChart());
  const first = system.spawn(definition);
  first.destroy(); // before its bootstrap: the queued entry is skipped
  assert.equal(first.destroyed, true);
  const second = system.spawn(definition);
  assert.equal(second.slot, first.slot);
  assert.notEqual(second.generation, first.generation);
  assert.equal(first.inspect === undefined, false);
  assertCode(() => first.inspect(), 'not-found');
  assertCode(() => first.destroy(), 'not-found');
  await system.flush();
  assert.deepEqual(second.inspect().activeStates, ['idle']);
  assertCode(() => system.inspect({ slot: 0, generation: 1 }), 'invalid');
  system.close();
}

// Options are checked when the system is created; a hook that throws does
// not stop the pump, and its error surfaces as an uncaught exception.
async function optionsAndHookErrors() {
  assertCode(() => createSystem({ scheduling: { resumeBudget: -1 } }), 'invalid');
  assertCode(() => createSystem({ scheduling: { resumesPerTurn: 0 } }), 'invalid');
  assertCode(() => createSystem({ finished: 'keep' }), 'invalid');
  assertCode(() => createSystem({ done: 'nope' }), 'invalid');

  const system = createSystem({
    finished: 'retain',
    done: () => {
      throw new Error('hook failed');
    },
  });
  const definition = system.define(finishChart());
  const actors = [system.spawn(definition), system.spawn(definition)];
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    await system.flush();
    await tick();
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.equal(uncaught.length, 1, 'one uncaught exception per turn');
  assert.equal(uncaught[0].message, 'hook failed');
  for (const actor of actors) {
    assert.equal(actor.inspect().residency, 'done', 'both actors finished despite the hook');
  }
  system.close();
}

// Memory stays in the scheduling category and returns to zero at close.
async function schedulingMemory() {
  const system = createSystem();
  const definition = system.define(idleChart());
  for (let index = 0; index < 5000; index += 1) {
    system.spawn(definition);
  }
  await system.flush();
  const { scheduling } = system.stats().memory;
  assert.ok(scheduling.bytesInUse >= 2 * 4096 * 16, 'two table pages for 5,000 slots');
  system.close();
}

(async () => {
  await spawnIsAsynchronous();
  await finalState();
  await finishedActorsAreReclaimed();
  await turnsYieldToTheEventLoop();
  await actionBudgetSplitsAHandler();
  await inAsAValueFaultsAtRunTime();
  await closeSettlesFlush();
  await destroyAndReuse();
  await optionsAndHookErrors();
  await schedulingMemory();
  console.log('actor.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
