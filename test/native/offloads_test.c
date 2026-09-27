/*
 * The offload store (core ADR 0074): it keeps a copy of an actor's bytes
 * per address, owns the value handles it was given, and gives everything
 * back when an entry is dropped, replaced or the store destroyed.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "allocator.h"
#include "check.h"
#include "offloads.h"

static int live_references;

static void counted_retain(void *self) {
    (void)self;
    live_references += 1;
}

static void counted_release(void *self) {
    (void)self;
    live_references -= 1;
}

static const ta_value_vtable counted = { .retain = counted_retain, .release = counted_release };

/* An array of `count` handles, each holding one reference, in the store's allocator. */
static ta_value *handles(ta_allocator allocator, uint32_t count) {
    ta_value *array = tna_alloc(allocator, (size_t)count * sizeof(ta_value), _Alignof(ta_value));
    CHECK(array != NULL);
    for (uint32_t index = 0; index < count; index += 1) {
        array[index] = (ta_value){ .self = &live_references, .v = &counted };
        live_references += 1;
    }
    return array;
}

int main(void) {
    tna_allocator counting;
    tna_allocator_init(&counting);
    ta_allocator allocator = tna_allocator_for(&counting, TNA_MEMORY_OTHER);
    tna_offloads store;
    tna_offloads_init(&store, allocator);

    /* Two addresses; the store only uses their identity. */
    const ta_address *first = (const ta_address *)(uintptr_t)0x1000;
    const ta_address *second = (const ta_address *)(uintptr_t)0x2000;
    uint8_t bytes[] = { 1, 2, 3, 4, 5 };
    CHECK(tna_offloads_put(&store, &(tna_offload_put_params){ .address = first,
                                                              .bytes = { .ptr = bytes, .len = sizeof bytes },
                                                              .handles = handles(allocator, 2),
                                                              .handle_count = 2 }) == TA_OK);
    CHECK(tna_offloads_put(&store, &(tna_offload_put_params){ .address = second,
                                                              .bytes = { .ptr = bytes, .len = 3 } }) == TA_OK);
    CHECK(tna_offloads_count(&store) == 2);
    CHECK(store.bytes_in_use == sizeof bytes + 3u);
    const tna_offload *entry = tna_offloads_find(&store, first);
    CHECK(entry != NULL && entry->length == sizeof bytes && memcmp(entry->bytes, bytes, sizeof bytes) == 0);
    bytes[0] = 9; /* the store kept a copy */
    CHECK(entry->bytes[0] == 1);
    CHECK(live_references == 2);

    /* Replacing an entry gives the old one's references back. */
    CHECK(tna_offloads_put(&store, &(tna_offload_put_params){ .address = first,
                                                              .bytes = { .ptr = bytes, .len = 1 },
                                                              .handles = handles(allocator, 1),
                                                              .handle_count = 1 }) == TA_OK);
    CHECK(live_references == 1);
    CHECK(tna_offloads_count(&store) == 2);

    /* Dropping one does, too; dropping twice is a no-op. */
    CHECK(tna_offloads_drop(&store, first));
    CHECK(!tna_offloads_drop(&store, first));
    CHECK(live_references == 0);
    CHECK(tna_offloads_find(&store, first) == NULL);

    /* Destroy frees the rest, and every byte is accounted for. */
    CHECK(tna_offloads_put(&store, &(tna_offload_put_params){ .address = first,
                                                              .bytes = { .ptr = bytes, .len = 2 },
                                                              .handles = handles(allocator, 3),
                                                              .handle_count = 3 }) == TA_OK);
    tna_offloads_destroy(&store);
    CHECK(live_references == 0);
    CHECK(store.bytes_in_use == 0);
    tna_map_destroy(&store.entries);
    CHECK(tna_allocator_total(&counting).bytes_in_use == 0);
    puts("offloads_test passed");
    return 0;
}
