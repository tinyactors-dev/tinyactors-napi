#include "runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "napi_datamodel.h"
#include "napi_system.h"
#include "system.h"

/* ------------------------------------------------------------------------
 * The environment
 */

static void tna_env_free_if_unused(tna_env *data) {
    if (data->torn_down && data->references == 0) {
        free(data);
    }
}

/*
 * The environment is going away: close every System still open (ADR 0012)
 * and drop the error class. The record itself stays until the last System
 * wrapper is finalized, because finalizers may run after this hook.
 */
static void tna_env_cleanup(void *arg) {
    tna_env *data = arg;
    tna_napi_system_close_open(data);
    data->torn_down = true;
    /* The environment is being destroyed; its references go with it. */
    data->error_class = NULL;
    data->actor_class = NULL;
    data->literal_brand = NULL;
    data->effects_handler = NULL;
    tna_env_free_if_unused(data);
}

napi_status tna_env_init(napi_env env, tna_env **out) {
    tna_env *data = calloc(1, sizeof *data);
    if (data == NULL) {
        return napi_generic_failure;
    }
    napi_status status = napi_set_instance_data(env, data, NULL, NULL);
    if (status == napi_ok) {
        status = napi_add_env_cleanup_hook(env, tna_env_cleanup, data);
    }
    if (status != napi_ok) {
        free(data);
        return status;
    }
    *out = data;
    return napi_ok;
}

tna_env *tna_env_get(napi_env env) {
    void *data = NULL;
    if (napi_get_instance_data(env, &data) != napi_ok) {
        return NULL;
    }
    return data;
}

void tna_env_retain(tna_env *data) {
    data->references += 1u;
}

void tna_env_release(tna_env *data) {
    data->references -= 1u;
    tna_env_free_if_unused(data);
}

/* Builds a TinyactorsError, or NULL before setup. */
static napi_value tna_error_object(napi_env env, const char *code, const char *message) {
    tna_env *data = tna_env_get(env);
    napi_value error_class = NULL;
    if (data == NULL || data->error_class == NULL ||
        napi_get_reference_value(env, data->error_class, &error_class) != napi_ok || error_class == NULL) {
        return NULL;
    }
    napi_value argv[2];
    napi_value error = NULL;
    if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &argv[0]) != napi_ok ||
        napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &argv[1]) != napi_ok ||
        napi_new_instance(env, error_class, 2, argv, &error) != napi_ok) {
        return NULL;
    }
    return error;
}

napi_value tna_error(napi_env env, const char *code, const char *message) {
    napi_value error = tna_error_object(env, code, message);
    if (error != NULL) {
        return error;
    }
    napi_value code_value = NULL;
    napi_value message_value = NULL;
    if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
        napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
        napi_create_error(env, code_value, message_value, &error) != napi_ok) {
        return NULL;
    }
    return error;
}

napi_value tna_throw(napi_env env, const char *code, const char *message) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        return NULL;
    }
    napi_value error = tna_error_object(env, code, message);
    if (error != NULL) {
        napi_throw(env, error);
        return NULL;
    }
    napi_throw_error(env, code, message);
    return NULL;
}

/* ------------------------------------------------------------------------
 * Calls
 */

/* A reference a call took and gives back when it ends. */
struct tna_cleanup {
    ta_address *address; /* or NULL */
    ta_value value;      /* or absent */
    ta_expression expression; /* or TA_EXPRESSION_NONE */
    tna_cleanup *next;
};

static void *tna_malloc_alloc(void *self, size_t size, size_t alignment) {
    (void)self;
    (void)alignment; /* malloc's alignment covers every arena block core asks for */
    return malloc(size);
}

static void tna_malloc_free(void *self, const ta_allocator_free_params *params) {
    (void)self;
    free(params->ptr);
}

static const ta_allocator_vtable tna_malloc_vtable = { tna_malloc_alloc, tna_malloc_free };

void tna_call_begin(tna_call *call, napi_env env, const char *function) {
    memset(call, 0, sizeof *call);
    call->env = env;
    call->function = function;
}

