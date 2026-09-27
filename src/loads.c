#include "loads.h"

#include <string.h>

#include "allocator.h"

const char *tna_load_outcome_name(tna_load_outcome outcome) {
    static const char *const names[TNA_LOAD_OUTCOMES] = {
        [TNA_LOAD_LOADED] = "loaded",       [TNA_LOAD_SPAWNED] = "spawned", [TNA_LOAD_NOT_FOUND] = "not_found",
        [TNA_LOAD_REJECTED] = "rejected",   [TNA_LOAD_FAILED] = "failed",   [TNA_LOAD_TIMED_OUT] = "timed_out",
    };
    return (uint32_t)outcome < TNA_LOAD_OUTCOMES ? names[outcome] : "failed";
}

void tna_loads_init(tna_loads *loads, ta_allocator allocator) {
    *loads = (tna_loads){ .allocator = allocator };
    tna_vec_init(&loads->families, allocator, TNA_LAYOUT(tna_loader_family));
    tna_vec_init(&loads->loads, allocator, TNA_LAYOUT(tna_load));
    tna_map_init(&loads->by_address, allocator);
    tna_vec_init(&loads->requests, allocator, TNA_LAYOUT(uint32_t));
    tna_vec_init(&loads->wakes, allocator, TNA_LAYOUT(tna_wake));
    tna_map_init(&loads->wake_due, allocator);
}

void tna_loads_close(tna_loads *loads) {
    for (uint32_t index = 0; index < loads->loads.count; index += 1u) {
        tna_load *load = tna_vec_at(&loads->loads, index);
        ta_address_release(load->address);
        load->address = NULL;
    }
    for (uint32_t index = 0; index < loads->wakes.count; index += 1u) {
        tna_wake *wake = tna_vec_at(&loads->wakes, index);
        ta_address_release(wake->address);
    }
    for (uint32_t index = 0; index < loads->families.count; index += 1u) {
        tna_loader_family *family = tna_vec_at(&loads->families, index);
        tna_free(loads->allocator, &(ta_allocator_free_params){ .ptr = family->name, .size = family->length + 1u,
                                                                 .alignment = 1 });
    }
    tna_vec_destroy(&loads->families);
    tna_vec_destroy(&loads->loads);
    tna_map_destroy(&loads->by_address);
    tna_vec_destroy(&loads->requests);
    tna_vec_destroy(&loads->wakes);
    tna_map_destroy(&loads->wake_due);
    loads->free_head = 0;
    loads->in_flight = 0;
    loads->requests_head = 0;
    loads->waiting = 0;
}

/* ------------------------------------------------------------------------
 * Families
 */

static tna_loader_family *tna_loads_family_named(const tna_loads *loads, ta_str name, uint32_t *at) {
    for (uint32_t index = 0; index < loads->families.count; index += 1u) {
        tna_loader_family *family = tna_vec_at(&loads->families, index);
        if (family->length == name.len && memcmp(family->name, name.ptr, name.len) == 0) {
            if (at != NULL) {
                *at = index;
            }
            return family;
        }
    }
    return NULL;
}

ta_result tna_loads_set_family(tna_loads *loads, ta_str name, uint32_t max_waiting) {
    uint32_t at = 0;
    tna_loader_family *family = tna_loads_family_named(loads, name, &at);
    if (family != NULL && max_waiting != 0) {
        family->max_waiting = max_waiting;
        return TA_OK;
    }
    if (family != NULL) {
        /* Loads already in flight keep the limit they started with. */
        tna_free(loads->allocator, &(ta_allocator_free_params){ .ptr = family->name, .size = family->length + 1u,
                                                                 .alignment = 1 });
        tna_loader_family *last = tna_vec_at(&loads->families, loads->families.count - 1u);
        *family = *last;
        loads->families.count -= 1u;
        return TA_OK;
    }
    if (max_waiting == 0) {
        return TA_OK;
    }
    char *copy = tna_alloc(loads->allocator, (size_t)name.len + 1u, 1);
    if (copy == NULL) {
        return TA_ERR_NOMEM;
    }
    memcpy(copy, name.ptr, name.len);
    copy[name.len] = '\0';
    tna_loader_family fresh = { .name = copy, .length = name.len, .max_waiting = max_waiting };
    if (tna_vec_push(&loads->families, &fresh) != TA_OK) {
        tna_free(loads->allocator, &(ta_allocator_free_params){ .ptr = copy, .size = (size_t)name.len + 1u,
                                                                 .alignment = 1 });
        return TA_ERR_NOMEM;
    }
    return TA_OK;
}

