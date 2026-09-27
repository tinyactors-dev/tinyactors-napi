/*
 * What a debugger's pokes need from the scheduler (ADR 0026), driven without
 * Node-API: operator transitions in the envelope (taken, refused, and for
 * another revision), and settling an abandoned macrostep.
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

enum { MAX_SETTLED = 16 };
static tna_settlement settled[MAX_SETTLED];
static uint32_t settled_count;

static tna_system *make_system(void) {
    settled_count = 0; /* waiter indices start again in each system */
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

/* a --x--> b --y--> c --z--> end (a top-level final); state IDs 0 to 3. */
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

/*
 * idle --go--> s1 -> s2 -> s3 -> rest: three eventless microsteps, each
 * entering a state whose onentry holds two <log> actions. With `spin`,
 * s3 goes back to s1 instead: a macrostep that never ends.
 */
static ta_definition_id define_chain(tna_system *system, bool spin) {
    static ta_scxml_action_spec logs[] = {
        { .kind = TA_SCXML_ACTION_LOG, .as.log = { .label = { "one", 3 } } },
        { .kind = TA_SCXML_ACTION_LOG, .as.log = { .label = { "two", 3 } } },
        { 0 },
    };
    static ta_scxml_handler_spec onentry[] = { { .actions = logs }, { 0 } };
    static ta_str to_s1[] = { { "s1", 2 }, { 0 } };
    static ta_str to_s2[] = { { "s2", 2 }, { 0 } };
    static ta_str to_s3[] = { { "s3", 2 }, { 0 } };
    static ta_str to_rest[] = { { "rest", 4 }, { 0 } };
    static ta_scxml_transition_spec on_go[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "go", 2 }, .targets = to_s1 }, { 0 } };
    static ta_scxml_transition_spec s1_next[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .targets = to_s2 }, { 0 } };
    static ta_scxml_transition_spec s2_next[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .targets = to_s3 }, { 0 } };
    static ta_scxml_transition_spec s3_rest[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .targets = to_rest }, { 0 } };
    static ta_scxml_transition_spec s3_spin[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .targets = to_s1 }, { 0 } };
    ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("idle"), .transitions = on_go },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("s1"), .onentry = onentry, .transitions = s1_next },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("s2"), .onentry = onentry, .transitions = s2_next },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("s3"), .onentry = onentry, .transitions = spin ? s3_spin : s3_rest },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("rest") },
        { 0 },
    };
    ta_scxml_spec spec = { .name = spin ? S("spin") : S("chain"), .states = states };
    return define(system, &spec);
}

static ta_actor_id spawn(tna_system *system, ta_definition_id definition) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = definition, .out = &actor }) == TA_OK);
    CHECK(tna_hook_actor_created(system, actor) == TA_OK);
    return actor;
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

/* Posts `event` with a fresh waiter and returns the waiter. */
static uint32_t send(tna_system *system, ta_actor_id target, ta_event_name_id event) {
    uint32_t waiter = tna_sched_waiter_take(&system->sched);
    CHECK(waiter != 0);
    ta_event message = { .name = event, .type = TA_EVENT_EXTERNAL, .invoke_id = TA_INVOKE_ID_NONE };
    CHECK(tna_system_post(system, &(tna_message){ .target = target, .event = &message, .waiter = waiter }) == TA_OK);
    return waiter;
}

/* Posts `event` carrying an operator transition; `waiter` may be 0. */
static ta_result post_jump(tna_system *system, ta_actor_id target, ta_event_name_id event, const tna_message_jump *jump,
                           uint32_t waiter) {
    ta_event message = { .name = event, .type = TA_EVENT_EXTERNAL, .invoke_id = TA_INVOKE_ID_NONE };
    return tna_system_post(system, &(tna_message){ .target = target, .event = &message, .jump = jump, .waiter = waiter });
}

typedef struct {
    uint32_t faults;
    uint32_t dead;
    uint32_t refused;
} turn_counts;

/* Pops settlements as the Node-API layer does, and gives their waiters back. */
static void collect(tna_system *system) {
    tna_settlement settlement;
    while (tna_sched_settlement_pop(&system->sched, &settlement)) {
        CHECK(settled_count < MAX_SETTLED);
        settled[settled_count] = settlement;
        settled_count += 1u;
        tna_sched_waiter_give(&system->sched, settlement.waiter);
    }
}

