#include "scheduler.h"

#include <string.h>

#include "allocator.h"

#define TNA_QUEUE_CHUNK 1024u

/* ------------------------------------------------------------------------
 * The envelope store
 */

static void tna_envelopes_init(tna_envelopes *store, ta_allocator allocator) {
    *store = (tna_envelopes){ .allocator = allocator, .issued = 1u }; /* index 0 means none */
    tna_vec_init(&store->pages, allocator, TNA_LAYOUT(tna_envelope *));
}

tna_envelope *tna_sched_envelope(const tna_sched *sched, uint32_t index) {
    const tna_envelopes *store = &sched->envelopes;
    uint32_t page = index >> TNA_ENVELOPE_PAGE_BITS;
    if (index == 0 || index >= store->issued || page >= store->pages.count) {
        return NULL;
    }
    tna_envelope **entries = tna_vec_at(&store->pages, page);
    return &(*entries)[index & (TNA_ENVELOPE_PAGE_ENTRIES - 1u)];
}

/* A fresh envelope index, or 0 when no memory. */
static uint32_t tna_envelope_take(tna_sched *sched) {
    tna_envelopes *store = &sched->envelopes;
    uint32_t index = store->free_head;
    if (index != 0) {
        tna_envelope *envelope = tna_sched_envelope(sched, index);
        store->free_head = envelope->next;
    } else {
        if ((store->issued >> TNA_ENVELOPE_PAGE_BITS) >= store->pages.count) {
            /* Every issued index is in use and the last page is full: add a page. */
            size_t bytes = TNA_ENVELOPE_PAGE_ENTRIES * sizeof(tna_envelope);
            tna_envelope *page = tna_alloc(store->allocator, bytes, _Alignof(tna_envelope));
            if (page == NULL) {
                return 0;
            }
            if (tna_vec_push(&store->pages, &page) != TA_OK) {
                tna_free(store->allocator,
                         &(ta_allocator_free_params){ .ptr = page, .size = bytes, .alignment = _Alignof(tna_envelope) });
                return 0;
            }
        }
        index = store->issued;
        store->issued += 1u;
    }
    tna_envelope *envelope = tna_sched_envelope(sched, index);
    *envelope = (tna_envelope){ .live = 1u };
    store->live += 1u;
    return index;
}

static size_t tna_jump_size(uint32_t count) {
    return sizeof(tna_jump) + (size_t)count * sizeof(ta_state_id);
}

/* Frees the operator transition an envelope carries, if any. */
static void tna_jump_give(tna_sched *sched, tna_envelope *envelope) {
    if (!envelope->has_jump) {
        return;
    }
    tna_free(sched->envelopes.allocator, &(ta_allocator_free_params){
                                             .ptr = envelope->jump,
                                             .size = tna_jump_size(envelope->jump->count),
                                             .alignment = _Alignof(tna_jump),
                                         });
    envelope->jump = NULL;
    envelope->has_jump = 0;
}

/* Releases the envelope's references and returns it to the free list. */
static void tna_envelope_give(tna_sched *sched, uint32_t index) {
    tna_envelope *envelope = tna_sched_envelope(sched, index);
    sched->retained -= envelope->bytes;
    ta_event_release(&envelope->event);
    if (envelope->has_jump) {
        tna_jump_give(sched, envelope);
    } else {
        ta_address_release(envelope->address);
    }
    if (envelope->trace != NULL) {
        tna_free_list_give(&sched->traces, envelope->trace);
    }
    *envelope = (tna_envelope){ .next = sched->envelopes.free_head };
    sched->envelopes.free_head = index;
    sched->envelopes.live -= 1u;
    sched->queued -= 1u;
}

static void tna_envelopes_destroy(tna_envelopes *store) {
    for (uint32_t page = 0; page < store->pages.count; page += 1) {
        tna_envelope **entries = tna_vec_at(&store->pages, page);
        tna_free(store->allocator, &(ta_allocator_free_params){
                                       .ptr = *entries,
                                       .size = TNA_ENVELOPE_PAGE_ENTRIES * sizeof(tna_envelope),
                                       .alignment = _Alignof(tna_envelope),
                                   });
    }
    tna_vec_destroy(&store->pages);
    store->issued = 1u;
    store->free_head = 0;
    store->live = 0;
}

const char *tna_dead_reason_name(tna_dead_reason reason) {
    static const char *const names[TNA_DEAD_REASONS] = {
        [TNA_DEAD_NOT_FOUND] = "not-found",       [TNA_DEAD_DONE] = "done",
        [TNA_DEAD_DESTROYED] = "destroyed",       [TNA_DEAD_REFUSED] = "refused",
        [TNA_DEAD_UNLOADED] = "unloaded",         [TNA_DEAD_REJECTED] = "rejected",
        [TNA_DEAD_LOAD_FAILED] = "load-failed",   [TNA_DEAD_LOAD_TIMEOUT] = "load-timeout",
        [TNA_DEAD_WAITING_FULL] = "waiting-full",
    };
    return (uint32_t)reason < TNA_DEAD_REASONS ? names[reason] : "not-found";
}

/* ------------------------------------------------------------------------
 * The table
 */

void tna_sched_init(tna_sched *sched, ta_allocator allocator, ta_allocator envelopes) {
    *sched = (tna_sched){ .allocator = allocator };
    tna_vec_init(&sched->pages, allocator, TNA_LAYOUT(tna_sched_entry *));
    tna_ring_shape shape = { .layout = TNA_LAYOUT(ta_actor_id), .chunk_capacity = TNA_QUEUE_CHUNK };
    tna_ring_init(&sched->runnable, allocator, shape);
    tna_ring_init(&sched->ready, allocator, shape);
    tna_envelopes_init(&sched->envelopes, envelopes);
    tna_free_list_init(&sched->traces, envelopes, TNA_LAYOUT(ta_trace_parent));
    tna_vec_init(&sched->waiters, envelopes, TNA_LAYOUT(tna_waiter));
    tna_map_init(&sched->inflight, allocator);
    /* One chunk holds a default turn's settlements (messageBudget and
     * resumesPerTurn are 1024 by default), so steady state reuses it. */
    tna_ring_init(&sched->settled, allocator,
                  (tna_ring_shape){ .layout = TNA_LAYOUT(tna_settlement), .chunk_capacity = TNA_QUEUE_CHUNK });
}

