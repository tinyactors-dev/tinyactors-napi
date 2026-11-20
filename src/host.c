/* The Host (AGENTS.md, "The binding's memory"; docs/api-map.md): the class,
 * `new Host(config, options)` over ta_host_create, the host's arena with a
 * mark per call, its tables, `close()`, the dispose symbols, and the
 * finalizer; the inputs (addImage, chart, boot, spawn, send, fail,
 * sendMany, terminate, actorByName) and the payloads they make. The loop,
 * the effects and the typed methods are the files beside it.
 *
 * Who holds what (AGENTS.md, "Rules the suite cannot see"):
 *   - the wrapper (the Host's JavaScript object) holds the ta_napi_host
 *     (napi_wrap, type-tagged) and, under the instance's `handlers`
 *     symbol, the handlers object, so a handler that closes over its host
 *     makes a cycle the collector sees through: no strong napi_ref holds a
 *     handler;
 *   - the ta_napi_host holds a weak reference to the wrapper;
 *   - the finalizer frees what close() did not, with basic-env calls only
 *     (napi_delete_reference, napi_adjust_external_memory through the
 *     allocator) and no last take, so the same path serves the
 *     environment's teardown. */
#include "addon.h"

#include <string.h>

/* napi_type_tag_object's tag of a Host's wrapper. */
static const napi_type_tag ta_napi_host_tag = {0x7461686f73744e41ULL, 0x5049686f73743031ULL};

/* The room for a refused config's error (environment->error), in the
 * call's arena. */
#define TA_NAPI_CONFIG_ERROR 8192u

/* ---- the tables and their release ------------------------------------------ */

/* The tables a host keeps and, for each, whether its row holds a napi_ref
 * first (a chart's, a payload's and a loop's do, NULL for a primitive
 * payload in the native datamodel's `values`; a session's scope is in its
 * `scopes`, a pending row's handlers on the wrapper). */
typedef struct ta_napi_rows {
    ta_table *table;
    bool referenced;
} ta_napi_rows;

static void ta_napi_rows_release(napi_env env, const ta_napi_rows *rows) {
    ta_table *table = rows->table;
    for (uint32_t slot = 0; rows->referenced && slot < table->capacity; slot++) {
        napi_ref *reference = (napi_ref *)ta_table_at(table, slot);
        if (reference != NULL && *reference != NULL) napi_delete_reference(env, *reference);
    }
    ta_table_free(table);
}

static void ta_napi_tables_init(ta_napi_host *host) {
    const struct {
        ta_table *table;
        uint32_t row;
    } tables[] = {
        {&host->charts, sizeof(ta_napi_chart_row)},     {&host->sessions, sizeof(ta_napi_session_row)},
        {&host->payloads, sizeof(ta_napi_payload_row)}, {&host->loops, sizeof(ta_napi_loop_row)},
        {&host->pending, sizeof(ta_napi_pending_row)},
    };
    for (size_t i = 0; i < sizeof tables / sizeof tables[0]; i++) {
        ta_table_config config = {sizeof config, tables[i].row, &host->allocator};
        ta_table_init(tables[i].table, &config);
    }
}

/* Frees core's host and everything made with it, the struct aside: the
 * host first (its datamodel calls release rows), then the rows'
 * references, the tables, quickjs, the arena. Basic-env calls only, so a
 * finalizer may call it; pending handlers are dropped, never called. */
static void ta_napi_host_release(napi_env env, ta_napi_host *host) {
    host->native.freeing = true; /* its rows go with basic-env calls only */
    if (host->host != NULL) ta_host_free(host->host);
    host->host = NULL;
    /* the loop's references: a timer's handle is cleared by close() first
     * (ta_napi_loop_stop); a finalizer finds none, since a pending one holds
     * the wrapper */
    napi_ref *references[] = {&host->clock, &host->immediate, &host->timer, &host->idle_promise, &host->error};
    for (size_t i = 0; i < sizeof references / sizeof references[0]; i++) {
        if (*references[i] != NULL) napi_delete_reference(env, *references[i]);
        *references[i] = NULL;
    }
    const ta_napi_rows rows[] = {
        {&host->charts, true}, {&host->sessions, false}, {&host->payloads, true},
        {&host->loops, true},  {&host->pending, false},
    };
    for (size_t i = 0; i < sizeof rows / sizeof rows[0]; i++) ta_napi_rows_release(env, &rows[i]);
    if (host->quickjs != NULL) ta_datamodel_ecmascript_free(host->quickjs); /* after the host that used it */
    host->quickjs = NULL;
    ta_napi_native_free(&host->native);
    ta_growable_arena_free(&host->arena);
}

/* The wrapper's finalizer, and the end of a construction that failed:
 * whatever close() did not free, then the struct, through the allocator
 * that made it. */
static void ta_napi_host_finalize(napi_env env, void *data, void *hint) {
    ta_napi_host *host = (ta_napi_host *)data;
    (void)hint;
    ta_napi_host_release(env, host);
    if (host->self != NULL) napi_delete_reference(env, host->self);
    ta_allocator allocator = host->allocator;
    allocator.free(allocator.context, host, sizeof *host);
}

/* ---- a call ------------------------------------------------------------------ */

static napi_value ta_napi_host_refuse(napi_env env, const char *message) {
    return ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STATE, message});
}

ta_napi_host *ta_napi_host_of(napi_env env, const ta_napi_host_check *check) {
    bool tagged = false;
    napi_valuetype type = napi_undefined;
    if (check->self == NULL || napi_typeof(env, check->self, &type) != napi_ok || type != napi_object ||
        napi_check_object_type_tag(env, check->self, &ta_napi_host_tag, &tagged) != napi_ok || !tagged) {
        napi_throw_type_error(env, NULL, "not a Host");
        return NULL;
    }
    void *data = NULL;
    if (napi_unwrap(env, check->self, &data) != napi_ok || data == NULL) {
        napi_throw_type_error(env, NULL, "not a Host");
        return NULL;
    }
    ta_napi_host *host = (ta_napi_host *)data;
    if (host->env != env) { /* bindings.md, section 5: one thread per host */
        ta_napi_host_refuse(env, "a Host is called only from the environment that made it");
        return NULL;
    }
    if (check->open && host->host == NULL) {
        ta_napi_host_refuse(env, "the Host is closed");
        return NULL;
    }
    return host;
}

bool ta_napi_enter(napi_env env, napi_value self, ta_napi_call *call) {
    ta_napi_host *host = ta_napi_host_of(env, &(ta_napi_host_check){self, true});
    if (host == NULL) return false;
    call->host = host;
    call->mark = ta_growable_arena_position(&host->arena);
    host->depth++;
    return true;
}

/* close()'s work: the loop's timers cleared and a waiting idle()
 * rejected, the last take of telemetry (ta_napi_loop_stop), then the host
 * freed and the handlers dropped. An error of the last take stays kept on
 * the host, for close() or the turn to throw. */
static void ta_napi_host_close_now(napi_env env, ta_napi_host *host);

void ta_napi_leave(ta_napi_call *call) {
    ta_napi_host *host = call->host;
    ta_napi_arena_release(&host->arena, call->mark, TA_NAPI_HOST_ARENA_CAP);
    host->depth--;
    if (host->depth > 0 || host->turning) return;
    if (host->closing) {
        ta_napi_host_close_now(host->env, host);
        host->endings = NULL; /* nobody awaits a close a handler asked for */
    } else ta_napi_native_flush(&host->native); /* outside core, not nested: the last drops go */
}

/* ---- options ------------------------------------------------------------------- */

static void ta_napi_host_close_now(napi_env env, ta_napi_host *host) {
    host->closing = false;
    ta_napi_loop_stop(env, host);
    napi_value kept = NULL;
    if (host->error != NULL) napi_get_reference_value(env, host->error, &kept); /* outlives the release */
    ta_napi_host_release(env, host);
    if (kept != NULL) napi_create_reference(env, kept, 1, &host->error);
    napi_value self, undefined, key, keys;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    /* the handlers go with the host: nothing a closed host holds keeps them */
    if (instance != NULL && host->self != NULL && napi_get_reference_value(env, host->self, &self) == napi_ok &&
        self != NULL && napi_get_reference_value(env, instance->keys, &keys) == napi_ok &&
        napi_get_named_property(env, keys, "handlers", &key) == napi_ok &&
        napi_get_undefined(env, &undefined) == napi_ok)
        napi_set_property(env, self, key, undefined);
}

/* A string option compared with `names`: its index, or -1 with a
 * TypeError thrown naming `what`. */
typedef struct ta_napi_choice {
    const char *what;
    const char *const *names;
    int count;
} ta_napi_choice;

static int ta_napi_choose(napi_env env, napi_value value, const ta_napi_choice *choice) {
    char text[16];
    size_t length = 0;
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) == napi_ok && type == napi_string &&
        napi_get_value_string_utf8(env, value, text, sizeof text, &length) == napi_ok) {
        for (int i = 0; i < choice->count; i++)
            if (strlen(choice->names[i]) == length && memcmp(choice->names[i], text, length) == 0) return i;
    }
    napi_throw_type_error(env, NULL, choice->what);
    return -1;
}

/* A non-negative integer option, at most `limit`; false with a TypeError
 * naming `what`. */
typedef struct ta_napi_count {
    const char *what;
    double limit;
    double value; /* out */
} ta_napi_count;

static bool ta_napi_count_of(napi_env env, napi_value value, ta_napi_count *count) {
    napi_valuetype type = napi_undefined;
    double number = -1;
    if (napi_typeof(env, value, &type) == napi_ok && type == napi_number &&
        napi_get_value_double(env, value, &number) == napi_ok && number >= 0 && number <= count->limit &&
        number == (double)(int64_t)number) {
        count->value = number;
        return true;
    }
    napi_throw_type_error(env, NULL, count->what);
    return false;
}

/* Whether every own key of `object` is one of `names`; a TypeError naming
 * the first that is not (an option misspelled is refused, not ignored). */
typedef struct ta_napi_known {
    const char *what; /* "a Host option", "a quickjs option" */
    const char *const *names;
    uint32_t count;
} ta_napi_known;

static bool ta_napi_only_known(napi_env env, napi_value object, const ta_napi_known *known) {
    napi_value keys, key;
    uint32_t length = 0;
    if (napi_get_property_names(env, object, &keys) != napi_ok || napi_get_array_length(env, keys, &length) != napi_ok)
        return false;
    for (uint32_t i = 0; i < length; i++) {
        char name[32];
        size_t size = 0;
        if (napi_get_element(env, keys, i, &key) != napi_ok ||
            napi_get_value_string_utf8(env, key, name, sizeof name, &size) != napi_ok)
            return false;
        bool found = false;
        for (uint32_t j = 0; j < known->count && !found; j++)
            found = strlen(known->names[j]) == size && memcmp(known->names[j], name, size) == 0;
        if (!found) {
            napi_value message, error;
            char text[96];
            size_t at = 0;
            const char *parts[] = {"unknown ", known->what, ": ", name};
            for (size_t p = 0; p < 4; p++)
                for (const char *c = parts[p]; *c != '\0' && at + 1 < sizeof text; c++) text[at++] = *c;
            if (napi_create_string_utf8(env, text, at, &message) == napi_ok &&
                napi_create_type_error(env, NULL, message, &error) == napi_ok)
                napi_throw(env, error);
            return false;
        }
    }
    return true;
}

/* An option of `options` (undefined when absent or when options is). */
typedef struct ta_napi_options {
    napi_value object; /* NULL: none given */
} ta_napi_options;

static napi_value ta_napi_option(napi_env env, const ta_napi_options *options, const char *name) {
    napi_value value = NULL;
    if (options->object == NULL || napi_get_named_property(env, options->object, name, &value) != napi_ok)
        napi_get_undefined(env, &value);
    return value;
}

static bool ta_napi_is(napi_env env, napi_value value, napi_valuetype want) {
    napi_valuetype type = napi_undefined;
    return napi_typeof(env, value, &type) == napi_ok && type == want;
}

/* The quickjs option: the sandbox's limits (ta_datamodel_ecmascript_config,
 * datamodel_ecmascript.h). */
