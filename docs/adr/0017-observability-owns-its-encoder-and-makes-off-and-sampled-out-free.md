# ADR 0017: Observability owns its encoder, and makes off and sampled-out free

**Status:** Accepted and implemented, except where the implementation notes say otherwise. The follow-up of 2026-09-25 in the notes adds failure logs that say why, the host metrics and the SDK metrics example; the traced-path targets and Bun's budgets stay open. ADR 0018 (the encoder writes into host memory) removed a copy and a zero-fill with no measurable gain: macrostep spans still cost about 530 ns (Node) and 575 ns (Bun) over untraced, against about 280, and every record about 1,470 against 780. Revises ADR 0016 (points 1 and 4, and its performance), move `traceparent` parsing from ADR 0015 point 4 into C, and take the napi slot core ADR 0072 names for metrics and logs, revising that ADR's section 7 for metrics. Research: [`docs/research/observability-build-vs-reuse.md`](../../../docs/research/observability-build-vs-reuse.md). **2026-09-25: the section 4 targets are withdrawn, and the measured performance is accepted as the baseline** (`docs/scale.md`, "tracing throughput, the accepted baseline"). Since core ADR 0078, `watchTraces({ families })` sends family names to the addon, which resolves each definition when a delivery first meets it, so nested and invoke-time children are watched too. The follow-up of 2026-09-26 in the notes removes the per-actor memory and the allocations an installed but idle sink cost (`b6b369e`, `db96831`, `28825dc`).
**Date:** 2026-09-24

## Context

The user asked for a clear-eyed review before more is built: "this is too
expensive and we're rebuilding a lot of the stuff the otel ecosystem has
already built. Maybe that's necessary, maybe that isn't."

The research note measures both halves of that. On the tracing bench
(100,000 actors, four records per event, Node 26, ns per event):

| | ns/event | Events/s |
|---|---|---|
| Untraced | 418 | 2.39M |
| **Untraced, but `post` gets a `traceparent`** | **912** | **1.10M** |
| Sink installed, `traceparent` sampled out | 924 | 1.08M |
| Macrostep spans only | 941 | 1.06M |
| Every record | 1573 | 0.64M |
| Every record, through the OpenTelemetry JS SDK instead, serialized, excluding the crossing from C | ≈ 5800 | ≈ 0.17M |

What the profiles show:

- **Core is cheap.** Building records costs 17–41 ns per event, and core's
  sampling gate costs 12 ns: a sampled-out macrostep costs almost nothing
  in core.
- **The expensive parts are napi's, and most are avoidable:**
  - parsing a `traceparent` in JavaScript: 494 ns per post, even with no
    sink installed;
  - a cryptographic random trace ID on every post: ~120 ns;
  - copying each span twice: ~100 ns;
  - reading the wall clock for every record: ~30–100 ns;
  - formatting event names for every record: ~20–40 ns.

  Two of these fixes (a seeded generator, and fewer clock reads) together
  measured −152 ns per event.
- **The ecosystem is more expensive, not less.** The official SDK takes
  1331 ns per event for one macrostep span serialized to OTLP, and 5415 ns
  for our "every record". That is before tinyactors runs or any record
  reaches JavaScript. Its sampled-out path costs 388 ns per span; ours
  costs 12 ns per event.
- **The bytes are inherent.** A lossless macrostep span is about 300 bytes,
  because OTLP repeats every attribute name in every span.

OpenTelemetry advises that "Libraries should only use the OpenTelemetry
API". That advice assumes spans are created in the SDK's language, at a
rate where one API call per span is cheap. Ours are created by core in C,
millions per second, for every host. Section 4 of the research note weighs
this in full.

So: **what we built is the cheaper design, and it is necessary for a
runtime whose spans start in C.** What is wrong is a set of costs on the
paths that should be free (off, and sampled out) and a set of hot spots on
the path that is paid for (traced).

## Decision

### 1. Keep the encoder for the high-volume signals: traces and logs

