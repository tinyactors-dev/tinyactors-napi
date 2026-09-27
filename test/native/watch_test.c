#include <stdio.h>
#include <stdint.h>

#include "allocator.h"
#include "check.h"
#include "watch.h"

/* Membership is exact at sizes past the old 1024 limit, duplicates count
 * once, and UINT64_MAX (the empty marker) is still an ID. */
static void sets_answer_membership(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    tna_trace_watch watch;
    tna_trace_watch_init(&watch, tna_allocator_for(&allocator, TNA_MEMORY_OTHER));
    CHECK(tna_trace_watch_empty(&watch));

    static uint64_t sessions[5001];
    for (uint32_t at = 0; at < 5000; at += 1u) {
        sessions[at] = (uint64_t)at * 3u + ((uint64_t)1 << 32);
    }
    sessions[5000] = sessions[0]; /* a duplicate */
    CHECK(tna_trace_watch_set(&watch, &(tna_trace_watch_set_params){ .sessions = sessions,
                                                                      .session_count = 5001 }) == TA_OK);
    CHECK(!tna_trace_watch_empty(&watch));
    CHECK(watch.sessions.count == 5000);
    for (uint32_t at = 0; at < 5000; at += 1u) {
        CHECK(tna_id_set_has(&watch.sessions, sessions[at]));
        CHECK(!tna_id_set_has(&watch.sessions, sessions[at] + 1u));
    }
    CHECK(!tna_id_set_has(&watch.sessions, UINT64_MAX));
    uint64_t edge[] = { 0, 7, UINT64_MAX };
    CHECK(tna_trace_watch_set(&watch, &(tna_trace_watch_set_params){ .sessions = edge, .session_count = 3 }) ==
          TA_OK);
    CHECK(tna_id_set_has(&watch.sessions, 0) && tna_id_set_has(&watch.sessions, 7));
    CHECK(tna_id_set_has(&watch.sessions, UINT64_MAX) && !tna_id_set_has(&watch.sessions, 8));

    /* Replacing with nothing empties it and frees the sets. */
    CHECK(tna_trace_watch_set(&watch, &(tna_trace_watch_set_params){0}) == TA_OK);
    CHECK(tna_trace_watch_empty(&watch));
    CHECK(!tna_id_set_has(&watch.sessions, sessions[0]));
    tna_trace_watch_destroy(&watch);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

static ta_definition_id define_family(ta_system *system, ta_allocator allocator, const char *family, uint32_t length) {
    static const ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "idle", 4 } },
        {0},
    };
    ta_definition_identity identity = { .family = { { family, length } } };
    ta_definition *definition = NULL;
    ta_definition_id id = 0;
    CHECK(ta_definition_compile_spec(system, &(ta_definition_compile_params){
                                                 .spec = &(ta_scxml_spec){ .identity = &identity, .states = states },
                                                 .datamodel = ta_null_datamodel(),
                                                 .allocator = allocator,
                                                 .out = &definition }) == TA_OK);
    CHECK(ta_system_register_definition(system, definition, &id) == TA_OK);
    return id;
}

static bool marked(tna_trace_watch *watch, ta_system *system, ta_actor_id actor) {
    ta_trace_parent trace = {0};
    tna_trace_watch_mark(watch, system, actor, &trace);
    return (trace.context.detail & TA_TRACE_DETAIL_WATCHED) != 0;
}

/* A watched family is resolved when a delivery first meets a definition, so
 * a definition registered after the watch is caught (core ADR 0078). */
