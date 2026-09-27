#include "watch.h"

#include "allocator.h"

#define TNA_ID_EMPTY UINT64_MAX

void tna_trace_watch_init(tna_trace_watch *watch, ta_allocator allocator) {
    *watch = (tna_trace_watch){ .allocator = allocator };
}

static void tna_id_set_free(ta_allocator allocator, tna_id_set *set) {
    if (set->slots != NULL) {
        tna_free(allocator, &(ta_allocator_free_params){ .ptr = set->slots, .size = set->capacity * sizeof(uint64_t),
                                                         .alignment = _Alignof(uint64_t) });
    }
    *set = (tna_id_set){0};
}

static void tna_free_families(ta_allocator allocator, ta_str *families, uint32_t count) {
    for (uint32_t at = 0; families != NULL && at < count; at += 1u) {
        if (families[at].ptr != NULL) {
            tna_free(allocator, &(ta_allocator_free_params){ .ptr = (void *)families[at].ptr,
                                                             .size = families[at].len == 0 ? 1u : families[at].len,
                                                             .alignment = 1 });
        }
    }
    if (families != NULL) {
        tna_free(allocator, &(ta_allocator_free_params){ .ptr = families, .size = count * sizeof(ta_str),
                                                         .alignment = _Alignof(ta_str) });
    }
}

void tna_trace_watch_destroy(tna_trace_watch *watch) {
    tna_id_set_free(watch->allocator, &watch->sessions);
    tna_id_set_free(watch->allocator, &watch->matched);
    tna_id_set_free(watch->allocator, &watch->checked);
    tna_free_families(watch->allocator, watch->families, watch->family_count);
    watch->families = NULL;
    watch->family_count = 0;
}

/* SplitMix64's finalizer: session and definition IDs are sequential. */
static uint64_t tna_id_hash(uint64_t id) {
    id ^= id >> 30;
    id *= 0xbf58476d1ce4e5b9u;
    id ^= id >> 27;
    id *= 0x94d049bb133111ebu;
    return id ^ (id >> 31);
}

bool tna_id_set_has(const tna_id_set *set, uint64_t id) {
    if (id == TNA_ID_EMPTY) {
        return set->has_max;
    }
    if (set->capacity == 0) {
        return false;
    }
    uint32_t mask = set->capacity - 1u;
    for (uint32_t at = (uint32_t)tna_id_hash(id) & mask;; at = (at + 1u) & mask) {
        uint64_t slot = set->slots[at];
        if (slot == id) {
            return true;
        }
        if (slot == TNA_ID_EMPTY) {
            return false;
        }
    }
}

static void tna_id_set_put(tna_id_set *set, uint64_t id) {
    if (id == TNA_ID_EMPTY) {
        set->count += set->has_max ? 0u : 1u;
        set->has_max = true;
        return;
    }
    uint32_t mask = set->capacity - 1u;
    for (uint32_t at = (uint32_t)tna_id_hash(id) & mask;; at = (at + 1u) & mask) {
        if (set->slots[at] == id) {
            return;
        }
        if (set->slots[at] == TNA_ID_EMPTY) {
            set->slots[at] = id;
            set->count += 1u;
            return;
        }
    }
}

/* Builds a set of `count` IDs. TA_ERR_NOMEM leaves `out` empty. */
static ta_result tna_id_set_build(ta_allocator allocator, const uint64_t *ids, uint32_t count, tna_id_set *out) {
    *out = (tna_id_set){0};
    if (count == 0) {
        return TA_OK;
    }
    if (count > UINT32_MAX / 4u) {
        return TA_ERR_NOMEM;
    }
    uint32_t capacity = 8u;
    while (capacity < count * 2u) {
        capacity *= 2u;
    }
    uint64_t *slots = tna_alloc(allocator, capacity * sizeof(uint64_t), _Alignof(uint64_t));
    if (slots == NULL) {
        return TA_ERR_NOMEM;
    }
    for (uint32_t at = 0; at < capacity; at += 1u) {
        slots[at] = TNA_ID_EMPTY;
    }
    *out = (tna_id_set){ .slots = slots, .capacity = capacity };
    for (uint32_t at = 0; at < count; at += 1u) {
        tna_id_set_put(out, ids[at]);
    }
    return TA_OK;
}