void tna_sched_discard_mail(tna_sched *sched) {
    tna_envelopes *store = &sched->envelopes;
    for (uint32_t index = 1; index < store->issued; index += 1) {
        tna_envelope *envelope = tna_sched_envelope(sched, index);
        if (envelope->live) {
            ta_event_release(&envelope->event);
            envelope->event = (ta_event){0};
            if (envelope->has_jump) {
                tna_jump_give(sched, envelope);
            } else {
                ta_address_release(envelope->address);
                envelope->address = NULL;
            }
            if (envelope->trace != NULL) {
                tna_free_list_give(&sched->traces, envelope->trace);
                envelope->trace = NULL;
            }
        }
    }
}

void tna_sched_destroy(tna_sched *sched) {
    for (uint32_t page = 0; page < sched->pages.count; page += 1) {
        tna_sched_entry **entries = tna_vec_at(&sched->pages, page);
        if (*entries != NULL) {
            tna_free(sched->allocator, &(ta_allocator_free_params){
                                           .ptr = *entries,
                                           .size = TNA_SCHED_PAGE_ENTRIES * sizeof(tna_sched_entry),
                                           .alignment = _Alignof(tna_sched_entry),
                                       });
        }
    }
    tna_vec_destroy(&sched->pages);
    tna_ring_destroy(&sched->runnable);
    tna_ring_destroy(&sched->ready);
    tna_sched_discard_mail(sched); /* gives back the trace parents envelopes hold */
    tna_envelopes_destroy(&sched->envelopes);
    tna_free_list_destroy(&sched->traces);
    tna_vec_destroy(&sched->waiters);
    tna_map_destroy(&sched->inflight);
    tna_ring_destroy(&sched->settled);
    sched->waiter_free = 0;
    sched->waiters_live = 0;
    sched->retained = 0;
    sched->known = 0;
    sched->queued = 0;
    sched->dead_first = 0;
    sched->dead_last = 0;
    sched->dead_count = 0;
    sched->records = NULL;
    sched->last_record = NULL;
    sched->record_count = 0;
}

tna_sched_entry *tna_sched_entry_at(const tna_sched *sched, uint32_t slot) {
    uint32_t page = slot >> TNA_SCHED_PAGE_BITS;
    if (page >= sched->pages.count) {
        return NULL;
    }
    tna_sched_entry **entries = tna_vec_at(&sched->pages, page);
    return *entries == NULL ? NULL : &(*entries)[slot & (TNA_SCHED_PAGE_ENTRIES - 1u)];
}

tna_sched_entry *tna_sched_lookup(const tna_sched *sched, ta_actor_id actor) {
    tna_sched_entry *entry = tna_sched_entry_at(sched, ta_actor_id_slot(actor));
    if (entry == NULL || entry->state == TNA_SCHED_NONE || entry->generation != ta_actor_id_generation(actor)) {
        return NULL;
    }
    return entry;
}

/* The entry of `slot`, allocating its page (and the directory up to it). */
static tna_sched_entry *tna_sched_entry_make(tna_sched *sched, uint32_t slot) {
    uint32_t page = slot >> TNA_SCHED_PAGE_BITS;
    if (page >= sched->pages.count) {
        if (tna_vec_reserve(&sched->pages, page + 1u) != TA_OK) {
            return NULL;
        }
        tna_sched_entry *none = NULL;
        while (sched->pages.count <= page) {
            if (tna_vec_push(&sched->pages, &none) != TA_OK) {
                return NULL;
            }
        }
    }
    tna_sched_entry **entries = tna_vec_at(&sched->pages, page);
    if (*entries == NULL) {
        size_t bytes = TNA_SCHED_PAGE_ENTRIES * sizeof(tna_sched_entry);
        *entries = tna_alloc(sched->allocator, bytes, _Alignof(tna_sched_entry));
        if (*entries == NULL) {
            return NULL;
        }
        memset(*entries, 0, bytes);
    }
    return &(*entries)[slot & (TNA_SCHED_PAGE_ENTRIES - 1u)];
}

/* Appends one taken envelope to the dead list. */
static void tna_sched_dead_append(tna_sched *sched, uint32_t index, tna_dead_reason reason) {
    tna_envelope *envelope = tna_sched_envelope(sched, index);
    envelope->reason = (uint8_t)reason;
    envelope->next = 0;
    if (sched->dead_last != 0) {
        tna_sched_envelope(sched, sched->dead_last)->next = index;
    } else {
        sched->dead_first = index;
    }
    sched->dead_last = index;
    sched->dead_count += 1u;
}

/* Moves the entry's whole mailbox to the dead list (ADR 0005 point 10). */
static void tna_sched_bury(tna_sched *sched, tna_sched_entry *entry, tna_dead_reason reason) {
    uint32_t index = entry->first;
    while (index != 0) {
        uint32_t next = tna_sched_envelope(sched, index)->next;
        tna_sched_dead_append(sched, index, reason);
        index = next;
    }
    entry->first = 0;
    entry->last = 0;
}

/* ------------------------------------------------------------------------
 * send() waiters
 */

tna_waiter *tna_sched_waiter(const tna_sched *sched, uint32_t index) {
    if (index == 0 || index >= sched->waiters.count) {
        return NULL;
    }
    return tna_vec_at(&sched->waiters, index);
}

