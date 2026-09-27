'use strict';

// The official OpenTelemetry JS SDK takes our spans (napi ADR 0016, case 2
// in docs/tracing.md): decoded and turned into ReadableSpan objects by
// test/fixtures/otel-sdk.js, they pass through the SDK's in-memory exporter
// and its OTLP/HTTP exporter with their IDs and parents intact. The SDK is
// a pinned dev dependency. Runs on Node and Bun.

const assert = require('node:assert/strict');
const http = require('node:http');
const { createSystem, statechart, formatTraceparent } = require('..');
const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { ExportResultCode } = require('@opentelemetry/core');
const { toReadableSpans } = require('./fixtures/otel-sdk');

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const REQUEST_SPAN = '00f067aa0ba902b7';

function receiver() {
  const bodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push({ type: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const exported = (exporter, spans) => new Promise((resolve) => exporter.export(spans, resolve));

(async () => {
  const batches = [];
  const system = createSystem();
  system.setTraceSink((bytes) => batches.push(bytes), { detail: 'full', resource: { 'service.name': 'sdk-example' } });
  const definition = system.define(
    statechart({ family: 'relay', revision: 'v1' })
      .state('idle', (s) => s.on('go', (t) => t.target('busy').raise('next')))
      .state('busy', (s) => s.on('next', (t) => t.target('idle'))),
  );
  const actor = system.spawn(definition);
  await system.flush();
  system.post(actor, 'go', undefined, { traceparent: formatTraceparent({ traceID: TRACE_ID, spanID: REQUEST_SPAN }) });
  await system.flush();
  system.close();
  const spans = batches.flatMap((bytes) => toReadableSpans(bytes));

  // The SDK's in-memory exporter keeps them as they are.
  const memory = new InMemorySpanExporter();
  const result = await exported(memory, spans);
  assert.equal(result.code, ExportResultCode.SUCCESS);
  const kept = memory.getFinishedSpans();
  const go = kept.find((span) => span.name === 'scxml.macrostep go');
  assert.equal(go.spanContext().traceId, TRACE_ID);
  assert.equal(go.parentSpanContext.spanId, REQUEST_SPAN);
  assert.equal(go.resource.attributes['service.name'], 'sdk-example');

  // Its OTLP/HTTP exporter serializes them, IDs and parents intact.
  const collector = await receiver();
  const otlp = new OTLPTraceExporter({ url: `${collector.url}/v1/traces` });
  const sent = await exported(otlp, spans);
  await otlp.shutdown();
  collector.server.close();
  assert.equal(sent.code, ExportResultCode.SUCCESS, sent.error?.message);
  assert.equal(collector.bodies.length, 1);
  const request = JSON.parse(collector.bodies[0].body);
  const received = request.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
  assert.equal(received.length, spans.length);
  const macrostep = received.find((span) => span.name === 'scxml.macrostep go');
  assert.equal(macrostep.traceId, TRACE_ID);
  assert.equal(macrostep.spanId, go.spanContext().spanId);
  assert.equal(macrostep.parentSpanId, REQUEST_SPAN);
  console.log('otel-sdk.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
