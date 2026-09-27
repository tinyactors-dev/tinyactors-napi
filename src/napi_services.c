#include "napi_services.h"

#include "napi_children.h"

#include <string.h>

#include "adapters/invoker.h"
#include "adapters/io.h"
#include "adapters/log.h"
#include "events.h"
#include "napi_trace.h"
#include "pump.h"

/* ------------------------------------------------------------------------
 * Building payloads
 */

static napi_status tna_put(napi_env env, napi_value object, const char *name, napi_value value) {
    if (value == NULL) {
        return napi_ok;
    }
    return napi_set_named_property(env, object, name, value);
}

static napi_value tna_text(napi_env env, const char *ptr, size_t len) {
    napi_value out = NULL;
    if (napi_create_string_utf8(env, ptr == NULL ? "" : ptr, ptr == NULL ? 0 : len, &out) != napi_ok) {
        return NULL;
    }
    return out;
}

static napi_value tna_js_undefined(napi_env env) {
    napi_value out = NULL;
    napi_get_undefined(env, &out);
    return out;
}

static napi_value tna_js_null(napi_env env) {
    napi_value out = NULL;
    napi_get_null(env, &out);
    return out;
}

/* An ActorID view, or { family, name } for a named actor. */
static napi_value tna_source(napi_env env, tna_napi_system *wrapper, const ta_actor_ref *source) {
    if (source->kind == TA_ACTOR_REF_NAMED) {
        ta_actor_address address = ta_address_view(source->as.named);
        return tna_address_object(env, &address);
    }
    return tna_actor_view(env, wrapper, source->as.runtime);
}

/* The JavaScript value of `value`, or undefined when it is absent or foreign. */
static napi_value tna_value_of(napi_env env, const ta_value *value) {
    napi_value out = NULL;
    if (!tna_value_get(env, value, &out)) {
        return tna_js_undefined(env);
    }
    return out;
}

static napi_value tna_atom_text(napi_env env, tna_system *system, ta_atom atom) {
    ta_str text = { 0 };
    if (ta_system_atom_text(system->core, atom, &text) != TA_OK) {
        return tna_js_undefined(env);
    }
    return tna_text(env, text.ptr, text.len);
}

/* The send ID's text (core ADR 0048), or null when the send has none. */
static napi_value tna_send_id_text(napi_env env, tna_system *system, ta_send_id send_id) {
    char stack[128];
    uint32_t needed = 0;
    ta_send_id_format_params params = { .send_id = send_id, .buffer = stack, .capacity = sizeof stack, .needed = &needed };
    ta_result result = ta_send_id_format(system->core, &params);
    char *text = stack;
    if (result == TA_ERR_NOMEM && needed > sizeof stack) {
        text = ta_arena_alloc(&system->scratch.turn, needed, 1);
        if (text == NULL) {
            return tna_js_null(env);
        }
        params.buffer = text;
        params.capacity = needed;
        result = ta_send_id_format(system->core, &params);
    }
    if (result != TA_OK) {
        return tna_js_null(env);
    }
    return tna_text(env, text, needed > 0 ? needed - 1u : 0);
}

/* Literal <content>: its text, or undefined without one. */
static void tna_content(napi_env env, napi_value payload, const tna_effect *effect) {
    if (effect->content.ptr == NULL) {
        return;
    }
    tna_put(env, payload, "content", tna_text(env, (const char *)effect->content.ptr, effect->content.len));
    tna_put(env, payload, "contentType", tna_text(env, effect->content_type.ptr, effect->content_type.len));
}

static napi_value tna_handle(napi_env env, uint64_t handle) {
    napi_value out = NULL;
    napi_create_double(env, (double)handle, &out);
    return out;
}

static napi_value tna_log_payload(napi_env env, tna_napi_system *wrapper, const tna_effect *effect) {
    napi_value payload = NULL;
    napi_value has_value = NULL;
    if (napi_create_object(env, &payload) != napi_ok || napi_get_boolean(env, effect->has_value, &has_value) != napi_ok) {
        return NULL;
    }
    tna_put(env, payload, "source", tna_source(env, wrapper, &effect->source));
    if (effect->label.len > 0) {
        tna_put(env, payload, "label", tna_text(env, effect->label.ptr, effect->label.len));
    }
    tna_put(env, payload, "hasValue", has_value);
    if (effect->has_value) {
        tna_put(env, payload, "value", tna_value_of(env, &effect->value));
    }
    return payload;
}