static bool ta_napi_quickjs_config(napi_env env, napi_value given, ta_datamodel_ecmascript_config *config) {
    static const char *const names[] = {"maxOps", "memoryLimit", "stackLimit", "realm"};
    static const char *const realms[] = {"auto", "isolated"};
    memset(config, 0, sizeof *config);
    config->size = sizeof *config;
    config->realm = TA_DATAMODEL_ECMASCRIPT_REALM_AUTO;
    if (ta_napi_is(env, given, napi_undefined)) return true;
    if (!ta_napi_is(env, given, napi_object)) {
        napi_throw_type_error(env, NULL, "quickjs is an object of the sandbox's limits");
        return false;
    }
    if (!ta_napi_only_known(env, given, &(ta_napi_known){"quickjs option", names, 4})) return false;
    ta_napi_options options = {given};
    napi_value value = ta_napi_option(env, &options, "maxOps");
    ta_napi_count count = {"quickjs.maxOps is an integer from 0 to 2^32-1", 4294967295.0, 0};
    if (!ta_napi_is(env, value, napi_undefined)) {
        if (!ta_napi_count_of(env, value, &count)) return false;
        config->max_ops = (uint32_t)count.value;
    }
    value = ta_napi_option(env, &options, "memoryLimit");
    count = (ta_napi_count){"quickjs.memoryLimit is a safe integer of bytes, 0 or more", 9007199254740991.0, 0};
    if (!ta_napi_is(env, value, napi_undefined)) {
        if (!ta_napi_count_of(env, value, &count)) return false;
        config->memory_limit = (size_t)count.value;
    }
    value = ta_napi_option(env, &options, "stackLimit");
    count = (ta_napi_count){"quickjs.stackLimit is a safe integer of bytes, 0 or more", 9007199254740991.0, 0};
    if (!ta_napi_is(env, value, napi_undefined)) {
        if (!ta_napi_count_of(env, value, &count)) return false;
        config->stack_limit = (size_t)count.value;
    }
    value = ta_napi_option(env, &options, "realm");
    if (!ta_napi_is(env, value, napi_undefined)) {
        int realm = ta_napi_choose(env, value, &(ta_napi_choice){"quickjs.realm is \"auto\" or \"isolated\"", realms, 2});
        if (realm < 0) return false;
        config->realm = realm == 0 ? TA_DATAMODEL_ECMASCRIPT_REALM_AUTO : TA_DATAMODEL_ECMASCRIPT_REALM_ISOLATED;
    }
    return true;
}

/* The handlers given as options, checked: each a function or absent;
 * ioProcessors and services objects of functions. Kept by name in
 * `handlers`, the object the wrapper holds, with the Map of the invoked
 * services that run (`invocations`). */
static bool ta_napi_handlers_read(napi_env env, const ta_napi_options *options, napi_value handlers) {
    static const char *const functions[] = {"log",  "transport", "telemetry",    "wake", "migrated",
                                            "migrationDone", "done", "error", "handlerError", "idle"};
    static const char *const maps[] = {"ioProcessors", "services"};
    for (size_t i = 0; i < sizeof functions / sizeof functions[0]; i++) {
        napi_value value = ta_napi_option(env, options, functions[i]);
        if (ta_napi_is(env, value, napi_undefined)) continue;
        if (!ta_napi_is(env, value, napi_function)) {
            napi_throw_type_error(env, NULL, "a Host's handler is a function");
            return false;
        }
        if (napi_set_named_property(env, handlers, functions[i], value) != napi_ok) return false;
    }
    for (size_t i = 0; i < sizeof maps / sizeof maps[0]; i++) {
        napi_value value = ta_napi_option(env, options, maps[i]), names, name, handler;
        uint32_t count = 0;
        if (ta_napi_is(env, value, napi_undefined)) continue;
        if (!ta_napi_is(env, value, napi_object) || napi_get_property_names(env, value, &names) != napi_ok ||
            napi_get_array_length(env, names, &count) != napi_ok) {
            napi_throw_type_error(env, NULL, "ioProcessors and services are objects of a type -> its handler");
            return false;
        }
        for (uint32_t j = 0; j < count; j++) {
            napi_value receive = NULL;
            if (napi_get_element(env, names, j, &name) != napi_ok || napi_get_property(env, value, name, &handler) != napi_ok)
                return false;
            if (i == 0 ? !ta_napi_is(env, handler, napi_object) || napi_get_named_property(env, handler, "receive", &receive) != napi_ok ||
                             !ta_napi_is(env, receive, napi_function)
                       : !ta_napi_is(env, handler, napi_function)) {
                napi_throw_type_error(env, NULL, i == 0 ? "ioProcessors is an object of a type -> its processor, an object with receive(send)"
                                                        : "services is an object of a type -> its handler, a function");
                return false;
            }
        }
        if (napi_set_named_property(env, handlers, maps[i], value) != napi_ok) return false;
    }
    /* the invoked services that run, by core's (segment, token), and the
     * last invocation's strings, shared with the next (effects.c) */
    napi_value global, map_class, map, last;
    return napi_get_global(env, &global) == napi_ok && napi_get_named_property(env, global, "Map", &map_class) == napi_ok &&
           napi_new_instance(env, map_class, 0, NULL, &map) == napi_ok &&
           napi_set_named_property(env, handlers, "invocations", map) == napi_ok &&
           napi_create_array_with_length(env, 3, &last) == napi_ok && napi_set_named_property(env, handlers, "last", last) == napi_ok;
}

/* ---- creation ------------------------------------------------------------------------ */

/* host.config, posted once before the host is handed out (no batch is
 * open: bindings.md, section 3), drained at once: the effective config,
 * or NULL with an exception pending. */
static napi_value ta_napi_host_config(napi_env env, ta_napi_host *host) {
    unsigned char room[64];
    ta_cbor_writer writer;
    ta_cbor_writer_init(&writer, (ta_buffer){room, sizeof room, 0}, &host->arena_allocator);
    ta_cbor_write_map(&writer, 2);
    ta_cbor_write_text(&writer, ta_string("method"));
    ta_cbor_write_text(&writer, ta_string("host.config"));
    ta_cbor_write_text(&writer, ta_string("id"));
    ta_cbor_write_uint(&writer, 0);
    ta_bytes message;
    ta_status status = ta_cbor_writer_bytes(&writer, &message);
    if (status == TA_OK) status = ta_host_post(host->host, message);
    ta_cbor_writer_free(&writer);
    if (status != TA_OK) return ta_napi_throw(env, &(ta_napi_refusal){status, "host.config was refused"});
    ta_napi_drain_state drain = {host, NULL, false};
    ta_napi_drain(env, &drain);
    if (ta_napi_throw_kept(env, host)) return NULL;
    napi_value result = NULL;
    if (drain.reply == NULL || !ta_napi_is(env, drain.reply, napi_object) ||
        napi_get_named_property(env, drain.reply, "result", &result) != napi_ok || !ta_napi_is(env, result, napi_object))
        return ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STATE, "host.config gave no config"});
    return result;
}

/* What the effective config tells the addon, read once: the tick rate,
 * whether an encoder runs, and the I/O processors, each type's handler at
 * its number (`processors[i + 1]` for ioProcessors[i]; 0 the transport)
 * and its type (`types[i + 1]`, a Send's `type`; 0 undefined).
 * A type options.ioProcessors names that the config lacks is refused. */
typedef struct ta_napi_effective {
    napi_value config;   /* the effective config */
    napi_value handlers; /* gets `processors` */
} ta_napi_effective;

static bool ta_napi_host_read_config(napi_env env, ta_napi_host *host, const ta_napi_effective *effective) {
    napi_value system, rate, entries, processors, types, transport, given, type, handler, undefined;
    double ticks = 0;
    bool has = false;
    if (napi_get_named_property(env, effective->config, "system", &system) != napi_ok || !ta_napi_is(env, system, napi_object) ||
        napi_get_named_property(env, system, "ticksPerSecond", &rate) != napi_ok || !ta_napi_is(env, rate, napi_number) ||
        napi_get_value_double(env, rate, &ticks) != napi_ok || ticks < 1) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STATE, "host.config gave no system.ticksPerSecond"});
        return false;
    }
    host->ticks_per_second = (uint64_t)ticks;
    if (napi_has_named_property(env, effective->config, "telemetry", &has) != napi_ok) return false;
    host->encoder = has;
    uint32_t count = 0;
    if (napi_get_named_property(env, effective->config, "ioProcessors", &entries) != napi_ok) return false;
    bool array = false;
    if (napi_is_array(env, entries, &array) != napi_ok) return false;
    if (array && napi_get_array_length(env, entries, &count) != napi_ok) return false;
    if (napi_get_named_property(env, effective->handlers, "ioProcessors", &given) != napi_ok ||
        napi_get_named_property(env, effective->handlers, "transport", &transport) != napi_ok ||
        napi_create_array_with_length(env, (size_t)count + 1, &processors) != napi_ok ||
        napi_create_array_with_length(env, (size_t)count + 1, &types) != napi_ok ||
        napi_get_undefined(env, &undefined) != napi_ok || napi_set_element(env, processors, 0, transport) != napi_ok ||
        napi_set_element(env, types, 0, undefined) != napi_ok)
        return false;
    bool handlers = ta_napi_is(env, given, napi_object);
    uint32_t found = 0;
    for (uint32_t i = 0; i < count; i++) {
        napi_value entry;
        if (napi_get_element(env, entries, i, &entry) != napi_ok) return false;
        handler = undefined;
        type = undefined;
        if (ta_napi_is(env, entry, napi_object) && napi_get_named_property(env, entry, "type", &type) != napi_ok)
            return false;
        bool typed = ta_napi_is(env, type, napi_string);
        if (napi_set_element(env, types, i + 1, typed ? type : undefined) != napi_ok) return false;
        if (handlers && typed) {
            bool own = false;
            if (napi_has_own_property(env, given, type, &own) != napi_ok) return false;
            if (own) {
                if (napi_get_property(env, given, type, &handler) != napi_ok) return false;
                found++;
            }
        }
        if (napi_set_element(env, processors, i + 1, handler) != napi_ok) return false;
    }
    if (handlers) {
        napi_value names;
        uint32_t named = 0;
        if (napi_get_property_names(env, given, &names) != napi_ok || napi_get_array_length(env, names, &named) != napi_ok)
            return false;
        if (named != found) {
            napi_throw_type_error(env, NULL, "ioProcessors names a type the config's ioProcessors does not have");
            return false;
        }
    }
    host->processors = count;
    return napi_set_named_property(env, effective->handlers, "processors", processors) == napi_ok &&
           napi_set_named_property(env, effective->handlers, "types", types) == napi_ok;
}

/* A refused config (ta_host_create, ta_host_restore): core's error, read
 * from the room it wrote, thrown. */
typedef struct ta_napi_refused_config {
    ta_buffer refusal;
    ta_status status;
} ta_napi_refused_config;

static void ta_napi_host_refused(napi_env env, const ta_napi_refused_config *refused) {
    napi_value reply = NULL, error = NULL;
    const ta_buffer *refusal = &refused->refusal;
    if (refusal->length > 0 && refusal->length <= refusal->capacity) {
        reply = ta_napi_value_read(env, (ta_bytes){refusal->pointer, refusal->length});
        if (reply == NULL) {
            napi_value ignored;
            napi_get_and_clear_last_exception(env, &ignored);
        } else if (!ta_napi_is(env, reply, napi_object) || napi_get_named_property(env, reply, "error", &error) != napi_ok)
            error = NULL;
    }
    ta_napi_throw_core_error(env, &(ta_napi_core_error){error, refused->status});
}

/* 64 random bits into `bits`: globalThis.crypto's getRandomValues, which
 * Node.js and Bun have. False when it is missing or throws (its exception
 * cleared). */
static bool ta_napi_random(napi_env env, uint64_t *bits) {
    napi_value global, crypto, get, buffer, array, result;
    void *data = NULL;
    bool ok = napi_get_global(env, &global) == napi_ok &&
              napi_get_named_property(env, global, "crypto", &crypto) == napi_ok &&
              napi_get_named_property(env, crypto, "getRandomValues", &get) == napi_ok &&
              napi_create_arraybuffer(env, sizeof *bits, &data, &buffer) == napi_ok &&
              napi_create_typedarray(env, napi_uint8_array, sizeof *bits, buffer, 0, &array) == napi_ok &&
              napi_call_function(env, crypto, get, 1, &array, &result) == napi_ok;
    bool pending = false;
    if (!ok && napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_value error;
        napi_get_and_clear_last_exception(env, &error);
    }
    if (ok) memcpy(bits, data, sizeof *bits);
    return ok;
}

