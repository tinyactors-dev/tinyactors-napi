/*
 * Hand-written codecs for generated calls (ADR 0013): primitives, strings,
 * bytes, the overridden types and the injected adapters. Generated codecs in
 * src/gen/ta_napi.c build every struct from these.
 *
 * Integers that cross as numbers must be integral and in range. 64-bit
 * integers cross as bigints unless bindings.rb lists them in NUMBER_TYPES;
 * a decoder also accepts a safe-integer number for them.
 */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "allocator.h"
#include "runtime.h"
#include "napi_system.h"
#include "system.h"
#include "values.h"

#define TNA_MAX_SAFE_INTEGER 9007199254740991.0

/* A number that is an integer in [minimum, maximum]. */
typedef struct {
    double minimum;
    double maximum;
    double value;
} tna_integer;

static bool tna_read_integer(tna_call *call, napi_value value, tna_integer *integer) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(call->env, value, &type) != napi_ok || type != napi_number) {
        return tna_invalid(call, "a number");
    }
    if (!tna_ok(call, napi_get_value_double(call->env, value, &integer->value))) {
        return false;
    }
    if (!isfinite(integer->value) || floor(integer->value) != integer->value || integer->value < integer->minimum ||
        integer->value > integer->maximum) {
        char expected[96];
        snprintf(expected, sizeof expected, "an integer from %.0f to %.0f", integer->minimum, integer->maximum);
        return tna_invalid(call, expected);
    }
    return true;
}

bool tna_dec_bool(tna_call *call, napi_value value, bool *out) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(call->env, value, &type) != napi_ok || type != napi_boolean) {
        return tna_invalid(call, "a boolean");
    }
    return tna_ok(call, napi_get_value_bool(call->env, value, out));
}

#define TNA_INTEGER_DECODER(ctype, low, high)                                     \
    bool tna_dec_##ctype(tna_call *call, napi_value value, ctype *out) {          \
        tna_integer integer = { (low), (high), 0 };                               \
        if (!tna_read_integer(call, value, &integer)) {                           \
            return false;                                                         \
        }                                                                         \
        *out = (ctype)integer.value;                                              \
        return true;                                                              \
    }

TNA_INTEGER_DECODER(uint8_t, 0.0, 255.0)
TNA_INTEGER_DECODER(uint16_t, 0.0, 65535.0)
TNA_INTEGER_DECODER(uint32_t, 0.0, 4294967295.0)
TNA_INTEGER_DECODER(int32_t, -2147483648.0, 2147483647.0)
TNA_INTEGER_DECODER(int, -2147483648.0, 2147483647.0)
TNA_INTEGER_DECODER(size_t, 0.0, TNA_MAX_SAFE_INTEGER)

bool tna_dec_u64n(tna_call *call, napi_value value, uint64_t *out) {
    tna_integer integer = { 0.0, TNA_MAX_SAFE_INTEGER, 0 };
    if (!tna_read_integer(call, value, &integer)) {
        return false;
    }
    *out = (uint64_t)integer.value;
    return true;
}

bool tna_dec_uint64_t(tna_call *call, napi_value value, uint64_t *out) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(call->env, value, &type) != napi_ok) {
        return tna_invalid(call, "a bigint");
    }
    if (type == napi_number) {
        return tna_dec_u64n(call, value, out);
    }
    bool lossless = false;
    if (type != napi_bigint || napi_get_value_bigint_uint64(call->env, value, out, &lossless) != napi_ok || !lossless) {
        return tna_invalid(call, "a bigint from 0 to 2^64 - 1");
    }
    return true;
}

napi_value tna_enc_bool(tna_call *call, const bool *in) {
    napi_value value = NULL;
    return tna_ok(call, napi_get_boolean(call->env, *in, &value)) ? value : NULL;
}

napi_value tna_enc_uint8_t(tna_call *call, const uint8_t *in) { return tna_number(call, (double)*in); }
napi_value tna_enc_uint16_t(tna_call *call, const uint16_t *in) { return tna_number(call, (double)*in); }
napi_value tna_enc_uint32_t(tna_call *call, const uint32_t *in) { return tna_number(call, (double)*in); }
napi_value tna_enc_int32_t(tna_call *call, const int32_t *in) { return tna_number(call, (double)*in); }
napi_value tna_enc_int(tna_call *call, const int *in) { return tna_number(call, (double)*in); }
napi_value tna_enc_size_t(tna_call *call, const size_t *in) { return tna_number(call, (double)*in); }
napi_value tna_enc_u64n(tna_call *call, const uint64_t *in) { return tna_number(call, (double)*in); }

