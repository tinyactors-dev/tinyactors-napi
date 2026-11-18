// The job chart's rules on a SimulatedClock, on both datamodels; the
// cadence and idle() on the real clock with small intervals; and the
// process's liveness and shutdown in child processes. Run by `mise run
// examples` (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SimulatedClock } from '@tinyactors/node';
import { lateness, Scheduler } from './scheduler.mjs';

const MAIN = fileURLToPath(new URL('main.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** A worker whose calls wait until the test settles them. */
function held() {
  const calls = [];
  const worker = (context) => new Promise((resolve, reject) => calls.push({ ...context, resolve, reject }));
  return { calls, worker };
}

/** Lets the host's turns run. Not `idle()`: it waits for the promises the
 * host's handlers returned, and the run handler returns the worker's, which
 * these tests hold until they settle it. */
async function settle(scheduler) {
  for (let round = 0; round < 8; round++) await new Promise((resolve) => setImmediate(resolve));
}

/** Moves the clock to `ms` from where it is, deadline by deadline. */
async function advance(clock, scheduler, ms) {
  const end = clock.now + ms;
  await settle(scheduler);
  while (scheduler.host.nextDeadline !== undefined && clock.now + scheduler.host.nextDeadline <= end) {
    clock.increment(scheduler.host.nextDeadline);
    await settle(scheduler);
  }
  if (clock.now < end) clock.increment(end - clock.now);
  await settle(scheduler);
}

const events = (scheduler, job, event) => scheduler.records.filter((r) => r.job === job && r.event === event);
const ended = (scheduler, job) => events(scheduler, job, 'ended')[0];

for (const datamodel of ['native', 'quickjs']) {
  const setup = (workers) => {
    const clock = new SimulatedClock();
    return { clock, scheduler: new Scheduler({ clock, datamodel, workers }) };
  };

  test(`${datamodel}: a recurring job runs on its cadence, its limit times, and leaves no deadline`, async () => {
    const { clock, scheduler } = setup({ quick: () => 'ok' });
    scheduler.submit({ id: 'tick', kind: 'recurring', worker: 'quick', every: 1000, times: 3 });
    await advance(clock, scheduler, 10_000);
    assert.deepEqual(events(scheduler, 'tick', 'run.started').map((r) => r.startedAt), [1000, 2000, 3000]);
    assert.deepEqual(events(scheduler, 'tick', 'run.started').map((r) => r.lateness), [0, 0, 0]);
    assert.equal(ended(scheduler, 'tick').outcome, 'completed');
    assert.equal(scheduler.host.nextDeadline, undefined);
    scheduler.host.close();
  });

  test(`${datamodel}: a failing attempt is retried with exponential backoff; the error reaches the chart`, async () => {
    const { calls, worker } = held();
    const { clock, scheduler } = setup({ flaky: worker });
    scheduler.submit({ id: 'hook', kind: 'deadline', worker: 'flaky', in: 500, within: 60_000, backoff: 100, timeout: 5000 });
    await advance(clock, scheduler, 500);
    calls[0].reject(new Error('503 from the peer'));
    await advance(clock, scheduler, 100);
    calls[1].reject(new Error('connection reset'));
    await advance(clock, scheduler, 200);
    calls[2].resolve({ delivered: true });
    await settle(scheduler);
    assert.deepEqual(events(scheduler, 'hook', 'run.started').map((r) => [r.attempt, r.startedAt]), [[1, 500], [2, 600], [3, 800]]);
    assert.deepEqual(events(scheduler, 'hook', 'attempt.failed').map((r) => r.error), ['503 from the peer', 'connection reset']);
    const end = ended(scheduler, 'hook');
    assert.equal(end.outcome, 'succeeded');
    assert.equal(end.failures, 2);
    assert.equal(end.lastError, 'connection reset');
    scheduler.host.close();
  });

  test(`${datamodel}: a hanging worker is timed out and aborted, its late answer goes nowhere, the deadline expires the job`, async () => {
    const { calls, worker } = held();
    const { clock, scheduler } = setup({ peer: worker });
    scheduler.submit({ id: 'peer', kind: 'deadline', worker: 'peer', in: 0, within: 1000, timeout: 300, backoff: 50 });
    await advance(clock, scheduler, 300);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true, 'the timed-out attempt was aborted');
    await advance(clock, scheduler, 50);
    assert.equal(calls.length, 2);
    // the first attempt answers after all: it was aborted, and the chart
    // takes only the current attempt's answer
    calls[0].resolve('too late');
    await settle(scheduler);
    assert.deepEqual(await scheduler.state('peer'), { active: { running: 'attempting' } });
    await advance(clock, scheduler, 2000);
    const end = ended(scheduler, 'peer');
    assert.equal(end.outcome, 'expired');
    assert.equal(end.lastError, 'timed out after 300 ms');
    assert.equal(end.at, 1000);
    assert.ok(calls.every((call) => call.signal.aborted), 'the deadline aborted the attempt in flight');
    scheduler.host.close();
  });

  test(`${datamodel}: an answer that comes after its attempt timed out is not taken for the next one`, async () => {
    // a worker that ignores its signal and answers late
    const { calls, worker } = held();
    const { clock, scheduler } = setup({ slow: worker });
    scheduler.submit({ id: 'slow', kind: 'once', worker: 'slow', in: 0, timeout: 300, attempts: 2, backoff: 100 });
    await advance(clock, scheduler, 400);
    assert.equal(calls.length, 2);
    calls[0].resolve('late'); // its run was aborted: the scheduler does not answer
    await settle(scheduler);
    assert.equal(ended(scheduler, 'slow'), undefined);
    calls[1].resolve('ok');
    await settle(scheduler);
    assert.equal(ended(scheduler, 'slow').outcome, 'succeeded');
    assert.deepEqual(scheduler.unanswered.map((u) => [u.attempt, u.reason]), [[1, 'aborted']]);
    scheduler.host.close();
  });

  test(`${datamodel}: cancel aborts a running worker; reschedule moves a one-shot and changes an interval`, async () => {
    const { calls, worker } = held();
    const { clock, scheduler } = setup({ slow: worker, quick: () => 'ok' });
    scheduler.submit({ id: 'export', kind: 'once', worker: 'slow', in: 100, timeout: 10_000 });
    scheduler.submit({ id: 'report', kind: 'once', worker: 'quick', in: 5000 });
    scheduler.submit({ id: 'tick', kind: 'recurring', worker: 'quick', every: 1000, times: 4 });
    await advance(clock, scheduler, 100);
    assert.equal(scheduler.cancel('export'), true);
    assert.ok(scheduler.reschedule('report', { in: 400 }));
    await advance(clock, scheduler, 900); // t = 1000: tick's first run
    assert.ok(scheduler.reschedule('tick', { every: 250 }));
    await advance(clock, scheduler, 2000);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(ended(scheduler, 'export').outcome, 'cancelled');
    assert.equal(ended(scheduler, 'report').at, 500);
    assert.deepEqual(events(scheduler, 'tick', 'run.started').map((r) => r.startedAt), [1000, 1250, 1500, 1750],
      'a waiting job is due the new interval from the reschedule');
    assert.equal(scheduler.cancel('export'), false, 'a job that ended');
    calls[0].resolve('done anyway');
    await settle(scheduler);
    scheduler.host.close();
  });

  test(`${datamodel}: a tick while the last run still runs is skipped, not queued`, async () => {
    const { calls, worker } = held();
    const { clock, scheduler } = setup({ slow: worker });
    scheduler.submit({ id: 'sync', kind: 'recurring', worker: 'slow', every: 100, times: 5, timeout: 10_000 });
    await advance(clock, scheduler, 350);
    calls[0].resolve();
    await advance(clock, scheduler, 50); // t = 400: the next run
    calls[1].resolve();
    await advance(clock, scheduler, 1000);
    assert.deepEqual(events(scheduler, 'sync', 'run.started').map((r) => r.startedAt), [100, 400, 500]);
    assert.equal(events(scheduler, 'sync', 'skipped').length, 2);
    calls[2].resolve();
    await settle(scheduler);
    const end = ended(scheduler, 'sync');
    assert.deepEqual([end.outcome, end.runs, end.skipped], ['completed', 3, 2]);
    scheduler.host.close();
  });

  test(`${datamodel}: shutdown stops waiting jobs at once, lets a running one finish, retries nothing`, async () => {
    const { calls, worker } = held();
    const { clock, scheduler } = setup({ slow: worker, quick: () => 'ok' });
    scheduler.submit({ id: 'running', kind: 'deadline', worker: 'slow', in: 0, within: 60_000, timeout: 10_000 });
    scheduler.submit({ id: 'waiting', kind: 'recurring', worker: 'quick', every: 1000 });
    await advance(clock, scheduler, 10);
    const closing = scheduler.shutdown({ grace: 5000 });
    assert.throws(() => scheduler.submit({ kind: 'once', worker: 'quick' }), /shutting down/);
    await settle(scheduler);
    assert.equal(ended(scheduler, 'waiting').outcome, 'stopped');
    assert.equal(ended(scheduler, 'running'), undefined, 'still running');
    calls[0].reject(new Error('failed while draining'));
    const summary = await closing;
    assert.equal(ended(scheduler, 'running').outcome, 'stopped');
    assert.equal(calls.length, 1, 'no retry while draining');
    assert.deepEqual([summary.inTime, summary.left], [true, []]);
    assert.equal(scheduler.host.closed, true);
  });
}

// ---- the real clock -------------------------------------------------------

test('drift: a fixed-rate job keeps its cadence under load, a fixed-delay one falls behind', async () => {
  const busy = () => { const end = performance.now() + 12; while (performance.now() < end); };
  const scheduler = new Scheduler({ workers: { quick: () => 'ok', busy } });
  scheduler.submit({ id: 'rate', kind: 'recurring', worker: 'quick', every: 20, times: 25, cadence: 'fixed-rate' });
  scheduler.submit({ id: 'delay', kind: 'recurring', worker: 'quick', every: 20, times: 25, cadence: 'fixed-delay' });
  scheduler.submit({ id: 'busy', kind: 'recurring', worker: 'busy', every: 17, times: 30, cadence: 'fixed-delay' });
  await scheduler.settled();
  const rate = lateness(scheduler.records, 'rate');
  const delay = lateness(scheduler.records, 'delay');
  // Relative, not absolute: under a loaded machine (the whole test suite
  // beside it) every run is later, and a tick that comes while the last run
  // is still going is skipped, so neither the lateness nor the count of runs
  // is fixed. What holds is that every tick ran or was skipped, and that the
  // fixed-delay job falls behind while the fixed-rate one does not.
  const label = `fixed-rate ${rate.runs} runs, last ${rate.last} ms late (mean ${rate.mean}); ` +
    `fixed-delay ${delay.runs} runs, last ${delay.last} ms late (mean ${delay.mean})`;
  assert.equal(rate.runs + events(scheduler, 'rate', 'skipped').length, 25, label);
  assert.ok(delay.last > delay.first, `fixed-delay falls behind: ${label}`);
  assert.ok(delay.mean > rate.mean, `fixed-delay is later than fixed-rate: ${label}`);
  assert.ok(delay.last > rate.last, `fixed-delay is later than fixed-rate: ${label}`);
  scheduler.host.close();
});

test('idle(): waits for a running worker but not for a deadline; rejects with a handler\'s error, and on a closed host', async () => {
  let finish;
  const scheduler = new Scheduler({
    workers: { slow: () => new Promise((resolve) => { finish = resolve; }), quick: () => 'ok' },
    onReport: (record) => { if (record.event === 'ended' && record.job === 'bad') throw new Error('the alert hook failed'); },
  });
  scheduler.submit({ id: 'later', kind: 'once', worker: 'quick', in: 60_000 });
  scheduler.submit({ id: 'slow', kind: 'once', worker: 'slow', in: 0, timeout: 60_000 });
  let idle = false;
  const waited = scheduler.host.idle().then(() => { idle = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(typeof finish, 'function', 'the worker is running');
  assert.equal(idle, false, 'idle() waits for the worker the run handler returned');
  finish('done');
  await waited;
  assert.equal(ended(scheduler, 'slow').outcome, 'succeeded');
  assert.ok(scheduler.host.nextDeadline > 50_000, 'the delayed send is pending: idle() did not wait for it');
  // a handler's error rejects the idle() waiting, and the host goes on
  scheduler.submit({ id: 'bad', kind: 'once', worker: 'quick', in: 0 });
  await assert.rejects(scheduler.host.idle(), /the alert hook failed/);
  // an idle() that waits when the host closes rejects (shutdown's
  // idleAtClose), and so does one asked of a closed host
  const waiting = scheduler.host.idle();
  scheduler.host.close();
  await assert.rejects(waiting, (error) => error.status === 'TA_ERROR_STATE');
  await assert.rejects(scheduler.host.idle(), (error) => error.status === 'TA_ERROR_STATE');
});

// ---- processes ------------------------------------------------------------

/** Runs `args` under this runtime from the package's directory. */
function child(args, options = {}) {
  return spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/** The records a child printed (`--json`), and its exit. */
function collect(proc) {
  const records = [];
  let stderr = '';
  let buffered = '';
  const listeners = [];
  proc.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffered += chunk;
    for (let n; (n = buffered.indexOf('\n')) >= 0;) {
      records.push(JSON.parse(buffered.slice(0, n)));
      buffered = buffered.slice(n + 1);
      for (const listener of listeners) listener();
    }
  });
  proc.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal, stderr })));
  const until = (predicate) => new Promise((resolve) => {
    const check = () => { if (records.some(predicate)) resolve(); };
    listeners.push(check);
    check();
  });
  return { records, exit, until };
}