uint32_t tna_sched_waiter_take(tna_sched *sched) {
    if (sched->waiters.count == 0) {
        tna_waiter none = { .generation = 1u };
        if (tna_vec_push(&sched->waiters, &none) != TA_OK) { /* index 0 is never issued */
            return 0;
        }
    }
    uint32_t index = sched->waiter_free;
    if (index != 0) {
        sched->waiter_free = tna_sched_waiter(sched, index)->next_free;
    } else {
        tna_waiter fresh = { .generation = 1u };
        if (tna_vec_push(&sched->waiters, &fresh) != TA_OK) {
            return 0;
        }
        index = sched->waiters.count - 1u;
    }
    tna_waiter *waiter = tna_sched_waiter(sched, index);
    waiter->state = TNA_WAITER_SETTLING; /* the caller's until a post takes it */
    waiter->envelope = 0;
    waiter->actor = 0;
    waiter->next_free = 0;
    waiter->host = NULL;
    sched->waiters_live += 1u;
    return index;
}

void tna_sched_waiter_give(tna_sched *sched, uint32_t index) {
    tna_waiter *waiter = tna_sched_waiter(sched, index);
    if (waiter == NULL || waiter->state == TNA_WAITER_FREE) {
        return;
    }
    waiter->generation = waiter->generation == UINT32_MAX ? 1u : waiter->generation + 1u;
    waiter->state = TNA_WAITER_FREE;
    waiter->host = NULL;
    waiter->next_free = sched->waiter_free;
    sched->waiter_free = index;
    sched->waiters_live -= 1u;
}

bool tna_sched_settlement_pop(tna_sched *sched, tna_settlement *out) {
    return tna_ring_pop(&sched->settled, out);
}

/* Queues a settlement for a waiter and marks it SETTLING. */
static void tna_sched_settle_waiter(tna_sched *sched, uint32_t index, tna_settlement settlement) {
    tna_waiter *waiter = tna_sched_waiter(sched, index);
    if (waiter == NULL) {
        return;
    }
    waiter->state = TNA_WAITER_SETTLING;
    settlement.waiter = index;
    /* The ring keeps a spare chunk, so this allocates only as it grows. If
     * it cannot, the promise is not settled until close() rejects it. */
    (void)tna_ring_push(&sched->settled, &settlement);
}

/* The macrostep `actor` ran for a send() ended: settle its waiter. */
static void tna_sched_complete(tna_sched *sched, ta_actor_id actor, tna_settlement settlement) {
    uint64_t index = 0;
    if (tna_map_count(&sched->inflight) == 0 || !tna_map_get(&sched->inflight, actor, &index)) {
        return;
    }
    tna_map_remove(&sched->inflight, actor);
    settlement.actor = actor;
    tna_sched_settle_waiter(sched, (uint32_t)index, settlement);
}

/* Unlinks `index` from the entry's mailbox; false when it is not there. */
static bool tna_sched_unlink(tna_sched *sched, tna_sched_entry *entry, uint32_t index) {
    uint32_t previous = 0;
    for (uint32_t at = entry->first; at != 0; at = tna_sched_envelope(sched, at)->next) {
        if (at == index) {
            uint32_t next = tna_sched_envelope(sched, at)->next;
            if (previous == 0) {
                entry->first = next;
            } else {
                tna_sched_envelope(sched, previous)->next = next;
            }
            if (entry->last == index) {
                entry->last = previous;
            }
            return true;
        }
        previous = at;
    }
    return false;
}

bool tna_sched_cancel(tna_sched *sched, uint32_t index) {
    tna_waiter *waiter = tna_sched_waiter(sched, index);
    if (waiter == NULL) {
        return false;
    }
    if (waiter->state == TNA_WAITER_QUEUED) {
        /* A message waiting for a load is withdrawn by tna_system_cancel(). */
        tna_envelope *envelope = tna_sched_envelope(sched, waiter->envelope);
        tna_sched_entry *entry = tna_sched_lookup(sched, waiter->actor);
        if (envelope != NULL && entry != NULL && tna_sched_unlink(sched, entry, waiter->envelope)) {
            /* A ready actor whose mailbox is now empty becomes idle when popped. */
            tna_envelope_give(sched, waiter->envelope);
        } else if (envelope != NULL) {
            envelope->waiter = 0; /* on the dead list: still reported, without the waiter */
        }
        waiter->state = TNA_WAITER_SETTLING;
        return true;
    }
    if (waiter->state == TNA_WAITER_INFLIGHT) {
        tna_map_remove(&sched->inflight, waiter->actor);
        waiter->state = TNA_WAITER_SETTLING;
        return true;
    }
    return false;
}

ta_result tna_sched_add(tna_sched *sched, ta_actor_id actor) {
    tna_sched_entry *entry = tna_sched_entry_make(sched, ta_actor_id_slot(actor));
    if (entry == NULL) {
        return TA_ERR_NOMEM;
    }
    if (tna_ring_push(&sched->runnable, &actor) != TA_OK) {
        return TA_ERR_NOMEM;
    }
    if (entry->state == TNA_SCHED_NONE) {
        sched->known += 1u;
    } else {
        /* A previous actor of this slot the addon never saw go: its mail is dead. */
        sched->quarantined -= entry->state == TNA_SCHED_QUARANTINED ? 1u : 0u;
        tna_sched_bury(sched, entry, TNA_DEAD_NOT_FOUND);
        tna_sched_complete(sched, ta_actor_id_make(ta_actor_id_slot(actor), entry->generation),
                           (tna_settlement){ .kind = TNA_SETTLE_DEAD, .reason = TNA_DEAD_NOT_FOUND });
    }
    *entry = (tna_sched_entry){ .generation = ta_actor_id_generation(actor), .state = TNA_SCHED_RUNNABLE };
    return TA_OK;
}

