/*
 * Time (ADR 0007 point 3), driven without Node-API:
 * - the manual clock dispatches due sends in deadline order, and a
 *   cancelled send never fires;
 * - the realtime clock follows a fake monotonic clock, is set at the start
 *   of every turn, so a send armed after an idle period is due its full
 *   delay later, and the host timer is armed only for an earlier deadline.
 */
#include <stdio.h>
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

/* The fake monotonic clock, in nanoseconds. */
static uint64_t fake_now;
static uint64_t read_fake(void *context) {
    (void)context;
    return fake_now;
}

/* The host timers the system asked for. */
static uint32_t armed_count;
static ta_time armed_delay;
static void record_arm(tna_system *system, ta_time delay, void *context) {
    (void)system;
    (void)context;
    armed_count += 1u;
    armed_delay = delay;
}

static tna_system *make_system(tna_clock_kind kind, ta_time initial) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    system->wake = no_wake;
    system->clock.now = read_fake;
    system->clock.arm = record_arm;
    CHECK(tna_system_set_clock(system, kind, initial) == TA_OK);
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

#define SEND(event_text, delay_text)                                                             \
    { .kind = TA_SCXML_ACTION_SEND,                                                              \
      .as.send = { .event = { .kind = TA_SCXML_EVENT_NAME, .as.name = S(event_text) },          \
                   .delay = { .kind = TA_SCXML_STRING_LITERAL, .as.literal = S(delay_text) } } }

/*
 * Family "order": `wait` arms b (200ms) then a (100ms) on entry;
 * wait --a--> one --b--> two. Reaching `two` means a fired before b.
 */
static ta_definition_id define_order(tna_system *system) {
    static ta_scxml_action_spec actions[] = { SEND("b", "200ms"), SEND("a", "100ms"), { 0 } };
    static ta_scxml_handler_spec onentry[] = { { .actions = actions }, { 0 } };
    static ta_str to_one[] = { { "one", 3 }, { 0 } };
    static ta_str to_two[] = { { "two", 3 }, { 0 } };
    static ta_scxml_transition_spec on_a[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "a", 1 }, .targets = to_one }, { 0 } };
    static ta_scxml_transition_spec on_b[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "b", 1 }, .targets = to_two }, { 0 } };
    static ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "wait", 4 }, .onentry = onentry, .transitions = on_a },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "one", 3 }, .transitions = on_b },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "two", 3 } },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("order"), .states = states };
    return define(system, &spec);
}

/*
 * Family "cancel": `wait` arms z (50ms, id "x") on entry;
 * wait --go/cancel x--> left --z--> bad.
 */
static ta_definition_id define_cancel(tna_system *system) {
    static ta_scxml_action_spec arm[] = {
        { .kind = TA_SCXML_ACTION_SEND,
          .as.send = { .id = { .kind = TA_SCXML_ID_LITERAL, .as.literal = { "x", 1 } },
                       .event = { .kind = TA_SCXML_EVENT_NAME, .as.name = { "z", 1 } },
                       .delay = { .kind = TA_SCXML_STRING_LITERAL, .as.literal = { "50ms", 4 } } } },
        { 0 },
    };
    static ta_scxml_action_spec cancel[] = {
        { .kind = TA_SCXML_ACTION_CANCEL,
          .as.cancel = { .sendid = { .kind = TA_SCXML_STRING_LITERAL, .as.literal = { "x", 1 } } } },
        { 0 },
    };
    static ta_scxml_handler_spec onentry[] = { { .actions = arm }, { 0 } };
    static ta_str to_left[] = { { "left", 4 }, { 0 } };
    static ta_str to_bad[] = { { "bad", 3 }, { 0 } };
    static ta_scxml_transition_spec on_go[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "go", 2 }, .targets = to_left, .actions = cancel }, { 0 } };
    static ta_scxml_transition_spec on_z[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "z", 1 }, .targets = to_bad }, { 0 } };
    static ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "wait", 4 }, .onentry = onentry, .transitions = on_go },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "left", 4 }, .transitions = on_z },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "bad", 3 } },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("cancel"), .states = states };
    return define(system, &spec);
}

/* Family "idle": wait --go/send t (100ms)--> armed --t--> fired. */
static ta_definition_id define_idle(tna_system *system) {
    static ta_scxml_action_spec arm[] = { SEND("t", "100ms"), { 0 } };
    static ta_str to_armed[] = { { "armed", 5 }, { 0 } };
    static ta_str to_fired[] = { { "fired", 5 }, { 0 } };
    static ta_scxml_transition_spec on_go[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "go", 2 }, .targets = to_armed, .actions = arm }, { 0 } };
    static ta_scxml_transition_spec on_t[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "t", 1 }, .targets = to_fired }, { 0 } };
    static ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "wait", 4 }, .transitions = on_go },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "armed", 5 }, .transitions = on_t },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "fired", 5 } },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("idle"), .states = states };
    return define(system, &spec);
}

static ta_actor_id spawn(tna_system *system, ta_definition_id definition) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = definition, .out = &actor }) == TA_OK);
    CHECK(tna_hook_actor_created(system, actor) == TA_OK);
    return actor;
}

/* Runs turns until quiet, checking that nothing faults. */
static void settle(tna_system *system) {
    for (int guard = 0; !tna_system_quiet(system); guard += 1) {
        CHECK(guard < 1000);
        tna_system_turn(system);
        for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
            CHECK(record->kind != TNA_RECORD_FAULT);
        }
        tna_system_end_turn(system);
    }
}