/* 64 random bits for the host's identity (ta_host_environment.nonce), so
 * its hibernation blobs wake in no other host; 0 without a source: the
 * system id alone tells hosts apart. */
static uint64_t ta_napi_host_nonce(napi_env env) {
    uint64_t nonce = 0;
    return ta_napi_random(env, &nonce) ? nonce : 0;
}

/* Object.assign({}, `from`), or a new object for `from` undefined. */
static bool ta_napi_shallow_copy(napi_env env, napi_value from, napi_value *out) {
    napi_value global, object, assign, arguments[2];
    if (napi_create_object(env, &arguments[0]) != napi_ok) return false;
    *out = arguments[0];
    if (ta_napi_is(env, from, napi_undefined)) return true;
    arguments[1] = from;
    return napi_get_global(env, &global) == napi_ok && napi_get_named_property(env, global, "Object", &object) == napi_ok &&
           napi_get_named_property(env, object, "assign", &assign) == napi_ok &&
           napi_call_function(env, object, assign, 2, arguments, out) == napi_ok;
}

/* The config ta_host_create gets: the caller's, or, when it gives no
 * system.traceSeed, a copy with a random one (the language layer picks
 * the seed, the maintainer, 2026-11-18), so hosts start different trace
 * ids; a seed the caller sets is kept, and so reproduces. A config core
 * will refuse anyway (not an object, a `system` that is not one) and a
 * runtime without crypto.getRandomValues keep the config as it is. False
 * with an exception pending. */
static bool ta_napi_config_seeded(napi_env env, napi_value config, napi_value *out) {
    napi_value system, seed, copy, system_copy, value;
    bool array = false, has = false;
    uint64_t bits = 0;
    *out = config;
    if (!ta_napi_is(env, config, napi_object) || napi_is_array(env, config, &array) != napi_ok || array) return true;
    if (napi_get_named_property(env, config, "system", &system) != napi_ok) return false;
    if (!ta_napi_is(env, system, napi_undefined)) {
        if (!ta_napi_is(env, system, napi_object) || napi_is_array(env, system, &array) != napi_ok || array) return true;
        if (napi_has_named_property(env, system, "traceSeed", &has) != napi_ok) return false;
        if (has) {
            if (napi_get_named_property(env, system, "traceSeed", &seed) != napi_ok) return false;
            if (!ta_napi_is(env, seed, napi_undefined)) return true; /* the caller's */
        }
    }
    if (!ta_napi_random(env, &bits)) return true;
    if (!ta_napi_shallow_copy(env, config, &copy) || !ta_napi_shallow_copy(env, system, &system_copy) ||
        napi_create_bigint_uint64(env, bits, &value) != napi_ok ||
        napi_set_named_property(env, system_copy, "traceSeed", value) != napi_ok ||
        napi_set_named_property(env, copy, "system", system_copy) != napi_ok)
        return false;
    *out = copy;
    return true;
}

/* ta_host_create with the config as CBOR in the call's arena and the
 * environment's one datamodel; a refused config throws core's error. */
static bool ta_napi_host_create(napi_env env, ta_napi_host *host, napi_value config) {
    ta_growable_arena_mark mark = ta_growable_arena_position(&host->arena);
    ta_cbor_writer writer;
    ta_cbor_writer_init(&writer, (ta_buffer){NULL, 0, 0}, &host->arena_allocator);
    bool ok = ta_napi_config_seeded(env, config, &config) &&
              ta_napi_value_write(env, config, &(ta_napi_writing){&writer, &host->arena, false, NULL, false});
    ta_bytes cbor = {NULL, 0};
    ta_status status = ok ? ta_cbor_writer_bytes(&writer, &cbor) : TA_OK;
    if (ok && status != TA_OK) {
        ta_napi_throw(env, &(ta_napi_refusal){status, "the config could not be written"});
        ok = false;
    }
    if (ok) {
        ta_buffer refusal = {ta_growable_arena_alloc(&host->arena, TA_NAPI_CONFIG_ERROR, 8), TA_NAPI_CONFIG_ERROR, 0};
        ta_host_environment environment = {sizeof environment, 1, host->datamodels, host->allocator, NULL,
                                           refusal.pointer != NULL ? &refusal : NULL, ta_napi_host_nonce(env)};
        status = ta_host_create(cbor, &environment, &host->host);
        if (status != TA_OK) {
            host->host = NULL;
            ta_napi_host_refused(env, &(ta_napi_refused_config){refusal, status});
            ok = false;
        }
    }
    ta_cbor_writer_free(&writer);
    ta_napi_arena_release(&host->arena, mark, TA_NAPI_HOST_ARENA_CAP);
    return ok;
}

/* ---- a restore: a snapshot's pack instead of an empty host -------------------------- */

/* The label of the datamodel state this addon packs: a pack another
 * program wrote holds state that is not ours. */
static const char ta_napi_snapshot_label[] = "tinyactors-napi";
/* @tinyactors/wasm's label (wasm/src/host.c): its packs are a wasm32
 * build's memory, which this build does not restore. */
static const char ta_napi_wasm_label[] = "tinyactors-wasm";

/* The keys of the datamodel state: the one datamodel a host holds. */
static const char *const ta_napi_state_keys[] = {"native", "quickjs"};

/* Host.restore's construction of a Host (the instance's `restoring`):
 * what the static method passes the constructor, and what the restore
 * gives back for the checks after the host is made.
 *
 *   snapshot   the argument, read after the config was written (a getter
 *              of the config may run JavaScript), and then not again;
 *   config     the constructor's first argument; `effective` the
 *              restored host's effective config;
 *   copy       an 8-aligned copy of an unaligned pack, the method's to
 *              free (through `allocator`);
 *   time       the host's time when it was packed;
 *   system_id  the pack's system id, copied (the pack is not read after
 *              the restore), the method's to free. */
typedef struct ta_napi_restoring {
    napi_value snapshot, config;
    napi_value effective; /* the restored host's effective config, for the system id's check */
    ta_allocator allocator;
    ta_buffer copy;
    ta_time time;
    ta_buffer system_id;
} ta_napi_restoring;

/* The datamodel's state back: {"native": its map} or {"quickjs": its
 * bytes}, the key the host's datamodel; false with an exception pending. */
static bool ta_napi_host_restore_state(napi_env env, ta_napi_host *host, ta_bytes state) {
    ta_cbor_reader reader;
    ta_cbor_item map, key, value;
    ta_cbor_reader_init(&reader, state);
    const char *mine = ta_napi_state_keys[host->datamodel];
    if (ta_cbor_read(&reader, &map) != 1 || map.kind != TA_CBOR_MAP || map.count != 1 || ta_cbor_read(&reader, &key) != 1 ||
        key.kind != TA_CBOR_TEXT) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, "not a snapshot of a Host"});
        return false;
    }
    if (key.bytes.length != strlen(mine) || memcmp(key.bytes.pointer, mine, key.bytes.length) != 0) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, host->datamodel == TA_NAPI_DATAMODEL_NATIVE
                                                                    ? "the snapshot is of a host on quickjs: restore it with "
                                                                      "datamodel \"quickjs\""
                                                                    : "the snapshot is of a host on the native datamodel: "
                                                                      "restore it with datamodel \"native\""});
        return false;
    }
    if (host->datamodel == TA_NAPI_DATAMODEL_NATIVE)
        return ta_napi_native_restore(&host->native, (ta_bytes){(const char *)state.pointer + reader.at, state.length - reader.at});
    ta_status status = ta_cbor_read(&reader, &value) == 1 && value.kind == TA_CBOR_BYTES
                           ? ta_datamodel_ecmascript_restore(host->quickjs, value.bytes)
                           : TA_ERROR_INVALID;
    if (status != TA_OK) ta_napi_throw(env, &(ta_napi_refusal){status, "the quickjs datamodel's state does not restore"});
    return status == TA_OK;
}

/* ta_host_restore of the snapshot (ta_host_snapshot_unpack, its images),
 * with the config as CBOR in the call's arena as for ta_host_create, then
 * the datamodel's state back before any run. A refused config throws
 * core's error; a pack another program labelled, or bytes that are no
 * pack, TA_ERROR_INVALID. */
static bool ta_napi_host_restore_core(napi_env env, ta_napi_host *host, ta_napi_restoring *restoring) {
    ta_growable_arena_mark mark = ta_growable_arena_position(&host->arena);
    ta_cbor_writer writer;
    ta_cbor_writer_init(&writer, (ta_buffer){NULL, 0, 0}, &host->arena_allocator);
    bool ok = ta_napi_value_write(env, restoring->config, &(ta_napi_writing){&writer, &host->arena, false, NULL, false});
    ta_bytes cbor = {NULL, 0};
    ta_status status = ok ? ta_cbor_writer_bytes(&writer, &cbor) : TA_OK;
    if (ok && status != TA_OK) {
        ta_napi_throw(env, &(ta_napi_refusal){status, "the config could not be written"});
        ok = false;
    }
    /* the pack, read now that no getter runs before the restore ends */
    ta_napi_bytes snapshot = {"restore takes the snapshot's bytes: a Uint8Array or an ArrayBuffer", {NULL, 0}};
    ok = ok && ta_napi_bytes_of(env, restoring->snapshot, &snapshot);
    ta_bytes pack = snapshot.view;
    if (ok && ((uintptr_t)pack.pointer & 7u) != 0) { /* the pack's parts are 8-aligned when the pack is */
        restoring->copy = (ta_buffer){restoring->allocator.alloc(restoring->allocator.context, pack.length, 8), pack.length, 0};
        if (restoring->copy.pointer == NULL) {
            ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for an aligned copy of the snapshot"});
            ok = false;
        } else {
            memcpy(restoring->copy.pointer, pack.pointer, pack.length);
            pack = (ta_bytes){restoring->copy.pointer, pack.length};
        }
    }
    ta_host_snapshot_contents contents;
    memset(&contents, 0, sizeof contents);
    contents.size = sizeof contents;
    if (ok) {
        status = ta_host_snapshot_unpack(pack, &contents);
        bool wasm = status == TA_OK && contents.datamodel.length == sizeof ta_napi_wasm_label - 1 &&
                    memcmp(contents.datamodel.pointer, ta_napi_wasm_label, contents.datamodel.length) == 0;
        if (status == TA_OK && (contents.datamodel.length != sizeof ta_napi_snapshot_label - 1 ||
                                memcmp(contents.datamodel.pointer, ta_napi_snapshot_label, contents.datamodel.length) != 0))
            status = TA_ERROR_INVALID; /* a pack another program wrote: its datamodel's state is not ours */
        if (status != TA_OK) {
            const char *message = wasm ? "a snapshot of @tinyactors/wasm: a snapshot restores only in the package that made it, of the "
                                         "same version (it is the host's memory); move actors between the packages as hibernation blobs"
                                       : "not a snapshot of a Host of @tinyactors/node";
            ta_napi_throw(env, &(ta_napi_refusal){status, message});
            ok = false;
        }
    }
    ta_bytes *images = ok && contents.image_count ? ta_growable_arena_alloc(&host->arena, sizeof(ta_bytes) * contents.image_count, 8)
                                                  : NULL;
    if (ok && contents.image_count && images == NULL) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the snapshot's images"});
        ok = false;
    }
    for (uint32_t i = 0; ok && i < contents.image_count; i++) images[i] = ta_host_snapshot_image(pack, i);
    if (ok) {
        ta_buffer refusal = {ta_growable_arena_alloc(&host->arena, TA_NAPI_CONFIG_ERROR, 8), TA_NAPI_CONFIG_ERROR, 0};
        ta_host_environment environment = {sizeof environment, 1, host->datamodels, host->allocator, NULL,
                                           refusal.pointer != NULL ? &refusal : NULL, 0}; /* the snapshot's identity */
        ta_host_snapshot_input input = {cbor, {contents.host, contents.host_length}, images, contents.image_count, 0};
        status = ta_host_restore(&environment, &input, &host->host);
        if (status != TA_OK) {
            host->host = NULL;
            ta_napi_host_refused(env, &(ta_napi_refused_config){refusal, status});
            ok = false;
        }
    }
    if (ok) { /* what is checked once the host is made */
        restoring->time = contents.time;
        size_t length = contents.system_id.length;
        restoring->system_id = (ta_buffer){restoring->allocator.alloc(restoring->allocator.context, length + 1, 8), length + 1, length};
        if (restoring->system_id.pointer == NULL) {
            ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the snapshot's system id"});
            ok = false;
        } else {
            if (length > 0) memcpy(restoring->system_id.pointer, contents.system_id.pointer, length);
            ((char *)restoring->system_id.pointer)[length] = '\0';
        }
    }
    /* the datamodel's handles valid again before the first run */
    ok = ok && ta_napi_host_restore_state(env, host, (ta_bytes){contents.state, contents.state_length});
    ta_cbor_writer_free(&writer);
    ta_napi_arena_release(&host->arena, mark, TA_NAPI_HOST_ARENA_CAP);
    return ok;
}

