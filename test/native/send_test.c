/*
 * send() waiters and retained bytes (ADR 0005 points 9 and 11), driven
 * without Node-API: a waiter settles when its message's macrostep ends
 * (stable, done), when the message becomes a dead letter, and when its actor
 * goes away; a cancelled message still in a mailbox is withdrawn; a delivered
 * one is not undone; the retained-bytes limit refuses a message that would
 * pass it and counts bytes back down; and waiters are reused, so steady
 * state makes no allocator call.
 */
#include <string.h>

#include "check.h"
#include "events.h"
#include "hooks.h"
#include "scheduler.h"
#include "system.h"

#define S(literal) ((ta_str){ .ptr = (literal), .len = (uint32_t)(sizeof(literal) - 1u) })

static void no_wake(tna_system *system, void *context) {
    (void)system;
    (void)context;
}

static tna_system *make_system(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    system->wake = no_wake;
    return system;
}

static void finish_system(tna_system *system) {
    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

static ta_definition_id define(tna_system *system, const ta_scxml_spec *spec) {
    ta_definition *definition = NULL;
    CHECK(ta_definition_compile_spec(system->core, &(ta_definition_compile_params){
                                                       .spec = spec,
                                                       .datamodel = ta_null_datamodel(),
                                                       .allocator = tna_allocator_for(&system->allocator, TNA_MEMORY_CORE),
                                                       .out = &definition,
                                                   }) == TA_OK);
    ta_definition_id id = 0;
    CHECK(ta_system_register_definition(system->core, definition, &id) == TA_OK);
    return id;
}

/* idle --ping--> idle, idle --stop--> end (a top-level final). */
static ta_definition_id define_ping(tna_system *system) {
    static ta_str to_idle[] = { { "idle", 4 }, { 0 } };
    static ta_str to_end[] = { { "end", 3 }, { 0 } };
    static ta_scxml_transition_spec on_idle[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "ping", 4 }, .targets = to_idle },
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "stop", 4 }, .targets = to_end },
        { 0 },
    };
    static ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "idle", 4 }, .transitions = on_idle },
        { .kind = TA_SCXML_STATE_FINAL, .id = { "end", 3 } },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("ping"), .states = states };
    return define(system, &spec);
}

static ta_actor_id spawn(tna_system *system, ta_definition_id definition) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = definition, .out = &actor }) == TA_OK);
    CHECK(tna_hook_actor_created(system, actor) == TA_OK);
    return actor;
}

static void destroy(tna_system *system, ta_actor_id actor) {
    CHECK(ta_actor_destroy(system->core, actor) == TA_OK);
    CHECK(tna_hook_actor_removed(system, actor) == TA_OK);
}

static ta_event_name_id name(tna_system *system, const char *text) {
    ta_event_name_id id = 0;
    CHECK(tna_event_name_intern(system->core, (ta_str){ .ptr = text, .len = (uint32_t)strlen(text) }, &id) == TA_OK);
    return id;
}

/* Posts `event` with a fresh waiter (and `bytes`); returns the waiter. */
static uint32_t send(tna_system *system, ta_actor_id target, ta_event_name_id event) {
    uint32_t waiter = tna_sched_waiter_take(&system->sched);
    CHECK(waiter != 0);
    ta_event message = { .name = event, .type = TA_EVENT_EXTERNAL, .invoke_id = TA_INVOKE_ID_NONE };
    CHECK(tna_system_post(system, &(tna_message){ .target = target, .event = &message, .waiter = waiter }) == TA_OK);
    return waiter;
}

static ta_result post_bytes(tna_system *system, ta_actor_id target, ta_event_name_id event, uint32_t bytes) {
    ta_event message = { .name = event, .type = TA_EVENT_EXTERNAL, .invoke_id = TA_INVOKE_ID_NONE };
    return tna_system_post(system, &(tna_message){ .target = target, .event = &message, .bytes = bytes });
}

enum { MAX_SETTLED = 64 };
static tna_settlement settled[MAX_SETTLED];
static uint32_t settled_count;

/* Pops settlements as the Node-API layer does, and gives their waiters back. */
static void collect(tna_system *system) {
    tna_settlement settlement;
    while (tna_sched_settlement_pop(&system->sched, &settlement)) {
        CHECK(settled_count < MAX_SETTLED);
        CHECK(tna_sched_waiter(&system->sched, settlement.waiter)->state == TNA_WAITER_SETTLING);
        settled[settled_count] = settlement;
        settled_count += 1u;
        tna_sched_waiter_give(&system->sched, settlement.waiter);
    }
}