/* The loader limit of the family `address` belongs to, or 0 without a loader. */
static uint32_t tna_loads_limit(const tna_loads *loads, const ta_address *address) {
    if (loads->families.count == 0) {
        return 0;
    }
    const tna_loader_family *family = tna_loads_family_named(loads, ta_address_view(address).family.name, NULL);
    return family == NULL ? 0 : family->max_waiting;
}

/* ------------------------------------------------------------------------
 * Loads
 */

tna_load *tna_loads_find(const tna_loads *loads, uint32_t index, uint32_t generation) {
    if (index == 0 || index >= loads->loads.count) {
        return NULL;
    }
    tna_load *load = tna_vec_at(&loads->loads, index);
    return load->address != NULL && load->generation == generation ? load : NULL;
}

bool tna_loads_would_load(const tna_loads *loads, const ta_address *address) {
    return tna_loads_limit(loads, address) != 0;
}

bool tna_loads_waiting(const tna_loads *loads, const ta_address *address) {
    uint64_t index = 0;
    return tna_map_count(&loads->by_address) != 0 &&
           tna_map_get(&loads->by_address, (uint64_t)(uintptr_t)address, &index);
}

bool tna_loads_withdraw(tna_loads *loads, tna_sched *sched, uint32_t index) {
    tna_envelope *envelope = tna_sched_envelope(sched, index);
    uint64_t load_index = 0;
    if (envelope == NULL || envelope->target != 0 || envelope->address == NULL ||
        tna_map_count(&loads->by_address) == 0 ||
        !tna_map_get(&loads->by_address, (uint64_t)(uintptr_t)envelope->address, &load_index)) {
        return false;
    }
    tna_load *load = tna_vec_at(&loads->loads, (uint32_t)load_index);
    if (!tna_sched_withdraw_waiting(sched, &load->mail, index)) {
        return false;
    }
    loads->waiting -= 1u;
    return true;
}

/* A free record's index, with the record reset; 0 when there is no memory. */
static uint32_t tna_loads_take(tna_loads *loads) {
    if (loads->loads.count == 0) {
        tna_load none = { 0 };
        if (tna_vec_push(&loads->loads, &none) != TA_OK) { /* index 0 is never issued */
            return 0;
        }
    }
    uint32_t index = loads->free_head;
    if (index != 0) {
        loads->free_head = ((tna_load *)tna_vec_at(&loads->loads, index))->next_free;
    } else {
        tna_load fresh = { 0 };
        if (tna_vec_push(&loads->loads, &fresh) != TA_OK) {
            return 0;
        }
        index = loads->loads.count - 1u;
    }
    tna_load *load = tna_vec_at(&loads->loads, index);
    uint32_t generation = load->generation == UINT32_MAX || load->generation == 0 ? 1u : load->generation + 1u;
    *load = (tna_load){ .generation = generation };
    return index;
}

static void tna_loads_give(tna_loads *loads, uint32_t index) {
    tna_load *load = tna_vec_at(&loads->loads, index);
    ta_address_release(load->address);
    load->address = NULL;
    load->next_free = loads->free_head;
    loads->free_head = index;
}

