/*
 * The router (ADR 0006), driven without Node-API: a <send> between actors
 * lands in the target's mailbox, a named target resolves through the
 * directory, a name with no actor is a dead letter that keeps the name, and
 * a named origin stays valid after its sender is destroyed (tinyactors-core
 * ADR 0065) — run under AddressSanitizer by test-native-asan.
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

/* Family "r": wait --hit--> got. */
static ta_definition_id define_receiver(tna_system *system) {
    static ta_str to_got[] = { { "got", 3 }, { 0 } };
    static ta_scxml_transition_spec on_hit[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = { "hit", 3 }, .targets = to_got }, { 0 } };
    static ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "wait", 4 }, .transitions = on_hit },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "got", 3 } },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("r"), .states = states };
    return define(system, &spec);
}

/* Family "snd": `a` sends hit to `target` on entry, then goes straight to the final `end`. */
static ta_definition_id define_sender(tna_system *system, ta_str target) {
    ta_scxml_action_spec actions[] = {
        { .kind = TA_SCXML_ACTION_SEND,
          .as.send = { .event = { .kind = TA_SCXML_EVENT_NAME, .as.name = S("hit") },
                       .target = { .kind = TA_SCXML_STRING_LITERAL, .as.literal = target } } },
        { 0 },
    };
    ta_scxml_handler_spec onentry[] = { { .actions = actions }, { 0 } };
    ta_str to_end[] = { S("end"), { 0 } };
    ta_scxml_transition_spec always[] = { { .kind = TA_SCXML_TRANSITION_EXTERNAL, .targets = to_end }, { 0 } };
    ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("a"), .onentry = onentry, .transitions = always },
        { .kind = TA_SCXML_STATE_FINAL, .id = S("end") },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("snd"), .states = states };
    return define(system, &spec);
}

static ta_actor_id spawn(tna_system *system, ta_definition_id definition, const ta_actor_address *address) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = definition, .address = address, .out = &actor }) ==
          TA_OK);
    CHECK(tna_hook_actor_created(system, actor) == TA_OK);
    return actor;
}

static void destroy(tna_system *system, ta_actor_id actor) {
    CHECK(ta_actor_destroy(system->core, actor) == TA_OK);
    CHECK(tna_hook_actor_removed(system, actor) == TA_OK);
}

/* Runs turns until quiet; checks for no faults and counts the dead letters. */
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

static bool text_is(ta_str text, const char *expected) {
    return text.len == strlen(expected) && memcmp(text.ptr, expected, text.len) == 0;
}

static bool in_state(tna_system *system, ta_actor_id actor, const char *id) {
    ta_state_id states[4];
    uint32_t count = 0;
    CHECK(ta_actor_active_states(system->core, &(ta_actor_active_states_params){
                                                   .actor = actor, .states = states, .capacity = 4, .count = &count }) ==
          TA_OK);
    ta_actor_inspection view;
    CHECK(ta_actor_inspect(system->core, actor, &view) == TA_OK);
    ta_state_info info;
    CHECK(count > 0);
    CHECK(ta_definition_state(system->core, &(ta_definition_state_params){
                                                .definition = view.definition_id, .state = states[count - 1u], .out = &info }) ==
          TA_OK);
    return text_is(info.id, id);
}

/*
 * A named sender finishes and is destroyed while its message waits in the
 * receiver's mailbox: the envelope's origin is the sender's interned
 * address, and it stays readable (AddressSanitizer would catch a freed one).
 */
