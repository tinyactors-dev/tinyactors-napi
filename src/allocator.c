#include "allocator.h"

#include <stdlib.h>

/* Block size of the turn and call arenas; an arena grows past it on demand. */
#define TNA_SCRATCH_BLOCK_BYTES ((size_t)16384)

static int tna_valid_alignment(size_t alignment) {
    return alignment != 0 && (alignment & (alignment - 1u)) == 0;
}

static void *tna_system_alloc(size_t size, size_t alignment) {
    if (alignment <= _Alignof(max_align_t)) {
        return malloc(size);
    }
    /* aligned_alloc wants a size that is a multiple of the alignment. */
    if (size > SIZE_MAX - (alignment - 1u)) {
        return NULL;
    }
    size_t rounded = (size + alignment - 1u) & ~(alignment - 1u);
    return aligned_alloc(alignment, rounded);
}

static void *tna_lane_alloc(void *self, size_t size, size_t alignment) {
    tna_allocator_lane *lane = self;
    if (size == 0 || !tna_valid_alignment(alignment)) {
        return NULL;
    }
    if (lane->owner->refuse_from != 0 && size >= lane->owner->refuse_from) {
        return NULL;
    }
    void *ptr = tna_system_alloc(size, alignment);
    if (ptr == NULL) {
        return NULL;
    }
    tna_memory_counters *counters = &lane->owner->counters[lane->category];
    counters->bytes_in_use += size;
    counters->allocations += 1u;
    if (counters->bytes_in_use > counters->peak_bytes) {
        counters->peak_bytes = counters->bytes_in_use;
    }
    if (size > counters->largest_block) {
        counters->largest_block = size;
    }
    return ptr;
}

static void tna_lane_free(void *self, const ta_allocator_free_params *params) {
    tna_allocator_lane *lane = self;
    if (params == NULL || params->ptr == NULL) {
        return;
    }
    free(params->ptr);
    tna_memory_counters *counters = &lane->owner->counters[lane->category];
    counters->bytes_in_use -= params->size;
    counters->frees += 1u;
}

static const ta_allocator_vtable tna_lane_vtable = {
    .alloc = tna_lane_alloc,
    .free = tna_lane_free,
};

void tna_allocator_refuse_from(tna_allocator *allocator, size_t bytes) {
    allocator->refuse_from = bytes;
}

void tna_allocator_init(tna_allocator *allocator) {
    *allocator = (tna_allocator){0};
    for (int category = 0; category < TNA_MEMORY_CATEGORY_COUNT; category += 1) {
        allocator->lanes[category] = (tna_allocator_lane){
            .owner = allocator,
            .category = (tna_memory_category)category,
        };
    }
}

ta_allocator tna_allocator_for(tna_allocator *allocator, tna_memory_category category) {
    return (ta_allocator){ .self = &allocator->lanes[category], .v = &tna_lane_vtable };
}

tna_memory_counters tna_allocator_counters(const tna_allocator *allocator, tna_memory_category category) {
    return allocator->counters[category];
}

tna_memory_counters tna_allocator_total(const tna_allocator *allocator) {
    tna_memory_counters total = {0};
    for (int category = 0; category < TNA_MEMORY_CATEGORY_COUNT; category += 1) {
        const tna_memory_counters *counters = &allocator->counters[category];
        total.bytes_in_use += counters->bytes_in_use;
        total.peak_bytes += counters->peak_bytes;
        if (counters->largest_block > total.largest_block) {
            total.largest_block = counters->largest_block;
        }
        total.allocations += counters->allocations;
        total.frees += counters->frees;
    }
    return total;
}

uint64_t tna_allocator_calls(const tna_allocator *allocator) {
    tna_memory_counters total = tna_allocator_total(allocator);
    return total.allocations + total.frees;
}

void *tna_alloc(ta_allocator allocator, size_t size, size_t alignment) {
    if (allocator.v == NULL || allocator.v->alloc == NULL) {
        return NULL;
    }
    return allocator.v->alloc(allocator.self, size, alignment);
}

void tna_free(ta_allocator allocator, const ta_allocator_free_params *params) {
    if (params == NULL || params->ptr == NULL || allocator.v == NULL || allocator.v->free == NULL) {
        return;
    }
    allocator.v->free(allocator.self, params);
}

ta_result tna_scratch_init(tna_scratch *scratch, tna_allocator *allocator) {
    ta_allocator backing = tna_allocator_for(allocator, TNA_MEMORY_SCRATCH);
    *scratch = (tna_scratch){0};
    ta_result result = ta_arena_init(&scratch->turn, backing, TNA_SCRATCH_BLOCK_BYTES);
    if (result == TA_OK) {
        result = ta_arena_init(&scratch->call, backing, TNA_SCRATCH_BLOCK_BYTES);
    }
    if (result != TA_OK) {
        ta_arena_destroy(&scratch->turn);
    }
    return result;
}

void tna_scratch_reset_turn(tna_scratch *scratch) {
    ta_arena_reset(&scratch->turn);
}

void tna_scratch_reset_call(tna_scratch *scratch) {
    ta_arena_reset(&scratch->call);
}

void tna_scratch_destroy(tna_scratch *scratch) {
    ta_arena_destroy(&scratch->turn);
    ta_arena_destroy(&scratch->call);
}