/* Whether the effective config's systemID is the snapshot's (its I/O
 * processors and tick rate come from the config too, not from the pack);
 * its text in the host's arena, under the caller's mark. */
static bool ta_napi_host_same_system(napi_env env, ta_napi_host *host, const ta_napi_restoring *restoring) {
    const ta_buffer *mine = &restoring->system_id;
    napi_value id;
    ta_napi_text text = {&host->arena, "systemID is a string", {NULL, 0}};
    if (napi_get_named_property(env, restoring->effective, "systemID", &id) == napi_ok && ta_napi_is(env, id, napi_string) &&
        ta_napi_text_of(env, id, &text) && text.view.length == mine->length &&
        memcmp(text.view.pointer, mine->pointer, mine->length) == 0)
        return true;
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
    char said[384];
    const char *parts[] = {"the snapshot is of system ", (const char *)mine->pointer, ": restore it with the config it was taken with"};
    size_t at = 0;
    for (size_t p = 0; p < 3; p++)
        for (const char *c = parts[p]; *c != '\0' && at + 1 < sizeof said; c++) said[at++] = *c;
    said[at] = '\0';
    ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, said});
    return false;
}

/* The datamodel option: "native" (the default) or "quickjs", the one
 * "ecmascript" datamodel the host holds (docs/plan.xml, decision
 * d-datamodel). */
static bool ta_napi_host_datamodel(napi_env env, ta_napi_host *host, const ta_napi_options *options) {
    static const char *const names[] = {"native", "quickjs"};
    napi_value value = ta_napi_option(env, options, "datamodel"), limits = ta_napi_option(env, options, "quickjs");
    int kind = TA_NAPI_DATAMODEL_NATIVE;
    if (!ta_napi_is(env, value, napi_undefined)) {
        kind = ta_napi_choose(env, value, &(ta_napi_choice){"datamodel is \"native\" or \"quickjs\"", names, 2});
        if (kind < 0) return false;
    }
    host->datamodel = (ta_napi_datamodel_kind)kind;
    if (kind == TA_NAPI_DATAMODEL_NATIVE) {
        if (!ta_napi_is(env, limits, napi_undefined)) {
            napi_throw_type_error(env, NULL, "quickjs's limits are for a host with datamodel \"quickjs\"");
            return false;
        }
        host->datamodels[0] = (ta_datamodel_binding){ta_napi_native_vtable(), &host->native};
        return true;
    }
    ta_datamodel_ecmascript_config config;
    if (!ta_napi_quickjs_config(env, limits, &config)) return false;
    host->quickjs = ta_datamodel_ecmascript_new(&config);
    if (host->quickjs == NULL) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the quickjs datamodel"});
        return false;
    }
    host->datamodels[0] = ta_datamodel_ecmascript_binding(host->quickjs);
    return true;
}

/* The handlers object on the wrapper, under the instance's symbol: not
 * enumerable, not configurable; writable, so close() drops it. */
static bool ta_napi_host_keep(napi_env env, napi_value self, napi_value handlers) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value keys, key;
    if (instance == NULL || napi_get_reference_value(env, instance->keys, &keys) != napi_ok ||
        napi_get_named_property(env, keys, "handlers", &key) != napi_ok)
        return false;
    napi_property_descriptor property = {NULL, key, NULL, NULL, NULL, handlers, napi_writable, NULL};
    return napi_define_properties(env, self, 1, &property) == napi_ok;
}

/* new Host(config, options) */
static napi_value ta_napi_host_new(napi_env env, napi_callback_info info) {
    static const char *const known[] = {"ioProcessors", "transport", "log", "clock", "telemetry", "wake",
                                        "migrated", "migrationDone", "services", "datamodel", "quickjs",
                                        "done", "error", "handlerError", "idle"};
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, self, target, handlers, undefined;
    /* Host.restore's snapshot, taken before any JavaScript runs: a Host made
     * meanwhile (a getter's) restores nothing */
    ta_napi_instance *instance = ta_napi_instance_of(env);
    ta_napi_restoring *restoring = instance != NULL ? instance->restoring : NULL;
    if (instance != NULL) instance->restoring = NULL;
    if (napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok || napi_get_new_target(env, info, &target) != napi_ok)
        return NULL;
    if (target == NULL) {
        napi_throw_type_error(env, NULL, "Host is a class: new Host(charts, options)");
        return NULL;
    }
    if (napi_get_undefined(env, &undefined) != napi_ok) return NULL;
    if (argc < 1) argv[0] = undefined;
    ta_napi_options options = {NULL};
    if (argc >= 2 && !ta_napi_is(env, argv[1], napi_undefined)) {
        if (!ta_napi_is(env, argv[1], napi_object)) {
            napi_throw_type_error(env, NULL, "a Host's options are an object");
            return NULL;
        }
        options.object = argv[1];
        if (!ta_napi_only_known(env, argv[1], &(ta_napi_known){"Host option", known, sizeof known / sizeof known[0]}))
            return NULL;
    }
    if (napi_create_object(env, &handlers) != napi_ok || !ta_napi_handlers_read(env, &options, handlers)) return NULL;

    ta_allocator allocator = ta_napi_allocator(env);
    ta_napi_host *host = (ta_napi_host *)allocator.alloc(allocator.context, sizeof *host, 8);
    if (host == NULL) return ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for a Host"});
    memset(host, 0, sizeof *host);
    host->env = env;
    host->native.host = host;
    host->allocator = allocator;
    host->deadline = UINT64_MAX;
    host->telemetry = !ta_napi_is(env, ta_napi_option(env, &options, "telemetry"), napi_undefined);
    ta_growable_arena_config arena = {sizeof arena, 0, 16384, &host->allocator};
    ta_growable_arena_init(&host->arena, &arena);
    host->arena_allocator = ta_growable_arena_allocator(&host->arena);
    ta_growable_arena_config scratch = {sizeof scratch, 0, 0, &host->allocator};
    ta_growable_arena_init(&host->native.scratch, &scratch);
    ta_napi_tables_init(host);

    napi_value effective = NULL;
    if (restoring != NULL) restoring->config = argv[0];
    bool ok = ta_napi_host_datamodel(env, host, &options) &&
              (restoring != NULL ? ta_napi_host_restore_core(env, host, restoring) : ta_napi_host_create(env, host, argv[0]));
    if (ok) {
        /* the config read in a call's frame: a mark, so its scratch goes */
        ta_growable_arena_mark mark = ta_growable_arena_position(&host->arena);
        effective = ta_napi_host_config(env, host);
        if (restoring != NULL) restoring->effective = effective;
        ok = effective != NULL &&
             ta_napi_host_read_config(env, host, &(ta_napi_effective){effective, handlers}) &&
             (restoring == NULL || ta_napi_host_same_system(env, host, restoring));
        ta_napi_arena_release(&host->arena, mark, TA_NAPI_HOST_ARENA_CAP);
    }
    ok = ok && ta_napi_host_keep(env, self, handlers) &&
         napi_wrap(env, self, host, ta_napi_host_finalize, NULL, NULL) == napi_ok;
    if (!ok) {
        ta_napi_host_finalize(env, host, NULL);
        return NULL;
    }
    /* wrapped: from here the finalizer frees it */
    if (napi_type_tag_object(env, self, &ta_napi_host_tag) != napi_ok ||
        napi_create_reference(env, self, 0, &host->self) != napi_ok ||
        !ta_napi_clock_attach(env, host, ta_napi_option(env, &options, "clock")))
        return NULL;
    if (restoring != NULL) ta_napi_clock_resume(env, host, restoring->time); /* on from the snapshot's time */
    ta_napi_advance(env, host); /* the host's clock starts now, not at 0 */
    return self;
}

/* ---- methods ----------------------------------------------------------------------- */

static napi_value ta_napi_this(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) return NULL;
    return self;
}

/* close()'s work for `self`: NULL with the last take's error thrown. From
 * a handler (a call or a turn on the stack) it is done when the outermost
 * one returns. host->endings holds, after it, what the last take's
 * handlers returned (NULL for none). */
static napi_value ta_napi_host_close_self(napi_env env, napi_value self, ta_napi_host **closed) {
    ta_napi_host *host = ta_napi_host_of(env, &(ta_napi_host_check){self, false});
    if (host == NULL) return NULL;
    *closed = host;
    host->endings = NULL;
    napi_value undefined;
    if (napi_get_undefined(env, &undefined) != napi_ok) return NULL;
    if (host->host == NULL) return undefined;
    if (host->depth > 0 || host->turning) host->closing = true;
    else ta_napi_host_close_now(env, host);
    if (host->host == NULL && ta_napi_throw_kept(env, host)) return NULL; /* the last take's error */
    return undefined;
}

/* close(): clears the timers, rejects a waiting idle(), gives the last
 * take to the telemetry handler and frees the host; again, nothing. A
 * promise a handler returned there is not awaited (an unhandled rejection
 * if it rejects); [Symbol.asyncDispose] awaits them. */
static napi_value ta_napi_host_close(napi_env env, napi_callback_info info) {
    ta_napi_host *host = NULL;
    napi_value result = ta_napi_host_close_self(env, ta_napi_this(env, info), &host);
    if (host != NULL) host->endings = NULL;
    return result;
}

/* A promise's .then(fulfilled) value: undefined, whatever Promise.all gave. */
static napi_value ta_napi_host_disposed(napi_env env, napi_callback_info info) {
    (void)info;
    napi_value undefined = NULL;
    napi_get_undefined(env, &undefined);
    return undefined;
}

/* [Symbol.asyncDispose](): close(), then a promise of undefined that
 * settles when the promises the last take's handlers returned have
 * (Promise.all): rejected with the first rejection, or with the last
 * take's error. */
static napi_value ta_napi_host_async_dispose(napi_env env, napi_callback_info info) {
    ta_napi_host *host = NULL;
    napi_deferred deferred;
    napi_value promise, endings = NULL, result = ta_napi_host_close_self(env, ta_napi_this(env, info), &host);
    if (host != NULL) {
        endings = host->endings;
        host->endings = NULL;
    }
    uint32_t count = 0;
    if (result != NULL && endings != NULL && napi_get_array_length(env, endings, &count) == napi_ok && count > 0) {
        napi_value global, promise_class, all, then, fulfilled, waited, argv[1];
        if (napi_get_global(env, &global) != napi_ok || napi_get_named_property(env, global, "Promise", &promise_class) != napi_ok ||
            napi_get_named_property(env, promise_class, "all", &all) != napi_ok ||
            napi_call_function(env, promise_class, all, 1, &endings, &waited) != napi_ok ||
            napi_get_named_property(env, waited, "then", &then) != napi_ok ||
            napi_create_function(env, "disposed", NAPI_AUTO_LENGTH, ta_napi_host_disposed, NULL, &fulfilled) != napi_ok)
            return NULL;
        argv[0] = fulfilled;
        if (napi_call_function(env, waited, then, 1, argv, &promise) != napi_ok) return NULL;
        return promise;
    }
    if (napi_create_promise(env, &deferred, &promise) != napi_ok) return NULL;
    if (result != NULL) {
        napi_resolve_deferred(env, deferred, result);
        return promise;
    }
    napi_value error;
    if (napi_get_and_clear_last_exception(env, &error) != napi_ok) return NULL;
    napi_reject_deferred(env, deferred, error);
    return promise;
}