/* Runs turns until quiet, collecting settlements. */
static void run(tna_system *system) {
    for (int guard = 0; !tna_system_quiet(system); guard += 1) {
        CHECK(guard < 1000);
        tna_system_turn(system);
        collect(system);
        tna_system_end_turn(system);
    }
}

/* The settlement of `waiter`, or NULL. */
static const tna_settlement *settlement_of(uint32_t waiter) {
    for (uint32_t index = 0; index < settled_count; index += 1) {
        if (settled[index].waiter == waiter) {
            return &settled[index];
        }
    }
    return NULL;
}

static void reset_settled(void) {
    settled_count = 0;
}

/* A waiter settles when its message's macrostep ends, stable or done. */
static void settles_on_completion(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_ping(system);
    ta_actor_id actor = spawn(system, chart);
    reset_settled();
    uint32_t ping = send(system, actor, name(system, "ping"));
    CHECK(tna_sched_waiter(&system->sched, ping)->state == TNA_WAITER_QUEUED);
    uint32_t stop = send(system, actor, name(system, "stop"));
    run(system);
    const tna_settlement *first = settlement_of(ping);
    const tna_settlement *second = settlement_of(stop);
    CHECK(first != NULL && first->kind == TNA_SETTLE_STABLE && first->actor == actor);
    CHECK(second != NULL && second->kind == TNA_SETTLE_DONE && second->actor == actor);
    /* The ping settled before the stop was delivered: settlements follow order. */
    CHECK(first < second);
    CHECK(system->sched.waiters_live == 0);
    finish_system(system);
}

/* A message to a finished or stale target settles as a dead letter. */
static void settles_as_a_dead_letter(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_ping(system);
    ta_actor_id actor = spawn(system, chart);
    ta_actor_id gone = spawn(system, chart);
    run(system);
    destroy(system, gone);
    reset_settled();
    ta_event_name_id stop = name(system, "stop");
    uint32_t first = send(system, actor, stop);
    uint32_t after = send(system, actor, stop);   /* the actor is done when it arrives */
    uint32_t stale = send(system, gone, stop);
    run(system);
    CHECK(settlement_of(first)->kind == TNA_SETTLE_DONE);
    CHECK(settlement_of(after)->kind == TNA_SETTLE_DEAD && settlement_of(after)->reason == TNA_DEAD_DONE);
    CHECK(settlement_of(stale)->kind == TNA_SETTLE_DEAD && settlement_of(stale)->reason == TNA_DEAD_NOT_FOUND);
    finish_system(system);
}

/* An actor destroyed while its macrostep for a send() is paused settles it. */
static void settles_when_its_actor_goes(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_ping(system);
    ta_actor_id actor = spawn(system, chart);
    run(system);
    reset_settled();
    uint32_t waiter = send(system, actor, name(system, "ping"));
    uint32_t queued = send(system, actor, name(system, "ping"));
    /* Deliver the first only: one turn delivers, and does not resume yet. */
    system->budgets.resumes = 1;
    tna_system_turn(system);
    collect(system);
    tna_system_end_turn(system);
    CHECK(tna_sched_waiter(&system->sched, waiter)->state == TNA_WAITER_INFLIGHT);
    destroy(system, actor);
    run(system);
    CHECK(settlement_of(waiter)->kind == TNA_SETTLE_DEAD && settlement_of(waiter)->reason == TNA_DEAD_DESTROYED);
    CHECK(settlement_of(queued)->kind == TNA_SETTLE_DEAD && settlement_of(queued)->reason == TNA_DEAD_DESTROYED);
    finish_system(system);
}

