#pragma once
/*
 * Scheduling (ADRs 0005, 0007, 0008). This module has no Node-API in it, so
 * native tests drive it directly.
 *
 * The scheduling table has one 16-byte entry per slot of core's actor table
 * (ADR 0002). It grows in fixed pages that are never moved or copied. An
 * entry holds host-owned state that core does not have: the generation of the
 * actor the addon knows in that slot, its scheduling state, a flag or two,
 * and the first and last envelope of its mailbox.
 *
 * Mailboxes (ADR 0005): an envelope is a record in the system's envelope
 * store, addressed by a 32-bit index (0 means none). A mailbox is the list
 * threaded through envelopes from the entry's `first` to its `last`; an
 * empty mailbox costs nothing beyond the entry. Freed envelopes go on the
 * store's free list, so after warm-up a post makes no allocator call
 * (ADR 0014). An idle actor that gets mail becomes `ready` and joins the
 * ready queue; an actor in any other state only collects mail. A turn
 * delivers the head envelope of up to `messages` ready actors, acting on
 * ta_actor_deliver()'s result alone (tinyactors-core ADR 0055).
 *
 * Dead letters: mail whose target is gone or finished moves to the dead
 * list, and each turn reports at most `messages` of them as records, so one
 * dead actor with a deep mailbox cannot make a turn long. Mail for a stale
 * ID is a dead letter at once, so it never joins the mailbox of the slot's
 * next actor.
 *
 * The runnable queue holds the actors whose macrostep has something to do:
 * a bootstrap, a delivered event, or a macrostep paused by a budget. An actor
 * stays `runnable` while its macrostep runs, so work that arrives for it then
 * only waits. A queue entry whose actor was destroyed or replaced in the
 * meantime is skipped when it is popped.
 *
 * send() waiters (ADR 0005 point 11): a message may carry a waiter, the
 * native half of a send() promise. While the message is queued the waiter
 * names its envelope; when core accepts the message the waiter moves to the
 * `inflight` map, keyed by the actor that runs the macrostep; when that
 * macrostep ends (stable, done, a fault, or the actor is gone) or the message
 * becomes a dead letter, the scheduler queues a settlement. The Node-API layer
 * pops settlements after the turn and settles the promises. Waiters are
 * reused through a free list, so a send makes no allocator call after
 * warm-up.
 *
 * One turn resumes up to `resumes` runnable actors, each with a microstep
 * budget and an action budget (core ADR 0061). What the turn learns that
 * JavaScript must hear about (an actor finished, an actor faulted) becomes a
 * record in the turn arena; the pump calls the hooks for them after the last
 * core call of the turn (ADR 0007 point 5).
 *
 * Operator transitions (ADR 0026, core ADR 0082): a message may carry one. It
 * queues behind the mail before it, like any message, and reaches
 * ta_actor_deliver() with it. A jump the actor no longer accepts (its source
 * is not active by then, or the actor runs another revision) is a dead letter
 * with reason `refused` and does not quarantine the actor: the operator's
 * input is at fault, not the actor.
 */
#include <stdbool.h>
#include <stdint.h>

#include "containers.h"
#include "host_metrics.h"
#include "tinyactors.h"
#include "watch.h"

#define TNA_SCHED_PAGE_BITS 12u
#define TNA_SCHED_PAGE_ENTRIES (1u << TNA_SCHED_PAGE_BITS) /* 4,096 entries, 64 KiB */

typedef enum {
    TNA_SCHED_NONE = 0,    /* no actor the addon knows */
    TNA_SCHED_IDLE,        /* between macrosteps, nothing to do */
    TNA_SCHED_READY,       /* has mail, is between macrosteps, and is on the ready queue */
    TNA_SCHED_RUNNABLE,    /* on the runnable queue */
    TNA_SCHED_QUARANTINED  /* faulted: out of scheduling until released (ADR 0008) */
} tna_sched_state;

enum {
    TNA_SCHED_BACKOFF = 1u << 0,  /* ran out of memory: skip one turn (ADR 0008) */
    TNA_SCHED_FINISHED = 1u << 1, /* reached a top-level final state */
    /* quarantined as a runaway (core ADR 0075): once released, it runs with
     * no microstep limit until its macrostep ends */
    TNA_SCHED_UNLIMITED = 1u << 2
};