/*
 * Moves the set into a table of `capacity` slots, a power of two at least
 * twice its count. False when there is no memory: the set keeps its table.
 */
static bool tna_id_set_rehash(ta_allocator allocator, tna_id_set *set, uint32_t capacity) {
    uint64_t *slots = tna_alloc(allocator, capacity * sizeof(uint64_t), _Alignof(uint64_t));
    if (slots == NULL) {
        return false;
    }
    for (uint32_t at = 0; at < capacity; at += 1u) {
        slots[at] = TNA_ID_EMPTY;
    }
    tna_id_set moved = { .slots = slots, .capacity = capacity, .has_max = set->has_max,
                         .count = set->has_max ? 1u : 0u };
    for (uint32_t at = 0; at < set->capacity; at += 1u) {
        if (set->slots[at] != TNA_ID_EMPTY) {
            tna_id_set_put(&moved, set->slots[at]);
        }
    }
    tna_id_set_free(allocator, set);
    *set = moved;
    return true;
}

/* Adds `id`, growing the set; false when there is no memory (the set is unchanged). */
static bool tna_id_set_add(ta_allocator allocator, tna_id_set *set, uint64_t id) {
    if (tna_id_set_has(set, id)) {
        return true;
    }
    if (id != TNA_ID_EMPTY && (set->count + 1u) * 2u > set->capacity) {
        uint32_t capacity = set->capacity == 0 ? 8u : set->capacity * 2u;
        if (capacity < set->capacity || !tna_id_set_rehash(allocator, set, capacity)) {
            return false;
        }
    }
    tna_id_set_put(set, id);
    return true;
}

/*
 * Shrinks a set whose load fell to an eighth into a table where it is at
 * most a quarter: the next grow (past a half) and the next shrink are both
 * a factor of two or more away, so adding and removing at either boundary
 * never rebuilds the table each time. The smallest table, 8 slots, is
 * kept even when empty, so one ID coming and going does not allocate each
 * time. Without memory the set keeps its larger table, which still works.
 */
static void tna_id_set_shrink(ta_allocator allocator, tna_id_set *set) {
    uint32_t stored = set->count - (set->has_max ? 1u : 0u);
    if (set->capacity <= 8u || stored * 8u > set->capacity) {
        return;
    }
    uint32_t capacity = 8u;
    while (capacity < stored * 4u) {
        capacity *= 2u;
    }
    if (capacity < set->capacity) {
        (void)tna_id_set_rehash(allocator, set, capacity);
    }
}

/*
 * Removes `id`. With linear probing an emptied slot would cut the probe run
 * of every ID stored after it, so the rest of the run is taken out and put
 * back: no tombstones, and the set never grows from removals.
 */
static void tna_id_set_remove(tna_id_set *set, uint64_t id) {
    if (id == TNA_ID_EMPTY) {
        set->count -= set->has_max ? 1u : 0u;
        set->has_max = false;
        return;
    }
    if (set->capacity == 0) {
        return;
    }
    uint32_t mask = set->capacity - 1u;
    uint32_t at = (uint32_t)tna_id_hash(id) & mask;
    while (set->slots[at] != id) {
        if (set->slots[at] == TNA_ID_EMPTY) {
            return;
        }
        at = (at + 1u) & mask;
    }
    set->slots[at] = TNA_ID_EMPTY;
    set->count -= 1u;
    for (at = (at + 1u) & mask; set->slots[at] != TNA_ID_EMPTY; at = (at + 1u) & mask) {
        uint64_t moved = set->slots[at];
        set->slots[at] = TNA_ID_EMPTY;
        set->count -= 1u;
        tna_id_set_put(set, moved);
    }
}

void tna_trace_watch_forget_definition(tna_trace_watch *watch, ta_definition_id definition) {
    tna_id_set_remove(&watch->matched, definition);
    tna_id_set_remove(&watch->checked, definition);
    tna_id_set_shrink(watch->allocator, &watch->matched);
    tna_id_set_shrink(watch->allocator, &watch->checked);
}

