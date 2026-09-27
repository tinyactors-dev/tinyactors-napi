/* The native system: create, close and free without leaks (ADR 0012). */
#include "check.h"
#include "system.h"

static void closes_without_leaks(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    CHECK(system != NULL);
    CHECK(!tna_system_closed(system));
    /* Core allocated its system through the core lane. */
    CHECK(tna_allocator_counters(&system->allocator, TNA_MEMORY_CORE).bytes_in_use > 0);

    tna_system_close(system);
    CHECK(tna_system_closed(system));
    CHECK(system->core == NULL);
    CHECK(tna_allocator_total(&system->allocator).bytes_in_use == 0);
    CHECK(tna_system_leaked_bytes(system) == 0);

    /* Close is idempotent. */
    tna_system_close(system);
    CHECK(tna_system_leaked_bytes(system) == 0);
    tna_system_free(system);
}

static void frees_an_open_system(void) {
    tna_system *system = NULL;
    CHECK(tna_system_create(&system) == TA_OK);
    tna_system_free(system); /* closes first */
}

static void many_systems_in_any_order(void) {
    enum { COUNT = 64 };
    tna_system *systems[COUNT];
    for (int index = 0; index < COUNT; index += 1) {
        CHECK(tna_system_create(&systems[index]) == TA_OK);
    }
    /* Close the odd ones, then free everything from the back. */
    for (int index = 1; index < COUNT; index += 2) {
        tna_system_close(systems[index]);
        CHECK(tna_system_leaked_bytes(systems[index]) == 0);
    }
    for (int index = COUNT - 1; index >= 0; index -= 1) {
        tna_system_close(systems[index]);
        CHECK(tna_system_leaked_bytes(systems[index]) == 0);
        tna_system_free(systems[index]);
    }
}

static void rejects_null(void) {
    CHECK(tna_system_create(NULL) == TA_ERR_INVALID);
    tna_system_close(NULL);
    tna_system_free(NULL);
    CHECK(tna_system_closed(NULL));
}

int main(void) {
    closes_without_leaks();
    frees_an_open_system();
    many_systems_in_any_order();
    rejects_null();
    puts("system_test passed");
    return 0;
}