void tna_sched_remove(tna_sched *sched, ta_actor_id actor, tna_dead_reason reason) {
    tna_sched_entry *entry = tna_sched_lookup(sched, actor);
    if (entry == NULL) {
        return;
    }
    tna_sched_bury(sched, entry, reason);
    tna_sched_complete(sched, actor, (tna_settlement){ .kind = TNA_SETTLE_DEAD, .reason = (uint8_t)reason });
    sched->quarantined -= entry->state == TNA_SCHED_QUARANTINED ? 1u : 0u;
    *entry = (tna_sched_entry){0};
    sched->known -= 1u;
}

/*
 * Moves the list `first`..`last`, in order, to the front of `to`'s mailbox,
 * with its send() waiters; an idle `to` becomes ready. TA_ERR_NOMEM, with
 * nothing moved, when `to` cannot join the ready queue.
 */
typedef struct {
    uint32_t first;
    uint32_t last;
    ta_actor_id to;
    tna_sched_entry *entry; /* `to`'s */
} tna_splice;

static ta_result tna_sched_splice_front(tna_sched *sched, const tna_splice *splice) {
    tna_sched_entry *to = splice->entry;
    if (splice->first == 0) {
        return TA_OK;
    }
    if (to->state == TNA_SCHED_IDLE && tna_ring_push(&sched->ready, &splice->to) != TA_OK) {
        return TA_ERR_NOMEM;
    }
    for (uint32_t index = splice->first; index != 0;) {
        tna_envelope *envelope = tna_sched_envelope(sched, index);
        envelope->target = splice->to;
        tna_waiter *waiter = tna_sched_waiter(sched, envelope->waiter);
        if (waiter != NULL && waiter->state == TNA_WAITER_QUEUED) {
            waiter->actor = splice->to;
        }
        index = envelope->next;
    }
    tna_sched_envelope(sched, splice->last)->next = to->first;
    if (to->last == 0) {
        to->last = splice->last;
    }
    to->first = splice->first;
    if (to->state == TNA_SCHED_IDLE) {
        to->state = TNA_SCHED_READY;
    }
    return TA_OK;
}

ta_result tna_sched_transfer(tna_sched *sched, const tna_sched_transfer_params *params) {
    tna_sched_entry *from = tna_sched_lookup(sched, params->from);
    tna_sched_entry *to = tna_sched_lookup(sched, params->to);
    if (from == NULL || to == NULL) {
        return TA_ERR_NOT_FOUND;
    }
    if (from == to || from->first == 0) {
        return TA_OK;
    }
    ta_result result = tna_sched_splice_front(
        sched, &(tna_splice){ .first = from->first, .last = from->last, .to = params->to, .entry = to });
    if (result != TA_OK) {
        return result;
    }
    from->first = 0;
    from->last = 0;
    if (from->state == TNA_SCHED_READY) {
        from->state = TNA_SCHED_IDLE; /* its ready-queue entry is skipped */
    }
    return TA_OK;
}

ta_result tna_sched_hand_over(tna_sched *sched, tna_mailbox *box, ta_actor_id to) {
    tna_sched_entry *entry = tna_sched_lookup(sched, to);
    if (entry == NULL) {
        return TA_ERR_NOT_FOUND;
    }
    ta_result result = tna_sched_splice_front(
        sched, &(tna_splice){ .first = box->first, .last = box->last, .to = to, .entry = entry });
    if (result == TA_OK) {
        *box = (tna_mailbox){ 0 };
    }
    return result;
}

void tna_sched_bury_waiting(tna_sched *sched, tna_mailbox *box, tna_dead_reason reason) {
    uint32_t index = box->first;
    while (index != 0) {
        uint32_t next = tna_sched_envelope(sched, index)->next;
        tna_sched_dead_append(sched, index, reason);
        index = next;
    }
    *box = (tna_mailbox){ 0 };
}

bool tna_sched_withdraw_waiting(tna_sched *sched, tna_mailbox *box, uint32_t index) {
    uint32_t previous = 0;
    for (uint32_t at = box->first; at != 0; at = tna_sched_envelope(sched, at)->next) {
        if (at == index) {
            uint32_t next = tna_sched_envelope(sched, at)->next;
            if (previous == 0) {
                box->first = next;
            } else {
                tna_sched_envelope(sched, previous)->next = next;
            }
            if (box->last == index) {
                box->last = previous;
            }
            box->count -= 1u;
            tna_envelope_give(sched, index);
            return true;
        }
        previous = at;
    }
    return false;
}

ta_result tna_sched_wake(tna_sched *sched, ta_actor_id actor) {
    tna_sched_entry *entry = tna_sched_lookup(sched, actor);
    if (entry == NULL) {
        return TA_ERR_NOT_FOUND;
    }
    if (entry->state != TNA_SCHED_IDLE && entry->state != TNA_SCHED_READY) {
        return TA_OK;
    }
    /* A ready actor's entry in the ready queue is skipped once it is runnable. */
    if (tna_ring_push(&sched->runnable, &actor) != TA_OK) {
        return TA_ERR_NOMEM;
    }
    entry->state = TNA_SCHED_RUNNABLE;
    return TA_OK;
}

ta_result tna_sched_release(tna_sched *sched, ta_actor_id actor) {
    tna_sched_entry *entry = tna_sched_lookup(sched, actor);
    if (entry == NULL) {
        return TA_ERR_NOT_FOUND;
    }
    if (entry->state != TNA_SCHED_QUARANTINED) {
        return TA_OK;
    }
    if (tna_ring_push(&sched->runnable, &actor) != TA_OK) {
        return TA_ERR_NOMEM;
    }
    entry->state = TNA_SCHED_RUNNABLE;
    entry->flags &= (uint8_t)~TNA_SCHED_BACKOFF;
    sched->quarantined -= 1u;
    return TA_OK;
}

