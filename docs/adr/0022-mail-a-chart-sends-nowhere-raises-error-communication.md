# ADR 0022: Mail a chart sends nowhere raises `error.communication`

**Status:** Accepted and implemented. Refines ADR 0006 point 4 and ADR 0008 point 1: mail a chart sends to a target that does not exist is no longer a dead letter.
**Date:** 2026-09-25

## Context

ADR 0006 accepted every delivery core hands the router, and turned mail
for a target with no actor into a dead letter (ADR 0008), with a reason
such as `not-found`. That was one uniform rule, and the host saw every
lost message.

SCXML 6.2.4 says otherwise for mail a chart sends: when the processor
cannot dispatch the event, it must place `error.communication` on the
sending session's internal queue. With the dead-letter rule a chart could
never learn that its send went nowhere, and W3C IRP tests 496 and 521
failed. The user decided (decision 8, option A) that the chart must see it.

Core already supports this. A router that answers
`TA_EXTERNAL_EVENT_ERROR` with a fault makes core raise
`error.communication` in the sender, with the fault's data as the event's
data. That works during the sender's own macrostep (an immediate
`<send>`), and later, when a delayed send comes due (core ADR 0072 counts
and records it as raised outside a run).

## Decision

**The router answers `TA_EXTERNAL_EVENT_ERROR` for mail a chart sends to a
target that does not exist when it is sent.** The chart gets
`error.communication` with `data` `{ reason, target }`: `reason` is a
dead-letter reason's text (`not-found`, `done`, `unloaded`), and `target`
names the destination as the `deadLetter` hook would (an `ActorID`, or
`{ family, name }`). Mail JavaScript posts (`post`, `send`) does not go
through the router, and keeps ADR 0008's dead letter.

| Target, when the chart's mail is dispatched | What the sender sees |
|---|---|
| a resident actor | nothing: the mail is accepted |
| a runtime or session ID no actor has (never had, destroyed, unloaded without a loader) | `error.communication`, reason `not-found` |
| a runtime ID whose actor reached a top-level final state and is not yet reclaimed | `error.communication`, reason `done` |
| a name with no directory entry, in a family with no loader | `error.communication`, reason `not-found` |
| a name whose actor is unloaded, in a family with no loader and nothing offloaded | `error.communication`, reason `unloaded` |
| a name in a family with a loader, or with offloaded actors (ADR 0020, core ADR 0074) | nothing: the mail waits for the load |
| the loader then answers `not-found` or `reject`, fails, or times out | a dead letter with that reason, as ADR 0020 says |
| a delayed send whose target is gone when it comes due | `error.communication` when the timer fires |
| `#_parent` from an invoked child, or `#_<invokeid>` from its parent | the same rule: an actor that is gone gives `error.communication` |

**Why the loader's answer is a dead letter, not the sender's error.** The
mail was dispatched: the router accepted it into a waiting mailbox, and the
sender's `<send>` completed. SCXML 6.2.4 is about failing to dispatch.
What happens to accepted mail afterwards is like loss on a network, which
SCXML does not report to the sender either. Reporting it would also need
core to raise an error in a sender after the fact, for mail it no longer
tracks, and with many waiting senders it would reach actors whose later
steps already assumed the send worked. The dead-letter hook, its metric by
reason and its WARN log name every such message, which is what an operator
needs at 3am; the chart does not.

**Mail that is accepted and lost later stays a dead letter** for the same
reason: a message waiting in a mailbox whose actor is destroyed, finishes
or is unloaded (ADR 0005's `destroyed`, `done`, `unloaded`).

## How it works

- `router.c` checks the destination before posting: a runtime ID must have
  a scheduling entry that has not finished; a name must be resident, have a
  load in flight, or be in a family that would start one. Otherwise it
  answers `TA_EXTERNAL_EVENT_ERROR` with a fault whose message says why.
  The router has no Node-API; the fault's data (`{ reason, target }`) is
  made by a callback the Node-API layer installs on the system.
- **A failure while core dispatches due sends** starts a macrostep for the
  sender that the scheduler cannot see. The router, and an I/O processor
  that refuses a send at that moment, wake the sender
  (`tna_system_wake_sender`), so its `error.communication` runs in the
  next turn. Before this ADR no path in napi reached it, so a host I/O
  processor that failed a delayed send left its sender stuck: this fixes
  that too.
- **A core fix the tests found:** an immediate `<send>` that failed during
  its sender's run was counted and recorded twice, once by the unit that
  sent it and once as raised outside a run. `ta_interpreter_dispatch_delayed`
  now says whether it runs inside the sender's run.

## Consequences

- A chart can handle its own undeliverable sends, as SCXML requires. IRP
  tests 496 and 521 pass: all 176 tests that run pass on Node and Bun.
- `tinyactors.errors` (by type `communication`) counts these failures, and
  the `error.raised` WARN log names them; `tinyactors.messages.dead_lettered`
  no longer does. A chart that ignores `error.communication` loses the
  message silently to the chart, but not to the operator.
- Two behaviours to explain: mail from a chart fails at the sender, mail
  from JavaScript becomes a dead letter. Both are visible in metrics.

## Testing

`test/unreachable.js` (Node and Bun): an unknown name, an unknown session
ID, a family with a loader (loads, and a loader's `not-found` is a dead
letter), a delayed send whose target was destroyed before it came due, and
a resident target that still gets its mail. `test/route.js` and
`test/datamodel.js` check the new rule where they checked the old one, and
`test/native/router_test.c` checks it without JavaScript.
