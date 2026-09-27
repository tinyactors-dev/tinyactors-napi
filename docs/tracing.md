# Tracing

Core writes trace records (core ADR 0067). The addon turns them into
OpenTelemetry spans and hands you, once per pump turn, the spans that
ended as **OTLP protobuf**: one `Uint8Array` holding one
`ExportTraceServiceRequest` (napi ADR 0016). Any OTLP/HTTP collector takes
those bytes as they are. tinyactors depends on no telemetry package: where
the bytes go, and how, is yours.

```js
const { createSystem } = require('@tinyactors/node');

const system = createSystem();
system.setTraceSink(
  (bytes) => fetch('http://localhost:4318/v1/traces', {
    method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: bytes,
  }),
  { resource: { 'service.name': 'orders' } },
);

// A request that came in with a W3C traceparent: every macrostep it
// causes, in any actor and after any timer, lands in its trace.
system.post(actor, 'order', body, { traceparent: request.headers.traceparent });
```

Batching across turns, retries and compression are up to you; the bytes
of several turns are separate requests.

## Options

`setTraceSink(sink, options)` calls `sink(traces, logs)` once per pump
turn:
- `traces` is an OTLP trace request. It is empty when no span ended in the
  turn.
- `logs` is an OTLP logs request, or `undefined` when there are no logs.

Post each to the collector's `/v1/traces` and `/v1/logs`.

- `detail`: `"summary"` (default) gives a span per macrostep, lifecycle
  spans, and failures. `"decisions"` adds microsteps, guard conditions and
  raised events. `"full"` gives every kind the addon encodes.
- `kinds`: the record kinds wanted (`TRACE_KINDS`), overriding `detail`.
  Core builds no other record. Without a sink core builds nothing. The
  three `definition*` kinds (core ADR 0080) are for hosts that follow
  core's record stream; the addon reports definitions through the
  definition logs below instead, so no preset asks for them, and naming
  them here adds nothing to the output.
- `sample`: the ratio, 0 to 1 (default 1), of the traces this system
  starts that are sampled. It uses OpenTelemetry's consistent probability
  sampling, so other services agree on the decision. A `traceparent` from
  a caller keeps the caller's decision.
- `logs`: failures (an action that failed, an `error.*` raised, a run
  stopped for lack of memory) as WARN logs, and `<log>` as INFO. They are
  written whatever the sampling and the detail. On by default.
- `logLimit`: at most this many logs per definition and name per second
  (default 20). The next log that passes carries `tinyactors.suppressed`,
  the number dropped.
- `unsampled`: also trace macrosteps whose traceparent is not sampled.
- `resource`: resource attributes every request carries, strings only.
- `values`: event data and assigned values as JSON attributes, cut at
  `valueLimit` characters (default 256). Off by default: values may hold
  personal data.
- `parent`: `"cause"` (default) puts a macrostep under the step that
  caused it: the caller's span for a delivery with a traceparent, else the
  sending step. `"link"` makes each macrostep a trace root linked to its
  cause instead.
- `seed`: a bigint. A delivery or spawn without a traceparent starts a new
  trace with a random ID; with a seed the IDs are a fixed sequence, for
  tests.

Replacing or removing a sink ends the spans still open (a macrostep that
paused between turns, say), marked `scxml.incomplete`, and hands them to
the previous sink first.

## At 3am: turning it up without a restart

- `system.configureTraces({ detail, kinds, sample })` changes the installed
  sink in place. Open spans are kept.
- `system.watchTraces({ sessions, families, addresses })` traces what
  matches in full and sampled, whatever `sample` says, until its handle's
  `stop()`. It matches the actors of these sessions or addresses, and
  every actor of these definition families; a watched family's spawns are
  watched from their bootstrap. What a watched delivery causes, such as
  internal events, sends to other actors and delayed sends, is watched
  too.

