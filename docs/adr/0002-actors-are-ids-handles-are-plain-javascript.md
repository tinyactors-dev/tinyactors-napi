# ADR 0002: Actors are IDs; handles are plain JavaScript

**Status:** Accepted; ID representation depends on tinyactors-core ADR 0059;
per-slot scheduling entry added with ADR 0005
**Date:** 2026-09-23

## Context

The first addon made every spawned actor a native-wrapped JavaScript
object. That meant one `napi_new_instance` (a constructor call), a
`napi_wrap` with a finalizer, and two strong `napi_ref`s (to the system and
the definition). That is about three V8 global handles per actor, or
about 12 million at 4 million actors. V8 visits global handles on every
garbage collection, so GC time grows with the population. It also kept
state (`destroyed`) in the wrapper that core already knows.

It also gave each ID to JavaScript as a `bigint`. That is one more heap
allocation per ID, and comparison and hashing are slow. The whole
`ta_actor_id` is not needed to name an actor. Core's actor table is already
the indirection: a slot indexes it, and the slot's generation detects stale
IDs. Both are 32-bit values, and tinyactors-core ADR 0059 makes them public.

## Decision

1. **An actor is named by its slot and its generation.** They are two
   unsigned 32-bit integers. The addon joins them with `ta_actor_id_make()`
   and splits core IDs with `ta_actor_id_slot()` and
   `ta_actor_id_generation()`. It never packs the bits itself. Generation 0
   means "no actor".
2. **In JavaScript both halves are plain numbers.** Slots stay far below
   2^30. Generations stay there unless one slot is reused more than a
   billion times. So on V8, both are small integers that are not allocated,
   and on JSC every int32 and double is stored inline. Nothing is
   allocated per ID, and the check for stale IDs is at full strength.
   - Native entry points take an actor as two positional number
     arguments, `slot` and `generation`. They never read properties of a
     view object. The JavaScript layer unpacks the view before the call.
   - A native call that returns a new actor (spawn, find, load) creates
     one small view object for it. That object is young and short-lived
     unless the application keeps it.
3. **The addon keeps no per-actor Node-API reference and no copy of a core
   fact.** Whether an actor exists, is done, or is destroyed is asked of
   core each time. The one per-actor native record is the host's own
   scheduling entry: 16 bytes per slot for the actor's scheduling state and
   mailbox (ADR 0005). Core has no such state, because the host owns
   external queueing (tinyactors-core ADR 0029).
4. **`ActorId` is a plain JavaScript class**, defined in `index.js`, with
   three fields: `system`, `slot` and `generation`. Its methods call system
   methods. It holds no native resource and needs no finalizer.
   - `Actor` is the same view. The two names are kept for the typings.
   - A view is only created when a singular API returns one or a caller asks
     for one. Paged enumeration never creates views (ADR 0003).
   - `system.fullId(actor)` returns the joined 64-bit value as a `bigint`,
     for logs and for interop with other bindings.
5. **Equality is by value.** `a.slot === b.slot && a.generation ===
   b.generation`. Among live actors the slot alone is unique, so code that
   holds only live actors can use `slot` as a `Map` key.
6. **Native wrapping is kept for objects that are few**: `System` (one per
   system) and `Definition` (one per registered definition). Their
   lifetimes follow ADR 0012.

## Consequences

- Four million actors cost no JavaScript objects unless a caller asks for
  views. Enumeration returns IDs in typed-array pages (ADR 0003).
- A view of a destroyed actor is harmless: its calls fail with `not-found`,
  because core rejects the stale generation.
- `index.d.ts` changes: `ActorId` becomes an interface with `slot` and
  `generation` instead of a branded `bigint`. `ActorTarget` accepts it
  unchanged.
- Other IDs (`DefinitionId`, `SendId`, `InvocationId`) are few or
  per-message, and remain `bigint` unless measurements show a cost.
