/*
 * The scheduling table and the runnable part of a turn (ADRs 0005, 0007,
 * 0008), driven without Node-API: entries in fixed pages, stale queue
 * entries skipped, coalesced wake-ups, bootstrap, budget pauses and done
 * records, and no leak at close.
 */
#include <string.h>

#include "check.h"
#include "hooks.h"
#include "scheduler.h"
#include "system.h"

#define S(literal) ((ta_str){ .ptr = (literal), .len = (uint32_t)(sizeof(literal) - 1u) })

static void table_pages(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    tna_sched sched;
    tna_sched_init(&sched, tna_allocator_for(&allocator, TNA_MEMORY_SCHEDULING),
                   tna_allocator_for(&allocator, TNA_MEMORY_ENVELOPES));
    CHECK(sizeof(tna_sched_entry) == 16u);
    CHECK(tna_sched_entry_at(&sched, 0) == NULL);

    /* A slot in the second page allocates that page only. */
    ta_actor_id far = ta_actor_id_make(TNA_SCHED_PAGE_ENTRIES + 5u, 3u);
    CHECK(tna_sched_add(&sched, far) == TA_OK);
    CHECK(tna_sched_entry_at(&sched, 0) == NULL);
    tna_sched_entry *entry = tna_sched_lookup(&sched, far);
    CHECK(entry != NULL && entry->state == TNA_SCHED_RUNNABLE && entry->generation == 3u);
    CHECK(sched.known == 1u);
    CHECK(!tna_sched_quiet(&sched));

    /* Another generation in the same slot is not this actor. */
    CHECK(tna_sched_lookup(&sched, ta_actor_id_make(TNA_SCHED_PAGE_ENTRIES + 5u, 4u)) == NULL);
    tna_sched_remove(&sched, ta_actor_id_make(TNA_SCHED_PAGE_ENTRIES + 5u, 4u), TNA_DEAD_DESTROYED);
    CHECK(sched.known == 1u);

    /* Pages never move: an entry pointer survives growth of the directory. */
    ta_actor_id later = ta_actor_id_make(40u * TNA_SCHED_PAGE_ENTRIES, 1u);
    CHECK(tna_sched_add(&sched, later) == TA_OK);
    CHECK(tna_sched_lookup(&sched, far) == entry);

    tna_sched_remove(&sched, far, TNA_DEAD_DESTROYED);
    CHECK(tna_sched_lookup(&sched, far) == NULL);
    CHECK(sched.known == 1u);
    tna_sched_destroy(&sched);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

typedef struct {
    uint32_t wakes;
} wake_counter;

static void count_wake(tna_system *system, void *context) {
    (void)system;
    ((wake_counter *)context)->wakes += 1u;
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

static ta_actor_id spawn(tna_system *system, ta_definition_id definition) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = definition, .out = &actor }) == TA_OK);
    CHECK(tna_hook_actor_created(system, actor) == TA_OK);
    return actor;
}

static ta_actor_residency residency(tna_system *system, ta_actor_id actor) {
    ta_actor_inspection view;
    CHECK(ta_actor_inspect(system->core, actor, &view) == TA_OK);
    return view.residency;
}

static uint32_t count_records(const tna_system *system, tna_record_kind kind) {
    uint32_t count = 0;
    for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
        count += record->kind == kind ? 1u : 0u;
    }
    return count;
}

static void turns(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    wake_counter counter = { 0 };
    system->wake = count_wake;
    system->wake_context = &counter;

    /* idle: a stable chart. finish: an eventless transition to a final. */
    ta_scxml_state_spec idle_states[] = { { .kind = TA_SCXML_STATE_ATOMIC, .id = S("idle") }, { 0 } };
    ta_scxml_spec idle = { .name = S("idle"), .states = idle_states };
    ta_str end[] = { S("end"), { 0 } };
    ta_scxml_transition_spec go[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .targets = end }, { 0 } };
    ta_scxml_state_spec finish_states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("start"), .transitions = go },
        { .kind = TA_SCXML_STATE_FINAL, .id = S("end") },
        { 0 },
    };
    ta_scxml_spec finish = { .name = S("finish"), .states = finish_states };
    ta_definition_id idle_chart = define(system, &idle);
    ta_definition_id finish_chart = define(system, &finish);

    /* Spawning asks for one turn; more spawns before it runs do not. */
    ta_actor_id a = spawn(system, idle_chart);
    ta_actor_id b = spawn(system, finish_chart);
    CHECK(counter.wakes == 1u);
    CHECK(system->turn_pending);
    CHECK(tna_sched_lookup(&system->sched, a)->state == TNA_SCHED_RUNNABLE);

    tna_system_turn(system);
    CHECK(!system->inside_core);
    CHECK(tna_sched_lookup(&system->sched, a)->state == TNA_SCHED_IDLE);
    CHECK(residency(system, a) == TA_ACTOR_IDLE);
    CHECK(residency(system, b) == TA_ACTOR_DONE);
    CHECK(count_records(system, TNA_RECORD_DONE) == 1u);
    CHECK(system->sched.records->actor == b);
    CHECK((tna_sched_lookup(&system->sched, b)->flags & TNA_SCHED_FINISHED) != 0);
    tna_system_end_turn(system);
    CHECK(tna_system_quiet(system));
    CHECK(!system->turn_pending);
    CHECK(counter.wakes == 1u);

    /* A destroyed actor's queue entry is skipped. */
    ta_actor_id c = spawn(system, idle_chart);
    CHECK(ta_actor_destroy(system->core, c) == TA_OK);
    CHECK(tna_hook_actor_removed(system, c) == TA_OK);
    tna_system_turn(system);
    CHECK(system->sched.record_count == 0u);
    tna_system_end_turn(system);
    CHECK(tna_system_quiet(system));

    /* A slot reused by a new actor: the old ID's entry is gone. */
    ta_actor_id d = spawn(system, idle_chart);
    CHECK(ta_actor_id_slot(d) == ta_actor_id_slot(c));
    CHECK(tna_sched_lookup(&system->sched, c) == NULL);
    tna_system_turn(system);
    tna_system_end_turn(system);
    CHECK(residency(system, d) == TA_ACTOR_IDLE);

    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