napi_value tna_call_end(tna_call *call, napi_value value) {
    for (tna_cleanup *cleanup = call->cleanups; cleanup != NULL; cleanup = cleanup->next) {
        ta_address_release(cleanup->address);
        ta_value_release(&cleanup->value);
        tna_expression_release(&cleanup->expression);
    }
    call->cleanups = NULL;
    if (call->temporary_used) {
        ta_arena_destroy(&call->temporary);
    } else if (call->arena != NULL && !tna_system_closed(call->owner->system)) {
        tna_scratch_reset_call(&call->owner->system->scratch);
    }
    if (call->owner != NULL && !tna_system_closed(call->owner->system)) {
        tna_napi_system_flush(call->owner);
    }
    return value;
}

/* Sets the system a call runs against; every argument must agree on it. */
static bool tna_call_owner(tna_call *call, tna_napi_system *owner) {
    if (call->owner == owner) {
        return true;
    }
    if (call->owner != NULL) {
        return tna_invalid(call, "a handle of the same system");
    }
    if (tna_system_closed(owner->system)) {
        tna_throw(call->env, "closed", "the system is closed");
        return false;
    }
    if (owner->system->inside_core) {
        tna_throw(call->env, "reentrant", "core cannot be called from inside a core call (ADR 0013)");
        return false;
    }
    if (call->arena != NULL) {
        return tna_invalid(call, "the system before any other argument");
    }
    call->owner = owner;
    call->core = owner->system->core;
    return true;
}

bool tna_call_receiver(tna_call *call, napi_value system) {
    tna_napi_system *owner = tna_napi_system_unwrap(call->env, system);
    if (owner == NULL) {
        tna_push(call, "system");
        return tna_invalid(call, "a native System");
    }
    return tna_call_owner(call, owner);
}

void tna_core_enter(tna_call *call) {
    if (call->owner != NULL) {
        call->owner->system->inside_core = true;
    }
}

void tna_core_leave(tna_call *call) {
    if (call->owner != NULL) {
        call->owner->system->inside_core = false;
    }
}

tna_system *tna_call_system(const tna_call *call) {
    return call->owner == NULL ? NULL : call->owner->system;
}

napi_value tna_call_fail(tna_call *call, ta_result result, napi_value detail) {
    bool pending = false;
    if (napi_is_exception_pending(call->env, &pending) == napi_ok && pending) {
        return NULL;
    }
    const char *code = tna_result_code(result);
    char message[160];
    snprintf(message, sizeof message, "%s: %s", call->function, code);
    napi_value error = tna_error_object(call->env, code, message);
    if (error == NULL) {
        return tna_throw(call->env, code, message);
    }
    if (detail != NULL) {
        napi_set_named_property(call->env, error, "detail", detail);
    }
    napi_throw(call->env, error);
    return NULL;
}

ta_arena *tna_call_arena(tna_call *call) {
    if (call->arena != NULL) {
        return call->arena;
    }
    if (call->owner != NULL) {
        call->arena = &call->owner->system->scratch.call;
    } else {
        ta_allocator allocator = { NULL, &tna_malloc_vtable };
        if (ta_arena_init(&call->temporary, allocator, 4096) != TA_OK) {
            return NULL;
        }
        call->temporary_used = true;
        call->arena = &call->temporary;
    }
    return call->arena;
}

void *tna_call_alloc(tna_call *call, size_t size, size_t alignment) {
    ta_arena *arena = tna_call_arena(call);
    void *memory = arena == NULL ? NULL : ta_arena_alloc(arena, size == 0 ? 1 : size, alignment);
    if (memory == NULL) {
        tna_throw(call->env, "out-of-memory", "the call arena is full");
        return NULL;
    }
    memset(memory, 0, size == 0 ? 1 : size);
    return memory;
}

bool tna_ok(tna_call *call, napi_status status) {
    if (status == napi_ok) {
        return true;
    }
    bool pending = false;
    if (napi_is_exception_pending(call->env, &pending) == napi_ok && pending) {
        return false;
    }
    const napi_extended_error_info *info = NULL;
    napi_get_last_error_info(call->env, &info);
    char message[200];
    snprintf(message, sizeof message, "%s: Node-API failed (%s)", call->function,
             info != NULL && info->error_message != NULL ? info->error_message : "unknown");
    tna_throw(call->env, "invalid", message);
    return false;
}

