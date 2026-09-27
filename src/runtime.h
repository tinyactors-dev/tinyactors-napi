#pragma once
/*
 * The Node-API runtime shared by hand-written and generated code (ADR 0013).
 *
 * The environment record (tna_env) is created at module init and belongs to
 * one Node-API environment (ADR 0001: no global registry). It holds:
 * - a reference to the JavaScript TinyactorsError class, registered by
 *   lib/errors.js through the native `setup` function;
 * - the list of systems that are still open, so the environment cleanup hook
 *   can close them (ADR 0012);
 * - counters that tests read: systems alive and bytes leaked at close.
 *
 * Teardown order is not fixed across runtimes: the cleanup hook may run
 * before or after the finalizers of System wrappers. So the record is
 * reference-counted: every native System holds a reference, and the record is
 * freed once the cleanup hook has run and the last System is freed.
 *
 * The rest of this header is what generated calls (src/gen/ta_napi.c) use:
 * - a call context (tna_call) with the call arena, the decode path for error
 *   messages, and the references to release when the call ends;
 * - the receiver: the native System a call runs against, with the
 *   reentrancy guard (ADR 0013 point 4);
 * - codecs for primitives, strings, bytes and the overridden types
 *   (ta_actor_id, ta_actor_ref, ta_value, ta_expression), and injectors for
 *   the adapters the plumbing supplies (ta_allocator, ta_datamodel);
 * - handle objects with finalizers that call the release function the API
 *   description names (ADR 0013 point 5).
 */
#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tinyactors.h"

typedef struct tna_napi_system tna_napi_system;

typedef struct tna_env {
    napi_ref error_class; /* TinyactorsError, or NULL before setup */
    napi_ref actor_class; /* ActorID (lib/actor.js), for views made natively */
    napi_ref literal_brand; /* the literal() brand symbol (lib/statechart.js) */
    napi_ref effects_handler; /* (system, kind, payload) => void (lib/system.js), step 13 */
    tna_napi_system *open_systems; /* intrusive list through tna_napi_system */
    uint32_t references;           /* live native Systems */
    bool torn_down;                /* the cleanup hook has run */
    uint64_t systems_created;
    uint64_t systems_closed;
    uint64_t leaked_bytes;         /* summed over closed systems */
    uint64_t values_live;          /* value boxes live in every system (ADR 0011) */
} tna_env;

/* Creates the record, stores it as instance data, and adds the cleanup hook. */
napi_status tna_env_init(napi_env env, tna_env **out);
tna_env *tna_env_get(napi_env env);
void tna_env_retain(tna_env *data);
/* Drops one System's reference; frees the record when nothing needs it. */
void tna_env_release(tna_env *data);

/*
 * Throws a TinyactorsError with `code` (a TinyactorsErrorCode string) and
 * `message`. Falls back to an Error with a `code` property before setup.
 * Returns NULL so a callback can `return tna_throw(...)`.
 */
napi_value tna_throw(napi_env env, const char *code, const char *message);
/* A TinyactorsError value (not thrown), or an Error with `code` before setup. */
napi_value tna_error(napi_env env, const char *code, const char *message);
/* The TinyactorsErrorCode for a core result (generated in src/gen/ta_napi.c). */
const char *tna_result_code(ta_result result);

/* ------------------------------------------------------------------------
 * Handles (ADR 0013 point 5)
 */

typedef struct tna_handle_kind {
    const char *name;                /* the API description's handle name */
    void (*release)(void *pointer);  /* its destroy function */
    bool reclaimed_by_core;          /* core frees it at system teardown */
} tna_handle_kind;

/*
 * One JavaScript handle object. It belongs to a system's list until it is
 * released, consumed, or the system closes; its finalizer is a safety net
 * behind explicit destruction.
 */
typedef struct tna_napi_handle {
    const void *tag; /* &tna_handle_tag */
    const tna_handle_kind *kind;
    void *pointer;   /* NULL once released, consumed, or reclaimed at close */
    tna_napi_system *owner;
    struct tna_napi_handle *previous;
    struct tna_napi_handle *next;
    bool finalized; /* the JavaScript object is gone */
} tna_napi_handle;

extern const char tna_handle_tag;

