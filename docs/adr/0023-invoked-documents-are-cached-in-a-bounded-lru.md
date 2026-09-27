# ADR 0023: Invoked documents are cached in a bounded LRU

**Status:** Accepted and implemented (2026-09-25); see the implementation notes. Refines ADR 0021 point 3. **Superseded by ADR 0024 and core ADR 0077** (2026-09-26): the cache is removed; definition identity and holds do its job.
**Date:** 2026-09-25

## Context

ADR 0021 caches the definitions the SCXML invoker imports, keyed by the
child document's bytes (`src/napi_children.c`). As built:

- **The lookup walks every entry** and compares bytes with `memcmp`, so
  each invoke of an imported child costs time proportional to the cache.
- **Nothing is ever removed.** The entries, their copied bytes and the
  definitions they name stay until `system.close()`, and the definitions
  are never retired.
- **`resolve(src)` functions are kept until `close()`**, one per
  definition defined with `resolve` and one per child imported through
  one, even after the definition is gone.

A document that differs on every invoke makes every invoke a miss. A
`<content expr>` that builds the child's text with per-request values
in it is the typical case, and so is a resolver that returns slightly
different text each time. Each miss compiles and registers a new
definition that is never retired: a slow leak on a long-running system,
with nothing on a dashboard to show it.

## Decision

1. **Look up by a hash of the bytes, confirm by comparing them.** The key
   is the document's 64-bit FNV-1a hash, in napi's open-addressing map
   (`containers.h`). Entries with the same hash are chained, and a match
   is confirmed by comparing lengths and bytes, so a collision never
   returns the wrong definition. A lookup costs the same however many
   documents are cached.

2. **The cache is bounded, and evicts the least recently used.**
   - Bounds: at most **256 documents** and **16 MiB of document bytes** by
     default, configured with
     `createSystem({ childDocuments: { maxCount, maxBytes } })`. Both are
     whole numbers from 1. A system that invokes a few distinct child
     charts, as real ones do, never reaches 256. A document that changes
     on every invoke reaches it quickly and then churns, which the
     metrics show (point 4). The byte bound caps what the copies of large
     documents cost; it counts the document bytes the cache keeps, not
     the compiled definitions.
   - A hit makes the entry the most recently used. Past a bound, the least
     recently used entries are evicted until the cache is within both.
     The entry just added is never evicted, so one document larger than
     `maxBytes` is still cached, alone.
   - **Evicting retires the definition** (core ADR 0043). Children still
     running keep a retired definition alive until the last one finishes;
     then core frees it. The next invoke of that document imports it again
     under a new definition ID. Generational IDs (ADR 0043) keep the old
     ID from ever naming another definition.
   - **A retired child definition is still visible until it is freed:**
     `inspect()` by its ID works and reports `retired: true`, but
     `findDefinition()` no longer returns it, as for any retired
     definition. After it is freed, its ID is stale.
   - **A hit on a definition that is retired or freed is a miss.** A user
     can retire a child definition with `Definition.retire()`; the entry is
     dropped and the document imported again.

3. **Room is reserved before the import** (core ADR 0070): the copy of the
   bytes and the entry are allocated first, so running out of memory
   fails the invoke with `TA_OP_NOMEM` and nothing changed. A refused or
   failed import releases the reservation. An import that succeeded is
   always cached, so every child definition is eventually retired by
   eviction or freed at close.

4. **Metrics** (napi ADR 0017, low cardinality):

   | Metric | Kind | Meaning |
   |---|---|---|
   | `tinyactors.invoke.documents` | gauge | cached child documents |
   | `tinyactors.invoke.documents.size` (By) | gauge | their bytes |
   | `tinyactors.invoke.document.lookups` | sum, by `tinyactors.lookup.result` (`hit`, `miss`) | invokes of an imported child |
   | `tinyactors.invoke.document.evictions` | sum | entries evicted |

   A document that changes on every invoke shows as a steady miss rate,
   and once the cache is full as a matching eviction rate. **Each eviction
   also writes a WARN log**, `tinyactors.invoke.document.evicted`, naming
   the invoking parent's definition and the bound that was reached, rate
   limited like every host log (per definition and name). A healthy system
   evicts rarely, so the log points at the parent chart whose
   `<content expr>` or `src` builds a new document each time.