static napi_value tna_io_payload(napi_env env, tna_napi_system *wrapper, const tna_effect *effect) {
    tna_system *system = wrapper->system;
    napi_value payload = NULL;
    if (napi_create_object(env, &payload) != napi_ok) {
        return NULL;
    }
    tna_put(env, payload, "source", tna_source(env, wrapper, &effect->source));
    tna_put(env, payload, "sendID", tna_send_id_text(env, system, effect->send_id));
    tna_put(env, payload, "event", effect->event == 0 ? tna_js_undefined(env) : tna_event_text(env, system, effect->event));
    tna_put(env, payload, "type", tna_atom_text(env, system, effect->type));
    tna_put(env, payload, "target",
            effect->target_text.ptr != NULL ? tna_text(env, effect->target_text.ptr, effect->target_text.len)
                                            : tna_value_of(env, &effect->target));
    tna_put(env, payload, "data", tna_value_of(env, &effect->value));
    tna_put(env, payload, "traceparent", tna_traceparent_value(env, &effect->trace));
    tna_content(env, payload, effect);
    return payload;
}

static napi_value tna_start_payload(napi_env env, tna_napi_system *wrapper, const tna_effect *effect) {
    tna_system *system = wrapper->system;
    napi_value payload = NULL;
    napi_value invocation = NULL;
    napi_value autoforward = NULL;
    if (napi_create_object(env, &payload) != napi_ok ||
        napi_create_bigint_uint64(env, effect->invoke_id, &invocation) != napi_ok ||
        napi_get_boolean(env, effect->autoforward, &autoforward) != napi_ok) {
        return NULL;
    }
    ta_str invoke_text = { 0 };
    napi_value invoke_id = ta_system_invoke_id_text(system->core, effect->invoke_id, &invoke_text) == TA_OK
                               ? tna_text(env, invoke_text.ptr, invoke_text.len)
                               : tna_js_undefined(env);
    tna_put(env, payload, "handle", tna_handle(env, effect->service));
    tna_put(env, payload, "parent", tna_actor_view(env, wrapper, effect->parent));
    tna_put(env, payload, "invocationID", invocation);
    tna_put(env, payload, "invokeID", invoke_id);
    tna_put(env, payload, "type", tna_atom_text(env, system, effect->type));
    tna_put(env, payload, "source",
            effect->target_text.ptr != NULL ? tna_text(env, effect->target_text.ptr, effect->target_text.len)
                                            : tna_value_of(env, &effect->target));
    tna_put(env, payload, "params", tna_value_of(env, &effect->params));
    tna_put(env, payload, "traceparent", tna_traceparent_value(env, &effect->trace));
    tna_put(env, payload, "autoforward", autoforward);
    if (effect->content.ptr != NULL) {
        tna_content(env, payload, effect);
    } else {
        tna_put(env, payload, "content", tna_value_of(env, &effect->value));
    }
    return payload;
}

static napi_value tna_cancel_payload(napi_env env, const tna_effect *effect) {
    napi_value payload = NULL;
    if (napi_create_object(env, &payload) != napi_ok) {
        return NULL;
    }
    tna_put(env, payload, "handle", tna_handle(env, effect->service));
    return payload;
}

static napi_value tna_forward_payload(napi_env env, tna_napi_system *wrapper, const tna_effect *effect) {
    napi_value payload = NULL;
    napi_value event = NULL;
    if (napi_create_object(env, &payload) != napi_ok || napi_create_object(env, &event) != napi_ok) {
        return NULL;
    }
    tna_put(env, event, "name", tna_event_text(env, wrapper->system, effect->forwarded.name));
    tna_put(env, event, "data", tna_value_of(env, &effect->forwarded.data));
    tna_put(env, payload, "handle", tna_handle(env, effect->service));
    tna_put(env, payload, "event", event);
    return payload;
}

