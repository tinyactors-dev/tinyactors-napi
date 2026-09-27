/*
 * Loading unloaded actors on demand (napi ADR 0020), driven without
 * Node-API: mail for an unloaded name waits in its load's mailbox and moves,
 * in order, to the front of the loaded actor's mailbox; the per-address cap;
 * waiting mail counts against maxQueuedMessages; a failed load's mail
 * becomes dead letters that keep the name; a virtual family's unknown name
 * starts a load; an unloaded actor's own timer wakes it; and without a
 * loader nothing changes. Run under AddressSanitizer by test-native-asan.
 */
#include <string.h>

#include "check.h"
#include "events.h"
#include "hooks.h"
#include "loads.h"
#include "router.h"
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
    CHECK(tna_system_set_clock(system, TNA_CLOCK_MANUAL, 0) == TA_OK);
    return system;
}

static void finish_system(tna_system *system) {
    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

/* Family "r": idle, taking any event without changing state. */
static ta_definition_id define_receiver(tna_system *system) {
    static ta_scxml_transition_spec any[] = {
        { .kind = TA_SCXML_TRANSITION_INTERNAL, .event = { "*", 1 } }, { 0 } };
    static ta_scxml_state_spec states[] = {
        { .kind = TA_SCXML_STATE_ATOMIC, .id = { "idle", 4 }, .transitions = any },
        { 0 },
    };
    ta_scxml_spec spec = { .name = S("r"), .states = states };
    ta_definition *definition = NULL;
    CHECK(ta_definition_compile_spec(system->core, &(ta_definition_compile_params){
                                                       .spec = &spec,
                                                       .datamodel = ta_null_datamodel(),
                                                       .allocator = tna_allocator_for(&system->allocator, TNA_MEMORY_CORE),
                                                       .out = &definition,
                                                   }) == TA_OK);
    ta_definition_id id = 0;
    CHECK(ta_system_register_definition(system->core, definition, &id) == TA_OK);
    return id;
}

static const ta_actor_address recv_name = { .family = { .name = { "r", 1 } }, .name = { "recv", 4 } };

static ta_actor_id spawn(tna_system *system, ta_definition_id definition, const ta_actor_address *address) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = definition, .address = address,
                                                                 .out = &actor }) == TA_OK);
    CHECK(tna_hook_actor_created(system, actor) == TA_OK);
    return actor;
}

/* Runs turns until quiet; returns the dead letters, and the last one's reason. */
static uint32_t settle(tna_system *system, tna_dead_reason *reason) {
    uint32_t dead = 0;
    for (int guard = 0; !tna_system_quiet(system); guard += 1) {
        CHECK(guard < 1000);
        tna_system_turn(system);
        for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
            CHECK(record->kind != TNA_RECORD_FAULT);
            if (record->kind == TNA_RECORD_DEAD_LETTER) {
                dead += 1u;
                if (reason != NULL) {
                    *reason = record->reason;
                }
                CHECK(record->has_address || record->actor != 0);
            }
        }
        tna_system_end_turn(system);
    }
    return dead;
}

static ta_session_image *unload(tna_system *system, ta_actor_id actor) {
    ta_session_image *image = NULL;
    CHECK(ta_actor_capture(system->core, &(ta_actor_capture_params){ .actor = actor, .out = &image }) == TA_OK);
    CHECK(ta_actor_unload(system->core, &(ta_actor_unload_params){ .actor = actor, .image = image }) == TA_OK);
    CHECK(tna_hook_actor_unloaded(system, actor) == TA_OK);
    return image;
}

static ta_actor_id load(tna_system *system, ta_session_image *image) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_load(system->core, &(ta_actor_load_params){ .image = image, .out = &actor }) == TA_OK);
    CHECK(tna_hook_actor_created(system, actor) == TA_OK);
    ta_session_image_destroy(image);
    return actor;
}

static ta_address *intern(tna_system *system, const ta_actor_address *text) {
    ta_address *address = NULL;
    CHECK(ta_address_intern(system->core, text, &address) == TA_OK);
    return address;
}

static ta_event_name_id event_name(tna_system *system, const char *text) {
    ta_event_name_id name = 0;
    CHECK(tna_event_name_intern(system->core, (ta_str){ .ptr = text, .len = (uint32_t)strlen(text) }, &name) ==
          TA_OK);
    return name;
}

