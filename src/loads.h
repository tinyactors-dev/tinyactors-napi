#pragma once
/*
 * Loading an unloaded actor when mail arrives for it (napi ADR 0020). This
 * module has no Node-API in it, so native tests drive it, and it moves to the
 * host kernel with the directory and the scheduler.
 *
 * A definition family can have a loader, registered here by name with its
 * `max_waiting`. Mail for a name in such a family that has no resident actor
 * (the directory's entry is unloaded, or there is none: the family is
 * virtual) starts a **load**: a record for the address with a mailbox of its
 * own (scheduler.h's tna_mailbox). Mail that arrives while the load is in
 * flight joins that mailbox, whether or not the actor has become resident
 * meanwhile, so it keeps its order; at most `max_waiting` messages wait, and
 * the rest are dead letters with reason `waiting-full`. There is one load
 * per address at a time.
 *
 * Each new load is a **request** for JavaScript, which calls the loader
 * after the turn and finishes the load with its outcome: loaded or spawned
 * (the waiting mail moves to the front of the actor's mailbox), or not
 * found, rejected, failed or timed out (it becomes dead letters). The
 * record's generation guards against a stale finish.
 *
 * **Wake-ups.** An unloaded actor's delayed sends travel in its image, so a
 * host registers the image's next deadline for its address. When that time
 * comes and the address still has no resident actor and no load, a load
 * starts with `why` = timer and an empty mailbox. The wake-ups are a
 * min-heap by due time; replacing an address's wake-up leaves the old heap
 * entry in place, and it is skipped when it comes up.
 *
 * Every record and heap entry holds one reference to its address, given back
 * when it goes; tna_loads_close() gives back all of them while core is alive.
 */
#include <stdbool.h>
#include <stdint.h>

#include "containers.h"
#include "directory.h"
#include "host_metrics.h"
#include "scheduler.h"
#include "tinyactors.h"

typedef enum { TNA_LOAD_WHY_MAIL = 0, TNA_LOAD_WHY_TIMER } tna_load_why;

typedef enum {
    TNA_LOAD_LOADED = 0, /* the loader returned an image */
    TNA_LOAD_SPAWNED,    /* the loader asked for a new actor */
    TNA_LOAD_NOT_FOUND,
    TNA_LOAD_REJECTED,   /* "not now" */
    TNA_LOAD_FAILED,
    TNA_LOAD_TIMED_OUT,
    TNA_LOAD_OUTCOMES
} tna_load_outcome;

/* The outcome's name for metrics ("loaded", "not_found", ...). */
const char *tna_load_outcome_name(tna_load_outcome outcome);

typedef struct {
    ta_address *address;   /* one reference; NULL while the record is free */
    tna_mailbox mail;
    ta_trace_parent trace; /* the first message's trace parent, or all zero */
    uint64_t started_ns;   /* monotonic, when the load started */
    uint32_t max_waiting;
    uint32_t generation;   /* half of the token JavaScript holds; never 0 */
    uint32_t next_free;
    uint8_t why;           /* tna_load_why */
} tna_load;

typedef struct {
    char *name; /* a copy of the family's name */
    uint32_t length;
    uint32_t max_waiting;
} tna_loader_family;

typedef struct {
    ta_time due;
    ta_address *address; /* one reference */
} tna_wake;

typedef struct {
    ta_allocator allocator;
    tna_vec families;   /* tna_loader_family */
    tna_vec loads;      /* tna_load; index 0 is never issued */
    uint32_t free_head;
    uint32_t in_flight; /* loads started and not finished */
    tna_map by_address; /* (uintptr_t)address -> load index */
    tna_vec requests;   /* uint32_t: loads JavaScript has not been told about */
    uint32_t requests_head;
    tna_vec wakes;      /* tna_wake: a min-heap by due */
    tna_map wake_due;   /* (uintptr_t)address -> the due time of its live wake-up */
    uint32_t waiting;   /* messages in every load's mailbox */
    uint64_t outcomes[TNA_LOAD_OUTCOMES];
} tna_loads;

void tna_loads_init(tna_loads *loads, ta_allocator allocator);
/*
 * Gives back every address reference and frees everything. The waiting
 * envelopes are the scheduler's: tna_sched_discard_mail() releases them.
 * Call it while core is alive.
 */
void tna_loads_close(tna_loads *loads);