napi_value tna_enc_uint64_t(tna_call *call, const uint64_t *in) {
    napi_value value = NULL;
    return tna_ok(call, napi_create_bigint_uint64(call->env, *in, &value)) ? value : NULL;
}

/* ------------------------------------------------------------------------
 * Strings and bytes: copied into the call arena, since core borrows them.
 */

bool tna_dec_ta_str(tna_call *call, napi_value value, ta_str *out) {
    napi_valuetype type = napi_undefined;
    size_t length = 0;
    if (napi_typeof(call->env, value, &type) != napi_ok || type != napi_string) {
        return tna_invalid(call, "a string");
    }
    if (!tna_ok(call, napi_get_value_string_utf8(call->env, value, NULL, 0, &length))) {
        return false;
    }
    if (length > UINT32_MAX - 1u) {
        return tna_invalid(call, "a shorter string");
    }
    char *text = tna_call_alloc(call, length + 1u, 1);
    if (text == NULL || !tna_ok(call, napi_get_value_string_utf8(call->env, value, text, length + 1u, &length))) {
        return false;
    }
    *out = (ta_str){ text, (uint32_t)length };
    return true;
}

napi_value tna_enc_ta_str(tna_call *call, const ta_str *in) {
    if (in->ptr == NULL) {
        return tna_undefined(call);
    }
    napi_value value = NULL;
    return tna_ok(call, napi_create_string_utf8(call->env, in->ptr, in->len, &value)) ? value : NULL;
}

napi_value tna_enc_text(tna_call *call, const char *text, uint32_t count) {
    napi_value value = NULL;
    const char *end = count == 0 || text == NULL ? NULL : memchr(text, '\0', count);
    size_t length = count == 0 || text == NULL ? 0 : (end == NULL ? count : (size_t)(end - text));
    return tna_ok(call, napi_create_string_utf8(call->env, text == NULL ? "" : text, length, &value)) ? value : NULL;
}

bool tna_dec_ta_bytes(tna_call *call, napi_value value, ta_bytes *out) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(call->env, value, &type) == napi_ok && type == napi_string) {
        ta_str text = { NULL, 0 };
        if (!tna_dec_ta_str(call, value, &text)) {
            return false;
        }
        *out = (ta_bytes){ (const uint8_t *)text.ptr, text.len };
        return true;
    }
    bool typed = false;
    napi_typedarray_type kind = napi_uint8_array;
    size_t length = 0;
    void *data = NULL;
    if (napi_is_typedarray(call->env, value, &typed) != napi_ok || !typed ||
        napi_get_typedarray_info(call->env, value, &kind, &length, &data, NULL, NULL) != napi_ok ||
        kind != napi_uint8_array || length > UINT32_MAX) {
        return tna_invalid(call, "a Uint8Array or a string");
    }
    uint8_t *copy = tna_call_alloc(call, length, 1);
    if (copy == NULL) {
        return false;
    }
    if (length != 0) {
        memcpy(copy, data, length);
    }
    *out = (ta_bytes){ copy, (uint32_t)length };
    return true;
}

napi_value tna_enc_ta_bytes(tna_call *call, const ta_bytes *in) {
    if (in->ptr == NULL) {
        return tna_undefined(call);
    }
    void *data = NULL;
    napi_value buffer = NULL;
    napi_value array = NULL;
    if (!tna_ok(call, napi_create_arraybuffer(call->env, in->len, &data, &buffer))) {
        return NULL;
    }
    if (in->len != 0) {
        memcpy(data, in->ptr, in->len);
    }
    return tna_ok(call, napi_create_typedarray(call->env, napi_uint8_array, in->len, buffer, 0, &array)) ? array : NULL;
}

/* ------------------------------------------------------------------------
 * Values (ADR 0011): undefined is absent; anything else becomes a value the
 * call holds until it ends. Core retains what it keeps.
 */

bool tna_dec_ta_value(tna_call *call, napi_value value, ta_value *out) {
    if (tna_absent(call, value)) {
        *out = (ta_value){ NULL, NULL };
        return true;
    }
    if (call->owner == NULL) {
        return tna_invalid(call, "a call that runs against a system");
    }
    if (!tna_value_make(&call->owner->values, value, out)) {
        tna_throw(call->env, "out-of-memory", "cannot keep a JavaScript value");
        return false;
    }
    return tna_call_keep_value(call, *out);
}

napi_value tna_enc_ta_value(tna_call *call, const ta_value *in) {
    napi_value value = NULL;
    if (!tna_value_get(call->env, in, &value)) {
        tna_throw(call->env, "unsupported", "core holds a value this binding did not make");
        return NULL;
    }
    return value;
}