typedef struct {
    uint32_t generation;
    uint8_t state; /* tna_sched_state */
    uint8_t flags;
    uint16_t reserved;
    uint32_t first; /* mailbox head envelope, 0 when empty */
    uint32_t last;  /* mailbox tail envelope, 0 when empty */
} tna_sched_entry;

/* Why a message became a dead letter (ADR 0008). */
typedef enum {
    TNA_DEAD_NOT_FOUND = 0, /* no resident actor has the target's ID */
    TNA_DEAD_DONE,          /* the target reached a top-level final state */
    TNA_DEAD_DESTROYED,     /* the target was destroyed or unloaded with mail waiting */
    TNA_DEAD_REFUSED,       /* core refused the message itself (for example a malformed event) */
    TNA_DEAD_UNLOADED,      /* the target is unloaded (a named address, or an actor unloaded with mail waiting) */
    /* Mail that waited for a loader (napi ADR 0020): */
    TNA_DEAD_REJECTED,      /* the loader answered "not now" */
    TNA_DEAD_LOAD_FAILED,   /* the loader threw, or its result could not be used */
    TNA_DEAD_LOAD_TIMEOUT,  /* the loader did not settle in time */
    TNA_DEAD_WAITING_FULL   /* the address already had maxWaiting messages waiting */
} tna_dead_reason;

/* The reason's name as JavaScript sees it ("not-found", "load-timeout", ...). */
const char *tna_dead_reason_name(tna_dead_reason reason);

/*
 * A mailbox that belongs to an address, not an actor: mail waiting while a
 * loader brings the actor back (napi ADR 0020). Its envelopes have no
 * target yet; each holds a reference to the address.
 */
typedef struct {
    uint32_t first;
    uint32_t last;
    uint32_t count;
} tna_mailbox;

/*
 * An operator transition a message carries (core ADR 0082), in one
 * allocation: the definition its state IDs belong to, and the transition.
 */
typedef struct {
    ta_definition_id definition;
    ta_state_id source; /* TA_STATE_NONE: the root */
    uint32_t count;
    ta_state_id targets[];
} tna_jump;

/*
 * One queued message. `event` holds its own references (data, named origin).
 * `address` is set only for a dead letter to a named target that had no
 * resident actor; it holds a reference too. `jump` is set only for a message
 * that carries an operator transition, which only a message to an actor ID
 * does, so the two share their room and `has_jump` says which it is.
 */
typedef struct {
    ta_event event;
    ta_actor_id target;
    union {
        ta_address *address;
        tna_jump *jump;
    };
    /* The trace parent the message's macrostep runs under (core ADR 0067),
     * from the scheduler's free list, or NULL: only traced mail pays for
     * one. */
    ta_trace_parent *trace;
    uint32_t next;   /* the next envelope in its list, 0 when last */
    uint32_t waiter; /* the send() waiting for this message, or 0 */
    uint32_t bytes;  /* counted against max_retained (ADR 0005 point 9) */
    uint8_t reason;  /* tna_dead_reason, while on the dead list */
    uint8_t live;    /* taken from the store */
    uint8_t has_jump; /* `jump`, not `address` */
} tna_envelope;

/* An operator transition to accept with a message (core ADR 0082). */
typedef struct {
    ta_definition_id definition; /* the definition the state IDs belong to */
    ta_operator_transition transition;
} tna_message_jump;

/* A message to accept: the target, the event, and what it carries along. */
typedef struct {
    ta_actor_id target;     /* unused for a named post */
    const ta_event *event;
    uint32_t bytes;         /* retained-bytes estimate of its data, 0 for none */
    uint32_t waiter;        /* a send() waiting for it, or 0 */
    const ta_trace_parent *trace; /* its trace parent, or NULL (core ADR 0067) */
    /* An operator transition, or NULL; only for a target named by ID. The
     * scheduler copies it. */
    const tna_message_jump *jump;
} tna_message;

typedef enum {
    TNA_WAITER_FREE = 0,
    TNA_WAITER_QUEUED,   /* its message waits in a mailbox or on the dead list */
    TNA_WAITER_INFLIGHT, /* core accepted the message; its macrostep runs */
    TNA_WAITER_SETTLING  /* settled or cancelled; the Node-API layer gives it back */
} tna_waiter_state;

