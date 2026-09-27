#include "containers.h"

#include <string.h>

#include "allocator.h"

static size_t tna_round_up(size_t value, size_t alignment) {
    return (value + alignment - 1u) & ~(alignment - 1u);
}

static size_t tna_stride(tna_layout layout) {
    return tna_round_up(layout.size, layout.alignment);
}

static void tna_release(ta_allocator allocator, void *ptr, tna_layout layout) {
    tna_free(allocator, &(ta_allocator_free_params){ .ptr = ptr, .size = layout.size, .alignment = layout.alignment });
}

/* ------------------------------------------------------------------ vec */

void tna_vec_init(tna_vec *vec, ta_allocator allocator, tna_layout layout) {
    *vec = (tna_vec){ .allocator = allocator, .layout = layout };
}

static tna_layout tna_vec_block(const tna_vec *vec, uint32_t capacity) {
    return (tna_layout){ .size = tna_stride(vec->layout) * capacity, .alignment = vec->layout.alignment };
}

ta_result tna_vec_reserve(tna_vec *vec, uint32_t count) {
    if (count <= vec->capacity) {
        return TA_OK;
    }
    uint32_t capacity = vec->capacity == 0 ? 8u : vec->capacity;
    while (capacity < count) {
        if (capacity > UINT32_MAX / 2u) {
            return TA_ERR_NOMEM;
        }
        capacity *= 2u;
    }
    tna_layout block = tna_vec_block(vec, capacity);
    void *items = tna_alloc(vec->allocator, block.size, block.alignment);
    if (items == NULL) {
        return TA_ERR_NOMEM;
    }
    if (vec->count != 0) {
        memcpy(items, vec->items, tna_stride(vec->layout) * vec->count);
    }
    if (vec->items != NULL) {
        tna_release(vec->allocator, vec->items, tna_vec_block(vec, vec->capacity));
    }
    vec->items = items;
    vec->capacity = capacity;
    return TA_OK;
}

ta_result tna_vec_push(tna_vec *vec, const void *element) {
    if (vec->count == UINT32_MAX) {
        return TA_ERR_NOMEM;
    }
    ta_result result = tna_vec_reserve(vec, vec->count + 1u);
    if (result != TA_OK) {
        return result;
    }
    memcpy(tna_vec_at(vec, vec->count), element, vec->layout.size);
    vec->count += 1u;
    return TA_OK;
}

void *tna_vec_at(const tna_vec *vec, uint32_t index) {
    return (unsigned char *)vec->items + tna_stride(vec->layout) * index;
}

void tna_vec_clear(tna_vec *vec) {
    vec->count = 0;
}

tna_slice tna_vec_slice(const tna_vec *vec) {
    return (tna_slice){ .ptr = vec->items, .len = vec->count };
}

void tna_vec_destroy(tna_vec *vec) {
    if (vec->items != NULL) {
        tna_release(vec->allocator, vec->items, tna_vec_block(vec, vec->capacity));
    }
    tna_vec_init(vec, vec->allocator, vec->layout);
}

/* ----------------------------------------------------------------- ring */

struct tna_ring_chunk {
    tna_ring_chunk *next;
};

static size_t tna_ring_data_offset(const tna_ring *ring) {
    return tna_round_up(sizeof(tna_ring_chunk), ring->shape.layout.alignment);
}

static tna_layout tna_ring_chunk_layout(const tna_ring *ring) {
    size_t alignment = ring->shape.layout.alignment > _Alignof(tna_ring_chunk) ? ring->shape.layout.alignment
                                                                               : _Alignof(tna_ring_chunk);
    return (tna_layout){
        .size = tna_ring_data_offset(ring) + tna_stride(ring->shape.layout) * ring->shape.chunk_capacity,
        .alignment = alignment,
    };
}

static void *tna_ring_slot(const tna_ring *ring, tna_ring_chunk *chunk, uint32_t index) {
    return (unsigned char *)chunk + tna_ring_data_offset(ring) + tna_stride(ring->shape.layout) * index;
}

void tna_ring_init(tna_ring *ring, ta_allocator allocator, tna_ring_shape shape) {
    if (shape.chunk_capacity == 0) {
        shape.chunk_capacity = 1;
    }
    *ring = (tna_ring){ .allocator = allocator, .shape = shape };
}

