/*
 * Mailboxes, the ready queue and dead letters (ADRs 0005, 0008, 0014),
 * driven without Node-API: per-target FIFO across the message budget, mail
 * before bootstrap, stale IDs, quarantine with an empty mailbox, finished and
 * destroyed targets, backpressure, the dead-letter budget, a fault that stays
 * with its actor, and no allocator call in steady state.
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

/* a --x--> b --y--> c, and c --z--> end (a top-level final). */
static ta_definition_id define_steps(tna_system *system) {
    static ta_str to_b[] = { { "b", 1 }, { 0 } };
    static ta_str to_c[] = { { "c", 1 }, { 0 } };
    static ta_str to_end[] = { { "end", 3 }, { 0 } };
    static ta_scxml_transition_spec on_x[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "x", 1 }, .targets = to_b }, { 0 } };
    static ta_scxml_transition_spec on_y[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "y", 1 }, .targets = to_c }, { 0 } };
    static ta_scxml_transition_spec on_z[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "z", 1 }, .targets = to_end }, { 0 } };
    static ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "a", 1 }, .transitions = on_x },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "b", 1 }, .transitions = on_y },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "c", 1 }, .transitions = on_z },
        { .kind = TA_SCXML_STATE_FINAL, .id = { "end", 3 } },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("steps"), .states = states };
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

static ta_result post(tna_system *system, ta_actor_id target, ta_event_name_id event) {
    ta_event message = { .name = event, .type = TA_EVENT_EXTERNAL, .invoke_id = TA_INVOKE_ID_NONE };
    return tna_system_post(system, &(tna_message){ .target = target, .event = &message });
}

/* One turn; returns the number of records of `kind` it produced. */
static uint32_t turn(tna_system *system, tna_record_kind kind) {
    tna_system_turn(system);
    uint32_t count = 0;
    for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
        count += record->kind == kind ? 1u : 0u;
    }
    tna_system_end_turn(system);
    return count;
}

/* Runs turns until quiet; returns the dead letters and checks for no faults. */
static uint32_t settle(tna_system *system) {
    uint32_t dead = 0;
    for (int guard = 0; !tna_system_quiet(system); guard += 1) {
        CHECK(guard < 1000);
        tna_system_turn(system);
        for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
            CHECK(record->kind != TNA_RECORD_FAULT);
            dead += record->kind == TNA_RECORD_DEAD_LETTER ? 1u : 0u;
        }
        tna_system_end_turn(system);
    }
    return dead;
}

/* The author's ID of the actor's one active atomic state. */
static const char *state_of(tna_system *system, ta_actor_id actor) {
    static char text[16];
    ta_state_id states[8];
    uint32_t count = 0;
    CHECK(ta_actor_active_states(system->core, &(ta_actor_active_states_params){
                                                   .actor = actor,
                                                   .states = states,
                                                   .capacity = 8,
                                                   .count = &count,
                                               }) == TA_OK);
    ta_actor_inspection view;
    CHECK(ta_actor_inspect(system->core, actor, &view) == TA_OK);
    if (count == 0) {
        return view.final_state == TA_STATE_NONE ? "" : "final";
    }
    ta_state_info info;
    CHECK(ta_definition_state(system->core, &(ta_definition_state_params){
                                                .definition = view.definition_id,
                                                .state = states[count - 1u],
                                                .out = &info,
                                            }) == TA_OK);
    CHECK(info.id.len < sizeof text);
    memcpy(text, info.id.ptr, info.id.len);
    text[info.id.len] = '\0';
    return text;
}

static tna_sched_state state(tna_system *system, ta_actor_id actor) {
    const tna_sched_entry *entry = tna_sched_lookup(&system->sched, actor);
    return entry == NULL ? TNA_SCHED_NONE : (tna_sched_state)entry->state;
}

/* Per-target FIFO holds when a turn stops at its message budget. */
static void fifo_across_the_budget(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_steps(system);
    enum { COUNT = 5 };
    ta_actor_id actors[COUNT];
    for (int index = 0; index < COUNT; index += 1) {
        actors[index] = spawn(system, chart);
    }
    settle(system);
    ta_event_name_id x = name(system, "x");
    ta_event_name_id y = name(system, "y");
    for (int index = 0; index < COUNT; index += 1) {
        CHECK(post(system, actors[index], x) == TA_OK);
        CHECK(post(system, actors[index], y) == TA_OK);
        CHECK(state(system, actors[index]) == TNA_SCHED_READY);
        CHECK(tna_sched_mailbox_count(&system->sched, actors[index]) == 2u);
    }
    system->budgets.messages = 2u;
    tna_system_turn(system);
    CHECK(system->sched.delivered == 2u); /* the budget stopped the turn */
    tna_system_end_turn(system);
    CHECK(settle(system) == 0u);
    for (int index = 0; index < COUNT; index += 1) {
        CHECK(strcmp(state_of(system, actors[index]), "c") == 0);
        CHECK(state(system, actors[index]) == TNA_SCHED_IDLE);
    }
    CHECK(system->sched.delivered == 2u * COUNT);
    CHECK(system->sched.queued == 0u);
    finish_system(system);
}