static const char *const tna_effect_kinds[] = {
    [TNA_EFFECT_LOG] = "log",
    [TNA_EFFECT_IO] = "io",
    [TNA_EFFECT_INVOKE_START] = "invoke-start",
    [TNA_EFFECT_INVOKE_CANCEL] = "invoke-cancel",
    [TNA_EFFECT_INVOKE_FORWARD] = "invoke-forward",
};

static napi_value tna_payload(napi_env env, tna_napi_system *wrapper, const tna_effect *effect) {
    switch (effect->kind) {
    case TNA_EFFECT_LOG:
        return tna_log_payload(env, wrapper, effect);
    case TNA_EFFECT_IO:
        return tna_io_payload(env, wrapper, effect);
    case TNA_EFFECT_INVOKE_START:
        return tna_start_payload(env, wrapper, effect);
    case TNA_EFFECT_INVOKE_CANCEL:
        return tna_cancel_payload(env, effect);
    case TNA_EFFECT_INVOKE_FORWARD:
    default:
        return tna_forward_payload(env, wrapper, effect);
    }
}

/* ------------------------------------------------------------------------
 * Dispatch
 */

void tna_services_dispatch(napi_env env, tna_napi_system *wrapper, napi_value *first_error) {
    tna_system *system = wrapper->system;
    tna_env *data = wrapper->env_data;
    tna_effect *effect = NULL;
    while (!tna_system_closed(system) && (effect = tna_effects_pop(&system->effects)) != NULL) {
        napi_handle_scope scope = NULL;
        napi_open_handle_scope(env, &scope);
        napi_value handler = NULL;
        napi_value argv[3] = { NULL, NULL, NULL };
        if (data->effects_handler != NULL && wrapper->facade != NULL &&
            napi_get_reference_value(env, data->effects_handler, &handler) == napi_ok && handler != NULL &&
            napi_get_reference_value(env, wrapper->facade, &argv[0]) == napi_ok && argv[0] != NULL &&
            napi_create_string_utf8(env, tna_effect_kinds[effect->kind], NAPI_AUTO_LENGTH, &argv[1]) == napi_ok &&
            (argv[2] = tna_payload(env, wrapper, effect)) != NULL) {
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
        tna_effect_release(effect);
        if (scope != NULL) {
            napi_close_handle_scope(env, scope);
        }
    }
}

/*
 * The data of the error.communication a chart gets for mail to a target
 * that does not exist (napi ADR 0022): { reason, target }, the target named
 * as a deadLetter hook names it (an ActorID, or { family, name }).
 */
static bool tna_unreachable_data(void *context, const tna_unreachable *unreachable, ta_value *out) {
    tna_napi_system *wrapper = context;
    if (!wrapper->dm.js_usable) {
        return false;
    }
    napi_env env = wrapper->env;
    napi_handle_scope scope = NULL;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
        return false;
    }
    const ta_actor_ref *destination = unreachable->destination;
    ta_actor_address address = { 0 };
    if (destination->kind == TA_ACTOR_REF_NAMED) {
        address = ta_address_view(destination->as.named);
    }
    napi_value target = destination->kind == TA_ACTOR_REF_NAMED
                            ? tna_address_object(env, &address)
                            : tna_actor_view(env, wrapper, destination->as.runtime);
    napi_value data = NULL;
    napi_value reason = NULL;
    bool made = target != NULL && napi_create_object(env, &data) == napi_ok &&
                napi_create_string_utf8(env, tna_dead_reason_name(unreachable->reason), NAPI_AUTO_LENGTH, &reason) ==
                    napi_ok &&
                napi_set_named_property(env, data, "reason", reason) == napi_ok &&
                napi_set_named_property(env, data, "target", target) == napi_ok &&
                tna_value_make(&wrapper->values, data, out);
    napi_close_handle_scope(env, scope);
    return made;
}

/*
 * The data of the error.communication.invoke.<id>.quarantined a quarantined
 * child's parent gets (napi ADR 0025): { code, message }, as the fault hook
 * has them.
 */