The portable C encoder of ADR 0016 stays, and stays the only trace
output. It also writes logs (section 7). Its code is the price of spans
that start in C; the measurements say the alternative costs four to seven
times more per event, and would have to be rebuilt in every host.

### 2. Off and sampled-out are free, and a bench holds them to it

- **`traceparent` is parsed in C.** `post`, `send` and `spawn` pass the
  string through unchanged, and the addon parses its 55 characters. The
  JavaScript regular expression and the three BigInts go.
  `parseTraceparent` and `formatTraceparent` stay in `lib/tracing.js` for
  users.
- **Trace IDs come from a fast generator seeded once.** Each system seeds
  SplitMix64 (or xoshiro256**) from the OS's random bytes when the sink is
  installed. It then draws two 64-bit words per new trace. The spec
  requires random IDs, not cryptographic ones [research note §4]. `seed`
  keeps its meaning.
- **Budgets checked by the bench** (`test/bench/tracing.js`, reported, not
  a CI gate):
  - untraced with a `traceparent`: within 40 ns of untraced without one;
  - sink installed, macrostep sampled out: within 40 ns of untraced;
  - watch set empty (section 3): no measurable cost.

### 3. Turning tracing on, off and down at 3am

- **A ratio sampler for the traces napi starts.**
  `sample: <0..1>` decides with OpenTelemetry's `TraceIdRatioBased`
  algorithm, on the new trace ID. Every process that sees the trace makes
  the same decision. An incoming `traceparent` keeps its caller's decision
  (parent-based). Today, installing a sink traces everything; with
  `sample`, a production system can run with `sample: 0` and pay nothing
  until something is watched.
- **Watch one actor, one definition, or one request.**
  - `system.watchTraces({ sessions, families, addresses })` returns a
    handle whose `stop()` removes the watch. napi checks the watch set at
    each delivery it makes (`post`, `send`, timers, routed mail) and marks
    matching deliveries sampled.
  - Everything the watched delivery causes follows, because core
    propagates the flag (ADR 0067 section 6).
  - No core change and no per-actor memory. When no watch is active, the
    check is one branch.
  - A request is watched by sending it with a sampled `traceparent`, as
    today.
- **Change settings without reinstalling.** `system.configureTraces({
  kinds, detail, sample })` changes the kind mask and the sampler in place.
  Open spans are not ended early. `setTraceSink` stays the way to install
  and remove the sink itself.
- **Detail presets over the kind mask:**
  - `summary`: macrostep begin and end, plus the failure kinds;
  - `decisions`: adds microsteps and conditions;
  - `full`: every kind, as today.

  `kinds` still overrides.

### 4. The traced path: named hot spots, with targets

- **One copy.** Spans are written straight into the request buffer, with
  sizes computed before writing (ADR 0016 already calls for this), instead
  of being built in a span buffer and copied at `tna_span_end`.
- **Fewer clock reads.** Read the wall clock at span boundaries only:
  macrostep begin and end, and microstep start. Span events carry their
  span's last reading. That is one read per span boundary instead of one
  per record.
- **Names formatted once.** Event names are cached per event-name atom,
  and labels per definition (section 5), so no record formats a name.
- **Targets on the bench machine:**
  - macrostep spans only: ≤ 700 ns per event (≥ 1.4M/s);
  - every record: ≤ 1.2 µs per event (≥ 0.8M/s).

  The implementation notes record what is reached.

### 5. State lives as long as what it describes

This is what the user's "new arena with a new lifetime" is right about.
The encoder already reuses its buffers, and a per-turn arena cannot hold a
macrostep that stays open across turns. What each piece of state needs is
the lifetime it describes:

- **The name cache** is keyed by definition ID, generation included, so a
  stale entry never matches. It is swept when it holds twice as many
  definitions as the system has live: an entry whose
  `ta_definition_inspect` answers `TA_ERR_NOT_FOUND` is dropped. This
  closes ADR 0016's "the name cache never evicts".
- **Open spans** go in an open-addressing table keyed by session. An entry
  is added at macrostep begin, removed at its end, and ended as incomplete
  when its actor is unloaded or destroyed. This closes ADR 0016's "open
  spans are kept in a linear array".

