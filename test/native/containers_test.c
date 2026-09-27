/* The containers (ADR 0009): growth, wrapping, tombstones, reuse. */
#include <stdint.h>
#include <stdio.h>

#include "allocator.h"
#include "check.h"
#include "containers.h"

static tna_allocator allocator;

static ta_allocator other(void) {
    return tna_allocator_for(&allocator, TNA_MEMORY_OTHER);
}

static void vec_grows(void) {
    tna_vec vec;
    tna_vec_init(&vec, other(), TNA_LAYOUT(uint64_t));
    for (uint64_t i = 0; i < 1000; i += 1) {
        CHECK(tna_vec_push(&vec, &i) == TA_OK);
    }
    CHECK(vec.count == 1000);
    CHECK(vec.capacity >= 1000);
    for (uint32_t i = 0; i < 1000; i += 1) {
        CHECK(*(uint64_t *)tna_vec_at(&vec, i) == i);
    }
    tna_slice slice = tna_vec_slice(&vec);
    CHECK(slice.len == 1000 && ((const uint64_t *)slice.ptr)[999] == 999);
    tna_vec_destroy(&vec);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

static void ring_keeps_fifo_order_across_chunks(void) {
    tna_ring ring;
    tna_ring_init(&ring, other(), (tna_ring_shape){ .layout = TNA_LAYOUT(uint32_t), .chunk_capacity = 4 });
    uint32_t next_in = 0;
    uint32_t next_out = 0;
    /* Uneven pushes and pops wrap through many chunks. */
    for (int round = 0; round < 200; round += 1) {
        for (int i = 0; i < 7; i += 1) {
            CHECK(tna_ring_push(&ring, &next_in) == TA_OK);
            next_in += 1;
        }
        for (int i = 0; i < 5; i += 1) {
            CHECK(*(uint32_t *)tna_ring_front(&ring) == next_out);
            uint32_t value = 0;
            CHECK(tna_ring_pop(&ring, &value));
            CHECK(value == next_out);
            next_out += 1;
        }
    }
    CHECK(tna_ring_count(&ring) == next_in - next_out);
    uint32_t value = 0;
    while (tna_ring_pop(&ring, &value)) {
        CHECK(value == next_out);
        next_out += 1;
    }
    CHECK(next_out == next_in);
    CHECK(tna_ring_front(&ring) == NULL);
    tna_ring_destroy(&ring);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

static void ring_reuses_its_spare_chunk(void) {
    tna_ring ring;
    tna_ring_init(&ring, other(), (tna_ring_shape){ .layout = TNA_LAYOUT(uint32_t), .chunk_capacity = 8 });
    uint32_t value = 7;
    CHECK(tna_ring_push(&ring, &value) == TA_OK);
    CHECK(tna_ring_pop(&ring, &value));
    /* A queue that fills and drains within one chunk allocates nothing more. */
    uint64_t before = tna_allocator_calls(&allocator);
    for (int round = 0; round < 100; round += 1) {
        for (uint32_t i = 0; i < 8; i += 1) {
            CHECK(tna_ring_push(&ring, &i) == TA_OK);
        }
        while (tna_ring_pop(&ring, &value)) {
        }
    }
    CHECK(tna_allocator_calls(&allocator) == before);
    tna_ring_destroy(&ring);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

static void map_deletes_with_tombstones(void) {
    tna_map map;
    tna_map_init(&map, other());
    for (uint64_t key = 1; key <= 1000; key += 1) {
        CHECK(tna_map_put(&map, key, key * 10) == TA_OK);
    }
    CHECK(tna_map_count(&map) == 1000);
    CHECK(tna_map_put(&map, 5, 55) == TA_OK); /* replace */
    uint64_t value = 0;
    CHECK(tna_map_get(&map, 5, &value) && value == 55);
    CHECK(tna_map_count(&map) == 1000);

    for (uint64_t key = 1; key <= 1000; key += 2) {
        CHECK(tna_map_remove(&map, key));
    }
    CHECK(!tna_map_remove(&map, 1));
    CHECK(tna_map_count(&map) == 500);
    CHECK(tna_map_tombstones(&map) == 500);
    for (uint64_t key = 1; key <= 1000; key += 1) {
        /* Probes pass tombstones to reach the keys behind them. */
        CHECK(tna_map_get(&map, key, &value) == (key % 2 == 0));
        if (key % 2 == 0) {
            CHECK(value == (key == 5 ? 55 : key * 10));
        }
    }

    /* Reinserting reuses tombstones; churn never lets them fill the table. */
    for (int round = 0; round < 20; round += 1) {
        for (uint64_t key = 2001; key <= 2400; key += 1) {
            CHECK(tna_map_put(&map, key, key) == TA_OK);
        }
        for (uint64_t key = 2001; key <= 2400; key += 1) {
            CHECK(tna_map_remove(&map, key));
        }
    }
    CHECK(tna_map_count(&map) == 500);
    CHECK((uint64_t)(tna_map_count(&map) + tna_map_tombstones(&map)) * 4u <= (uint64_t)map.capacity * 3u);
    CHECK(tna_map_get(&map, 1000, &value) && value == 10000);
    CHECK(!tna_map_get(&map, 2001, &value));
    /* Iteration visits every live entry once and skips tombstones. */
    uint32_t cursor = 0;
    uint32_t seen = 0;
    uint64_t key = 0;
    while (tna_map_next(&map, &cursor, &key, &value)) {
        CHECK(tna_map_get(&map, key, NULL));
        seen += 1u;
    }
    CHECK(seen == tna_map_count(&map));
    tna_map_destroy(&map);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

typedef struct {
    uint64_t a;
    uint64_t b;
} record;

static void free_list_reuses_records(void) {
    tna_free_list list;
    tna_free_list_init(&list, tna_allocator_for(&allocator, TNA_MEMORY_ENVELOPES), TNA_LAYOUT(record));
    record *taken[10];
    for (int i = 0; i < 10; i += 1) {
        taken[i] = tna_free_list_take(&list);
        CHECK(taken[i] != NULL);
        taken[i]->a = (uint64_t)i;
    }
    CHECK(list.live_count == 10);
    for (int i = 0; i < 10; i += 1) {
        tna_free_list_give(&list, taken[i]);
    }
    CHECK(list.free_count >= 10 && list.live_count == 0);

    /* Taking again reuses the records: no allocator call. */
    uint64_t before = tna_allocator_calls(&allocator);
    for (int round = 0; round < 100; round += 1) {
        for (int i = 0; i < 10; i += 1) {
            taken[i] = tna_free_list_take(&list);
        }
        for (int i = 0; i < 10; i += 1) {
            tna_free_list_give(&list, taken[i]);
        }
    }
    CHECK(tna_allocator_calls(&allocator) == before);

    tna_free_list_destroy(&list);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

/* A burst of records costs a chunk per up-to-1024 records, not a call each,
 * and records from one chunk never overlap. */
static void free_list_allocates_in_chunks(void) {
    enum { N = 10000 };
    static record *taken[N];
    tna_free_list list;
    tna_free_list_init(&list, tna_allocator_for(&allocator, TNA_MEMORY_ENVELOPES), TNA_LAYOUT(record));
    uint64_t before = tna_allocator_calls(&allocator);
    for (int i = 0; i < N; i += 1) {
        taken[i] = tna_free_list_take(&list);
        CHECK(taken[i] != NULL);
        CHECK(((uintptr_t)taken[i] & (_Alignof(record) - 1u)) == 0);
        taken[i]->a = (uint64_t)i;
        taken[i]->b = ~(uint64_t)i;
    }
    uint64_t calls = tna_allocator_calls(&allocator) - before;
    CHECK(calls < N / 100);
    for (int i = 0; i < N; i += 1) {
        CHECK(taken[i]->a == (uint64_t)i && taken[i]->b == ~(uint64_t)i);
    }
    for (int i = 0; i < N; i += 1) {
        tna_free_list_give(&list, taken[i]);
    }
    CHECK(list.live_count == 0);
    tna_free_list_destroy(&list);
    CHECK(tna_allocator_total(&allocator).bytes_in_use == 0);
}

int main(void) {
    tna_allocator_init(&allocator);
    vec_grows();
    ring_keeps_fifo_order_across_chunks();
    ring_reuses_its_spare_chunk();
    map_deletes_with_tombstones();
    free_list_reuses_records();
    free_list_allocates_in_chunks();
    /* Accounting balances to zero over everything above. */
    tna_memory_counters total = tna_allocator_total(&allocator);
    CHECK(total.bytes_in_use == 0);
    CHECK(total.allocations == total.frees);
    puts("containers_test passed");
    return 0;
}