ta_result tna_sched_abandoned(tna_sched *sched, ta_actor_id actor) {
    tna_sched_entry *entry = tna_sched_lookup(sched, actor);
    if (entry == NULL) {
        return TA_ERR_NOT_FOUND;
    }
    tna_sched_complete(sched, actor, (tna_settlement){ .kind = TNA_SETTLE_ABANDONED });
    /* The macrostep a release() lifted the microstep limit for is gone. */
    entry->flags &= (uint8_t)~TNA_SCHED_UNLIMITED;
    if (entry->state != TNA_SCHED_RUNNABLE) {
        return TA_OK; /* quarantined (a runaway's release() then finds it stable), or core abandoned an event the addon never delivered */
    }
    entry->flags &= (uint8_t)~TNA_SCHED_BACKOFF;
    if (entry->first == 0) {
        entry->state = TNA_SCHED_IDLE;
        return TA_OK;
    }
    entry->state = TNA_SCHED_READY;
    if (tna_ring_push(&sched->ready, &actor) != TA_OK) {
        /* No room in the ready queue: it stays runnable, and its entry in the
         * runnable queue resumes it, which finds it stable and settles it. */
        entry->state = TNA_SCHED_RUNNABLE;
    }
    return TA_OK;
}

bool tna_sched_quiet(const tna_sched *sched) {
    return tna_ring_count(&sched->runnable) == 0 && tna_ring_count(&sched->ready) == 0 && sched->dead_count == 0 &&
           tna_ring_count(&sched->settled) == 0;
}

uint32_t tna_sched_mailbox_count(const tna_sched *sched, ta_actor_id actor) {
    const tna_sched_entry *entry = tna_sched_lookup(sched, actor);
    uint32_t count = 0;
    for (uint32_t index = entry == NULL ? 0 : entry->first; index != 0;
         index = tna_sched_envelope(sched, index)->next) {
        count += 1u;
    }
    return count;
}

/* ------------------------------------------------------------------------
 * Posting
 */

/* The limits a message must fit before it is accepted (ADR 0005 point 9). */
static bool tna_sched_full(const tna_sched *sched, uint32_t bytes) {
    return (sched->max_queued != 0 && sched->queued >= sched->max_queued) ||
           (sched->max_retained != 0 && sched->retained + bytes > sched->max_retained);
}

/* A copy of the message's trace parent from the free list, or NULL for an
 * untraced message. False when there is no memory for one. */
static bool tna_sched_take_trace(tna_sched *sched, const tna_message *message, ta_trace_parent **out) {
    *out = NULL;
    const ta_trace_parent *trace = message->trace;
    if (trace == NULL || (trace->context.trace_id_high == 0 && trace->context.trace_id_low == 0 &&
                          trace->cause.session == 0 && trace->cause.macrostep == 0)) {
        return true;
    }
    *out = tna_free_list_take(&sched->traces);
    if (*out == NULL) {
        return false;
    }
    **out = *trace;
    return true;
}

/* A copy of the message's operator transition, or NULL for none. False when
 * there is no memory for one. */
static bool tna_sched_take_jump(tna_sched *sched, const tna_message *message, tna_jump **out) {
    *out = NULL;
    const tna_message_jump *jump = message->jump;
    if (jump == NULL) {
        return true;
    }
    uint32_t count = jump->transition.target_count;
    *out = tna_alloc(sched->envelopes.allocator, tna_jump_size(count), _Alignof(tna_jump));
    if (*out == NULL) {
        return false;
    }
    (*out)->definition = jump->definition;
    (*out)->source = jump->transition.source;
    (*out)->count = count;
    if (count != 0) {
        memcpy((*out)->targets, jump->transition.targets, (size_t)count * sizeof(ta_state_id));
    }
    return true;
}

/* Fills a taken envelope from the message and attaches its waiter. */
static void tna_sched_fill(tna_sched *sched, uint32_t index, const tna_message *message, ta_trace_parent *trace) {
    tna_envelope *envelope = tna_sched_envelope(sched, index);
    envelope->trace = trace;
    envelope->event = *message->event;
    envelope->target = message->target;
    envelope->bytes = message->bytes;
    envelope->waiter = message->waiter;
    sched->queued += 1u;
    sched->retained += message->bytes;
    tna_waiter *waiter = tna_sched_waiter(sched, message->waiter);
    if (waiter != NULL) {
        waiter->state = TNA_WAITER_QUEUED;
        waiter->envelope = index;
        waiter->actor = message->target;
    }
}

ta_result tna_sched_post(tna_sched *sched, const tna_message *message) {
    ta_actor_id target = message->target;
    if (tna_sched_full(sched, message->bytes)) {
        return TA_ERR_BUSY;
    }
    tna_sched_entry *entry = tna_sched_lookup(sched, target);
    bool dead = entry == NULL || (entry->flags & TNA_SCHED_FINISHED) != 0;
    /* An idle actor joins the ready queue; reserve that before taking mail. */
    if (!dead && entry->state == TNA_SCHED_IDLE && tna_ring_push(&sched->ready, &target) != TA_OK) {
        return TA_ERR_NOMEM;
    }
    ta_trace_parent *trace = NULL;
    if (!tna_sched_take_trace(sched, message, &trace)) {
        return TA_ERR_NOMEM; /* a ready-queue entry pushed above names an idle actor; delivery skips it */
    }
    tna_jump *jump = NULL;
    uint32_t index = tna_sched_take_jump(sched, message, &jump) ? tna_envelope_take(sched) : 0;
    if (index == 0) {
        /* A ready-queue entry pushed above names an idle actor; delivery skips it. */
        if (trace != NULL) {
            tna_free_list_give(&sched->traces, trace);
        }
        if (jump != NULL) {
            tna_free(sched->envelopes.allocator, &(ta_allocator_free_params){
                                                     .ptr = jump,
                                                     .size = tna_jump_size(jump->count),
                                                     .alignment = _Alignof(tna_jump),
                                                 });
        }
        return TA_ERR_NOMEM;
    }
    tna_sched_fill(sched, index, message, trace);
    if (jump != NULL) {
        tna_envelope *envelope = tna_sched_envelope(sched, index);
        envelope->jump = jump;
        envelope->has_jump = 1u;
    }
    if (dead) {
        tna_sched_dead_append(sched, index, entry == NULL ? TNA_DEAD_NOT_FOUND : TNA_DEAD_DONE);
        return TA_OK;
    }
    if (entry->last != 0) {
        tna_sched_envelope(sched, entry->last)->next = index;
    } else {
        entry->first = index;
    }
    entry->last = index;
    if (entry->state == TNA_SCHED_IDLE) {
        entry->state = TNA_SCHED_READY;
    }
    return TA_OK;
}

