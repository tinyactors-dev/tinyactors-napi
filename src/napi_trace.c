#include "napi_trace.h"

#include <string.h>

#include "adapters/trace.h"
#include "pump.h"

/* ------------------------------------------------------------------------
 * Names
 */

/* ta_trace_kind, in order: the names JavaScript sees and masks with. */
static const char *const tna_trace_kinds[] = {
    "spawned",        "loaded",   "unloaded",  "finished",   "destroyed",      "macrostepBegin",
    "macrostepEnd",   "condition", "microstep", "raised",     "dataInit",       "assign",
    "script",         "foreach",  "actionFailed", "sent",    "cancelled",      "invoked",
    "invokeCancelled", "paused",  "resumed",   "stopped",    "ignored",        "forwarded",
    "longMacrostep",  "runaway",  "definitionRegistered", "definitionRetired", "definitionFreed",
    "abandoned",       "withdrawn",
};
_Static_assert(sizeof tna_trace_kinds / sizeof tna_trace_kinds[0] == (size_t)TA_TRACE_WITHDRAWN + 1u,
               "one name per ta_trace_kind");

static void tna_js_put(napi_env env, napi_value object, const char *name, napi_value value) {
    if (value != NULL) {
        napi_set_named_property(env, object, name, value);
    }
}

static napi_value tna_js_string(napi_env env, const char *ptr, size_t len) {
    napi_value out = NULL;
    napi_create_string_utf8(env, ptr == NULL ? "" : ptr, ptr == NULL ? 0 : len, &out);
    return out;
}

static napi_value tna_js_number(napi_env env, double value) {
    napi_value out = NULL;
    napi_create_double(env, value, &out);
    return out;
}

static napi_value tna_js_bigint(napi_env env, uint64_t value) {
    napi_value out = NULL;
    napi_create_bigint_uint64(env, value, &out);
    return out;
}

static napi_value tna_js_key_object(napi_env env, const ta_step_key *key) {
    napi_value out = NULL;
    napi_create_object(env, &out);
    tna_js_put(env, out, "session", tna_js_bigint(env, key->session));
    tna_js_put(env, out, "macrostep", tna_js_bigint(env, key->macrostep));
    tna_js_put(env, out, "microstep", tna_js_number(env, key->microstep));
    return out;
}

napi_value tna_traceparent_value(napi_env env, const ta_trace_parent *parent) {
    char text[56];
    uint32_t needed = 0;
    napi_value out = NULL;
    if (ta_traceparent_format(&(ta_traceparent_format_params){ .parent = *parent, .buffer = text,
                                                                .capacity = sizeof text, .needed = &needed }) ==
        TA_OK) {
        napi_create_string_latin1(env, text, needed - 1u, &out);
    } else {
        napi_get_undefined(env, &out);
    }
    return out;
}

/* ------------------------------------------------------------------------
 * The encoder's host (otlp.h)
 */

static uint64_t tna_host_now(void *self) {
    (void)self;
    return tna_system_wall_ns();
}

static void tna_host_trace_id(void *self, uint8_t out[16]) {
    tna_napi_system *wrapper = self;
    ta_trace_context context = ta_system_new_trace(wrapper->system->core);
    for (int at = 0; at < 8; at += 1) {
        out[at] = (uint8_t)(context.trace_id_high >> (56 - 8 * at));
        out[8 + at] = (uint8_t)(context.trace_id_low >> (56 - 8 * at));
    }
}

/*
 * A value's JSON text, cut at the limit (`values: true`). It runs inside
 * the core call that wrote the record, as the JavaScript data model does;
 * JSON.stringify runs no chart code, and a toJSON that calls into the
 * system meets the reentrancy guard.
 */