/*
 * Starts a load for `address`: a record, its entry in the address map, and
 * a request. TA_ERR_NOMEM leaves nothing behind. The record's index goes to
 * `*out`.
 */
typedef struct {
    ta_address *address;
    uint32_t max_waiting;
    tna_load_why why;
    const ta_trace_parent *trace;
    uint64_t now_ns;
} tna_load_start;

static ta_result tna_loads_start(tna_loads *loads, const tna_load_start *start, uint32_t *out) {
    uint32_t index = tna_loads_take(loads);
    if (index == 0) {
        return TA_ERR_NOMEM;
    }
    if (tna_vec_reserve(&loads->requests, loads->requests.count + 1u) != TA_OK ||
        tna_map_put(&loads->by_address, (uint64_t)(uintptr_t)start->address, index) != TA_OK) {
        tna_load *load = tna_vec_at(&loads->loads, index);
        load->next_free = loads->free_head;
        loads->free_head = index;
        return TA_ERR_NOMEM;
    }
    (void)tna_vec_push(&loads->requests, &index); /* reserved above */
    tna_load *load = tna_vec_at(&loads->loads, index);
    ta_address_retain(start->address);
    load->address = start->address;
    load->max_waiting = start->max_waiting;
    load->why = (uint8_t)start->why;
    load->started_ns = start->now_ns;
    if (start->trace != NULL) {
        load->trace = *start->trace;
    }
    loads->in_flight += 1u;
    *out = index;
    return TA_OK;
}

/* Appends a message to a load's mailbox, or dead-letters it when it is full. */
static ta_result tna_loads_append(tna_loads *loads, tna_sched *sched, tna_load *load, const tna_message *message) {
    if (load->mail.count >= load->max_waiting) {
        ta_address_retain(load->address);
        ta_result result = tna_sched_post_dead(sched, &(tna_dead_post){ .address = load->address, .message = message,
                                                                        .reason = TNA_DEAD_WAITING_FULL });
        if (result != TA_OK) {
            ta_address_release(load->address);
        }
        return result;
    }
    ta_result result = tna_sched_post_waiting(
        sched, &(tna_waiting_post){ .box = &load->mail, .address = load->address, .message = message });
    if (result == TA_OK) {
        loads->waiting += 1u;
    }
    return result;
}

ta_result tna_loads_route(tna_loads *loads, const tna_load_route *route) {
    uint64_t found = 0;
    if (tna_map_count(&loads->by_address) != 0 &&
        tna_map_get(&loads->by_address, (uint64_t)(uintptr_t)route->address, &found)) {
        return tna_loads_append(loads, route->sched, tna_vec_at(&loads->loads, (uint32_t)found), route->message);
    }
    if (route->resident) {
        return TA_ERR_NOT_FOUND;
    }
    uint32_t limit = tna_loads_limit(loads, route->address);
    if (limit == 0) {
        return TA_ERR_NOT_FOUND;
    }
    uint32_t index = 0;
    ta_result result = tna_loads_start(loads, &(tna_load_start){ .address = route->address,
                                                                  .max_waiting = limit,
                                                                  .why = TNA_LOAD_WHY_MAIL,
                                                                  .trace = route->message->trace,
                                                                  .now_ns = route->now_ns },
                                       &index);
    if (result != TA_OK) {
        return result;
    }
    tna_load *load = tna_vec_at(&loads->loads, index);
    result = tna_loads_append(loads, route->sched, load, route->message);
    if (result != TA_OK) {
        /* Nothing was accepted: the load never happened. */
        loads->requests.count -= 1u;
        tna_map_remove(&loads->by_address, (uint64_t)(uintptr_t)route->address);
        loads->in_flight -= 1u;
        tna_loads_give(loads, index);
    }
    return result;
}

