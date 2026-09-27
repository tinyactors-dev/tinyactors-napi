#pragma once
/*
 * Trace records to OTLP protobuf (napi ADR 0016).
 *
 * The encoder is a core trace sink's back end: it takes the records core
 * writes (core ADR 0067), maps them to OpenTelemetry spans, keeps the
 * spans still open between turns, and writes the spans that ended as one
 * `ExportTraceServiceRequest` (opentelemetry-proto, trace/v1), which an
 * OTLP/HTTP `/v1/traces` endpoint accepts as it is. It exports nothing:
 * where the bytes go is the host's business.
 *
 * Portability: it uses only core's public header and the host interface
 * below. It has no Node-API in it (the NODE_API_SOURCES check keeps it
 * so) and none of napi's own modules, so it can move to wherever a second
 * host needs it (the host kernel, or a small library of its own).
 *
 * The mapping, lossless over the records core writes:
 * - MACROSTEP_BEGIN opens a span, MACROSTEP_END ends it;
 * - MICROSTEP opens a child span, ended by the next MICROSTEP or the END;
 * - every other record inside a macrostep is a span event on the step it
 *   happened in;
 * - a lifecycle record is a span of no duration.
 * The attribute table is in napi ADR 0016's implementation notes.
 *
 * Memory: every buffer keeps its capacity, so once the busiest turn has been
 * seen, encoding allocates nothing. Writing cannot fail: a record that does
 * not fit because an allocation failed is counted in `dropped`.
 *
 * Output (napi ADR 0018): the encoder never owns a request. A host asks for
 * a request's size, which is free (the spans and log records keep a running
 * total), allocates exactly that many bytes in memory its own language owns,
 * and has the encoder write the request into them in one pass.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "host_metrics.h"
#include "tinyactors.h"

/* What the encoder asks of its host. */
typedef struct {
    void *self;
    /* Wall-clock time, in nanoseconds since the Unix epoch (core has only
     * logical time). */
    uint64_t (*now)(void *self);
    /* A new trace ID, for a span whose record carries none. 16 bytes. */
    void (*trace_id)(void *self, uint8_t out[16]);
    /* Optional: text for a value (event data, an assigned value), valid until
     * the next call; false when there is none. Used only with `values`. */
    bool (*value_text)(void *self, const ta_value *value, ta_str *out);
} tna_otlp_host;

typedef struct {
    /* The system whose records these are: names come from its definitions
     * (core ADR 0071) and its interned event names. */
    const ta_system *core;
    ta_allocator allocator;
    tna_otlp_host host;
    /* Parent a macrostep under its cause (false), or make it a root and
     * link it to its cause (true). */
    bool link_parents;
    /* Put values (event data, assigned values) in attributes. */
    bool values;
    /* The instrumentation scope's version. */
    ta_str version;
    /* The kinds the user asked for (TA_TRACE_BIT). The sink also asks core
     * for UNLOADED and DESTROYED, which end open spans, and writes their
     * spans only when they are wanted. */
    uint32_t wanted_kinds;
    uint32_t wanted_watched_kinds; /* the same, for watched contexts */
    uint32_t wanted_unsampled_kinds; /* the same, for unsampled ones */
    /* Logs (napi ADR 0017 section 7): failures and <log> become OTLP log
     * records, at most `log_limit` per definition and name per second;
     * 0 writes no logs. */
    uint32_t log_limit;
} tna_otlp_config;

/* A growable byte buffer over an allocator. */
typedef struct {
    ta_allocator allocator;
    uint8_t *data;
    size_t len;
    size_t cap;
} tna_otlp_buf;

typedef struct {
    uint8_t trace_id[16];
    uint64_t span_id;
    uint64_t parent_span_id; /* 0: none */
    uint8_t link_trace_id[16];
    uint64_t link_span_id;   /* 0: no link */
    uint64_t start;
    uint32_t microstep;      /* for a microstep span */
    bool error;
    tna_otlp_buf name;
    tna_otlp_buf attributes; /* encoded Span.attributes entries */
    tna_otlp_buf events;     /* encoded Span.events entries */
} tna_otlp_span;

/* A session's open macrostep, and its open microstep. */
typedef struct {
    uint64_t session;
    bool has_micro;
    tna_otlp_span macro;
    tna_otlp_span micro;
} tna_otlp_open;

typedef struct {
    uint64_t definition;
    uint32_t tag; /* what is named: kind in the top two bits, the ID below */
    uint32_t len;
    size_t at;    /* in `names` */
    bool used;
} tna_otlp_name;

