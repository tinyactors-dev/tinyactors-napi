#pragma once
/*
 * The addon's containers (ADR 0009). Queues, enumeration pages and tables use
 * these types and nothing else. Every one allocates through a ta_allocator,
 * normally a category of the system's counting allocator (ADR 0014).
 *
 * - vec: a growable array. It doubles, so it is for small or bounded things;
 *   a queue that can hold millions of entries is a ring.
 * - ring: a FIFO of fixed-size chunks. Growing never copies the queue, and an
 *   empty ring keeps one spare chunk so a queue that fills and drains does
 *   not allocate each time.
 * - map: open addressing, uint64_t keys and values, linear probing, deletion
 *   by tombstone.
 * - slice: a pointer and a length.
 * - free list: fixed-size records that are reused instead of freed.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tinyactors.h"

typedef struct {
    size_t size;
    size_t alignment;
} tna_layout;

#define TNA_LAYOUT(type) ((tna_layout){ .size = sizeof(type), .alignment = _Alignof(type) })

typedef struct {
    const void *ptr;
    uint32_t len;
} tna_slice;

/* ------------------------------------------------------------------ vec */

typedef struct {
    ta_allocator allocator;
    tna_layout layout;
    void *items;
    uint32_t count;
    uint32_t capacity;
} tna_vec;

void tna_vec_init(tna_vec *vec, ta_allocator allocator, tna_layout layout);
ta_result tna_vec_reserve(tna_vec *vec, uint32_t count);
ta_result tna_vec_push(tna_vec *vec, const void *element);
void *tna_vec_at(const tna_vec *vec, uint32_t index);
void tna_vec_clear(tna_vec *vec);
tna_slice tna_vec_slice(const tna_vec *vec);
void tna_vec_destroy(tna_vec *vec);

/* ----------------------------------------------------------------- ring */

typedef struct tna_ring_chunk tna_ring_chunk;

typedef struct {
    tna_layout layout;
    uint32_t chunk_capacity; /* elements per chunk */
} tna_ring_shape;

typedef struct {
    ta_allocator allocator;
    tna_ring_shape shape;
    tna_ring_chunk *head;
    tna_ring_chunk *tail;
    tna_ring_chunk *spare;
    uint32_t head_index; /* the first element's index in the head chunk */
    uint32_t tail_index; /* elements used in the tail chunk */
    uint32_t count;
} tna_ring;

void tna_ring_init(tna_ring *ring, ta_allocator allocator, tna_ring_shape shape);
ta_result tna_ring_push(tna_ring *ring, const void *element);
/* Copies the front element to `out` and removes it; false when empty. */
bool tna_ring_pop(tna_ring *ring, void *out);
/* The front element, or NULL when empty. */
void *tna_ring_front(const tna_ring *ring);
uint32_t tna_ring_count(const tna_ring *ring);
void tna_ring_destroy(tna_ring *ring);

/* ------------------------------------------------------------------ map */

typedef struct {
    ta_allocator allocator;
    uint64_t *keys;
    uint64_t *values;
    uint8_t *states;
    uint32_t capacity; /* a power of two, or 0 */
    uint32_t count;
    uint32_t tombstones;
} tna_map;

void tna_map_init(tna_map *map, ta_allocator allocator);
/* Inserts or replaces. TA_ERR_NOMEM leaves the map as it was. */
ta_result tna_map_put(tna_map *map, uint64_t key, uint64_t value);
bool tna_map_get(const tna_map *map, uint64_t key, uint64_t *out);
bool tna_map_remove(tna_map *map, uint64_t key);
/*
 * Iteration: start `*cursor` at 0; each true answer gives one live entry.
 * The map must not change during the walk.
 */
bool tna_map_next(const tna_map *map, uint32_t *cursor, uint64_t *key, uint64_t *value);
uint32_t tna_map_count(const tna_map *map);
uint32_t tna_map_tombstones(const tna_map *map);
void tna_map_destroy(tna_map *map);

/* ------------------------------------------------------------ free list */

typedef struct tna_free_record tna_free_record;
typedef struct tna_free_chunk tna_free_chunk;

/*
 * Records come from chunks, not one allocation each: an empty list takes a
 * chunk holding as many records as are live (at least 8, at most 1024), so
 * a burst of N records costs about N/1024 allocator calls, not N. Chunks
 * are kept until destroy, as single records on the list were before.
 */
typedef struct {
    ta_allocator allocator;
    tna_layout layout; /* at least a pointer, so a free record can link */
    tna_free_record *head;
    tna_free_chunk *chunks;
    uint32_t free_count;
    uint32_t live_count;
} tna_free_list;

void tna_free_list_init(tna_free_list *list, ta_allocator allocator, tna_layout layout);
/* A record from the list, or from a new chunk; NULL when allocation fails. */
void *tna_free_list_take(tna_free_list *list);
/* Returns a record taken from this list. */
void tna_free_list_give(tna_free_list *list, void *record);
/* Frees every chunk. Every record taken must have been given back first
 * (live_count is 0): a record still taken is freed with its chunk. */
void tna_free_list_destroy(tna_free_list *list);
