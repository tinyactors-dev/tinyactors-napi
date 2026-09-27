#pragma once
/*
 * Offloaded actors (core ADR 0074, napi ADR 0020): the bytes an unloaded
 * actor was offloaded to, kept per address until the actor loads again or
 * the address is removed.
 *
 * One allocation per actor holds its bytes; a map keyed by the address
 * handle core and the directory share finds it. The directory keeps an
 * unloaded address's reference, so the key stays valid for as long as the
 * entry: removing the address removes the entry first.
 *
 * Values an actor's data model kept by handle rather than writing out (napi
 * ADR 0020 notes, the handle fallback of napi's data model) stay alive with
 * the entry: it holds one reference to each, released when the entry goes.
 *
 * This module has no Node-API in it.
 */
#include <stddef.h>
#include <stdint.h>

#include "containers.h"
#include "tinyactors.h"

typedef struct {
    uint8_t *bytes;
    size_t length;
    /* References the entry holds to values its bytes name by handle. */
    ta_value *handles;
    uint32_t handle_count;
} tna_offload;

typedef struct {
    ta_allocator allocator;
    tna_map entries; /* (uintptr_t)ta_address * -> tna_offload * */
    size_t bytes_in_use;
} tna_offloads;

void tna_offloads_init(tna_offloads *offloads, ta_allocator allocator);
/*
 * Keeps a copy of `bytes` for `address`, taking over `handles` (their
 * references and the array, allocated with the store's allocator), in place
 * of any entry it had. TA_ERR_NOMEM keeps nothing and leaves `handles` the
 * caller's.
 */
typedef struct {
    const ta_address *address;
    ta_bytes bytes;
    ta_value *handles;
    uint32_t handle_count;
} tna_offload_put_params;
ta_result tna_offloads_put(tna_offloads *offloads, const tna_offload_put_params *params);
/* The entry for `address`, or null. */
const tna_offload *tna_offloads_find(const tna_offloads *offloads, const ta_address *address);
/* Frees the entry for `address`, releasing its handles; false when it had none. */
bool tna_offloads_drop(tna_offloads *offloads, const ta_address *address);
uint32_t tna_offloads_count(const tna_offloads *offloads);
/* Frees every entry. */
void tna_offloads_destroy(tna_offloads *offloads);
