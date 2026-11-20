/* The spans of an OTLP ExportTraceServiceRequest as CBOR: language-free C
 * over core's decoder, shared by the addon (decodeTraces, values.c) and the
 * wasm package's module (wasm/src/codecs.c), each of which reads the CBOR
 * into values with its own value table. */
#ifndef TA_NAPI_TRACES_H
#define TA_NAPI_TRACES_H

#include "tinyactors.h"

/* Writes every span of `request` into `writer` as one CBOR array of maps:
 * trace, span, parent (hex text; parent null for a root span), name, kind,
 * start, end (nanoseconds since the Unix epoch), status, statusMessage,
 * flags, attributes, events [{name, time, attributes}], links [{trace,
 * span, attributes}], resource (its attributes) and scope {name, version,
 * attributes}. TA_ERROR_INVALID when the bytes are not such a request,
 * else the writer's status (ta_cbor_writer_bytes reads the item). */
ta_status ta_napi_traces_write(ta_bytes request, ta_cbor_writer *writer);

#endif