/* ------------------------------------------------------------------------
 * Expressions (ADR 0011): source text is a string; a function, a literal()
 * object and a { get, set } location object are host expressions of the
 * JavaScript data model, held by the call until core retains them.
 */

/* An object whose `get` and `set` are functions. */
static bool tna_location_object(tna_call *call, napi_value value) {
    napi_value get = NULL;
    napi_value set = NULL;
    napi_valuetype type = napi_undefined;
    if (napi_get_named_property(call->env, value, "get", &get) != napi_ok ||
        napi_typeof(call->env, get, &type) != napi_ok || type != napi_function ||
        napi_get_named_property(call->env, value, "set", &set) != napi_ok ||
        napi_typeof(call->env, set, &type) != napi_ok) {
        return false;
    }
    return type == napi_function;
}

bool tna_dec_ta_expression(tna_call *call, napi_value value, ta_expression *out) {
    napi_valuetype type = napi_undefined;
    if (tna_absent(call, value)) {
        *out = (ta_expression){ .kind = TA_EXPRESSION_NONE };
        return true;
    }
    if (napi_typeof(call->env, value, &type) != napi_ok) {
        return tna_invalid(call, "an expression");
    }
    if (type == napi_string) {
        *out = (ta_expression){ .kind = TA_EXPRESSION_SOURCE };
        return tna_dec_ta_str(call, value, &out->as.source);
    }
    tna_expr_kind kind = TNA_EXPR_FUNCTION;
    if (type == napi_function) {
        kind = TNA_EXPR_FUNCTION;
    } else if (type == napi_object && tna_expression_is_literal(call->env, value)) {
        kind = TNA_EXPR_LITERAL;
    } else if (type == napi_object && tna_location_object(call, value)) {
        kind = TNA_EXPR_LOCATION;
    } else {
        return tna_invalid(call, "source text, a function, a literal() value or a { get, set } location");
    }
    if (call->owner == NULL) {
        /*
         * A call with no system (compile_error_format) only reads the spec;
         * a JavaScript expression stands there as text naming its kind.
         */
        static const char *const names[] = { "[JavaScript function]", "[literal]", "[location]" };
        *out = (ta_expression){ .kind = TA_EXPRESSION_SOURCE,
                                .as.source = { names[kind], (uint32_t)strlen(names[kind]) } };
        return true;
    }
    if (!tna_expression_make(&call->owner->dm, value, kind, out)) {
        tna_throw(call->env, "out-of-memory", "cannot keep a JavaScript expression");
        return false;
    }
    return tna_call_keep_expression(call, *out);
}

napi_value tna_enc_ta_expression(tna_call *call, const ta_expression *in) {
    switch (in->kind) {
    case TA_EXPRESSION_NONE:
        return tna_undefined(call);
    case TA_EXPRESSION_SOURCE:
        return tna_enc_ta_str(call, &in->as.source);
    default: {
        napi_value value = tna_expression_value(call->env, in);
        if (value == NULL) {
            tna_throw(call->env, "unsupported", "a host expression this binding did not make");
        }
        return value;
    }
    }
}

/* ------------------------------------------------------------------------
 * Actor IDs cross as (slot, generation) (ADR 0002).
 */

static bool tna_dec_named_u32(tna_call *call, napi_value object, const char *key, uint32_t *out) {
    if (!tna_member(call, object, key) || !tna_dec_uint32_t(call, tna_member_value(call), out)) {
        return false;
    }
    tna_pop(call);
    return true;
}

bool tna_dec_ta_actor_id(tna_call *call, napi_value value, ta_actor_id *out) {
    uint32_t slot = 0;
    uint32_t generation = 0;
    if (!tna_expect_object(call, value) || !tna_dec_named_u32(call, value, "slot", &slot) ||
        !tna_dec_named_u32(call, value, "generation", &generation)) {
        return false;
    }
    *out = ta_actor_id_make(slot, generation);
    return true;
}

bool tna_dec_actor_pair(tna_call *call, const napi_value *pair, ta_actor_id *out) {
    uint32_t slot = 0;
    uint32_t generation = 0;
    tna_push(call, "slot");
    if (!tna_dec_uint32_t(call, pair[0], &slot)) {
        return false;
    }
    tna_pop(call);
    tna_push(call, "generation");
    if (!tna_dec_uint32_t(call, pair[1], &generation)) {
        return false;
    }
    tna_pop(call);
    *out = ta_actor_id_make(slot, generation);
    return true;
}

