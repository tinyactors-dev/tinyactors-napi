/* The counting allocator and the scratch arenas (ADR 0014). */
#include <stdint.h>
#include <stdio.h>

#include "allocator.h"
#include "check.h"

static void counts_by_category(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    ta_allocator envelopes = tna_allocator_for(&allocator, TNA_MEMORY_ENVELOPES);
    ta_allocator values = tna_allocator_for(&allocator, TNA_MEMORY_VALUES);

    void *a = tna_alloc(envelopes, 48, 8);
    void *b = tna_alloc(envelopes, 16, 8);
    void *c = tna_alloc(values, 32, 16);
    CHECK(a != NULL && b != NULL && c != NULL);
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_ENVELOPES).bytes_in_use == 64);
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_ENVELOPES).allocations == 2);
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_VALUES).bytes_in_use == 32);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 96);
    CHECK(tna_allocator_calls(&allocator) == 3);

    tna_free(envelopes, &(ta_allocator_free_params){ .ptr = a, .size = 48, .alignment = 8 });
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_ENVELOPES).bytes_in_use == 16);
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_ENVELOPES).peak_bytes == 64);
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_ENVELOPES).largest_block == 48);
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_VALUES).largest_block == 32);
    CHECK(tna_allocator_total(&allocator).largest_block == 48);
    tna_free(envelopes, &(ta_allocator_free_params){ .ptr = b, .size = 16, .alignment = 8 });
    tna_free(values, &(ta_allocator_free_params){ .ptr = c, .size = 32, .alignment = 16 });

    /* Accounting balances to zero. */
    tna_memory_counters total = tna_allocator_total(&allocator);
    CHECK(total.bytes_in_use == 0);
    CHECK(total.allocations == total.frees);
    CHECK(tna_allocator_calls(&allocator) == 6);
}

static void honours_alignment(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    ta_allocator other = tna_allocator_for(&allocator, TNA_MEMORY_OTHER);
    void *wide = tna_alloc(other, 100, 64);
    CHECK(wide != NULL);
    CHECK(((uintptr_t)wide & 63u) == 0);
    CHECK(tna_alloc(other, 0, 8) == NULL);
    CHECK(tna_alloc(other, 8, 3) == NULL);
    tna_free(other, &(ta_allocator_free_params){ .ptr = wide, .size = 100, .alignment = 64 });
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
    /* Refused requests are not counted. */
    CHECK(tna_allocator_calls(&allocator) == 2);
}

static void reset_arenas_make_no_allocator_call(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    tna_scratch scratch;
    CHECK(tna_scratch_init(&scratch, &allocator) == TA_OK);

    for (int round = 0; round < 3; round += 1) {
        uint64_t before = tna_allocator_calls(&allocator);
        for (int i = 0; i < 100; i += 1) {
            CHECK(ta_arena_alloc(&scratch.turn, 200, 8) != NULL);
            CHECK(ta_arena_alloc(&scratch.call, 50, 16) != NULL);
        }
        uint64_t after = tna_allocator_calls(&allocator);
        if (round > 0) {
            /* After warm-up, the same work reuses the arenas' blocks. */
            CHECK(after == before);
        }
        tna_scratch_reset_turn(&scratch);
        tna_scratch_reset_call(&scratch);
    }
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_SCRATCH).bytes_in_use > 0);
    tna_scratch_destroy(&scratch);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

static void backs_a_core_system(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    ta_system *system = NULL;
    ta_system_config config = { .allocator = tna_allocator_for(&allocator, TNA_MEMORY_CORE), .initial_time = 0 };
    CHECK(ta_system_create(&config, &system) == TA_OK);
    CHECK(tna_allocator_counters(&allocator, TNA_MEMORY_CORE).bytes_in_use > 0);
    ta_system_destroy(system);
    tna_memory_counters core = tna_allocator_counters(&allocator, TNA_MEMORY_CORE);
    CHECK(core.bytes_in_use == 0);
    CHECK(core.allocations == core.frees);
}

/* The test switch refuses allocations from a size on, and counts none of them. */
static void refuses_from_a_size(void) {
    tna_allocator allocator;
    tna_allocator_init(&allocator);
    ta_allocator core = tna_allocator_for(&allocator, TNA_MEMORY_CORE);
    tna_allocator_refuse_from(&allocator, 1024);
    void *small = tna_alloc(core, 1023, 8);
    CHECK(small != NULL);
    CHECK(tna_alloc(core, 1024, 8) == NULL);
    CHECK(tna_alloc(tna_allocator_for(&allocator, TNA_MEMORY_VALUES), 4096, 8) == NULL);
    CHECK(tna_allocator_calls(&allocator) == 1);
    tna_allocator_refuse_from(&allocator, 0);
    void *large = tna_alloc(core, 4096, 8);
    CHECK(large != NULL);
    tna_free(core, &(ta_allocator_free_params){ .ptr = small, .size = 1023, .alignment = 8 });
    tna_free(core, &(ta_allocator_free_params){ .ptr = large, .size = 4096, .alignment = 8 });
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

int main(void) {
    counts_by_category();
    refuses_from_a_size();
    honours_alignment();
    reset_arenas_make_no_allocator_call();
    backs_a_core_system();
    puts("allocator_test passed");
    return 0;
}
