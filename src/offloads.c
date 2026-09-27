#include "offloads.h"

#include <string.h>

void tna_offloads_init(tna_offloads *offloads, ta_allocator allocator) {
    *offloads = (tna_offloads){ .allocator = allocator };
    tna_map_init(&offloads->entries, allocator);
}

static void tna_offload_free(tna_offloads *offloads, tna_offload *entry) {
    for (uint32_t index = 0; index < entry->handle_count; index += 1) {
        ta_value_release(&entry->handles[index]);
    }
    if (entry->handles != NULL) {
        offloads->allocator.v->free(offloads->allocator.self,
                                    &(ta_allocator_free_params){ .ptr = entry->handles,
                                                                 .size = (size_t)entry->handle_count * sizeof(ta_value),
                                                                 .alignment = _Alignof(ta_value) });
    }
    offloads->bytes_in_use -= entry->length;
    offloads->allocator.v->free(offloads->allocator.self,
                                &(ta_allocator_free_params){ .ptr = entry,
                                                             .size = sizeof(tna_offload) + entry->length,
                                                             .alignment = _Alignof(tna_offload) });
}

ta_result tna_offloads_put(tna_offloads *offloads, const tna_offload_put_params *params) {
    size_t size = sizeof(tna_offload) + params->bytes.len;
    tna_offload *entry = offloads->allocator.v->alloc(offloads->allocator.self, size, _Alignof(tna_offload));
    if (entry == NULL) {
        return TA_ERR_NOMEM;
    }
    uint64_t key = (uint64_t)(uintptr_t)params->address;
    uint64_t previous = 0;
    bool replaced = tna_map_get(&offloads->entries, key, &previous);
    if (tna_map_put(&offloads->entries, key, (uint64_t)(uintptr_t)entry) != TA_OK) {
        offloads->allocator.v->free(offloads->allocator.self,
                                    &(ta_allocator_free_params){ .ptr = entry, .size = size,
                                                                 .alignment = _Alignof(tna_offload) });
        return TA_ERR_NOMEM;
    }
    *entry = (tna_offload){
        .bytes = (uint8_t *)(entry + 1),
        .length = params->bytes.len,
        .handles = params->handles,
        .handle_count = params->handle_count,
    };
    if (params->bytes.len != 0) {
        memcpy(entry->bytes, params->bytes.ptr, params->bytes.len);
    }
    offloads->bytes_in_use += entry->length;
    if (replaced) {
        tna_offload_free(offloads, (tna_offload *)(uintptr_t)previous);
    }
    return TA_OK;
}

const tna_offload *tna_offloads_find(const tna_offloads *offloads, const ta_address *address) {
    uint64_t value = 0;
    return tna_map_get(&offloads->entries, (uint64_t)(uintptr_t)address, &value) ? (const tna_offload *)(uintptr_t)value
                                                                                  : NULL;
}

bool tna_offloads_drop(tna_offloads *offloads, const ta_address *address) {
    uint64_t key = (uint64_t)(uintptr_t)address;
    uint64_t value = 0;
    if (!tna_map_get(&offloads->entries, key, &value)) {
        return false;
    }
    (void)tna_map_remove(&offloads->entries, key);
    tna_offload_free(offloads, (tna_offload *)(uintptr_t)value);
    return true;
}

uint32_t tna_offloads_count(const tna_offloads *offloads) {
    return tna_map_count(&offloads->entries);
}

void tna_offloads_destroy(tna_offloads *offloads) {
    uint32_t cursor = 0;
    uint64_t key = 0;
    uint64_t value = 0;
    while (tna_map_next(&offloads->entries, &cursor, &key, &value)) {
        tna_offload_free(offloads, (tna_offload *)(uintptr_t)value);
    }
    tna_map_destroy(&offloads->entries);
    tna_map_init(&offloads->entries, offloads->allocator);
}
