'use strict';

// The example docs/tracing.md shows: system.metrics() read by the official
// OpenTelemetry SDK's observable instruments. tinyactors does not depend on
// the SDK; the application does, and passes its meter in.
//
// Sums become observable counters and gauges observable gauges, all fed by
// one batch callback that takes one snapshot per collection. The SDK has no
// asynchronous histogram, so the histograms (turn duration, timer
// lateness) are not observed here: export them with metricsToOTLP().

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

module.exports = { observeMetrics };