static bool tna_host_value_text(void *self, const ta_value *value, ta_str *out) {
    tna_napi_system *wrapper = self;
    napi_env env = wrapper->env;
    napi_handle_scope scope = NULL;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
        return false;
    }
    bool ok = false;
    napi_value js = NULL;
    napi_value global = NULL;
    napi_value json = NULL;
    napi_value stringify = NULL;
    napi_value text = NULL;
    napi_valuetype type = napi_undefined;
    bool error = false;
    /* A thrown Error is "Error: message": JSON.stringify gives "{}" for one. */
    bool got = tna_value_get(env, value, &js);
    if (got && napi_is_error(env, js, &error) == napi_ok && error) {
        got = napi_coerce_to_string(env, js, &text) == napi_ok;
    } else if (got) {
        got = napi_get_global(env, &global) == napi_ok && napi_get_named_property(env, global, "JSON", &json) == napi_ok &&
              napi_get_named_property(env, json, "stringify", &stringify) == napi_ok &&
              napi_call_function(env, json, stringify, 1, &js, &text) == napi_ok;
    }
    if (got && napi_typeof(env, text, &type) == napi_ok && type == napi_string) {
        size_t limit = wrapper->trace_value_limit < sizeof wrapper->trace_value ? wrapper->trace_value_limit
                                                                                : sizeof wrapper->trace_value - 1u;
        size_t written = 0;
        if (napi_get_value_string_utf8(env, text, wrapper->trace_value, limit + 1u, &written) == napi_ok) {
            *out = (ta_str){ wrapper->trace_value, (uint32_t)written };
            ok = true;
        }
    }
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_value ignored = NULL;
        napi_get_and_clear_last_exception(env, &ignored);
        ok = false;
    }
    napi_close_handle_scope(env, scope);
    return ok;
}

/* ------------------------------------------------------------------------
 * Dispatch: the turn's spans, as one OTLP request
 */

/*
 * One request, written straight into memory of exactly its size (napi ADR
 * 0018). napi_create_buffer does not zero-fill, and the encoder writes every
 * byte, so nothing is copied or cleared. The sink gets a plain Uint8Array
 * over that memory, as before, not the Buffer itself. The bytes belong to
 * JavaScript: a sink may keep them across an await.
 *
 * The request is written before the Buffer's ArrayBuffer is asked for. Bun
 * keeps a small Buffer's bytes in memory of its own and moves them into a
 * new ArrayBuffer when one is asked for, after which `data` is stale; a
 * request of up to 1,000 bytes written after that was lost (ADR 0026).
 */
typedef size_t (*tna_put_request)(tna_otlp *otlp, uint8_t *out, size_t size);

static napi_value tna_request_value(napi_env env, tna_otlp *otlp, size_t size, tna_put_request put) {
    void *data = NULL;
    napi_value buffer = NULL;
    napi_value memory = NULL;
    size_t offset = 0;
    napi_value array = NULL;
    if (napi_create_buffer(env, size, &data, &buffer) != napi_ok) {
        return NULL;
    }
    if (size != 0 && put(otlp, data, size) != size) {
        return NULL;
    }
    if (napi_get_typedarray_info(env, buffer, NULL, NULL, NULL, &memory, &offset) != napi_ok ||
        napi_create_typedarray(env, napi_uint8_array, size, memory, offset, &array) != napi_ok) {
        return NULL;
    }
    return array;
}

/*
 * The turn's batch, { traces, logs }: the spans that ended, as one OTLP
 * trace request (empty when none ended), and the log records, as one OTLP
 * logs request, or undefined when there are none. NULL when there is
 * neither.
 */
static napi_value tna_trace_bytes(napi_env env, tna_system *system) {
    tna_otlp *otlp = &system->otlp;
    size_t traces = tna_otlp_traces_size(otlp);
    size_t logs = tna_otlp_logs_size(otlp);
    if (!system->tracing || (traces == 0 && logs == 0)) {
        return NULL;
    }
    napi_value batch = NULL;
    napi_value traces_value = tna_request_value(env, otlp, traces, tna_otlp_put_traces);
    napi_value logs_value = NULL;
    if (logs != 0) {
        logs_value = tna_request_value(env, otlp, logs, tna_otlp_put_logs);
    } else {
        napi_get_undefined(env, &logs_value);
    }
    if (traces_value == NULL || logs_value == NULL || napi_create_object(env, &batch) != napi_ok) {
        return NULL;
    }
    tna_js_put(env, batch, "traces", traces_value);
    tna_js_put(env, batch, "logs", logs_value);
    return batch;
}

