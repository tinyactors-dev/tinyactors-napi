#include "directory.h"

static uint64_t tna_directory_key(const ta_address *address) {
    return (uint64_t)(uintptr_t)address;
}

static uint64_t tna_directory_value(ta_actor_directory_entry entry) {
    return entry.kind == TA_ACTOR_DIRECTORY_RESIDENT ? entry.actor : 0u;
}

void tna_directory_init(tna_directory *directory, ta_allocator allocator) {
    tna_map_init(&directory->entries, allocator);
}

ta_actor_directory_entry tna_directory_find(const tna_directory *directory, const ta_address *address) {
    uint64_t value = 0;
    if (address == NULL || !tna_map_get(&directory->entries, tna_directory_key(address), &value)) {
        return (ta_actor_directory_entry){ .kind = TA_ACTOR_DIRECTORY_NONE };
    }
    if (value == 0) {
        return (ta_actor_directory_entry){ .kind = TA_ACTOR_DIRECTORY_UNLOADED };
    }
    return (ta_actor_directory_entry){ .kind = TA_ACTOR_DIRECTORY_RESIDENT, .actor = value };
}

static bool tna_entries_equal(ta_actor_directory_entry left, ta_actor_directory_entry right) {
    return left.kind == right.kind && (left.kind != TA_ACTOR_DIRECTORY_RESIDENT || left.actor == right.actor);
}

/* Sets the entry for `address` to `entry` (NONE removes it), keeping one reference while it exists. */
static ta_result tna_directory_store(tna_directory *directory, ta_address *address, ta_actor_directory_entry entry) {
    uint64_t key = tna_directory_key(address);
    bool present = tna_map_get(&directory->entries, key, NULL);
    if (entry.kind == TA_ACTOR_DIRECTORY_NONE) {
        if (present) {
            tna_map_remove(&directory->entries, key);
            ta_address_release(address);
        }
        return TA_OK;
    }
    ta_result result = tna_map_put(&directory->entries, key, tna_directory_value(entry));
    if (result == TA_OK && !present) {
        ta_address_retain(address);
    }
    return result;
}

static ta_result tna_directory_claim(void *self, const ta_actor_directory_claim_params *params) {
    tna_directory *directory = self;
    if (params == NULL || params->address == NULL || params->entry.kind == TA_ACTOR_DIRECTORY_NONE) {
        return TA_ERR_INVALID;
    }
    if (tna_directory_find(directory, params->address).kind != TA_ACTOR_DIRECTORY_NONE) {
        return TA_ERR_STALE;
    }
    return tna_directory_store(directory, params->address, params->entry);
}

static ta_result tna_directory_resolve(void *self, const ta_actor_directory_resolve_params *params) {
    const tna_directory *directory = self;
    if (params == NULL || params->address == NULL || params->out == NULL) {
        return TA_ERR_INVALID;
    }
    *params->out = tna_directory_find(directory, params->address);
    return params->out->kind == TA_ACTOR_DIRECTORY_NONE ? TA_ERR_NOT_FOUND : TA_OK;
}

static ta_result tna_directory_replace(void *self, const ta_actor_directory_replace_params *params) {
    tna_directory *directory = self;
    if (params == NULL || params->address == NULL) {
        return TA_ERR_INVALID;
    }
    if (!tna_entries_equal(tna_directory_find(directory, params->address), params->expected)) {
        return TA_ERR_STALE;
    }
    return tna_directory_store(directory, params->address, params->replacement);
}

static ta_result tna_directory_remove(void *self, const ta_actor_directory_remove_params *params) {
    tna_directory *directory = self;
    if (params == NULL || params->address == NULL) {
        return TA_ERR_INVALID;
    }
    if (!tna_entries_equal(tna_directory_find(directory, params->address), params->expected)) {
        return TA_ERR_STALE;
    }
    return tna_directory_store(directory, params->address, (ta_actor_directory_entry){ .kind = TA_ACTOR_DIRECTORY_NONE });
}

static const ta_actor_directory_vtable tna_directory_vtable = {
    .claim = tna_directory_claim,
    .resolve = tna_directory_resolve,
    .replace = tna_directory_replace,
    .remove = tna_directory_remove,
};

ta_actor_directory tna_directory_adapter(tna_directory *directory) {
    return (ta_actor_directory){ .self = directory, .v = &tna_directory_vtable };
}

uint32_t tna_directory_count(const tna_directory *directory) {
    return tna_map_count(&directory->entries);
}

void tna_directory_clear(tna_directory *directory) {
    uint32_t cursor = 0;
    uint64_t key = 0;
    uint64_t value = 0;
    while (tna_map_next(&directory->entries, &cursor, &key, &value)) {
        ta_address_release((ta_address *)(uintptr_t)key);
    }
    tna_map_destroy(&directory->entries);
}

void tna_directory_destroy(tna_directory *directory) {
    tna_directory_clear(directory);
}
