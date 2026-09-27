'use strict';

// Sends one traced request through three actors to an OTLP/HTTP collector,
// such as otel-tui, so its trace can be looked at (ADR 0015). Run it with
// `mise run otel-demo` while otel-tui runs. OTEL_EXPORTER_OTLP_ENDPOINT
// picks the collector (default http://localhost:4318).
//
// The flow: a gateway takes an order, asks the inventory to reserve and
// the payments to charge, and confirms once both answered. The request
// arrives with a traceparent, as an HTTP handler would pass it on, so every
// macrostep it causes lands in one trace under the request's span.
//
// Logs: each actor writes a <log> (INFO) at the steps an operator would look
// for, and a second request orders more than the inventory holds, so its
// <script> throws and the failure arrives as a WARN log in its own trace.
// In otel-tui, the logs view lists them, and each one opens the trace and
// span it was written in.

const { randomBytes } = require('node:crypto');
const { createSystem, statechart, formatTraceparent, metricsToOTLP } = require('..');
const { OTLPExporter } = require('./otlp');

function charts(system) {
  const gateway = system.define(
    statechart({ family: 'gateway', revision: 'v1' })
      .data('answers', 0)
      .state('idle', (s) =>
        s.on('order', (t) =>
          t
            .log('order received', ({ event }) => `${event.data.items} items, ${event.data.amount} EUR`)
            .target('waiting')
            .send('reserve', (m) => m.to('#_actor_inventory/main').data(({ event }) => event.data))
            .send('charge', (m) => m.to('#_actor_payments/main').data(({ event }) => event.data)),
        ),
      )
      .state('waiting', (s) => {
        s.on('reserved', (t) => t.assign('answers', function () { return this.answers + 1; }));
        s.on('charged', (t) => t.assign('answers', function () { return this.answers + 1; }));
        s.always((t) =>
          t.when(({ data }) => data.answers === 2).log('order confirmed', () => 'reserved and charged').target('confirmed'),
        );
      })
      .state('confirmed'),
  );
  const inventory = system.define(
    statechart({ family: 'inventory', revision: 'v1' })
      .data('stock', 10)
      .data('reserved', 0)
      .state('ready', (s) => {
        s.on('reserve', (t) =>
          t
            .when(function ({ event }) { return event.data.items <= this.stock - this.reserved; })
            .assign('reserved', function ({ event }) { return this.reserved + event.data.items; })
            .log('reserved', function ({ event }) { return `${event.data.items} items, ${this.stock - this.reserved} left`; })
            .send('reserved', (m) => m.to('#_actor_gateway/main')),
        );
        // More than is left: say so, then fail, as a real check would.
        s.on('reserve', (t) =>
          t
            .log('out of stock', function ({ event }) { return `wanted ${event.data.items}, ${this.stock - this.reserved} left`; })
            .script(function ({ event }) {
              throw new Error(`cannot reserve ${event.data.items} items`);
            }),
        );
      }),
  );
  const payments = system.define(
    statechart({ family: 'payments', revision: 'v1' })
      .state('ready', (s) =>
        s.on('charge', (t) =>
          t
            .log('charging', ({ event }) => `${event.data.amount} EUR`)
            .target('charging')
            .send('settle', (m) => m.to('#_actor_payments/main').after(5)),
        ),
      )
      .state('charging', (s) =>
        s.on('settle', (t) =>
          t.log('settled').target('ready').send('charged', (m) => m.to('#_actor_gateway/main')),
        ),
      ),
  );
  return { gateway, inventory, payments };
}

// The host's own request span, as its HTTP handler would export it: one
// span in OTLP JSON, posted beside tinyactors' protobuf. OTLP JSON spells
// its fields traceId and spanId; our own names use ID.
async function postRequestSpan(endpoint, { traceID, spanID, start, end }) {
  const nanos = (ms) => (BigInt(ms) * 1000000n).toString();
  const body = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'tinyactors-demo' } }] },
      scopeSpans: [{
        scope: { name: 'demo-http' },
        spans: [{
          traceId: traceID, spanId: spanID, name: 'POST /orders', kind: 2, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
          attributes: [{ key: 'http.request.method', value: { stringValue: 'POST' } },
                       { key: 'url.path', value: { stringValue: '/orders' } }],
          status: { code: 1 },
        }],
      }],
    }],
  };
  const response = await fetch(`${endpoint}/v1/traces`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OTLP export failed: HTTP ${response.status}`);
}

async function main() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318';
  const exporter = new OTLPExporter({ endpoint });
  const system = createSystem();
  system.setTraceSink(exporter.sink, { detail: 'full', values: true, resource: { 'service.name': 'tinyactors-demo' } });
  const { gateway, inventory, payments } = charts(system);
  const stock = system.spawn(inventory, { name: 'main' });
  system.spawn(payments, { name: 'main' });
  const entry = system.spawn(gateway, { name: 'main' });
  await system.flush();

  // The request's own span, as the host's HTTP handler would have it.
  const traceID = randomBytes(16).toString('hex');
  const requestSpan = randomBytes(8).toString('hex');
  const start = Date.now();
  await system.send(entry, 'order', { items: 3, amount: 42 },
                    { traceparent: formatTraceparent({ traceID, spanID: requestSpan }) });
  // The payment settles after 5 ms of real time.
  while (system.inspect(entry).activeStates[0] !== 'confirmed') {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await system.flush();
  }
  const end = Date.now();

  // A second request orders more than is left. The inventory logs it and
  // its <script> fails: an INFO log, then WARN logs, in a trace of their own.
  const lateTraceID = randomBytes(16).toString('hex');
  const lateSpan = randomBytes(8).toString('hex');
  const lateStart = Date.now();
  await system.send(stock, 'reserve', { items: 50, amount: 700 },
                    { traceparent: formatTraceparent({ traceID: lateTraceID, spanID: lateSpan }) });
  await system.flush();
  const lateEnd = Date.now();

  exporter.metrics(metricsToOTLP(system.metrics(), { resource: { 'service.name': 'tinyactors-demo' } }));
  system.close();
  const sent = await exporter.flush();
  await postRequestSpan(endpoint, { traceID, spanID: requestSpan, start, end });
  await postRequestSpan(endpoint, { traceID: lateTraceID, spanID: lateSpan, start: lateStart, end: lateEnd });
  console.log(`exported ${sent} OTLP requests: the order in trace ${traceID}, the refused one in ${lateTraceID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