static tna_ring_chunk *tna_ring_take_chunk(tna_ring *ring) {
    tna_ring_chunk *chunk = ring->spare;
    if (chunk != NULL) {
        ring->spare = NULL;
    } else {
        tna_layout layout = tna_ring_chunk_layout(ring);
        chunk = tna_alloc(ring->allocator, layout.size, layout.alignment);
        if (chunk == NULL) {
            return NULL;
        }
    }
    chunk->next = NULL;
    return chunk;
}

/* Keeps the first chunk that empties as the spare and frees the rest. */
static void tna_ring_drop_chunk(tna_ring *ring, tna_ring_chunk *chunk) {
    if (ring->spare == NULL) {
        ring->spare = chunk;
        return;
    }
    tna_release(ring->allocator, chunk, tna_ring_chunk_layout(ring));
}

ta_result tna_ring_push(tna_ring *ring, const void *element) {
    if (ring->count == UINT32_MAX) {
        return TA_ERR_NOMEM;
    }
    if (ring->tail == NULL || ring->tail_index == ring->shape.chunk_capacity) {
        tna_ring_chunk *chunk = tna_ring_take_chunk(ring);
        if (chunk == NULL) {
            return TA_ERR_NOMEM;
        }
        if (ring->tail == NULL) {
            ring->head = chunk;
            ring->head_index = 0;
        } else {
            ring->tail->next = chunk;
        }
        ring->tail = chunk;
        ring->tail_index = 0;
    }
    memcpy(tna_ring_slot(ring, ring->tail, ring->tail_index), element, ring->shape.layout.size);
    ring->tail_index += 1u;
    ring->count += 1u;
    return TA_OK;
}

void *tna_ring_front(const tna_ring *ring) {
    return ring->count == 0 ? NULL : tna_ring_slot(ring, ring->head, ring->head_index);
}

bool tna_ring_pop(tna_ring *ring, void *out) {
    if (ring->count == 0) {
        return false;
    }
    if (out != NULL) {
        memcpy(out, tna_ring_slot(ring, ring->head, ring->head_index), ring->shape.layout.size);
    }
    ring->head_index += 1u;
    ring->count -= 1u;
    if (ring->count == 0) {
        tna_ring_drop_chunk(ring, ring->head);
        ring->head = NULL;
        ring->tail = NULL;
        ring->head_index = 0;
        ring->tail_index = 0;
    } else if (ring->head_index == ring->shape.chunk_capacity) {
        tna_ring_chunk *drained = ring->head;
        ring->head = drained->next;
        ring->head_index = 0;
        tna_ring_drop_chunk(ring, drained);
    }
    return true;
}

uint32_t tna_ring_count(const tna_ring *ring) {
    return ring->count;
}

void tna_ring_destroy(tna_ring *ring) {
    tna_layout layout = tna_ring_chunk_layout(ring);
    tna_ring_chunk *chunk = ring->head;
    while (chunk != NULL) {
        tna_ring_chunk *next = chunk->next;
        tna_release(ring->allocator, chunk, layout);
        chunk = next;
    }
    if (ring->spare != NULL) {
        tna_release(ring->allocator, ring->spare, layout);
    }
    tna_ring_init(ring, ring->allocator, ring->shape);
}

/* ------------------------------------------------------------------ map */

enum { TNA_MAP_EMPTY = 0, TNA_MAP_FULL = 1, TNA_MAP_TOMBSTONE = 2 };

/* splitmix64's finalizer: sequential keys (slots, pointers) spread well. */
static uint64_t tna_map_hash(uint64_t key) {
    key ^= key >> 30;
    key *= 0xbf58476d1ce4e5b9u;
    key ^= key >> 27;
    key *= 0x94d049bb133111ebu;
    key ^= key >> 31;
    return key;
}

static tna_layout tna_map_block(uint32_t capacity) {
    return (tna_layout){ .size = (size_t)capacity * (2u * sizeof(uint64_t) + 1u), .alignment = _Alignof(uint64_t) };
}

void tna_map_init(tna_map *map, ta_allocator allocator) {
    *map = (tna_map){ .allocator = allocator };
}

