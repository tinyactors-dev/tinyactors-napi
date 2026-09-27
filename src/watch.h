#pragma once
/*
 * Watched traces (napi ADR 0017 section 3): the sessions and definitions
 * an operator asked to see in full. The scheduler consults the watch at
 * each delivery it makes to core, which is every post, send, timer and
 * routed message. A matching delivery gets a sampled context marked
 * TA_TRACE_DETAIL_WATCHED (core ADR 0073), and core carries the mark to
 * everything the macrostep causes. With no watch, the check is one branch.
 *
 * This module has no Node-API in it.
 */
#include <stdbool.h>
#include <stdint.h>

#include "tinyactors.h"

/*
 * One open-addressing hash set of IDs, with linear probing. Its capacity
 * is a power of two at least twice its count, so a lookup touches one or
 * two slots whatever the size of the watch. When removals bring the load
 * down to an eighth, the set moves to a table where it is at most a
 * quarter (never below 8 slots), so the watch's memory
 * follows what is alive rather than its high-water mark. UINT64_MAX marks
 * an empty slot; an ID equal to it is kept in `has_max` instead.
 */
typedef struct {
    uint64_t *slots;
    uint32_t capacity; /* 0, or a power of two */
    uint32_t count;
    bool has_max;
} tna_id_set;

/*
 * Watched families are names, resolved to definitions when a delivery first
 * meets one (core ADR 0078): a definition registered after watchTraces,
 * by JavaScript or by core itself (a nested or invoke-time child), is
 * caught the same way. `matched` holds the definitions whose family is
 * watched and `checked` every definition already looked at, so each
 * definition's family is read once per watch. A definition core frees
 * leaves both (core ADR 0079), so a watch on a system that churns through
 * definitions stays the size of what is alive.
 */
typedef struct {
    ta_allocator allocator;
    tna_id_set sessions;
    ta_str *families; /* owned copies */
    uint32_t family_count;
    tna_id_set matched;
    tna_id_set checked;
} tna_trace_watch;

void tna_trace_watch_init(tna_trace_watch *watch, ta_allocator allocator);
void tna_trace_watch_destroy(tna_trace_watch *watch);

typedef struct {
    const uint64_t *sessions;
    uint32_t session_count;
    const ta_str *families;
    uint32_t family_count;
} tna_trace_watch_set_params;

/* Replaces what is watched. TA_ERR_NOMEM leaves the watch as it was. */
ta_result tna_trace_watch_set(tna_trace_watch *watch, const tna_trace_watch_set_params *params);

static inline bool tna_trace_watch_empty(const tna_trace_watch *watch) {
    return watch == NULL || watch->sessions.count + watch->family_count == 0;
}

/* Drops a definition core has freed from `matched` and `checked` (core ADR 0079). */
void tna_trace_watch_forget_definition(tna_trace_watch *watch, ta_definition_id definition);

/* Whether `id` is in the set: constant time, for tests and the scheduler. */
bool tna_id_set_has(const tna_id_set *set, uint64_t id);

/*
 * Marks `trace` watched when `actor` is: its session is watched, or its
 * definition's family is. A watched delivery with no trace starts one from
 * core's generator. `trace` is left alone otherwise.
 */
void tna_trace_watch_mark(tna_trace_watch *watch, ta_system *core, ta_actor_id actor, ta_trace_parent *trace);