static napi_value ta_napi_host_closed(napi_env env, napi_callback_info info) {
    ta_napi_host *host = ta_napi_host_of(env, &(ta_napi_host_check){ta_napi_this(env, info), false});
    napi_value result = NULL;
    if (host != NULL) napi_get_boolean(env, host->host == NULL, &result);
    return result;
}

static napi_value ta_napi_host_ticks(napi_env env, napi_callback_info info) {
    ta_napi_host *host = ta_napi_host_of(env, &(ta_napi_host_check){ta_napi_this(env, info), false});
    napi_value result = NULL;
    if (host != NULL) napi_create_double(env, (double)host->ticks_per_second, &result);
    return result;
}

/* host.quickjsHeapBytes: the bytes the quickjs engine has allocated
 * (ta_datamodel_ecmascript_heap_bytes, O(1)); undefined on a native host
 * and on a closed one. */
static napi_value ta_napi_host_quickjs_heap(napi_env env, napi_callback_info info) {
    ta_napi_host *host = ta_napi_host_of(env, &(ta_napi_host_check){ta_napi_this(env, info), false});
    napi_value result = NULL;
    if (host == NULL) return NULL;
    if (host->quickjs == NULL || host->host == NULL) napi_get_undefined(env, &result);
    else napi_create_double(env, (double)ta_datamodel_ecmascript_heap_bytes(host->quickjs), &result);
    return result;
}

/* ---- payloads: a value for a session's datamodel ----------------------------------- */

/* The datamodel name of a chart in the host: its image's. */
static ta_string_view ta_napi_chart_datamodel(const ta_napi_host *host, ta_host_chart_ref chart) {
    ta_host_segment_info info;
    memset(&info, 0, sizeof info);
    info.size = sizeof info;
    if (ta_host_segment_info_get(host->host, chart.segment, &info) != TA_OK || info.image == NULL)
        return (ta_string_view){NULL, 0};
    return ta_image_chart_datamodel(info.image, chart.chart);
}

/* The chart of a live session; false when there is none. */
static bool ta_napi_session_chart(ta_napi_host *host, uint64_t session, ta_host_chart_ref *chart) {
    ta_host_location location;
    if (ta_host_locate(host->host, session, &location) != TA_OK) return false;
    ta_system *system = ta_host_system(host->host, location.segment);
    ta_actor_info info;
    memset(&info, 0, sizeof info);
    info.size = sizeof info;
    if (system == NULL || ta_actor_info_get(system, location.actor, &info) != TA_OK) return false;
    *chart = (ta_host_chart_ref){location.segment, info.chart};
    return true;
}

bool ta_napi_host_payload(napi_env env, ta_napi_host *host, ta_napi_payload_for *target) {
    target->payload = 0;
    if (target->value == NULL || ta_napi_is(env, target->value, napi_undefined)) return true;
    ta_host_chart_ref chart = target->chart;
    if (target->session != 0 && !ta_napi_session_chart(host, target->session, &chart)) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STALE, "no live session takes this data"});
        return false;
    }
    ta_string_view datamodel = ta_napi_chart_datamodel(host, chart);
    if (datamodel.length != 10 || memcmp(datamodel.pointer, "ecmascript", 10) != 0) {
        napi_throw_type_error(env, NULL, "the chart's datamodel takes no data");
        return false;
    }
    /* the native datamodel copies the value into its shared context;
     * quickjs takes CBOR in the call's arena (AGENTS.md, "The binding's memory") */
    if (host->datamodel == TA_NAPI_DATAMODEL_NATIVE) return ta_napi_native_payload(&host->native, target->value, &target->payload);
    ta_cbor_writer writer;
    ta_cbor_writer_init(&writer, (ta_buffer){NULL, 0, 0}, &host->arena_allocator);
    bool ok = ta_napi_value_write(env, target->value, &(ta_napi_writing){&writer, &host->arena, false, NULL, true}); /* an Address: tag 32, its text to quickjs */
    if (ok) {
        ta_bytes cbor;
        ta_status status = ta_cbor_writer_bytes(&writer, &cbor);
        if (status == TA_OK) status = ta_datamodel_ecmascript_payload_from_cbor(host->quickjs, cbor, &target->payload);
        if (status != TA_OK) {
            ta_napi_throw(env, &(ta_napi_refusal){status, "the value could not be made a payload"});
            ok = false;
        }
    }
    ta_cbor_writer_free(&writer);
    return ok;
}

void ta_napi_host_payload_release(ta_napi_host *host, ta_payload payload) {
    if (payload == 0 || host->host == NULL) return;
    host->datamodels[0].vtable->release(host->datamodels[0].datamodel, payload);
}

/* ---- inputs ------------------------------------------------------------------------- */

/* A call's arguments: `argc` of them read into `argv`, the rest undefined. */
typedef struct ta_napi_arguments {
    size_t argc;
    napi_value argv[4];
    napi_value self;
} ta_napi_arguments;

static bool ta_napi_arguments_of(napi_env env, napi_callback_info info, ta_napi_arguments *arguments) {
    size_t given = arguments->argc;
    napi_value undefined;
    if (napi_get_cb_info(env, info, &given, arguments->argv, &arguments->self, NULL) != napi_ok ||
        napi_get_undefined(env, &undefined) != napi_ok)
        return false;
    for (size_t i = given; i < arguments->argc; i++) arguments->argv[i] = undefined;
    if (given < arguments->argc) arguments->argc = given;
    return true;
}

/* A status of an input: undefined, or a TinyactorsError naming it. */
static napi_value ta_napi_input_status(napi_env env, const ta_napi_refusal *refusal) {
    napi_value undefined = NULL;
    if (refusal->status != TA_OK) return ta_napi_throw(env, refusal);
    napi_get_undefined(env, &undefined);
    return undefined;
}

/* A session: a bigint from 1 to 2^64-1, or a number that is a safe
 * integer from 1 (2^53-1 at most: a number past it has lost bits, and
 * napi_get_value_int64 would saturate silently). spawn gives bigints. */
bool ta_napi_session_of(napi_env env, napi_value value, uint64_t *session) {
    bool lossless = false;
    double number = 0;
    napi_valuetype type = napi_undefined;
    bool ok = napi_typeof(env, value, &type) == napi_ok;
    napi_value id;
    /* an Actor (the application layer's): its id, a bigint */
    if (ok && type == napi_object && napi_get_named_property(env, value, "id", &id) == napi_ok &&
        napi_typeof(env, id, &type) == napi_ok && type == napi_bigint)
        value = id;
    if (ok && type == napi_bigint)
        ok = napi_get_value_bigint_uint64(env, value, session, &lossless) == napi_ok && lossless;
    else if (ok && type == napi_number) {
        ok = napi_get_value_double(env, value, &number) == napi_ok && number >= 1 && number <= 9007199254740991.0 &&
             number == (double)(uint64_t)number;
        if (ok) *session = (uint64_t)number;
    } else ok = false;
    if (!ok || *session == 0) { /* 0 is core's "no session" (ta_host_actor_by_name) */
        napi_throw_type_error(env, NULL, "a session is an Actor, a bigint from 1 to 2^64-1 or a safe integer from 1");
        return false;
    }
    return true;
}

bool ta_napi_optional_text(napi_env env, napi_value value, ta_napi_text *text) {
    text->view = (ta_string_view){NULL, 0};
    if (ta_napi_is(env, value, napi_undefined) || ta_napi_is(env, value, napi_null)) return true;
    return ta_napi_text_of(env, value, text);
}


/* host.addImage(image) -> segment: a Uint8Array (a Buffer too) or an
 * ArrayBuffer, copied by the host during the call. */
static napi_value ta_napi_host_add_image(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL;
    ta_napi_bytes image = {"addImage takes the image's bytes: a Uint8Array or an ArrayBuffer", {NULL, 0}};
    if (ta_napi_bytes_of(env, arguments.argv[0], &image)) {
        uint32_t segment = 0;
        ta_status status = ta_host_add_image(call.host->host, image.view, &segment);
        if (status != TA_OK) ta_napi_throw(env, &(ta_napi_refusal){status, "the image was refused"});
        else napi_create_uint32(env, segment, &result);
    }
    ta_napi_leave(&call);
    return result;
}

/* host.chart(name) -> {segment, chart}: the current version of the chart,
 * a frozen object for spawn. */
static napi_value ta_napi_host_chart(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL, segment, chart;
    ta_napi_text name = {&call.host->arena, "chart takes the chart's name, a string", {NULL, 0}};
    ta_host_chart_ref ref;
    if (ta_napi_text_of(env, arguments.argv[0], &name)) {
        ta_status status = ta_host_chart(call.host->host, name.view, &ref);
        if (status != TA_OK) ta_napi_throw(env, &(ta_napi_refusal){status, "the host has no chart of that name"});
        else if (napi_create_object(env, &result) != napi_ok || napi_create_uint32(env, ref.segment, &segment) != napi_ok ||
                 napi_create_uint32(env, ref.chart, &chart) != napi_ok ||
                 napi_set_named_property(env, result, "segment", segment) != napi_ok ||
                 napi_set_named_property(env, result, "chart", chart) != napi_ok || napi_object_freeze(env, result) != napi_ok)
            result = NULL;
    }
    ta_napi_leave(&call);
    return result;
}

/* host.boot(segment): the segment's boot actors (ta_host_boot), each under
 * its name. */
static napi_value ta_napi_host_boot(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL;
    ta_napi_count segment = {"boot takes a segment, the number addImage returned", 4294967295.0, 0};
    if (ta_napi_count_of(env, arguments.argv[0], &segment)) {
        ta_napi_advance(env, call.host);
        ta_status status = ta_host_boot(call.host->host, (uint32_t)segment.value);
        if (status == TA_OK) ta_napi_schedule(env, call.host);
        result = ta_napi_input_status(env, &(ta_napi_refusal){status, "the segment's boot was refused"});
    }
    ta_napi_leave(&call);
    return result;
}

/* host.actorByName(name) -> bigint | undefined: the live actor spawned
 * with `name`, newest segment first. */
static napi_value ta_napi_host_actor_by_name(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL;
    ta_napi_text name = {&call.host->arena, "actorByName takes the actor's name, a string", {NULL, 0}};
    if (ta_napi_text_of(env, arguments.argv[0], &name)) {
        uint64_t session = ta_host_actor_by_name(call.host->host, name.view);
        if (session == 0) napi_get_undefined(env, &result);
        else napi_create_bigint_uint64(env, session, &result);
    }
    ta_napi_leave(&call);
    return result;
}

/* host.holdsImage(image) -> boolean: whether a live segment runs an image
 * of these bytes (ta_image_bytes); the application layer adds a restored
 * host only the images its snapshot does not hold. */
static napi_value ta_napi_host_holds_image(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL;
    ta_napi_bytes image = {"holdsImage takes the image's bytes: a Uint8Array or an ArrayBuffer", {NULL, 0}};
    if (ta_napi_bytes_of(env, arguments.argv[0], &image)) {
        bool held = false;
        uint32_t count = ta_host_segment_count(call.host->host);
        for (uint32_t segment = 0; segment < count && !held; segment++) {
            ta_host_segment_info segment_info;
            memset(&segment_info, 0, sizeof segment_info);
            segment_info.size = sizeof segment_info;
            if (ta_host_segment_info_get(call.host->host, segment, &segment_info) != TA_OK || segment_info.image == NULL) continue;
            ta_bytes bytes = ta_image_bytes(segment_info.image);
            held = bytes.length == image.view.length && memcmp(bytes.pointer, image.view.pointer, bytes.length) == 0;
        }
        napi_get_boolean(env, held, &result);
    }
    ta_napi_leave(&call);
    return result;
}

/* host.residentCount() -> number: the actors in memory now, every live
 * segment's actors less its hibernated ones (ta_system_stats_get); the
 * application layer's bound of resident actors. */
