'use strict';

// The observable-instrument example in docs/tracing.md, run against the
// official OpenTelemetry metrics SDK, a pinned dev dependency (napi ADR
// 0017 section 7). Runs on Node and Bun.

const assert = require('node:assert/strict');
const { MeterProvider, MetricReader } = require('@opentelemetry/sdk-metrics');
const { createSystem, statechart } = require('..');
const { observeMetrics } = require('./fixtures/otel-metrics');

class ManualReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

const pointOf = (resourceMetrics, name, match) => {
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== name) continue;
      const found = metric.dataPoints.find((p) => Object.entries(match).every(([k, v]) => p.attributes[k] === v));
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

async function observed() {
  const system = createSystem();
  const reader = new ManualReader();
  const provider = new MeterProvider({ readers: [reader] });
  observeMetrics(provider.getMeter('tinyactors-example'), system);

  const definition = system.define(
    statechart({ family: 'orders', revision: 'v1' })
      .state('open', (s) => s.on('close', (t) => t.target('closed')))
      .state('closed'),
  );
  const order = system.spawn(definition);
  system.spawn(definition);
  await system.flush();
  order.post('close');
  await system.flush();

  const { resourceMetrics, errors } = await reader.collect();
  assert.deepEqual(errors, []);
  const family = { 'tinyactors.definition.family': 'orders', 'tinyactors.definition.revision': 'v1' };
  assert.equal(pointOf(resourceMetrics, 'tinyactors.actors.spawned', family).value, 2, 'a sum, as a counter');
  assert.equal(pointOf(resourceMetrics, 'tinyactors.actors.occupancy', { ...family, 'scxml.state': 'open' }).value, 1,
               'a gauge');
  assert.equal(pointOf(resourceMetrics, 'tinyactors.actors.occupancy', { ...family, 'scxml.state': 'closed' }).value, 1);
  assert.equal(pointOf(resourceMetrics, 'tinyactors.pump.turn.duration', {}), undefined,
               'histograms are not observed: the SDK has no asynchronous histogram');
  await provider.shutdown();
  system.close();
}

(async () => {
  await observed();
  console.log('otel-metrics.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