static bool tna_quarantine_data(void *context, const tna_quarantine_report *report, ta_value *out) {
    tna_napi_system *wrapper = context;
    if (!wrapper->dm.js_usable) {
        return false;
    }
    napi_env env = wrapper->env;
    napi_handle_scope scope = NULL;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
        return false;
    }
    char text[160];
    tna_fault_message(report->operation, report->code, text, sizeof text);
    napi_value data = NULL;
    napi_value code = NULL;
    napi_value message = NULL;
    bool made = napi_create_object(env, &data) == napi_ok &&
                napi_create_string_utf8(env, tna_result_code(report->code), NAPI_AUTO_LENGTH, &code) == napi_ok &&
                napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message) == napi_ok &&
                napi_set_named_property(env, data, "code", code) == napi_ok &&
                napi_set_named_property(env, data, "message", message) == napi_ok &&
                tna_value_make(&wrapper->values, data, out);
    napi_close_handle_scope(env, scope);
    return made;
}

void tna_services_init(tna_napi_system *wrapper) {
    tna_children_init(wrapper);
    wrapper->system->unreachable_data = tna_unreachable_data;
    wrapper->system->unreachable_context = wrapper;
    wrapper->system->quarantine_data = tna_quarantine_data;
    wrapper->system->quarantine_context = wrapper;
}

/* ------------------------------------------------------------------------
 * Registration
 */

/* The atom of a type string argument, interned in core. */
static bool tna_type_atom(napi_env env, tna_system *system, napi_value value, const char *what, ta_atom *out) {
    napi_valuetype type = napi_undefined;
    size_t length = 0;
    if (value == NULL || napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0) {
        tna_throw(env, "invalid", what);
        return false;
    }
    char *text = ta_arena_alloc(&system->scratch.call, length + 1u, 1);
    if (text == NULL) {
        tna_throw(env, "out-of-memory", "cannot read the type");
        return false;
    }
    napi_get_value_string_utf8(env, value, text, length + 1u, &length);
    ta_result result = ta_system_intern_atom(system->core, (ta_str){ .ptr = text, .len = (uint32_t)length }, out);
    tna_scratch_reset_call(&system->scratch);
    if (result != TA_OK) {
        tna_throw(env, tna_result_code(result), "cannot intern the type");
        return false;
    }
    return true;
}

static tna_napi_system *tna_services_this(napi_env env, napi_callback_info info, size_t *argc, napi_value *argv) {
    if (napi_get_cb_info(env, info, argc, argv, NULL, NULL) != napi_ok) {
        return NULL;
    }
    tna_napi_system *wrapper = tna_open_this(env, info);
    if (wrapper != NULL && wrapper->system->inside_core) {
        tna_throw(env, "reentrant", "services cannot be changed from inside a core call (ADR 0013)");
        return NULL;
    }
    return wrapper;
}

/* An optional string argument copied into the call arena; empty when undefined. */
static bool tna_optional_text(napi_env env, tna_system *system, napi_value value, ta_str *out) {
    napi_valuetype type = napi_undefined;
    *out = (ta_str){ NULL, 0 };
    if (value == NULL || napi_typeof(env, value, &type) != napi_ok || type == napi_undefined) {
        return true;
    }
    size_t length = 0;
    if (type != napi_string || napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
        return false;
    }
    char *text = ta_arena_alloc(&system->scratch.call, length + 1u, 1);
    if (text == NULL) {
        return false;
    }
    napi_get_value_string_utf8(env, value, text, length + 1u, &length);
    *out = (ta_str){ .ptr = text, .len = (uint32_t)length };
    return true;
}

/*
 * registerIO(type, location?, origin?): core sends <send type> to the
 * JavaScript processors (lib/system.js). `location` and `origin` are the
 * templates the native adapter renders for _ioprocessors and for computed
 * origins (adapters/io.h, core ADR 0068). Returns the registry index.
 */