static napi_value ta_napi_host_resident_count(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {0, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    uint64_t resident = 0;
    uint32_t count = ta_host_segment_count(call.host->host);
    for (uint32_t segment = 0; segment < count; segment++) {
        ta_system *system = ta_host_system(call.host->host, segment);
        if (system == NULL) continue; /* freed */
        ta_system_stats stats;
        memset(&stats, 0, sizeof stats);
        stats.size = sizeof stats;
        ta_system_stats_get(system, &stats);
        resident += stats.actors - stats.hibernated;
    }
    napi_value result = NULL;
    napi_create_double(env, (double)resident, &result);
    ta_napi_leave(&call);
    return result;
}

/* host.actorInfo(session) -> {chart, hibernated} | undefined: a live
 * actor's chart (its name, ta_image_chart_name) and whether it is
 * hibernated now (ta_host_locate, ta_actor_info_get); undefined when the
 * session names no live actor. */
static napi_value ta_napi_host_actor_info(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    uint64_t session = 0;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_session_of(env, arguments.argv[0], &session) ||
        !ta_napi_enter(env, arguments.self, &call))
        return NULL;
    napi_value result = NULL, chart, hibernated;
    ta_host_location location;
    ta_system *system = ta_host_locate(call.host->host, session, &location) == TA_OK ? ta_host_system(call.host->host, location.segment)
                                                                                      : NULL;
    ta_actor_info actor;
    memset(&actor, 0, sizeof actor);
    actor.size = sizeof actor;
    ta_host_segment_info segment;
    memset(&segment, 0, sizeof segment);
    segment.size = sizeof segment;
    if (system != NULL && ta_actor_info_get(system, location.actor, &actor) == TA_OK &&
        ta_host_segment_info_get(call.host->host, location.segment, &segment) == TA_OK && segment.image != NULL) {
        ta_string_view name = ta_image_chart_name(segment.image, actor.chart);
        if (napi_create_object(env, &result) != napi_ok ||
            napi_create_string_utf8(env, name.pointer != NULL ? name.pointer : "", name.length, &chart) != napi_ok ||
            napi_get_boolean(env, actor.state == TA_ACTOR_HIBERNATED, &hibernated) != napi_ok ||
            napi_set_named_property(env, result, "chart", chart) != napi_ok ||
            napi_set_named_property(env, result, "hibernated", hibernated) != napi_ok)
            result = NULL;
    } else napi_get_undefined(env, &result);
    ta_napi_leave(&call);
    return result;
}

/* An output the host handed out (metrics, a hibernation blob): the host's
 * view of its bytes, until the ack, and, for a blob, its session. */
typedef struct ta_napi_output {
    ta_bytes taken;
    uint64_t session; /* a blob's: woken back from the view when the copy fails; 0 none */
} ta_napi_output;

/* An output was taken, copied once into a Buffer: with no batch open it
 * opened a batch of this output alone, acknowledged here; with one open (a
 * handler's call) it joined that batch, which the drain acks (host->batch,
 * from a take to its ack, never guessed from the depth). A blob whose copy
 * fails is woken back from the view first, still valid, or the actor would
 * have no blob anywhere. NULL with an exception pending. */
static napi_value ta_napi_host_output(napi_env env, ta_napi_host *host, const ta_napi_output *output) {
    napi_value result = NULL;
    if (napi_create_buffer_copy(env, output->taken.length, output->taken.pointer, NULL, &result) != napi_ok) {
        result = NULL;
        if (output->session != 0) ta_host_wake(host->host, output->session, output->taken);
    }
    if (!host->batch) {
        ta_host_effects_ack(host->host);
        host->acks++;
    }
    return result;
}

/* host.metrics() -> Buffer: the host's counters as an OTLP metrics
 * request (ta_host_metrics), pulled when the application wants them;
 * TA_ERROR_STATE without telemetry in the config. */
static napi_value ta_napi_host_metrics(napi_env env, napi_callback_info info) {
    ta_napi_call call;
    if (!ta_napi_enter(env, ta_napi_this(env, info), &call)) return NULL;
    ta_bytes taken;
    ta_status status = ta_host_metrics(call.host->host, &taken);
    napi_value result = status == TA_OK ? ta_napi_host_output(env, call.host, &(ta_napi_output){taken, 0})
                                        : ta_napi_throw(env, &(ta_napi_refusal){status, "metrics were refused (TA_ERROR_STATE: "
                                                                                        "the config has no telemetry)"});
    ta_napi_leave(&call);
    return result;
}

/* ---- hibernation: the application keeps the blobs ---------------------------------- */

/* host.sweep(maxScan, limit) -> bigint[]: the CLOCK sweep (ta_host_sweep),
 * at most `limit` sessions that did not run since the previous sweep and
 * can be hibernated now, scanning at most `maxScan` slots; each a count
 * from 0 to 2^32-1, anything else a TypeError (never wrapped). */
