# ADR 0025: A quarantined child tells its parent

**Status:** Accepted and implemented; see the implementation notes. Refines ADR 0008 point 1 and ADR 0021 point 6: a quarantined invoked child is no longer silent to its parent. Needs core ADR 0081.
**Date:** 2026-09-26

## Context

ADR 0021 point 6 says a child that faults or is quarantined is an ordinary
faulted actor, and its parent is not told. A parent that waits in its
invoking state for `done.invoke.<id>` therefore waits forever, unless its
author added a timeout.

The following quarantine an actor (ADR 0008):

- A runaway macrostep (core ADR 0075). This is the only one a correct
  chart can cause.
- A delivered event that core refused.
- A scheduling queue that could not grow.
- An internal failure in core.

Errors inside a chart, such as a bad expression, a `<script>` that throws
or an unknown send target, are `error.*` events in the child itself.
They do not quarantine it.

**What the standard says.** SCXML 6.4.3 names two ways an invoked session
ends:

- It reaches a top-level final state, and the parent gets
  `done.invoke.<id>`.
- The parent cancels it, and the parent gets no event.

It says nothing about abnormal termination. SCXML 3.12.2 reserves
extensions of defined error names for platforms. It says
`error.communication` covers errors "arising from `<send>` and
`<invoke>`". We already use this for a lost invocation:
`error.communication.invoke.<id>.unavailable` (core ADR 0038, ADR 0021
point 6).

**Quarantine is not death.** `system.release()` lets the child continue.
A runaway finishes its macrostep, and may still reach its final state.
So the report cannot mean "the child is finished".

## Decision

**When napi quarantines an invoked child, its parent gets
`error.communication.invoke.<id>.quarantined` on its internal queue. The
child stays quarantined, and the invocation stays active.**

1. **What the parent sees.** The error event's `data` is
   `{ code, message }`, the same `code` and `message` the `fault` hook
   receives (for example `runaway`). A parent that has no transition for
   the event ignores it (SCXML 3.12.2), and loses nothing.
2. **What the parent can do:**
   - Leave the invoking state. The child is cancelled and destroyed, as
     today (ADR 0021 point 6).
   - Stay and wait. If an operator releases the child and it reaches its
     final state, `done.invoke.<id>` still arrives, and events from the
     child still arrive.
3. **Each quarantine is reported once.** A child that is released and
   quarantined again reports again. Release itself sends nothing.
4. **Only the direct parent is told.** Every cause of quarantine in the
   list above is reported. An actor with no parent (not invoked) behaves
   as before.
5. **When the parent is gone.** If the parent is gone, or the invocation
   has already been cancelled, core answers `TA_ERR_NOT_FOUND` and napi
   drops the report. The quarantine itself is unchanged: the fault hook,
   the failure log and the quarantine gauge.
6. **Mechanism.** napi calls `ta_actor_report_invoke()` with
   `TA_INVOKE_REPORT_ERROR`, reason `quarantined`, and `ends` false (core
   ADR 0081), under the trace parent of the macrostep that faulted. The
   scheduler makes an idle parent runnable, as for any other report. The
   report is made after the child's fault is recorded, outside any core
   call. If the report fails for lack of memory, it is retried as the
   scheduler retries other work. It must not be lost.

## Alternatives

- **Keep the silence (A).** This conforms to the standard. But a parent
  cannot tell a slow child from a stuck one without a timeout, and every
  author would have to write that timeout.
- **Treat quarantine of a child as its end (C).** The host would destroy
  the child and report `ends` true. That takes `release()` away from
  children, and after a runaway, `release()` is the operator's main tool.
- **`error.platform.quarantined`.** `error.communication.invoke.<id>.*`
  names the invocation, so a parent with several children knows which one
  faulted. It also matches the `.unavailable` report.

## Consequences

- `docs/scxml.md` and ADR 0021 point 6 no longer say the parent is not
  told. `docs/scxml.md` documents the event and its data.
- An author who wants a child's fault to end the parent's wait writes one
  transition on `error.communication.invoke.<id>.quarantined`.

## Testing

- **JavaScript, on Node and Bun:**
  - A runaway child's parent takes a transition on
    `error.communication.invoke.<id>.quarantined`, whose data has `code`
    `runaway`.
  - A parent that stays, then `release()` of the child, then the child
    finishes: the parent gets `done.invoke.<id>`.
  - A parent that leaves: the child is destroyed.
  - A second quarantine after release reports again.
  - A parent destroyed before its child faults: nothing is reported, and
    nothing crashes.
  - A nested child: only its direct parent is told.
- **tinyactors-test:** scenarios for core ADR 0081's report through the
  test host: `ends` false to an idle parent and to a paused parent,
  followed by `done.invoke`.
- **The out-of-memory sweep** covers the report, so a failed allocation
  delays the report but never loses it.

## Implementation notes

Implemented 2026-09-26.

- **Where:** in the portable plumbing (`src/system.c`), not in the pump.
  Right after the scheduler's part of a turn, `tna_system_turn()` walks the
  turn's fault records. For each child it inspects, a report is made while
  the child still stands where it faulted: `has_parent`, `parent` and
  `trace` from `ta_actor_inspect()`, the core addition in core ADR 0081's
  notes. This covers every cause of quarantine, because every quarantine
  writes a fault record.
- **Data:** `{ code, message }` comes from a callback the Node-API layer
  installs (`quarantine_data`, as `unreachable_data` does for ADR 0022).
  It uses `tna_fault_message()` from `src/pump.c`, the formatter the
  `fault` hook uses, so the texts cannot drift apart. Without the
  callback, as in the native tests' own systems, the event has no data.
- **Retry:** a report whose data or core call runs out of memory, or whose
  parent cannot be put on the runnable queue, waits in
  `system->quarantine_reports`. The system is not quiet while one waits,
  so the next turn tries again. A report that core has taken but whose
  parent could not be scheduled keeps only the scheduling step. If even
  queueing the report fails, it is lost, and the fault hook, the failure
  log and the gauge still show the quarantine.
- **Dropped:** `TA_ERR_NOT_FOUND` from core (the parent or its invocation
  is gone) ends the report.
- **Deviation from the Testing section:** the JavaScript suite does not
  include the out-of-memory case. `refuseAllocationsFrom()` refuses by
  size, and no threshold separated the report's allocations from the
  child's and the turn's reliably. `test/native/quarantine_test.c` covers
  it instead: data that fails twice, then the report arriving, with the
  system busy until then; and a parent destroyed while its report waits.
  Core's side of an out-of-memory report is covered by tinyactors-test's
  sweep (core ADR 0081).
- **Tests on Node and Bun (`test/quarantine.js`):**
  - the parent is told, with the fault hook's code and message, and keeps
    waiting;
  - the report's macrostep is in the child's trace, and its parent span
    is the child's step at the limit;
  - release, then a second runaway, reports again, and after a second
    release `done.invoke` arrives;
  - leaving the invoking state destroys the quarantined child;
  - a parent destroyed from the fault hook;
  - a grandchild reports to its own parent only.