/* A long entry handler, split by the action budget over several turns. */
static void action_budget(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    enum { ACTIONS = 40 };
    ta_scxml_action_spec logs[ACTIONS + 1];
    memset(logs, 0, sizeof logs);
    for (int index = 0; index < ACTIONS; index += 1) {
        logs[index] = (ta_scxml_action_spec){ .kind = TA_SCXML_ACTION_LOG, .as.log = { .label = S("step") } };
    }
    ta_scxml_handler_spec onentry[] = { { .actions = logs }, { 0 } };
    /* The bootstrap never pauses (core ADR 0061), so the long handler is on a
     * state entered after it, through an eventless transition. */
    ta_str busy_target[] = { S("busy"), { 0 } };
    ta_scxml_transition_spec go[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .targets = busy_target }, { 0 } };
    ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("start"), .transitions = go },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("busy"), .onentry = onentry },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("busy"), .states = states };
    ta_definition_id chart = define(system, &spec);
    ta_scxml_state_spec idle_states[] = { { .kind = TA_SCXML_STATE_ATOMIC, .id = S("idle") }, { 0 } };
    ta_scxml_spec idle = { .name = S("idle"), .states = idle_states };
    ta_definition_id idle_chart = define(system, &idle);

    system->budgets.actions = 8u;
    ta_actor_id busy = spawn(system, chart);
    uint32_t turns = 0;
    while (tna_sched_lookup(&system->sched, busy)->state == TNA_SCHED_RUNNABLE) {
        tna_system_turn(system);
        tna_system_end_turn(system);
        turns += 1u;
        if (turns == 1u) {
            /* Another actor bootstraps while the busy one is paused. */
            ta_actor_id other = spawn(system, idle_chart);
            tna_system_turn(system);
            tna_system_end_turn(system);
            turns += 1u;
            CHECK(residency(system, other) == TA_ACTOR_IDLE);
            CHECK(tna_sched_lookup(&system->sched, busy)->state == TNA_SCHED_RUNNABLE);
        }
        CHECK(turns < 100u);
    }
    CHECK(turns >= ACTIONS / 8);
    CHECK(residency(system, busy) == TA_ACTOR_IDLE);
    CHECK(tna_system_quiet(system));

    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

/* The resume limit bounds one turn; the rest waits for the next. */
static void resume_limit(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    ta_scxml_state_spec idle_states[] = { { .kind = TA_SCXML_STATE_ATOMIC, .id = S("idle") }, { 0 } };
    ta_scxml_spec idle = { .name = S("idle"), .states = idle_states };
    ta_definition_id chart = define(system, &idle);
    system->budgets.resumes = 10u;
    enum { COUNT = 25 };
    for (int index = 0; index < COUNT; index += 1) {
        spawn(system, chart);
    }
    CHECK(tna_ring_count(&system->sched.runnable) == COUNT);
    tna_system_turn(system);
    tna_system_end_turn(system);
    CHECK(tna_ring_count(&system->sched.runnable) == COUNT - 10);
    CHECK(system->turn_pending); /* work remains: another turn was asked for */
    tna_system_turn(system);
    tna_system_turn(system);
    tna_system_end_turn(system);
    CHECK(tna_system_quiet(system));
    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

int main(void) {
    table_pages();
    turns();
    action_budget();
    resume_limit();
    puts("scheduler_test passed");
    return 0;
}