void tna_trace_dispatch(napi_env env, tna_napi_system *wrapper, napi_value *first_error) {
    tna_system *system = wrapper->system;
    if (!system->tracing) {
        return;
    }
    if (system->otlp.span_count == 0 && system->otlp.log_count == 0) {
        tna_otlp_end_turn(&system->otlp);
        return;
    }
    napi_handle_scope scope = NULL;
    napi_open_handle_scope(env, &scope);
    tna_env *data = wrapper->env_data;
    napi_value handler = NULL;
    napi_value argv[3] = { NULL, NULL, NULL };
    argv[2] = tna_trace_bytes(env, system);
    tna_otlp_end_turn(&system->otlp); /* before JavaScript runs: the sink may replace the sink */
    bool callable = argv[2] != NULL && data->effects_handler != NULL && wrapper->facade != NULL &&
                    napi_get_reference_value(env, data->effects_handler, &handler) == napi_ok && handler != NULL &&
                    napi_get_reference_value(env, wrapper->facade, &argv[0]) == napi_ok && argv[0] != NULL &&
                    napi_create_string_utf8(env, "trace", NAPI_AUTO_LENGTH, &argv[1]) == napi_ok;
    if (callable) {
        napi_value global = NULL;
        napi_value ignored = NULL;
        napi_get_global(env, &global);
        if (napi_call_function(env, global, handler, 3, argv, &ignored) != napi_ok) {
            napi_value error = NULL;
            bool pending = false;
            if (napi_is_exception_pending(env, &pending) == napi_ok && pending &&
                napi_get_and_clear_last_exception(env, &error) == napi_ok && *first_error == NULL) {
                *first_error = error;
            }
        }
    }
    if (scope != NULL) {
        napi_close_handle_scope(env, scope);
    }
}

/* ------------------------------------------------------------------------
 * Installing the sink
 */

/* Resource attributes from [key, value, key, value, ...]: strings. */
static bool tna_set_resource(napi_env env, tna_system *system, napi_value pairs) {
    uint32_t length = 0;
    bool is_array = false;
    if (napi_is_array(env, pairs, &is_array) != napi_ok || !is_array ||
        napi_get_array_length(env, pairs, &length) != napi_ok || length % 2u != 0 || length > 64u) {
        return false;
    }
    tna_otlp_attribute attributes[32];
    char text[4096];
    size_t used = 0;
    for (uint32_t at = 0; at < length; at += 1u) {
        napi_value item = NULL;
        size_t written = 0;
        if (napi_get_element(env, pairs, at, &item) != napi_ok ||
            napi_get_value_string_utf8(env, item, text + used, sizeof text - used, &written) != napi_ok ||
            used + written + 1u >= sizeof text) {
            return false;
        }
        ta_str value = { text + used, (uint32_t)written };
        if (at % 2u == 0) {
            attributes[at / 2u].key = value;
        } else {
            attributes[at / 2u].value = value;
        }
        used += written + 1u;
    }
    return tna_otlp_set_resource(&system->otlp, attributes, length / 2u) == TA_OK;
}

/*
 * setTraceSink(installed, kinds, unsampled, values, valueLimit, links,
 * resource, seed): installs the encoder and the sink adapter, or core's
 * null sink. Returns the bytes of the spans the previous sink left open,
 * ended now (marked incomplete), for the previous JavaScript sink, or
 * undefined.
 */
/* What core is asked for: the user's masks, plus UNLOADED and DESTROYED,
 * which end a session's open span (the encoder writes their spans only
 * when they were asked for). */
static tna_trace_masks tna_trace_masks_asked(const tna_trace_masks *masks, bool logs) {
    uint32_t ending = TA_TRACE_BIT(TA_TRACE_UNLOADED) | TA_TRACE_BIT(TA_TRACE_DESTROYED);
    /* Logs need the failure records whatever the detail and the sampling
     * (core ADR 0072 section 2); the encoder turns them into spans only
     * when they were asked for. */
    uint32_t failures = logs ? TA_TRACE_BIT(TA_TRACE_ACTION_FAILED) | TA_TRACE_BIT(TA_TRACE_RAISED) |
                                   TA_TRACE_BIT(TA_TRACE_STOPPED) | TA_TRACE_BIT(TA_TRACE_LONG_MACROSTEP) |
                                   TA_TRACE_BIT(TA_TRACE_RUNAWAY)
                             : 0u;
    return (tna_trace_masks){ .kinds = masks->kinds | ending | failures,
                              .watched_kinds = masks->watched_kinds | ending | failures,
                              .unsampled_kinds = masks->unsampled_kinds | failures };
}

