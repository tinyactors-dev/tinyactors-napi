# ADR 0014: Memory is pooled by lifetime

**Status:** Accepted; refines ADR 0009 and ADR 0011. Amended on 2026-09-23:
size-class pools are deferred until a measurement asks for them.
**Date:** 2026-09-23

## Context

The target is four million actors in one process, with fine-grained actors
such as one actor per websocket connection (tinyactors-core ADR 0018). At
that scale, every allocation on the per-message path matters. Each one is
paid millions of times per second, and it fragments a heap in which millions
of objects die in any order.

When this ADR was first written, a post and its reply cost about four to six
allocator calls across core and the planned addon:

| When | Where | What | Now |
|---|---|---|---|
| every macrostep | core `interpreter.c` | sparse state and an internal-event array, allocated and freed | removed by core ADR 0064 |
| every spawn | core `actor.c` | the actor record, session storage and data-model instance | one allocation (core ADR 0063) |
| actor table growth | core `actor.c` | the table doubled by copying | fixed pages (core ADR 0063) |
| a named destination or origin | core `routing.c` | a string copy | reference-counted handles (core ADR 0065) |
| delayed sends | core `timer.c` | per-owner send arrays and the owner heap | unchanged; they grow only with an actor's sends |
| every post (as planned) | addon | a mailbox record, a ring chunk, and hash-map growth | removed by the scheduling table (ADR 0005) |
| every value (as planned) | Node-API | `napi_create_reference` | see ADR 0011 |

Arenas alone do not solve this. An arena frees everything at once, but actors
and messages die one at a time. An arena per actor costs at least one chunk
per actor, far more than the "handful of words" of core ADR 0018.

With the core changes above, the general allocator is no longer called on
the per-message path of a simple actor. What is left is the addon's own
per-message records (envelopes and value boxes), and those have one fixed
size each.

## Decision

1. **Every allocation has one of four lifetimes, and each lifetime has one
   strategy:**

   | Lifetime | Examples | Strategy |
   |---|---|---|
   | System | actors, sparse state, envelopes, value-box records, queue chunks, scheduling-table pages, directory entries | the system's counting allocator; free lists for fixed-size records |
   | Definition | compiled layouts, spec trees | core's arenas (unchanged) |
   | Pump turn | `done`, `fault` and `deadLetter` records waiting for their hooks | a turn arena, reset at the end of each turn |
   | Call | spec decoding, an enumeration page, formatting buffers | a call arena, reset after the call |

2. **The system allocator is a counting allocator over `malloc`.** It is
   the one `ta_allocator` of the system, and it is also handed to core.
   `free` receives the size and alignment, so the counters need no header.
   A system is used by one thread (ADR 0001), so it has no locks.

3. **Fixed-size records the addon makes per message are reused through free
   lists:** envelopes (ADR 0005) and value-box records (ADR 0011). A freed
   record goes onto its list, and the next one of that kind comes off it.
   Ring chunks are kept the same way: an empty ring keeps one spare chunk.

4. **Scratch memory is core's `ta_arena`, backed by the system allocator.**
   The turn arena and the call arena are reset, not destroyed, so after
   warm-up they allocate nothing.

5. **Size-class pools are deferred.** A chunk source with size-class pools
   can replace `malloc` behind the same allocator interface, with no change
   to any caller. That is done only when the steady-state measurement in
   point 6 shows allocator calls that the free lists and core's own changes
   do not remove, or when fragmentation shows up in a long run.

6. **Accounting (ADR 0009).** `stats()` reports, for each lifetime and each
   category, the bytes in use, the number of allocator calls, and the
   free-list lengths. The allocator-call count is the test signal: after
   warm-up, a steady workload of posts and deliveries makes no allocator
   call in the addon. Core's calls are counted and reported separately.

7. **What stays outside this design.** V8 and Node-API allocate for
   promises, handle scopes and JavaScript objects. There, the aim is only
   short-lived young-generation objects on the hot path and no handles that
   are kept per actor or per value (ADRs 0002 and 0011).

## Consequences

- The per-message path of a simple actor makes no allocator call, from core
  (ADRs 0063–0065) or from the addon (free lists), without a custom
  allocator.
- There is less code before anything runs: an allocator that counts, two
  arenas and two free lists.
- A long-running system returns freed memory to `malloc`, not to pools it
  keeps until `close()`.
- If pools are added later, only `allocator.{c,h}` changes. The steady-state
  test shows whether they help.
- The step exit criteria test for zero allocator calls in steady state.
  That result is exact, unlike a timing ratio.