typedef struct {
    uint32_t generation; /* part of the token JavaScript holds; never 0 */
    uint32_t envelope;   /* QUEUED: the message's envelope */
    ta_actor_id actor;   /* QUEUED: the target; INFLIGHT: the actor running it */
    uint32_t next_free;
    uint8_t state;       /* tna_waiter_state */
    void *host;          /* the Node-API layer's promise (a napi_deferred) */
} tna_waiter;

typedef enum {
    TNA_SETTLE_STABLE, /* the message's macrostep ended with the actor stable */
    TNA_SETTLE_DONE,   /* ... with the actor finished */
    TNA_SETTLE_DEAD,   /* the message became a dead letter, or its actor went away */
    TNA_SETTLE_FAULT,  /* the macrostep failed and the actor is quarantined */
    TNA_SETTLE_ABANDONED /* an operator abandoned the macrostep (core ADR 0082) */
} tna_settle_kind;

typedef struct {
    uint32_t waiter;
    uint8_t kind;    /* tna_settle_kind */
    uint8_t reason;  /* DEAD: tna_dead_reason */
    ta_result code;  /* FAULT: core's result */
    ta_actor_id actor;
} tna_settlement;

#define TNA_ENVELOPE_PAGE_BITS 10u
#define TNA_ENVELOPE_PAGE_ENTRIES (1u << TNA_ENVELOPE_PAGE_BITS) /* 1,024 envelopes */

/* Envelopes in fixed pages, addressed by index; index 0 is never issued. */
typedef struct {
    ta_allocator allocator; /* the envelopes category */
    tna_vec pages;          /* tna_envelope *, one per page */
    uint32_t issued;        /* indices handed out so far, index 0 included */
    uint32_t free_head;     /* free list, threaded through `next` */
    uint32_t live;
} tna_envelopes;

typedef enum {
    TNA_RECORD_DONE,       /* the actor reached a top-level final state */
    TNA_RECORD_FAULT,      /* a core call for the actor failed (ADR 0008) */
    TNA_RECORD_DEAD_LETTER /* a message whose target is gone or finished */
} tna_record_kind;

typedef struct tna_turn_record {
    tna_record_kind kind;
    ta_actor_id actor;     /* DEAD_LETTER: the target, or 0 when it was a name with no actor */
    /* DEAD_LETTER to a named target with no actor: its text, copied into the turn arena. */
    bool has_address;
    ta_actor_address address;
    const char *operation; /* FAULT: "resume", "deliver" */
    ta_result code;        /* FAULT: core's result */
    ta_event_name_id event; /* DEAD_LETTER */
    tna_dead_reason reason; /* DEAD_LETTER */
    /* DEAD_LETTER: the message's data, owned by the record until
     * tna_sched_release_records(), so a host can post it again (napi ADR
     * 0020's restart outbox). Absent when the message had none. */
    ta_value data;
    /* DEAD_LETTER: the message's trace parent, when it had one. */
    bool has_trace;
    ta_trace_parent trace;
    struct tna_turn_record *next;
} tna_turn_record;

typedef struct {
    ta_allocator allocator; /* the scheduling category */
    tna_vec pages;          /* tna_sched_entry *, one per page */
    tna_ring runnable;      /* ta_actor_id */
    tna_ring ready;         /* ta_actor_id */
    tna_envelopes envelopes;
    /* Trace parents of queued traced messages (ta_trace_parent). */
    tna_free_list traces;
    uint32_t known;         /* entries not in state NONE */
    /* Accepted messages not yet delivered or reported: mailboxes plus the dead list. */
    uint32_t queued;
    uint32_t max_queued;    /* 0: no limit (ADR 0005 point 9) */
    /* Retained-bytes estimates of queued messages, and their limit (0: none). */
    uint64_t retained;
    uint64_t max_retained;
    /* send() waiters: records by index (0 is never issued), a free list,
     * the actors whose macrostep a waiter follows, and settlements. */
    tna_vec waiters;        /* tna_waiter */
    uint32_t waiter_free;
    uint32_t waiters_live;
    tna_map inflight;       /* ta_actor_id -> waiter index */
    tna_ring settled;       /* tna_settlement */
    /* Dead letters waiting to be reported, threaded through `next`. */
    uint32_t dead_first;
    uint32_t dead_last;
    uint32_t dead_count;
    uint64_t dead_letters;  /* reported so far, with or without a hook */
    uint64_t delivered;     /* messages core accepted */
    /* For metrics (napi ADR 0017 section 7): dead letters by tna_dead_reason,
     * faults by -ta_result, and the actors in quarantine now. */
    uint64_t dead_by_reason[TNA_DEAD_REASONS];
    uint64_t faults[TNA_FAULT_CODES];
    uint32_t quarantined;
    /* The records of the current turn, in the turn arena. */
    tna_turn_record *records;
    tna_turn_record *last_record;
    uint32_t record_count;
} tna_sched;