/* The slot holding `key`, or UINT32_MAX. */
static uint32_t tna_map_find(const tna_map *map, uint64_t key) {
    if (map->capacity == 0) {
        return UINT32_MAX;
    }
    uint32_t mask = map->capacity - 1u;
    for (uint32_t probe = 0, slot = (uint32_t)tna_map_hash(key) & mask; probe < map->capacity;
         probe += 1, slot = (slot + 1u) & mask) {
        if (map->states[slot] == TNA_MAP_EMPTY) {
            return UINT32_MAX;
        }
        if (map->states[slot] == TNA_MAP_FULL && map->keys[slot] == key) {
            return slot;
        }
    }
    return UINT32_MAX;
}

/* Places a key known to be absent into a table with no tombstones. */
static void tna_map_place(tna_map *map, uint64_t key, uint64_t value) {
    uint32_t mask = map->capacity - 1u;
    uint32_t slot = (uint32_t)tna_map_hash(key) & mask;
    while (map->states[slot] == TNA_MAP_FULL) {
        slot = (slot + 1u) & mask;
    }
    map->keys[slot] = key;
    map->values[slot] = value;
    map->states[slot] = TNA_MAP_FULL;
    map->count += 1u;
}

/* Rebuilds the table at `capacity`, which also clears every tombstone. */
static ta_result tna_map_rehash(tna_map *map, uint32_t capacity) {
    tna_layout block = tna_map_block(capacity);
    unsigned char *memory = tna_alloc(map->allocator, block.size, block.alignment);
    if (memory == NULL) {
        return TA_ERR_NOMEM;
    }
    tna_map old = *map;
    map->keys = (uint64_t *)memory;
    map->values = map->keys + capacity;
    map->states = (uint8_t *)(map->values + capacity);
    memset(map->states, TNA_MAP_EMPTY, capacity);
    map->capacity = capacity;
    map->count = 0;
    map->tombstones = 0;
    for (uint32_t slot = 0; slot < old.capacity; slot += 1) {
        if (old.states[slot] == TNA_MAP_FULL) {
            tna_map_place(map, old.keys[slot], old.values[slot]);
        }
    }
    if (old.keys != NULL) {
        tna_release(map->allocator, old.keys, tna_map_block(old.capacity));
    }
    return TA_OK;
}

ta_result tna_map_put(tna_map *map, uint64_t key, uint64_t value) {
    uint32_t found = tna_map_find(map, key);
    if (found != UINT32_MAX) {
        map->values[found] = value;
        return TA_OK;
    }
    /* Keep live entries and tombstones under 3/4; a rebuild leaves live
     * entries at most half the table. */
    if ((uint64_t)(map->count + map->tombstones + 1u) * 4u > (uint64_t)map->capacity * 3u) {
        uint32_t capacity = map->capacity == 0 ? 16u : map->capacity;
        while ((uint64_t)(map->count + 1u) * 2u > capacity) {
            if (capacity > UINT32_MAX / 2u) {
                return TA_ERR_NOMEM;
            }
            capacity *= 2u;
        }
        ta_result result = tna_map_rehash(map, capacity);
        if (result != TA_OK) {
            return result;
        }
    }
    uint32_t mask = map->capacity - 1u;
    uint32_t slot = (uint32_t)tna_map_hash(key) & mask;
    while (map->states[slot] == TNA_MAP_FULL) {
        slot = (slot + 1u) & mask;
    }
    if (map->states[slot] == TNA_MAP_TOMBSTONE) {
        map->tombstones -= 1u;
    }
    map->keys[slot] = key;
    map->values[slot] = value;
    map->states[slot] = TNA_MAP_FULL;
    map->count += 1u;
    return TA_OK;
}

bool tna_map_get(const tna_map *map, uint64_t key, uint64_t *out) {
    uint32_t slot = tna_map_find(map, key);
    if (slot == UINT32_MAX) {
        return false;
    }
    if (out != NULL) {
        *out = map->values[slot];
    }
    return true;
}

bool tna_map_remove(tna_map *map, uint64_t key) {
    uint32_t slot = tna_map_find(map, key);
    if (slot == UINT32_MAX) {
        return false;
    }
    map->states[slot] = TNA_MAP_TOMBSTONE;
    map->count -= 1u;
    map->tombstones += 1u;
    return true;
}

bool tna_map_next(const tna_map *map, uint32_t *cursor, uint64_t *key, uint64_t *value) {
    while (*cursor < map->capacity) {
        uint32_t slot = *cursor;
        *cursor += 1u;
        if (map->states[slot] == TNA_MAP_FULL) {
            *key = map->keys[slot];
            *value = map->values[slot];
            return true;
        }
    }
    return false;
}