### 6. Replies stay in the trace

This closes ADR 0016's open point 1.

- **I/O processors.** The context an I/O processor receives with a
  request becomes per-request. Its `post` defaults `traceparent` to the
  request's (the sending step), so a reply is a child of the step that
  sent the request. An explicit `options.traceparent` wins.
- **Invokers.** The invoker's `reporter` does the same for events from
  the invoked service, using the invoking step.
- **Tested end to end:** a request to a JavaScript I/O processor that
  replies asynchronously lands in the original trace, in the otel-tui
  demo and in `test/otlp.js`.

### 7. Logs through the encoder; metrics as plain data

This revises core ADR 0072 section 7.

- **Logs** are high-volume in an error loop, and they come from records
  that already flow through the encoder. The encoder writes an
  `ExportLogsServiceRequest` from the failure kinds and `<log>`, as ADR
  0072 decides. `setTraceSink`'s callback receives it next to the traces,
  as `{ traces, logs }` bytes per turn.
  - **Rate limits** (ADR 0072 open question 4): at most N log records per
    definition and event name (or record kind) per interval. When one is
    dropped, the next log that passes carries `tinyactors.suppressed` with
    the count dropped. The counters of ADR 0072 still count every failure.
- **Metrics** are read once per export interval, not per event, so the
  encoder's speed does not matter for them. The user's Meter pipeline
  (views, temporality, exporters) is exactly what an SDK user wants.
  - `system.metrics()` returns a plain snapshot: core's counters and
    occupancy (ADR 0072), plus napi's gauges and histograms (mailboxes,
    dead letters, quarantine, turn duration, backlog, timer lateness).
  - `docs/tracing.md` shows the snapshot read by the SDK's observable
    instruments, tested like ADR 0016's SDK example against the pinned
    dev dependencies.
  - Users with no SDK get `metricsToOTLP(snapshot)` in `lib/`, a small
    JavaScript OTLP metrics writer with no dependency, if the user wants
    it in `lib/` (question 2).
  - **No metrics encoder in C.**

### 8. The package still depends on nothing

`lib/` keeps no telemetry dependency. Automatic context propagation, which
means reading the application's active OpenTelemetry context at `post`
time instead of passing `traceparent`, is the one thing the API would give
us cheaply. It would live in a separate optional adapter package that
depends only on `@opentelemetry/api`, if the user wants one (question 3).

## Alternatives

- **Delegate spans to `@opentelemetry/api` and the user's SDK,** with a
  separate adapter over core's record sink.
  - Measured, the SDK alone costs 1331 ns per event for one span and
    5415 ns for "every record", serialized. Every record would also have
    to cross into JavaScript first (ADR 0015 measured about 4.8 µs for
    that), so the whole system would run at roughly 0.1M events/s.
  - Its sampled-out spans cost 388 ns each, against our 12 ns.
  - It serves only JavaScript: the browser, Python and database hosts
    would each need their own adapter.
  - What it gives, automatic propagation and the application's sampler,
    is available more cheaply (sections 3 and 8).
- **An always-on summary of macrostep spans.** Even after section 4, a
  macrostep span costs on the order of 300 ns per event: a third of the
  untraced event. That cannot be always on. The always-on summary is ADR
  0072's counters and occupancy, which cost increments, not spans.
- **Correlation IDs indexing a table of trace contexts** (the user's first
  idea). It would save memory on pending delayed sends (48 bytes to 4).
  It would save no CPU: core's record building is 17–41 ns per event. It
  would add reference counts, a free list and entries in session images.
  At the JavaScript boundary, where an ID table would save the 494 ns
  parse, parsing in C does the same with no lifetime to manage. Revisit if
  the memory of pending sends becomes the constraint.