/* Posts an event named `text` to `address` as JavaScript's postNamed does. */
static ta_result post(tna_system *system, ta_address *address, const char *text) {
    ta_event event = { .type = TA_EVENT_EXTERNAL, .name = event_name(system, text), .invoke_id = TA_INVOKE_ID_NONE };
    return tna_router_post_named(system, address, &(tna_message){ .event = &event });
}

static tna_load_request next_request(tna_system *system) {
    tna_load_request request;
    CHECK(tna_loads_next_request(&system->loads, &request));
    return request;
}

static ta_result finish(tna_system *system, tna_load_request request, tna_load_outcome outcome, ta_actor_id actor) {
    return tna_loads_finish(&system->loads, &(tna_load_finish){ .sched = &system->sched,
                                                                .directory = &system->directory,
                                                                .metrics = &system->metrics,
                                                                .index = request.index,
                                                                .generation = request.generation,
                                                                .outcome = outcome,
                                                                .actor = actor });
}

/* The event names in `actor`'s mailbox, in order, must be `expected`. */
static void mailbox_is(tna_system *system, ta_actor_id actor, const char *const *expected, uint32_t count) {
    const tna_sched_entry *entry = tna_sched_lookup(&system->sched, actor);
    CHECK(entry != NULL);
    uint32_t at = 0;
    for (uint32_t index = entry->first; index != 0; index = tna_sched_envelope(&system->sched, index)->next) {
        CHECK(at < count);
        CHECK(tna_sched_envelope(&system->sched, index)->event.name == event_name(system, expected[at]));
        CHECK(tna_sched_envelope(&system->sched, index)->target == actor);
        at += 1u;
    }
    CHECK(at == count);
}

/*
 * Mail for an unloaded name starts one load; more mail joins its mailbox,
 * even after the actor is resident again, until the load finishes; then it
 * goes, in order, ahead of mail sent to the actor meanwhile.
 */
static void waiting_mail_moves_in_order(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_receiver(system);
    ta_actor_id first = spawn(system, chart, &recv_name);
    CHECK(settle(system, NULL) == 0u);
    ta_session_image *image = unload(system, first);
    CHECK(tna_loads_set_family(&system->loads, S("r"), 10) == TA_OK);
    ta_address *address = intern(system, &recv_name);

    CHECK(post(system, address, "a") == TA_OK);
    CHECK(post(system, address, "b") == TA_OK);
    CHECK(system->loads.in_flight == 1u && system->loads.waiting == 2u);
    tna_load_request request = next_request(system);
    CHECK(request.address == address && request.why == TNA_LOAD_WHY_MAIL);
    tna_load_request none;
    CHECK(!tna_loads_next_request(&system->loads, &none)); /* one load per address */

    ta_actor_id loaded = load(system, image);
    CHECK(post(system, address, "c") == TA_OK); /* resident, but the load is in flight: it waits too */
    ta_event direct = { .type = TA_EVENT_EXTERNAL, .name = event_name(system, "d"), .invoke_id = TA_INVOKE_ID_NONE };
    CHECK(tna_system_post(system, &(tna_message){ .target = loaded, .event = &direct }) == TA_OK);

    CHECK(finish(system, request, TNA_LOAD_LOADED, loaded) == TA_OK);
    static const char *const order[] = { "a", "b", "c", "d" };
    mailbox_is(system, loaded, order, 4);
    CHECK(system->loads.in_flight == 0u && system->loads.waiting == 0u);
    CHECK(system->loads.outcomes[TNA_LOAD_LOADED] == 1u);
    CHECK(system->metrics.load_seconds.count == 1u);
    CHECK(finish(system, request, TNA_LOAD_LOADED, loaded) == TA_ERR_STALE);
    CHECK(settle(system, NULL) == 0u);
    CHECK(system->sched.delivered == 4u);

    /* Resident and no load in flight: mail goes straight to the actor. */
    CHECK(post(system, address, "e") == TA_OK);
    CHECK(tna_sched_mailbox_count(&system->sched, loaded) == 1u && system->loads.in_flight == 0u);
    ta_address_release(address);
    finish_system(system);
}

