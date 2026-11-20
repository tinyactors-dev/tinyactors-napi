// The packages' smoke test (mise/pack.rb): run in a fresh project that
// installed @tinyactors/node and this machine's platform package from
// their tarballs, never from the repository, by node and by bun (and in
// Linux containers by the release).
//
//   node smoke.mjs        bun smoke.mjs
//
// It compiles a counter for both datamodels, sends its actor three events,
// reads the count from its log line, awaits a typed method's promise
// (the convenience layer), round-trips a value through the
// codec, checks that the addon came from the platform package, and prints
// one line naming the platform. Exits with status 1 when a check fails.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compileCharts, decode, encode, Host } from '@tinyactors/node';

const COUNTER = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="s">
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="s">
    <transition event="inc"><assign location="n" expr="n + 1"/></transition>
    <transition event="report"><log label="count" expr="n"/></transition>
  </state>
</scxml>`;

async function count(datamodel) {
  const lines = [];
  const host = new Host([], { system: 'smoke', datamodel, log: (entry) => lines.push(entry.text) });
  try {
    const compiled = compileCharts([{ name: 'counter.scxml', text: COUNTER }]);
    try {
      host.addImage(compiled.image);
    } finally {
      compiled.close();
    }
    const session = host.spawn(host.chart('counter'));
    for (const value of [1, 'two', { three: [3] }]) host.send(session, 'inc', value);
    host.send(session, 'report');
    await host.idle();
    // the convenience layer shipped with the main package (lib/)
    const stats = await host.hostStats();
    if (stats.host.actors !== 1) lines.push(`hostStats answered ${stats.host.actors} actors, not 1`);
  } finally {
    host.close();
  }
  return lines;
}

const failures = [];
for (const datamodel of ['native', 'quickjs']) {
  const lines = await count(datamodel);
  if (lines.length !== 1 || lines[0] !== '3') failures.push(`${datamodel}: the counter logged ${JSON.stringify(lines)}, not 3`);
}
const value = { n: [1, 2.5, 'x', null, true, new Uint8Array([0])] };
const back = decode(encode(value));
if (JSON.stringify(back, (k, v) => (v instanceof Uint8Array ? [...v] : v)) !== JSON.stringify(value, (k, v) => (v instanceof Uint8Array ? [...v] : v))) {
  failures.push(`the codec does not round-trip ${JSON.stringify(back)}`);
}
// The platform package lib/direct.mjs loads is the one resolved from the main
// package's directory, and it must be this build's: a registry's package of
// the same name (an older release) would pass every check above.
const require = createRequire(import.meta.url);
const main = dirname(require.resolve('@tinyactors/node'));
const version = JSON.parse(readFileSync(join(main, 'package.json'), 'utf8')).version;
const platformPackage = `@tinyactors/node-${process.platform}-${process.arch}`;
try {
  const loaded = createRequire(join(main, 'lib', 'direct.mjs'))(`${platformPackage}/package.json`).version;
  if (loaded !== version) failures.push(`${platformPackage} is ${loaded}, not ${version}, the main package's`);
} catch (error) {
  failures.push(`${platformPackage} does not resolve from the main package: ${error.message}`);
}
if (existsSync(join(main, 'build'))) failures.push(`${main} has a build/: the addon may not be the platform package's`);

const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const libc = process.report?.getReport?.().header?.glibcVersionRuntime;
const where = `${version}, ${process.platform} ${process.arch}, ${runtime}${libc ? `, glibc ${libc}` : ''}`;
for (const failure of failures) console.error(`smoke: ${where}: ${failure}`);
if (failures.length > 0) process.exit(1);
console.log(`smoke: ok: ${where}`);
