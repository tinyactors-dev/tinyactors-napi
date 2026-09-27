# ADR 0008: Faults are per actor

**Status:** Accepted Refined by ADR 0022: a chart's mail to a target that does not exist is `error.communication` in the sender, not a dead letter; mail from JavaScript is unchanged. Refined by ADR 0025: quarantining an invoked child also tells its parent.
**Date:** 2026-09-23

## Context

In the first addon, any non-OK result from `ta_actor_resume()` or
`ta_actor_deliver()` aborted the whole pump. The failing envelope or
runnable entry had already been popped, so it was lost. The error then
surfaced as a thrown exception, a rejected promise, or sometimes both from
the same call. With four million actors, one bad actor must not stop the
rest.

## Decision

1. **A failure is attributed to an actor and handled there.**
   - `TA_ERR_NOMEM` from a resume or deliver: the macrostep is retryable
     (tinyactors-core ADR 0047). The actor goes back on its queue with
     the back-off flag of its scheduling entry set, and it is skipped for
     one turn. The pump goes on with other actors.
   - Any other failure: the actor is **quarantined**. Its scheduling state
     becomes `quarantined` (ADR 0005), so it leaves the scheduling queues and
     stays out of them even while its mailbox is empty. Mail for it is kept
     but not delivered. A `fault` hook receives
     `{ actor, operation, code, message }`. `system.release(id)` puts the
     actor on the runnable queue, where the next resume continues a paused
     macrostep or reports the actor stable, and ADR 0005's rules apply from
     there. Destroying it discards the mailbox.
   - Messages dropped because their target is gone go to a `deadLetter`
     hook with `{ target, event, reason }`, at most `messageBudget` per
     turn. `target` is an `ActorId`, or `{ family, name }` for a message
     sent to a name with no resident actor (ADR 0006). `reason` is
     `not-found` (an unknown or stale ID, or a name with no entry), `done`
     (the target reached a top-level final state), `destroyed` (the target
     was destroyed with mail waiting), `refused` (core refused that
     message, which also faults the target, ADR 0005) or `unloaded` (a name
     whose actor is unloaded, or mail left for an actor unloaded through the
     raw generated layer; `unload()` itself refuses an actor with mail
     waiting). Dead letters are
     counted in `stats().messages.deadLetters` with or without a hook.
2. **The pump never throws.** Failures inside a turn reach JavaScript only
   through hooks and, for `send()`, through that message's promise.
3. **API calls throw only for misuse**, such as wrong argument types, a
   closed system, or a definition from another system. They are thrown
   synchronously as `TinyactorsError` with a `code`. A call never both
   throws and rejects.
   - A full queue is not misuse. `send()` reports `queue-full` through its
     promise, as it does every other outcome of the message (ADR 0005 point
     9). `post()` has no promise, so it throws `queue-full`: nothing was
     accepted, and the caller must know.
   - An already aborted `signal` rejects a `send()` and throws from a
     `post()`, for the same reason.
4. **Result names and codes are generated** from
   `tinyactors-core/include/tinyactors.api.json`, not written by hand, so
   new core results (such as `TA_ERR_DONE`) reach JavaScript without edits.

## Consequences

- A system-wide failure is only something that is actually system-wide,
  such as the system being closed or its allocator failing during setup.
- Applications that want "stop the world on first fault" can set that in
  their `fault` hook.
