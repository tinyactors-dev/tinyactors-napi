#pragma once
/*
 * The tracing hook (core ADR 0067, napi ADR 0016): the Node-API half.
 *
 * lib/system.js registers a JavaScript function with setTraceSink(); this
 * module installs the OTLP encoder (otlp.h) and the sink adapter
 * (adapters/trace.h) with the mask JavaScript asked for, or core's null
 * sink when there is no function, so an untraced system builds no record.
 * At the end of each turn the pump calls tna_trace_dispatch(), which hands
 * the spans that ended to the environment's effects handler as one
 * Uint8Array holding one OTLP ExportTraceServiceRequest:
 * handler(system, "trace", bytes). The bytes are the only output; lib/
 * decodes them for those who want objects (decodeTraces).
 */
#include <node_api.h>

#include "napi_system.h"

/* Hands the turn's trace records to JavaScript. An exception becomes the turn's first error. */
void tna_trace_dispatch(napi_env env, tna_napi_system *wrapper, napi_value *first_error);
/* setTraceSink(installed, kinds, unsampled, values, valueLimit, links, resource, seed). */
napi_value tna_set_trace_sink_method(napi_env env, napi_callback_info info);
/* The sample ratio crosses as parts of this whole. */
#define TNA_SAMPLE_WHOLE 1000000000u
/* spawnTrace(traceparent, watched): the trace parent for generated spawn, or undefined. */
napi_value tna_spawn_trace_method(napi_env env, napi_callback_info info);
/* configureTraces(kinds, watchedKinds, unsampledKinds, sample). */
napi_value tna_configure_traces_method(napi_env env, napi_callback_info info);
/* setTraceWatch(sessions, definitions). */
napi_value tna_set_trace_watch_method(napi_env env, napi_callback_info info);
/* traceWatchSizes(): tests only. */
napi_value tna_trace_watch_sizes_method(napi_env env, napi_callback_info info);
/*
 * options.traceparent of post()/send()/spawn(): undefined for none, or W3C
 * traceparent text, which core parses (core ADR 0073). Throws and answers
 * false otherwise.
 */
bool tna_trace_argument(napi_env env, napi_value value, ta_trace_parent *out);
/* A ta_trace_parent as traceparent text (core ADR 0073), or undefined when
 * it has no trace ID or no cause. */
napi_value tna_traceparent_value(napi_env env, const ta_trace_parent *parent);
/* The object generated bindings read as a ta_trace_parent (spawn, load), or
 * undefined for a parent with no trace. */
napi_value tna_trace_parent_object(napi_env env, const ta_trace_parent *parent);
/* The kind names, in ta_trace_kind order, for lib/tracing.js. */
napi_value tna_trace_kind_names(napi_env env);