/* Mail posted between spawn and bootstrap waits for the bootstrap. */
static void mail_before_bootstrap(void) {
    tna_system *system = make_system();
    ta_actor_id actor = spawn(system, define_steps(system));
    CHECK(state(system, actor) == TNA_SCHED_RUNNABLE);
    CHECK(post(system, actor, name(system, "x")) == TA_OK);
    CHECK(state(system, actor) == TNA_SCHED_RUNNABLE); /* only collects mail */
    CHECK(settle(system) == 0u);
    CHECK(strcmp(state_of(system, actor), "b") == 0);
    finish_system(system);
}

/* A stale ID's mail is a dead letter at once and never reaches the slot's next actor. */
static void stale_ids(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_steps(system);
    ta_actor_id old = spawn(system, chart);
    settle(system);
    destroy(system, old);
    ta_actor_id next = spawn(system, chart);
    CHECK(ta_actor_id_slot(next) == ta_actor_id_slot(old));
    settle(system);
    CHECK(post(system, old, name(system, "x")) == TA_OK);
    CHECK(tna_sched_mailbox_count(&system->sched, next) == 0u);
    CHECK(system->sched.dead_count == 1u);
    tna_system_turn(system);
    const tna_turn_record *record = system->sched.records;
    CHECK(record != NULL && record->kind == TNA_RECORD_DEAD_LETTER);
    CHECK(record->actor == old && record->reason == TNA_DEAD_NOT_FOUND && record->event == name(system, "x"));
    tna_system_end_turn(system);
    CHECK(strcmp(state_of(system, next), "a") == 0);
    CHECK(system->sched.dead_letters == 1u);
    finish_system(system);
}

/* A quarantined actor with an empty mailbox stays out when mail arrives; release brings it back. */
static void quarantine(void) {
    tna_system *system = make_system();
    ta_actor_id actor = spawn(system, define_steps(system));
    settle(system);
    tna_sched_lookup(&system->sched, actor)->state = TNA_SCHED_QUARANTINED; /* as a fault leaves it */
    CHECK(post(system, actor, name(system, "x")) == TA_OK);
    CHECK(state(system, actor) == TNA_SCHED_QUARANTINED);
    CHECK(tna_system_quiet(system)); /* nothing to do: the mail waits */
    CHECK(strcmp(state_of(system, actor), "a") == 0);
    CHECK(tna_sched_release(&system->sched, actor) == TA_OK);
    tna_system_want_turn(system);
    CHECK(settle(system) == 0u);
    CHECK(strcmp(state_of(system, actor), "b") == 0);
    CHECK(state(system, actor) == TNA_SCHED_IDLE);
    finish_system(system);
}

/* A delivery core refuses as malformed faults that actor only. */
static void a_fault_stays_with_its_actor(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_steps(system);
    ta_actor_id bad = spawn(system, chart);
    ta_actor_id good = spawn(system, chart);
    settle(system);
    CHECK(post(system, bad, 0x7fffffffu) == TA_OK); /* a name core never issued */
    CHECK(post(system, good, name(system, "x")) == TA_OK);
    tna_system_turn(system);
    const tna_turn_record *record = system->sched.records;
    CHECK(record != NULL && record->kind == TNA_RECORD_FAULT && record->actor == bad);
    CHECK(strcmp(record->operation, "deliver") == 0 && record->code == TA_ERR_INVALID);
    uint32_t refused = 0;
    for (; record != NULL; record = record->next) {
        refused += record->kind == TNA_RECORD_DEAD_LETTER && record->reason == TNA_DEAD_REFUSED ? 1u : 0u;
    }
    CHECK(refused == 1u); /* the refused envelope, not the actor's other mail */
    tna_system_end_turn(system);
    CHECK(settle(system) == 0u);
    CHECK(state(system, bad) == TNA_SCHED_QUARANTINED);
    CHECK(strcmp(state_of(system, good), "b") == 0);
    /* Mail for the quarantined actor is kept, not delivered. */
    CHECK(post(system, bad, name(system, "x")) == TA_OK);
    CHECK(settle(system) == 0u);
    CHECK(tna_sched_mailbox_count(&system->sched, bad) == 1u);
    /* Destroying it discards its mailbox as dead letters. */
    destroy(system, bad);
    CHECK(settle(system) == 1u);
    finish_system(system);
}

