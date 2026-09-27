# ADR 0009: One native toolkit for memory and containers

**Status:** Accepted; memory strategy refined by ADR 0014
**Date:** 2026-09-23

## Context

The first addon wrote its own queue logic twice (runnable and external).
Each had its own head, count, capacity, compaction and `realloc` doubling.
Its decoders freed memory by hand along each error path, and it built
sentinel-terminated `ta_str` arrays with `calloc`. Contiguous queues grown by
doubling copy the whole block at millions of entries. No one could see how
much memory the addon itself used.

## Decision

1. **One small container module** (`src/containers.{c,h}`) provides:
   - `vec`: a growable array;
   - `ring`: a FIFO made of fixed-size chunks, so growing it never copies
     the whole queue. An empty ring keeps one spare chunk, so a queue that
     fills and drains does not allocate each time (ADR 0014);
   - `map`: an open-addressing hash map keyed by `uint64_t`, used for the
     directory, which it keys by `ta_address` pointer (ADR 0006). Mailboxes
     do not use it, because the scheduling table indexes them by slot
     (ADR 0005);
   - `slice`: a view of a pointer and a length, used in every interface
     that passes a sequence.

   Queues, enumeration pages and tables use these types and nothing else.
2. **Temporary allocations use a scratch arena**, such as decoding a spec or
   building an inspection page. It is reset after each call, so error
   paths free nothing by hand. It is core's `ta_arena`, backed by the
   system allocator (ADR 0014).
3. **All allocations go through one counting allocator per system**
   (ADR 0014). That allocator is also handed to core. `system.stats()`
   reports the addon's bytes by category (envelopes, scheduling table, value
   boxes, directory, scratch high-water mark), the number of allocator
   calls, and the free-list lengths, next to what core reports for each
   actor.
4. **The addon follows core's C rules where they make sense**: functions
   take at most three parameters, and helpers get their own module instead
   of living in `addon.c`.

## Consequences

- One tested implementation of each container, instead of one per queue.
- The memory an operator sees includes the addon's own queues, not only
  core's actors.
