# Job scheduler

A scheduler of background jobs whose jobs are actors. A job is recurring
(every N ms, a number of times or for ever), a one-shot at a time, or a
one-shot with a deadline by which it must have succeeded. Each run of a
job is one or more attempts of a worker function, and workers misbehave
the way real ones do:

- **A worker that throws** fails its attempt. The error's message reaches
  the job's chart, which retries after an exponential backoff (doubled
  after each failure, capped) up to the job's number of attempts.
- **A worker that hangs** is given up on after the attempt's timeout. The
  chart asks for the worker to be aborted (it gets an `AbortSignal`), and
  retries. An answer that comes after its attempt timed out goes nowhere:
  the chart takes only the answer of its current attempt.
- **A deadline** ends the job as `expired`, whatever attempt is running or
  waiting, and aborts the worker in flight.
- **A slow recurring run** does not push the schedule back: the next tick
  is armed when the run starts, and a tick that comes while the last run
  still runs is skipped, not queued.
- **Cancel and reschedule** are events: a cancel ends a job and aborts its
  worker; a reschedule moves a waiting one-shot or changes a recurring
  job's interval.

The process stays alive while jobs are scheduled and exits by itself when
the last one ends. On SIGINT or SIGTERM it shuts down gracefully: it takes
no new jobs, stops the waiting ones, lets the running ones finish their
attempt or time out within a grace period, then closes the host and exits.

## What is where

| File | What it holds |
|---|---|
| [`charts/job.scxml`](charts/job.scxml) | the job: its schedule, attempts, timeouts, retries, deadline, cancel, reschedule and drain |
| [`scheduler.mjs`](scheduler.mjs) | the application: the host, the I/O processors that run workers and tell the time, the record of what happened, the shutdown |
| [`main.mjs`](main.mjs) | a batch that exits by itself, a server that runs until a signal (`--serve`), and the drift comparison (`--drift`) |
| [`test.mjs`](test.mjs) | the chart's rules on a `SimulatedClock` on both datamodels; cadence and `idle()` on the real clock; liveness and shutdown in child processes |

## The tinyactors features it uses, and why

- **Delayed sends and `<cancel>`** are the whole schedule: the next tick
  (`due`), an attempt's timeout, the backoff before a retry and the
  deadline are each a `<send delayexpr>` with an id, cancelled in the
  `<onexit>` of the state that armed it, so whichever way a state is left
  (an answer, a cancel, the deadline, a shutdown), nothing of it fires
  later.
- **An async I/O processor** (`urn:jobs:run`) runs the workers. Its handler
  is `async`, so its `send` is filled before the host moves on and
  `send.answer()` works after the worker's `await`. A worker's error is
  caught and answered as `result.failed` with its message, so it reaches
  the chart as an event. The same processor takes the chart's `abort`
  requests.
- **`idlocation`** gives each attempt's send its own id, and the answer
  carries it back as `_event.sendid`: the chart compares it with the
  current attempt's, which is how a late answer is told from a current one.
  A generated id is unique in its session only (`send.1` in every
  session), so the scheduler keys its running workers by session and id.
- **An I/O processor as the chart's clock** (`urn:jobs:clock`): a chart
  cannot read the time, so a fixed-rate job asks the application before
  arming each tick and arms it at an absolute time of its schedule. A
  fixed-delay job arms each tick `interval` after the last one ran, and
  drifts.
- **A final state's `<onentry>`** reports the job's end to `urn:jobs:report`,
  which is how the application learns that an actor ended.
- **Named actors and spawn params**: a job's actor is named by its id and
  given its schedule at spawn.
- **`host.idle()`, `host.nextDeadline`, `host.close()`** for liveness and
  shutdown, and the typed method `actorState` for a job's state.
- **A `SimulatedClock`** in the test: retries, timeouts, deadlines and
  skipped ticks over seconds of schedule take a few milliseconds, stepping
  from deadline to deadline.
- **Both datamodels**: the chart's rules run on the native datamodel and on
  quickjs.

## Liveness