static void families_resolve_as_met(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    ta_allocator core_allocator = tna_allocator_for(&allocator, TNA_MEMORY_CORE);
    ta_system *system = NULL;
    CHECK(ta_system_create(&(ta_system_config){ .allocator = core_allocator }, &system) == TA_OK);
    tna_trace_watch watch;
    tna_trace_watch_init(&watch, tna_allocator_for(&allocator, TNA_MEMORY_OTHER));
    ta_str families[] = { { "order/invoke", 12 } };
    CHECK(tna_trace_watch_set(&watch, &(tna_trace_watch_set_params){ .families = families, .family_count = 1 }) ==
          TA_OK);
    CHECK(!tna_trace_watch_empty(&watch));

    ta_definition_id other = define_family(system, core_allocator, "order", 5);
    ta_definition_id child = define_family(system, core_allocator, "order/invoke", 12);
    ta_actor_id plain = 0;
    ta_actor_id watched = 0;
    CHECK(ta_actor_spawn(system, &(ta_actor_spawn_params){ .definition = other, .out = &plain }) == TA_OK);
    CHECK(ta_actor_spawn(system, &(ta_actor_spawn_params){ .definition = child, .out = &watched }) == TA_OK);
    CHECK(marked(&watch, system, watched));
    CHECK(!marked(&watch, system, plain));
    /* Asked again, the answers come from the sets. */
    CHECK(marked(&watch, system, watched));
    CHECK(!marked(&watch, system, plain));
    CHECK(watch.checked.count == 2 && watch.matched.count == 1);

    tna_trace_watch_destroy(&watch);
    ta_system_destroy(system);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

/* The definition sink a host installs: it tells the watch (core ADR 0079). */
static void forget_freed(void *self, const ta_definition_event *event) {
    if (event->kind == TA_DEFINITION_EVENT_FREED) {
        tna_trace_watch_forget_definition(self, event->definition);
    }
}

static const ta_definition_sink_vtable forget_vtable = { .notify = forget_freed };

/* A definition of `family` whose one state is named after `round`, so each
 * round's chart has its own content, and so an identity of its own. */
static ta_definition_id define_distinct(ta_system *system, ta_allocator allocator, ta_str family, uint32_t round) {
    char name[16];
    int length = snprintf(name, sizeof name, "s%u", round);
    ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { name, (uint32_t)length } },
        {0},
    };
    ta_definition_identity identity = { .family = { family } };
    ta_definition *definition = NULL;
    ta_definition_id id = 0;
    CHECK(ta_definition_compile_spec(system, &(ta_definition_compile_params){
                                                 .spec = &(ta_scxml_spec){ .identity = &identity, .states = states },
                                                 .datamodel = ta_null_datamodel(),
                                                 .allocator = allocator,
                                                 .out = &definition }) == TA_OK);
    CHECK(ta_system_register_definition(system, definition, &id) == TA_OK);
    return id;
}

/*
 * A definition core frees leaves `matched` and `checked`, so a family watch
 * on a system that churns through definitions stays the size of what is
 * alive; removing from the middle of a probe run keeps every other member
 * findable.
 */
