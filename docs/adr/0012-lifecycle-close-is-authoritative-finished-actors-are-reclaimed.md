# ADR 0012: Lifecycle: close is authoritative, finished actors are reclaimed

**Status:** Accepted
**Date:** 2026-09-23

## Context

Two lifecycle problems in the first addon grow with scale:
- finished actors stayed resident until JavaScript explicitly destroyed
  them, and nothing told JavaScript that an actor had finished;
- teardown depended on the order in which finalizers ran across `System`,
  `Definition` and `Actor` wrappers.

## Decision

1. **Completion is announced.** When an actor finishes, the pump calls the
   `done` hook with `{ actor, finalState, data }`:
   - `finalState` is the state name from tinyactors-core ADR 0056;
   - `data` is its completion data.

   A pending `send()` or `spawn` promise that waits for completion is
   settled at the same point.
2. **What happens to a finished actor is a system option,**
   `finished: "destroy" | "retain"`:
   - `"destroy"` (the default): the actor is destroyed after the `done`
     hook returns, so an application with many short-lived actors uses
     constant memory;
   - `"retain"`: finished actors stay inspectable until destroyed. This is
     for tests and debugging.
3. **`System.close()` is explicit, idempotent and authoritative.** In
   order, it:
   - stops the pump: clears its pending immediate and its timer;
   - rejects all pending promises;
   - destroys every session image still alive (ROADMAP step 14), which
     releases the values it holds; a `SessionImage` then reads as
     destroyed;
   - discards mailboxes;
   - destroys the `ta_system`;
   - releases every definition callback and every live value box
     (ADR 0011);
   - frees the free lists, the scheduling table and the arenas (ADR 0014).
     The allocator's bytes in use are then zero.

   After close, every method throws `closed`.
4. **Finalizers are safety nets.** The environment cleanup hook closes any
   systems still open. `Definition` wrappers hold a system pointer and
   check whether it is closed. `Actor` views (ADR 0002) have no finalizer.

## Consequences

- By default, the memory of a long-running system follows the number of live
  actors, not the total spawned.
- Tests that inspect finished actors set `finished: "retain"`.