/* ------------------------------------------------------------------------
 * The decode path
 */

static void tna_path_append(tna_call *call, const char *text) {
    size_t used = strlen(call->path);
    if (used < TNA_PATH_BYTES - 1u) {
        snprintf(call->path + used, TNA_PATH_BYTES - used, "%s", text);
    }
}

static void tna_path_mark(tna_call *call) {
    if (call->depth < TNA_PATH_DEPTH) {
        call->lengths[call->depth] = (uint32_t)strlen(call->path);
    }
    call->depth += 1u;
}

void tna_push(tna_call *call, const char *key) {
    tna_path_mark(call);
    if (call->path[0] != '\0') {
        tna_path_append(call, ".");
    }
    tna_path_append(call, key);
}

void tna_push_index(tna_call *call, uint32_t index) {
    char text[24];
    snprintf(text, sizeof text, "[%u]", index);
    tna_path_mark(call);
    tna_path_append(call, text);
}

void tna_pop(tna_call *call) {
    if (call->depth == 0) {
        return;
    }
    call->depth -= 1u;
    if (call->depth < TNA_PATH_DEPTH) {
        call->path[call->lengths[call->depth]] = '\0';
    }
}

bool tna_invalid(tna_call *call, const char *expected) {
    char message[TNA_PATH_BYTES + 160];
    snprintf(message, sizeof message, "%s: %s: expected %s", call->function,
             call->path[0] != '\0' ? call->path : "arguments", expected);
    tna_throw(call->env, "invalid", message);
    return false;
}

bool tna_member(tna_call *call, napi_value object, const char *key) {
    tna_push(call, key);
    return tna_ok(call, napi_get_named_property(call->env, object, key, &call->member));
}

napi_value tna_member_value(const tna_call *call) {
    return call->member;
}

bool tna_absent(tna_call *call, napi_value value) {
    napi_valuetype type = napi_undefined;
    return value == NULL || (napi_typeof(call->env, value, &type) == napi_ok && type == napi_undefined);
}

bool tna_expect_object(tna_call *call, napi_value value) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(call->env, value, &type) != napi_ok || type != napi_object) {
        return tna_invalid(call, "an object");
    }
    return true;
}

bool tna_array_length(tna_call *call, napi_value value, uint32_t *out) {
    bool is_array = false;
    if (napi_is_array(call->env, value, &is_array) != napi_ok || !is_array) {
        return tna_invalid(call, "an array");
    }
    return tna_ok(call, napi_get_array_length(call->env, value, out));
}

/* ------------------------------------------------------------------------
 * Making JavaScript values
 */

napi_value tna_undefined(tna_call *call) {
    napi_value value = NULL;
    return tna_ok(call, napi_get_undefined(call->env, &value)) ? value : NULL;
}

napi_value tna_object(tna_call *call) {
    napi_value value = NULL;
    return tna_ok(call, napi_create_object(call->env, &value)) ? value : NULL;
}

napi_value tna_new_array(tna_call *call, uint32_t length) {
    napi_value value = NULL;
    return tna_ok(call, napi_create_array_with_length(call->env, length, &value)) ? value : NULL;
}

napi_value tna_string(tna_call *call, const char *text) {
    napi_value value = NULL;
    return tna_ok(call, napi_create_string_utf8(call->env, text, NAPI_AUTO_LENGTH, &value)) ? value : NULL;
}

napi_value tna_number(tna_call *call, double number) {
    napi_value value = NULL;
    return tna_ok(call, napi_create_double(call->env, number, &value)) ? value : NULL;
}

bool tna_read_symbol(tna_call *call, napi_value value, tna_symbol *out) {
    napi_valuetype type = napi_undefined;
    size_t length = 0;
    if (napi_typeof(call->env, value, &type) != napi_ok || type != napi_string) {
        return tna_invalid(call, "a symbol string");
    }
    if (!tna_ok(call, napi_get_value_string_utf8(call->env, value, out->text, sizeof out->text, &length))) {
        return false;
    }
    if (length >= sizeof out->text - 1u) {
        return tna_invalid(call, "a known symbol");
    }
    return true;
}