/* Mail for a finished actor, and for a destroyed one, becomes dead letters. */
static void finished_and_destroyed_targets(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_steps(system);
    ta_actor_id actor = spawn(system, chart);
    settle(system);
    ta_event_name_id x = name(system, "x");
    ta_event_name_id y = name(system, "y");
    ta_event_name_id z = name(system, "z");
    CHECK(post(system, actor, x) == TA_OK);
    CHECK(post(system, actor, y) == TA_OK);
    CHECK(post(system, actor, z) == TA_OK);
    CHECK(post(system, actor, x) == TA_OK); /* arrives after the actor finished */
    uint32_t dead = 0;
    uint32_t done = 0;
    for (int guard = 0; !tna_system_quiet(system); guard += 1) {
        CHECK(guard < 100);
        tna_system_turn(system);
        for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
            done += record->kind == TNA_RECORD_DONE ? 1u : 0u;
            if (record->kind == TNA_RECORD_DEAD_LETTER) {
                CHECK(record->reason == TNA_DEAD_DONE && record->actor == actor);
                dead += 1u;
            }
        }
        tna_system_end_turn(system);
    }
    CHECK(done == 1u && dead == 1u);
    /* Mail posted to the retained finished actor is dead at once. */
    CHECK(post(system, actor, x) == TA_OK);
    CHECK(system->sched.dead_count == 1u);
    CHECK(settle(system) == 1u);

    ta_actor_id other = spawn(system, chart);
    settle(system);
    CHECK(post(system, other, x) == TA_OK);
    destroy(system, other);
    tna_system_turn(system);
    CHECK(system->sched.records != NULL && system->sched.records->reason == TNA_DEAD_DESTROYED);
    tna_system_end_turn(system);
    CHECK(tna_system_quiet(system));
    finish_system(system);
}

/* max_queued refuses new mail; accepted mail is never dropped. */
static void backpressure(void) {
    tna_system *system = make_system();
    ta_actor_id actor = spawn(system, define_steps(system));
    settle(system);
    system->sched.max_queued = 2u;
    ta_event_name_id x = name(system, "x");
    CHECK(post(system, actor, x) == TA_OK);
    CHECK(post(system, actor, name(system, "y")) == TA_OK);
    CHECK(post(system, actor, x) == TA_ERR_BUSY);
    CHECK(tna_sched_mailbox_count(&system->sched, actor) == 2u);
    CHECK(settle(system) == 0u);
    CHECK(strcmp(state_of(system, actor), "c") == 0);
    CHECK(post(system, actor, x) == TA_OK); /* room again */
    settle(system);
    finish_system(system);
}

/* At most `messages` dead letters are reported per turn. */
static void dead_letter_budget(void) {
    tna_system *system = make_system();
    ta_actor_id gone = spawn(system, define_steps(system));
    settle(system);
    destroy(system, gone);
    ta_event_name_id x = name(system, "x");
    for (int index = 0; index < 10; index += 1) {
        CHECK(post(system, gone, x) == TA_OK);
    }
    system->budgets.messages = 3u;
    CHECK(turn(system, TNA_RECORD_DEAD_LETTER) == 3u);
    CHECK(turn(system, TNA_RECORD_DEAD_LETTER) == 3u);
    CHECK(turn(system, TNA_RECORD_DEAD_LETTER) == 3u);
    CHECK(turn(system, TNA_RECORD_DEAD_LETTER) == 1u);
    CHECK(tna_system_quiet(system));
    CHECK(system->sched.dead_letters == 10u);
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

/* After warm-up, posting and delivering makes no allocator call in the addon (ADR 0014). */
static void steady_state(void) {
    tna_system *system = make_system();
    /* A chart that accepts `ping` forever. */
    ta_str to_idle[] = { S("idle"), { 0 } };
    ta_scxml_transition_spec on_ping[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = S("ping"), .targets = to_idle }, { 0 } };
    ta_scxml_state_spec states[] = { { .kind = TA_SCXML_STATE_ATOMIC, .id = S("idle"), .transitions = on_ping }, { 0 } };
    ta_scxml_spec spec = { .name = S("ping"), .states = states };
    ta_definition_id chart = define(system, &spec);
    enum { COUNT = 200 };
    ta_actor_id actors[COUNT];
    for (int index = 0; index < COUNT; index += 1) {
        actors[index] = spawn(system, chart);
    }
    ta_event_name_id ping = name(system, "ping");
    for (int round = 0; round < 3; round += 1) {
        settle(system);
        for (int index = 0; index < COUNT; index += 1) {
            CHECK(post(system, actors[index], ping) == TA_OK);
        }
    }
    settle(system);
    uint64_t before = addon_calls(system);
    uint64_t core_before = tna_allocator_counters(&system->allocator, TNA_MEMORY_CORE).allocations;
    for (int round = 0; round < 5; round += 1) {
        for (int index = 0; index < COUNT; index += 1) {
            CHECK(post(system, actors[index], ping) == TA_OK);
        }
        settle(system);
    }
    CHECK(addon_calls(system) == before);
    uint64_t core_after = tna_allocator_counters(&system->allocator, TNA_MEMORY_CORE).allocations;
    printf("steady state: 0 addon allocator calls, %llu core allocations for %d messages\n",
           (unsigned long long)(core_after - core_before), 5 * COUNT);
    finish_system(system);
}