/* The latest settlement of `waiter` (waiter indices are reused), or NULL. */
static const tna_settlement *settlement_of(uint32_t waiter) {
    for (uint32_t index = settled_count; index > 0; index -= 1) {
        if (settled[index - 1u].waiter == waiter) {
            return &settled[index - 1u];
        }
    }
    return NULL;
}

/* One turn, counting its records. */
static turn_counts turn(tna_system *system) {
    turn_counts counts = { 0 };
    tna_system_turn(system);
    for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
        counts.faults += record->kind == TNA_RECORD_FAULT ? 1u : 0u;
        counts.dead += record->kind == TNA_RECORD_DEAD_LETTER ? 1u : 0u;
        counts.refused += record->kind == TNA_RECORD_DEAD_LETTER && record->reason == TNA_DEAD_REFUSED ? 1u : 0u;
    }
    collect(system);
    tna_system_end_turn(system);
    return counts;
}

/* Runs turns until quiet, adding up their records. */
static turn_counts settle(tna_system *system) {
    turn_counts total = { 0 };
    for (int guard = 0; !tna_system_quiet(system); guard += 1) {
        CHECK(guard < 1000);
        turn_counts counts = turn(system);
        total.faults += counts.faults;
        total.dead += counts.dead;
        total.refused += counts.refused;
    }
    return total;
}

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

static ta_definition_id definition_of(tna_system *system, ta_actor_id actor) {
    ta_actor_inspection view;
    CHECK(ta_actor_inspect(system->core, actor, &view) == TA_OK);
    return view.definition_id;
}

/* An operator transition queues behind real mail and reaches deliver; one
 * the actor no longer accepts is a dead letter, not a fault. */
static void operator_transitions(void) {
    tna_system *system = make_system();
    ta_definition_id steps = define_steps(system);
    ta_actor_id actor = spawn(system, steps);
    settle(system);
    CHECK(sizeof(tna_sched_entry) == 16u);
    CHECK(sizeof(tna_envelope) == 104u); /* the jump shares the address's room */
    ta_event_name_id x = name(system, "x");
    ta_event_name_id jump_event = name(system, "operator.goto");
    ta_state_id to_c[] = { 2u };
    tna_message_jump to_c_from_root = {
        .definition = steps,
        .transition = { .source = TA_STATE_NONE, .targets = to_c, .target_count = 1u },
    };
    /* Behind x: x moves a to b first, then the jump moves b to c. */
    CHECK(post(system, actor, x) == TA_OK);
    uint32_t waiter = tna_sched_waiter_take(&system->sched);
    CHECK(post_jump(system, actor, jump_event, &to_c_from_root, waiter) == TA_OK);
    const tna_envelope *queued = tna_sched_envelope(&system->sched, tna_sched_lookup(&system->sched, actor)->last);
    CHECK(queued->has_jump && queued->jump->count == 1u && queued->jump->targets[0] == 2u);
    turn_counts counts = settle(system);
    CHECK(counts.faults == 0u && counts.dead == 0u);
    CHECK(strcmp(state_of(system, actor), "c") == 0);
    CHECK(settlement_of(waiter) != NULL && settlement_of(waiter)->kind == TNA_SETTLE_STABLE);

    /* From a: queued behind a jump to c, a is no longer active: refused. */
    ta_state_id to_b[] = { 1u };
    tna_message_jump from_a = {
        .definition = steps,
        .transition = { .source = 0u, .targets = to_b, .target_count = 1u },
    };
    CHECK(post(system, actor, name(system, "unknown.event")) == TA_OK); /* ignored: the actor stays in c */
    waiter = tna_sched_waiter_take(&system->sched);
    CHECK(post_jump(system, actor, jump_event, &from_a, waiter) == TA_OK);
    counts = settle(system);
    CHECK(counts.faults == 0u && counts.refused == 1u);
    CHECK(state(system, actor) == TNA_SCHED_IDLE); /* not quarantined */
    CHECK(strcmp(state_of(system, actor), "c") == 0);
    const tna_settlement *refused = settlement_of(waiter);
    CHECK(refused != NULL && refused->kind == TNA_SETTLE_DEAD && refused->reason == TNA_DEAD_REFUSED);

    /* A jump over another revision's state IDs is refused without reaching core. */
    ta_definition_id other = define_chain(system, false);
    tna_message_jump foreign = {
        .definition = other,
        .transition = { .source = TA_STATE_NONE, .targets = to_b, .target_count = 1u },
    };
    CHECK(post_jump(system, actor, jump_event, &foreign, 0) == TA_OK);
    counts = settle(system);
    CHECK(counts.faults == 0u && counts.refused == 1u);
    CHECK(strcmp(state_of(system, actor), "c") == 0);

    /* Back to a, by a jump from the root. */
    CHECK(definition_of(system, actor) == steps);
    ta_state_id to_a[] = { 0u };
    tna_message_jump back = {
        .definition = steps,
        .transition = { .source = TA_STATE_NONE, .targets = to_a, .target_count = 1u },
    };
    CHECK(post_jump(system, actor, jump_event, &back, 0) == TA_OK);
    counts = settle(system);
    CHECK(counts.faults == 0u && counts.dead == 0u);
    CHECK(strcmp(state_of(system, actor), "a") == 0);

    /* Jumps withdrawn, to a gone actor, or left waiting give their memory back. */
    uint32_t withdrawn = tna_sched_waiter_take(&system->sched);
    CHECK(post_jump(system, actor, jump_event, &back, withdrawn) == TA_OK);
    CHECK(tna_sched_cancel(&system->sched, withdrawn));
    tna_sched_waiter_give(&system->sched, withdrawn);
    CHECK(post_jump(system, ta_actor_id_make(900u, 1u), jump_event, &back, 0) == TA_OK);
    counts = settle(system);
    CHECK(counts.dead == 1u);
    CHECK(post_jump(system, actor, jump_event, &back, 0) == TA_OK); /* left in the mailbox */
    finish_system(system); /* no leak: the waiting jump went with its envelope */
}

