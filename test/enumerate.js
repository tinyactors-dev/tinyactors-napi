'use strict';

// Step 9: paged enumeration (ROADMAP step 9; ADR 0003, core ADR 0062).
// Runs on Node and Bun.

const assert = require('node:assert/strict');
const { createSystem, statechart, TinyactorsError } = require('..');

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

// A full garbage collection on either runtime.
const collect = (() => {
  if (typeof Bun !== 'undefined') {
    return () => Bun.gc(true);
  }
  require('node:v8').setFlagsFromString('--expose-gc');
  return require('node:vm').runInNewContext('gc');
})();

// Bytes the JavaScript side holds after a full collection: the heap, plus
// ArrayBuffers (a page of IDs lives in one).
function retained() {
  collect();
  const { heapUsed, arrayBuffers = 0 } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

const idleChart = () => statechart({ family: 'idle', revision: 'v1' }).state('idle');

// Spawns `count` actors without keeping their views, and bootstraps them.
async function populate(system, count) {
  const definition = system.define(idleChart());
  for (let at = 0; at < count; at += 1) {
    system.spawn(definition);
  }
  await system.flush();
  return definition;
}

const key = (slot, generation) => `${slot}:${generation}`;

// Pages cover the population once, in slot order, as [slot, generation] pairs.
async function pagesCoverThePopulation() {
  const system = createSystem();
  const definition = system.define(idleChart());
  const spawned = [];
  for (let at = 0; at < 2500; at += 1) {
    const actor = system.spawn(definition);
    spawned.push(key(actor.slot, actor.generation));
  }
  await system.flush();

  const pages = [...system.actorIDs({ pageSize: 1000 })];
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => page.length), [2000, 2000, 1000]);
  for (const page of pages) {
    assert.ok(page instanceof Uint32Array);
  }
  const seen = pages.flatMap((page) => {
    const keys = [];
    for (let at = 0; at < page.length; at += 2) {
      keys.push(key(page[at], page[at + 1]));
    }
    return keys;
  });
  assert.deepEqual(seen, spawned, 'every actor once, in slot order');

  assert.equal([...system.actorIDs()].length, 3, 'default pages of 1024');

  // actors() gives inspections of the same actors.
  let count = 0;
  for (const inspection of system.actors({ pageSize: 700 })) {
    assert.equal(key(inspection.actor.slot, inspection.actor.generation), spawned[count]);
    assert.deepEqual(inspection.activeStates, ['idle']);
    count += 1;
  }
  assert.equal(count, spawned.length);

  // An empty system has no pages.
  const empty = createSystem();
  assert.deepEqual([...empty.actorIDs()], []);
  assert.deepEqual([...empty.actors()], []);
  empty.close();
  system.close();
}

// Options are checked, and a closed system cannot be enumerated.
async function optionsAndClose() {
  const system = createSystem();
  await populate(system, 3);
  for (const pageSize of [0, -1, 1.5, 65537, '10']) {
    assertCode(() => system.actorIDs({ pageSize }).next(), 'invalid');
    assertCode(() => system.actors({ pageSize }).next(), 'invalid');
  }
  assertCode(() => system.actorIDs(null).next(), 'invalid');
  assert.equal([...system.actorIDs({ pageSize: 65536 })].length, 1);

  const iterator = system.actorIDs({ pageSize: 1 });
  assert.equal(iterator.next().value.length, 2);
  system.close();
  assertCode(() => iterator.next(), 'closed');
  assertCode(() => system.actorIDs().next(), 'closed');
}

