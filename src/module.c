/* The module @tinyactors/node: its instance per environment (the main
 * thread and each worker; napi_set_instance_data), the allocator, the class
 * TinyactorsError and the exports. Everything a Host does is host.c and
 * the files beside it. */
#include "addon.h"

#include <assert.h>
#include <stdlib.h>

/* ---- the allocator (AGENTS.md, "The host's allocator") ------------------ */

/* malloc, reported to the engine so its collector sees the memory. `align`
 * is at most 8 (allocator.h:9) and malloc gives at least 8. The context is
 * the environment: napi_adjust_external_memory is a basic-env call, so a
 * finalizer may free through it. */
static void *ta_napi_allocator_alloc(void *context, size_t size, size_t align) {
    assert(align <= 8);
    (void)align;
    void *block = malloc(size);
    if (block != NULL) {
        int64_t total;
        napi_adjust_external_memory((napi_env)context, (int64_t)size, &total);
    }
    return block;
}

static void ta_napi_allocator_free(void *context, void *ptr, size_t size) {
    if (ptr == NULL) return;
    free(ptr);
    int64_t total;
    napi_adjust_external_memory((napi_env)context, -(int64_t)size, &total);
}

ta_allocator ta_napi_allocator(napi_env env) {
    return (ta_allocator){env, ta_napi_allocator_alloc, ta_napi_allocator_free};
}

void ta_napi_arena_release(ta_growable_arena *arena, ta_growable_arena_mark mark, size_t cap) {
    ta_growable_arena_release(arena, mark);
    if (ta_growable_arena_position(arena).chunk == NULL && arena->reserved > cap)
        ta_growable_arena_free(arena); /* it may allocate again, as a new history */
}

/* ---- names and lengths ------------------------------------------------------ */

napi_status ta_napi_arities(napi_env env, napi_value object, const ta_napi_arity *arities) {
    for (const ta_napi_arity *arity = arities; arity->name != NULL; arity++) {
        napi_value function = NULL, name = NULL, length = NULL;
        napi_status status = napi_get_named_property(env, object, arity->name, &function);
        if (status == napi_ok) status = napi_create_string_utf8(env, arity->name, NAPI_AUTO_LENGTH, &name);
        if (status == napi_ok) status = napi_create_uint32(env, arity->length, &length);
        napi_property_descriptor properties[] = {
            {"name", NULL, NULL, NULL, NULL, name, napi_configurable, NULL},
            {"length", NULL, NULL, NULL, NULL, length, napi_configurable, NULL},
        };
        if (status == napi_ok) status = napi_define_properties(env, function, 2, properties);
        if (status != napi_ok) return status;
    }
    return napi_ok;
}

/* The arities of what the module exports, of the classes' static and
 * prototype methods (the typed methods' are methods.c's), and of the
 * views' (effects.c). */
static const ta_napi_arity ta_napi_exported_arities[] = {
    {"encode", 1},         {"decode", 1}, {"compileCharts", 3}, {"compileSystem", 3}, {"encodeHTTPPost", 1},
    {"parseHTTPRequest", 1}, {"Host", 2},   {"Address", 1},       {NULL, 0},
};
static const ta_napi_arity ta_napi_host_static_arities[] = {{"restore", 3}, {NULL, 0}};
static const ta_napi_arity ta_napi_host_arities[] = {
    {"addImage", 1}, {"chart", 1},     {"boot", 1},  {"spawn", 2},     {"send", 4},  {"fail", 2},
    {"sendMany", 1}, {"terminate", 1}, {"actorByName", 1}, {"sweep", 2}, {"hibernate", 1}, {"wake", 2},
    {"migrate", 1},  {NULL, 0},
};
static const ta_napi_arity ta_napi_address_static_arities[] = {{"fromSession", 2}, {"fromName", 2}, {NULL, 0}};
static const ta_napi_arity ta_napi_clock_arities[] = {{"increment", 1}, {NULL, 0}};

static napi_status ta_napi_module_arities(napi_env env, napi_value exports) {
    napi_value host, address, clock, prototype;
    napi_status status = ta_napi_arities(env, exports, ta_napi_exported_arities);
    if (status == napi_ok) status = napi_get_named_property(env, exports, "Host", &host);
    if (status == napi_ok) status = ta_napi_arities(env, host, ta_napi_host_static_arities);
    if (status == napi_ok) status = napi_get_named_property(env, host, "prototype", &prototype);
    if (status == napi_ok) status = ta_napi_arities(env, prototype, ta_napi_host_arities);
    if (status == napi_ok) status = napi_get_named_property(env, exports, "Address", &address);
    if (status == napi_ok) status = ta_napi_arities(env, address, ta_napi_address_static_arities);
    if (status == napi_ok) status = napi_get_named_property(env, exports, "SimulatedClock", &clock);
    if (status == napi_ok) status = napi_get_named_property(env, clock, "prototype", &prototype);
    if (status == napi_ok) status = ta_napi_arities(env, prototype, ta_napi_clock_arities);
    return status;
}

