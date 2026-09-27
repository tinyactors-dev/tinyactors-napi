'use strict';

// A small OTLP/HTTP exporter, for tests and the otel-tui demo only (napi
// ADRs 0016 and 0017). It is not part of the package: tinyactors depends on
// no telemetry package. The trace sink's bytes are already OTLP protobuf
// requests (traces, and logs beside them), and metricsToOTLP() makes the
// metrics one, so exporting is one POST each; this queues them and posts in
// order. It uses only fetch, which Node and Bun both have.

class OTLPExporter {
  #endpoint;
  #pending = [];

  constructor({ endpoint = 'http://127.0.0.1:4318' } = {}) {
    this.#endpoint = endpoint.replace(/\/$/, '');
  }

  /** A trace sink: pass it to System.setTraceSink. */
  sink = (traces, logs) => {
    if (traces.length !== 0) this.#pending.push(['/v1/traces', traces]);
    if (logs !== undefined) this.#pending.push(['/v1/logs', logs]);
  };

  /** Queues metricsToOTLP() bytes. */
  metrics(bytes) {
    this.#pending.push(['/v1/metrics', bytes]);
  }

  /** Posts every request queued so far; resolves to how many were posted. */
  async flush() {
    const batch = this.#pending.splice(0);
    for (const [path, bytes] of batch) {
      const response = await fetch(`${this.#endpoint}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: bytes,
      });
      if (!response.ok) {
        throw new Error(`OTLP export failed: HTTP ${response.status}`);
      }
      await response.arrayBuffer();
    }
    return batch.length;
  }
}

module.exports = { OTLPExporter };
