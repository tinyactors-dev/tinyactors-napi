'use strict';

const native = require('./lib/native');
const { TinyactorsError } = require('./lib/errors');
const { createSystem } = require('./lib/system');
const { statechart, literal, content } = require('./lib/statechart');
const { TRACE_KINDS, parseTraceparent, formatTraceparent, stepSpanID } = require('./lib/tracing');
const { decodeTraces } = require('./lib/otlp');
const { metricsToOTLP } = require('./lib/metrics');
const { createDebugSession, DAPReader, encodeDAPMessage } = require('./lib/debug');

module.exports = {
  version: native.version,
  createSystem,
  statechart,
  literal,
  content,
  TinyactorsError,
  // Tracing (core ADR 0067, napi ADR 0016): OTLP bytes, and a decoder; no
  // telemetry dependency.
  TRACE_KINDS,
  decodeTraces,
  parseTraceparent,
  formatTraceparent,
  stepSpanID,
  // Metrics (core ADR 0072, napi ADR 0017): system.metrics() and its OTLP bytes.
  metricsToOTLP,
  // The debug adapter (napi ADR 0026): a DAP session the application puts
  // behind its own transport, and the base protocol's framing for byte
  // streams.
  createDebugSession,
  DAPReader,
  encodeDAPMessage,
};
