// The application: a job scheduler whose jobs are actors of
// charts/job.scxml. The chart decides when a job runs, how long an attempt
// may take, when to retry and when the job is over; this file runs the
// workers, keeps the time and the record of what happened, and shuts down.
//
// The chart's three I/O processors are served here:
//   urn:jobs:run     an attempt: runs the job's worker, answers result.ok or
//                    result.failed; event "abort" aborts an attempt's worker
//   urn:jobs:clock   the application's time, for a fixed-rate schedule
//   urn:jobs:report  what happened: run.ok, attempt.failed, skipped, ended
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Host, TinyactorsError } from '@tinyactors/node';

const CHART = readFileSync(new URL('charts/job.scxml', import.meta.url), 'utf8');


export class Scheduler {
  /**
   * @param {object} options
   * @param {{ [name: string]: (context) => unknown }} options.workers the
   *   worker functions a job may name; each gets `{ job, payload, run,
   *   attempt, signal }` and returns a value or a promise
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {(record) => void} [options.onReport] called with every record
   *   of what happened; its error is a handler's error (README, "Errors")
   */
  constructor({ workers, clock, datamodel, onReport } = {}) {
    this.workers = workers ?? {};
    this.clock = clock;
    this.onReport = onReport;
    this.accepting = true;
    /** id → { id, session, spec, ended: Promise, end } */
    this.jobs = new Map();
    /** Every record: run.ok, attempt.failed, skipped, ended, and a run's start. */
    this.records = [];
    /** The attempts whose worker is running, by `session:sendid` (a
     * generated sendid is unique in its session only: docs/log.xml,
     * l-p4-examples-jobs-sendid) → { job, controller, worker }. */
    this.inFlight = new Map();
    /** Answers that found nobody, by status: what happens to a worker that
     * finishes after its job ended or after close(). */
    this.unanswered = [];
    this.sequence = 0;
    this.origin = performance.now();

    this.host = new Host(
      {
        systemID: 'jobs',
        ioProcessors: [{ type: 'urn:jobs:run' }, { type: 'urn:jobs:clock' }, { type: 'urn:jobs:report' }],
      },
      {
        clock,
        datamodel,
        ioProcessors: {
          'urn:jobs:run': (host, send) => (send.event === 'abort' ? this.#abort(send.session, send.data.runID) : this.#run(send)),
          'urn:jobs:clock': (host, send) => send.answer('clock', { now: this.now() }),
          'urn:jobs:report': (host, send) => this.#report({ event: send.event, ...send.data }),
        },
      },
    );
    this.host.addCharts({ 'job.scxml': CHART });
  }

  /** The application's clock in milliseconds: the simulated clock's, or
   * the runtime's since the scheduler was made. The chart has none of its
   * own, so every absolute time it holds is of this clock. */
  now() {
    return this.clock ? this.clock.now : performance.now() - this.origin;
  }

  /**
   * Submits a job and returns its id.
   * @param {object} spec
   * @param {'recurring' | 'once' | 'deadline'} spec.kind
   * @param {string} spec.worker the name of a worker
   * @param {number} [spec.every] recurring: the interval in ms
   * @param {number} [spec.times] recurring: how many runs (0: for ever)
   * @param {'fixed-rate' | 'fixed-delay'} [spec.cadence]
   * @param {number} [spec.in] once, deadline: ms from now
   * @param {number} [spec.at] once, deadline: an absolute time of `now()`
   * @param {number} [spec.within] deadline: ms from now by which it must succeed
   * @param {number} [spec.timeout] ms an attempt may take
   * @param {number} [spec.attempts] attempts per run
   * @param {number} [spec.backoff] ms before the first retry, doubled after each
   */
  submit(spec) {
    if (!this.accepting) throw new Error('the scheduler is shutting down and takes no new jobs');
    if (!(spec.worker in this.workers)) throw new TypeError(`no worker named ${spec.worker}`);
    const id = spec.id ?? `job-${++this.sequence}`;
    if (this.jobs.has(id)) throw new Error(`a job ${id} exists`);
    const now = this.now();
    const params = {
      id,
      kind: spec.kind ?? 'once',
      worker: spec.worker,
      payload: spec.payload ?? null,
      start: now,
      at: spec.at ?? now + (spec.in ?? 0),
      deadline: spec.within === undefined ? null : now + spec.within,
      interval: spec.every ?? 1000,
      limit: spec.times ?? 0,
      cadence: spec.cadence ?? 'fixed-rate',
      timeout: spec.timeout ?? 1000,
      maxAttempts: spec.attempts ?? (spec.kind === 'deadline' ? 5 : 1),
      backoff: spec.backoff ?? 100,
      backoffMax: spec.backoffMax ?? 10_000,
    };
    let end;
    const ended = new Promise((resolve) => { end = resolve; });
    const session = this.host.spawnChart('job', { name: id, params });
    this.jobs.set(id, { id, session, spec: params, ended, end });
    return id;
  }

  /** Cancels a job; false when it has ended already. */
  cancel(id) {
    return this.#tell(id, 'cancel');
  }

  /** Changes a recurring job's interval (`{ every }`) or moves a waiting
   * one-shot (`{ in }` or `{ at }`); false when the job has ended. */
  reschedule(id, change) {
    const now = this.now();
    const data = change.every !== undefined
      ? { interval: change.every, now }
      : { at: change.at ?? now + change.in, now };
    return this.#tell(id, 'reschedule', data);
  }

  /** The promise of a job's end record. */
  ended(id) {
    return this.jobs.get(id)?.ended ?? Promise.resolve(this.records.findLast((r) => r.event === 'ended' && r.job === id));
  }

  /** The promise that every job submitted so far has ended. */
  settled() {
    return Promise.all([...this.jobs.values()].map((job) => job.ended));
  }

  /** The job's active state, read with the typed method. */
  async state(id) {
    const job = this.jobs.get(id);
    if (job === undefined) return 'ended';
    return (await this.host.actorState({ session: job.session })).value;
  }

  /**
   * The graceful shutdown: no new jobs; every job told to drain (a waiting
   * one stops at once, a running one after its current attempt, which its
   * timeout bounds); `grace` ms for them to end; then `close()`. Answers
   * what was left at the close.
   */
  async shutdown({ grace = 2000 } = {}) {
    this.accepting = false;
    for (const id of [...this.jobs.keys()]) this.#tell(id, 'drain');
    let timer;
    const inTime = await Promise.race([
      this.settled().then(() => true),
      new Promise((resolve) => { timer = setTimeout(resolve, grace, false); }),
    ]);
    clearTimeout(timer);
    const left = [...this.jobs.keys()];
    const deadlineAtClose = this.host.nextDeadline;
    // A typed method still pending at close is dropped: its promise never
    // settles, and it keeps nothing alive.
    let stateAtClose = 'pending';
    if (left.length > 0) {
      this.state(left[0]).then((value) => { stateAtClose = value; }, (error) => { stateAtClose = error.status; });
    }
    const idleAtClose = this.host.idle().then(() => 'resolved', (error) => error.status);
    this.host.close();
    return {
      inTime,
      left,
      inFlight: [...this.inFlight.values()].map((run) => run.job),
      deadlineAtClose,
      deadlineAfterClose: this.host.nextDeadline,
      idleAtClose: await idleAtClose,
      stateAtClose: () => stateAtClose,
    };
  }

  #tell(id, event, data) {
    const job = this.jobs.get(id);
    if (job === undefined) return false;
    try {
      this.host.send(job.session, event, data);
      return true;
    } catch (error) {
      // the actor ended between its last report and this call
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_STALE') return false;
      throw error;
    }
  }

