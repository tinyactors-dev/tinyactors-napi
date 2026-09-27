/*
 * The in-memory actor directory (ADR 0006): core's compare-and-swaps on a
 * map keyed by interned address, one address reference per entry, and
 * nothing left behind at close, driven without Node-API.
 */
#include "check.h"
#include "directory.h"
#include "system.h"

#define S(literal) ((ta_str){ .ptr = (literal), .len = (uint32_t)(sizeof(literal) - 1u) })

static ta_address *intern(tna_system *system, ta_str family, ta_str name) {
    ta_address *address = NULL;
    ta_actor_address text = { .family = { .name = family }, .name = name };
    CHECK(ta_address_intern(system->core, &text, &address) == TA_OK);
    return address;
}

static void compare_and_swap(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    tna_directory *directory = &system->directory;
    ta_actor_directory adapter = tna_directory_adapter(directory);
    ta_address *a = intern(system, S("f"), S("a"));
    ta_address *again = intern(system, S("f"), S("a"));
    CHECK(a == again); /* interned: equal addresses are one pointer */
    ta_address_release(again);

    ta_actor_directory_entry out = { .kind = TA_ACTOR_DIRECTORY_RESIDENT };
    CHECK(adapter.v->resolve(adapter.self, &(ta_actor_directory_resolve_params){ .address = a, .out = &out }) ==
          TA_ERR_NOT_FOUND);
    CHECK(out.kind == TA_ACTOR_DIRECTORY_NONE);

    ta_actor_directory_entry one = { .kind = TA_ACTOR_DIRECTORY_RESIDENT, .actor = ta_actor_id_make(3, 1) };
    ta_actor_directory_entry two = { .kind = TA_ACTOR_DIRECTORY_RESIDENT, .actor = ta_actor_id_make(4, 1) };
    ta_actor_directory_entry unloaded = { .kind = TA_ACTOR_DIRECTORY_UNLOADED };
    ta_actor_directory_entry none = { .kind = TA_ACTOR_DIRECTORY_NONE };
    CHECK(adapter.v->claim(adapter.self, &(ta_actor_directory_claim_params){ .address = a, .entry = one }) == TA_OK);
    CHECK(adapter.v->claim(adapter.self, &(ta_actor_directory_claim_params){ .address = a, .entry = two }) ==
          TA_ERR_STALE);
    CHECK(adapter.v->resolve(adapter.self, &(ta_actor_directory_resolve_params){ .address = a, .out = &out }) == TA_OK);
    CHECK(out.kind == TA_ACTOR_DIRECTORY_RESIDENT && out.actor == one.actor);

    /* replace compares against `expected` */
    CHECK(adapter.v->replace(adapter.self, &(ta_actor_directory_replace_params){
                                               .address = a, .expected = two, .replacement = unloaded }) == TA_ERR_STALE);
    CHECK(adapter.v->replace(adapter.self, &(ta_actor_directory_replace_params){
                                               .address = a, .expected = one, .replacement = unloaded }) == TA_OK);
    CHECK(tna_directory_find(directory, a).kind == TA_ACTOR_DIRECTORY_UNLOADED);
    CHECK(adapter.v->replace(adapter.self, &(ta_actor_directory_replace_params){
                                               .address = a, .expected = unloaded, .replacement = two }) == TA_OK);
    CHECK(tna_directory_find(directory, a).actor == two.actor);

    /* remove compares too, and gives the reference back */
    CHECK(adapter.v->remove(adapter.self, &(ta_actor_directory_remove_params){ .address = a, .expected = one }) ==
          TA_ERR_STALE);
    CHECK(adapter.v->remove(adapter.self, &(ta_actor_directory_remove_params){ .address = a, .expected = two }) == TA_OK);
    CHECK(tna_directory_find(directory, a).kind == TA_ACTOR_DIRECTORY_NONE);
    CHECK(adapter.v->remove(adapter.self, &(ta_actor_directory_remove_params){ .address = a, .expected = none }) == TA_OK);
    CHECK(tna_directory_count(directory) == 0);

    /* An entry left at close is given back before core goes: no leak. */
    ta_address *b = intern(system, S("f"), S("b"));
    CHECK(adapter.v->claim(adapter.self, &(ta_actor_directory_claim_params){ .address = b, .entry = unloaded }) == TA_OK);
    ta_address_release(b);
    ta_address_release(a);
    CHECK(tna_directory_count(directory) == 1);
    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

/* Core claims and removes the entry of a named actor through the directory. */
static void named_actor_lifecycle(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    static ta_scxml_state_spec states[] = { { .kind = TA_SCXML_STATE_ATOMIC, .id = { "a", 1 } }, { 0 } };
    ta_scxml_spec spec = { .name = S("f"), .states = states };
    ta_definition *definition = NULL;
    CHECK(ta_definition_compile_spec(system->core, &(ta_definition_compile_params){
                                                       .spec = &spec,
                                                       .datamodel = ta_null_datamodel(),
                                                       .allocator = tna_allocator_for(&system->allocator, TNA_MEMORY_CORE),
                                                       .out = &definition,
                                                   }) == TA_OK);
    ta_definition_id id = 0;
    CHECK(ta_system_register_definition(system->core, definition, &id) == TA_OK);
    ta_actor_address name = { .family = { .name = S("f") }, .name = S("x") };
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = id, .address = &name, .out = &actor }) ==
          TA_OK);
    ta_address *x = intern(system, S("f"), S("x"));
    ta_actor_directory_entry entry = tna_directory_find(&system->directory, x);
    CHECK(entry.kind == TA_ACTOR_DIRECTORY_RESIDENT && entry.actor == actor);
    ta_actor_id found = 0;
    CHECK(ta_actor_find(system->core, &(ta_actor_find_params){ .address = &name, .out = &found }) == TA_OK);
    CHECK(found == actor);
    CHECK(ta_actor_destroy(system->core, actor) == TA_OK);
    CHECK(tna_directory_find(&system->directory, x).kind == TA_ACTOR_DIRECTORY_NONE);
    ta_address_release(x);
    /* A named actor still resident at close: core removes it while it tears down. */
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = id, .address = &name, .out = &actor }) ==
          TA_OK);
    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

int main(void) {
    compare_and_swap();
    named_actor_lifecycle();
    puts("directory_test passed");
    return 0;
}
