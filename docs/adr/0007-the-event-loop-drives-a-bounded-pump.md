# ADR 0007: The event loop drives a bounded pump

**Status:** Accepted; turns yield to I/O and the clock is read every turn (amended)
**Date:** 2026-09-23

## Context

The first addon ran work only inside `flush()`. That function drained all
queues to quiescence synchronously and then returned a promise that was
already settled. Per-turn budgets did not bound the total work, so draining
four million actors blocked the event loop for the whole drain. Nothing ran
unless someone called `flush()`, and delayed sends never fired.

## Decision

1. **One pump turn does bounded work, in this order:**
   1. with `clock: "realtime"`, read the monotonic clock and call
      `ta_system_set_time()`;
   2. resume up to `resumesPerTurn` runnable actors, among those queued
      before the turn began. Each resume passes `resumeBudget` as core's
      microstep `budget` and `actionBudget` as core's `action_budget`
      (tinyactors-core ADR 0061), so a microstep that runs a long script
      or `<foreach>` pauses inside its executable content instead of
      running to its end in one turn;
   3. deliver from the ready queue, up to `messageBudget`;
   4. call `ta_system_dispatch_due()` with `dueBudget`;
   5. call the hooks for the turn's records (point 5), then reset the turn
      arena (ADR 0014).

   Handles made by data-model callbacks (ADR 0011) must not pile up until
   the end of the turn. The scheduler has no Node-API in it (so native tests
   and sanitizers cover it), so it opens no scope around a resume; instead
   each data-model callback opens its own `napi_handle_scope` (step 11).
   No JavaScript runs inside a resume before then.
2. **The pump is native. Turns are scheduled with the global
   `setImmediate`.** The system creates one native function for the turn,
   and calls `setImmediate` with it from native code.
   - Enqueueing work schedules a turn if none is pending. A flag in the
     system coalesces further requests.
   - At the end of a turn, the next turn is scheduled if work remains.
   - `setImmediate` callbacks run after the event loop has polled for I/O.
     So between two turns, socket reads, timers and other callbacks run, and
     a busy system cannot starve websocket traffic. At most one turn runs
     per event-loop iteration.
   - A pending immediate keeps the process alive, and nothing else does.
     Queued work, and a script ending in `await system.flush()`, therefore
     run to completion, while an idle system does not keep the process
     alive.
   - No JavaScript file takes part in scheduling, and actor data never goes
     through the scheduling call.
   - An earlier version of this ADR used a `napi_threadsafe_function`. It
     is not used now. Node's dispatch loop (`ThreadSafeFunction::Dispatch`
     in `src/node_api.cc`) runs up to 1,000 calls in one wake-up, and it
     also runs a call that was queued from inside the current one. A turn
     that scheduled the next turn would therefore run up to 1,000 turns
     with no I/O in between.
3. **Time.** After each turn, the addon reads `ta_system_next_deadline()`
   and keeps exactly one timer.
   - The timer is re-armed only when the new deadline is earlier than the
     armed one. A later deadline leaves the timer in place. It fires early,
     finds nothing due, and is armed again for the deadline then current.
     With millions of actors that re-arm idle timeouts, the earliest
     deadline changes almost every turn, and this keeps timer calls rare.
   - The timer is created from native code with the global `setTimeout`
     and cancelled with `clearTimeout`. Both runtimes provide them. The
     handle is unreferenced by calling its `unref` method.
   - Node-API has no timer of its own, and `napi_get_uv_event_loop` would
     tie the addon to libuv.
   - With `clock: "realtime"`, time comes from a monotonic clock read
     natively (for example `clock_gettime(CLOCK_MONOTONIC)`), relative to
     system creation. It is set at the start of every turn (point 1) and
     when the timer fires, which then wakes the pump.
   - Setting the time only when the timer fires is wrong. Core computes a
     delayed send's due time from the system time (`due = now + delay`).
     After an idle period with no timer armed, that time is old, so a
     30-second timeout armed by the first new message would already be due.
   - With `clock: "manual"`, there is no timer. `advanceTo()` and
     `advanceBy()` set the time and return a promise that settles once
     everything due has been dispatched and the system is quiet.
   - `clock: "realtime"` is the default. A pending timer holds the native
     System, like a pending turn. When `close()` runs in a finalizer, where
     no JavaScript can run, the timer is left pending and its callback
     drops the hold.
   - Due sends are dispatched at the end of the turn, at most `dueBudget`
     of them (default 1024). They go through the router into mailboxes, so
     the events they carry are delivered in a later turn.
4. **`flush()` resolves when the system is quiet**: no runnable actors, no
   ready actors, and nothing due at the current time. It spans as many
   turns as needed and yields to the event loop between them. Several
   `flush()` calls share one waiter list. The waiters are native promises
   (`napi_create_promise`), settled at the end of the turn that reaches
   quiescence.
5. **Hooks are called from native code.** The `done`, `fault` and
   `deadLetter` functions (ADRs 0008 and 0012) are passed in the system
   options and held as references by the system. The pump calls them at
   the end of a turn, after the last core call, so no hook runs while core
   is running. Service effects follow the hooks the same way (ROADMAP step
   13): core's calls into the log sink, I/O processors and invokers are
   queued natively (`src/effects.h`) and handed to JavaScript after the
   hooks, in the order core made them. Waiting effects keep the system from
   being quiet.
6. **Nothing runs synchronously in API calls.** `post`, `spawn` and the
   others only enqueue. Bootstrapping a spawned actor is runnable work like
   any other.

## Consequences

- A delayed send due later does not hold `flush()`, and its timer does not
  hold the process. A script that must see a delayed send fire keeps the
  process alive itself (a server does anyway), or uses the manual clock.

- Any single turn is bounded by the budgets, and other JavaScript runs
  between turns.
- The event loop is the only scheduler. There is no libuv or V8-specific
  API, so the same code runs on Node and Bun.
- Tests that need determinism use the manual clock and `await flush()`.
- All scheduling state (queues, the pending-turn flag, the timer handle,
  waiters and hooks) lives in the native `System`. `close()` releases it in
  one place (ADR 0012).
- The pump depends on both runtimes running `setImmediate` callbacks
  after I/O and never inline. Tests on each runtime check that no turn runs
  inside the API call that enqueued the work, and that an I/O or timer
  callback runs between two consecutive turns of a busy system.
- Starting a turn costs one JavaScript call to `setImmediate`, and one
  `Immediate` object, per turn, not per message.