/* At most max_waiting messages wait; waiting mail counts against max_queued. */
static void waiting_mail_is_bounded(void) {
    tna_system *system = make_system();
    ta_actor_id first = spawn(system, define_receiver(system), &recv_name);
    CHECK(settle(system, NULL) == 0u);
    ta_session_image *image = unload(system, first);
    CHECK(tna_loads_set_family(&system->loads, S("r"), 2) == TA_OK);
    ta_address *address = intern(system, &recv_name);
    CHECK(post(system, address, "a") == TA_OK);
    CHECK(post(system, address, "b") == TA_OK);
    CHECK(post(system, address, "c") == TA_OK); /* accepted as a waiting-full dead letter */
    CHECK(system->loads.waiting == 2u && system->sched.queued == 3u);
    system->sched.max_queued = 3u;
    CHECK(post(system, address, "d") == TA_ERR_BUSY);
    system->sched.max_queued = 0;
    tna_load_request request = next_request(system); /* the pump hands it to JavaScript after a turn */
    tna_dead_reason reason = TNA_DEAD_NOT_FOUND;
    CHECK(settle(system, &reason) == 1u && reason == TNA_DEAD_WAITING_FULL);

    ta_actor_id loaded = load(system, image);
    CHECK(finish(system, request, TNA_LOAD_LOADED, loaded) == TA_OK);
    CHECK(settle(system, NULL) == 0u);
    CHECK(system->sched.delivered == 2u);
    ta_address_release(address);
    finish_system(system);
}

/* A load that fails dead-letters its mail with the name; the next mail starts a new load. */
static void a_failed_load_dead_letters_its_mail(void) {
    static const struct {
        tna_load_outcome outcome;
        tna_dead_reason reason;
    } cases[] = {
        { TNA_LOAD_NOT_FOUND, TNA_DEAD_NOT_FOUND },
        { TNA_LOAD_REJECTED, TNA_DEAD_REJECTED },
        { TNA_LOAD_FAILED, TNA_DEAD_LOAD_FAILED },
        { TNA_LOAD_TIMED_OUT, TNA_DEAD_LOAD_TIMEOUT },
    };
    for (uint32_t at = 0; at < sizeof cases / sizeof cases[0]; at += 1u) {
        tna_system *system = make_system();
        ta_actor_id first = spawn(system, define_receiver(system), &recv_name);
        CHECK(settle(system, NULL) == 0u);
        ta_session_image *image = unload(system, first);
        CHECK(tna_loads_set_family(&system->loads, S("r"), 10) == TA_OK);
        ta_address *address = intern(system, &recv_name);
        CHECK(post(system, address, "a") == TA_OK);
        CHECK(post(system, address, "b") == TA_OK);
        tna_load_request request = next_request(system);
        /* A LOADED finish for an actor that is not at the address changes nothing. */
        CHECK(finish(system, request, TNA_LOAD_LOADED, first) == TA_ERR_NOT_FOUND);
        CHECK(finish(system, request, cases[at].outcome, 0) == TA_OK);
        tna_dead_reason reason = TNA_DEAD_DONE;
        CHECK(settle(system, &reason) == 2u && reason == cases[at].reason);
        CHECK(system->loads.outcomes[cases[at].outcome] == 1u && system->loads.waiting == 0u);
        CHECK(system->sched.dead_by_reason[cases[at].reason] == 2u);
        /* The next message starts a new load. */
        CHECK(post(system, address, "c") == TA_OK);
        tna_load_request again = next_request(system);
        CHECK(again.index != request.index || again.generation != request.generation);
        ta_actor_id loaded = load(system, image);
        CHECK(finish(system, again, TNA_LOAD_LOADED, loaded) == TA_OK);
        CHECK(settle(system, NULL) == 0u);
        ta_address_release(address);
        finish_system(system);
    }
}

/* A virtual family: a name with no entry at all starts a load, and a spawn at it finishes it. */
static void a_virtual_family_spawns(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_receiver(system);
    CHECK(tna_loads_set_family(&system->loads, S("r"), 10) == TA_OK);
    ta_address *address = intern(system, &recv_name);
    CHECK(post(system, address, "a") == TA_OK);
    tna_load_request request = next_request(system);
    ta_actor_id spawned = spawn(system, chart, &recv_name);
    CHECK(finish(system, request, TNA_LOAD_SPAWNED, spawned) == TA_OK);
    CHECK(settle(system, NULL) == 0u);
    CHECK(system->sched.delivered == 1u && system->loads.outcomes[TNA_LOAD_SPAWNED] == 1u);
    /* Without a loader, the old behaviour: a dead letter. */
    CHECK(tna_loads_set_family(&system->loads, S("r"), 0) == TA_OK);
    ta_actor_address other = { .family = { .name = S("r") }, .name = S("other") };
    ta_address *nobody = intern(system, &other);
    CHECK(post(system, nobody, "a") == TA_OK);
    tna_dead_reason reason = TNA_DEAD_DONE;
    CHECK(settle(system, &reason) == 1u && reason == TNA_DEAD_NOT_FOUND);
    ta_address_release(nobody);
    ta_address_release(address);
    finish_system(system);
}