/* ---- TinyactorsError ------------------------------------------------------ */

/* The class index.d.ts declares, an Error subclass with read-only `code`,
 * `reason`, `path` and `status` (undefined when not given). It is defined
 * by a script, once per environment: a class made with napi_define_class
 * is not an Error (no stack, no [[ErrorData]]), and extending Error is
 * the language's own `class ... extends`. */
static const char ta_napi_error_source[] =
    "(class TinyactorsError extends Error {\n"
    "  constructor(message, options) {\n"
    "    super(message);\n"
    "    const given = options ?? {};\n"
    "    Object.defineProperties(this, {\n"
    "      code: { value: given.code, enumerable: true },\n"
    "      reason: { value: given.reason, enumerable: true },\n"
    "      path: { value: given.path, enumerable: true },\n"
    "      status: { value: given.status, enumerable: true },\n"
    "    });\n"
    "  }\n"
    "  get name() { return 'TinyactorsError'; }\n"
    "})";

static napi_status ta_napi_error_class(napi_env env, napi_value *out) {
    napi_value source;
    napi_status status = napi_create_string_utf8(env, ta_napi_error_source, sizeof ta_napi_error_source - 1, &source);
    if (status != napi_ok) return status;
    return napi_run_script(env, source, out);
}

ta_napi_instance *ta_napi_instance_of(napi_env env) {
    void *data = NULL;
    if (napi_get_instance_data(env, &data) != napi_ok || data == NULL) {
        napi_throw_error(env, NULL, "@tinyactors/node is not initialized in this environment");
        return NULL;
    }
    return (ta_napi_instance *)data;
}

napi_value ta_napi_throw(napi_env env, const ta_napi_refusal *refusal) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return NULL;
    napi_value class, arguments[2], status, error;
    const char *name = ta_status_name(refusal->status);
    if (napi_get_reference_value(env, instance->error, &class) != napi_ok ||
        napi_create_string_utf8(env, refusal->message, NAPI_AUTO_LENGTH, &arguments[0]) != napi_ok ||
        napi_create_object(env, &arguments[1]) != napi_ok ||
        napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &status) != napi_ok ||
        napi_set_named_property(env, arguments[1], "status", status) != napi_ok ||
        napi_new_instance(env, class, 2, arguments, &error) != napi_ok) {
        bool pending = false;
        napi_is_exception_pending(env, &pending);
        if (!pending) napi_throw_error(env, name, refusal->message);
        return NULL;
    }
    napi_throw(env, error);
    return NULL;
}

napi_value ta_napi_throw_core_error(napi_env env, const ta_napi_core_error *core) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return NULL;
    const char *name = ta_status_name(core->status);
    napi_value class, arguments[2], status, error, data, value;
    napi_valuetype type = napi_undefined;
    if (core->error != NULL && napi_typeof(env, core->error, &type) != napi_ok) return NULL;
    bool map = type == napi_object;
    if (napi_get_reference_value(env, instance->error, &class) != napi_ok ||
        napi_create_object(env, &arguments[1]) != napi_ok)
        return NULL;
    /* a reply's error has no status of a call: TA_OK leaves it undefined */
    if (core->status != TA_OK && (napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &status) != napi_ok ||
                                  napi_set_named_property(env, arguments[1], "status", status) != napi_ok))
        return NULL;
    if (map) {
        if (napi_get_named_property(env, core->error, "message", &arguments[0]) != napi_ok ||
            napi_get_named_property(env, core->error, "code", &value) != napi_ok ||
            napi_set_named_property(env, arguments[1], "code", value) != napi_ok ||
            napi_get_named_property(env, core->error, "data", &data) != napi_ok ||
            napi_typeof(env, data, &type) != napi_ok)
            return NULL;
        if (type == napi_object) {
            if (napi_get_named_property(env, data, "reason", &value) != napi_ok ||
                napi_set_named_property(env, arguments[1], "reason", value) != napi_ok ||
                napi_get_named_property(env, data, "path", &value) != napi_ok ||
                napi_set_named_property(env, arguments[1], "path", value) != napi_ok)
                return NULL;
        }
    } else if (napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &arguments[0]) != napi_ok)
        return NULL;
    if (napi_new_instance(env, class, 2, arguments, &error) != napi_ok) return NULL;
    napi_throw(env, error);
    return NULL;
}

/* ---- the instance --------------------------------------------------------- */

/* At the environment's teardown: the references, the arena's chunks and
 * the instance itself. */
