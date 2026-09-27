# ADR 0016: Traces leave the addon as OTLP protobuf

**Status:** Accepted and implemented. See the implementation notes for where the code differs from the text. Supersedes ADR 0015 points 1 and 3, and relaxes one constraint the user set for ADR 0015 (see "Constraints"). Revised while Proposed, 2026-09-24: the encoder is written against core's public header and a small host interface, so any host can link it (point 3); trace IDs come from that interface (point 4); a section on using the official OpenTelemetry SDK; lifecycle span IDs (point 2). Research: [`docs/research/trace-handoff-formats.md`](../../../docs/research/trace-handoff-formats.md). Revised by ADR 0017 (the sink receives logs beside traces; `traceparent` is parsed and trace IDs are made by core; open spans are indexed by session).
**Date:** 2026-09-24

## Context

ADR 0015 hands JavaScript one array of plain record objects per pump turn,
and `lib/tracing.js` maps them to span-shaped objects. Building those
objects costs nearly everything tracing costs. On the tracing bench, core
writing every record kind runs at 2.13M events/s. Handing the records over
as objects drops that to 0.20M, and mapping them to spans to 0.15M. Each
record costs one `napi_create_object` and ten to twenty property writes.

The user's goal is a format that telemetry tooling reads as it is, so the
JavaScript host only has to move bytes. Their constraints so far:

1. **lib/ depends on no telemetry package,** not even as an optional or
   peer dependency.