// Core ADR 0062 §4: changes between pages.
async function changesBetweenPages() {
  const system = createSystem();
  const definition = system.define(idleChart());
  const actors = [];
  for (let at = 0; at < 30; at += 1) {
    actors.push(system.spawn(definition));
  }
  await system.flush();

  const iterator = system.actorIDs({ pageSize: 10 });
  const seen = [];
  const take = (page) => {
    for (let at = 0; at < page.length; at += 2) {
      seen.push(key(page[at], page[at + 1]));
    }
  };
  take(iterator.next().value);

  const visited = actors[3];
  const ahead = actors[25];
  system.destroy(visited);
  system.destroy(ahead);
  // Both freed slots are reused: one is behind the cursor (slot 3), one ahead (slot 25).
  const first = system.spawn(definition);
  const second = system.spawn(definition);
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    take(step.value);
  }

  assert.equal(new Set(seen.map((each) => each.split(':')[0])).size, seen.length, 'no position twice');
  for (const [at, actor] of actors.entries()) {
    if (at !== 3 && at !== 25) {
      assert.ok(seen.includes(key(actor.slot, actor.generation)), `resident actor ${at} visited`);
    }
  }
  assert.ok(seen.includes(key(visited.slot, visited.generation)), 'visited before it was destroyed');
  assert.ok(!seen.includes(key(ahead.slot, ahead.generation)), 'destroyed before the walk reached it');
  for (const spawned of [first, second]) {
    assert.equal(seen.includes(key(spawned.slot, spawned.generation)), spawned.slot >= 10,
      `a spawned actor is visited exactly when its slot is ahead of the cursor (slot ${spawned.slot})`);
  }

  // actors() skips an actor destroyed after its page was taken, before it was reached.
  const inspections = system.actors({ pageSize: 30 });
  const firstInspection = inspections.next().value;
  const gone = actors[20];
  system.destroy(gone);
  const rest = [...inspections].map((inspection) => key(inspection.actor.slot, inspection.actor.generation));
  assert.ok(firstInspection !== undefined);
  assert.ok(!rest.includes(key(gone.slot, gone.generation)));
  assert.equal(rest.length + 1, 29, 'every other resident actor');
  system.close();
}

// Iterating keeps at most one page on the JavaScript side, whatever the
// population: the bytes held midway through an iteration do not grow with it.
async function heapIsBoundedByThePage() {
  const heldMidway = async (population) => {
    const system = createSystem();
    await populate(system, population);
    const before = retained();
    // Two iterations held open midway through the population.
    const openIDs = system.actorIDs({ pageSize: 1024 });
    const openInspections = system.actors({ pageSize: 1024 });
    for (let at = 0; at < population / 2048; at += 1) {
      openIDs.next();
    }
    for (let at = 0; at < population / 2; at += 1) {
      openInspections.next();
    }
    const held = retained() - before;
    openIDs.return();
    openInspections.return();
    system.close();
    return held;
  };
  const small = await heldMidway(20_480);
  const large = await heldMidway(81_920);
  // Holding every inspection of the large population would be tens of MB.
  const bound = 1024 * 1024;
  assert.ok(small < bound, `held ${small} bytes midway through 20k actors`);
  assert.ok(large < bound, `held ${large} bytes midway through 80k actors`);
}

// The last page costs about what the first does: a whole iteration is linear.
async function lastPageCostsLikeTheFirst() {
  const system = createSystem();
  await populate(system, 100_000);
  const pageSize = 4096;
  const firsts = [];
  const lasts = [];
  for (let run = 0; run < 7; run += 1) {
    const times = [];
    let from = process.hrtime.bigint();
    for (const page of system.actorIDs({ pageSize })) {
      const now = process.hrtime.bigint();
      times.push(Number(now - from));
      void page;
      from = process.hrtime.bigint();
    }
    // The last page may be short; compare full pages.
    const full = times.slice(0, Math.floor(100_000 / pageSize));
    firsts.push(...full.slice(0, 3));
    lasts.push(...full.slice(-3));
  }
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const ratio = median(lasts) / median(firsts);
  assert.ok(ratio < 4, `last pages cost ${ratio.toFixed(2)}x the first`);
  system.close();
}

(async () => {
  // A system that never goes quiet shows up as a hang: fail instead.
  let current = 'start';
  const watchdog = setTimeout(() => {
    console.error(`enumerate.js: ${current} did not finish in time`);
    process.exit(1);
  }, Number(process.env.ENUMERATE_TIMEOUT_MS ?? 120_000));
  for (const test of [
    pagesCoverThePopulation, optionsAndClose, changesBetweenPages, heapIsBoundedByThePage, lastPageCostsLikeTheFirst,
  ]) {
    current = test.name;
    await test();
  }
  clearTimeout(watchdog);
  console.log('enumerate.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