napi_value tna_register_io_method(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = { NULL, NULL, NULL };
    tna_napi_system *wrapper = tna_services_this(env, info, &argc, argv);
    ta_atom atom = 0;
    if (wrapper == NULL || !tna_type_atom(env, wrapper->system, argv[0], "registerIO(): expected a type string", &atom)) {
        return NULL;
    }
    tna_system *system = wrapper->system;
    tna_io_registration registration = { .type = atom };
    uint32_t index = 0;
    registration.index = &index;
    if (!tna_optional_text(env, system, argc > 1 ? argv[1] : NULL, &registration.location) ||
        !tna_optional_text(env, system, argc > 2 ? argv[2] : NULL, &registration.origin)) {
        tna_scratch_reset_call(&system->scratch);
        return tna_throw(env, "invalid", "registerIO(): options.location and options.origin must be strings");
    }
    ta_result result = tna_io_register(system, &registration);
    tna_scratch_reset_call(&system->scratch);
    if (result != TA_OK) {
        return tna_throw(env, tna_result_code(result),
                         "registerIO(): core refused the type (the SCXML event processor's type is reserved)");
    }
    napi_value out = NULL;
    napi_create_uint32(env, index, &out);
    return out;
}

/* The registry index of a registered I/O processor type (core ADR 0068); throws otherwise. */
static bool tna_processor_index(napi_env env, tna_system *system, napi_value type, const char *what, uint32_t *out) {
    ta_atom atom = 0;
    if (!tna_type_atom(env, system, type, what, &atom)) {
        return false;
    }
    if (ta_system_find_io(system->core, atom, out) != TA_OK || *out == 0) {
        tna_throw(env, "invalid", "no JavaScript I/O processor is registered for the origin's type");
        return false;
    }
    return true;
}

static bool tna_object_member(napi_env env, napi_value object, const char *name, napi_value *out) {
    bool has = false;
    napi_valuetype type = napi_undefined;
    *out = NULL;
    if (napi_has_named_property(env, object, name, &has) != napi_ok || !has ||
        napi_get_named_property(env, object, name, out) != napi_ok || napi_typeof(env, *out, &type) != napi_ok ||
        type == napi_undefined) {
        *out = NULL;
    }
    return *out != NULL;
}

bool tna_origin_argument(napi_env env, tna_system *system, napi_value value, ta_origin *out) {
    *out = (ta_origin){ .kind = TA_ORIGIN_NONE };
    napi_valuetype type = napi_undefined;
    if (value == NULL || napi_typeof(env, value, &type) != napi_ok || type == napi_undefined) {
        return true;
    }
    napi_value field = NULL;
    if (type != napi_object || !tna_object_member(env, value, "type", &field)) {
        tna_throw(env, "invalid", "origin: expected { type, uri } or { type, scope } or { type, token }");
        return false;
    }
    if (system->inside_core) {
        tna_throw(env, "reentrant", "origin: an origin cannot be made from inside a core call (ADR 0013)");
        return false;
    }
    ta_io_origin_make_params params = { .out = out };
    if (!tna_processor_index(env, system, field, "origin.type: expected a processor type string", &params.processor)) {
        return false;
    }
    napi_value uri = NULL;
    napi_value scope = NULL;
    napi_value token = NULL;
    if (tna_object_member(env, value, "uri", &uri)) {
        size_t length = 0;
        if (napi_get_value_string_utf8(env, uri, NULL, 0, &length) != napi_ok) {
            tna_throw(env, "invalid", "origin.uri: expected a string");
            return false;
        }
        char *text = ta_arena_alloc(&system->scratch.call, length + 1u, 1);
        if (text == NULL) {
            tna_throw(env, "out-of-memory", "origin: cannot read the URI");
            return false;
        }
        napi_get_value_string_utf8(env, uri, text, length + 1u, &length);
        params.origin_class = TA_IO_ORIGIN_MESSAGE;
        params.uri = (ta_str){ .ptr = text, .len = (uint32_t)length };
    } else if (tna_object_member(env, value, "scope", &scope)) {
        napi_value index = NULL;
        napi_value generation = NULL;
        if (!tna_object_member(env, scope, "index", &index) || !tna_object_member(env, scope, "generation", &generation) ||
            napi_get_value_uint32(env, index, &params.scope.index) != napi_ok ||
            napi_get_value_uint32(env, generation, &params.scope.generation) != napi_ok) {
            tna_throw(env, "invalid", "origin.scope: expected a scope from openScope()");
            return false;
        }
        params.origin_class = TA_IO_ORIGIN_SCOPED;
    } else if (tna_object_member(env, value, "token", &token)) {
        napi_valuetype kind = napi_undefined;
        double number = 0;
        bool lossless = true;
        napi_typeof(env, token, &kind);
        if (kind == napi_bigint ? napi_get_value_bigint_uint64(env, token, &params.token, &lossless) != napi_ok || !lossless
                                : napi_get_value_double(env, token, &number) != napi_ok || !(number >= 0) ||
                                      number != (double)(uint64_t)number) {
            tna_throw(env, "invalid", "origin.token: expected a non-negative integer or bigint");
            return false;
        }
        if (kind != napi_bigint) {
            params.token = (uint64_t)number;
        }
        if (!tna_io_renders_origins(system, params.processor)) {
            tna_throw(env, "invalid", "origin.token: the processor was registered without an origin template");
            return false;
        }
        params.origin_class = TA_IO_ORIGIN_COMPUTED;
    } else {
        tna_throw(env, "invalid", "origin: expected { type, uri } or { type, scope } or { type, token }");
        return false;
    }
    ta_result result = ta_io_origin_make(system->core, &params);
    tna_scratch_reset_call(&system->scratch);
    if (result == TA_ERR_NOT_FOUND) {
        tna_throw(env, "stale", "origin.scope: the scope is closed");
        return false;
    }
    if (result != TA_OK) {
        tna_throw(env, tna_result_code(result), "origin: core refused it");
        return false;
    }
    return true;
}