2. **tinyactors is a library, and users bring their own exporter.**
3. **The C code does not do the export** (ADR 0015 point 1: "C only
   hooks").

The research note compares four formats and measures a prototype on the
same bench and machine (medians, every record kind):

| Hand-off | Events/s |
|---|---|
| Objects (ADR 0015) | 0.19M |
| Objects mapped to spans | 0.13M |
| A raw copy of the records into one ArrayBuffer | 1.3M |
| **OTLP protobuf written in C** | **0.83M** (458 bytes per event) |

The prototype's bytes, posted by `fetch` and untouched, were accepted by
otel-tui (HTTP 200), which showed the traces with their spans.

## Decision

1. **One format out: OTLP protobuf.** The trace hook receives, per pump
   turn, one `Uint8Array` holding one `ExportTraceServiceRequest`: the spans
   that ended in that turn. It can be posted to any OTLP/HTTP `/v1/traces`
   endpoint with `Content-Type: application/x-protobuf` as it is, written to
   a file, or handed to a user. The hook is
   `setTraceSink(sink, { kinds, unsampled, resource })`. `resource` holds
   the resource attributes (`service.name`, ...), encoded once when the sink
   is installed.

2. **The mapping is lossless and specified once.**
   - A macrostep is a span.
   - A microstep is its child span.
   - Every other record kind is a span event on the step it happened in.
   - Lifecycle records are spans with no duration.

   Every field of every record is an attribute, named with ADR 0067's
   `scxml.*` names, and a table in this ADR's implementation notes lists
   them. Span IDs are `ta_step_key_span_id()`. OTLP requires span IDs to be
   unique within a trace, and today two lifecycle records of the same kind
   in one session (two `LOADED`, say) derive the same one (ADR 0015 open
   point 3). Core fixes that first: each session gets a lifecycle counter,
   kept in the session image, and the span-ID derivation includes it, the
   same way in every host. Parents follow ADR 0067
   section 6: the cause, or a link when `parent: "link"`. The mapping
   `lib/tracing.js` does today is the reference, and its gaps become
   requirements. For example, it drops records that fall outside an open
   macrostep.

3. **C encodes; it does not export.** A portable C module with no
   Node-API, next to `src/traces.c`, does three things: maps records to
   spans, keeps the spans that are still open across turns, and writes
   protobuf with a small hand-written writer. It depends on nothing outside
   the repository. HTTP, retries, batching across turns, gzip and where the
   bytes go all stay in JavaScript and belong to the user.

   **Any host can link it.** The encoder uses only core's public header
   (`tinyactors.h`) and a small host interface of its own, with no napi
   internals:
   - **a clock:** wall time in Unix nanoseconds, since core has only
     logical time;
   - **names:** the lookups of point 5, through core's public API;
   - **trace IDs:** a source of random 16-byte IDs (point 4);
   - **values** (optional): text for a value, for `values: true` (point 6).

   napi implements that interface in its own files. The encoder's source
   is not in `NODE_API_SOURCES` (`mise/lib/compile.rb`), so `test-native`
   fails if Node-API ever reaches it, and it has native tests of its own. It stays in
   napi's directory until a second host needs it. Then it moves to a place
   every host links. That may be the host kernel, but it need not be: the
   database hosts (the SQLite and PostgreSQL proposals) won't use the
   kernel, because their mailboxes and timers are tables, and they will
   want the same traces. Where it moves is decided when that host
   starts.

4. **A trace always has an ID.** When a sink is installed and a delivery or
   spawn carries no `traceparent`, napi starts a trace with a random trace
   ID. Core never generates IDs; the host does. Core then propagates the
   context as usual. This replaces the step-derived trace IDs and the
   unbounded span-to-trace map in `TraceSpans`. The IDs come from the host
   interface's source (point 3). napi's source is the operating system's
   random bytes. `setTraceSink` takes a `seed` for tests, which makes the
   IDs a fixed sequence, so golden bytes and repeated runs compare
   equal.

5. **Names come from core, cached per definition.** Event names, state
   IDs, and the transition, action and expression facts of core ADR 0071
   are looked up the first time a definition is seen and kept until it is
   freed. The labels follow ADR 0071 section 3: the host's format.

6. **Values stay out by default.** Event data and assigned values are
   JavaScript values. With `values: true`, the encoder renders them through
   the data model's `value_text` at the end of the turn, cut to a limit.
   That costs one call into JavaScript per value, which is why it is off by
   default, as it is today.

7. **Objects for those who need them: a decoder in lib/.**
   `decodeTraces(bytes)` is a small protobuf reader in `lib/` with no
   dependency. It returns span-shaped objects, with the same shape
   `TraceSpans` produces today, for users who feed an in-process pipeline
   (span processors, exporters that don't speak OTLP) or who check
   properties in JavaScript. The OpenTelemetry JS SDK has no way to take in
   OTLP bytes, so these users need objects. Only those who decode pay for
   them.

8. **`tools/otlp.js` shrinks to a POST.** The test exporter and the
   otel-tui demo post the hook's bytes. The in-process receiver in
   `test/otlp.js` decodes them with `decodeTraces`.

## Using the official OpenTelemetry SDK

tinyactors does not depend on the SDK, and posting the hook's bytes needs
no SDK at all: one `fetch` to `/v1/traces` is the whole export. A user who
also runs the official OpenTelemetry JS SDK is in one of three cases.

1. **Both send to the same collector.** This is the expected case, and it
   needs no glue. The SDK exports the user's own spans, and the user
   posts our bytes to the same OTLP endpoint.
   - **One trace:** to join the two into one trace, the user passes the
     active span's context as `traceparent` on `post`, `send` and `spawn`.
     Our spans then carry the user's trace ID and name the user's span as
     parent.
   - **Sampling:** the SDK's sampling decision carries over through the
     sampled flag in `traceparent`, which core honours (ADR 0067
     section 6).
   - **Resource:** the SDK's resource (`service.name`, ...) does not apply
     to bytes the SDK never sees, so the user sets `resource` on
     `setTraceSink` (point 1).
2. **Our spans go through the SDK's pipeline:** its span processors, its
   sampler, or an exporter that does not speak OTLP. The SDK cannot take
   in OTLP bytes, and it has no public decoder. The route is
   `decodeTraces(bytes)` (point 7), then objects shaped like the SDK's
   `ReadableSpan`, handed to the SDK's exporter or processor. Our span IDs
   are kept, so the links between spans hold. Recreating the spans through
   the SDK's tracer would give them new IDs and break those links, so the
   docs advise against it.
3. **An in-process consumer that isn't OpenTelemetry,** such as a
   verifier, reads `decodeTraces` output directly. The lossless mapping
   (point 2) is its contract.

**The docs carry worked examples, not a dependency.** `docs/tracing.md`
shows case 1: posting the bytes, and passing the SDK's active context as
`traceparent`. It also shows case 2: `decodeTraces` output turned into
`ReadableSpan` objects and exported by the SDK's OTLP exporter. The case 2
example is tested in `test/`, against a pinned SDK version installed as a
**dev** dependency only, on Node and Bun, so an SDK change that breaks it
is noticed. `package.json`'s runtime `dependencies` stay empty.

## Alternatives

- **Keep objects (ADR 0015).** It is the slowest by six times, and
  JavaScript still has to encode the spans afterwards.
- **OTLP JSON.** It is the same work in C with a payload two to three times
  larger, and receivers only SHOULD accept it. `JSON.parse` would give
  cheap objects, but so does the decoder in point 7, for those who want
  them. Not measured.
- **OTel Arrow (OTAP).** Its specification is a Draft. It runs only over
  gRPC bidirectional streaming, with dictionary state kept per stream. It
  needs an Arrow IPC writer, and a collector with the contrib receiver in
  front of any viewer; otel-tui doesn't take it. It fits links between
  collectors, not our edge.
- **A custom columnar layout with accessors in JavaScript.** It has the
  cheapest hand-off (1.3M, measured with unpacked structs). But no tool
  reads it, every consumer that wants spans still has to map and encode in
  JavaScript, and every language host has to repeat the layout and the
  mapping. It is a second format to keep in step with core, where OTLP is a
  format others already maintain.
- **Put the encoder in core.** Core is freestanding and has no clock, and
  its sink is already the extension point (ADR 0067). Core ships only
  trivial implementations of its interfaces (ADR 0057).

## Constraints

- **Kept: no telemetry dependency.** The writer and the decoder are
  hand-written, and `package.json` gains nothing.
- **Kept, in a narrower sense: users bring their own exporter.** Users
  choose where the bytes go and how, and can decode them into objects.
  What they can no longer do is receive raw records in JavaScript with no
  span mapping. The OTLP output is the only format. The mapping has to be
  lossless so that nothing is lost by that.
- **Relaxed: "C only hooks".** C now knows OTLP's span model and wire
  format. It still does no export: no transport, no retries, no policy. The
  user accepted this relaxation on 2026-09-24, together with OTLP as the
  only output and random trace IDs in napi.

## Relation to other decisions

- **ADR 0015:** points 1 (plain records) and 3 (`TraceSpans` as the output)
  are superseded. Points 2 (the mask decides what is built), 4
  (`traceparent` in and out) and 5 (our own export is for testing) stand.
  Its open point 1 (the cost of objects) is what this ADR answers.
- **Core ADR 0067:** unchanged. The encoder is a sink adapter over its
  records. Its attribute names and span-ID derivation are what the encoder
  writes.
- **Core ADR 0071:** provides the names in point 5. Until it lands,
  transitions, actions and expressions cross as numbers.
- **The host kernel** (`docs/proposals/host-kernel.md`): the encoder has
  no Node-API in it and depends only on core's public header and its own
  host interface (point 3), so it can move into the kernel, or into a
  small library of its own, whichever the second host needs. A browser,
  Python or database host then emits the same bytes. A kernel host could
  implement the clock through the kernel's pump-driver interface.
- **Core ADR 0067, open points:** the mapping is lossless over the records
  core writes. Three kinds of events still leave no record: an internal
  event that enables no transition, events queued outside a run, and
  autoforwarding. They show up in OTLP only once core records them. The
  lifecycle span-ID collision is fixed as part of this ADR (point 2).

## Consequences

- Tracing costs about four to six times less in napi. Once the encoder is
  optimized (constant keys encoded in advance, names cached, sizes computed
  before writing), the prototype's 0.83M events/s should rise.
- `setTraceSink`'s callback receives bytes, not records. Every current
  caller changes (AGENTS.md: change APIs in place). `TraceSpans` is
  removed. `decodeTraces` takes its place for users who want objects.
- The addon grows by the encoder: a few hundred lines of portable C with
  native tests, which check golden bytes for small charts and round trips
  through `decodeTraces`.
- A verifier written in JavaScript reads decoded spans. The mapping table
  in the implementation notes is its contract.

## Testing (when implemented)

- **Native tests:** golden bytes for small charts, and the encoder's open
  spans across turns (a macrostep that pauses between turns).
- **JavaScript tests, on Node and Bun:**
  - `decodeTraces` of the hook's bytes gives the spans the mapping table
    says, one for one with the records core wrote, with nothing lost;
  - the bytes pass a strict protobuf decode;
  - posting them to the in-process receiver works.
- **Bench:** `test/bench/tracing.js` reports the OTLP hand-off next to
  untraced.
- **SDK example:** the case 2 example from "Using the official
  OpenTelemetry SDK" runs against a pinned SDK dev dependency, on Node and
  Bun.
- **Lifecycle span IDs:** core golden values show that two `LOADED`
  records of one session get different span IDs, including across an
  image.
- **By hand:** `mise run otel-demo` shows the demo in otel-tui.

## Implementation notes

Implemented in `b1fcac5` (core: lifecycle keys), `7effa89` (the encoder),
`2ca32f7` (the hook, `decodeTraces`, the tools) and `ee14770` (the SDK
example and docs).

### The mapping (point 2)

| Record | OTLP |
|---|---|
| `MACROSTEP_BEGIN` | opens span `scxml.macrostep <event>` (`bootstrap` for macrostep 1 with no event, `(no event)` otherwise); ID = step key (session, macrostep, 0); parent = the cause's span, or a link with `parent: "link"` |
| `MICROSTEP` | ends the open microstep and opens child span `scxml.microstep <event>` or `(eventless)`; ID = (session, macrostep, microstep) |
| `MACROSTEP_END` | adds `scxml.state` and `scxml.state.id` (the configuration) and ends the macrostep and its open microstep |
| `SPAWNED`, `LOADED`, `UNLOADED`, `FINISHED`, `DESTROYED` | span `scxml.<kind>` of no duration; ID = the lifecycle key (session, 0, n); parent = its cause |
| every other kind | span event `scxml.<name>` on the open microstep when the record's microstep is that one, else on the macrostep. Names: `condition`, `raise`, `data`, `assign`, `script`, `foreach`, `error` (ACTION_FAILED), `send`, `cancel`, `invoke`, `invoke.cancel`, `paused`, `resumed`, `stopped` |

Span attributes: `scxml.session_id` (decimal text), `scxml.macrostep`,
`scxml.actor` (`slot:generation`), `scxml.definition`, `scxml.time`
(logical time); on a macrostep also the event attributes below,
`scxml.cause.session_id`/`.macrostep`/`.microstep` and
`scxml.trace.flags`; on a microstep also `scxml.microstep`,
`scxml.transition` (labels) and `scxml.transition.id`, and
`scxml.state.exited`/`.entered`/`.history` with their `.id` twins.

Event attributes: `scxml.position`, `scxml.state` (+ `.id`),
`scxml.transition` (+ `.id`), `scxml.action` (+ `.id`), `scxml.iteration`,
`scxml.microstep`, `scxml.time`, `scxml.expression.id`, `scxml.result`,
`scxml.data.name`, `scxml.send_id`, `scxml.invoke_id`,
`scxml.fault.code`, `scxml.fault.detail`, `scxml.value` (with `values`),
`scxml.final_state`, the cause attributes, and the event's
`scxml.event.name`, `.type`, `.sendid`, `.invokeid`, `.data` (with
`values`). A record with a fault, and ACTION_FAILED, sets its span's status
to error. A span still open when its session unloads or is destroyed, or
when the sink is replaced, ends with `scxml.incomplete: true`; a record
for a macrostep whose BEGIN the encoder never saw opens
`scxml.macrostep (continued)` with `scxml.continued: true`, so no record
is dropped.

### Where the code differs from the text

- **Lifecycle keys (point 2).** Core gives every lifecycle record the key
  (session, 0, n), where n counts the session's lifecycle records from 1
  and is kept in the session image. FINISHED is a lifecycle record too
  (it had the key of the microstep that finished, which collided with
  that microstep's span); it names that step as its cause. Restoring an
  image skips the ordinal the UNLOADED written after the capture takes.
  Core's ADR 0067 has a status-line pointer. Session images are in-memory
  handles, so there was no serialized format version to change. The
  counter sits in padding: `ta_actor` stays 232 bytes.
- **The host interface (point 3)** is a clock, a trace-ID source and
  optional value text. Names are not a host call: the encoder reads them
  through core's public lookups directly (ADR 0071), which every host has.
- **Values (point 6)** are rendered when the record is written, inside
  the core call, by `JSON.stringify` through the host interface, not at
  the end of the turn: the record's value is borrowed only for the call,
  and keeping it would mean retaining every value until the turn ends.
- **Names are cached per definition** for transitions and actions, in the
  encoder's own table; state names are core's stored text and need no
  cache. Constant attribute keys are copied from literals rather than
  encoded in advance; sizes are computed before every write.
- **Trace IDs (point 4)** are started for `post`, `send` and `spawn`
  without a traceparent (the OS's random bytes, `arc4random_buf` or
  `getrandom`; SplitMix64 from `seed`). Events a JavaScript service or
  I/O processor hands back arrive without a context; their spans get a
  fresh trace ID from the encoder (see open points).
- **`setTraceSink`** returns the bytes of the spans it ended to the
  previous JavaScript sink; the native method returns them to `lib/`.
- **`decodeTraces`** returns each span with its `resource` and `scope`
  (shared objects), and times both as milliseconds and as nanosecond
  bigints.
- **The demo** posts the host's own `POST /orders` span as one OTLP JSON
  request beside the protobuf, as an HTTP handler with its own exporter
  would.

### Numbers

`test/bench/tracing.js`, 100,000 actors, every record kind unless said
(Node 26.10 / Bun 1.4.1, medians):

| | Node | Bun |
|---|---|---|
| Untraced | 2.26–2.31M events/s | 2.79M |
| Macrostep records only | 0.99–1.02M | 1.09M |
| **Every record, OTLP bytes (this ADR)** | **0.62M** | **0.62M** |
| Every record, then `decodeTraces` of each batch | 0.11M | 0.10M |
| Before: record objects (ADR 0015) | 0.19M | |
| Before: objects mapped to spans | 0.13M | |
| Prototype encoder (research note) | 0.83M | |

That is 3.3 times the object hand-off and 4.8 times the path that ended in
spans. OTLP bytes per event: 1110 (the prototype's 458 had fewer
attributes; the mapping is lossless now). Core bytes per idle actor: 281
untraced, 283 with a sink.

### Open points

1. **Events handed back by services start no trace.** An invoker's or
   I/O processor's reply carries no trace context, so its macrostep's
   spans get a fresh trace ID from the encoder, unconnected to the
   request that caused the call. Carrying `request.traceparent` back on
   the reply would join them.
2. **Throughput below the prototype.** 0.62M against 0.83M, for 2.4 times
   the bytes. Pre-encoding constant keys, and optional attribute sets (the
   `.id` twins, the logical time) would narrow it.
3. **Open spans are a linear array**, searched from the end. That is
   fast while few macrosteps are open across turns; very many paused
   actors would make it slow, and would want a map.
4. **The name cache never evicts.** Definition IDs are generational, so a
   freed definition's entries are never wrong, only kept.