static napi_value ta_napi_host_sweep(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {2, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL, session;
    ta_napi_count scan = {"sweep's maxScan is an integer from 0 to 2^32-1", 4294967295.0, 0};
    ta_napi_count limit = {"sweep's limit is an integer from 0 to 2^32-1", 4294967295.0, 0};
    if (ta_napi_count_of(env, arguments.argv[0], &scan) && ta_napi_count_of(env, arguments.argv[1], &limit)) {
        /* it answers at most one session a slot scanned */
        uint32_t room = (uint32_t)(limit.value < scan.value ? limit.value : scan.value);
        uint64_t *sessions = room ? (uint64_t *)ta_growable_arena_alloc(&call.host->arena, sizeof(uint64_t) * room, 8) : NULL;
        if (room && sessions == NULL) ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the sweep's sessions"});
        else {
            uint32_t found = ta_host_sweep(call.host->host, (uint32_t)scan.value, (ta_uint64_array){sessions, room});
            bool ok = napi_create_array_with_length(env, found, &result) == napi_ok;
            for (uint32_t i = 0; ok && i < found; i++)
                ok = napi_create_bigint_uint64(env, sessions[i], &session) == napi_ok && napi_set_element(env, result, i, session) == napi_ok;
            if (!ok) result = NULL;
        }
    }
    ta_napi_leave(&call);
    return result;
}

/* host.hibernate(session) -> Buffer: ta_host_hibernate, the blob copied
 * once, the application's to store until it gives it to wake.
 * TA_ERROR_STATE: the actor is not at a stable point; TA_ERROR_UNSUPPORTED:
 * its datamodel cannot store its state, and the message says why. */
static napi_value ta_napi_host_hibernate(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    ta_napi_host *host = call.host;
    napi_value result = NULL;
    uint64_t session = 0;
    if (ta_napi_session_of(env, arguments.argv[0], &session)) {
        ta_bytes taken;
        ta_status status = ta_host_hibernate(host->host, session, &taken);
        if (status == TA_OK) result = ta_napi_host_output(env, host, &(ta_napi_output){taken, session});
        else {
            const char *message = status == TA_ERROR_STATE ? "the actor is not at a stable point now (events waiting, in a "
                                                             "macrostep, an invoked child), or not resident"
                                                           : "the hibernation was refused";
            if (status == TA_ERROR_UNSUPPORTED) {
                const char *reason = host->quickjs != NULL ? ta_datamodel_ecmascript_last_error(host->quickjs) : host->native.reason;
                if (reason != NULL && reason[0] != '\0') message = reason;
            }
            ta_napi_throw(env, &(ta_napi_refusal){status, message});
        }
    }
    ta_napi_leave(&call);
    return result;
}

/* host.wake(session, blob): ta_host_wake with the blob hibernate gave (a
 * Uint8Array, a Buffer too, or an ArrayBuffer), read during the call; the
 * actor's waiting events run at the next turn. */
static napi_value ta_napi_host_wake(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {2, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL;
    uint64_t session = 0;
    ta_napi_bytes blob = {"wake takes the blob hibernate gave: a Uint8Array or an ArrayBuffer", {NULL, 0}};
    if (ta_napi_session_of(env, arguments.argv[0], &session)) {
        if (ta_napi_bytes_of(env, arguments.argv[1], &blob)) {
            ta_status status = ta_host_wake(call.host->host, session, blob.view);
            if (status == TA_OK) ta_napi_schedule(env, call.host); /* its mailbox runs at the next turn */
            result = ta_napi_input_status(env, &(ta_napi_refusal){status, "the wake was refused (TA_ERROR_STATE: the session "
                                                                          "is not hibernated; TA_ERROR_INVALID: not its blob; "
                                                                          "TA_ERROR_STALE: not its latest blob)"});
        }
    }
    ta_napi_leave(&call);
    return result;
}

/* ---- migration: actors move to the current version of their chart ----------------- */

/* migrate's options (`given`, an object or undefined), read for `host`. */
typedef struct ta_napi_migrate_in {
    ta_napi_host *host;
    napi_value given;
} ta_napi_migrate_in;

/* migrate's options read into `request`; false with an exception thrown. */
static bool ta_napi_migration_of(napi_env env, const ta_napi_migrate_in *call, ta_host_migration *request) {
    static const char *const names[] = {"chart", "session", "wake", "timeout"};
    napi_value given = call->given;
    memset(request, 0, sizeof *request);
    if (ta_napi_is(env, given, napi_undefined)) return true;
    if (!ta_napi_is(env, given, napi_object)) {
        napi_throw_type_error(env, NULL, "migrate takes an object of chart, session, wake, timeout, or nothing");
        return false;
    }
    if (!ta_napi_only_known(env, given, &(ta_napi_known){"migrate option", names, 4})) return false;
    ta_napi_options options = {given};
    napi_value chart = ta_napi_option(env, &options, "chart"), session = ta_napi_option(env, &options, "session");
    napi_value wake = ta_napi_option(env, &options, "wake"), timeout = ta_napi_option(env, &options, "timeout");
    if (!ta_napi_is(env, chart, napi_undefined)) {
        ta_napi_text name = {&call->host->arena, "migrate's chart is a chart's name, a string", {NULL, 0}};
        if (!ta_napi_text_of(env, chart, &name)) return false;
        if (name.view.length == 0) { /* core reads an empty name as every chart */
            napi_throw_range_error(env, NULL, "migrate's chart is a chart's name; leave it out for every chart");
            return false;
        }
        request->name = name.view;
    }
    if (!ta_napi_is(env, session, napi_undefined) && !ta_napi_session_of(env, session, &request->session)) return false;
    if (!ta_napi_is(env, wake, napi_undefined)) {
        bool on = false;
        if (!ta_napi_is(env, wake, napi_boolean) || napi_get_value_bool(env, wake, &on) != napi_ok) {
            napi_throw_type_error(env, NULL, "migrate's wake is a boolean");
            return false;
        }
        request->flags = on ? TA_HOST_MIGRATE_WAKE : 0;
    }
    if (!ta_napi_is(env, timeout, napi_undefined)) {
        double milliseconds = -1;
        if (!ta_napi_is(env, timeout, napi_number) || napi_get_value_double(env, timeout, &milliseconds) != napi_ok) {
            napi_throw_type_error(env, NULL, "migrate's timeout is a number of milliseconds");
            return false;
        }
        double nanoseconds = milliseconds * 1e6 + 0.5;
        if (!(milliseconds >= 0) || !(nanoseconds < 18446744073709551616.0)) { /* NaN, negative, 2^64 and infinity */
            napi_throw_range_error(env, NULL, "migrate's timeout is milliseconds, not negative, below 2^64 nanoseconds");
            return false;
        }
        request->timeout = ta_napi_ticks_after(call->host, (uint64_t)nanoseconds);
    }
    return true;
}

/* host.migrate({chart, session, wake, timeout}?) -> migration:
 * ta_host_migrate of every chart (or `chart`, or one `session`), asking
 * the wake handler for hibernated actors with `wake`
 * (TA_HOST_MIGRATE_WAKE: a WAKE each), ending after `timeout` milliseconds
 * of the host's clock, as ticks rounded up and counted from the clock
 * advanced now (0: none). The migration moves actors in later runs, so a
 * turn is scheduled; the host's migrationDone handler gets its end. */
static napi_value ta_napi_host_migrate(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL;
    ta_host_migration request;
    if (ta_napi_migration_of(env, &(ta_napi_migrate_in){call.host, arguments.argv[0]}, &request)) {
        ta_napi_advance(env, call.host); /* the timeout counts from the host's clock now */
        uint32_t migration = 0;
        ta_status status = ta_host_migrate(call.host->host, &request, &migration);
        if (status != TA_OK) ta_napi_throw(env, &(ta_napi_refusal){status, "the migration was refused"});
        else {
            ta_napi_schedule(env, call.host); /* the migration moves actors in the next runs */
            napi_create_uint32(env, migration, &result);
        }
    }
    ta_napi_leave(&call);
    return result;
}

/* The options of spawn and send: an object of `names` or undefined. */
static bool ta_napi_input_options(napi_env env, napi_value value, const ta_napi_known *known) {
    if (ta_napi_is(env, value, napi_undefined)) return true;
    if (!ta_napi_is(env, value, napi_object)) {
        napi_throw_type_error(env, NULL, "options are an object");
        return false;
    }
    return ta_napi_only_known(env, value, known);
}

/* host.spawn(ref, {name, params, traceparent}?) -> bigint */
static napi_value ta_napi_host_spawn(napi_env env, napi_callback_info info) {
    static const char *const known[] = {"name", "params", "traceparent"};
    ta_napi_arguments arguments = {2, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    ta_napi_host *host = call.host;
    napi_value ref = arguments.argv[0], result = NULL, value;
    ta_napi_options options = {ta_napi_is(env, arguments.argv[1], napi_object) ? arguments.argv[1] : NULL};
    ta_napi_count segment = {"spawn takes a chart reference, {segment, chart}, from host.chart", 4294967295.0, 0};
    ta_napi_count chart = segment;
    ta_spawn spawn;
    memset(&spawn, 0, sizeof spawn);
    ta_napi_text name = {&host->arena, "spawn's name is a string", {NULL, 0}};
    ta_napi_text traceparent = {&host->arena, "a traceparent is W3C text, a string", {NULL, 0}};
    bool ok = ta_napi_input_options(env, arguments.argv[1], &(ta_napi_known){"spawn option", known, 3});
    if (ok && !ta_napi_is(env, ref, napi_object)) {
        napi_throw_type_error(env, NULL, segment.what);
        ok = false;
    }
    ok = ok && napi_get_named_property(env, ref, "segment", &value) == napi_ok && ta_napi_count_of(env, value, &segment) &&
         napi_get_named_property(env, ref, "chart", &value) == napi_ok && ta_napi_count_of(env, value, &chart) &&
         ta_napi_optional_text(env, ta_napi_option(env, &options, "name"), &name) &&
         ta_napi_optional_text(env, ta_napi_option(env, &options, "traceparent"), &traceparent);
    if (ok) {
        spawn.segment = (uint32_t)segment.value;
        spawn.chart = (uint32_t)chart.value;
        spawn.name = name.view;
        spawn.traceparent = traceparent.view;
        ta_napi_payload_for params = {0, {spawn.segment, spawn.chart}, ta_napi_option(env, &options, "params"), 0};
        if (ta_napi_host_payload(env, host, &params)) {
            uint64_t session = 0;
            spawn.params = params.payload; /* moved to core on success */
            ta_napi_advance(env, host);
            ta_status status = ta_host_spawn(host->host, &spawn, &session);
            if (status != TA_OK) {
                ta_napi_host_payload_release(host, params.payload); /* still ours */
                ta_napi_throw(env, &(ta_napi_refusal){status, "the spawn was refused"});
            } else {
                ta_napi_schedule(env, host);
                napi_create_bigint_uint64(env, session, &result);
            }
        }
    }
    ta_napi_leave(&call);
    return result;
}

/* An event of send, sendMany and fail: the fields as JavaScript values,
 * and the ta_event_in made from them (texts in the host's arena, the data
 * a payload of the target session's datamodel, made last, so nothing
 * needs releasing when an earlier field is refused). */
typedef struct ta_napi_event {
    napi_value target, name, data, sendid, origin, traceparent;
    ta_event_in in; /* out */
} ta_napi_event;

/* An event's target: a session (a bigint or a safe integer), or a local address (a string
 * or an Address) core resolves to one (ta_host_resolve) before the payload
 * is made in that session's datamodel: event->in.session. */
static bool ta_napi_target_of(napi_env env, const ta_napi_call *call, ta_napi_event *event) {
    napi_value value = ta_napi_address_text(env, event->target);
    uint64_t *session = &event->in.session;
    if (!ta_napi_is(env, value, napi_string)) {
        if (ta_napi_is(env, value, napi_bigint) || ta_napi_is(env, value, napi_number) || ta_napi_is(env, value, napi_object))
            return ta_napi_session_of(env, value, session);
        napi_throw_type_error(env, NULL, "a target is an Actor, a session (a bigint or a safe integer) or a local address (a string or an Address)");
        return false;
    }
    ta_napi_text address = {&call->host->arena, "an address is a string", {NULL, 0}};
    if (!ta_napi_text_of(env, value, &address)) return false;
    ta_status status = ta_host_resolve(call->host->host, address.view, session);
    if (status != TA_OK) {
        ta_napi_throw(env, &(ta_napi_refusal){status, "the address names no local session"});
        return false;
    }
    return true;
}


static bool ta_napi_event_of(napi_env env, const ta_napi_call *call, ta_napi_event *event) {
    ta_napi_host *host = call->host;
    ta_event_in *in = &event->in;
    memset(in, 0, sizeof *in);
    in->size = sizeof *in;
    ta_napi_text name = {&host->arena, "an event's name is a string", {NULL, 0}};
    ta_napi_text sendid = {&host->arena, "a sendid is a string", {NULL, 0}};
    ta_napi_text origin = {&host->arena, "an origin is an address, a string or an Address", {NULL, 0}};
    ta_napi_text traceparent = {&host->arena, "a traceparent is W3C text, a string", {NULL, 0}};
    if (!ta_napi_target_of(env, call, event) ||
        (event->name != NULL && !ta_napi_text_of(env, event->name, &name)) ||
        !ta_napi_optional_text(env, event->sendid, &sendid) || !ta_napi_optional_text(env, ta_napi_address_text(env, event->origin), &origin) ||
        !ta_napi_optional_text(env, event->traceparent, &traceparent))
        return false;
    in->name = name.view;
    in->sendid = sendid.view;
    in->origin = origin.view;
    in->traceparent = traceparent.view;
    ta_napi_payload_for payload = {in->session, {0, 0}, event->data, 0};
    if (!ta_napi_host_payload(env, host, &payload)) return false;
    in->data = payload.payload;
    return true;
}

/* A message, the object send.message gives: its known keys, the others
 * ignored, so a newer sender's keys do not break an older host. */
static bool ta_napi_message_of(napi_env env, napi_value message, ta_napi_event *event) {
    if (!ta_napi_is(env, message, napi_object) || napi_get_named_property(env, message, "target", &event->target) != napi_ok ||
        napi_get_named_property(env, message, "event", &event->name) != napi_ok ||
        napi_get_named_property(env, message, "data", &event->data) != napi_ok ||
        napi_get_named_property(env, message, "sendid", &event->sendid) != napi_ok ||
        napi_get_named_property(env, message, "origin", &event->origin) != napi_ok ||
        napi_get_named_property(env, message, "traceparent", &event->traceparent) != napi_ok) {
        bool pending = false;
        napi_is_exception_pending(env, &pending);
        if (!pending) napi_throw_type_error(env, NULL, "a message is an object of target, event, data, sendid, origin, traceparent");
        return false;
    }
    if (ta_napi_is(env, event->target, napi_undefined) || ta_napi_is(env, event->name, napi_undefined)) {
        napi_throw_type_error(env, NULL, "a message has a target and an event");
        return false;
    }
    return true;
}

/* host.send(target, event, data?, {sendid, traceparent, origin}?) or
 * host.send(message): an input, applied at the call. */
static napi_value ta_napi_host_send(napi_env env, napi_callback_info info) {
    static const char *const known[] = {"sendid", "traceparent", "origin"};
    ta_napi_arguments arguments = {4, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value *argv = arguments.argv, result = NULL;
    ta_napi_event event;
    memset(&event, 0, sizeof event);
    bool ok;
    if (arguments.argc == 1 && ta_napi_is(env, argv[0], napi_object)) ok = ta_napi_message_of(env, argv[0], &event);
    else {
        ta_napi_options options = {ta_napi_is(env, argv[3], napi_object) ? argv[3] : NULL};
        ok = ta_napi_input_options(env, argv[3], &(ta_napi_known){"send option", known, 3});
        event.target = argv[0];
        event.name = argv[1];
        event.data = argv[2];
        event.sendid = ta_napi_option(env, &options, "sendid");
        event.origin = ta_napi_option(env, &options, "origin");
        event.traceparent = ta_napi_option(env, &options, "traceparent");
    }
    if (ok && ta_napi_event_of(env, &call, &event)) {
        ta_status status = ta_host_send(call.host->host, &event.in);
        if (status != TA_OK) ta_napi_host_payload_release(call.host, event.in.data); /* still ours */
        else ta_napi_schedule(env, call.host);
        result = ta_napi_input_status(env, &(ta_napi_refusal){status, "the send was refused"});
    }
    ta_napi_leave(&call);
    return result;
}

/* host.fail(target, sendid?): a send the application's transport could not
 * deliver, reported to its sender (error.communication with the sendid). */
static napi_value ta_napi_host_fail(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {2, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL, undefined;
    ta_napi_event event;
    memset(&event, 0, sizeof event);
    napi_get_undefined(env, &undefined);
    event.target = arguments.argv[0];
    event.sendid = arguments.argv[1];
    event.data = event.origin = event.traceparent = undefined;
    if (ta_napi_event_of(env, &call, &event)) {
        event.in.flags = TA_EVENT_IN_ERROR_COMMUNICATION;
        ta_status status = ta_host_send(call.host->host, &event.in);
        if (status == TA_OK) ta_napi_schedule(env, call.host);
        result = ta_napi_input_status(env, &(ta_napi_refusal){status, "the failure was refused"});
    }
    ta_napi_leave(&call);
    return result;
}

/* Events a sendMany converts and hands core at once: the arena holds a
 * slice, not the whole array, so one large call leaves no large chunk kept
 * for the host's life. */
#define TA_NAPI_SLICE 256u

/* One slice of sendMany, items [first, first + count): the accepted prefix
 * of the slice, or -1 with an exception pending (nothing of the slice
 * taken). The payloads core did not take are released: still ours. */
typedef struct ta_napi_slice {
    napi_value items;
    uint32_t first, count;
} ta_napi_slice;

static int64_t ta_napi_send_slice(napi_env env, const ta_napi_call *call, const ta_napi_slice *slice) {
    ta_napi_host *host = call->host;
    ta_growable_arena_mark mark = ta_growable_arena_position(&host->arena);
    ta_event_in *events = (ta_event_in *)ta_growable_arena_alloc(&host->arena, sizeof(ta_event_in) * TA_NAPI_SLICE, 8);
    uint32_t made = 0;
    int64_t taken = -1;
    if (events == NULL) ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the events"});
    else {
        for (; made < slice->count; made++) {
            napi_value item;
            ta_napi_event event;
            memset(&event, 0, sizeof event);
            if (napi_get_element(env, slice->items, slice->first + made, &item) != napi_ok ||
                !ta_napi_message_of(env, item, &event) || !ta_napi_event_of(env, call, &event))
                break;
            events[made] = event.in;
        }
        if (made == slice->count) taken = ta_host_send_many(host->host, events, made);
        for (uint32_t i = taken < 0 ? 0 : (uint32_t)taken; i < made; i++) ta_napi_host_payload_release(host, events[i].data);
    }
    ta_napi_arena_release(&host->arena, mark, TA_NAPI_ARENA_UNCAPPED);
    return taken;
}

/* host.sendMany(items) -> number: each item a message (host.send(message)'s
 * fields), handed to core in slices (ta_host_send_many); the length of the
 * accepted prefix. An item that cannot be converted throws, and the slices
 * before its own were sent. */
static napi_value ta_napi_host_send_many(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value items = arguments.argv[0], result = NULL;
    bool array = false, failed = false;
    uint32_t count = 0, accepted = 0;
    if (napi_is_array(env, items, &array) != napi_ok || !array || napi_get_array_length(env, items, &count) != napi_ok) {
        napi_throw_type_error(env, NULL, "sendMany takes an array of messages");
        failed = true;
    }
    for (uint32_t first = 0; !failed && first < count; first += TA_NAPI_SLICE) {
        ta_napi_slice slice = {items, first, count - first < TA_NAPI_SLICE ? count - first : TA_NAPI_SLICE};
        int64_t taken = ta_napi_send_slice(env, &call, &slice);
        if (taken < 0) failed = true;
        else accepted += (uint32_t)taken;
        if (taken != (int64_t)slice.count) break; /* refused at an event: the rest is not sent */
    }
    if (accepted) ta_napi_schedule(env, call.host);
    if (!failed) napi_create_uint32(env, accepted, &result);
    ta_napi_leave(&call);
    return result;
}

/* host.terminate(session) */
static napi_value ta_napi_host_terminate(napi_env env, napi_callback_info info) {
    ta_napi_arguments arguments = {1, {NULL}, NULL};
    ta_napi_call call;
    if (!ta_napi_arguments_of(env, info, &arguments) || !ta_napi_enter(env, arguments.self, &call)) return NULL;
    napi_value result = NULL;
    uint64_t session = 0;
    if (ta_napi_session_of(env, arguments.argv[0], &session)) {
        ta_status status = ta_host_terminate(call.host->host, session);
        if (status == TA_OK) ta_napi_schedule(env, call.host);
        result = ta_napi_input_status(env, &(ta_napi_refusal){status, "the terminate was refused"});
    }
    ta_napi_leave(&call);
    return result;
}

/* ---- snapshots: the whole host to bytes and back --------------------------------- */

/* quickjs's state (ta_datamodel_ecmascript_snapshot) as bytes in `writer`:
 * written into room for the last state's length and a quarter more, once
 * more only when it outgrew that (each call writes the whole state). */
static bool ta_napi_quickjs_state(napi_env env, ta_napi_host *host, ta_cbor_writer *writer) {
    ta_allocator *allocator = &host->allocator;
    size_t room = host->quickjs_room + host->quickjs_room / 4 + 4096;
    ta_buffer out = {allocator->alloc(allocator->context, room, 8), room, 0};
    ta_status status = out.pointer != NULL ? ta_datamodel_ecmascript_snapshot(host->quickjs, &out) : TA_ERROR_NO_MEMORY;
    if (out.pointer != NULL && status == TA_ERROR_NO_MEMORY && out.length > room) { /* it outgrew the guess */
        allocator->free(allocator->context, out.pointer, room);
        room = out.length;
        out = (ta_buffer){allocator->alloc(allocator->context, room, 8), room, 0};
        status = out.pointer != NULL ? ta_datamodel_ecmascript_snapshot(host->quickjs, &out) : TA_ERROR_NO_MEMORY;
    }
    if (status == TA_OK) {
        host->quickjs_room = out.length;
        ta_cbor_write_bytes(writer, (ta_bytes){out.pointer, out.length});
    } else {
        const char *reason = ta_datamodel_ecmascript_last_error(host->quickjs);
        ta_napi_throw(env, &(ta_napi_refusal){status, status == TA_ERROR_UNSUPPORTED && reason != NULL && reason[0] != '\0'
                                                          ? reason
                                                          : "the quickjs datamodel's state could not be written"});
    }
    if (out.pointer != NULL) allocator->free(allocator->context, out.pointer, room);
    return status == TA_OK;
}

/* host.snapshot() -> Buffer: ta_host_snapshot_pack of the whole host, with
 * the datamodel's state ({"native": its map} or {"quickjs": its bytes},
 * labelled tinyactors-napi), the images, the system id and the host's
 * time (its clocks advanced first, so it is the time of the call), written
 * once into the Buffer. A quiescent host only: from a
 * handler (a batch is open), with an effect or a reply pending, or during
 * a migration, TA_ERROR_STATE, checked by core before the datamodel's
 * state is built; a value outside the value table TA_ERROR_UNSUPPORTED. */
static napi_value ta_napi_host_snapshot(napi_env env, napi_callback_info info) {
    ta_napi_call call;
    if (!ta_napi_enter(env, ta_napi_this(env, info), &call)) return NULL;
    ta_napi_host *host = call.host;
    napi_value result = NULL;
    ta_buffer quiet = {NULL, 0, 0};
    ta_status ready = ta_host_snapshot(host->host, &quiet); /* quiescent first: TA_ERROR_NO_MEMORY is its room */
    if (ready != TA_OK && ready != TA_ERROR_NO_MEMORY) {
        ta_napi_throw(env, &(ta_napi_refusal){ready, "a snapshot needs a quiescent host (TA_ERROR_STATE: from a handler, "
                                                     "with an effect or a reply pending, or during a migration)"});
        ta_napi_leave(&call);
        return NULL;
    }
    ta_napi_advance(env, host); /* the snapshot's time is now, not the last turn's */
    ta_cbor_writer writer; /* through the host's allocator: a snapshot's size is no call's scratch */
    ta_cbor_writer_init(&writer, (ta_buffer){NULL, 0, 0}, &host->allocator);
    const char *key = ta_napi_state_keys[host->datamodel];
    ta_cbor_write_map(&writer, 1);
    ta_cbor_write_text(&writer, (ta_string_view){key, strlen(key)});
    bool ok = host->datamodel == TA_NAPI_DATAMODEL_NATIVE ? ta_napi_native_snapshot(&host->native, &writer)
                                                          : ta_napi_quickjs_state(env, host, &writer);
    ta_bytes state = {NULL, 0};
    ta_status status = ok ? ta_cbor_writer_bytes(&writer, &state) : TA_OK;
    if (ok && status != TA_OK) {
        ta_napi_throw(env, &(ta_napi_refusal){status, "no memory for the datamodel's state"});
        ok = false;
    }
    if (ok) {
        ta_datamodel_state packed = {{ta_napi_snapshot_label, sizeof ta_napi_snapshot_label - 1}, state};
        ta_buffer probe = {NULL, 0, 0};
        void *data = NULL;
        status = ta_host_snapshot_pack(host->host, &packed, &probe);
        if (status == TA_ERROR_NO_MEMORY) {
            if (napi_create_buffer(env, probe.length, &data, &result) != napi_ok) result = NULL;
            ta_buffer out = {data, probe.length, 0};
            status = result != NULL ? ta_host_snapshot_pack(host->host, &packed, &out) : TA_OK;
        }
        if (status != TA_OK) {
            result = NULL;
            ta_napi_throw(env, &(ta_napi_refusal){status, "the snapshot was refused"});
        }
    }
    ta_cbor_writer_free(&writer);
    ta_napi_leave(&call);
    return result;
}

/* Host.restore(snapshot, config, options) -> Host: a new Host running the
 * snapshot snapshot() gave (a Uint8Array, a Buffer too, or an
 * ArrayBuffer), made by the constructor with the config and options as
 * `new Host` takes them; the datamodel must be the snapshot's. */
static napi_value ta_napi_host_restore(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {NULL, NULL, NULL}, self = NULL, result = NULL, undefined;
    if (napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok || napi_get_undefined(env, &undefined) != napi_ok)
        return NULL;
    ta_napi_bytes check = {"restore takes the snapshot's bytes first: a Uint8Array or an ArrayBuffer", {NULL, 0}};
    if (!ta_napi_bytes_of(env, argc >= 1 ? argv[0] : NULL, &check)) return NULL;
    if (self == NULL || !ta_napi_is(env, self, napi_function)) {
        napi_throw_type_error(env, NULL, "restore is called on Host: Host.restore(snapshot, charts, options)");
        return NULL;
    }
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return NULL;
    ta_napi_restoring restoring;
    memset(&restoring, 0, sizeof restoring);
    restoring.snapshot = argv[0];
    restoring.allocator = ta_napi_allocator(env);
    napi_value arguments[2] = {argc >= 2 ? argv[1] : undefined, argc >= 3 ? argv[2] : undefined};
    ta_napi_restoring *outer = instance->restoring;
    instance->restoring = &restoring;
    if (napi_new_instance(env, self, 2, arguments, &result) != napi_ok) result = NULL;
    instance->restoring = outer;
    ta_buffer *owned[] = {&restoring.copy, &restoring.system_id};
    for (size_t i = 0; i < 2; i++)
        if (owned[i]->pointer != NULL) restoring.allocator.free(restoring.allocator.context, owned[i]->pointer, owned[i]->capacity);
    return result;
}

/* Symbol.<name> of this realm, or NULL when it has none. */
static napi_value ta_napi_well_known(napi_env env, const char *name) {
    napi_value global, symbol, value;
    if (napi_get_global(env, &global) != napi_ok || napi_get_named_property(env, global, "Symbol", &symbol) != napi_ok ||
        napi_get_named_property(env, symbol, name, &value) != napi_ok || !ta_napi_is(env, value, napi_symbol))
        return NULL;
    return value;
}

napi_status ta_napi_host_define(napi_env env, napi_value exports) {
    napi_value dispose = ta_napi_well_known(env, "dispose"), async_dispose = ta_napi_well_known(env, "asyncDispose");
    napi_property_descriptor properties[] = {
        {"close", NULL, ta_napi_host_close, NULL, NULL, NULL, napi_default_method, NULL},
        {"closed", NULL, NULL, ta_napi_host_closed, NULL, NULL, napi_configurable, NULL},
        {"ticksPerSecond", NULL, NULL, ta_napi_host_ticks, NULL, NULL, napi_configurable, NULL},
        {"nextDeadline", NULL, NULL, ta_napi_host_next_deadline, NULL, NULL, napi_configurable, NULL},
        {"quickjsHeapBytes", NULL, NULL, ta_napi_host_quickjs_heap, NULL, NULL, napi_configurable, NULL},
        {"now", NULL, ta_napi_host_now, NULL, NULL, NULL, napi_default_method, NULL},
        {"idle", NULL, ta_napi_host_idle, NULL, NULL, NULL, napi_default_method, NULL},
        {"addImage", NULL, ta_napi_host_add_image, NULL, NULL, NULL, napi_default_method, NULL},
        {"chart", NULL, ta_napi_host_chart, NULL, NULL, NULL, napi_default_method, NULL},
        {"boot", NULL, ta_napi_host_boot, NULL, NULL, NULL, napi_default_method, NULL},
        {"spawn", NULL, ta_napi_host_spawn, NULL, NULL, NULL, napi_default_method, NULL},
        {"send", NULL, ta_napi_host_send, NULL, NULL, NULL, napi_default_method, NULL},
        {"fail", NULL, ta_napi_host_fail, NULL, NULL, NULL, napi_default_method, NULL},
        {"sendMany", NULL, ta_napi_host_send_many, NULL, NULL, NULL, napi_default_method, NULL},
        {"terminate", NULL, ta_napi_host_terminate, NULL, NULL, NULL, napi_default_method, NULL},
        {"actorByName", NULL, ta_napi_host_actor_by_name, NULL, NULL, NULL, napi_default_method, NULL},
        {"holdsImage", NULL, ta_napi_host_holds_image, NULL, NULL, NULL, napi_default_method, NULL},
        {"residentCount", NULL, ta_napi_host_resident_count, NULL, NULL, NULL, napi_default_method, NULL},
        {"actorInfo", NULL, ta_napi_host_actor_info, NULL, NULL, NULL, napi_default_method, NULL},
        {"metrics", NULL, ta_napi_host_metrics, NULL, NULL, NULL, napi_default_method, NULL},
        {"sweep", NULL, ta_napi_host_sweep, NULL, NULL, NULL, napi_default_method, NULL},
        {"hibernate", NULL, ta_napi_host_hibernate, NULL, NULL, NULL, napi_default_method, NULL},
        {"wake", NULL, ta_napi_host_wake, NULL, NULL, NULL, napi_default_method, NULL},
        {"migrate", NULL, ta_napi_host_migrate, NULL, NULL, NULL, napi_default_method, NULL},
        {"snapshot", NULL, ta_napi_host_snapshot, NULL, NULL, NULL, napi_default_method, NULL},
        {"restore", NULL, ta_napi_host_restore, NULL, NULL, NULL, napi_static | napi_writable | napi_configurable, NULL},
        {NULL, dispose, ta_napi_host_close, NULL, NULL, NULL, napi_default_method, NULL},
        {NULL, async_dispose, ta_napi_host_async_dispose, NULL, NULL, NULL, napi_default_method, NULL},
    };
    size_t count = sizeof properties / sizeof properties[0];
    /* a runtime without the symbols: close() only (they are the last two) */
    if (dispose == NULL) count -= 2;
    else if (async_dispose == NULL) count--;
    napi_value class;
    napi_status status = napi_define_class(env, "Host", NAPI_AUTO_LENGTH, ta_napi_host_new, NULL, count, properties, &class);
    if (status == napi_ok) status = ta_napi_methods_define(env, class);
    if (status == napi_ok) status = napi_set_named_property(env, exports, "Host", class);
    return status;
}
