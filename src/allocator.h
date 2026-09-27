#pragma once
/*
 * The system's memory (ADR 0014, ADR 0009).
 *
 * One counting allocator per system, over malloc. It is the system's one
 * ta_allocator, and it is also handed to core. Every allocation names a
 * category, so stats() can say what the addon's memory is for. `free`
 * receives the size and alignment, so the counters need no header.
 *
 * Scratch memory is core's ta_arena over this allocator: a turn arena reset at
 * the end of each pump turn, and a call arena reset after each call. They are
 * reset, not destroyed, so after warm-up they allocate nothing.
 *
 * Size-class pools are deferred (ADR 0014, point 5). If a measurement asks for
 * them, they replace malloc behind tna_alloc and tna_free and nothing else
 * changes.
 *
 * A system is used by one thread (ADR 0001): nothing here locks.
 */
#include <stddef.h>
#include <stdint.h>

#include "tinyactors.h"

typedef enum {
    TNA_MEMORY_CORE = 0,   /* everything core allocates */
    TNA_MEMORY_ENVELOPES,  /* mailbox envelopes (ADR 0005) */
    TNA_MEMORY_SCHEDULING, /* the scheduling table and queues (ADR 0005) */
    TNA_MEMORY_VALUES,     /* value boxes (ADR 0011) */
    TNA_MEMORY_DIRECTORY,  /* the actor directory (ADR 0006) */
    TNA_MEMORY_SCRATCH,    /* the turn and call arenas */
    TNA_MEMORY_OTHER,      /* everything else the addon keeps */
    TNA_MEMORY_CATEGORY_COUNT
} tna_memory_category;

typedef struct {
    size_t bytes_in_use;
    size_t peak_bytes;    /* the high-water mark of bytes_in_use */
    size_t largest_block; /* the largest single allocation so far */
    uint64_t allocations; /* successful allocator calls */
    uint64_t frees;
} tna_memory_counters;

typedef struct tna_allocator tna_allocator;

/* What a category's ta_allocator points at: the owner and the category. */
typedef struct {
    tna_allocator *owner;
    tna_memory_category category;
} tna_allocator_lane;

struct tna_allocator {
    tna_allocator_lane lanes[TNA_MEMORY_CATEGORY_COUNT];
    tna_memory_counters counters[TNA_MEMORY_CATEGORY_COUNT];
    /* Tests only: refuse every allocation of at least this many bytes; 0 refuses none. */
    size_t refuse_from;
};

void tna_allocator_init(tna_allocator *allocator);
/* A ta_allocator whose allocations count against `category`. */
ta_allocator tna_allocator_for(tna_allocator *allocator, tna_memory_category category);
tna_memory_counters tna_allocator_counters(const tna_allocator *allocator, tna_memory_category category);
/* The sum over every category; peak_bytes is the sum of the peaks, and
 * largest_block the largest of any category. */
tna_memory_counters tna_allocator_total(const tna_allocator *allocator);
/* Allocations plus frees, over every category: the steady-state test signal. */
uint64_t tna_allocator_calls(const tna_allocator *allocator);
/*
 * Tests only: from now on, refuse every allocation of at least `bytes`, in
 * every category, as a full pool would; 0 refuses none again. A size, not a
 * count, names the allocation to fail, so a test can fail one large
 * allocation without depending on how many small ones come before it.
 */
void tna_allocator_refuse_from(tna_allocator *allocator, size_t bytes);

/*
 * Convenience over a ta_allocator (a lane or any other). A zero size or an
 * alignment that is not a power of two yields NULL.
 */
void *tna_alloc(ta_allocator allocator, size_t size, size_t alignment);
void tna_free(ta_allocator allocator, const ta_allocator_free_params *params);

/* The turn and call arenas. */
typedef struct {
    ta_arena turn;
    ta_arena call;
} tna_scratch;

ta_result tna_scratch_init(tna_scratch *scratch, tna_allocator *allocator);
void tna_scratch_reset_turn(tna_scratch *scratch);
void tna_scratch_reset_call(tna_scratch *scratch);
void tna_scratch_destroy(tna_scratch *scratch);