/* Copies `count` family names. TA_ERR_NOMEM frees what was copied. */
static ta_result tna_copy_families(ta_allocator allocator, const ta_str *from, uint32_t count, ta_str **out) {
    *out = NULL;
    if (count == 0) {
        return TA_OK;
    }
    ta_str *families = tna_alloc(allocator, count * sizeof(ta_str), _Alignof(ta_str));
    if (families == NULL) {
        return TA_ERR_NOMEM;
    }
    for (uint32_t at = 0; at < count; at += 1u) {
        families[at] = (ta_str){0};
    }
    for (uint32_t at = 0; at < count; at += 1u) {
        char *copy = tna_alloc(allocator, from[at].len == 0 ? 1u : from[at].len, 1);
        if (copy == NULL) {
            tna_free_families(allocator, families, count);
            return TA_ERR_NOMEM;
        }
        for (uint32_t byte = 0; byte < from[at].len; byte += 1u) {
            copy[byte] = from[at].ptr[byte];
        }
        families[at] = (ta_str){ .ptr = copy, .len = from[at].len };
    }
    *out = families;
    return TA_OK;
}

ta_result tna_trace_watch_set(tna_trace_watch *watch, const tna_trace_watch_set_params *params) {
    tna_id_set sessions;
    ta_str *families = NULL;
    if (tna_id_set_build(watch->allocator, params->sessions, params->session_count, &sessions) != TA_OK) {
        return TA_ERR_NOMEM;
    }
    if (tna_copy_families(watch->allocator, params->families, params->family_count, &families) != TA_OK) {
        tna_id_set_free(watch->allocator, &sessions);
        return TA_ERR_NOMEM;
    }
    tna_trace_watch_destroy(watch);
    watch->sessions = sessions;
    watch->families = families;
    watch->family_count = params->family_count;
    return TA_OK;
}

static bool tna_same_str(ta_str left, ta_str right) {
    if (left.len != right.len) {
        return false;
    }
    for (uint32_t at = 0; at < left.len; at += 1u) {
        if (left.ptr[at] != right.ptr[at]) {
            return false;
        }
    }
    return true;
}

/* Whether `definition`'s family is watched, read once and remembered. */
static bool tna_trace_watch_family(tna_trace_watch *watch, ta_system *core, ta_definition_id definition) {
    if (watch->family_count == 0) {
        return false;
    }
    if (tna_id_set_has(&watch->checked, definition)) {
        return tna_id_set_has(&watch->matched, definition);
    }
    ta_definition_inspection view;
    bool watched = false;
    if (ta_definition_inspect(core, definition, &view) == TA_OK) {
        for (uint32_t at = 0; at < watch->family_count && !watched; at += 1u) {
            watched = tna_same_str(view.identity.family.name, watch->families[at]);
        }
    }
    /* Remembering is an optimization: with no memory, the next delivery
     * reads the family again. `matched` first, so `checked` never claims a
     * definition whose match was lost. */
    if (!watched || tna_id_set_add(watch->allocator, &watch->matched, definition)) {
        (void)tna_id_set_add(watch->allocator, &watch->checked, definition);
    }
    return watched;
}

void tna_trace_watch_mark(tna_trace_watch *watch, ta_system *core, ta_actor_id actor, ta_trace_parent *trace) {
    if (tna_trace_watch_empty(watch)) {
        return;
    }
    ta_actor_inspection view;
    if (ta_actor_inspect(core, actor, &view) != TA_OK ||
        (!tna_id_set_has(&watch->sessions, view.session_id) &&
         !tna_trace_watch_family(watch, core, view.definition_id))) {
        return;
    }
    if (trace->context.trace_id_high == 0 && trace->context.trace_id_low == 0) {
        trace->context = ta_system_new_trace(core);
    }
    trace->context.flags |= TA_TRACE_FLAG_SAMPLED;
    trace->context.detail |= TA_TRACE_DETAIL_WATCHED;
}