/* ------------------------------------------------------------------------
 * Calls
 */

#define TNA_PATH_BYTES 256u
#define TNA_PATH_DEPTH 64u

typedef struct tna_cleanup tna_cleanup;

typedef struct tna_call {
    napi_env env;
    const char *function;   /* "core.actor_spawn", for messages */
    tna_napi_system *owner; /* set by the receiver or by a handle argument */
    ta_system *core;
    ta_arena *arena;        /* the call arena, chosen on first use */
    ta_arena temporary;     /* the call arena of a call with no system */
    bool temporary_used;
    tna_cleanup *cleanups;
    napi_value member;      /* the value tna_member read last */
    uint32_t depth;
    uint32_t lengths[TNA_PATH_DEPTH];
    char path[TNA_PATH_BYTES];
} tna_call;

void tna_call_begin(tna_call *call, napi_env env, const char *function);
/*
 * Ends a call: releases what it interned, resets or frees its arena, and
 * releases handles whose objects were finalized while core ran. Returns
 * `value` (NULL when the call threw).
 */
napi_value tna_call_end(tna_call *call, napi_value value);
/* Unwraps the JavaScript System the call runs against; throws when closed. */
bool tna_call_receiver(tna_call *call, napi_value system);
/* The reentrancy guard around one core call (ADR 0013 point 4). */
void tna_core_enter(tna_call *call);
void tna_core_leave(tna_call *call);
/* Throws the TinyactorsError for `result`, with `detail` when not NULL. */
napi_value tna_call_fail(tna_call *call, ta_result result, napi_value detail);
/* Releases `address` when the call ends; releases it now on failure. */
bool tna_call_keep_address(tna_call *call, ta_address *address);
/* Releases `value` when the call ends; releases it now on failure. */
bool tna_call_keep_value(tna_call *call, ta_value value);
/* Releases a host expression when the call ends; releases it now on failure. */
bool tna_call_keep_expression(tna_call *call, ta_expression expression);
/* The call arena: the system's, or a temporary one for a call with no system. */
ta_arena *tna_call_arena(tna_call *call);
/* Zeroed memory from the call arena; throws and returns NULL on failure. */
void *tna_call_alloc(tna_call *call, size_t size, size_t alignment);
/* The system the call runs against, or NULL. */
struct tna_system *tna_call_system(const tna_call *call);

/* True when `status` is napi_ok; otherwise throws unless already pending. */
bool tna_ok(tna_call *call, napi_status status);

/* The decode path, for messages such as "core.actor_spawn: params.address.name". */
void tna_push(tna_call *call, const char *key);
void tna_push_index(tna_call *call, uint32_t index);
void tna_pop(tna_call *call);
/* Throws an "invalid" TinyactorsError naming the path; returns false. */
bool tna_invalid(tna_call *call, const char *expected);
/* Reads `key` of `object` and pushes it on the path. */
bool tna_member(tna_call *call, napi_value object, const char *key);
/* The value tna_member read last. */
napi_value tna_member_value(const tna_call *call);
bool tna_absent(tna_call *call, napi_value value); /* undefined */
bool tna_expect_object(tna_call *call, napi_value value);
/* The length of an array; throws "invalid" when `value` is not one. */
bool tna_array_length(tna_call *call, napi_value value, uint32_t *out);

napi_value tna_undefined(tna_call *call);
napi_value tna_object(tna_call *call);
napi_value tna_new_array(tna_call *call, uint32_t length);
napi_value tna_string(tna_call *call, const char *text);
napi_value tna_number(tna_call *call, double value);

/* An enum symbol read from JavaScript. */
typedef struct {
    char text[64];
} tna_symbol;
bool tna_read_symbol(tna_call *call, napi_value value, tna_symbol *out);

/* Items decoded into the call arena, for counted and terminated lists. */
typedef struct {
    void *items;
    uint32_t count;
} tna_items;

/* ------------------------------------------------------------------------
 * Codecs: decode JavaScript into C, encode C as JavaScript.
 */