/* openScope(type, uri): a connection's scope, { index, generation } (core ADR 0068). */
napi_value tna_open_scope_method(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = { NULL, NULL };
    tna_napi_system *wrapper = tna_services_this(env, info, &argc, argv);
    if (wrapper == NULL) {
        return NULL;
    }
    tna_system *system = wrapper->system;
    if (system->inside_core) {
        return tna_throw(env, "reentrant", "openScope(): cannot run inside a core call (ADR 0013)");
    }
    uint32_t processor = 0;
    if (!tna_processor_index(env, system, argv[0], "openScope(): expected a processor type string", &processor)) {
        return NULL;
    }
    ta_str uri = { NULL, 0 };
    if (!tna_optional_text(env, system, argc > 1 ? argv[1] : NULL, &uri) || uri.len == 0) {
        tna_scratch_reset_call(&system->scratch);
        return tna_throw(env, "invalid", "openScope(): expected a URI string");
    }
    ta_io_scope scope = { 0, 0 };
    ta_result result =
        ta_io_scope_open(system->core, &(ta_io_scope_open_params){ .processor = processor, .uri = uri, .out = &scope });
    tna_scratch_reset_call(&system->scratch);
    if (result != TA_OK) {
        return tna_throw(env, tna_result_code(result), "openScope(): core refused it");
    }
    napi_value out = NULL;
    napi_value index = NULL;
    napi_value generation = NULL;
    if (napi_create_object(env, &out) != napi_ok || napi_create_uint32(env, scope.index, &index) != napi_ok ||
        napi_create_uint32(env, scope.generation, &generation) != napi_ok ||
        napi_set_named_property(env, out, "index", index) != napi_ok ||
        napi_set_named_property(env, out, "generation", generation) != napi_ok) {
        return NULL;
    }
    return out;
}

/* closeScope(index, generation): events from the scope keep no origin text afterwards. */
napi_value tna_close_scope_method(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = { NULL, NULL };
    tna_napi_system *wrapper = tna_services_this(env, info, &argc, argv);
    if (wrapper == NULL) {
        return NULL;
    }
    tna_system *system = wrapper->system;
    if (system->inside_core) {
        return tna_throw(env, "reentrant", "closeScope(): cannot run inside a core call (ADR 0013)");
    }
    ta_io_scope scope = { 0, 0 };
    if (argc < 2 || napi_get_value_uint32(env, argv[0], &scope.index) != napi_ok ||
        napi_get_value_uint32(env, argv[1], &scope.generation) != napi_ok) {
        return tna_throw(env, "invalid", "closeScope(): expected a scope from openScope()");
    }
    ta_io_scope_close(system->core, scope);
    return tna_js_undefined(env);
}