/* An unloaded actor's wake-up starts a load when it is due, and not before. */
static void a_wake_up_starts_a_load(void) {
    tna_system *system = make_system();
    ta_actor_id first = spawn(system, define_receiver(system), &recv_name);
    CHECK(settle(system, NULL) == 0u);
    ta_session_image *image = unload(system, first);
    CHECK(tna_loads_set_family(&system->loads, S("r"), 10) == TA_OK);
    ta_address *address = intern(system, &recv_name);
    CHECK(tna_loads_wake_at(&system->loads, address, 500) == TA_OK);
    CHECK(tna_loads_wake_at(&system->loads, address, 100) == TA_OK); /* replaces the first */
    ta_time due = 0;
    CHECK(tna_loads_next_wake(&system->loads, &due) && due == 100);
    CHECK(settle(system, NULL) == 0u);
    CHECK(system->loads.in_flight == 0u);
    CHECK(tna_system_advance_to(system, 100) == TA_OK);
    CHECK(!tna_system_quiet(system));
    tna_system_turn(system);
    tna_system_end_turn(system);
    tna_load_request request = next_request(system);
    CHECK(request.why == TNA_LOAD_WHY_TIMER && request.address == address);
    ta_actor_id loaded = load(system, image);
    CHECK(finish(system, request, TNA_LOAD_LOADED, loaded) == TA_OK);
    /* The replaced wake-up at 500 is dropped when it comes up. */
    CHECK(tna_system_advance_to(system, 600) == TA_OK);
    CHECK(settle(system, NULL) == 0u);
    CHECK(system->loads.in_flight == 0u && system->loads.wakes.count == 0u);
    /* A wake-up for a resident actor starts nothing. */
    CHECK(tna_loads_wake_at(&system->loads, address, 700) == TA_OK);
    CHECK(tna_system_advance_to(system, 700) == TA_OK);
    CHECK(settle(system, NULL) == 0u);
    CHECK(system->loads.in_flight == 0u);
    ta_address_release(address);
    finish_system(system);
}

/*
 * A cancelled send() withdraws its message from the load's mailbox: the
 * rest still move, in order; withdrawing it again, or a message that is
 * not waiting, changes nothing.
 */
static void a_waiting_message_can_be_withdrawn(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_receiver(system);
    ta_actor_id first = spawn(system, chart, &recv_name);
    CHECK(settle(system, NULL) == 0u);
    ta_session_image *image = unload(system, first);
    CHECK(tna_loads_set_family(&system->loads, S("r"), 10) == TA_OK);
    ta_address *address = intern(system, &recv_name);

    CHECK(post(system, address, "a") == TA_OK);
    CHECK(post(system, address, "b") == TA_OK);
    CHECK(post(system, address, "c") == TA_OK);
    tna_load_request request = next_request(system);
    tna_load *record = tna_loads_find(&system->loads, request.index, request.generation);
    CHECK(record != NULL);
    uint32_t middle = tna_sched_envelope(&system->sched, record->mail.first)->next;
    uint32_t live = system->sched.envelopes.live;
    CHECK(tna_loads_withdraw(&system->loads, &system->sched, middle));
    CHECK(system->loads.waiting == 2u && record->mail.count == 2u);
    CHECK(system->sched.envelopes.live == live - 1u);
    CHECK(!tna_loads_withdraw(&system->loads, &system->sched, middle));
    uint32_t last = record->mail.last;
    CHECK(tna_loads_withdraw(&system->loads, &system->sched, last)); /* the tail moves back */
    CHECK(record->mail.count == 1u && record->mail.first == record->mail.last);
    CHECK(post(system, address, "d") == TA_OK); /* appends after the new tail */

    ta_actor_id loaded = load(system, image);
    CHECK(finish(system, request, TNA_LOAD_LOADED, loaded) == TA_OK);
    static const char *const order[] = { "a", "d" };
    mailbox_is(system, loaded, order, 2);
    CHECK(settle(system, NULL) == 0u);
    ta_address_release(address);
    finish_system(system);
}

int main(void) {
    waiting_mail_moves_in_order();
    a_waiting_message_can_be_withdrawn();
    waiting_mail_is_bounded();
    a_failed_load_dead_letters_its_mail();
    a_virtual_family_spawns();
    a_wake_up_starts_a_load();
    puts("loads_test passed");
    return 0;
}