bool tna_loads_next_request(tna_loads *loads, tna_load_request *out) {
    while (loads->requests_head < loads->requests.count) {
        uint32_t index = *(uint32_t *)tna_vec_at(&loads->requests, loads->requests_head);
        loads->requests_head += 1u;
        if (loads->requests_head == loads->requests.count) {
            tna_vec_clear(&loads->requests);
            loads->requests_head = 0;
        }
        tna_load *load = tna_vec_at(&loads->loads, index);
        if (load->address == NULL) {
            continue; /* finished before JavaScript heard of it */
        }
        *out = (tna_load_request){ .index = index, .generation = load->generation, .address = load->address,
                                   .why = (tna_load_why)load->why };
        return true;
    }
    return false;
}

static tna_dead_reason tna_load_dead_reason(tna_load_outcome outcome) {
    switch (outcome) {
    case TNA_LOAD_NOT_FOUND: return TNA_DEAD_NOT_FOUND;
    case TNA_LOAD_REJECTED: return TNA_DEAD_REJECTED;
    case TNA_LOAD_TIMED_OUT: return TNA_DEAD_LOAD_TIMEOUT;
    default: return TNA_DEAD_LOAD_FAILED;
    }
}

ta_result tna_loads_finish(tna_loads *loads, const tna_load_finish *finish) {
    tna_load *load = tna_loads_find(loads, finish->index, finish->generation);
    if (load == NULL) {
        return TA_ERR_STALE;
    }
    tna_load_outcome outcome = finish->outcome;
    ta_result result = TA_OK;
    uint32_t waiting = load->mail.count;
    if (outcome == TNA_LOAD_LOADED || outcome == TNA_LOAD_SPAWNED) {
        ta_actor_directory_entry entry = tna_directory_find(finish->directory, load->address);
        if (entry.kind != TA_ACTOR_DIRECTORY_RESIDENT || entry.actor != finish->actor) {
            return TA_ERR_NOT_FOUND;
        }
        result = tna_sched_hand_over(finish->sched, &load->mail, finish->actor);
        if (result != TA_OK) {
            outcome = TNA_LOAD_FAILED;
        } else {
            tna_loads_cancel_wake(loads, load->address);
        }
    }
    if (load->mail.first != 0) {
        tna_sched_bury_waiting(finish->sched, &load->mail, tna_load_dead_reason(outcome));
    }
    loads->waiting -= waiting;
    loads->outcomes[outcome] += 1u;
    double seconds = finish->now_ns > load->started_ns ? (double)(finish->now_ns - load->started_ns) / 1e9 : 0.0;
    tna_exemplar exemplar =
        tna_exemplar_of(&load->trace.context, ta_step_key_span_id(load->trace.cause), finish->wall_ns);
    tna_histogram_record(&finish->metrics->load_seconds, seconds, &exemplar);
    tna_map_remove(&loads->by_address, (uint64_t)(uintptr_t)load->address);
    loads->in_flight -= 1u;
    tna_loads_give(loads, finish->index);
    return result == TA_OK ? TA_OK : TA_ERR_NOMEM;
}

/* ------------------------------------------------------------------------
 * Wake-ups: a min-heap by due time
 */

static tna_wake *tna_wake_at(const tna_loads *loads, uint32_t index) {
    return tna_vec_at(&loads->wakes, index);
}

static void tna_wake_swap(tna_loads *loads, uint32_t a, uint32_t b) {
    tna_wake held = *tna_wake_at(loads, a);
    *tna_wake_at(loads, a) = *tna_wake_at(loads, b);
    *tna_wake_at(loads, b) = held;
}

static void tna_wake_sift_up(tna_loads *loads, uint32_t index) {
    while (index > 0) {
        uint32_t parent = (index - 1u) / 2u;
        if (tna_wake_at(loads, parent)->due <= tna_wake_at(loads, index)->due) {
            return;
        }
        tna_wake_swap(loads, parent, index);
        index = parent;
    }
}