static bool in_state(tna_system *system, ta_actor_id actor, const char *id) {
    ta_state_id states[4];
    uint32_t count = 0;
    CHECK(ta_actor_active_states(system->core, &(ta_actor_active_states_params){
                                                   .actor = actor, .states = states, .capacity = 4, .count = &count }) ==
          TA_OK);
    ta_actor_inspection view;
    CHECK(ta_actor_inspect(system->core, actor, &view) == TA_OK);
    for (uint32_t index = 0; index < count; index += 1) {
        ta_state_info info;
        CHECK(ta_definition_state(system->core, &(ta_definition_state_params){
                                                    .definition = view.definition_id, .state = states[index], .out = &info }) ==
              TA_OK);
        if (info.id.len == strlen(id) && memcmp(info.id.ptr, id, info.id.len) == 0) {
            return true;
        }
    }
    return false;
}

static void post(tna_system *system, ta_actor_id actor, const char *name) {
    ta_event_name_id id = 0;
    CHECK(tna_event_name_intern(system->core, (ta_str){ .ptr = name, .len = (uint32_t)strlen(name) }, &id) == TA_OK);
    ta_event event = { .name = id, .type = TA_EVENT_EXTERNAL, .invoke_id = TA_INVOKE_ID_NONE };
    CHECK(tna_system_post(system, &(tna_message){ .target = actor, .event = &event }) == TA_OK);
}

/* Manual clock: nothing fires before its deadline, and deadlines fire in order. */
static void test_manual_order(void) {
    tna_system *system = make_system(TNA_CLOCK_MANUAL, 1000);
    CHECK(ta_system_time(system->core) == 1000);
    ta_actor_id actor = spawn(system, define_order(system));
    settle(system);
    CHECK(in_state(system, actor, "wait"));
    CHECK(tna_system_quiet(system));

    CHECK(tna_system_advance_to(system, 1099) == TA_OK);
    settle(system);
    CHECK(in_state(system, actor, "wait"));
    /* One step past both deadlines: they still fire in deadline order. */
    CHECK(tna_system_advance_to(system, 1300) == TA_OK);
    settle(system);
    CHECK(in_state(system, actor, "two"));
    /* Time never moves back, and the manual clock arms no timer. */
    CHECK(tna_system_advance_to(system, 1299) == TA_ERR_INVALID);
    CHECK(armed_count == 0);
    finish_system(system);
}

/* A cancelled send never fires. */
static void test_manual_cancel(void) {
    tna_system *system = make_system(TNA_CLOCK_MANUAL, 0);
    ta_actor_id actor = spawn(system, define_cancel(system));
    settle(system);
    post(system, actor, "go");
    settle(system);
    CHECK(in_state(system, actor, "left"));
    CHECK(tna_system_advance_to(system, 1000) == TA_OK);
    settle(system);
    CHECK(in_state(system, actor, "left"));
    finish_system(system);
}

/*
 * Realtime: after 10 s idle, the first message arms a 100ms send. Its
 * deadline counts from that turn, not from the time last set, and the timer
 * is armed for the full delay.
 */
static void test_realtime_idle(void) {
    fake_now = 5000000000u; /* 5 s of monotonic time before creation */
    armed_count = 0;
    tna_system *system = make_system(TNA_CLOCK_REALTIME, 0);
    ta_actor_id actor = spawn(system, define_idle(system));
    settle(system);
    CHECK(ta_system_time(system->core) == 0);

    fake_now += 10000000000u; /* 10 s idle */
    post(system, actor, "go");
    settle(system);
    CHECK(in_state(system, actor, "armed"));
    CHECK(ta_system_time(system->core) == 10000);
    ta_time deadline = 0;
    CHECK(ta_system_next_deadline(system->core, &deadline) == TA_OK);
    CHECK(deadline == 10100);
    CHECK(armed_count == 1 && armed_delay == 100);

    /* The timer fires early: nothing is due yet, so it is armed again. */
    fake_now += 99000000u;
    tna_system_timer_fired(system);
    settle(system);
    CHECK(in_state(system, actor, "armed"));
    CHECK(armed_count == 2 && armed_delay == 1);

    fake_now += 1000000u;
    tna_system_timer_fired(system);
    settle(system);
    CHECK(in_state(system, actor, "fired"));
    CHECK(tna_system_advance_to(system, 20000) == TA_ERR_INVALID);
    finish_system(system);
}

/* Realtime: a later deadline leaves the armed timer alone; an earlier one re-arms. */
static void test_realtime_rearm(void) {
    fake_now = 0;
    armed_count = 0;
    tna_system *system = make_system(TNA_CLOCK_REALTIME, 0);
    ta_actor_id first = spawn(system, define_idle(system));
    ta_actor_id second = spawn(system, define_idle(system));
    settle(system);

    post(system, first, "go"); /* due 100 */
    settle(system);
    CHECK(armed_count == 1 && armed_delay == 100);

    spawn(system, define_cancel(system)); /* z due 50: earlier, so it re-arms */
    settle(system);
    CHECK(armed_count == 2 && armed_delay == 50);

    fake_now += 10000000u;
    post(system, second, "go"); /* due 110: later, no new timer */
    settle(system);
    CHECK(armed_count == 2);

    fake_now += 40000000u; /* 50: z is due */
    tna_system_timer_fired(system);
    settle(system);
    CHECK(armed_count == 3 && armed_delay == 50); /* now for 100 */

    fake_now += 60000000u; /* 110: both idle sends are due */
    tna_system_timer_fired(system);
    settle(system);
    CHECK(in_state(system, first, "fired"));
    CHECK(in_state(system, second, "fired"));
    finish_system(system);
}

int main(void) {
    test_manual_order();
    test_manual_cancel();
    test_realtime_idle();
    test_realtime_rearm();
    puts("clock_test passed");
    return 0;
}