/*
 * Withdraws the waiting envelope at `index` from its load's mailbox, when
 * it is there: a send() waiting for it was cancelled. False when it is not
 * waiting (it is in an actor's mailbox or on the dead list).
 */
bool tna_loads_withdraw(tna_loads *loads, tna_sched *sched, uint32_t index);

/* Registers `family`'s loader limit; `max_waiting` 0 removes the loader. */
ta_result tna_loads_set_family(tna_loads *loads, ta_str family, uint32_t max_waiting);

/*
 * Routes a message for the named `address` (router.h): into its load's
 * mailbox when a load is in flight; otherwise, when it has no resident actor
 * and its family has a loader, a new load (and a request) with the message
 * as its first. TA_ERR_NOT_FOUND: neither, and the caller routes as before.
 * TA_OK: accepted, perhaps as a `waiting-full` dead letter. TA_ERR_BUSY and
 * TA_ERR_NOMEM: nothing accepted.
 */
typedef struct {
    tna_sched *sched;
    ta_address *address;
    const tna_message *message;
    bool resident; /* the directory has a resident actor at `address` */
    uint64_t now_ns;
} tna_load_route;
ta_result tna_loads_route(tna_loads *loads, const tna_load_route *route);

/* True when a load for `address` is in flight. */
bool tna_loads_waiting(const tna_loads *loads, const ta_address *address);
/* Whether mail for `address` would start a load: its family has a loader,
 * or actors of it were offloaded (napi ADR 0020, core ADR 0074). */
bool tna_loads_would_load(const tna_loads *loads, const ta_address *address);

/* A load JavaScript has not been told about, oldest first. */
typedef struct {
    uint32_t index;
    uint32_t generation;
    const ta_address *address; /* the record's reference: valid until it finishes */
    tna_load_why why;
} tna_load_request;
bool tna_loads_next_request(tna_loads *loads, tna_load_request *out);
static inline uint32_t tna_loads_pending_requests(const tna_loads *loads) {
    return loads->requests.count - loads->requests_head;
}

/* The load a token names, or NULL when it has finished (a stale token). */
tna_load *tna_loads_find(const tna_loads *loads, uint32_t index, uint32_t generation);

/*
 * Finishes a load. LOADED and SPAWNED: `actor` must be the resident actor
 * at the address (TA_ERR_NOT_FOUND otherwise, and nothing changes); the
 * waiting mail moves to the front of its mailbox, and its wake-up goes.
 * Other outcomes: the waiting mail becomes dead letters. Records the outcome
 * and the load's duration in `metrics`. TA_ERR_STALE: the token names no
 * load in flight. TA_ERR_NOMEM: the hand-over could not reserve the actor's
 * ready-queue entry, so the mail became `load-failed` dead letters.
 */
typedef struct {
    tna_sched *sched;
    const tna_directory *directory;
    tna_host_metrics *metrics;
    uint32_t index;
    uint32_t generation;
    tna_load_outcome outcome;
    ta_actor_id actor;
    uint64_t now_ns;
    uint64_t wall_ns; /* for the duration's exemplar */
} tna_load_finish;
ta_result tna_loads_finish(tna_loads *loads, const tna_load_finish *finish);

/* Wakes `address` at `due` (replacing an earlier wake-up for it). */
ta_result tna_loads_wake_at(tna_loads *loads, ta_address *address, ta_time due);
/* Forgets the wake-up of `address`, if any. */
void tna_loads_cancel_wake(tna_loads *loads, const ta_address *address);
/*
 * The earliest wake-up's due time; false when there is none. It may be a
 * replaced or cancelled one: that only asks for a turn early, which drops
 * it (tna_loads_fire_wakes).
 */
static inline bool tna_loads_next_wake(const tna_loads *loads, ta_time *due) {
    if (loads->wakes.count == 0) {
        return false;
    }
    *due = ((const tna_wake *)loads->wakes.items)[0].due;
    return true;
}
/*
 * Fires the wake-ups due at `now`: each whose address has no resident actor
 * and no load, in a family with a loader, starts a load with `why` = timer
 * and an empty mailbox. The rest are dropped. A load that cannot start for
 * lack of memory keeps its wake-up for the next turn.
 */
typedef struct {
    const tna_directory *directory;
    ta_time now;
    uint64_t now_ns;
} tna_wake_fire;
void tna_loads_fire_wakes(tna_loads *loads, const tna_wake_fire *fire);
