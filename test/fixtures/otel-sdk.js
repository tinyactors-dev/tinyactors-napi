'use strict';

// The worked example in docs/tracing.md, case 2 (napi ADR 0016): the trace
// sink's bytes, decoded, handed to the official OpenTelemetry JS SDK's
// exporters as ReadableSpan objects. Kept here so test/otel-sdk.js runs the
// code the docs show; the SDK is a pinned dev dependency, never a runtime
// one. Our span IDs are kept, so parents and links stay exact.

const { decodeTraces } = require('../..');
const { SpanKind, SpanStatusCode, TraceFlags } = require('@opentelemetry/api');
const { resourceFromAttributes } = require('@opentelemetry/resources');

const KIND = { internal: SpanKind.INTERNAL, server: SpanKind.SERVER, client: SpanKind.CLIENT,
               producer: SpanKind.PRODUCER, consumer: SpanKind.CONSUMER };
const STATUS = { unset: SpanStatusCode.UNSET, ok: SpanStatusCode.OK, error: SpanStatusCode.ERROR };

// Nanoseconds since the epoch, as the SDK's HrTime: [seconds, nanoseconds].
const hrTime = (nanos) => [Number(nanos / 1000000000n), Number(nanos % 1000000000n)];

function context(traceId, spanId) {
  return { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: false };
}

/** The spans in `bytes` as the SDK's ReadableSpan objects. */
function toReadableSpans(bytes) {
  const resources = new Map();
  return decodeTraces(bytes).map((span) => {
    let resource = resources.get(span.resource);
    if (resource === undefined) {
      resource = resourceFromAttributes(span.resource.attributes);
      resources.set(span.resource, resource);
    }
    const start = hrTime(span.startTimeUnixNano);
    const end = hrTime(span.endTimeUnixNano);
    const own = context(span.traceID, span.spanID);
    return {
      name: span.name,
      kind: KIND[span.kind] ?? SpanKind.INTERNAL,
      spanContext: () => own,
      parentSpanContext: span.parentSpanID === undefined ? undefined : context(span.traceID, span.parentSpanID),
      startTime: start,
      endTime: end,
      duration: hrTime(span.endTimeUnixNano - span.startTimeUnixNano),
      status: { code: STATUS[span.status.code], message: span.status.message },
      attributes: span.attributes,
      links: span.links.map((link) => ({ context: context(link.traceID, link.spanID), attributes: link.attributes })),
      events: span.events.map((event) => ({ name: event.name, time: hrTime(event.timeUnixNano),
                                            attributes: event.attributes })),
      ended: true,
      resource,
      instrumentationScope: { name: span.scope.name, version: span.scope.version },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  });
}

module.exports = { toReadableSpans };
