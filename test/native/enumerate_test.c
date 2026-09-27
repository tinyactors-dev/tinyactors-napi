/*
 * Paged enumeration (ADR 0003, core ADR 0062), driven without Node-API:
 * pages continue from core's cursor, a last page that is exactly full takes
 * one more empty call, and actors spawned or destroyed between pages follow
 * core ADR 0062 §4.
 */
#include <stdbool.h>
#include <string.h>

#include "check.h"
#include "enumerate.h"
#include "system.h"

#define S(literal) ((ta_str){ .ptr = (literal), .len = (uint32_t)(sizeof(literal) - 1u) })
#define POPULATION 100u
#define MAX_ACTORS 256u

static tna_system *make_system(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    return system;
}

static void finish_system(tna_system *system) {
    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

/* Family "e": one atomic state. */
static ta_definition_id define_chart(tna_system *system) {
    static ta_scxml_state_spec states[] = { { .kind = TA_SCXML_STATE_ATOMIC, .id = { "idle", 4 } }, { 0 } };
    ta_scxml_spec spec = { .name = S("e"), .states = states };
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

static ta_actor_id spawn(tna_system *system, ta_definition_id definition) {
    ta_actor_id actor = 0;
    CHECK(ta_actor_spawn(system->core, &(ta_actor_spawn_params){ .definition = definition, .out = &actor }) == TA_OK);
    return actor;
}

/* Every ID a full walk in pages of `limit` sees, in order; returns how many pages it took. */
static uint32_t walk(tna_system *system, uint32_t limit, ta_actor_id *seen, uint32_t *count) {
    uint32_t pairs[2u * MAX_ACTORS];
    uint32_t pages = 0;
    *count = 0;
    tna_id_page page = { .from = 0, .limit = limit, .pairs = pairs };
    for (;;) {
        CHECK(tna_enumerate_ids(system, &page) == TA_OK);
        CHECK(page.count <= limit);
        pages += 1u;
        for (uint32_t at = 0; at < page.count; at += 1u) {
            seen[(*count)++] = ta_actor_id_make(pairs[2u * at], pairs[2u * at + 1u]);
        }
        if (page.next == TA_ACTOR_VISIT_END) {
            return pages;
        }
        page.from = page.next;
    }
}

static bool contains(const ta_actor_id *ids, uint32_t count, ta_actor_id id) {
    for (uint32_t at = 0; at < count; at += 1u) {
        if (ids[at] == id) {
            return true;
        }
    }
    return false;
}

/* A walk in pages sees every actor exactly once, in slot order. */
static void test_pages_cover_the_population(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_chart(system);
    ta_actor_id actors[POPULATION];
    for (uint32_t at = 0; at < POPULATION; at += 1u) {
        actors[at] = spawn(system, chart);
    }
    ta_actor_id seen[MAX_ACTORS];
    uint32_t count = 0;
    uint32_t pages = walk(system, 7u, seen, &count);
    CHECK(count == POPULATION);
    CHECK(pages == (POPULATION + 6u) / 7u);
    for (uint32_t at = 0; at < POPULATION; at += 1u) {
        CHECK(seen[at] == actors[at]);
    }
    finish_system(system);
}

/*
 * A last page that is exactly full, with slots after it that hold no actor,
 * takes one more call, which visits nothing and ends the walk.
 */
static void test_exactly_full_last_page(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_chart(system);
    ta_actor_id actors[20];
    for (uint32_t at = 0; at < 20u; at += 1u) {
        actors[at] = spawn(system, chart);
    }
    CHECK(ta_actor_destroy(system->core, actors[18]) == TA_OK);
    CHECK(ta_actor_destroy(system->core, actors[19]) == TA_OK);
    ta_actor_id seen[MAX_ACTORS];
    uint32_t count = 0;
    CHECK(walk(system, 9u, seen, &count) == 3u);
    CHECK(count == 18u);
    finish_system(system);
}

/* An empty system is one empty page that ends the walk. */
static void test_empty_system(void) {
    tna_system *system = make_system();
    uint32_t pairs[2];
    tna_id_page page = { .from = 0, .limit = 1, .pairs = pairs };
    CHECK(tna_enumerate_ids(system, &page) == TA_OK);
    CHECK(page.count == 0);
    CHECK(page.next == TA_ACTOR_VISIT_END);
    page.limit = 0;
    CHECK(tna_enumerate_ids(system, &page) == TA_ERR_INVALID);
    finish_system(system);
}

/* Core ADR 0062 §4: changes between pages. */
static void test_changes_between_pages(void) {
    tna_system *system = make_system();
    ta_definition_id chart = define_chart(system);
    ta_actor_id actors[40];
    for (uint32_t at = 0; at < 40u; at += 1u) {
        actors[at] = spawn(system, chart);
    }
    uint32_t pairs[2u * 10u];
    ta_actor_id seen[MAX_ACTORS];
    uint32_t count = 0;
    tna_id_page page = { .from = 0, .limit = 10u, .pairs = pairs };
    CHECK(tna_enumerate_ids(system, &page) == TA_OK);
    for (uint32_t at = 0; at < page.count; at += 1u) {
        seen[count++] = ta_actor_id_make(pairs[2u * at], pairs[2u * at + 1u]);
    }
    /* Destroy one already visited, one not yet reached; free a slot before the cursor and reuse it. */
    ta_actor_id visited = actors[3];
    ta_actor_id ahead = actors[25];
    CHECK(ta_actor_destroy(system->core, visited) == TA_OK);
    CHECK(ta_actor_destroy(system->core, ahead) == TA_OK);
    ta_actor_id reused = spawn(system, chart); /* takes a freed slot: 3 or 25 */
    uint32_t reused_cursor = page.next;
    ta_actor_id appended = 0;
    uint32_t appended_cursor = 0;
    for (;;) {
        if (page.next == TA_ACTOR_VISIT_END) {
            break;
        }
        page.from = page.next;
        CHECK(tna_enumerate_ids(system, &page) == TA_OK);
        for (uint32_t at = 0; at < page.count; at += 1u) {
            seen[count++] = ta_actor_id_make(pairs[2u * at], pairs[2u * at + 1u]);
        }
        if (appended == 0) {
            appended = spawn(system, chart); /* the other freed slot */
            appended_cursor = page.next;
        }
    }
    /* No position twice. */
    for (uint32_t a = 0; a < count; a += 1u) {
        for (uint32_t b = a + 1u; b < count; b += 1u) {
            CHECK(ta_actor_id_slot(seen[a]) != ta_actor_id_slot(seen[b]));
        }
    }
    /* Resident for the whole walk: exactly once. */
    for (uint32_t at = 0; at < 40u; at += 1u) {
        if (at != 3u && at != 25u) {
            CHECK(contains(seen, count, actors[at]));
        }
    }
    CHECK(contains(seen, count, visited));   /* seen before it was destroyed */
    CHECK(!contains(seen, count, ahead));    /* destroyed before the walk reached it */
    /* An actor spawned during the walk is visited exactly when its slot is at or after the cursor. */
    CHECK(contains(seen, count, reused) == (ta_actor_id_slot(reused) >= reused_cursor));
    CHECK(contains(seen, count, appended) ==
          (appended_cursor != TA_ACTOR_VISIT_END && ta_actor_id_slot(appended) >= appended_cursor));
    /* One of the two freed slots is behind the cursor, the other ahead of it. */
    CHECK(contains(seen, count, reused) != contains(seen, count, appended));
    finish_system(system);
}

int main(void) {
    test_pages_cover_the_population();
    test_exactly_full_last_page();
    test_empty_system();
    test_changes_between_pages();
    puts("enumerate_test passed");
    return 0;
}