/* registerInvoker(type): core starts <invoke type> through the JavaScript invokers. */
napi_value tna_register_invoker_method(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = { NULL };
    tna_napi_system *wrapper = tna_services_this(env, info, &argc, argv);
    ta_atom atom = 0;
    if (wrapper == NULL ||
        !tna_type_atom(env, wrapper->system, argv[0], "registerInvoker(): expected a type string", &atom)) {
        return NULL;
    }
    tna_system *system = wrapper->system;
    ta_result result = ta_system_register_invoker(system->core, atom, tna_js_invoker_adapter(system));
    if (result != TA_OK) {
        return tna_throw(env, tna_result_code(result), "registerInvoker(): core refused the type");
    }
    return tna_js_undefined(env);
}

/* setLogSink(installed): installs the buffered sink adapter, or uninstalls it. */
napi_value tna_set_log_sink_method(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = { NULL };
    tna_napi_system *wrapper = tna_services_this(env, info, &argc, argv);
    if (wrapper == NULL) {
        return NULL;
    }
    bool installed = false;
    if (argc < 1 || napi_get_value_bool(env, argv[0], &installed) != napi_ok) {
        return tna_throw(env, "invalid", "setLogSink: expected a boolean");
    }
    tna_system *system = wrapper->system;
    system->log_to_js = installed;
    ta_result result = tna_system_refresh_log_sink(system);
    if (result != TA_OK) {
        return tna_throw(env, tna_result_code(result), "setLogSink: core refused the sink");
    }
    return tna_js_undefined(env);
}

/* ------------------------------------------------------------------------
 * Reports from JavaScript invocations
 */

/* The event name done.invoke.<invokeid> of an invocation (SCXML 6.4). */
static ta_result tna_done_name(tna_system *system, ta_invoke_id invoke, ta_event_name_id *out) {
    static const char prefix[] = "done.invoke.";
    ta_str id = { 0 };
    ta_result result = ta_system_invoke_id_text(system->core, invoke, &id);
    if (result != TA_OK) {
        return result;
    }
    size_t length = sizeof prefix - 1u + id.len;
    char *text = ta_arena_alloc(&system->scratch.call, length, 1);
    if (text == NULL) {
        return TA_ERR_NOMEM;
    }
    memcpy(text, prefix, sizeof prefix - 1u);
    memcpy(text + sizeof prefix - 1u, id.ptr, id.len);
    result = tna_event_name_intern(system->core, (ta_str){ .ptr = text, .len = (uint32_t)length }, out);
    tna_scratch_reset_call(&system->scratch);
    return result;
}

/*
 * reportInvoke(slot, generation, invocationID, kind, name, data, traceparent): a
 * JavaScript invocation reports to its parent. `kind` is "event" (with the
 * interned `name`), "done" or "unavailable"; `data` is the event data, the
 * done data, or the error. Returns true when the report was taken, false
 * when the parent or the invocation is gone. Throws when the report was not
 * taken but could be again: "queue-full" when the parent's mailbox is at its
 * limits, "out-of-memory" when core or the addon could not allocate. The
 * caller keeps a throwing invocation alive, so its service can retry.
 */