napi_value tna_enc_ta_actor_id(tna_call *call, const ta_actor_id *in) {
    napi_value object = tna_object(call);
    napi_value slot = tna_number(call, (double)ta_actor_id_slot(*in));
    napi_value generation = tna_number(call, (double)ta_actor_id_generation(*in));
    if (object == NULL || slot == NULL || generation == NULL ||
        !tna_ok(call, napi_set_named_property(call->env, object, "slot", slot)) ||
        !tna_ok(call, napi_set_named_property(call->env, object, "generation", generation))) {
        return NULL;
    }
    return object;
}

/* ------------------------------------------------------------------------
 * Actor refs: {kind: "runtime", runtime: {slot, generation}} or
 * {kind: "named", named: {family: {name}, name}} (ADR 0006). A named ref is
 * interned for the call and released when it ends; JavaScript never holds
 * a ta_address.
 */

static bool tna_dec_named_str(tna_call *call, napi_value object, const char *key, ta_str *out) {
    if (!tna_member(call, object, key) || !tna_dec_ta_str(call, tna_member_value(call), out)) {
        return false;
    }
    tna_pop(call);
    return true;
}

static bool tna_dec_address(tna_call *call, napi_value value, ta_actor_address *out) {
    if (!tna_expect_object(call, value) || !tna_member(call, value, "family")) {
        return false;
    }
    napi_value family = tna_member_value(call);
    if (!tna_expect_object(call, family) || !tna_dec_named_str(call, family, "name", &out->family.name)) {
        return false;
    }
    tna_pop(call);
    return tna_dec_named_str(call, value, "name", &out->name);
}

bool tna_dec_ta_actor_ref(tna_call *call, napi_value value, ta_actor_ref *out) {
    tna_symbol kind;
    if (!tna_expect_object(call, value) || !tna_member(call, value, "kind") ||
        !tna_read_symbol(call, tna_member_value(call), &kind)) {
        return false;
    }
    tna_pop(call);
    if (strcmp(kind.text, "runtime") == 0) {
        *out = (ta_actor_ref){ .kind = TA_ACTOR_REF_RUNTIME };
        if (!tna_member(call, value, "runtime") || !tna_dec_ta_actor_id(call, tna_member_value(call), &out->as.runtime)) {
            return false;
        }
        tna_pop(call);
        return true;
    }
    if (strcmp(kind.text, "named") != 0) {
        tna_push(call, "kind");
        return tna_invalid(call, "\"runtime\" or \"named\"");
    }
    ta_actor_address address = { { { NULL, 0 } }, { NULL, 0 } };
    if (!tna_member(call, value, "named") || !tna_dec_address(call, tna_member_value(call), &address)) {
        return false;
    }
    if (call->core == NULL) {
        return tna_invalid(call, "a call that runs against a system");
    }
    ta_address *handle = NULL;
    ta_result result = ta_address_intern(call->core, &address, &handle);
    if (result != TA_OK) {
        tna_call_fail(call, result, NULL);
        return false;
    }
    if (!tna_call_keep_address(call, handle)) {
        return false;
    }
    tna_pop(call);
    *out = (ta_actor_ref){ .kind = TA_ACTOR_REF_NAMED, .as.named = handle };
    return true;
}

static napi_value tna_enc_address(tna_call *call, const ta_address *handle) {
    ta_actor_address address = ta_address_view(handle);
    napi_value object = tna_object(call);
    napi_value family = tna_object(call);
    napi_value family_name = tna_enc_ta_str(call, &address.family.name);
    napi_value name = tna_enc_ta_str(call, &address.name);
    if (object == NULL || family == NULL || family_name == NULL || name == NULL ||
        !tna_ok(call, napi_set_named_property(call->env, family, "name", family_name)) ||
        !tna_ok(call, napi_set_named_property(call->env, object, "family", family)) ||
        !tna_ok(call, napi_set_named_property(call->env, object, "name", name))) {
        return NULL;
    }
    return object;
}

napi_value tna_enc_ta_actor_ref(tna_call *call, const ta_actor_ref *in) {
    napi_value object = tna_object(call);
    bool named = in->kind == TA_ACTOR_REF_NAMED;
    napi_value kind = tna_string(call, named ? "named" : "runtime");
    napi_value member = NULL;
    if (named) {
        member = in->as.named == NULL ? tna_undefined(call) : tna_enc_address(call, in->as.named);
    } else {
        member = tna_enc_ta_actor_id(call, &in->as.runtime);
    }
    if (object == NULL || kind == NULL || member == NULL ||
        !tna_ok(call, napi_set_named_property(call->env, object, "kind", kind)) ||
        !tna_ok(call, napi_set_named_property(call->env, object, named ? "named" : "runtime", member))) {
        return NULL;
    }
    return object;
}