/* Cancel withdraws a message still in its mailbox; a delivered one is not undone. */
static void cancel(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_ping(system);
    ta_actor_id actor = spawn(system, chart);
    run(system);
    reset_settled();
    ta_event_name_id ping = name(system, "ping");
    ta_event_name_id stop = name(system, "stop");
    uint32_t delivered = send(system, actor, ping);
    uint32_t withdrawn = send(system, actor, stop);
    uint32_t kept = send(system, actor, ping);
    system->budgets.resumes = 1;
    tna_system_turn(system); /* delivers `delivered` */
    collect(system);
    tna_system_end_turn(system);
    CHECK(tna_sched_waiter(&system->sched, delivered)->state == TNA_WAITER_INFLIGHT);
    CHECK(tna_sched_mailbox_count(&system->sched, actor) == 2u);
    CHECK(tna_sched_cancel(&system->sched, withdrawn));
    tna_sched_waiter_give(&system->sched, withdrawn);
    CHECK(tna_sched_mailbox_count(&system->sched, actor) == 1u);
    CHECK(tna_sched_cancel(&system->sched, delivered));
    tna_sched_waiter_give(&system->sched, delivered);
    CHECK(!tna_sched_cancel(&system->sched, delivered)); /* already given back */
    run(system);
    /* `stop` was withdrawn, so the actor is still running and got `kept`. */
    CHECK(settlement_of(kept)->kind == TNA_SETTLE_STABLE);
    CHECK(settlement_of(delivered) == NULL && settlement_of(withdrawn) == NULL);
    CHECK(system->sched.queued == 0 && system->sched.waiters_live == 0);
    /* Cancelling the only message of a ready actor leaves it idle. */
    uint32_t only = send(system, actor, stop);
    CHECK(tna_sched_cancel(&system->sched, only));
    tna_sched_waiter_give(&system->sched, only);
    run(system);
    CHECK(tna_sched_lookup(&system->sched, actor)->state == TNA_SCHED_IDLE);
    finish_system(system);
}

/* max_retained refuses a message that would pass it and counts back down. */
static void retained_bytes(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_ping(system);
    ta_actor_id actor = spawn(system, chart);
    run(system);
    system->sched.max_retained = 100;
    ta_event_name_id ping = name(system, "ping");
    CHECK(post_bytes(system, actor, ping, 60) == TA_OK);
    CHECK(post_bytes(system, actor, ping, 50) == TA_ERR_BUSY);
    CHECK(post_bytes(system, actor, ping, 40) == TA_OK);
    CHECK(system->sched.retained == 100u);
    CHECK(post_bytes(system, actor, ping, 1) == TA_ERR_BUSY);
    CHECK(post_bytes(system, actor, ping, 0) == TA_OK); /* no data: always fits */
    run(system);
    CHECK(system->sched.retained == 0);
    CHECK(post_bytes(system, actor, ping, 101) == TA_ERR_BUSY); /* never fits */
    finish_system(system);
}

static uint64_t addon_calls(const tna_system *system) {
    uint64_t calls = 0;
    for (int category = 0; category < TNA_MEMORY_CATEGORY_COUNT; category += 1) {
        if (category != TNA_MEMORY_CORE) {
            tna_memory_counters counters = tna_allocator_counters(&system->allocator, (tna_memory_category)category);
            calls += counters.allocations + counters.frees;
        }
    }
    return calls;
}

/* After warm-up, a send and its settlement make no allocator call in the addon. */
static void steady_state(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_ping(system);
    enum { COUNT = 60 };
    ta_actor_id actors[COUNT];
    for (int index = 0; index < COUNT; index += 1) {
        actors[index] = spawn(system, chart);
    }
    ta_event_name_id ping = name(system, "ping");
    for (int round = 0; round < 3; round += 1) {
        run(system);
        reset_settled();
        for (int index = 0; index < COUNT; index += 1) {
            send(system, actors[index], ping);
        }
    }
    run(system);
    uint64_t before = addon_calls(system);
    for (int round = 0; round < 5; round += 1) {
        reset_settled();
        for (int index = 0; index < COUNT; index += 1) {
            send(system, actors[index], ping);
        }
        run(system);
        CHECK(settled_count == COUNT);
    }
    CHECK(addon_calls(system) == before);
    finish_system(system);
}

/* Close with waiters still pending leaks nothing (the Node-API layer rejects them). */
static void close_with_waiters(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_ping(system);
    ta_actor_id actor = spawn(system, chart);
    send(system, actor, name(system, "ping"));
    finish_system(system);
}

int main(void) {
    settles_on_completion();
    settles_as_a_dead_letter();
    settles_when_its_actor_goes();
    cancel();
    retained_bytes();
    steady_state();
    close_with_waiters();
    printf("send_test passed\n");
    return 0;
}
