'use strict';

// The test-only OTLP/HTTP exporter (tools/otlp.js, napi ADR 0016) against an
// in-process receiver: the trace sink's bytes arrive as they are, as
// protobuf, and decode into one trace parented as it ran. Runs on Node and
// Bun.

const assert = require('node:assert/strict');
const http = require('node:http');
const { createSystem, statechart, decodeTraces, formatTraceparent } = require('..');
const { OTLPExporter } = require('../tools/otlp');

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const REQUEST_SPAN = '00f067aa0ba902b7';

// A collector that keeps every export it receives, as bytes.
function receiver() {
  const exports = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      exports.push({ path: request.url, type: request.headers['content-type'],
                     body: new Uint8Array(Buffer.concat(chunks)) });
      response.writeHead(200, { 'content-type': 'application/x-protobuf' });
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, exports, endpoint: `http://127.0.0.1:${server.address().port}` }));
  });
}

(async () => {
  const collector = await receiver();
  const exporter = new OTLPExporter({ endpoint: collector.endpoint });
  const system = createSystem();
  const sent = [];
  system.setTraceSink((bytes) => { sent.push(bytes); exporter.sink(bytes); },
                      { detail: 'full', resource: { 'service.name': 'otlp-test' } });
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
  const posted = await exporter.flush();
  collector.server.close();

  assert.equal(collector.exports.length, posted, 'one POST per turn with spans');
  for (const [index, { path, type, body }] of collector.exports.entries()) {
    assert.equal(path, '/v1/traces');
    assert.equal(type, 'application/x-protobuf');
    assert.deepEqual(body, sent[index], 'the bytes arrive as the sink got them');
  }
  const received = collector.exports.flatMap(({ body }) => decodeTraces(body));
  assert.equal(received[0].resource.attributes['service.name'], 'otlp-test');
  const traced = received.filter((span) => span.traceID === TRACE_ID);
  const macrostep = traced.find((span) => span.name === 'scxml.macrostep go');
  const micro = traced.filter((span) => span.parentSpanID === macrostep.spanID);
  assert.equal(macrostep.parentSpanID, REQUEST_SPAN, 'the macrostep sits under the request span');
  assert.deepEqual(micro.map((span) => span.name).sort(), ['scxml.microstep go', 'scxml.microstep next']);
  assert.equal(macrostep.kind, 'internal');
  assert.ok(macrostep.endTimeUnixNano >= macrostep.startTimeUnixNano);
  const first = micro.find((span) => span.name === 'scxml.microstep go');
  const raised = first.events.find((event) => event.name === 'scxml.raise');
  assert.ok(raised, 'the raise is an event of the first microstep');
  assert.equal(raised.attributes['scxml.event.name'], 'next');
  console.log('otlp.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
