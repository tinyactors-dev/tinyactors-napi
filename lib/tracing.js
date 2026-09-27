'use strict';

// Tracing (core ADR 0067, napi ADR 0016). The addon hands a registered hook
// the spans that ended in each pump turn as OTLP protobuf bytes
// (System.setTraceSink); lib/otlp.js decodes them for those who want
// objects. This module holds what JavaScript still needs: the kind mask,
// W3C traceparent parsing and formatting, and span IDs derived from step
// keys exactly as core derives them. It depends on no telemetry package.

const native = require('./native');
const { TinyactorsError } = require('./errors');

/** Record kinds, in core's order; a sink's mask is built from these names. */
const TRACE_KINDS = Object.freeze([...native.traceKinds]);

/*
 * The definition records (core ADR 0080) are for hosts that follow core's
 * record stream. napi's OTLP output already reports definitions from the
 * definition sink (the tinyactors.definition.* logs), so no preset asks
 * core to build them, and asking for them explicitly adds no output.
 */
const DEFINITION_KINDS = ['definitionRegistered', 'definitionRetired', 'definitionFreed'];
const ENCODED_KINDS = Object.freeze(TRACE_KINDS.filter((kind) => !DEFINITION_KINDS.includes(kind)));

const LIFECYCLE = ['spawned', 'loaded', 'unloaded', 'finished', 'destroyed'];
// The failure kinds are the ones the log path writes as failures: an action
// that failed, a run stopped for lack of memory, and a long or runaway
// macrostep (core ADR 0075). An operator's abandon and withdraw (core ADRs
// 0082, 0084) are rare, and without them a summary macrostep span ends with
// no reason given.
const FAILURES = ['actionFailed', 'stopped', 'longMacrostep', 'runaway'];
const INTERVENTIONS = ['abandoned', 'withdrawn'];
const SUMMARY = [...LIFECYCLE, 'macrostepBegin', 'macrostepEnd', ...FAILURES, ...INTERVENTIONS];

/**
 * Detail presets over the kind mask (napi ADR 0017 section 3):
 * - summary: a span per macrostep, lifecycle spans, failures and an
 *   operator's interventions;
 * - decisions: adds microsteps, guard conditions and raised events;
 * - full: every kind.
 */
const TRACE_DETAIL = Object.freeze({
  summary: Object.freeze(SUMMARY),
  decisions: Object.freeze([...SUMMARY, 'microstep', 'condition', 'raised']),
  full: ENCODED_KINDS,
});

/** The mask for `kinds` (names from TRACE_KINDS); every encoded kind when undefined. */
function kindMask(kinds, what = 'setTraceSink()') {
  if (kinds === undefined) {
    return kindMask(ENCODED_KINDS, what);
  }
  if (!Array.isArray(kinds)) {
    throw new TinyactorsError(`${what}: options.kinds must be an array of record kinds`, 'invalid');
  }
  let mask = 0;
  for (const kind of kinds) {
    const bit = TRACE_KINDS.indexOf(kind);
    if (bit < 0) {
      throw new TinyactorsError(`${what}: unknown record kind "${kind}"`, 'invalid');
    }
    mask |= 2 ** bit;
  }
  return mask;
}

// ------------------------------------------------------------------------
// W3C trace context: traceparent = version "-" trace-id "-" parent-id "-" flags

/**
 * Parses a `traceparent` header: { traceID, parentSpanID, flags, sampled },
 * or undefined when it is not a valid one (the W3C rule: a receiver that
 * cannot parse it starts a new trace). Core parses it (ta_traceparent_parse),
 * as it does a traceparent given to post(), send() or spawn(), so the two
 * agree: spaces and tabs around it are ignored; hex is lowercase; version
 * ff, an all-zero trace or parent ID, and version 00 with anything after
 * the flags are refused; a later version is read by its first four fields,
 * and what follows a dash after its flags is ignored.
 */
function parseTraceparent(header) {
  if (typeof header !== 'string') {
    return undefined;
  }
  let parsed;
  try {
    parsed = native.core.traceparent_parse(header);
  } catch (error) {
    if (error instanceof TinyactorsError && error.code === 'invalid') {
      return undefined;
    }
    throw error;
  }
  const { context, cause } = parsed;
  return {
    traceID: hex16(context.trace_id_high) + hex16(context.trace_id_low),
    parentSpanID: hex16(cause.macrostep),
    flags: context.flags,
    sampled: (context.flags & 1) === 1,
  };
}

/** A `traceparent` header for a span: { traceID, spanID, sampled | flags }. */
function formatTraceparent({ traceID, spanID, sampled = true, flags }) {
  const bits = flags ?? (sampled ? 1 : 0);
  return `00-${traceID}-${spanID}-${bits.toString(16).padStart(2, '0')}`;
}

const MASK64 = (1n << 64n) - 1n;

function mix(value) {
  let v = value;
  v ^= v >> 33n;
  v = (v * 0xff51afd7ed558ccdn) & MASK64;
  v ^= v >> 33n;
  v = (v * 0xc4ceb9fe1a85ec53n) & MASK64;
  v ^= v >> 33n;
  return v;
}

const hex16 = (value) => value.toString(16).padStart(16, '0');

/**
 * The 16-hex-digit span ID of step (session, macrostep, microstep). A host
 * cause (session 0) is the host's own span ID, `macrostep`.
 */
function stepSpanID(session, macrostep, microstep = 0) {
  const s = BigInt(session);
  const m = BigInt(macrostep);
  if (s === 0n) {
    return hex16(m);
  }
  let span = mix(s);
  span = mix(span ^ m);
  span = mix(span ^ (BigInt(microstep) | (1n << 32n)));
  return hex16(span === 0n ? 1n : span);
}

/**
 * The masks and sample ratio `options` asks for: { kinds, watchedKinds,
 * sample } with `sample` in parts per 10^9. `kinds` overrides `detail`.
 */
function traceConfig({ detail = 'summary', kinds, sample = 1 }, what) {
  if (kinds === undefined && !Object.hasOwn(TRACE_DETAIL, detail)) {
    throw new TinyactorsError(`${what}: options.detail must be "summary", "decisions" or "full"`, 'invalid');
  }
  if (typeof sample !== 'number' || !(sample >= 0 && sample <= 1)) {
    throw new TinyactorsError(`${what}: options.sample must be a number from 0 to 1`, 'invalid');
  }
  return {
    kinds: kindMask(kinds ?? TRACE_DETAIL[detail], what),
    watchedKinds: kindMask(undefined, what),
    sample: Math.round(sample * 1e9),
  };
}

module.exports = {
  TRACE_KINDS,
  TRACE_DETAIL,
  traceConfig,
  kindMask,
  parseTraceparent,
  formatTraceparent,
  stepSpanID,
};