bool tna_dec_ta_origin(tna_call *call, napi_value value, ta_origin *out) {
    (void)value;
    *out = (ta_origin){ 0 };
    return tna_invalid(call, "no origin: origins are made by core and the plumbing (post with an origin option)");
}

/*
 * {kind, actor | invoke | scope, type, uri} (core ADR 0068). `type` and
 * `uri` are what the receiver's data model shows as _event.origintype and
 * _event.origin, rendered by core; `uri` is absent when the origin has none
 * (a closed scope), and both are absent for no origin.
 */
napi_value tna_enc_ta_origin(tna_call *call, const ta_origin *in) {
    static const char *const kinds[] = { "none", "actor", "io", "invoke" };
    napi_value object = tna_object(call);
    napi_value kind = tna_string(call, (uint32_t)in->kind < 4u ? kinds[in->kind] : "unknown");
    if (object == NULL || kind == NULL || !tna_ok(call, napi_set_named_property(call->env, object, "kind", kind))) {
        return NULL;
    }
    napi_value member = NULL;
    const char *name = NULL;
    if (in->kind == TA_ORIGIN_ACTOR) {
        name = "actor";
        member = tna_enc_ta_actor_ref(call, &in->as.actor);
    } else if (in->kind == TA_ORIGIN_INVOKE) {
        name = "invoke";
        member = tna_enc_uint64_t(call, &in->as.invoke.invoke);
    } else if (in->kind == TA_ORIGIN_IO && in->as.io.origin_class == TA_IO_ORIGIN_SCOPED) {
        name = "scope";
        member = tna_object(call);
        napi_value index = tna_enc_uint32_t(call, &in->as.io.as.scope.index);
        napi_value generation = tna_enc_uint32_t(call, &in->as.io.as.scope.generation);
        if (member == NULL || index == NULL || generation == NULL ||
            !tna_ok(call, napi_set_named_property(call->env, member, "index", index)) ||
            !tna_ok(call, napi_set_named_property(call->env, member, "generation", generation))) {
            return NULL;
        }
    }
    if (name != NULL && (member == NULL || !tna_ok(call, napi_set_named_property(call->env, object, name, member)))) {
        return NULL;
    }
    ta_arena *arena = call->core == NULL || in->kind == TA_ORIGIN_NONE ? NULL : tna_call_arena(call);
    if (arena == NULL) {
        return object;
    }
    ta_str type = { NULL, 0 };
    ta_str uri = { NULL, 0 };
    /* Core sets the type before it renders the URI, so a closed scope keeps its type. */
    ta_result result = ta_origin_text(call->core, &(ta_origin_text_params){ .origin = in,
                                                                             .arena = ta_arena_allocator(arena),
                                                                             .type = &type,
                                                                             .uri = &uri });
    if (type.len != 0) {
        napi_value text = tna_enc_ta_str(call, &type);
        if (text == NULL || !tna_ok(call, napi_set_named_property(call->env, object, "type", text))) {
            return NULL;
        }
    }
    if (result == TA_OK) {
        napi_value text = tna_enc_ta_str(call, &uri);
        if (text == NULL || !tna_ok(call, napi_set_named_property(call->env, object, "uri", text))) {
            return NULL;
        }
    }
    return object;
}

/* ------------------------------------------------------------------------
 * Adapters the plumbing supplies (INJECT_TYPES).
 */

bool tna_inject_ta_allocator(tna_call *call, ta_allocator *out) {
    tna_system *system = tna_call_system(call);
    if (system == NULL) {
        return tna_invalid(call, "a call that runs against a system");
    }
    *out = tna_allocator_for(&system->allocator, TNA_MEMORY_CORE);
    return true;
}

/*
 * Core's null data model, or the JavaScript data model (ADR 0011) when
 * System.define() selected it for this compile (selectDatamodel).
 */
bool tna_inject_ta_datamodel(tna_call *call, ta_datamodel *out) {
    if (call->owner == NULL) {
        return tna_invalid(call, "a call that runs against a system");
    }
    tna_js_datamodel *dm = &call->owner->dm;
    *out = dm->select_javascript ? tna_js_datamodel_adapter(dm) : ta_null_datamodel();
    dm->select_javascript = false;
    return true;
}

napi_value tna_enc_ta_datamodel(tna_call *call, const ta_datamodel *in) {
    if (in->v == NULL) {
        return tna_undefined(call);
    }
    return tna_enc_ta_str(call, &in->v->name);
}