A production system can run with `sample: 0`: failures still arrive as
logs, and `watchTraces` shows the actor someone is asking about.

## Metrics

`system.metrics()` returns plain data: `{ startTime, time, system,
metrics }`, where each metric is `{ name, unit, kind, points }`. A `sum`
or `gauge` point is `{ attributes, value }`; a `histogram` point is
`{ attributes, count, sum, min, max, bounds, buckets, exemplars }`, with
explicit bucket bounds. Every metric is listed from the first snapshot on,
so a reader can register its instruments once.

**Core's counters** (core ADR 0072), per definition family and revision:
`tinyactors.actors.spawned` and the rest of the lifecycle,
`tinyactors.events.taken` and `.ignored` (by `scxml.event.type`),
`tinyactors.errors` (by `scxml.error.type`), sends, timers, invocations,
and `tinyactors.actors.occupancy`: how many actors are in each state (by
`scxml.state`).

**What only the host knows** (napi ADR 0017 section 7):

| Metric | Kind | What it answers |
|---|---|---|
| `tinyactors.pump.turn.duration` (s) | histogram | Is the host keeping up? A turn that takes long blocked the event loop. Exemplars link a bucket to the trace of a sampled macrostep that ran in such a turn. |
| `tinyactors.scheduler.runnable`, `.ready` | gauge | How many actors wait for a turn (queue lengths, counting entries a later turn skips). |
| `tinyactors.timers.lateness` (s) | histogram | How late each delayed send fired, to an actor or an I/O processor. Exemplars link to the trace that set the timer. |
| `tinyactors.timers.overdue` (s) | gauge | How far behind the earliest pending timer is now; one that keeps growing is not being served. |
| `tinyactors.actors.quarantined` | gauge | Actors taken out of scheduling after a fault (ADR 0008). |
| `tinyactors.faults` | sum | Faults by `tinyactors.fault.code`. |
| `tinyactors.messages.dead_lettered` | sum | Dead letters by `tinyactors.dead_letter.reason`. |
| `tinyactors.messages.queued`, `.delivered`, `tinyactors.memory.usage` | gauge, sum, gauge | Mail and memory. |
| `tinyactors.definitions` | gauge | Definitions alive, by `tinyactors.definition.origin` (`host`: `define()`; `nested`: an inline child compiled with its parent; `invoke`: chart text compiled when an `<invoke>` ran) and `tinyactors.definition.state` (`live`, or `retired` but still used by a child or an actor). |
| `tinyactors.definitions.registered`, `.retired`, `.freed` | sum | The definition lifecycle (core ADR 0079). A `registered` count that keeps climbing while `freed` keeps pace is **churn**: an invoke compiling new chart text for every child. A `registered` count that climbs while `freed` does not is a leak. |

No metric attribute names one actor; which actors, is what `inspect()`
and a walk over actors answer. Post `metricsToOTLP(system.metrics(), {
resource })` to `/v1/metrics` at your export interval.

With the official OpenTelemetry metrics SDK, report the sums and gauges
from observable instruments, one snapshot per collection. The SDK has no
asynchronous histogram, so send the two histograms with `metricsToOTLP`
(tested in `test/otel-metrics.js`, from `test/fixtures/otel-metrics.js`):

```js
function observeMetrics(meter, system) {
  const instruments = new Map();
  for (const metric of system.metrics().metrics) {
    if (metric.kind === 'histogram') continue;
    const options = { unit: metric.unit };
    instruments.set(metric.name, metric.kind === 'sum'
      ? meter.createObservableCounter(metric.name, options)
      : meter.createObservableGauge(metric.name, options));
  }
  meter.addBatchObservableCallback((result) => {
    for (const metric of system.metrics().metrics) {
      const instrument = instruments.get(metric.name);
      if (instrument === undefined) continue;
      for (const point of metric.points) result.observe(instrument, point.value, point.attributes);
    }
  }, [...instruments.values()]);
}
```

## Logs