typedef struct {
    uint32_t resumes;    /* resume calls in one turn */
    uint32_t messages;   /* deliveries in one turn, and dead letters reported */
    uint32_t microsteps; /* core's `budget` for one resume */
    uint32_t actions;    /* core's `action_budget` for one resume; 0: no limit */
} tna_turn_budgets;

typedef struct {
    ta_system *core;
    ta_arena *arena;   /* the turn arena: records live here */
    bool *inside_core; /* the reentrancy flag (ADR 0013 point 4) */
    tna_turn_budgets budgets;
    /* Watched sessions and definitions (watch.h); NULL or empty: none. */
    tna_trace_watch *watch;
} tna_turn_params;

/* `allocator` for the table and queues, `envelopes` for the envelope store. */
void tna_sched_init(tna_sched *sched, ta_allocator allocator, ta_allocator envelopes);
/*
 * Releases every queued message's references. Call it while core is still
 * alive (a named origin is a core handle), before ta_system_destroy().
 */
void tna_sched_discard_mail(tna_sched *sched);
void tna_sched_destroy(tna_sched *sched);

/* The entry of `slot`, or NULL when its page does not exist. */
tna_sched_entry *tna_sched_entry_at(const tna_sched *sched, uint32_t slot);
/* The entry of the actor `actor` names, or NULL when the addon knows another
 * actor (or none) in that slot. */
tna_sched_entry *tna_sched_lookup(const tna_sched *sched, ta_actor_id actor);

/*
 * A new actor (spawned, loaded, reconstructed, prepared): fill its entry and
 * put it on the runnable queue for bootstrap. TA_ERR_NOMEM leaves the table
 * as it was.
 */
ta_result tna_sched_add(tna_sched *sched, ta_actor_id actor);
/* The actor is gone (destroyed, unloaded): dead-letter its mailbox and clear its entry. */
void tna_sched_remove(tna_sched *sched, ta_actor_id actor, tna_dead_reason reason);
/*
 * A named actor was replaced in place (ROADMAP step 14): the mail still
 * waiting for `from` moves, in order, to the front of `to`'s mailbox, with
 * its send() waiters. That mail was accepted for the address `to` now
 * holds, and it is older than anything queued for `to` directly. An idle
 * `to` becomes ready. TA_ERR_NOT_FOUND when the table knows either actor
 * not; TA_ERR_NOMEM (nothing moved) when `to` cannot join the ready queue.
 */
typedef struct {
    ta_actor_id from;
    ta_actor_id to;
} tna_sched_transfer_params;
ta_result tna_sched_transfer(tna_sched *sched, const tna_sched_transfer_params *params);

/*
 * Accepts a message for `message->target` (ADR 0005 point 3). On TA_OK the
 * envelope owns the event's references and the waiter follows the message;
 * otherwise the caller keeps both.
 * - A target the table does not know (stale or unknown ID) or one that has
 *   finished: accepted as a dead letter at once.
 * - TA_ERR_BUSY: the queue is at max_queued, or the message's bytes would
 *   pass max_retained; nothing was accepted.
 * - TA_ERR_NOMEM: nothing was accepted.
 */
ta_result tna_sched_post(tna_sched *sched, const tna_message *message);
/*
 * Accepts a message that is a dead letter already: its target is a name the
 * directory has no resident actor for (ADR 0006 point 4). On TA_OK the
 * envelope owns `event`'s references and the `address` reference.
 * TA_ERR_BUSY and TA_ERR_NOMEM as for tna_sched_post().
 */
typedef struct {
    ta_address *address;
    const tna_message *message;
    tna_dead_reason reason;
} tna_dead_post;
ta_result tna_sched_post_dead(tna_sched *sched, const tna_dead_post *post);
/*
 * Accepts a message into the waiting mailbox `box` of `address` (napi ADR
 * 0020). The envelope takes its own reference to `address`. On TA_OK it
 * owns the event's references and the waiter follows the message, as for
 * tna_sched_post(); the limits of ADR 0005 point 9 count it. TA_ERR_BUSY
 * and TA_ERR_NOMEM as for tna_sched_post().
 */