5. **A `resolve(src)` function is released when its definition is freed**,
   not at `close()`. Core has no "definition freed" hook, and none is
   added: a freed definition's ID is stale, so `ta_definition_inspect`
   answers `TA_ERR_NOT_FOUND` for it. napi sweeps the kept resolvers and
   releases those whose definition is gone, as the trace encoder's name
   cache does (ADR 0017 section 5). The sweep runs when the list of kept
   resolvers has doubled since the last sweep (from 16), so its cost is
   amortized over the imports and `define()` calls that grow it. This
   covers resolvers of top-level definitions a user retired, too.

## Alternatives

- **Unbounded, as ADR 0021 built it.** No leak for charts with fixed
  child documents, but an unbounded one for charts that build them.
- **Evict by age or idle time.** It needs a clock the invoke path does
  not read today, and it bounds nothing: a burst of distinct documents
  still grows the cache without limit until the timer runs.
- **A core hook for "definition freed".** It would release resolvers at
  the exact moment, but it adds a callback to core's definition lifecycle
  for one host's convenience. Inspection already answers the question.
- **Do not cache documents built by `<content expr>`.** It avoids churn,
  but every invoke of a fixed `<content expr>` document would import
  again, and the definitions would still need retiring.

## Consequences

- Invoking an imported child costs one hash and one comparison of the
  bytes on a hit, whatever the cache holds.
- Memory for imported children is bounded by the limits, plus the
  definitions of children still running after their entries were evicted.
- A chart that builds a new child document on every invoke keeps working,
  and shows up as misses, evictions and a WARN log instead of slow growth.
- `resolve` no longer outlives the definition that holds it by more than
  one sweep.

## Testing

- **Native** (the portable cache, `test/native/documents_test.c`): hits,
  misses, collisions of the same hash, LRU order, eviction at both bounds,
  a document larger than `maxBytes` kept alone, reservation and its
  release, and the counting allocator balancing at destroy.
- **JavaScript, Node and Bun:** a hit on the second invoke; distinct
  documents missing; eviction at `maxCount` with a running child
  surviving it and the next invoke importing again; a `<content expr>`
  that changes on every invoke staying within the bound; the metrics and
  the WARN log; a resolver released after its definition is freed.

## Implementation notes

- **Where it lives.** The cache is `src/documents.{c,h}`, portable (no
  Node-API, so `test-native` covers it, and it moves with the host kernel).
  It stores definition IDs and bytes only; `src/napi_children.c` retires
  what it evicts, writes the log and counts hits and misses. The hash is a
  field (`documents.hash`, FNV-1a by default) so the native test can make
  every document collide and exercise the chains.
- **Reserve, then commit.** `tna_documents_reserve` copies the bytes and
  takes an entry, and adds it to its hash chain, before the import; a
  reserved entry is never found. A failed import calls
  `tna_documents_cancel`, a successful one `tna_documents_commit`, then
  eviction runs. A refused document is therefore never cached, and every
  imported definition is cached until it is evicted or the system closes.
- **A hit is checked.** `ta_definition_inspect` confirms the cached
  definition is registered and not retired; otherwise the entry is
  dropped (`tna_documents_forget`) and the invoke is a miss.
- **The log** is written per eviction under the invoking parent's
  definition, so the rate limit (napi ADR 0017) is per parent chart.
  Lowering the bounds (`setChildDocuments`) evicts at once, with no
  parent to name.
- **Resolvers** are swept as decided; `hostMetrics().childDocuments`
  also reports how many are kept (`resolvers`), for tests. It is not a
  metric.
- **Options:** `createSystem({ childDocuments: { maxCount, maxBytes } })`,
  checked in `lib/`, passed to the native `setChildDocuments`.
- **Tests:** `test/native/documents_test.c` (hits and misses, chains of
  one hash, LRU order, both bounds, one oversized document kept alone,
  reserve and cancel, forget, entry reuse, the allocator balancing), and
  `test/documents.js` on Node and Bun (a hit, eviction at `maxCount` with
  the running child still answering, re-import, a changing `<content
  expr>` bounded at 3 with 10 misses and 7 evictions and the WARN log, a
  child definition retired by the user becoming a miss, and resolvers of
  retired definitions swept while a live one keeps working).

