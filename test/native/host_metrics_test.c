/* Host metrics: explicit-bucket histograms and their exemplars (napi ADR 0017 section 7). */
#include <stdio.h>

#include "check.h"
#include "host_metrics.h"

/* A value lands in the first bucket whose bound is at least the value; one
 * past the last bound lands in the overflow bucket. */
static void buckets_by_inclusive_bound(void) {
    tna_host_metrics metrics;
    tna_host_metrics_init(&metrics);
    tna_histogram *turns = &metrics.turn_seconds;
    CHECK(turns->bound_count > 2 && turns->bound_count <= TNA_HISTOGRAM_MAX_BOUNDS);
    tna_histogram_record(turns, turns->bounds[0], NULL);
    tna_histogram_record(turns, turns->bounds[1] * 0.99, NULL);
    tna_histogram_record(turns, turns->bounds[turns->bound_count - 1u] * 2.0, NULL);
    CHECK(turns->buckets[0] == 1);
    CHECK(turns->buckets[1] == 1);
    CHECK(turns->buckets[turns->bound_count] == 1);
    CHECK(turns->count == 3);
    CHECK(turns->min == turns->bounds[0]);
    CHECK(turns->max == turns->bounds[turns->bound_count - 1u] * 2.0);
}

/* A sampled context gives an exemplar that keeps the value it was recorded
 * with; an unsampled one gives none. */
static void exemplars_only_for_sampled_traces(void) {
    tna_host_metrics metrics;
    tna_host_metrics_init(&metrics);
    ta_trace_context sampled = { .trace_id_high = 0x0102030405060708u, .trace_id_low = 0x090a0b0c0d0e0f10u,
                                 .flags = TA_TRACE_FLAG_SAMPLED };
    ta_trace_context unsampled = sampled;
    unsampled.flags = 0;
    tna_exemplar none = tna_exemplar_of(&unsampled, 7, 1);
    CHECK(!none.set);
    tna_exemplar exemplar = tna_exemplar_of(&sampled, 0x1122334455667788u, 42);
    CHECK(exemplar.set && exemplar.time_ns == 42);
    CHECK(exemplar.trace_id[0] == 0x01 && exemplar.trace_id[15] == 0x10);
    CHECK(exemplar.span_id[0] == 0x11 && exemplar.span_id[7] == 0x88);
    tna_histogram *lateness = &metrics.lateness_seconds;
    tna_histogram_record(lateness, 0.25, &exemplar);
    tna_histogram_record(lateness, 0.0, &none);
    uint32_t bucket = 0;
    while (lateness->bounds[bucket] < 0.25) {
        bucket += 1u;
    }
    CHECK(lateness->exemplars[bucket].set && lateness->exemplars[bucket].value == 0.25);
    CHECK(!lateness->exemplars[0].set);
}

int main(void) {
    buckets_by_inclusive_bound();
    exemplars_only_for_sampled_traces();
    puts("host_metrics_test passed");
    return 0;
}