typedef struct {
    tna_mailbox *box;
    ta_address *address;
    const tna_message *message;
} tna_waiting_post;
ta_result tna_sched_post_waiting(tna_sched *sched, const tna_waiting_post *post);
/*
 * The actor for the address was loaded: the waiting mail moves, in order,
 * to the front of `to`'s mailbox, with its send() waiters, as replacement
 * moves an incumbent's mail. It is older than anything posted to `to`
 * directly. An idle `to` becomes ready. TA_ERR_NOT_FOUND when the table
 * does not know `to`; TA_ERR_NOMEM (nothing moved) when `to` cannot join
 * the ready queue. `box` is empty afterwards on TA_OK.
 */
ta_result tna_sched_hand_over(tna_sched *sched, tna_mailbox *box, ta_actor_id to);
/* The load failed: every waiting message becomes a dead letter with `reason`. */
void tna_sched_bury_waiting(tna_sched *sched, tna_mailbox *box, tna_dead_reason reason);
/*
 * Withdraws the envelope at `index` from the waiting mailbox `box` and
 * frees it, as cancelling a send() does for mail in an actor's mailbox (ADR
 * 0005 point 11). False, changing nothing, when `box` does not hold it.
 */
bool tna_sched_withdraw_waiting(tna_sched *sched, tna_mailbox *box, uint32_t index);
/* The envelope at `index` (for tests and the router), or NULL. */
tna_envelope *tna_sched_envelope(const tna_sched *sched, uint32_t index);
/* Messages waiting in `actor`'s mailbox. */
uint32_t tna_sched_mailbox_count(const tna_sched *sched, ta_actor_id actor);
/*
 * Core gave `actor` a macrostep to run outside a delivery (for example an
 * invocation reported unavailable, which queues an internal event): an idle
 * or ready actor becomes runnable. A runnable or quarantined actor is left
 * as it is. TA_ERR_NOT_FOUND for an actor the table does not know.
 */
ta_result tna_sched_wake(tna_sched *sched, ta_actor_id actor);
/* Puts a quarantined actor back on the runnable queue (ADR 0008). */
ta_result tna_sched_release(tna_sched *sched, ta_actor_id actor);

/*
 * An operator abandoned the actor's macrostep (core ADR 0082): the send()
 * that follows it settles as ABANDONED, and a runnable actor stands between
 * macrosteps again (ready or idle). Its entry in the runnable queue is
 * skipped when popped. A quarantined one stays quarantined.
 * TA_ERR_NOT_FOUND for an actor the table does not know.
 */
ta_result tna_sched_abandoned(tna_sched *sched, ta_actor_id actor);

/*
 * send() waiters. tna_sched_waiter_take() returns a free waiter's index, or
 * 0 when there is no memory; give it to exactly one tna_sched_post() (or
 * back with tna_sched_waiter_give()). A settlement names the waiter it
 * settles, which is then SETTLING until the Node-API layer gives it back.
 */
uint32_t tna_sched_waiter_take(tna_sched *sched);
tna_waiter *tna_sched_waiter(const tna_sched *sched, uint32_t index);
void tna_sched_waiter_give(tna_sched *sched, uint32_t index);
bool tna_sched_settlement_pop(tna_sched *sched, tna_settlement *out);
/*
 * Cancels a pending waiter (abort or timeout). A message still in a mailbox
 * is withdrawn, so it is never delivered; one already on the dead list is
 * still reported, without its waiter; one already delivered is not undone.
 * Returns true when the waiter was pending; it is then SETTLING.
 */
bool tna_sched_cancel(tna_sched *sched, uint32_t index);

/* True when a turn has nothing to do. */
bool tna_sched_quiet(const tna_sched *sched);

/*
 * One bounded turn: resume runnable actors, deliver to ready actors, then
 * report dead letters (ADR 0007 point 1). The turn's records start empty
 * and stay valid until the turn arena is reset. Never fails: a failure is an
 * actor's, and becomes a record.
 */
void tna_sched_turn(tna_sched *sched, const tna_turn_params *params);
/*
 * Releases what the turn's records own (a dead letter's data) and forgets
 * the records. The turn calls it first, so a caller that runs turns back to
 * back leaks nothing; the host calls it once it has reported them, and
 * close calls it before core goes, since values outlive nothing.
 */
void tna_sched_release_records(tna_sched *sched);