/* The masks and the sample ratio (parts per 10^9) in argv[0..3]. */
static bool tna_trace_config(napi_env env, const napi_value *argv, tna_trace_masks *masks, uint32_t *parts) {
    return napi_get_value_uint32(env, argv[0], &masks->kinds) == napi_ok &&
           napi_get_value_uint32(env, argv[1], &masks->watched_kinds) == napi_ok &&
           napi_get_value_uint32(env, argv[2], &masks->unsampled_kinds) == napi_ok &&
           napi_get_value_uint32(env, argv[3], parts) == napi_ok && *parts <= TNA_SAMPLE_WHOLE;
}

napi_value tna_set_trace_sink_method(napi_env env, napi_callback_info info) {
    size_t argc = 11;
    napi_value argv[11] = { NULL };
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
        return NULL;
    }
    tna_napi_system *wrapper = tna_open_this(env, info);
    if (wrapper == NULL) {
        return NULL;
    }
    tna_system *system = wrapper->system;
    if (system->inside_core) {
        return tna_throw(env, "reentrant", "setTraceSink cannot be called from inside a core call (ADR 0013)");
    }
    bool installed = false;
    tna_trace_masks masks = { 0 };
    uint32_t parts = 0;
    bool values = false;
    uint32_t value_limit = 0;
    bool links = false;
    napi_valuetype seed_type = napi_undefined;
    uint32_t log_limit = 0;
    if (argc < 11 || napi_get_value_bool(env, argv[0], &installed) != napi_ok ||
        napi_get_value_uint32(env, argv[10], &log_limit) != napi_ok ||
        !tna_trace_config(env, argv + 1, &masks, &parts) ||
        napi_get_value_bool(env, argv[5], &values) != napi_ok ||
        napi_get_value_uint32(env, argv[6], &value_limit) != napi_ok ||
        napi_get_value_bool(env, argv[7], &links) != napi_ok || napi_typeof(env, argv[9], &seed_type) != napi_ok) {
        return tna_throw(env, "invalid",
                         "setTraceSink: expected (installed, kinds, watchedKinds, unsampledKinds, sample, values, "
                         "valueLimit, links, resource, seed, logLimit)");
    }
    uint64_t seed = 0;
    bool lossless = true;
    if (seed_type != napi_undefined &&
        (seed_type != napi_bigint || napi_get_value_bigint_uint64(env, argv[9], &seed, &lossless) != napi_ok ||
         !lossless)) {
        return tna_throw(env, "invalid", "setTraceSink: options.seed must be a bigint of at most 64 bits");
    }

    /* The previous sink's open spans end now, for the previous JavaScript sink. */
    napi_value remaining = NULL;
    if (system->tracing) {
        tna_otlp_end_all(&system->otlp);
        remaining = tna_trace_bytes(env, system);
        tna_otlp_destroy(&system->otlp);
        system->tracing = false;
    }
    ta_result result = ta_system_set_trace_sink(system->core, ta_null_trace_sink());
    if (result == TA_OK && installed && (masks.kinds | masks.watched_kinds | masks.unsampled_kinds) != 0) {
        tna_otlp_init(&system->otlp,
                      &(tna_otlp_config){
                          .core = system->core,
                          .allocator = tna_allocator_for(&system->allocator, TNA_MEMORY_OTHER),
                          .host = { .self = wrapper, .now = tna_host_now, .trace_id = tna_host_trace_id,
                                    .value_text = tna_host_value_text },
                          .log_limit = log_limit,
                          .link_parents = links,
                          .values = values,
                          .version = { TINYACTORS_NAPI_VERSION, (uint32_t)(sizeof TINYACTORS_NAPI_VERSION - 1u) },
                      });
        system->tracing = true;
        ta_system_seed_trace_ids(system->core, seed_type != napi_undefined ? seed : tna_system_os_seed(system));
        wrapper->trace_value_limit = value_limit;
        if (!tna_set_resource(env, system, argv[8])) {
            tna_otlp_destroy(&system->otlp);
            system->tracing = false;
            return tna_throw(env, "invalid", "setTraceSink: options.resource must map names to strings");
        }
        system->trace_masks = masks;
        tna_otlp_set_wanted(&system->otlp, masks.kinds, masks.watched_kinds, masks.unsampled_kinds);
        ta_system_set_trace_ratio(system->core, parts, TNA_SAMPLE_WHOLE);
        tna_trace_masks asked = tna_trace_masks_asked(&masks, system->otlp.config.log_limit != 0);
        result = ta_system_set_trace_sink(system->core, tna_trace_sink_adapter(system, &asked));
        if (result != TA_OK) {
            tna_otlp_destroy(&system->otlp);
            system->tracing = false;
        }
    }
    if (result == TA_OK) {
        result = tna_system_refresh_log_sink(system);
    }
    if (result != TA_OK) {
        return tna_throw(env, tna_result_code(result), "setTraceSink: core refused the sink");
    }
    if (remaining == NULL) {
        napi_get_undefined(env, &remaining);
    }
    return remaining;
}

