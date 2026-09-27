#pragma once
/*
 * What only the host knows, for metrics (napi ADR 0017 section 7, core ADR
 * 0072 section 4): how long pump turns take, how late delayed sends fire,
 * faults by code, quarantines and dead letters by reason.
 *
 * Histograms have explicit buckets, as OTLP's Histogram does, because
 * otel-tui and most viewers chart those and not exponential ones. Each
 * bucket keeps its latest exemplar: the value, when it happened, and the
 * trace and span of a sampled macrostep that ran then, so a slow turn on a
 * dashboard leads to its trace.
 *
 * Everything here is fixed-size and allocates nothing. This module has no
 * Node-API in it.
 */
#include <stdbool.h>
#include <stdint.h>

#include "tinyactors.h"

/* Bounds of the largest histogram, plus one overflow bucket. */
#define TNA_HISTOGRAM_MAX_BOUNDS 16u

typedef struct {
    bool set;
    double value;       /* in the histogram's unit */
    uint64_t time_ns;   /* Unix nanoseconds */
    uint8_t trace_id[16];
    uint8_t span_id[8];
} tna_exemplar;

typedef struct {
    const double *bounds; /* ascending upper bounds, inclusive (OTLP explicit_bounds) */
    uint32_t bound_count;
    uint64_t count;
    double sum;
    double min;
    double max;
    uint64_t buckets[TNA_HISTOGRAM_MAX_BOUNDS + 1u];
    tna_exemplar exemplars[TNA_HISTOGRAM_MAX_BOUNDS + 1u];
} tna_histogram;

/* ta_result codes are small negative numbers; faults are counted by -code. */
#define TNA_FAULT_CODES 32u
/* tna_dead_reason, in scheduler.h. */
#define TNA_DEAD_REASONS 9u

typedef struct {
    tna_histogram turn_seconds;     /* one pump turn, wall time, hooks and services included */
    tna_histogram lateness_seconds; /* a delayed send's dispatch time minus its due time */
    tna_histogram load_seconds;     /* a loader call, from the first message to its result (napi ADR 0020) */
    /* The trace and span of the latest sampled macrostep that began in the
     * running turn: that turn's exemplar. The trace encoder sets it. */
    tna_exemplar turn_exemplar;
} tna_host_metrics;

void tna_host_metrics_init(tna_host_metrics *metrics);
/* An exemplar for the step `span_id` of `context`, set only when the
 * context is a sampled trace: an unsampled one has no trace to link to. */
tna_exemplar tna_exemplar_of(const ta_trace_context *context, uint64_t span_id, uint64_t time_ns);
/* Records one value; `exemplar` may be NULL or unset. */
void tna_histogram_record(tna_histogram *histogram, double value, const tna_exemplar *exemplar);