ta_result tna_sched_post_waiting(tna_sched *sched, const tna_waiting_post *post) {
    if (tna_sched_full(sched, post->message->bytes)) {
        return TA_ERR_BUSY;
    }
    ta_trace_parent *trace = NULL;
    if (!tna_sched_take_trace(sched, post->message, &trace)) {
        return TA_ERR_NOMEM;
    }
    uint32_t index = tna_envelope_take(sched);
    if (index == 0) {
        if (trace != NULL) {
            tna_free_list_give(&sched->traces, trace);
        }
        return TA_ERR_NOMEM;
    }
    tna_message message = *post->message;
    message.target = 0; /* no actor yet: the hand-over names it */
    tna_sched_fill(sched, index, &message, trace);
    ta_address_retain(post->address);
    tna_envelope *envelope = tna_sched_envelope(sched, index);
    envelope->address = post->address; /* a dead letter names it if the load fails */
    tna_mailbox *box = post->box;
    if (box->last != 0) {
        tna_sched_envelope(sched, box->last)->next = index;
    } else {
        box->first = index;
    }
    box->last = index;
    box->count += 1u;
    return TA_OK;
}

ta_result tna_sched_post_dead(tna_sched *sched, const tna_dead_post *post) {
    if (tna_sched_full(sched, post->message->bytes)) {
        return TA_ERR_BUSY;
    }
    ta_trace_parent *trace = NULL;
    if (!tna_sched_take_trace(sched, post->message, &trace)) {
        return TA_ERR_NOMEM;
    }
    uint32_t index = tna_envelope_take(sched);
    if (index == 0) {
        if (trace != NULL) {
            tna_free_list_give(&sched->traces, trace);
        }
        return TA_ERR_NOMEM;
    }
    tna_sched_fill(sched, index, post->message, trace);
    tna_envelope *envelope = tna_sched_envelope(sched, index);
    envelope->target = 0;
    envelope->address = post->address;
    tna_sched_dead_append(sched, index, post->reason);
    return TA_OK;
}

/* ------------------------------------------------------------------------
 * The turn
 */

static void tna_sched_record(tna_sched *sched, const tna_turn_params *params, tna_turn_record record) {
    tna_turn_record *copy = ta_arena_alloc(params->arena, sizeof *copy, _Alignof(tna_turn_record));
    if (copy == NULL) {
        /* The turn arena is out of memory: the hook is not called, and what
         * the record owned goes back now. */
        ta_value_release(&record.data);
        return;
    }
    *copy = record;
    copy->next = NULL;
    if (sched->last_record != NULL) {
        sched->last_record->next = copy;
    } else {
        sched->records = copy;
    }
    sched->last_record = copy;
    sched->record_count += 1u;
}

/* Quarantines the record's actor (ADR 0008) and records the fault. */
static void tna_sched_fault(tna_sched *sched, const tna_turn_params *params, tna_turn_record record) {
    tna_sched_entry *entry = tna_sched_lookup(sched, record.actor);
    uint32_t code = record.code < 0 ? (uint32_t)(-(int64_t)record.code) : 0u;
    sched->faults[code < TNA_FAULT_CODES ? code : 0u] += 1u;
    if (entry != NULL) {
        sched->quarantined += entry->state == TNA_SCHED_QUARANTINED ? 0u : 1u;
        entry->state = TNA_SCHED_QUARANTINED;
        entry->flags &= (uint8_t)~TNA_SCHED_BACKOFF;
    }
    record.kind = TNA_RECORD_FAULT;
    tna_sched_record(sched, params, record);
}

/* Puts an actor back at the end of `queue`; a failure is a fault. */
static void tna_sched_requeue(tna_sched *sched, const tna_turn_params *params, tna_ring *queue, ta_actor_id actor) {
    if (tna_ring_push(queue, &actor) != TA_OK) {
        tna_sched_fault(sched, params, (tna_turn_record){ .actor = actor, .operation = "schedule", .code = TA_ERR_NOMEM });
    }
}

/* A stable actor: ready when it has mail, idle otherwise. */
static void tna_sched_settle(tna_sched *sched, const tna_turn_params *params, tna_sched_entry *entry, ta_actor_id actor) {
    if (entry->first == 0) {
        entry->state = TNA_SCHED_IDLE;
        return;
    }
    entry->state = TNA_SCHED_READY;
    tna_sched_requeue(sched, params, &sched->ready, actor);
}