/*
 * Replacement in place (ROADMAP step 14): the incumbent's waiting mail moves,
 * in order, to the front of the replacement's mailbox, ahead of mail posted
 * to the replacement directly.
 */
static void transfer_on_replacement(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_steps(system);
    ta_actor_id incumbent = spawn(system, chart);
    ta_actor_id replacement = spawn(system, chart);
    settle(system);
    CHECK(post(system, incumbent, name(system, "x")) == TA_OK);
    CHECK(post(system, incumbent, name(system, "y")) == TA_OK);
    CHECK(post(system, replacement, name(system, "z")) == TA_OK);
    CHECK(state(system, incumbent) == TNA_SCHED_READY);
    CHECK(tna_sched_transfer(&system->sched, &(tna_sched_transfer_params){ .from = incumbent, .to = replacement }) ==
          TA_OK);
    CHECK(tna_sched_mailbox_count(&system->sched, incumbent) == 0u);
    CHECK(tna_sched_mailbox_count(&system->sched, replacement) == 3u);
    CHECK(state(system, incumbent) == TNA_SCHED_IDLE);
    CHECK(tna_sched_transfer(&system->sched, &(tna_sched_transfer_params){ .from = incumbent, .to = replacement }) ==
          TA_OK); /* nothing left to move */
    CHECK(settle(system) == 0u);
    CHECK(strcmp(state_of(system, incumbent), "a") == 0);
    CHECK(strcmp(state_of(system, replacement), "final") == 0); /* x, y, then z */
    CHECK(tna_sched_transfer(&system->sched, &(tna_sched_transfer_params){ .from = 99u, .to = replacement }) ==
          TA_ERR_NOT_FOUND);
    finish_system(system);
}

/* Unloading an actor with mail waiting dead-letters that mail as `unloaded`. */
static void unload_with_mail(void) {
    tna_system *system = make_system();
    ta_actor_id actor = spawn(system, define_steps(system));
    settle(system);
    CHECK(post(system, actor, name(system, "x")) == TA_OK);
    CHECK(tna_hook_actor_unloaded(system, actor) == TA_OK); /* as after ta_actor_unload */
    tna_system_turn(system);
    uint32_t unloaded = 0;
    for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
        unloaded += record->kind == TNA_RECORD_DEAD_LETTER && record->reason == TNA_DEAD_UNLOADED ? 1u : 0u;
    }
    tna_system_end_turn(system);
    CHECK(unloaded == 1u);
    CHECK(tna_sched_lookup(&system->sched, actor) == NULL);
    destroy(system, actor); /* core still has it: the hook alone was driven */
    finish_system(system);
}

/* Close releases queued mail and leaks nothing. */
static void close_with_mail(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_steps(system);
    ta_actor_id actor = spawn(system, chart);
    ta_actor_id gone = spawn(system, chart);
    settle(system);
    destroy(system, gone);
    for (int index = 0; index < 3000; index += 1) {
        CHECK(post(system, actor, name(system, "y")) == TA_OK); /* spans several envelope pages */
    }
    CHECK(post(system, gone, name(system, "x")) == TA_OK);
    finish_system(system);
}

int main(void) {
    fifo_across_the_budget();
    mail_before_bootstrap();
    stale_ids();
    quarantine();
    a_fault_stays_with_its_actor();
    finished_and_destroyed_targets();
    backpressure();
    dead_letter_budget();
    steady_state();
    close_with_mail();
    transfer_on_replacement();
    unload_with_mail();
    puts("mailbox_test passed");
    return 0;
}
