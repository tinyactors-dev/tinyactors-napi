# ADR 0015: Tracing is a hook that hands JavaScript plain records

**Status:** Accepted and implemented; serves core ADR 0067. Open point 2 (naming IDs) is addressed by core ADR 0071: `TraceSpans` takes the system and labels transitions and actions. Points 1 and 3 superseded by ADR 0016: the hook hands JavaScript OTLP protobuf bytes, and `TraceSpans` is removed (its open point 1, the cost of objects, is what ADR 0016 answers).
**Date:** 2026-09-24

## Context

Core ADR 0067 writes trace records to one sink per system: decisions,
data changes and effects, each with a step key and the W3C trace context
the macrostep runs under. A Node or Bun host wants to see them, usually
as spans in whatever tracer the application already runs.

Two things pull in opposite directions. Records are borrowed for the
duration of `write`, inside a core call where no JavaScript may run
(ADR 0001 rule 3), and a busy system writes millions of them. And
tinyactors is a library: its users bring their own telemetry, and a
dependency on one tracer's SDK or API would be wrong for everyone else.

## Decision

1. **C only hooks.** The addon installs a buffered trace sink when
   JavaScript registers a function (`System.setTraceSink(sink, { kinds,
   unsampled })`), and core's null sink otherwise, so an untraced system
   builds no record at all. The sink copies each record (its lists and
   name into pools, a reference to its event and value) and the pump
   hands the turn's records to JavaScript as **one array at the end of
   the turn**, after the last core call (ADR 0007 point 5). C turns
   records into plain objects and nothing else: no spans, no OTLP, no
   HTTP, no knowledge of OpenTelemetry.
2. **The mask decides what is built.** `kinds` names the record kinds;
   core builds no other. Sampling is core's (ADR 0067 section 6).
3. **lib/ puts out plain data, and depends on no telemetry package.**
   `lib/tracing.js` exports `TraceSpans`, which turns records into
   span-shaped objects (trace ID, span ID, parent, name, start and end
   time, attributes, events, links, status) with the attribute names of
   core ADR 0067 (`scxml.state`, `scxml.transition`, `scxml.event.name`,
   `scxml.session_id`, ...), `parseTraceparent` / `formatTraceparent`,
   and `stepSpanId`, which derives span IDs exactly as core's
   `ta_step_key_span_id()` does. `package.json` gains no dependency, not
   even an optional or peer one. A user maps the objects onto their
   tracer; `docs/tracing.md` shows how, as an example.
4. **traceparent in and out.** `post()`, `send()` and `spawn()` take
   `options.traceparent`; the macrostep it starts runs under it, and its
   cause is the header's parent span. An I/O processor's request and an
   invoker's start request carry `traceparent`, naming the step that
   sent or invoked, for the service to pass on. Mail between actors
   keeps its trace parent in the mailbox, out of line: an envelope holds
   a pointer to a free-listed parent only when the message is traced.
5. **Our own export is for testing.** `tools/otlp.js` is a small
   OTLP/HTTP JSON exporter built on `fetch`, used by the tests
   (`test/otlp.js`, against an in-process receiver) and by
   `mise run otel-demo`, which sends a demo trace to otel-tui. It is not
   exported from the package.

## Consequences

- Untraced cost: none beyond core's step counters (core ADR 0067). The
  mailbox envelope grows by 8 bytes (96 to 104), the pointer to an
  optional trace parent; a traced message holds a 48-byte parent from
  the scheduler's free list.
- Traced cost (`test/bench/tracing.js`, 100,000 actors, one `ping` with
  an assignment each, Node 26 on an M-series Mac): 2.24M events/s
  untraced; 0.44M with a sink that wants only macrostepBegin and
  macrostepEnd; 0.20M with every kind; 0.15M with every kind mapped to
  spans. Core's own share is small: with the addon's copy skipped, a sink
  that wants every kind still runs at 2.13M events/s. The rest is copying
  records and building JavaScript objects. Bun is 20 to 70% faster in
  each row.
- The trace buffer keeps its capacity from turn to turn, so a steady
  stream of records makes no allocator call once the busiest turn has
  been seen. It does not use the turn arena, which finds room block by
  block and slows down as a busy turn's records fill it.
- Record wall time is read in C (`timespec_get`) when a record is
  copied, since core's `now` is logical time.

## Open points

1. Converting records to JavaScript objects costs most of what tracing
   costs. A columnar batch (typed arrays with names interned per batch)
   would be cheaper, at the price of a less direct API.
2. Transition, expression and action IDs cross as numbers. Naming them
   needs definition inspection by ID, which core does not offer for
   transitions yet.
3. A lifecycle record's span ID is derived from the session and the
   record kind, so two LOADED records of one session share one.