static void ta_napi_instance_finalize(napi_env env, void *data, void *hint) {
    ta_napi_instance *instance = (ta_napi_instance *)data;
    (void)hint;
    if (instance->error != NULL) napi_delete_reference(env, instance->error);
    if (instance->object != NULL) napi_delete_reference(env, instance->object);
    if (instance->keys != NULL) napi_delete_reference(env, instance->keys);
    if (instance->turn != NULL) napi_delete_reference(env, instance->turn);
    if (instance->compiled != NULL) napi_delete_reference(env, instance->compiled);
    if (instance->compile_error != NULL) napi_delete_reference(env, instance->compile_error);
    if (instance->checker != NULL) napi_delete_reference(env, instance->checker);
    if (instance->resolve_error != NULL) napi_delete_reference(env, instance->resolve_error);
    napi_ref references[] = {instance->address, instance->send,   instance->entry, instance->migrated, instance->rejected,
                             instance->invocation, instance->crashed, instance->started, instance->start_failed,
                             instance->settled, instance->settled_rejected,
                             instance->vm,      instance->realm,  instance->realms, instance->in,     instance->stringify,
                             instance->application};
    for (size_t i = 0; i < sizeof references / sizeof references[0]; i++)
        if (references[i] != NULL) napi_delete_reference(env, references[i]);
    ta_growable_arena_free(&instance->arena);
    free(instance);
}

/* The instance of this environment, with its class and Object.prototype
 * referenced; NULL with an exception pending. */
static ta_napi_instance *ta_napi_instance_new(napi_env env) {
    ta_napi_instance *instance = (ta_napi_instance *)calloc(1, sizeof *instance);
    if (instance == NULL) {
        napi_throw_error(env, NULL, "@tinyactors/node: no memory for the module's instance");
        return NULL;
    }
    instance->env = env;
    instance->allocator = ta_napi_allocator(env);
    /* 16 KB chunks, as a host's: its cap (TA_NAPI_INSTANCE_ARENA_CAP) keeps
     * three of them, where one default chunk of 64 KB and its header would
     * be over it, given back after every call */
    ta_growable_arena_config config = {sizeof config, 0, 16384, &instance->allocator};
    ta_growable_arena_init(&instance->arena, &config);
    if (napi_set_instance_data(env, instance, ta_napi_instance_finalize, NULL) != napi_ok) {
        ta_napi_instance_finalize(env, instance, NULL);
        napi_throw_error(env, NULL, "@tinyactors/node: napi_set_instance_data failed");
        return NULL;
    }
    napi_value class, global, object, prototype, keys, handlers;
    if (ta_napi_error_class(env, &class) != napi_ok ||
        napi_create_reference(env, class, 1, &instance->error) != napi_ok ||
        napi_get_global(env, &global) != napi_ok ||
        napi_get_named_property(env, global, "Object", &object) != napi_ok ||
        napi_get_named_property(env, object, "prototype", &prototype) != napi_ok ||
        napi_create_reference(env, prototype, 1, &instance->object) != napi_ok ||
        napi_create_object(env, &keys) != napi_ok ||
        napi_create_string_utf8(env, "tinyactors.handlers", NAPI_AUTO_LENGTH, &handlers) != napi_ok ||
        napi_create_symbol(env, handlers, &handlers) != napi_ok ||
        napi_set_named_property(env, keys, "handlers", handlers) != napi_ok ||
        napi_create_reference(env, keys, 1, &instance->keys) != napi_ok) {
        bool pending = false;
        napi_is_exception_pending(env, &pending);
        if (!pending) napi_throw_error(env, NULL, "@tinyactors/node: module init failed");
        return NULL;
    }
    return instance;
}

static napi_value ta_napi_module_init(napi_env env, napi_value exports) {
    ta_napi_instance *instance = ta_napi_instance_new(env);
    if (instance == NULL) return NULL;
    napi_value class;
    if (napi_get_reference_value(env, instance->error, &class) != napi_ok) return NULL;
    napi_property_descriptor properties[] = {
        {"encode", NULL, ta_napi_encode, NULL, NULL, NULL, napi_enumerable, NULL},
        {"decode", NULL, ta_napi_decode, NULL, NULL, NULL, napi_enumerable, NULL},
        {"TinyactorsError", NULL, NULL, NULL, NULL, class, napi_enumerable, NULL},
    };
    if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) != napi_ok ||
        ta_napi_host_define(env, exports) != napi_ok || ta_napi_loop_define(env, exports) != napi_ok ||
        ta_napi_compile_define(env, exports) != napi_ok || ta_napi_address_define(env, exports) != napi_ok ||
        ta_napi_effects_define(env, exports) != napi_ok || ta_napi_http_define(env, exports) != napi_ok ||
        ta_napi_module_arities(env, exports) != napi_ok)
        return NULL;
    return exports;
}

/* Node-API's loader finds the module by the names this macro defines
 * (napi_register_module_v1, node_api_module_get_api_version_v1). */
NAPI_MODULE_INIT() {
    return ta_napi_module_init(env, exports);
}