/* Abandoning a macrostep that never ends settles napi's state: the send()
 * rejects as abandoned, and the actor stands between macrosteps. */
static void abandoned_macrostep(void) {
    tna_system *system = make_system();
    ta_definition_id spin = define_chain(system, true);
    ta_actor_id actor = spawn(system, spin);
    settle(system);
    ta_event_name_id go = name(system, "go");
    uint32_t waiter = send(system, actor, go);
    CHECK(post(system, actor, go) == TA_OK); /* waits behind the runaway */
    for (int index = 0; index < 5; index += 1) {
        turn(system);
    }
    CHECK(state(system, actor) == TNA_SCHED_RUNNABLE);
    CHECK(settlement_of(waiter) == NULL);

    /* Paused inside a microstep, core refuses (core ADR 0082); the next
     * turn, with no action budget, finishes that microstep and pauses
     * between two. */
    system->budgets.actions = 1u;
    turn(system);
    CHECK(ta_actor_abandon(system->core, actor) == TA_ERR_BUSY);
    system->budgets.actions = 0u;
    turn(system);
    CHECK(ta_actor_abandon(system->core, actor) == TA_OK);
    CHECK(tna_hook_actor_abandoned(system, actor) == TA_OK);
    collect(system);
    const tna_settlement *abandoned = settlement_of(waiter);
    CHECK(abandoned != NULL && abandoned->kind == TNA_SETTLE_ABANDONED);
    CHECK(state(system, actor) == TNA_SCHED_READY); /* its next message waits */
    turn(system); /* the stale runnable entry is skipped; the next go starts another runaway */
    CHECK(state(system, actor) == TNA_SCHED_RUNNABLE);
    CHECK(tna_sched_mailbox_count(&system->sched, actor) == 0u);

    /* Abandoned with nothing waiting, it stands idle. */
    turn(system);
    CHECK(ta_actor_abandon(system->core, actor) == TA_OK);
    CHECK(tna_hook_actor_abandoned(system, actor) == TA_OK);
    CHECK(state(system, actor) == TNA_SCHED_IDLE);
    turn(system);
    CHECK(state(system, actor) == TNA_SCHED_IDLE);
    finish_system(system);
}

int main(void) {
    operator_transitions();
    abandoned_macrostep();
    puts("debugging_test passed");
    return 0;
}
