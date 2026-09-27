# ADR 0011: JavaScript values cross as reference-counted boxes

**Status:** Accepted. Amended on 2026-09-23: build one `napi_ref` per box
first, and measure it against a handle table before choosing. Measured the
same day: one `napi_ref` per box (model A) stays; see the result below.
**Date:** 2026-09-23

## Context

Core treats values as host-defined `ta_value`s that it retains and releases
(tinyactors-core ADRs 0006 and 0050). Event data, data-model roots, delayed
send payloads and completions are JavaScript values. Core may keep a value
long after the call that produced it, but a `napi_value` is valid only in
its handle scope. So each value that core keeps needs something that holds
it past the call.

There are two ways to hold it:

- **A. One `napi_ref` per box.** This is simple and is the standard
  Node-API way. Each reference is a V8 global handle plus a separately
  allocated tracking record in Node. Global handles are GC roots, so their
  number might matter at four million actors with data (ADR 0002's
  concern).
- **B. One handle table per system.** A JavaScript array is held by one
  `napi_ref`, and a box is an index into it. There is one global handle,
  but the design has more parts: an index free list, and an array that
  grows by copying.

Nobody has measured the difference. The cost of GC roots is an assumption,
not a result.

## Decision

1. **A box holds one value for core.** A value box is a small native record
   from the system's box free list (ADR 0014). It holds the value and a
   native reference count. `retain` increments the count. `release`
   decrements it and, at zero, releases the value and returns the record to
   the free list. Core shares values only by retain; `ta_value_vtable` has
   no `clone` (tinyactors-core ADR 0050). Values are shared, not
   structured-cloned.
2. **Build model A first.** A box holds one strong `napi_ref`, made with
   `napi_create_reference` and deleted with `napi_delete_reference` at the
   last release. Reading the value is `napi_get_reference_value`. All box
   access goes through one small interface (make, retain, release, get), so
   model B can replace A without changing any caller.
3. **Measure before choosing.** At 1M and 4M actors with data, step 11
   compares A with B on:
   - bytes per live value;
   - the cost of making and releasing a value;
   - full and minor GC time;
   - allocator calls and `malloc` calls per message.

   A stays unless B is clearly better on GC time or allocations. The result
   is recorded in this ADR.
4. **Boxes exist only for values that are present.** An event without data,
   and a chart without data, create no boxes.
5. **Primitives do not need a box.** Numbers, booleans, `null` and
   `undefined` may be carried in `ta_value.self` with a vtable whose retain
   and release do nothing. This is an optimization, measured with point 3.
6. **Data-model callbacks** (conditions, values, locations, scripts) are
   synchronous JavaScript functions that the definition retains. They are
   called inside a macrostep through a pre-built call context. They must
   not return promises. An exception becomes a fault that core turns into
   `error.execution`.
7. **All values die before their system.** `close()` releases every box that
   is still live (ADR 0012). No box outlives its system, so a box needs no
   finalizer and no weak reference.

## Result of the measurement (2026-09-23, ROADMAP step 11)

`test/scale.js` ran its `data` chart at 50k, 200k, 1M and 4M actors, with
every actor holding a data object and every message carrying a new object,
under both models (`docs/scale.md` has the table). At 4M actors on Node:

| | Model A (`napi_ref`) | Model B (handle table) |
|---|---|---|
| post + delivery with data | 1.27 µs | 1.49 µs |
| spawn + bootstrap | 1.31 µs | 1.43 µs |
| RSS per actor | 788 B | 713 B |
| GC pause, minor / major | 106 / 44 ms | 104 / 22 ms |
| addon allocator calls in steady state | 0 | 0 |

Model B halves major GC time and saves about 10% RSS, but every access costs
two Node-API calls instead of one, so messages are 17% slower on Node (26%
on Bun), and minor GC, which dominates, is the same. That is not clearly
better, so **model A stays the default**. Model B remains buildable with
`TNA_VALUES_MODEL=table` for a later measurement, for example if a workload
with far more live values per actor shifts the balance.

Also learned while building it:
- A `napi_ref` to a string, bigint or symbol needs Node-API version 10, so the
  addon builds against version 10. Both runtimes provide it.
- Numbers, booleans, `null` and `undefined` ride inline (point 5), so
  assigning a counter creates no box.

## Consequences

- Model A is the simplest correct design, and it is what the first addon
  did. Its cost per value (a global handle and a tracking record) is shown
  in `system.stats()` as the number of live boxes (ADR 0009).
- If the measurement favours the handle table, only `values.{c,h}` changes.
- A data model that stored plain data natively (for example, JSON in core
  memory) could avoid handles altogether. It is left as a future option for
  charts whose data never needs to be a live JavaScript object.