napi_value tna_report_invoke_method(napi_env env, napi_callback_info info) {
    size_t argc = 7;
    napi_value argv[7] = { NULL, NULL, NULL, NULL, NULL, NULL, NULL };
    tna_napi_system *wrapper = tna_services_this(env, info, &argc, argv);
    if (wrapper == NULL) {
        return NULL;
    }
    tna_system *system = wrapper->system;
    uint32_t slot = 0;
    uint32_t generation = 0;
    uint64_t invoke = 0;
    bool lossless = false;
    char kind[16] = { 0 };
    size_t kind_length = 0;
    if (argc < 4 || napi_get_value_uint32(env, argv[0], &slot) != napi_ok ||
        napi_get_value_uint32(env, argv[1], &generation) != napi_ok ||
        napi_get_value_bigint_uint64(env, argv[2], &invoke, &lossless) != napi_ok || !lossless ||
        napi_get_value_string_utf8(env, argv[3], kind, sizeof kind, &kind_length) != napi_ok) {
        return tna_throw(env, "invalid", "reportInvoke: expected (slot, generation, invocationID, kind, name, data)");
    }
    ta_actor_id parent = ta_actor_id_make(slot, generation);
    napi_value taken = NULL;
    if (strcmp(kind, "unavailable") == 0) {
        /* A lost service: its invocation ends (core ADR 0081). */
        ta_value data = { 0 };
        napi_valuetype type = napi_undefined;
        bool has_data = argc >= 6 && napi_typeof(env, argv[5], &type) == napi_ok && type != napi_undefined;
        if (has_data && !tna_value_make(&wrapper->values, argv[5], &data)) {
            return tna_throw(env, "out-of-memory", "reportInvoke: cannot keep the error");
        }
        ta_invoke_error error = {
            .reason = { .ptr = "unavailable", .len = 11 },
            .data = has_data ? &data : NULL,
            .ends = true,
        };
        system->inside_core = true;
        ta_result result = ta_actor_report_invoke(system->core, &(ta_invoke_report_params){
                                                                    .actor = parent,
                                                                    .invoke_id = invoke,
                                                                    .kind = TA_INVOKE_REPORT_ERROR,
                                                                    .as.error = &error,
                                                                });
        system->inside_core = false;
        ta_value_release(&data);
        if (result == TA_ERR_NOMEM) {
            return tna_throw(env, "out-of-memory", "reportInvoke: the report was not accepted");
        }
        if (result == TA_OK) {
            (void)tna_sched_wake(&system->sched, parent);
            tna_system_want_turn(system);
        }
        napi_get_boolean(env, result == TA_OK, &taken);
        return taken;
    }
    ta_event_name_id name = 0;
    if (strcmp(kind, "done") == 0) {
        system->inside_core = true;
        ta_result result = tna_done_name(system, invoke, &name);
        system->inside_core = false;
        if (result == TA_ERR_NOMEM) {
            return tna_throw(env, "out-of-memory", "reportInvoke: cannot name the done event");
        }
        if (result != TA_OK) {
            napi_get_boolean(env, false, &taken);
            return taken;
        }
    } else if (strcmp(kind, "event") != 0 || argc < 5 || napi_get_value_uint32(env, argv[4], &name) != napi_ok) {
        return tna_throw(env, "invalid", "reportInvoke: kind must be \"event\" (with a name), \"done\" or \"unavailable\"");
    }
    ta_event event = {
        .name = name,
        .type = TA_EVENT_EXTERNAL,
        /* No origin: core gives the service's event its invoke origin on delivery (ADR 0068). */
        .invoke_id = invoke,
    };
    napi_valuetype type = napi_undefined;
    if (argc >= 6 && napi_typeof(env, argv[5], &type) == napi_ok && type != napi_undefined &&
        !tna_value_make(&wrapper->values, argv[5], &event.data)) {
        return tna_throw(env, "out-of-memory", "reportInvoke: cannot keep the data");
    }
    /* The service's events stay in the trace of the step that invoked it (napi ADR 0017 section 6). */
    ta_trace_parent trace;
    if (!tna_trace_argument(env, argc >= 7 ? argv[6] : NULL, &trace)) {
        ta_value_release(&event.data);
        return NULL;
    }
    ta_result result = tna_system_post(system, &(tna_message){ .target = parent, .event = &event, .trace = &trace });
    if (result != TA_OK) {
        ta_value_release(&event.data);
        if (result == TA_ERR_BUSY) {
            return tna_throw(env, "queue-full", "reportInvoke: the parent's mailbox is full");
        }
        return tna_throw(env, tna_result_code(result), "reportInvoke: the report was not accepted");
    }
    napi_get_boolean(env, true, &taken);
    return taken;
}