- **An open host keeps the process alive only through its timer**, which
  it arms at its next deadline. While any job is scheduled there is one, so
  the process stays; once the last job ends there is none, and the process
  exits with the host still open (`main.mjs` closes it in `beforeExit`).
- **A worker's pending promise keeps nothing alive.** A worker that hangs
  on a promise with no I/O behind it does not hold the process open; the
  attempt's timeout, a delayed send, is what does, until it fires.
- **`await host.idle()`** resolves at the next turn with nothing to do: it
  does not wait for delayed sends that are not yet due; it waits for the
  workers' promises, which the run handler returns. The tests that hold a
  worker to look at the host meanwhile let turns run with `setImmediate`
  instead. An `idle()` that is waiting when the host closes rejects with
  `TA_ERROR_STATE`, and so does one asked of a closed host.

## The shutdown, and what close() drops

`scheduler.shutdown({ grace })` stops accepting jobs and sends `drain` to
every job: a waiting job ends `stopped` at once, a running one ends after
its current attempt (no retry, no next tick). After `grace` ms it closes
the host whatever is left, and reports what that was. In `--serve`, a job
whose worker hangs with a 60-second timeout and a job whose worker ignores
its signal are still running at the close:

- **their delayed sends are dropped**: `nextDeadline` reads the pending
  timeout before `close()` and `undefined` after, and the host's timer is
  cleared, so it holds the process no longer;
- **a typed method pending at the close never settles** (the promise of
  `actorState`) and keeps nothing alive;
- **an `idle()` waiting at the close rejects** with `TA_ERROR_STATE`;
- **a worker that finishes after the close** finds a closed host
  (`send.answer()` would throw `TA_ERROR_STATE`), which the scheduler
  records, as it records an answer that `send.answer()` could not deliver
  (`false`: the job ended while its worker ran);
- the process exits on its own once the stubborn worker's own timer has
  fired, with no `process.exit()`.

## Errors

A worker's error is the application's to catch: the scheduler answers it
to the chart as `result.failed`. An error thrown by a handler and not
caught (here, the `onReport` hook the application gives the scheduler) is
reported after the turn as the README says: it rejects a waiting
`idle()`; with none waiting it is an uncaught exception, which ends the
process (the test runs that in a child and sees the exit code).

## Drift

`main.mjs --drift` runs a fixed-rate and a fixed-delay job every 20 ms, 40
times, alone and beside a CPU-bound job that blocks the event loop for 12
ms every 17 ms. One run on this machine (node 22, x86_64 Linux):

```output
alone                fixed-rate   40 runs every 20 ms: the last started 1.2 ms late (mean 0.7, max 4.8)
alone                fixed-delay  40 runs every 20 ms: the last started 24.1 ms late (mean 13.4, max 24.1)
with a CPU-bound job  fixed-rate   40 runs every 20 ms: the last started 7.3 ms late (mean 4.0, max 12.3)
with a CPU-bound job  fixed-delay  40 runs every 20 ms: the last started 136.5 ms late (mean 86.3, max 136.5)
```

A chained delayed send counts its delay from the step that armed it,
which runs late by the timer's and the turn's latency, so a fixed-delay
job falls behind by that much every tick (about 0.6 ms alone, 3.5 ms
under load). The fixed-rate job is late by the latency of one tick only.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/job-scheduler/main.mjs            # or bun; exits by itself after about 0.3 s
node examples/job-scheduler/main.mjs --serve    # Ctrl-C for the graceful shutdown
node examples/job-scheduler/main.mjs --drift
```

`--json` prints one JSON record per line, `--grace MS` sets the shutdown's
grace (default 500).

## Test it

```sh
mise run examples job-scheduler     # under node and bun
node examples/job-scheduler/test.mjs
bun test ./examples/job-scheduler/test.mjs
```

It takes about three seconds: the chart's rules on a `SimulatedClock`,
the drift comparison and `idle()` on the real clock with intervals of
20 ms, and three child processes (the batch exiting by itself, the server
shut down by SIGTERM, and an uncaught handler error ending a process).
