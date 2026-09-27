'use strict';

// Runs the W3C SCXML IRP suite against the addon (napi ADR 0019): every test
// `mise run irp` rewrote for the ECMAScript data model is imported with
// define(xml, { format: 'scxml' }) under tools/ecmascript-datamodel.js, run
// on a manual clock, and judged by the `Outcome` <log> its pass or fail
// state writes.
//
//   node test/irp/run.js build/irp/documents.json [--baseline]
//
// test/irp/expected-failures.json lists the tests known to fail, each with
// the reason. The run fails on a test that fails and is not listed, and on
// a listed test that passes. --baseline rewrites the list from this run.

const fs = require('node:fs');
const path = require('node:path');
const { createSystem } = require('../..');
const { ecmascript } = require('../../tools/ecmascript-datamodel');

const EXPECTED = path.join(__dirname, 'expected-failures.json');
const STEP_MS = 100;       // logical time per step while waiting for an outcome
const LOGICAL_LIMIT = 20000; // logical milliseconds a test may take
const WALL_LIMIT = 3000;   // real milliseconds a test may take (a chart that loops forever)

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no outcome within ${ms} ms of real time`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function drive(system, outcome) {
  for (let time = 0; time <= LOGICAL_LIMIT && outcome.value === undefined; time += STEP_MS) {
    await system.flush();
    if (outcome.value === undefined) {
      await system.advanceBy(STEP_MS);
    }
  }
}

// One test: its outcome, or why it has none.
async function run(test) {
  const outcome = { value: undefined };
  const system = createSystem({
    clock: 'manual',
    log: (record) => {
      if (record.label === 'Outcome' && outcome.value === undefined) {
        outcome.value = record.value;
      }
    },
  });
  try {
    system.registerDatamodel('ecmascript', ecmascript);
    let start;
    // An invoke's src="file:test239sub1.scxml" names a sibling document of
    // the test (napi ADR 0021); <data src> and <script src> name the files
    // the importer read.
    const siblings = {};
    for (const chart of test.charts) {
      siblings[`file:${chart.name.replace(/^irp_/, '')}.scxml`] = chart.source;
    }
    for (const chart of test.charts) {
      const resolve = (src) => chart.files?.[src] ?? siblings[src];
      const definition = system.define(chart.source, { format: 'scxml', resolve });
      if (chart.start) {
        start = definition;
      }
    }
    system.spawn(start);
    await withTimeout(drive(system, outcome), WALL_LIMIT);
    if (outcome.value === 'pass') {
      return { passed: true };
    }
    return { passed: false, reason: outcome.value === undefined ? 'no outcome' : `outcome ${outcome.value}` };
  } catch (error) {
    return { passed: false, reason: `${error.code ?? error.name}: ${error.message.split('\n')[0]}` };
  } finally {
    try {
      system.close();
    } catch {
      // Already closed.
    }
  }
}

(async () => {
  const [documentsPath, ...flags] = process.argv.slice(2);
  const baseline = flags.includes('--baseline');
  const tests = JSON.parse(fs.readFileSync(documentsPath, 'utf8'));
  const expected = baseline || !fs.existsSync(EXPECTED) ? {} : JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
  const failures = {};
  const unexpected = [];
  let passed = 0;
  let skipped = 0;
  for (const test of tests) {
    if (test.skip !== undefined) {
      skipped += 1;
      continue;
    }
    const result = await run(test);
    if (result.passed) {
      passed += 1;
      if (expected[test.label] !== undefined) {
        unexpected.push(`${test.label}: passes, but expected-failures.json lists it (${expected[test.label]})`);
      }
      continue;
    }
    failures[test.label] = result.reason;
    if (expected[test.label] === undefined) {
      unexpected.push(`${test.label}: ${result.reason}`);
    }
  }
  const failed = Object.keys(failures).length;
  const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;
  console.log(`scxml-irp against the addon (${runtime}): ${passed + failed} run, ${passed} passed, ` +
              `${failed} expected to fail, ${skipped} skipped`);
  if (baseline) {
    fs.writeFileSync(EXPECTED, `${JSON.stringify(failures, null, 2)}\n`);
    console.log(`wrote ${failed} expected failures to ${path.relative(process.cwd(), EXPECTED)}`);
    return;
  }
  if (unexpected.length !== 0) {
    console.error(unexpected.join('\n'));
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