static void tna_wake_sift_down(tna_loads *loads, uint32_t index) {
    uint32_t count = loads->wakes.count;
    for (;;) {
        uint32_t left = 2u * index + 1u;
        uint32_t right = left + 1u;
        uint32_t least = index;
        if (left < count && tna_wake_at(loads, left)->due < tna_wake_at(loads, least)->due) {
            least = left;
        }
        if (right < count && tna_wake_at(loads, right)->due < tna_wake_at(loads, least)->due) {
            least = right;
        }
        if (least == index) {
            return;
        }
        tna_wake_swap(loads, least, index);
        index = least;
    }
}

/* Removes the heap's top; its reference is the caller's. */
static tna_wake tna_wake_pop(tna_loads *loads) {
    tna_wake top = *tna_wake_at(loads, 0);
    loads->wakes.count -= 1u;
    if (loads->wakes.count != 0) {
        *tna_wake_at(loads, 0) = *tna_wake_at(loads, loads->wakes.count);
        tna_wake_sift_down(loads, 0);
    }
    return top;
}

/* True when the heap entry is its address's live wake-up. */
static bool tna_wake_live(const tna_loads *loads, const tna_wake *wake) {
    uint64_t due = 0;
    return tna_map_get(&loads->wake_due, (uint64_t)(uintptr_t)wake->address, &due) && due == wake->due;
}

ta_result tna_loads_wake_at(tna_loads *loads, ta_address *address, ta_time due) {
    if (tna_vec_reserve(&loads->wakes, loads->wakes.count + 1u) != TA_OK ||
        tna_map_put(&loads->wake_due, (uint64_t)(uintptr_t)address, due) != TA_OK) {
        return TA_ERR_NOMEM;
    }
    ta_address_retain(address);
    tna_wake wake = { .due = due, .address = address };
    (void)tna_vec_push(&loads->wakes, &wake); /* reserved above */
    tna_wake_sift_up(loads, loads->wakes.count - 1u);
    return TA_OK;
}

void tna_loads_cancel_wake(tna_loads *loads, const ta_address *address) {
    if (tna_map_count(&loads->wake_due) != 0) {
        tna_map_remove(&loads->wake_due, (uint64_t)(uintptr_t)address);
    }
}

/* The earliest live wake-up's due time, dropping replaced and cancelled
 * ones from the top; false when there is none. */
static bool tna_loads_live_wake(tna_loads *loads, ta_time *due) {
    while (loads->wakes.count != 0 && !tna_wake_live(loads, tna_wake_at(loads, 0))) {
        tna_wake stale = tna_wake_pop(loads);
        ta_address_release(stale.address);
    }
    if (loads->wakes.count == 0) {
        return false;
    }
    *due = tna_wake_at(loads, 0)->due;
    return true;
}

void tna_loads_fire_wakes(tna_loads *loads, const tna_wake_fire *fire) {
    ta_time due = 0;
    while (tna_loads_live_wake(loads, &due) && due <= fire->now) {
        tna_wake wake = tna_wake_pop(loads);
        tna_map_remove(&loads->wake_due, (uint64_t)(uintptr_t)wake.address);
        ta_actor_directory_entry entry = tna_directory_find(fire->directory, wake.address);
        uint32_t limit = tna_loads_limit(loads, wake.address);
        if (entry.kind != TA_ACTOR_DIRECTORY_RESIDENT && limit != 0 && !tna_loads_waiting(loads, wake.address)) {
            uint32_t index = 0;
            if (tna_loads_start(loads, &(tna_load_start){ .address = wake.address, .max_waiting = limit,
                                                          .why = TNA_LOAD_WHY_TIMER, .now_ns = fire->now_ns },
                                &index) != TA_OK) {
                /* No memory: try again at the next turn, and stop for now. */
                (void)tna_loads_wake_at(loads, wake.address, wake.due);
                ta_address_release(wake.address);
                return;
            }
        }
        ta_address_release(wake.address);
    }
}