/* configureTraces(kinds, watchedKinds, unsampledKinds, sample): new masks
 * and ratio for the installed sink, keeping its open spans. */
napi_value tna_configure_traces_method(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4] = { NULL };
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
        return NULL;
    }
    tna_napi_system *wrapper = tna_open_this(env, info);
    if (wrapper == NULL) {
        return NULL;
    }
    tna_system *system = wrapper->system;
    tna_trace_masks masks = { 0 };
    uint32_t parts = 0;
    if (argc < 4 || !tna_trace_config(env, argv, &masks, &parts)) {
        return tna_throw(env, "invalid", "configureTraces: expected (kinds, watchedKinds, unsampledKinds, sample)");
    }
    if (system->inside_core) {
        return tna_throw(env, "reentrant", "configureTraces cannot be called from inside a core call (ADR 0013)");
    }
    napi_value undefined = NULL;
    napi_get_undefined(env, &undefined);
    if (!system->tracing) {
        return undefined;
    }
    system->trace_masks = masks;
    tna_otlp_set_wanted(&system->otlp, masks.kinds, masks.watched_kinds, masks.unsampled_kinds);
    ta_system_set_trace_ratio(system->core, parts, TNA_SAMPLE_WHOLE);
    tna_trace_masks asked = tna_trace_masks_asked(&masks, system->otlp.config.log_limit != 0);
    ta_system_set_trace_sink(system->core, tna_trace_sink_adapter(system, &asked));
    return undefined;
}

/* A uint64 from a number or a bigint. */
static bool tna_uint64_of(napi_env env, napi_value value, uint64_t *out) {
    bool lossless = true;
    if (napi_get_value_bigint_uint64(env, value, out, &lossless) == napi_ok) {
        return lossless;
    }
    double number = 0;
    if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0) || number > 9007199254740991.0) {
        return false;
    }
    *out = (uint64_t)number;
    return true;
}

/*
 * The uint64s of a JavaScript array, into `*out`, allocated for them (NULL
 * when the array is empty); the caller frees it with tna_free_uint64s.
 * False when an element is not a uint64 or there is no memory.
 */
static bool tna_uint64_array(napi_env env, ta_allocator allocator, napi_value array, uint64_t **out, uint32_t *count) {
    *out = NULL;
    if (napi_get_array_length(env, array, count) != napi_ok || *count > UINT32_MAX / sizeof(uint64_t)) {
        return false;
    }
    if (*count == 0) {
        return true;
    }
    *out = tna_alloc(allocator, *count * sizeof(uint64_t), _Alignof(uint64_t));
    if (*out == NULL) {
        return false;
    }
    for (uint32_t at = 0; at < *count; at += 1u) {
        napi_value element = NULL;
        if (napi_get_element(env, array, at, &element) != napi_ok || !tna_uint64_of(env, element, &(*out)[at])) {
            return false;
        }
    }
    return true;
}

static void tna_free_uint64s(ta_allocator allocator, uint64_t *ids, uint32_t count) {
    if (ids != NULL) {
        tna_free(allocator, &(ta_allocator_free_params){ .ptr = ids, .size = count * sizeof(uint64_t),
                                                         .alignment = _Alignof(uint64_t) });
    }
}

/* Frees what tna_family_array read. */
static void tna_free_families(ta_allocator allocator, ta_str *families, uint32_t count) {
    for (uint32_t at = 0; families != NULL && at < count; at += 1u) {
        if (families[at].ptr != NULL) {
            tna_free(allocator, &(ta_allocator_free_params){ .ptr = (void *)families[at].ptr,
                                                             .size = (size_t)families[at].len + 1u, .alignment = 1 });
        }
    }
    if (families != NULL) {
        tna_free(allocator, &(ta_allocator_free_params){ .ptr = families, .size = count * sizeof(ta_str),
                                                         .alignment = _Alignof(ta_str) });
    }
}