/* ------------------------------------------------------------------------
 * Handle objects
 */

const char tna_handle_tag = 0;

static void tna_handle_finalize(napi_env env, void *data, void *hint) {
    (void)env;
    (void)hint;
    tna_napi_handle *handle = data;
    tna_napi_system *owner = handle->owner;
    handle->finalized = true;
    if (handle->pointer == NULL || tna_system_closed(owner->system)) {
        tna_napi_system_drop(handle);
        return;
    }
    if (owner->system->inside_core) {
        return; /* released when the core call returns (tna_call_end) */
    }
    handle->kind->release(handle->pointer);
    handle->pointer = NULL;
    tna_napi_system_drop(handle);
}

napi_value tna_handle_wrap(tna_call *call, const tna_handle_kind *kind, void *pointer) {
    if (call->owner == NULL) {
        tna_throw(call->env, "invalid", "a handle needs the system that made it");
        return NULL;
    }
    tna_napi_handle *handle = calloc(1, sizeof *handle);
    if (handle == NULL) {
        kind->release(pointer);
        tna_throw(call->env, "out-of-memory", "cannot allocate a handle object");
        return NULL;
    }
    handle->tag = &tna_handle_tag;
    handle->kind = kind;
    handle->pointer = pointer;
    napi_value object = tna_object(call);
    if (object == NULL || !tna_ok(call, napi_wrap(call->env, object, handle, tna_handle_finalize, NULL, NULL))) {
        kind->release(pointer);
        free(handle);
        return NULL;
    }
    tna_napi_system_adopt(call->owner, handle);
    return object;
}

static tna_napi_handle *tna_handle_of(tna_call *call, napi_value value) {
    void *wrapped = NULL;
    if (napi_unwrap(call->env, value, &wrapped) != napi_ok || wrapped == NULL ||
        *(const void *const *)wrapped != &tna_handle_tag) {
        return NULL;
    }
    return wrapped;
}

bool tna_handle_unwrap(tna_call *call, napi_value value, tna_handle_ref *ref) {
    tna_napi_handle *handle = tna_handle_of(call, value);
    char expected[96];
    snprintf(expected, sizeof expected, "a %s handle", ref->kind->name);
    if (handle == NULL || handle->kind != ref->kind) {
        return tna_invalid(call, expected);
    }
    if (!tna_call_owner(call, handle->owner)) {
        return false;
    }
    if (handle->pointer == NULL) {
        snprintf(expected, sizeof expected, "a %s handle that was not released", ref->kind->name);
        return tna_invalid(call, expected);
    }
    ref->pointer = handle->pointer;
    return true;
}

void tna_handle_retire(tna_call *call, napi_value value) {
    tna_napi_handle *handle = tna_handle_of(call, value);
    if (handle != NULL) {
        handle->pointer = NULL;
    }
}

/* The cleanup list for addresses a call interned (runtime_codecs.c). */
bool tna_call_keep_address(tna_call *call, ta_address *address) {
    tna_cleanup *cleanup = tna_call_alloc(call, sizeof *cleanup, _Alignof(tna_cleanup));
    if (cleanup == NULL) {
        ta_address_release(address);
        return false;
    }
    *cleanup = (tna_cleanup){ .address = address, .next = call->cleanups };
    call->cleanups = cleanup;
    return true;
}

bool tna_call_keep_expression(tna_call *call, ta_expression expression) {
    tna_cleanup *cleanup = tna_call_alloc(call, sizeof *cleanup, _Alignof(tna_cleanup));
    if (cleanup == NULL) {
        tna_expression_release(&expression);
        return false;
    }
    *cleanup = (tna_cleanup){ .expression = expression, .next = call->cleanups };
    call->cleanups = cleanup;
    return true;
}

bool tna_call_keep_value(tna_call *call, ta_value value) {
    tna_cleanup *cleanup = tna_call_alloc(call, sizeof *cleanup, _Alignof(tna_cleanup));
    if (cleanup == NULL) {
        ta_value_release(&value);
        return false;
    }
    *cleanup = (tna_cleanup){ .value = value, .next = call->cleanups };
    call->cleanups = cleanup;
    return true;
}