bool tna_dec_bool(tna_call *call, napi_value value, bool *out);
bool tna_dec_uint8_t(tna_call *call, napi_value value, uint8_t *out);
bool tna_dec_uint16_t(tna_call *call, napi_value value, uint16_t *out);
bool tna_dec_uint32_t(tna_call *call, napi_value value, uint32_t *out);
bool tna_dec_int32_t(tna_call *call, napi_value value, int32_t *out);
bool tna_dec_int(tna_call *call, napi_value value, int *out);
bool tna_dec_size_t(tna_call *call, napi_value value, size_t *out);
bool tna_dec_uint64_t(tna_call *call, napi_value value, uint64_t *out); /* a bigint */
bool tna_dec_u64n(tna_call *call, napi_value value, uint64_t *out);     /* a number */
bool tna_dec_ta_str(tna_call *call, napi_value value, ta_str *out);
bool tna_dec_ta_bytes(tna_call *call, napi_value value, ta_bytes *out);
bool tna_dec_ta_value(tna_call *call, napi_value value, ta_value *out);
bool tna_dec_ta_expression(tna_call *call, napi_value value, ta_expression *out);
bool tna_dec_ta_actor_ref(tna_call *call, napi_value value, ta_actor_ref *out);
/* Always refused: origins are made by core and the plumbing (core ADR 0068). */
bool tna_dec_ta_origin(tna_call *call, napi_value value, ta_origin *out);
/* {slot, generation} inside an object. */
bool tna_dec_ta_actor_id(tna_call *call, napi_value value, ta_actor_id *out);
/* Two positional arguments: pair[0] is the slot, pair[1] the generation. */
bool tna_dec_actor_pair(tna_call *call, const napi_value *pair, ta_actor_id *out);

napi_value tna_enc_bool(tna_call *call, const bool *in);
napi_value tna_enc_uint8_t(tna_call *call, const uint8_t *in);
napi_value tna_enc_uint16_t(tna_call *call, const uint16_t *in);
napi_value tna_enc_uint32_t(tna_call *call, const uint32_t *in);
napi_value tna_enc_int32_t(tna_call *call, const int32_t *in);
napi_value tna_enc_int(tna_call *call, const int *in);
napi_value tna_enc_size_t(tna_call *call, const size_t *in);
napi_value tna_enc_uint64_t(tna_call *call, const uint64_t *in);
napi_value tna_enc_u64n(tna_call *call, const uint64_t *in);
napi_value tna_enc_ta_str(tna_call *call, const ta_str *in);
napi_value tna_enc_ta_bytes(tna_call *call, const ta_bytes *in);
napi_value tna_enc_ta_value(tna_call *call, const ta_value *in);
napi_value tna_enc_ta_expression(tna_call *call, const ta_expression *in);
napi_value tna_enc_ta_actor_ref(tna_call *call, const ta_actor_ref *in);
/* {kind, actor | invoke | scope, type, uri}: type and URI rendered by core (core ADR 0068). */
napi_value tna_enc_ta_origin(tna_call *call, const ta_origin *in);
napi_value tna_enc_ta_actor_id(tna_call *call, const ta_actor_id *in);
/* The adapter's SCXML data-model name. */
napi_value tna_enc_ta_datamodel(tna_call *call, const ta_datamodel *in);
/* A char caller buffer: `count` bytes including the terminating NUL. */
napi_value tna_enc_text(tna_call *call, const char *text, uint32_t count);

/* Adapters the plumbing supplies (INJECT_TYPES in bindings.rb). */
bool tna_inject_ta_allocator(tna_call *call, ta_allocator *out);
bool tna_inject_ta_datamodel(tna_call *call, ta_datamodel *out);

/* ------------------------------------------------------------------------
 * Handle objects
 */

/* Wraps a pointer core handed out; the object releases it when collected. */
napi_value tna_handle_wrap(tna_call *call, const tna_handle_kind *kind, void *pointer);

typedef struct {
    const tna_handle_kind *kind; /* set by the caller */
    void *pointer;               /* set by tna_handle_unwrap */
} tna_handle_ref;

/* The live pointer of a handle object of ref->kind; throws otherwise. */
bool tna_handle_unwrap(tna_call *call, napi_value value, tna_handle_ref *ref);
/* The handle was destroyed or consumed by core: forget its pointer. */
void tna_handle_retire(tna_call *call, napi_value value);