  /** An attempt. The handler is async, so its send keeps every field after
   * the await; the chart's attempt timeout bounds it, and a worker that
   * finishes after the job ended or after close() finds nobody to answer. */
  async #run(send) {
    const { job, worker: name, payload, run, attempt, due } = send.data;
    const controller = new AbortController();
    const startedAt = this.now();
    const key = `${send.session}:${send.sendid}`;
    this.inFlight.set(key, { job, controller, worker: name });
    this.#record({ event: 'run.started', job, run, attempt, due, startedAt, lateness: startedAt - due });
    let event;
    let data;
    try {
      const result = await this.workers[name]({ job, payload, run, attempt, signal: controller.signal });
      event = 'result.ok';
      data = { ms: this.now() - startedAt, result: result ?? null };
    } catch (error) {
      // the worker's error reaches the chart as an event, with its message
      event = 'result.failed';
      data = { message: String(error?.message ?? error) };
    }
    const aborted = controller.signal.aborted;
    this.inFlight.delete(key);
    if (aborted) {
      this.unanswered.push({ job, run, attempt, reason: 'aborted', event });
      return;
    }
    // nobody is left to take it: the host closed (answer() would throw
    // TA_ERROR_STATE), or the job ended while its worker ran (cancelled,
    // expired: answer() gives false)
    if (this.host.closed) this.unanswered.push({ job, run, attempt, reason: 'closed', event });
    else if (!send.answer(event, data)) this.unanswered.push({ job, run, attempt, reason: 'ended', event });
  }

  #abort(session, runID) {
    const key = `${session}:${runID}`;
    const run = this.inFlight.get(key);
    if (run === undefined) return;
    this.inFlight.delete(key);
    run.controller.abort(new Error('the attempt was given up'));
  }

  #report(record) {
    this.#record(record);
    if (record.event === 'ended') {
      const job = this.jobs.get(record.job);
      this.jobs.delete(record.job);
      job?.end(record);
    }
  }

  #record(record) {
    record.at = this.now();
    this.records.push(record);
    this.onReport?.(record);
  }
}

/** The lateness of a job's runs, from its run.started records: how far
 * after its scheduled time each started. */
export function lateness(records, job) {
  const runs = records.filter((r) => r.event === 'run.started' && r.job === job && r.attempt === 1);
  const values = runs.map((r) => r.lateness);
  return {
    runs: runs.length,
    first: values[0],
    last: values.at(-1),
    max: Math.max(...values),
    mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
  };
}
