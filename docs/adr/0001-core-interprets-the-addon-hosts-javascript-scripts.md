# ADR 0001: Core interprets, the addon hosts, JavaScript scripts

**Status:** Accepted
**Date:** 2026-09-23

## Context

The first addon (`src/addon.c`, about 2,500 lines) was written before this
split was settled, and it cannot scale to four million actors
(tinyactors-core ADR 0018). Most of its faults come from mixing up layers:

- It **re-implements facts that core owns**: a copy of each definition's
  identity strings, a copy of its top-level final states (reported wrongly
  for charts with more than one), a `destroyed` flag kept beside core's
  actor table, a private null data model, and a readiness check made with
  `ta_actor_inspect()` before every `ta_actor_deliver()`.
- It **omits what only a host can provide**: an external-event router, a
  pump driven by the event loop, timers, I/O processors, invokers, and a
  data model for JavaScript values.
- It **puts work in C that belongs in JavaScript**, and the reverse: a
  hand-written 400-line object-tree decoder in C, and no paged enumeration.

This rewrite starts from a clear split of responsibility.

## Decision

| Layer | Owns |
|---|---|
| **tinyactors-core** | Statechart semantics, the actor table, sessions, internal queues, delayed-send storage and the deadline index, interning, definition identity, completion and final state, inspection, session images. |
| **Addon (C, Node-API)** | Host services core asks for: external queues and scheduling (ADR 0005), the external-event router (ADR 0006), the clock and pump (ADR 0007), I/O processors, invokers, log sink, the actor directory, the JavaScript data model and value boxes (ADR 0011). It also provides paged enumeration to JavaScript (ADR 0003), and the generated control-plane bindings (ADR 0013). |
| **JavaScript** | Scripting and policy: the fluent builder, which emits the generated spec shape (ADR 0013), handle objects (ADR 0002), promise and `send()` bookkeeping, and choosing options. |

Rules that follow:

1. **The addon never stores a fact that core can answer.** If a binding
   needs a fact that core does not expose, the fix is a core change with an
   ADR (as tinyactors-core ADRs 0054–0057 were), not a copy in the addon.
2. **The addon relies on these core decisions:**
   - tinyactors-core ADR 0054: inspection is O(size of the actor) and lists
     delayed sends;
   - ADR 0055: `ta_actor_deliver()` is the admission test and reports
     `TA_ERR_DONE`;
   - ADR 0056: a finished actor reports its final state;
   - ADR 0057: core ships the null data model;
   - ADR 0059: an actor ID is a public slot and generation;
   - ADR 0061: a macrostep can pause inside executable content, so one
     resume is bounded (ADR 0007);
   - ADR 0062: the actor walk is paged by position (ADR 0003);
   - ADR 0065 (proposed): named addresses are reference-counted handles,
     which named routing needs (ADR 0006).
3. **JavaScript runs only between core calls.** Core callbacks into the
   addon (router, I/O, invoker, log, data model) must not re-enter the
   interpreter. They enqueue work or buffer records. Data-model callbacks
   are the one place JavaScript runs inside a macrostep, and they are
   synchronous (ADR 0011).
4. **A system belongs to the thread and Node-API environment that created
   it** (tinyactors-core ADR 0017). The addon has no global registry.

## Consequences

- The addon is smaller than the first version and has no semantic logic,
  so there is nothing in it that can disagree with core.
- Core ADRs are a prerequisite for some addon features. Work is ordered so
  that the addon does not work around a missing core fact.
- `docs/design.md` and `ROADMAP.md` came before these ADRs. Where they
  disagree, the ADRs win.