static void tna_sched_resume_one(tna_sched *sched, const tna_turn_params *params, ta_actor_id actor) {
    tna_sched_entry *entry = tna_sched_lookup(sched, actor);
    if (entry == NULL || entry->state != TNA_SCHED_RUNNABLE) {
        return; /* destroyed, replaced or quarantined since it was queued */
    }
    if ((entry->flags & TNA_SCHED_BACKOFF) != 0) {
        entry->flags &= (uint8_t)~TNA_SCHED_BACKOFF;
        tna_sched_requeue(sched, params, &sched->runnable, actor);
        return;
    }
    ta_run_status status = TA_RUN_STABLE;
    ta_actor_resume_params resume = {
        .actor = actor,
        .budget = params->budgets.microsteps,
        .status = &status,
        .action_budget = params->budgets.actions,
        .no_microstep_limit = (entry->flags & TNA_SCHED_UNLIMITED) != 0,
    };
    *params->inside_core = true;
    ta_result result = ta_actor_resume(params->core, &resume);
    *params->inside_core = false;
    /* The table is the addon's: core calls never move its pages. */
    if (result == TA_ERR_NOMEM) {
        entry->flags |= TNA_SCHED_BACKOFF;
        tna_sched_requeue(sched, params, &sched->runnable, actor);
        return;
    }
    if (result == TA_ERR_NOT_FOUND) {
        tna_sched_remove(sched, actor, TNA_DEAD_NOT_FOUND);
        return;
    }
    if (result != TA_OK) {
        if (result == TA_ERR_RUNAWAY) {
            /* Quarantined as a runaway: an operator's release() lets this
             * macrostep finish; the next one has the limit again. */
            entry->flags |= TNA_SCHED_UNLIMITED;
        }
        tna_sched_complete(sched, actor, (tna_settlement){ .kind = TNA_SETTLE_FAULT, .code = result });
        tna_sched_fault(sched, params, (tna_turn_record){ .actor = actor, .operation = "resume", .code = result });
        return;
    }
    switch (status) {
    case TA_RUN_PAUSED:
        tna_sched_requeue(sched, params, &sched->runnable, actor);
        return;
    case TA_RUN_DONE:
        entry->flags &= (uint8_t)~TNA_SCHED_UNLIMITED;
        tna_sched_complete(sched, actor, (tna_settlement){ .kind = TNA_SETTLE_DONE });
        entry->state = TNA_SCHED_IDLE;
        tna_sched_bury(sched, entry, TNA_DEAD_DONE);
        if ((entry->flags & TNA_SCHED_FINISHED) == 0) {
            entry->flags |= TNA_SCHED_FINISHED;
            tna_sched_record(sched, params, (tna_turn_record){ .kind = TNA_RECORD_DONE, .actor = actor });
        }
        return;
    case TA_RUN_STABLE:
    default:
        entry->flags &= (uint8_t)~TNA_SCHED_UNLIMITED;
        tna_sched_complete(sched, actor, (tna_settlement){ .kind = TNA_SETTLE_STABLE });
        tna_sched_settle(sched, params, entry, actor);
        return;
    }
}

/*
 * The operator transition of a jump envelope for ta_actor_deliver(), or NULL
 * when the actor no longer runs the definition its state IDs belong to (a
 * replacement took the mail over, ADR 0005 point 12). Only a jump pays for
 * the inspection.
 */
static const ta_operator_transition *tna_sched_jump(const tna_turn_params *params, ta_actor_id actor, const tna_jump *jump,
                                                    ta_operator_transition *out) {
    ta_actor_inspection view;
    *params->inside_core = true;
    ta_result result = ta_actor_inspect(params->core, actor, &view);
    *params->inside_core = false;
    if (result != TA_OK || view.definition_id != jump->definition) {
        return NULL;
    }
    *out = (ta_operator_transition){ .source = jump->source, .targets = jump->targets, .target_count = jump->count };
    return out;
}

/* The head envelope is a jump the actor does not accept: a dead letter with
 * reason `refused`, and the actor stands between macrosteps as before. */
static void tna_sched_refuse_jump(tna_sched *sched, const tna_turn_params *params, tna_sched_entry *entry, ta_actor_id actor) {
    uint32_t head = entry->first;
    entry->first = tna_sched_envelope(sched, head)->next;
    if (entry->first == 0) {
        entry->last = 0;
    }
    tna_sched_dead_append(sched, head, TNA_DEAD_REFUSED);
    tna_sched_settle(sched, params, entry, actor);
}

/* Delivers the head envelope of a ready actor (ADR 0005 point 6). */
static void tna_sched_deliver_one(tna_sched *sched, const tna_turn_params *params, ta_actor_id actor) {
    tna_sched_entry *entry = tna_sched_lookup(sched, actor);
    if (entry == NULL || entry->state != TNA_SCHED_READY) {
        return; /* destroyed, replaced or quarantined since it was queued */
    }
    if ((entry->flags & TNA_SCHED_BACKOFF) != 0) {
        entry->flags &= (uint8_t)~TNA_SCHED_BACKOFF;
        tna_sched_requeue(sched, params, &sched->ready, actor);
        return;
    }
    if (entry->first == 0) {
        entry->state = TNA_SCHED_IDLE;
        return;
    }
    uint32_t head = entry->first;
    tna_envelope *envelope = tna_sched_envelope(sched, head);
    ta_trace_parent trace = envelope->trace != NULL ? *envelope->trace : (ta_trace_parent){0};
    tna_trace_watch_mark(params->watch, params->core, actor, &trace);
    ta_operator_transition jump;
    const ta_operator_transition *transition = NULL;
    if (envelope->has_jump) {
        transition = tna_sched_jump(params, actor, envelope->jump, &jump);
        if (transition == NULL) {
            tna_sched_refuse_jump(sched, params, entry, actor);
            return;
        }
    }
    *params->inside_core = true;
    ta_result result = ta_actor_deliver(params->core, &(ta_actor_deliver_params){
                                                         .actor = actor,
                                                         .event = &envelope->event,
                                                         .trace = trace,
                                                         .transition = transition,
                                                     });
    *params->inside_core = false;
    switch (result) {
    case TA_OK:
        /* Core retained what it keeps; the envelope's own references go. */
        entry->first = envelope->next;
        if (entry->first == 0) {
            entry->last = 0;
        }
        if (envelope->waiter != 0) {
            /* The send() follows the macrostep this message starts. */
            tna_waiter *waiter = tna_sched_waiter(sched, envelope->waiter);
            if (tna_map_put(&sched->inflight, actor, envelope->waiter) == TA_OK) {
                waiter->state = TNA_WAITER_INFLIGHT;
                waiter->actor = actor;
                waiter->envelope = 0;
            } else {
                tna_sched_settle_waiter(sched, envelope->waiter,
                                        (tna_settlement){ .kind = TNA_SETTLE_FAULT, .code = TA_ERR_NOMEM, .actor = actor });
            }
        }
        tna_envelope_give(sched, head);
        sched->delivered += 1u;
        entry->state = TNA_SCHED_RUNNABLE;
        tna_sched_requeue(sched, params, &sched->runnable, actor);
        return;
    case TA_ERR_NOMEM:
        entry->flags |= TNA_SCHED_BACKOFF; /* retryable (ADR 0008): try again next turn */
        tna_sched_requeue(sched, params, &sched->ready, actor);
        return;
    case TA_ERR_DONE:
        entry->state = TNA_SCHED_IDLE;
        entry->flags |= TNA_SCHED_FINISHED;
        tna_sched_bury(sched, entry, TNA_DEAD_DONE);
        return;
    case TA_ERR_NOT_FOUND:
        tna_sched_remove(sched, actor, TNA_DEAD_NOT_FOUND);
        return;
    default:
        if (result == TA_ERR_INVALID && transition != NULL) {
            /* The actor does not accept the jump now (its source is no
             * longer active): the operator's input is at fault, not the
             * actor (ADR 0026). */
            tna_sched_refuse_jump(sched, params, entry, actor);
            return;
        }
        /*
         * Any other failure quarantines the actor and keeps its mailbox
         * (ADR 0008). The envelope core refused (for example a malformed
         * event) becomes a dead letter: delivering it again after release()
         * would only fault again. TA_ERR_BUSY cannot happen while the table
         * is right, because a ready actor is between macrosteps; it is a host
         * bug, and that envelope is kept.
         */
        if (result != TA_ERR_BUSY) {
            entry->first = envelope->next;
            if (entry->first == 0) {
                entry->last = 0;
            }
            tna_sched_dead_append(sched, head, TNA_DEAD_REFUSED);
        }
        tna_sched_fault(sched, params, (tna_turn_record){ .actor = actor, .operation = "deliver", .code = result });
        return;
    }
}