uint32_t tna_map_count(const tna_map *map) {
    return map->count;
}

uint32_t tna_map_tombstones(const tna_map *map) {
    return map->tombstones;
}

void tna_map_destroy(tna_map *map) {
    if (map->keys != NULL) {
        tna_release(map->allocator, map->keys, tna_map_block(map->capacity));
    }
    tna_map_init(map, map->allocator);
}

/* ------------------------------------------------------------ free list */

struct tna_free_record {
    tna_free_record *next;
};

struct tna_free_chunk {
    tna_free_chunk *next;
    size_t bytes; /* the whole allocation, header included */
};

#define TNA_FREE_CHUNK_MIN 8u
#define TNA_FREE_CHUNK_MAX 1024u

void tna_free_list_init(tna_free_list *list, ta_allocator allocator, tna_layout layout) {
    if (layout.size < sizeof(tna_free_record)) {
        layout.size = sizeof(tna_free_record);
    }
    if (layout.alignment < _Alignof(tna_free_record)) {
        layout.alignment = _Alignof(tna_free_record);
    }
    /* Records sit back to back in a chunk, so each size is a multiple of the alignment. */
    layout.size = (layout.size + layout.alignment - 1u) & ~(layout.alignment - 1u);
    *list = (tna_free_list){ .allocator = allocator, .layout = layout };
}

/* A chunk's alignment: its header's or its records', whichever is larger. */
static size_t tna_free_chunk_alignment(const tna_free_list *list) {
    return list->layout.alignment < _Alignof(tna_free_chunk) ? _Alignof(tna_free_chunk) : list->layout.alignment;
}

/* Where a chunk's first record starts: past the header, aligned. */
static size_t tna_free_chunk_offset(const tna_free_list *list) {
    size_t alignment = tna_free_chunk_alignment(list);
    return (sizeof(tna_free_chunk) + alignment - 1u) & ~(alignment - 1u);
}

/* Puts a new chunk's records on the list; false when allocation fails. */
static bool tna_free_list_grow(tna_free_list *list) {
    uint32_t count = list->live_count;
    if (count < TNA_FREE_CHUNK_MIN) {
        count = TNA_FREE_CHUNK_MIN;
    }
    if (count > TNA_FREE_CHUNK_MAX) {
        count = TNA_FREE_CHUNK_MAX;
    }
    size_t offset = tna_free_chunk_offset(list);
    size_t alignment = tna_free_chunk_alignment(list);
    size_t bytes = offset + (size_t)count * list->layout.size;
    tna_free_chunk *chunk = tna_alloc(list->allocator, bytes, alignment);
    if (chunk == NULL) {
        return false;
    }
    chunk->bytes = bytes;
    chunk->next = list->chunks;
    list->chunks = chunk;
    uint8_t *records = (uint8_t *)chunk + offset;
    for (uint32_t at = count; at > 0; at -= 1u) {
        tna_free_record *record = (tna_free_record *)(void *)(records + (size_t)(at - 1u) * list->layout.size);
        record->next = list->head;
        list->head = record;
    }
    list->free_count += count;
    return true;
}

void *tna_free_list_take(tna_free_list *list) {
    if (list->head == NULL && !tna_free_list_grow(list)) {
        return NULL;
    }
    tna_free_record *record = list->head;
    list->head = record->next;
    list->free_count -= 1u;
    list->live_count += 1u;
    return record;
}

void tna_free_list_give(tna_free_list *list, void *record) {
    if (record == NULL) {
        return;
    }
    tna_free_record *free_record = record;
    free_record->next = list->head;
    list->head = free_record;
    list->free_count += 1u;
    list->live_count -= 1u;
}

void tna_free_list_destroy(tna_free_list *list) {
    size_t alignment = tna_free_chunk_alignment(list);
    tna_free_chunk *chunk = list->chunks;
    while (chunk != NULL) {
        tna_free_chunk *next = chunk->next;
        tna_release(list->allocator, chunk, (tna_layout){ .size = chunk->bytes, .alignment = alignment });
        chunk = next;
    }
    list->chunks = NULL;
    list->head = NULL;
    list->free_count = 0;
}
