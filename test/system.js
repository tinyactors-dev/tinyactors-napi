'use strict';

// Step 2: a system is created, closed and finalized in any order without
// leaks (ROADMAP step 2, ADRs 0008, 0012, 0014).

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createSystem, TinyactorsError } = require('..');
const native = require('../lib/native');

const isBun = typeof Bun !== 'undefined';

function collectGarbage() {
  if (isBun) {
    Bun.gc(true);
    return;
  }
  require('node:v8').setFlagsFromString('--expose-gc');
  require('node:vm').runInNewContext('gc')();
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function assertClosedError(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.name, 'TinyactorsError');
    assert.equal(error.code, 'closed');
    return true;
  });
}

function lifecycle() {
  const system = createSystem();
  assert.equal(system.closed, false);

  const stats = system.stats();
  assert.ok(stats.memory.core.bytesInUse > 0, 'core allocates its system through the counting allocator');
  assert.equal(stats.memory.total.bytesInUse, Object.entries(stats.memory)
    .filter(([name]) => name !== 'total')
    .reduce((sum, [, counters]) => sum + counters.bytesInUse, 0));
  for (const name of ['core', 'envelopes', 'scheduling', 'values', 'directory', 'scratch', 'other']) {
    assert.deepEqual(Object.keys(stats.memory[name]).sort(), ['allocations', 'bytesInUse', 'frees', 'largestBlock', 'peakBytes']);
  }
  assert.equal(stats.allocatorCalls, stats.memory.total.allocations + stats.memory.total.frees);

  system.close();
  assert.equal(system.closed, true);
  system.close(); // idempotent
  assertClosedError(() => system.stats());
}

function disposes() {
  const system = createSystem();
  assert.equal(typeof system[Symbol.dispose], 'function');
  system[Symbol.dispose]();
  assert.equal(system.closed, true);
}

function rejectsBadOptions() {
  assert.throws(() => createSystem(42), (error) => error instanceof TinyactorsError && error.code === 'invalid');
}

function manyInAnyOrder() {
  const before = native.environmentStats();
  const systems = Array.from({ length: 200 }, () => createSystem());
  // Close every third one from the back, then the rest from the front.
  for (let index = systems.length - 1; index >= 0; index -= 3) {
    systems[index].close();
  }
  for (const system of systems) {
    system.close();
  }
  const after = native.environmentStats();
  assert.equal(after.systemsCreated - before.systemsCreated, 200);
  assert.equal(after.systemsClosed - before.systemsClosed, 200);
  assert.equal(after.leakedBytes, 0);
}

async function finalizedWithoutClose() {
  const before = native.environmentStats();
  (() => {
    for (let index = 0; index < 100; index += 1) {
      createSystem();
    }
  })();
  // Finalizers are a safety net (ADR 0012): they close what JavaScript dropped.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    collectGarbage();
    await nextTurn();
    if (native.environmentStats().systemsClosed - before.systemsClosed === 100) {
      break;
    }
  }
  const after = native.environmentStats();
  if (!isBun) {
    assert.equal(after.systemsClosed - before.systemsClosed, 100, 'Node finalizes dropped systems');
  }
  assert.equal(after.leakedBytes, 0);
}

function cleanupHookClosesOpenSystems() {
  // The environment cleanup hook closes systems still open at exit.
  const script = `
    const { createSystem } = require(${JSON.stringify(path.join(__dirname, '..'))});
    globalThis.kept = Array.from({ length: 10 }, () => createSystem());
    createSystem().close();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `child exited with ${result.status}: ${result.stderr}`);
}

async function workerEnvironment() {
  if (isBun) {
    return; // Bun's worker teardown is not covered here.
  }
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(`
    const { createSystem } = require(${JSON.stringify(path.join(__dirname, '..'))});
    globalThis.kept = Array.from({ length: 10 }, () => createSystem());
  `, { eval: true });
  const code = await new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', resolve);
  });
  assert.equal(code, 0);
}

(async () => {
  lifecycle();
  disposes();
  rejectsBadOptions();
  manyInAnyOrder();
  await finalizedWithoutClose();
  cleanupHookClosesOpenSystems();
  await workerEnvironment();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