/* Reads an array of strings. False on a wrong type or no memory. */
static bool tna_family_array(napi_env env, ta_allocator allocator, napi_value array, ta_str **out, uint32_t *count) {
    *out = NULL;
    *count = 0;
    bool is_array = false;
    uint32_t length = 0;
    if (napi_is_array(env, array, &is_array) != napi_ok || !is_array ||
        napi_get_array_length(env, array, &length) != napi_ok) {
        return false;
    }
    if (length == 0) {
        return true;
    }
    ta_str *families = tna_alloc(allocator, length * sizeof(ta_str), _Alignof(ta_str));
    if (families == NULL) {
        return false;
    }
    for (uint32_t at = 0; at < length; at += 1u) {
        families[at] = (ta_str){0};
    }
    for (uint32_t at = 0; at < length; at += 1u) {
        napi_value item = NULL;
        size_t size = 0;
        char *text = NULL;
        if (napi_get_element(env, array, at, &item) != napi_ok ||
            napi_get_value_string_utf8(env, item, NULL, 0, &size) != napi_ok || size > UINT32_MAX - 1u ||
            (text = tna_alloc(allocator, size + 1u, 1)) == NULL ||
            napi_get_value_string_utf8(env, item, text, size + 1u, &size) != napi_ok) {
            if (text != NULL) {
                tna_free(allocator, &(ta_allocator_free_params){ .ptr = text, .size = size + 1u, .alignment = 1 });
            }
            tna_free_families(allocator, families, length);
            return false;
        }
        families[at] = (ta_str){ .ptr = text, .len = (uint32_t)size };
    }
    *out = families;
    *count = length;
    return true;
}

/*
 * traceWatchSizes(): tests only. { sessions, matched, checked, capacity },
 * the sizes of the watch's sets and the slots matched and checked take, so a test can see a family watch shed the
 * definitions core frees (core ADR 0079). lib/ never calls it.
 */
napi_value tna_trace_watch_sizes_method(napi_env env, napi_callback_info info) {
    tna_napi_system *wrapper = tna_open_this(env, info);
    if (wrapper == NULL) {
        return NULL;
    }
    const tna_trace_watch *watch = &wrapper->system->trace_watch;
    napi_value sizes = NULL;
    napi_value sessions = NULL;
    napi_value matched = NULL;
    napi_value checked = NULL;
    napi_value capacity = NULL;
    if (napi_create_object(env, &sizes) != napi_ok ||
        napi_create_uint32(env, watch->sessions.count, &sessions) != napi_ok ||
        napi_create_uint32(env, watch->matched.count, &matched) != napi_ok ||
        napi_create_uint32(env, watch->checked.count, &checked) != napi_ok ||
        napi_create_uint32(env, watch->matched.capacity + watch->checked.capacity, &capacity) != napi_ok ||
        napi_set_named_property(env, sizes, "sessions", sessions) != napi_ok ||
        napi_set_named_property(env, sizes, "matched", matched) != napi_ok ||
        napi_set_named_property(env, sizes, "checked", checked) != napi_ok ||
        napi_set_named_property(env, sizes, "capacity", capacity) != napi_ok) {
        return tna_throw(env, "out-of-memory", "traceWatchSizes: cannot build the result");
    }
    return sizes;
}

/*
 * setTraceWatch(sessions, families): what is watched, replacing the last:
 * session IDs, and definition family names that the watch resolves as
 * deliveries meet each definition (watch.h). No size limit of its own.
 */
