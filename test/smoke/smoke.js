'use strict';

// Run from a project that installed the packed tarballs (mise run
// smoke-install, smoke-packages): @tinyactors/node must load its addon from
// the platform package, and run a chart.

const assert = require('node:assert/strict');
const path = require('node:path');
const tinyactors = require('@tinyactors/node');

const { version } = require('@tinyactors/node/package.json');
const platform = `@tinyactors/node-${process.platform}-${process.arch}`;
const addon = path.dirname(require.resolve(`${platform}/package.json`, { paths: [path.dirname(require.resolve('@tinyactors/node'))] }));

async function main() {
  assert.equal(tinyactors.version, version, 'the addon reports the package version');
  const light = tinyactors.statechart({ family: 'light', revision: 'v1' })
    .data('switches', 0)
    .state('off', (s) => s.on('toggle', (t) => t.target('on').assign('switches', function () { return this.switches + 1; })))
    .state('on', (s) => s.on('toggle', (t) => t.target('off')));
  const system = tinyactors.createSystem();
  const lamp = system.spawn(system.define(light), { name: 'lamp' });
  const result = await lamp.send('toggle');
  assert.equal(result.status, 'stable');
  assert.deepEqual(lamp.inspect().activeStates, ['on']);
  assert.equal(lamp.data().switches, 1);
  system.close();
  const engine = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;
  console.log(`smoke passed: @tinyactors/node ${version} on ${engine}, ${process.platform}-${process.arch}, addon from ${path.basename(addon)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
