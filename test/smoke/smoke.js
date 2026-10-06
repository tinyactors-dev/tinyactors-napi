'use strict';

// Run from a fresh project that installed the packed tarballs (mise run
// node:smoke, node:smoke-containers): @tinyactors/node must load its addon
// from the platform package, not from a build tree, and run a machine.

const assert = require('node:assert/strict');
const path = require('node:path');
const { createMachine, createActor, assign } = require('@tinyactors/node');

const { version } = require('@tinyactors/node/package.json');
const platform = `@tinyactors/node-${process.platform}-${process.arch}`;
const main = path.dirname(require.resolve('@tinyactors/node/package.json'));
const addon = require.resolve(platform, { paths: [main] });
assert.equal(require(`${platform}/package.json`).version, version, 'the platform package has the main package\'s version');
assert.ok(require.cache[addon], `the addon was loaded from ${platform}`);

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
actor.send({ type: 'TOGGLE' });
assert.equal(actor.getSnapshot().value, 'active');
actor.send({ type: 'TOGGLE' });
actor.send({ type: 'TOGGLE' });
actor.send({ type: 'STOP' });
const snapshot = actor.getSnapshot();
assert.equal(snapshot.status, 'done');
assert.deepEqual(snapshot.output, { toggles: 2 });

const engine = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;
console.log(`smoke passed: @tinyactors/node ${version} on ${engine}, ${process.platform}-${process.arch}, addon from ${platform}`);
