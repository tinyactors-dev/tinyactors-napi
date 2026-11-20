/* The spans of an OTLP ExportTraceServiceRequest as CBOR (traces.h): core
 * reads the request (ta_otlp_next_span and its walkers, every view into
 * the bytes given), and this writes what trace.spans.decode gives plus
 * each span's flags, links, resource and scope. No Node-API here: the wasm
 * package's module compiles this file too. */
#include "traces.h"

/* An attribute value nests no deeper than this; deeper ones are None. */
#define TA_NAPI_TRACES_DEPTH 32u

typedef struct ta_napi_traces {
    ta_cbor_writer *writer;
} ta_napi_traces;

static void ta_napi_traces_key(ta_napi_traces *out, const char *key) {
    ta_cbor_write_text(out->writer, ta_string(key));
}

static void ta_napi_traces_id(ta_napi_traces *out, ta_trace_id trace) {
    char text[TA_TRACE_ID_TEXT_LENGTH];
    ta_buffer buffer = {text, sizeof text, 0};
    ta_trace_id_format(trace, &buffer);
    ta_cbor_write_text(out->writer, (ta_string_view){text, (uint32_t)buffer.length});
}

static void ta_napi_traces_span_id(ta_napi_traces *out, ta_span_id span) {
    char text[16];
    ta_buffer buffer = {text, sizeof text, 0};
    ta_span_id_format(span, &buffer);
    ta_cbor_write_text(out->writer, (ta_string_view){text, (uint32_t)buffer.length});
}

static void ta_napi_traces_attributes(ta_napi_traces *out, ta_otlp_fields attributes, uint32_t depth);

static void ta_napi_traces_value(ta_napi_traces *out, const ta_otlp_value *value, uint32_t depth) {
    ta_cbor_writer *writer = out->writer;
    switch (value->kind) {
    case TA_OTLP_VALUE_STRING: ta_cbor_write_text(writer, value->bytes); return;
    case TA_OTLP_VALUE_BOOL: ta_cbor_write_simple(writer, value->integer ? 21u : 20u); return;
    case TA_OTLP_VALUE_INT: ta_cbor_write_int(writer, value->integer); return;
    case TA_OTLP_VALUE_DOUBLE: ta_cbor_write_float(writer, value->number); return;
    case TA_OTLP_VALUE_BYTES: ta_cbor_write_bytes(writer, (ta_bytes){value->bytes.pointer, value->bytes.length}); return;
    default: break;
    }
    if (depth >= TA_NAPI_TRACES_DEPTH || (value->kind != TA_OTLP_VALUE_ARRAY && value->kind != TA_OTLP_VALUE_LIST)) {
        ta_cbor_write_simple(writer, 22u); /* null */
        return;
    }
    if (value->kind == TA_OTLP_VALUE_LIST) {
        ta_napi_traces_attributes(out, value->items, depth + 1);
        return;
    }
    ta_otlp_value item;
    ta_cbor_write_array(writer, TA_CBOR_COUNT_LATER);
    for (uint32_t at = 0; ta_otlp_next_value(value->items, &at, &item) == 1;)
        ta_napi_traces_value(out, &item, depth + 1);
    ta_cbor_write_end(writer);
}

static void ta_napi_traces_attributes(ta_napi_traces *out, ta_otlp_fields attributes, uint32_t depth) {
    ta_otlp_key_value pair;
    ta_cbor_write_map(out->writer, TA_CBOR_COUNT_LATER);
    for (uint32_t at = 0; ta_otlp_next_attribute(attributes, &at, &pair) == 1;) {
        ta_cbor_write_text(out->writer, pair.key);
        ta_napi_traces_value(out, &pair.value, depth);
    }
    ta_cbor_write_end(out->writer);
}