static void named_origin_outlives_its_sender(void) {
    tna_system *system = make_system();
    ta_actor_address receiver_name = { .family = { .name = S("r") }, .name = S("recv") };
    ta_actor_address sender_name = { .family = { .name = S("snd") }, .name = S("s1") };
    ta_actor_id receiver = spawn(system, define_receiver(system), &receiver_name);
    ta_actor_id sender = spawn(system, define_sender(system, S("#_actor_r/recv")), &sender_name);

    /* One turn with no deliveries: both bootstrap, the sender sends and finishes. */
    uint32_t messages = system->budgets.messages;
    system->budgets.messages = 0;
    tna_system_turn(system);
    bool done = false;
    for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
        CHECK(record->kind != TNA_RECORD_FAULT);
        done = done || (record->kind == TNA_RECORD_DONE && record->actor == sender);
    }
    CHECK(done);
    tna_system_end_turn(system);
    system->budgets.messages = messages;
    CHECK(tna_sched_mailbox_count(&system->sched, receiver) == 1u);

    destroy(system, sender); /* what finished: "destroy" does after the done hook */

    const tna_sched_entry *entry = tna_sched_lookup(&system->sched, receiver);
    const tna_envelope *envelope = tna_sched_envelope(&system->sched, entry->first);
    CHECK(envelope->event.origin.kind == TA_ORIGIN_ACTOR);
    CHECK(envelope->event.origin.as.actor.kind == TA_ACTOR_REF_NAMED);
    ta_actor_address origin = ta_address_view(envelope->event.origin.as.actor.as.named);
    CHECK(text_is(origin.family.name, "snd"));
    CHECK(text_is(origin.name, "s1"));

    CHECK(settle(system) == 0u);
    CHECK(in_state(system, receiver, "got"));
    CHECK(system->sched.delivered == 1u);
    finish_system(system);
}

/* Family "snd": `a` sends hit to `target` on entry, and goes to `failed` on error.communication. */
static ta_definition_id define_failing_sender(tna_system *system, ta_str target) {
    ta_scxml_action_spec actions[] = {
        { .kind = TA_SCXML_ACTION_SEND,
          .as.send = { .event = { .kind = TA_SCXML_EVENT_NAME, .as.name = S("hit") },
                       .target = { .kind = TA_SCXML_STRING_LITERAL, .as.literal = target } } },
        { 0 },
    };
    ta_scxml_handler_spec onentry[] = { { .actions = actions }, { 0 } };
    ta_str to_failed[] = { S("failed"), { 0 } };
    ta_scxml_transition_spec on_error[] = {
        { .kind = TA_SCXML_TRANSITION_EXTERNAL, .event = S("error.communication"), .targets = to_failed }, { 0 } };
    ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("a"), .onentry = onentry, .transitions = on_error },
        { .kind = TA_SCXML_STATE_ATOMIC, .id = S("failed") },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("snd"), .states = states };
    return define(system, &spec);
}

/*
 * A chart's send to a name the directory has no actor for, in a family with
 * no loader, is refused: the sender gets error.communication (napi ADR
 * 0022, SCXML 6.2.4), and nothing becomes a dead letter.
 */
static void unknown_name_raises_error_communication(void) {
    tna_system *system = make_system();
    ta_actor_address sender_name = { .family = { .name = S("snd") }, .name = S("s2") };
    ta_actor_id sender = spawn(system, define_failing_sender(system, S("#_actor_r/nobody")), &sender_name);
    CHECK(settle(system) == 0u);
    CHECK(in_state(system, sender, "failed"));
    finish_system(system);
}

/* A named target follows the directory: a new actor at the name gets the next message. */
static void named_target_follows_the_directory(void) {
    tna_system *system = make_system();
    ta_actor_address receiver_name = { .family = { .name = S("r") }, .name = S("recv") };
    ta_definition_id receiver_chart = define_receiver(system);
    ta_definition_id sender_chart = define_sender(system, S("#_actor_r/recv"));
    ta_actor_id first = spawn(system, receiver_chart, &receiver_name);
    CHECK(settle(system) == 0u);
    destroy(system, first);
    ta_actor_id second = spawn(system, receiver_chart, &receiver_name);
    (void)spawn(system, sender_chart, NULL);
    CHECK(settle(system) == 0u);
    CHECK(in_state(system, second, "got"));
    finish_system(system);
}

int main(void) {
    named_origin_outlives_its_sender();
    unknown_name_raises_error_communication();
    named_target_follows_the_directory();
    puts("router_test passed");
    return 0;
}