static void freed_definitions_leave(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    ta_allocator core_allocator = tna_allocator_for(&allocator, TNA_MEMORY_CORE);
    ta_system *system = NULL;
    CHECK(ta_system_create(&(ta_system_config){ .allocator = core_allocator }, &system) == TA_OK);
    tna_trace_watch watch;
    tna_trace_watch_init(&watch, tna_allocator_for(&allocator, TNA_MEMORY_OTHER));
    CHECK(ta_system_set_definition_sink(system, (ta_definition_sink){ .self = &watch, .v = &forget_vtable }) ==
          TA_OK);
    ta_str watched_family = { "churn/invoke", 12 };
    CHECK(tna_trace_watch_set(&watch, &(tna_trace_watch_set_params){ .families = &watched_family,
                                                                      .family_count = 1 }) == TA_OK);

    enum { ROUNDS = 300 };
    static ta_definition_id ids[ROUNDS];
    static ta_actor_id actors[ROUNDS];
    for (uint32_t round = 0; round < ROUNDS; round += 1u) {
        /* Alternating families, so both sets hold members. */
        ta_str family = round % 2u == 0 ? watched_family : (ta_str){ "churn", 5 };
        ids[round] = define_distinct(system, core_allocator, family, round);
        CHECK(ta_actor_spawn(system, &(ta_actor_spawn_params){ .definition = ids[round], .out = &actors[round] }) ==
              TA_OK);
        CHECK(marked(&watch, system, actors[round]) == (round % 2u == 0));
    }
    CHECK(watch.checked.count == ROUNDS && watch.matched.count == ROUNDS / 2);

    /* Free every third definition: the rest stay members, whatever probe
     * runs the removals cut through. */
    uint32_t freed = 0;
    for (uint32_t round = 0; round < ROUNDS; round += 3u) {
        CHECK(ta_system_retire_definition(system, ids[round]) == TA_OK);
        CHECK(ta_actor_destroy(system, actors[round]) == TA_OK);
        freed += 1u;
    }
    CHECK(watch.checked.count == ROUNDS - freed);
    for (uint32_t round = 0; round < ROUNDS; round += 1u) {
        bool gone = round % 3u == 0;
        CHECK(tna_id_set_has(&watch.checked, ids[round]) == !gone);
        CHECK(tna_id_set_has(&watch.matched, ids[round]) == (!gone && round % 2u == 0));
    }

    /* The rest go too: both sets return to empty. */
    for (uint32_t round = 0; round < ROUNDS; round += 1u) {
        if (round % 3u != 0) {
            CHECK(ta_system_retire_definition(system, ids[round]) == TA_OK);
            CHECK(ta_actor_destroy(system, actors[round]) == TA_OK);
        }
    }
    CHECK(watch.checked.count == 0 && watch.matched.count == 0);
    /* Empty sets are back to the smallest table. */
    CHECK(watch.checked.capacity == 8u && watch.matched.capacity == 8u);
    tna_trace_watch_destroy(&watch);
    ta_system_destroy(system);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

/*
 * Capacity follows what is alive: after a large churn the sets shrink to a
 * table where the survivors are at most a quarter of it; adding and
 * freeing one definition at that size does not rebuild the table; and the
 * survivors stay findable.
 */
static void sets_shrink_with_hysteresis(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    ta_allocator core_allocator = tna_allocator_for(&allocator, TNA_MEMORY_CORE);
    ta_system *system = NULL;
    CHECK(ta_system_create(&(ta_system_config){ .allocator = core_allocator }, &system) == TA_OK);
    tna_trace_watch watch;
    tna_trace_watch_init(&watch, tna_allocator_for(&allocator, TNA_MEMORY_OTHER));
    CHECK(ta_system_set_definition_sink(system, (ta_definition_sink){ .self = &watch, .v = &forget_vtable }) ==
          TA_OK);
    ta_str family = { "shrink/invoke", 13 };
    CHECK(tna_trace_watch_set(&watch, &(tna_trace_watch_set_params){ .families = &family, .family_count = 1 }) ==
          TA_OK);
    enum { ROUNDS = 512, KEPT = 4 };
    static ta_definition_id ids[ROUNDS];
    static ta_actor_id actors[ROUNDS];
    for (uint32_t round = 0; round < ROUNDS; round += 1u) {
        ids[round] = define_distinct(system, core_allocator, family, round);
        CHECK(ta_actor_spawn(system, &(ta_actor_spawn_params){ .definition = ids[round], .out = &actors[round] }) ==
              TA_OK);
        CHECK(marked(&watch, system, actors[round]));
    }
    uint32_t peak = watch.checked.capacity;
    CHECK(peak >= ROUNDS * 2u);
    for (uint32_t round = KEPT; round < ROUNDS; round += 1u) {
        CHECK(ta_system_retire_definition(system, ids[round]) == TA_OK);
        CHECK(ta_actor_destroy(system, actors[round]) == TA_OK);
    }
    CHECK(watch.checked.count == KEPT && watch.matched.count == KEPT);
    CHECK(watch.checked.capacity <= 16u && watch.matched.capacity <= 16u);
    for (uint32_t round = 0; round < KEPT; round += 1u) {
        CHECK(tna_id_set_has(&watch.checked, ids[round]) && tna_id_set_has(&watch.matched, ids[round]));
    }
    /* One more comes and goes at this size: the table stays as it is. */
    uint32_t settled = watch.checked.capacity;
    const uint64_t *table = watch.checked.slots;
    for (uint32_t round = 0; round < 8u; round += 1u) {
        ta_definition_id extra = define_distinct(system, core_allocator, family, ROUNDS + round);
        ta_actor_id actor = 0;
        CHECK(ta_actor_spawn(system, &(ta_actor_spawn_params){ .definition = extra, .out = &actor }) == TA_OK);
        CHECK(marked(&watch, system, actor));
        CHECK(ta_system_retire_definition(system, extra) == TA_OK);
        CHECK(ta_actor_destroy(system, actor) == TA_OK);
        CHECK(watch.checked.capacity == settled && watch.checked.slots == table);
    }
    for (uint32_t round = 0; round < KEPT; round += 1u) {
        CHECK(ta_actor_destroy(system, actors[round]) == TA_OK);
    }
    /* Destroying the system frees the rest, which the sink tells the watch. */
    ta_system_destroy(system);
    CHECK(watch.checked.count == 0 && watch.checked.capacity == 8u);
    tna_trace_watch_destroy(&watch);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

int main(void) {
    sets_answer_membership();
    families_resolve_as_met();
    freed_definitions_leave();
    sets_shrink_with_hysteresis();
    puts("watch_test passed");
    return 0;
}