The sink's second argument holds OTLP logs, each tied to its trace and
span where it has one, and rate-limited per definition and name (`logLimit`
per second, then one log that says how many were suppressed):

| Log | Severity | Body, for example |
|---|---|---|
| `scxml.log` | INFO | `order received: "3 items, 42 EUR"` (a `<log>`) |
| `tinyactors.action.failed` | WARN | `<script> in ready on reserve failed: Error: cannot reserve 50 items` |
| `tinyactors.error.raised` | WARN | `error.execution: Error: cannot reserve 50 items` |
| `tinyactors.run.stopped` | WARN | `the run stopped: an allocation failed (ADR 0070)` |
| `tinyactors.actor.quarantined` | WARN | `actor quarantined: deliver failed: invalid` |
| `tinyactors.message.dead_lettered` | WARN | `arm dead-lettered: not-found` |
| `tinyactors.definition.registered`, `.freed` | DEBUG | `registered order/invoke 3f2a9c01d4e7b650 (invoke)` |
| `tinyactors.definition.retired` | INFO | `retired order v1 (host)` |

The definition logs carry `tinyactors.definition.family`, `.revision`,
`.origin` and `.id`. They are rate-limited per **family** and event, not
per definition, so a family that registers a new definition for every
child writes at most `logLimit` of them a second, and a count of the
rest; they are DEBUG and INFO, so a backend that keeps WARN and above
drops them, while the metrics above keep the full counts. They go
wherever the other logs go, and `logs: false` stops them too. They come
from core's definition sink (core ADR 0079), which fires whatever the kind
mask or sampling, so they are the one OTLP path for definitions; core's
definition records (ADR 0080) never reach the output a second time.

A failure says what failed and why in its body, and in attributes for
filtering: `exception.message` (the thrown value, an `Error` as
`Error: message`), `scxml.action` and `scxml.action.id`, `scxml.fault.code`
and `scxml.fault.message`, `scxml.state`, the step key and the
definition. The reason is written whatever `values` says: at 3am it is
the one value you cannot do without.

## What the spans say

- A **macrostep** is a span, `scxml.macrostep <event>`; its **microsteps**
  are child spans, `scxml.microstep <event>` or `(eventless)`.
- Every other record is a **span event** on the step it happened in:
  `scxml.condition`, `scxml.assign`, `scxml.raise`, `scxml.send`,
  `scxml.data`, `scxml.error`, and the rest. A record with a fault carries
  `scxml.fault.code`, and `scxml.fault.message` with what went wrong, in
  the words of the failure's log (a thrown `Error` as `Error: message`).
- **Lifecycle** records (`scxml.spawned`, `scxml.finished`, ...) are spans
  of no duration.
- Span IDs are derived from step keys, the same way in every host
  (`stepSpanID`). Transitions and actions are named through the
  definitions: `scxml.transition` reads like
  `idle → busy on order.placed [guarded]`, `scxml.action` like
  `<assign> in onentry of busy`; `scxml.transition.id` and
  `scxml.action.id` keep the compiled IDs.
- I/O processors and invokers get `request.traceparent`, naming the step
  that sent or invoked, to pass on to what they call.

The full attribute table is in napi ADR 0016's implementation notes;
`scxml.fault.message` on span events came later, for the debug adapter's
exception texts.

## Objects instead of bytes

`decodeTraces(bytes)` reads the bytes back into span objects (`traceID`,
`spanID`, `parentSpanID`, `name`, times, `attributes`, `events`, `links`,
`status`, `resource`, `scope`), with no dependency. Use it to check
properties in JavaScript, or to feed a pipeline that wants objects.

## With the official OpenTelemetry JS SDK

tinyactors does not depend on the SDK. If your application runs it, you
are in one of two cases.

**1. Both send to the same collector.** This needs no glue. Your SDK
exports your spans; you post the trace sink's bytes to the same OTLP
endpoint. To put both in one trace, pass the active span as the
traceparent:

```js
const { context, trace } = require('@opentelemetry/api');
const { formatTraceparent } = require('@tinyactors/node');

const active = trace.getSpanContext(context.active());
system.post(actor, 'order', body, {
  traceparent: formatTraceparent({ traceID: active.traceId, spanID: active.spanId,
                                   flags: active.traceFlags }),
});
```

Our macrosteps then carry your trace ID and sit under your span, and your
sampling decision carries over through the sampled flag. Your SDK's
resource does not apply to bytes it never sees, so set `resource` on
`setTraceSink`.

**2. Our spans go through the SDK's pipeline** (its processors, or an
exporter that does not speak OTLP). The SDK cannot take in OTLP bytes, so
decode them and hand the SDK `ReadableSpan` objects. This keeps our span
IDs, so parents and links stay exact (recreating the spans with the SDK's
tracer would give them new IDs). The example below is tested in
`test/otel-sdk.js` against pinned SDK versions (`@opentelemetry/api`
1.9.1, `@opentelemetry/sdk-trace-base` 2.11.0,
`@opentelemetry/resources` 2.11.0,
`@opentelemetry/exporter-trace-otlp-http` 0.222.0):

```js
const { decodeTraces } = require('@tinyactors/node');
const { SpanKind, SpanStatusCode, TraceFlags } = require('@opentelemetry/api');
const { resourceFromAttributes } = require('@opentelemetry/resources');

const KIND = { internal: SpanKind.INTERNAL, server: SpanKind.SERVER, client: SpanKind.CLIENT,
               producer: SpanKind.PRODUCER, consumer: SpanKind.CONSUMER };
const STATUS = { unset: SpanStatusCode.UNSET, ok: SpanStatusCode.OK, error: SpanStatusCode.ERROR };
const hrTime = (nanos) => [Number(nanos / 1000000000n), Number(nanos % 1000000000n)];
const context = (traceId, spanId) => ({ traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: false });

function toReadableSpans(bytes) {
  const resources = new Map();
  return decodeTraces(bytes).map((span) => {
    let resource = resources.get(span.resource);
    if (resource === undefined) {
      resource = resourceFromAttributes(span.resource.attributes);
      resources.set(span.resource, resource);
    }
    const own = context(span.traceID, span.spanID);
    return {
      name: span.name,
      kind: KIND[span.kind] ?? SpanKind.INTERNAL,
      spanContext: () => own,
      parentSpanContext: span.parentSpanID === undefined ? undefined : context(span.traceID, span.parentSpanID),
      startTime: hrTime(span.startTimeUnixNano),
      endTime: hrTime(span.endTimeUnixNano),
      duration: hrTime(span.endTimeUnixNano - span.startTimeUnixNano),
      status: { code: STATUS[span.status.code], message: span.status.message },
      attributes: span.attributes,
      links: span.links.map((link) => ({ context: context(link.traceID, link.spanID), attributes: link.attributes })),
      events: span.events.map((event) => ({ name: event.name, time: hrTime(event.timeUnixNano),
                                            attributes: event.attributes })),
      ended: true,
      resource,
      instrumentationScope: { name: span.scope.name, version: span.scope.version },
      droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
    };
  });
}

// For example, with the SDK's exporter:
system.setTraceSink((bytes) => exporter.export(toReadableSpans(bytes), () => {}));
```

## Looking at a trace in otel-tui

```text
mise exec aqua:ymtdzzz/otel-tui -- otel-tui    # in another terminal
mise run otel-demo
```

The demo sends one order through three actors; its trace shows up under
`POST /orders`. `OTEL_EXPORTER_OTLP_ENDPOINT` picks another collector. If
otel-tui cannot bind its internal metrics port (8888), start it with
`--disable-internal-metrics`. `tools/otlp.js`, the exporter the demo and
the tests use, is not part of the package.
