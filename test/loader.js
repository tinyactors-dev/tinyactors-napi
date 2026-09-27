'use strict';

// lib/loader.js (docs/adr/0001-packaging-and-releases.md): the installed
// platform package wins, else the repository build, else one error that
// names what it looked for. Each case lays out its own node_modules in a
// temporary directory. Runs on Node and Bun.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAddon, packageName, SUPPORTED } = require('../lib/loader');

const REPOSITORY_BUILD = path.join(__dirname, '..', 'build', 'tinyactors_napi.node');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyactors-loader-'));
const missing = path.join(scratch, 'no-such-addon.node');

// A node_modules under a new directory of `scratch` holding `name`, whose
// addon is `addon` (a path to copy, or the bytes to write).
function layout(label, name, addon) {
  const root = path.join(scratch, label);
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'tinyactors.node' }));
  if (Buffer.isBuffer(addon)) {
    fs.writeFileSync(path.join(dir, 'tinyactors.node'), addon);
  } else if (addon !== undefined) {
    fs.copyFileSync(addon, path.join(dir, 'tinyactors.node'));
  }
  return { root, addon: path.join(dir, 'tinyactors.node') };
}

function platformPackageWins() {
  const name = packageName('linux', 'x64');
  const { root, addon } = layout('present', name, REPOSITORY_BUILD);
  const loaded = loadAddon({ platform: 'linux', arch: 'x64', paths: [root], repositoryBuild: missing });
  assert.equal(typeof loaded.version, 'string');
  assert.equal(loaded, require(addon), 'the platform package is the one loaded');
}

function repositoryBuildWithoutPackage() {
  const empty = path.join(scratch, 'empty');
  fs.mkdirSync(empty);
  const loaded = loadAddon({ platform: 'linux', arch: 'x64', paths: [empty] });
  assert.equal(loaded, require(REPOSITORY_BUILD));
}

function oneErrorWithNeither() {
  const empty = path.join(scratch, 'empty');
  assert.throws(() => loadAddon({ platform: 'linux', arch: 'arm64', paths: [empty], repositoryBuild: missing }), (error) => {
    assert.equal(error.code, 'ERR_TINYACTORS_NO_ADDON');
    assert.match(error.message, /@tinyactors\/node-linux-arm64 is not installed/);
    assert.match(error.message, /linux-arm64/);
    assert.match(error.message, /optional dependency/);
    for (const platform of SUPPORTED) {
      assert.ok(error.message.includes(platform), `names ${platform}`);
    }
    return true;
  });
  assert.throws(() => loadAddon({ platform: 'freebsd', arch: 'x64', paths: [empty], repositoryBuild: missing }), (error) => {
    assert.equal(error.code, 'ERR_TINYACTORS_NO_ADDON');
    assert.match(error.message, /@tinyactors\/node-freebsd-x64 is not installed \(there is no package for this platform\)/);
    return true;
  });
}

// An installed package whose addon cannot load throws its own error; the
// loader does not fall back to the repository build.
function brokenPackageThrowsItsError() {
  const name = packageName('darwin', 'arm64');
  const { root } = layout('broken', name, Buffer.from('not a shared library'));
  assert.throws(() => loadAddon({ platform: 'darwin', arch: 'arm64', paths: [root] }), (error) => {
    assert.notEqual(error.code, 'ERR_TINYACTORS_NO_ADDON');
    assert.match(String(error.message), /tinyactors\.node|invalid ELF|shared|dlopen/i);
    return true;
  });
  const { root: withoutAddon } = layout('no-addon', packageName('linux', 'arm64'));
  assert.throws(() => loadAddon({ platform: 'linux', arch: 'arm64', paths: [withoutAddon] }), (error) => {
    assert.notEqual(error.code, 'ERR_TINYACTORS_NO_ADDON');
    return true;
  });
}

try {
  platformPackageWins();
  repositoryBuildWithoutPackage();
  oneErrorWithNeither();
  brokenPackageThrowsItsError();
  console.log('loader.js passed');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
