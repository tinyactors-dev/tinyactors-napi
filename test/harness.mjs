// A test harness that runs the same under node, bun and a Chromium page:
// bun refuses node:test outside `bun test`. Each test file calls test()
// for its cases and run() once; a failed case makes the process exit 1
// (in a page, the runner is told: test/runtime.mjs).
//
// Against @tinyactors/wasm, the cases wasm/test/exclusions.mjs lists for
// this runtime are skipped, each with its reason, and counted; a listed
// case the file does not have fails the run, so the list stays true. With
// TA_TEST_EXCLUDED=run (or a page's `runExcluded`) the excluded cases run
// too and each one that passes is reported, to shorten the list.
import { exclusionsOf, fileExcluded } from '../wasm/test/exclusions.mjs';
import { failed, file, fullCollection, macrotask, runtime, wasm } from './runtime.mjs';

const cases = [];

export function test(name, body) {
  cases.push({ name, body });
}

const runExcluded = globalThis.__tinyactors_test?.runExcluded ?? globalThis.process?.env?.TA_TEST_EXCLUDED === 'run';

// Runs every case; again on each call (a file that runs its cases once per
// datamodel calls it once per datamodel).
export async function run() {
  let failures = 0, skipped = 0, passedExcluded = 0;
  const excluded = wasm ? exclusionsOf(file, runtime) : new Map();
  const whole = wasm ? fileExcluded(file, runtime) : undefined;
  if (whole !== undefined) for (const { name } of cases) if (!excluded.has(name)) excluded.set(name, whole);
  for (const name of excluded.keys()) {
    if (!cases.some((each) => each.name === name)) {
      failures++;
      console.log(`FAIL wasm/test/exclusions.mjs names a case ${file} does not have: ${name}`);
    }
  }
  for (const { name, body } of cases) {
    const reason = excluded.get(name);
    if (reason !== undefined && !runExcluded) {
      skipped++;
      console.log(`skip ${name} (${reason})`);
      continue;
    }
    try {
      await body();
      if (reason !== undefined) {
        passedExcluded++;
        console.log(`PASS excluded ${name} (${reason})`);
      } else console.log(`ok   ${name}`);
    } catch (error) {
      if (reason !== undefined) {
        console.log(`fail excluded ${name} (${reason})`);
        continue;
      }
      failures++;
      console.log(`FAIL ${name}`);
      console.log(String(error?.stack ?? error).replace(/^/gm, '     '));
    }
  }
  if (skipped || passedExcluded) console.log(`excluded: ${skipped} skipped${passedExcluded ? `, ${passedExcluded} excluded but passing` : ''}`);
  failed(failures);
}

// A full collection, then the turns the runtime runs finalizers in (node
// runs Node-API finalizers after the collection, from the event loop, so
// each collection is followed by a turn).
export async function collect(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await fullCollection();
    await macrotask();
  }
}