static void ta_napi_traces_events(ta_napi_traces *out, ta_otlp_fields events) {
    ta_otlp_event event;
    ta_cbor_write_array(out->writer, TA_CBOR_COUNT_LATER);
    for (uint32_t at = 0; ta_otlp_next_event(events, &at, &event) == 1;) {
        ta_cbor_write_map(out->writer, 3);
        ta_napi_traces_key(out, "name");
        ta_cbor_write_text(out->writer, event.name);
        ta_napi_traces_key(out, "time");
        ta_cbor_write_uint(out->writer, event.time);
        ta_napi_traces_key(out, "attributes");
        ta_napi_traces_attributes(out, event.attributes, 0);
    }
    ta_cbor_write_end(out->writer);
}

static void ta_napi_traces_links(ta_napi_traces *out, ta_otlp_fields links) {
    ta_otlp_link link;
    ta_cbor_write_array(out->writer, TA_CBOR_COUNT_LATER);
    for (uint32_t at = 0; ta_otlp_next_link(links, &at, &link) == 1;) {
        ta_cbor_write_map(out->writer, 3);
        ta_napi_traces_key(out, "trace");
        ta_napi_traces_id(out, link.trace);
        ta_napi_traces_key(out, "span");
        ta_napi_traces_span_id(out, link.span);
        ta_napi_traces_key(out, "attributes");
        ta_napi_traces_attributes(out, link.attributes, 0);
    }
    ta_cbor_write_end(out->writer);
}

static void ta_napi_traces_span(ta_napi_traces *out, const ta_otlp_span *span) {
    ta_cbor_writer *writer = out->writer;
    ta_cbor_write_map(writer, 15);
    ta_napi_traces_key(out, "trace");
    ta_napi_traces_id(out, span->trace);
    ta_napi_traces_key(out, "span");
    ta_napi_traces_span_id(out, span->span);
    ta_napi_traces_key(out, "parent");
    if (span->parent) ta_napi_traces_span_id(out, span->parent);
    else ta_cbor_write_simple(writer, 22u);
    ta_napi_traces_key(out, "name");
    ta_cbor_write_text(writer, span->name);
    ta_napi_traces_key(out, "kind");
    ta_cbor_write_uint(writer, span->kind);
    ta_napi_traces_key(out, "start");
    ta_cbor_write_uint(writer, span->start);
    ta_napi_traces_key(out, "end");
    ta_cbor_write_uint(writer, span->end);
    ta_napi_traces_key(out, "status");
    ta_cbor_write_uint(writer, span->status);
    ta_napi_traces_key(out, "statusMessage");
    ta_cbor_write_text(writer, span->status_message);
    ta_napi_traces_key(out, "flags");
    ta_cbor_write_uint(writer, span->flags);
    ta_napi_traces_key(out, "attributes");
    ta_napi_traces_attributes(out, span->attributes, 0);
    ta_napi_traces_key(out, "events");
    ta_napi_traces_events(out, span->events);
    ta_napi_traces_key(out, "links");
    ta_napi_traces_links(out, span->links);
    ta_napi_traces_key(out, "resource");
    ta_napi_traces_attributes(out, span->resource, 0);
    ta_napi_traces_key(out, "scope");
    ta_cbor_write_map(writer, 3);
    ta_napi_traces_key(out, "name");
    ta_cbor_write_text(writer, span->scope_name);
    ta_napi_traces_key(out, "version");
    ta_cbor_write_text(writer, span->scope_version);
    ta_napi_traces_key(out, "attributes");
    ta_napi_traces_attributes(out, span->scope_attributes, 0);
}

ta_status ta_napi_traces_write(ta_bytes request, ta_cbor_writer *writer) {
    ta_otlp_cursor cursor = {0};
    ta_otlp_span span;
    int32_t got = 0;
    while ((got = ta_otlp_next_span(request, &cursor, &span)) == 1)
        continue; /* the whole request is read before anything is written */
    if (got != 0) return TA_ERROR_INVALID;
    ta_napi_traces out = {writer};
    ta_cbor_write_array(writer, TA_CBOR_COUNT_LATER);
    cursor = (ta_otlp_cursor){0};
    while (ta_otlp_next_span(request, &cursor, &span) == 1)
        ta_napi_traces_span(&out, &span);
    ta_cbor_write_end(writer);
    ta_bytes written;
    return ta_cbor_writer_bytes(writer, &written);
}