- **A new arena for tracing** (the user's second idea). Buffers are
  already reused (malloc is 3% of traced time), and a per-turn arena can't
  hold spans that outlive a turn. Its useful core, state tied to its
  lifetime, is section 5.
- **Swallow the cost, but make toggling easy** (the user's third idea).
  This is, in substance, the decision. The difference is that about 40% of
  today's traced overhead is not a cost to swallow: it is the hot spots in
  sections 2 and 4.
- **A custom columnar layout.** Rejected by ADR 0016, and nothing here
  changes that. The bytes are not where the time goes.

## Relation to other decisions

- **ADR 0015:** point 4 (`traceparent` in and out) stands. Parsing moves
  from JavaScript to C.
- **ADR 0016:**
  - Point 1 (one format out) gains logs next to traces, and the
    `sample` and `detail` options.
  - Point 4 (a trace always has an ID) now uses a generator seeded once.
  - Its open points 1, 3 and 4 close here (sections 6 and 5), and open
    point 2 has targets (section 4).
  - The mapping, the lossless requirement, the host interface and
    `decodeTraces` are unchanged.
- **Core ADR 0067:** unchanged. The measurements confirm its design: core
  costs 17–41 ns per event, and its sampling gate costs 12 ns.
- **Core ADR 0072:**
  - This is the napi ADR it names for napi's part.
  - Its section 7 is revised for metrics: plain data and a JavaScript
    writer, no C encoder.
  - Logs are as it decides, with the rate limit of section 7 here.
  - Its counters are the always-on summary.
- **Core ADR 0071:** it supplies the labels that section 4 caches.

## Consequences

- The paths that should be free become free. Propagating a caller's
  context stops halving throughput, and a production system can install a
  sink with `sample: 0` and watch only what it needs.
- The traced path gets faster by the hot spots in section 4. Its
  remaining cost is the encoder and the bytes, and that is the price of
  lossless OTLP.
- napi's API grows by `sample`, `detail`, `configureTraces`,
  `watchTraces`, `metrics`, and possibly `metricsToOTLP`. `setTraceSink`'s
  callback receives `{ traces, logs }`.
- We keep owning the C encoder (about 1200 lines) and the decoder. The
  measurements are the reason: nothing in the ecosystem produces these
  spans more cheaply.

## Testing (when implemented)

- **Bench budgets** (section 2), reported by `test/bench/tracing.js` next
  to the numbers in the research note.
- **Sampling:** `sample` decides as `TraceIdRatioBased` does for known
  trace IDs, with a fixed `seed`. A parent's decision wins.
- **Watches:** a watched session, family or address is traced; everything
  it causes is traced; nothing else is. After `stop()`, nothing is traced.
- **`configureTraces`:** changes take effect with no incomplete spans.
- **Replies:** the reply of a JavaScript I/O processor and an event from
  an invoked service carry the request's trace ID and parent.
- **Lifetimes:** the name cache shrinks after definitions are freed. Open
  spans with 10,000 paused actors cost O(1) per record.
- **Logs:** failure records produce log records correlated with their
  spans. Rate limits report the number suppressed.
- **Metrics:** the snapshot matches the counters. The SDK example reads
  it through observable instruments. By hand, otel-tui shows traces, logs
  and metrics.

## Questions for the user

**Answered 2026-09-25:**

1. **Default detail:** `summary`.
2. **`metricsToOTLP` ships in `lib/`.** It is plain JavaScript with no
   dependency, and it gives users without an SDK a metrics path, as the
   hook's bytes do for traces.
3. **No adapter package** for now.
4. **Seeded fast generator: yes, implemented in core.** See "A tracing
   module in core" below.
5. **Summary for everyone, full detail for watched actors: yes.** Core
   carries a detail bit on the trace context.

**A tracing module in core.** The user expects a proper tracing module in
core to come out of this work. It builds, generates and inspects W3C
`traceparent` headers and trace IDs, so every host shares one
implementation instead of writing its own:

- parse and format `traceparent` (version, trace ID, parent ID, flags),
  with validation, as `ta_trace_context` and `ta_trace_parent` values;
- trace-ID and span-ID generation from a fast generator that core keeps,
  seeded by the host from its OS's random bytes. Core stays freestanding
  and deterministic: it never reads the OS, and a given seed gives a
  given sequence;
- the sampling decision (ratio, compatible with OpenTelemetry's
  `TraceIdRatioBased`) and the detail bit of question 5;
- inspection helpers: text for a trace ID or span ID, and the step key a
  span ID came from where that can be answered.

That module is a core decision, so it gets a core ADR of its own before
it is built. napi then parses nothing itself: `traceparent` crosses as
text and core parses it.

The original questions were:

1. **Default detail** when a sink is installed: `summary` (macrostep spans
   plus failures) or `full` (lossless, as today)?
2. **Metrics without an SDK:** ship `metricsToOTLP` in `lib/`, or only a
   writer in `tools/` for the demo?
3. **An optional adapter package** depending only on `@opentelemetry/api`,
   for automatic context propagation: wanted, or not now?
4. **Trace IDs from a seeded fast generator,** which the spec allows,
   instead of the OS's cryptographic generator per trace: acceptable?
5. **"Summary for everyone, full detail for watched actors"** would need
   core to carry a detail bit on the trace context, because the kind mask
   is per system. Worth a core change, or is "watched actors fully,
   everyone else sampled out" enough?

## Implementation notes

- **Section 2.**
  - `post`, `send` and `spawn` hand `traceparent` to the addon as text, and
    core parses it (core ADR 0073).
  - Core's generator is seeded once per sink, from the OS or from `seed`.
  - `mise run bench-check` runs the budgets on Node and Bun. It is not part
    of `mise run test`, because 40 ns is within a shared machine's noise.
    On a quiet machine with Node 22, a `traceparent` cost 19 ns over
    untraced and a sampled-out macrostep 26 ns, both within budget.
  - Bun measured a sampled-out macrostep at 46–53 ns, over the budget: open
    point.
- **Section 3.** `detail` (`summary` by default), `sample`,
  `configureTraces()` and `watchTraces()` are built as written.
  - The scheduler checks the watch at its one delivery point, with
    `ta_actor_inspect` only when a watch is active.
  - A watched family's spawns are watched from their bootstrap.
- **Section 4.** The clock is read at span boundaries only. The encoder
  still copies each span once more, from its own buffers into the request;
  writing spans straight into the request was not done.
  - Measured with every record kind, 100,000 actors, Node 26, before the
    machine was loaded: 886 ns per event for macrostep spans, against a
    437 ns untraced baseline, and 1,543 ns for every record.
  - The targets of 700 ns and 1.2 µs are not met: open point.
- **Section 5.** Open spans are in an open-addressing index by session.
  They end, marked incomplete, on unload and destroy: the sink always asks
  core for those two kinds, and writes their spans only when they were
  asked for. The name cache sweeps freed definitions and compacts its text
  before it grows.
- **Section 6.** An I/O processor's context is per request, and a reply it
  posts defaults to the request's `traceparent`. An invoker's events carry
  the invoke request's `traceparent`. Core's `ta_invoke_report_params`
  gained `trace`.
- **Section 7.**
  - **The sink's signature differs from the text.** It is called as
    `sink(traces, logs)`, not with `{ traces, logs }`, so a sink written
    for traces alone keeps working. `traces` is empty when only logs were
    written.
  - **Logs are the failures and `<log>`.** Failures (ACTION_FAILED, a
    RAISED `error.*`, STOPPED) are WARN, and `<log>` is INFO. The limit is
    `logLimit` per definition and name per second, and `logs: false`
    writes none.
  - **Metrics.** `system.metrics()` and `metricsToOTLP()` are built. The
    snapshot holds core's counters and occupancy, and napi's messages and
    memory.
  - **Not done:** the tested SDK example with observable instruments, and
    the host metrics listed in core ADR 0072's implementation notes.
- **otel-tui.** In a check in tmux, `mise run otel-demo` showed the
  request's trace, with `POST /orders` and the actors' spans, and the
  metrics (`tinyactors.actors.spawned` and the rest). The demo chart has
  no failure and no `<log>`, so it sends no logs.

### Follow-up, 2026-09-25

- **Failure logs say why.** Found in otel-tui: a `<script>` that threw left
  one WARN log whose body was `error.execution`, with no reason and no
  action, and no `tinyactors.action.failed` at all.
  - Core wrote `SCRIPT` with the fault for a failed `<script>`, never
    `ACTION_FAILED`. It now writes both, like every other action. A
    record's fault carries its message, and `ACTION_FAILED` borrows the
    data its error event holds (core ADR 0067's status line points here).
  - The body is the message, as OTLP's log data model makes the body the
    human-readable part: `<script> in ready on reserve failed: Error:
    cannot reserve 50 items`, and `error.execution: Error: cannot reserve
    50 items`. The attributes add `exception.message` (OpenTelemetry's
    semantic convention), `scxml.action` and `scxml.action.id`,
    `scxml.fault.code` and `scxml.fault.message`. The reason is written
    whatever `values` says.
  - napi renders a thrown `Error` as `Error: message`; `JSON.stringify`
    gave `{}`.
- **Host metrics (section 7, and core ADR 0072 section 4).**
  - `tinyactors.pump.turn.duration` and `tinyactors.timers.lateness` are
    histograms with explicit buckets, in seconds. Each bucket keeps an
    exemplar: the latest sampled macrostep that ran in the turn, or the
    trace that set the timer.
  - `tinyactors.timers.overdue` is how far behind the earliest pending
    timer is.
  - `tinyactors.scheduler.runnable` and `.ready` are the run queues'
    lengths, counting entries a later turn skips.
  - `tinyactors.actors.quarantined`, `tinyactors.faults` by
    `tinyactors.fault.code`, and `tinyactors.messages.dead_lettered` by
    `tinyactors.dead_letter.reason`.
  - Quarantines and dead letters are WARN logs,
    `tinyactors.actor.quarantined` and `tinyactors.message.dead_lettered`,
    through the same rate limit.
  - Lateness is measured where a dispatched delayed send reaches the
    router or an I/O processor. A delayed send to `#_internal` stays in
    core and is not a host timer, so it is not measured.
  - The histograms live in a portable module (`src/host_metrics.{c,h}`),
    with a native test. Every metric is listed from the first snapshot.
- **The SDK example** with observable instruments is tested
  (`test/otel-metrics.js`), against `@opentelemetry/sdk-metrics` 2.11.0, a
  pinned dev dependency. The SDK has no asynchronous histogram, so the two
  histograms go through `metricsToOTLP` only.
- **The traced path.** The request's header is written into a gap before
  the spans, so taking a request no longer copies every span; event names
  are cached; short copies are inlined. Measured with mise's Node 22.23.2
  and Bun 1.4.1 (load average about 3 on 16 cores), median of three runs,
  ns per event:

  | | Untraced | Macrostep spans | Every record |
  |---|---|---|---|
  | Node, before | 614–616 | 1,182–1,183 | 2,090–2,129 |
  | Node, after | 634–661 | 1,121–1,227 | 2,064–2,178 |
  | Bun, before | 546–550 | 1,117–1,137 | not measured |
  | Bun, after | 522–531 | 1,099–1,112 | 2,106–2,134 |

  The machine was slower than when the targets were set: untraced was
  418 ns then. Over untraced, macrostep spans cost about 540 ns and every
  record about 1,450 ns, against targets of about 280 ns and 780 ns. The
  changes' gain is within the noise.
  - **Where the time goes** (macOS `sample`, macrostep spans only, ns per
    event over untraced): the encoder about 190, core about 120, copying
    about 80, V8 about 100, clock reads about 30. Core and V8 slow down
    broadly, not in one place: each turn writes about 350 KB of spans
    (338 bytes a macrostep span) and copies it into a fresh, zero-filled
    ArrayBuffer, which crowds the caches.
  - **Open point: the targets.** What would reach them is structural:
    hand the span buffer to JavaScript without the copy (an external
    ArrayBuffer returned to a small pool on finalize, which some runtimes
    refuse, and whose finalizer can outlive the system's allocator), or
    hand spans over in smaller chunks during a turn so they stay in cache,
    or slimmer spans in `summary`.
  - **Open point: Bun's budgets.** Bun is over both 40 ns budgets:
    `traceparent` +38 to +57 ns and sampled out +55 to +84 ns, before
    these changes as after. Node is within them (+32 to +39 and +19 to
    +43, the latter noisy). Taking the `traceparent` string out of
    JavaScript costs more on Bun; caching the last parsed text is the
    likely fix.

### Follow-up, 2026-09-26: what an installed sink costs at rest

The machine-keyed bench (`mise run bench`, which reports memory beside
throughput) showed that installing a sink, even with every macrostep
sampled out, cost about 270 native bytes per actor and 0.20 allocator
calls per event (Node 22, 1M actors, machine `a99e44a37e2e`). Neither was
per actor, and neither was in core; both were napi's:

- **The OTLP encoder's staging buffers kept their largest turn.** The span
  and log buffers were reset after each request but never shrunk. A turn
  that spawns N actors traces N bootstrap macrosteps (about 365 bytes of
  spans each under `summary`), so a million spawns in one turn left about
  336 bytes per actor in the "other" category for the system's life.
  Spawning in turns of 1,000 left 5 bytes per actor: it was the turn's
  size, not the population. Now `tna_otlp_end_turn()` runs at the end of
  every pump turn and frees a buffer past 1 MiB when it is more than four
  times a typical turn's use (an average over turns that wrote anything,
  moving an eighth of the way each such turn, taken before the current
  turn). A burst's buffer goes as its turn ends; steady turns, and the
  idle turns between them, keep theirs and allocate nothing. A first
  version freed any buffer past 1 MiB that a request left empty, which
  regrew it every turn under `full` at the default `messageBudget` (0.03
  calls per event); `28825dc` replaced it.
- **Trace parents were allocated one at a time.** Mail between actors keeps
  its trace parent out of line (napi ADR 0015 point 4), from
  `tna_free_list`, which allocated a record per take when empty. The first
  round of N traced messages made N allocator calls: the 0.20 per event
  the bench counted over five rounds. The free list now takes a chunk of
  as many records as are live (8 to 1,024), as envelopes already did, so
  that round costs about N/1,024 calls. Value boxes use the same list and
  gain the same. Steady state was, and stays, zero.

Measured with `mise run bench-compare 27d38c5 1000000` (2 alternating runs
each, medians, load about 2.7):

| Variant | Node native B/actor | Node allocs/event | Node ns/event | Bun native B/actor | Bun allocs/event | Bun ns/event |
|---|---|---|---|---|---|---|
| untraced | 328 → 328 | 0.00 → 0.00 | 446 → 445 | 328 → 328 | 0.00 → 0.00 | 388 → 387 |
| sampled out | 597 → 329 | 0.20 → 0.00 | 464 → 464 | 597 → 329 | 0.20 → 0.00 | 418 → 425 |
| `summary` | 597 → 329 | 0.20 → 0.00 | 922 → 909 | 597 → 329 | 0.20 → 0.00 | 798 → 820 |
| `summary` 10% | 597 → 328 | 0.20 → 0.00 | 514 → 504 | 597 → 328 | 0.20 → 0.00 | 458 → 450 |
| every record | 597 → 329 | 0.20 → 0.00 | 1,702 → 1,707 | 597 → 329 | 0.20 → 0.00 | 1,523 → 1,507 |

RSS per actor fell 11 to 14% with a sink installed, but stays above
untraced (Node 1,124 against 669): the burst's staging buffer is freed,
and the malloc behind it keeps the pages. Nothing moved outside the 5%
rule. `test/allocations.js` checks that a sink installed and sampled out,
and `summary` at 1%, make no more napi allocator calls than untraced after
warm-up, that the first round of messages adds only a few, and that an
idle sink keeps at most 1 MiB plus 16 bytes per actor over untraced after
50,000 spawns in one turn; each check fails against the old code.