static bool tna_copy_text(ta_arena *arena, ta_str text, ta_str *out) {
    char *copy = ta_arena_alloc(arena, (size_t)text.len + 1u, 1);
    if (copy == NULL) {
        return false;
    }
    memcpy(copy, text.ptr, text.len);
    copy[text.len] = '\0';
    *out = (ta_str){ .ptr = copy, .len = text.len };
    return true;
}

/* Copies an address's text into the turn arena, so a record outlives the reference. */
static bool tna_copy_address(ta_arena *arena, const ta_address *address, ta_actor_address *out) {
    ta_actor_address view = ta_address_view(address);
    return tna_copy_text(arena, view.family.name, &out->family.name) && tna_copy_text(arena, view.name, &out->name);
}

/* Reports up to `limit` dead letters as records and frees their envelopes. */
static void tna_sched_report_dead(tna_sched *sched, const tna_turn_params *params, uint32_t limit) {
    for (uint32_t reported = 0; reported < limit && sched->dead_first != 0; reported += 1) {
        uint32_t index = sched->dead_first;
        tna_envelope *envelope = tna_sched_envelope(sched, index);
        sched->dead_first = envelope->next;
        if (sched->dead_first == 0) {
            sched->dead_last = 0;
        }
        sched->dead_count -= 1u;
        sched->dead_letters += 1u;
        sched->dead_by_reason[envelope->reason < TNA_DEAD_REASONS ? envelope->reason : 0u] += 1u;
        tna_turn_record record = {
            .kind = TNA_RECORD_DEAD_LETTER,
            .actor = envelope->target,
            .event = envelope->event.name,
            .reason = (tna_dead_reason)envelope->reason,
            /* The data moves to the record; the envelope gives back the rest. */
            .data = envelope->event.data,
            .has_trace = envelope->trace != NULL,
            .trace = envelope->trace != NULL ? *envelope->trace : (ta_trace_parent){0},
        };
        envelope->event.data = (ta_value){0};
        if (!envelope->has_jump && envelope->address != NULL) {
            /* The envelope's reference goes below; the record keeps the text. */
            record.has_address = tna_copy_address(params->arena, envelope->address, &record.address);
        }
        tna_sched_record(sched, params, record);
        if (envelope->waiter != 0) {
            tna_sched_settle_waiter(sched, envelope->waiter,
                                    (tna_settlement){ .kind = TNA_SETTLE_DEAD, .reason = envelope->reason, .actor = envelope->target });
        }
        tna_envelope_give(sched, index);
    }
}

void tna_sched_release_records(tna_sched *sched) {
    for (tna_turn_record *record = sched->records; record != NULL; record = record->next) {
        ta_value_release(&record->data);
        record->data = (ta_value){0};
    }
    sched->records = NULL;
    sched->last_record = NULL;
    sched->record_count = 0;
}

void tna_sched_turn(tna_sched *sched, const tna_turn_params *params) {
    tna_sched_release_records(sched);
    /* Only actors queued before each phase began: a requeued actor waits for the next turn. */
    uint32_t pending = tna_ring_count(&sched->runnable);
    uint32_t limit = params->budgets.resumes < pending ? params->budgets.resumes : pending;
    for (uint32_t index = 0; index < limit; index += 1) {
        ta_actor_id actor = 0;
        if (!tna_ring_pop(&sched->runnable, &actor)) {
            break;
        }
        tna_sched_resume_one(sched, params, actor);
    }
    pending = tna_ring_count(&sched->ready);
    limit = params->budgets.messages < pending ? params->budgets.messages : pending;
    for (uint32_t index = 0; index < limit; index += 1) {
        ta_actor_id actor = 0;
        if (!tna_ring_pop(&sched->ready, &actor)) {
            break;
        }
        tna_sched_deliver_one(sched, params, actor);
    }
    tna_sched_report_dead(sched, params, params->budgets.messages);
}