napi_value tna_set_trace_watch_method(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = { NULL };
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
        return NULL;
    }
    tna_napi_system *wrapper = tna_open_this(env, info);
    if (wrapper == NULL) {
        return NULL;
    }
    ta_allocator allocator = tna_allocator_for(&wrapper->system->allocator, TNA_MEMORY_OTHER);
    uint64_t *sessions = NULL;
    ta_str *families = NULL;
    uint32_t session_count = 0;
    uint32_t family_count = 0;
    bool read = argc >= 2 && tna_uint64_array(env, allocator, argv[0], &sessions, &session_count) &&
                tna_family_array(env, allocator, argv[1], &families, &family_count);
    ta_result result = TA_ERR_INVALID;
    if (read) {
        result = tna_trace_watch_set(&wrapper->system->trace_watch,
                                     &(tna_trace_watch_set_params){ .sessions = sessions,
                                                                    .session_count = session_count,
                                                                    .families = families,
                                                                    .family_count = family_count });
    }
    tna_free_uint64s(allocator, sessions, session_count);
    tna_free_families(allocator, families, family_count);
    if (!read) {
        return tna_throw(env, "invalid", "watchTraces: expected arrays of session IDs and family names");
    }
    if (result != TA_OK) {
        return tna_throw(env, "out-of-memory", "watchTraces: no memory for the watch");
    }
    napi_value undefined = NULL;
    napi_get_undefined(env, &undefined);
    return undefined;
}

/*
 * spawnTrace(traceparent, watched): the trace parent generated spawn takes,
 * as the object its codec reads: the parsed traceparent, a new trace when
 * there is none and tracing is on, or undefined. `watched` marks it watched
 * (the definition's family is watched).
 */
napi_value tna_spawn_trace_method(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = { NULL };
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
        return NULL;
    }
    tna_napi_system *wrapper = tna_open_this(env, info);
    ta_trace_parent parent;
    if (wrapper == NULL || !tna_trace_argument(env, argc < 1 ? NULL : argv[0], &parent)) {
        return NULL;
    }
    bool watched = false;
    if (argc >= 2 && napi_get_value_bool(env, argv[1], &watched) == napi_ok && watched && wrapper->system->tracing) {
        tna_system_start_trace(wrapper->system, &parent.context);
        parent.context.flags |= TA_TRACE_FLAG_SAMPLED;
        parent.context.detail |= TA_TRACE_DETAIL_WATCHED;
    }
    tna_system_start_trace(wrapper->system, &parent.context);
    return tna_trace_parent_object(env, &parent);
}

napi_value tna_trace_parent_object(napi_env env, const ta_trace_parent *parent) {
    napi_value out = NULL;
    if (parent->context.trace_id_high == 0 && parent->context.trace_id_low == 0) {
        napi_get_undefined(env, &out);
        return out;
    }
    napi_value context = NULL;
    napi_create_object(env, &out);
    napi_create_object(env, &context);
    tna_js_put(env, context, "trace_id_high", tna_js_bigint(env, parent->context.trace_id_high));
    tna_js_put(env, context, "trace_id_low", tna_js_bigint(env, parent->context.trace_id_low));
    tna_js_put(env, context, "flags", tna_js_number(env, parent->context.flags));
    tna_js_put(env, context, "detail", tna_js_number(env, parent->context.detail));
    tna_js_put(env, out, "context", context);
    tna_js_put(env, out, "cause", tna_js_key_object(env, &parent->cause));
    return out;
}

/* ------------------------------------------------------------------------
 * Trace parents from JavaScript: traceparent text, parsed by core (ADR 0073)
 */

bool tna_trace_argument(napi_env env, napi_value value, ta_trace_parent *out) {
    *out = (ta_trace_parent){ 0 };
    if (value == NULL) {
        return true;
    }
    /* The common cases first, one Node-API call each: text, or undefined. */
    char text[128];
    size_t len = 0;
    if (napi_get_value_string_latin1(env, value, text, sizeof text, &len) != napi_ok) {
        napi_valuetype type = napi_undefined;
        if (napi_typeof(env, value, &type) == napi_ok && type == napi_undefined) {
            return true;
        }
        len = sizeof text; /* not text: refused below */
    }
    if (len >= sizeof text - 1u ||
        ta_traceparent_parse(&(ta_traceparent_parse_params){ .text = { text, (uint32_t)len }, .out = out }) !=
            TA_OK) {
        tna_throw(env, "invalid", "options.traceparent is not a W3C traceparent");
        return false;
    }
    return true;
}

napi_value tna_trace_kind_names(napi_env env) {
    napi_value out = NULL;
    size_t count = sizeof tna_trace_kinds / sizeof tna_trace_kinds[0];
    napi_create_array_with_length(env, count, &out);
    for (uint32_t index = 0; index < count; index += 1u) {
        napi_set_element(env, out, index, tna_js_string(env, tna_trace_kinds[index], strlen(tna_trace_kinds[index])));
    }
    return out;
}
