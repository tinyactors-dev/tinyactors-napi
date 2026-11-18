// The job scheduler on the real clock.
//
//   node examples/job-scheduler/main.mjs            a batch of jobs; the process exits by itself
//                                                   when the last one ends
//   node examples/job-scheduler/main.mjs --serve    recurring jobs for ever, until SIGINT or
//                                                   SIGTERM: then a graceful shutdown
//   node examples/job-scheduler/main.mjs --drift    a fixed-rate and a fixed-delay job side by
//                                                   side, with and without a CPU-bound job
//
// Options: --grace MS (the shutdown's grace, default 500), --json (one JSON
// record per line instead of text, for the test).
import { parseArgs } from 'node:util';
import { lateness, Scheduler } from './scheduler.mjs';

const { values } = parseArgs({
  options: {
    serve: { type: 'boolean', default: false },
    drift: { type: 'boolean', default: false },
    grace: { type: 'string', default: '500' },
    json: { type: 'boolean', default: false },
  },
});

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** The workers a job may name: what a real scheduler would run (a report,
 * a backup, a webhook), stood in for by their timing and failures. */
function workers() {
  const calls = new Map();
  const count = (job) => { const n = (calls.get(job) ?? 0) + 1; calls.set(job, n); return n; };
  return {
    // a quick job: a cache refresh
    refresh: () => ({ refreshed: true }),
    // a slow job that honours its signal: an export
    export: ({ signal }) => sleep(120, signal).then(() => ({ rows: 1200 })),
    // fails its first two attempts, then succeeds: a webhook to a flaky peer
    webhook: ({ job }) => {
      if (count(job) <= 2) throw new Error('503 from the peer');
      return { delivered: true };
    },
    // never settles and ignores its signal: a call to a peer that hangs
    hang: () => new Promise(() => {}),
    // ignores its signal and finishes in its own time: a batch that cannot
    // be interrupted
    stubborn: () => sleep(1500).then(() => ({ done: true })),
    // blocks the event loop: a CPU-bound job, which delays every other job
    crunch: () => { const end = performance.now() + 12; while (performance.now() < end); },
  };
}

const print = values.json
  ? (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
  : (record) => {
    if (record.event === 'run.started') return;
    const at = String(Math.round(record.at)).padStart(5);
    const what = record.event === 'ended'
      ? `${record.outcome} after ${record.runs} run(s), ${record.failures} failure(s)${record.lastError ? ` (last: ${record.lastError})` : ''}`
      : record.event === 'attempt.failed' ? `attempt ${record.attempt} failed: ${record.error}`
        : record.job === '-' ? JSON.stringify({ ...record, event: undefined, job: undefined, at: undefined })
          : `run ${record.run}`;
    process.stdout.write(`${at} ms  ${record.job.padEnd(10)} ${record.event.padEnd(15)} ${what}\n`);
  };

if (values.drift) {
  // Each case in a scheduler of its own: two recurring jobs every 20 ms,
  // one fixed-rate and one fixed-delay, alone and beside a CPU-bound job.
  for (const loaded of [false, true]) {
    const scheduler = new Scheduler({ workers: workers() });
    scheduler.submit({ id: 'fixed-rate', kind: 'recurring', worker: 'refresh', every: 20, times: 40, cadence: 'fixed-rate' });
    scheduler.submit({ id: 'fixed-delay', kind: 'recurring', worker: 'refresh', every: 20, times: 40, cadence: 'fixed-delay' });
    if (loaded) scheduler.submit({ id: 'crunch', kind: 'recurring', worker: 'crunch', every: 17, times: 45, cadence: 'fixed-delay' });
    await scheduler.settled();
    for (const job of ['fixed-rate', 'fixed-delay']) {
      const late = lateness(scheduler.records, job);
      const record = { event: 'drift', job, loaded, runs: late.runs, last: late.last, max: late.max, mean: late.mean };
      if (values.json) print(record);
      else console.log(`${loaded ? 'with a CPU-bound job' : 'alone              '}  ${job.padEnd(11)}  ${late.runs} runs every 20 ms: the last started ${late.last.toFixed(1)} ms late (mean ${late.mean.toFixed(1)}, max ${late.max.toFixed(1)})`);
    }
    scheduler.host.close();
  }
} else if (values.serve) {
  // Recurring jobs for ever, and one attempt that hangs past the grace.
  const scheduler = new Scheduler({ workers: workers(), onReport: print });
  scheduler.submit({ id: 'refresh', kind: 'recurring', worker: 'refresh', every: 50 });
  scheduler.submit({ id: 'export', kind: 'recurring', worker: 'export', every: 200, timeout: 1000 });
  scheduler.submit({ id: 'stuck', kind: 'once', worker: 'hang', in: 0, timeout: 60_000 });
  scheduler.submit({ id: 'batch', kind: 'recurring', worker: 'stubborn', every: 100, timeout: 60_000 });
  scheduler.submit({ id: 'nightly', kind: 'once', worker: 'export', in: 3_600_000 });
  print({ event: 'ready', job: '-', at: scheduler.now(), pid: process.pid });
  const stop = async (signal) => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    print({ event: 'signal', job: '-', at: scheduler.now(), signal });
    const closing = scheduler.shutdown({ grace: Number(values.grace) });
    try {
      scheduler.submit({ kind: 'once', worker: 'refresh' });
    } catch (error) {
      print({ event: 'refused', job: '-', at: scheduler.now(), message: error.message });
    }
    const summary = await closing;
    // the process exits by itself from here: close() cleared the host's
    // timer, and the hanging worker's promise holds nothing
    print({ event: 'closed', job: '-', at: scheduler.now(), ...summary, stateAtClose: summary.stateAtClose(), unanswered: scheduler.unanswered });
    process.once('exit', () => print({ event: 'exit', job: '-', at: scheduler.now(), stateAtClose: summary.stateAtClose(), unanswered: scheduler.unanswered }));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  // A batch: every job ends, so the host arms no timer after the last one,
  // and the process exits with the host still open.
  const scheduler = new Scheduler({ workers: workers(), onReport: print });
  scheduler.submit({ id: 'refresh', kind: 'recurring', worker: 'refresh', every: 50, times: 5 });
  scheduler.submit({ id: 'export', kind: 'once', worker: 'export', in: 100 });
  scheduler.submit({ id: 'webhook', kind: 'deadline', worker: 'webhook', in: 20, within: 1000, backoff: 40 });
  scheduler.submit({ id: 'peer', kind: 'deadline', worker: 'hang', in: 0, within: 300, timeout: 80, backoff: 20 });
  scheduler.submit({ id: 'cleanup', kind: 'once', worker: 'refresh', in: 400 });
  scheduler.submit({ id: 'report', kind: 'once', worker: 'refresh', in: 5000 });
  setTimeout(() => {
    scheduler.cancel('cleanup');
    scheduler.reschedule('report', { in: 50 });
    scheduler.reschedule('refresh', { every: 30 });
  }, 120);
  process.once('beforeExit', () => {
    // the loop is empty: no job left, and the open host keeps nothing alive
    // (no doc says so: docs/log.xml, l-p4-examples-jobs-exit-open)
    print({ event: 'idle', job: '-', at: scheduler.now(), jobs: scheduler.jobs.size, deadline: scheduler.host.nextDeadline ?? null, closed: scheduler.host.closed });
    scheduler.host.close();
  });
}