test('a process exits by itself when its last job ends, with its host still open', async () => {
  const started = Date.now();
  const { records, exit } = collect(child([MAIN, '--json']));
  const { code } = await exit;
  assert.equal(code, 0);
  const idle = records.find((r) => r.event === 'idle');
  assert.deepEqual([idle.jobs, idle.deadline, idle.closed], [0, null, false]);
  const outcomes = Object.fromEntries(records.filter((r) => r.event === 'ended').map((r) => [r.job, r.outcome]));
  assert.deepEqual(outcomes, {
    cleanup: 'cancelled', webhook: 'succeeded', report: 'succeeded', refresh: 'completed', export: 'succeeded', peer: 'expired',
  });
  assert.ok(Date.now() - started < 10_000);
});

test('SIGTERM: a graceful shutdown, what is dropped at close, and a clean exit', async () => {
  const proc = child([MAIN, '--serve', '--json', '--grace', '300']);
  const { records, exit, until } = collect(proc);
  // alive for as long as jobs are scheduled
  await until((r) => r.event === 'run.ok' && r.job === 'refresh' && r.run >= 4);
  assert.equal(proc.exitCode, null);
  proc.kill('SIGTERM');
  const { code, signal } = await exit;
  assert.deepEqual([code, signal], [0, null]);
  const find = (event) => records.find((r) => r.event === event);
  assert.match(find('refused').message, /shutting down/);
  const outcomes = Object.fromEntries(records.filter((r) => r.event === 'ended').map((r) => [r.job, r.outcome]));
  assert.deepEqual(outcomes, { refresh: 'stopped', nightly: 'stopped', export: 'stopped' });
  const closed = find('closed');
  assert.equal(closed.inTime, false);
  assert.deepEqual(closed.left.sort(), ['batch', 'stuck']);
  assert.ok(closed.deadlineAtClose > 50_000, 'the hanging attempt\'s timeout was pending at close');
  assert.equal(closed.deadlineAfterClose, undefined);
  assert.equal(closed.idleAtClose, 'TA_ERROR_STATE');
  const last = find('exit');
  assert.equal(last.stateAtClose, 'pending', 'a typed method pending at close never settles');
  assert.deepEqual(last.unanswered.map((u) => [u.job, u.reason]), [['batch', 'closed']],
    'a worker that finished after close found a closed host');
});

test('a handler\'s error with no idle() waiting is an uncaught exception that ends the process', () => {
  const code = `
    import { Scheduler } from './examples/job-scheduler/scheduler.mjs';
    const scheduler = new Scheduler({
      workers: { quick: () => 'ok' },
      onReport: (record) => { if (record.event === 'ended') throw new Error('the alert hook failed'); },
    });
    scheduler.submit({ kind: 'once', worker: 'quick', in: 10 });
    scheduler.submit({ kind: 'once', worker: 'quick', in: 60_000 });
  `;
  const args = process.versions.bun ? ['-e', code] : ['--input-type=module', '-e', code];
  const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /the alert hook failed/);
});
