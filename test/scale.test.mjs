// The scaling gate's fast pass (docs/plan.xml, p2-scale): every operation of
// tools/scale.mjs on hosts of 20,000 and 40,000 actors (the all-resident
// scenario at 40,000 and 80,000: between 20,000 and 40,000 resident
// actors a close's cost per actor steps up by 1.45 as the population leaves
// the processor's cache, then stays flat to 160,000), on the datamodel
// under test, each size in a process of its own under this runtime. The
// cost at 40,000 must be within the gate's factor of the cost at 20,000
// (per call, or per actor for the operations on the whole population); an
// operation over it is measured again before it fails, both sizes in new
// processes, up to eight times, each size keeping its least cost, so noise
// does not fail the test and a scan does: a process's costs vary by up to
// 1.6 times from one process to the next (a collection, its heap's
// layout), and four attempts left one operation over in 3 of 8 runs
// (docs/log.xml, l-p2-decisions-scale-gate-noise); from the third attempt
// the median of the attempts' own ratios counts too, since a slow minute
// of the machine slows both sizes of an attempt alike
// (l-p2-allocation-scale-slow-minutes). The operations known to grow because
// of core (KNOWN, each with its request to core) are reported, not failed.
// `mise run scale` and `mise run test --full` run the same at two and four
// million actors.
import { Host } from '@tinyactors/node';
import { FACTOR, gate, KNOWN } from '../tools/scale.mjs';
import { CONFIG, DATAMODEL, ENGINE, image, scxml } from './charts.mjs';
import { collect, run, test } from './harness.mjs';

test(`every operation costs at 40,000 actors at most ${FACTOR} times what it costs at 20,000`, async () => {
  const report = await gate({ actors: 20_000, 'resident-actors': 40_000, datamodel: DATAMODEL, samples: 5, 'min-ms': 20, attempts: 8 });
  for (const known of report.known) console.log(`     known: ${known}`);
  for (const [name, request] of Object.entries(KNOWN)) {
    const measured = Object.values(report.scenarios).some((scenario) => name in scenario.ratios);
    if (!measured) throw new Error(`KNOWN names ${name} (${request}), which the gate does not measure`);
  }
  if (report.failures.length) throw new Error(report.failures.join('\n'));
});

// The native datamodel's restore makes a row's values in the engine, then
// the next row's: as one value of every row, a restore of 200,000 sessions
// cost about twice per session what one of 10,000 did on node (16 us
// against 31), and a million six times (12 us against 76).
const LISTS = scxml('lists', `
  <datamodel><data id="n" expr="0"/><data id="list" expr="[1, 2, 3, 4, 5, 6, 7, 8, 'a', 'b', 'c', 'd', {x: 1}, {y: 2}]"/></datamodel>
  <state id="s"/>`);

/** A snapshot of `sessions` sessions of LISTS. */
async function snapshotOf(sessions) {
  const host = new Host(CONFIG, ENGINE);
  host.addImage(image({ lists: LISTS }));
  const chart = host.chart('lists');
  for (let i = 0; i < sessions; i++) {
    host.spawn(chart);
    if (i % 4096 === 4095) await host.idle();
  }
  await host.idle();
  const snapshot = host.snapshot();
  host.close();
  return snapshot;
}

/** One restore's cost per session, after a full collection: a restore is
 * not charged the collection of the hosts restored before it. */
async function restoreCost(snapshot, sessions) {
  await collect(2);
  const started = performance.now();
  const restored = Host.restore(snapshot, CONFIG, ENGINE);
  const cost = (performance.now() - started) / sessions;
  restored.close();
  return cost;
}

test(`a restore costs per session at 200,000 sessions at most ${FACTOR} times what it costs at 10,000`, async () => {
  if (DATAMODEL !== 'native') return; // quickjs's state is restored by core, in one call
  const sizes = [10_000, 200_000];
  const snapshots = [];
  for (const sessions of sizes) snapshots.push(await snapshotOf(sessions));
  // each size keeps its least cost of every attempt, the two sizes measured
  // in turn: noise (a collection, a neighbour) only adds time and does not
  // repeat, a restore that grows with the sessions does (as the gate does)
  const best = [Infinity, Infinity];
  for (let attempt = 0; attempt < 4 && (attempt < 2 || best[1] / best[0] > FACTOR); attempt++)
    for (let i = 0; i < sizes.length; i++) best[i] = Math.min(best[i], await restoreCost(snapshots[i], sizes[i]));
  const [small, large] = best;
  if (large / small > FACTOR)
    throw new Error(`restore: ${(small * 1000).toFixed(1)} us a session at 10,000, ${(large * 1000).toFixed(1)} at 200,000`);
});

await run();