typedef struct {
    tna_otlp_config config;
    tna_otlp_open *open;       /* the first `open_count` are open; the rest are spare */
    uint32_t open_count;
    uint32_t open_capacity;
    uint32_t *open_index;      /* open addressing by session: index + 1 into `open`, 0 empty */
    uint32_t open_index_capacity; /* a power of two, at least twice `open_capacity` */
    uint64_t last_now;         /* the clock at the last span boundary: span events use it */
    tna_otlp_span lifecycle;   /* a lifecycle span while it is built */
    tna_otlp_buf logs;         /* encoded ScopeLogs.log_records entries */
    tna_otlp_buf log_body;     /* a log's body while its attributes are built */
    uint32_t log_count;
    /* Rate limits, one slot per (definition, name) hash; a collision shares one. */
    struct {
        uint64_t key;
        uint64_t window; /* the second the count is for */
        uint32_t count;
        uint32_t suppressed;
    } log_rates[256];
    tna_otlp_name *name_slots; /* open addressing, a power of two */
    uint32_t name_capacity;
    uint32_t name_count;
    tna_otlp_buf names;        /* the cached labels' text */
    tna_otlp_buf resource;     /* encoded Resource.attributes entries */
    /* Encoded ScopeSpans.spans entries that ended since the last put; `len`
     * is the running total a request's size is computed from. */
    tna_otlp_buf spans;
    tna_otlp_buf scratch;      /* an event's attributes while it is built */
    tna_otlp_buf label;        /* a label while it is built */
    tna_otlp_buf text;         /* an event name or ID while it is formatted */
    uint32_t span_count;       /* spans in `spans` */
    /* Bytes this turn's requests used from `spans` and `logs`, and the
     * typical use of a turn that wrote any (an average that moves an eighth
     * of the way each such turn), for tna_otlp_end_turn(). */
    size_t turn_spans;
    size_t turn_logs;
    size_t typical_spans;
    size_t typical_logs;
    /* The latest sampled macrostep span opened, for the host's exemplars
     * (host_metrics.h); the host clears `set` when it takes it. */
    tna_exemplar last_macrostep;
    uint64_t dropped;          /* records lost to a failed allocation */
} tna_otlp;

void tna_otlp_init(tna_otlp *otlp, const tna_otlp_config *config);

/* One resource attribute, a string. */
typedef struct {
    ta_str key;
    ta_str value;
} tna_otlp_attribute;

/* Sets the resource attributes (`service.name`, ...) every request carries. */
ta_result tna_otlp_set_resource(tna_otlp *otlp, const tna_otlp_attribute *attributes, uint32_t count);

/* Takes one record, as a trace sink's `write` does. Cannot fail. */
void tna_otlp_write(tna_otlp *otlp, const ta_trace_record *record);

/*
 * The size in bytes of the ExportTraceServiceRequest the spans that ended
 * since the last put make; 0 when none ended. It walks nothing.
 */
size_t tna_otlp_traces_size(const tna_otlp *otlp);

/*
 * Writes that request into `out`, which holds `size` bytes, and forgets the
 * spans. `size` must be what tna_otlp_traces_size() reports now: otherwise
 * nothing is written or forgotten and the result is 0. Returns the bytes
 * written, which is `size`: the write never goes past it.
 */
size_t tna_otlp_put_traces(tna_otlp *otlp, uint8_t *out, size_t size);

/* A <log> as an INFO log record; its value's text comes from the host. */
/*
 * A WARN log the host writes about an actor or a message, not a record core
 * wrote: a quarantine or a dead letter (napi ADR 0017 section 7). It goes
 * through the same rate limit, per definition and event name. The body is
 * "<event name> <body>" when `has_event`, else `body`.
 */
typedef struct {
    ta_str event_name;          /* LogRecord.event_name */
    ta_str body;
    bool has_event;
    ta_event_name_id event;     /* scxml.event.name, when has_event */
    ta_definition_id definition; /* 0 when unknown */
    uint64_t session;            /* 0 when unknown */
    ta_str key;                  /* one more attribute: the reason or code */
    ta_str value;
} tna_otlp_host_log_params;
void tna_otlp_host_log(tna_otlp *otlp, const tna_otlp_host_log_params *log);

/*
 * A definition lifecycle event as a log (core ADR 0079): DEBUG for
 * registered and freed, INFO for retired, with the family, revision,
 * origin ("host", "nested" or "invoke") and ID. Rate-limited per family
 * and event name, not per definition, so a family that churns through
 * invoke-time definitions stays within the limit.
 */
typedef struct {
    const ta_definition_event *event;
    ta_str origin;
} tna_otlp_definition_log_params;
void tna_otlp_definition_log(tna_otlp *otlp, const tna_otlp_definition_log_params *log);
void tna_otlp_log(tna_otlp *otlp, const ta_log_record *record);

/* The same pair for the log records written since the last put, as one
 * ExportLogsServiceRequest for `/v1/logs`. */
size_t tna_otlp_logs_size(const tna_otlp *otlp);
size_t tna_otlp_put_logs(tna_otlp *otlp, uint8_t *out, size_t size);

/* Drops the names cached for a definition core has freed (core ADR 0079). */
void tna_otlp_forget_definition(tna_otlp *otlp, ta_definition_id definition);

/* Ends every open span now, marked `scxml.incomplete`, so the next put
 * carries them: the sink is going away. */
/*
 * At the end of every pump turn, whether or not it wrote a request: a
 * staging buffer larger than 1 MiB and more than four times a typical
 * turn's use (as it stood before this turn) is freed. A burst, such as a
 * turn of spawns each tracing its bootstrap, is far above typical, so its
 * buffer goes as soon as the turn ends instead of staying for the system's
 * life. Steady turns, and the idle turns between them, keep their buffer
 * and allocate nothing; a new steady load regrows it a few times while the
 * typical use catches up.
 */
void tna_otlp_end_turn(tna_otlp *otlp);
void tna_otlp_end_all(tna_otlp *otlp);

/* Changes the kinds the user asked for (configureTraces). */
static inline void tna_otlp_set_wanted(tna_otlp *otlp, uint32_t kinds, uint32_t watched_kinds,
                                       uint32_t unsampled_kinds) {
    otlp->config.wanted_kinds = kinds;
    otlp->config.wanted_watched_kinds = watched_kinds;
    otlp->config.wanted_unsampled_kinds = unsampled_kinds;
}

/* Spans still open (for tests). */
static inline uint32_t tna_otlp_open_count(const tna_otlp *otlp) { return otlp->open_count; }

void tna_otlp_destroy(tna_otlp *otlp);
