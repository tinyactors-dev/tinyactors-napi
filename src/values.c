/* The value table (docs/values.md; tinyactors-core/docs/protocol.md,
 * "Values"): JavaScript values to CBOR and back, streaming with core's
 * ta_cbor_writer and ta_cbor_reader. The one conversion the API uses:
 * encode and decode here, and later the config, typed methods' params and
 * replies, and payloads for quickjs.
 *
 * Core owns CBOR's syntax and checks (UTF-8, widths, nesting); this file
 * owns the JavaScript mapping:
 *
 *   undefined, null, true, false  simple values 23, 22, 21, 20
 *   a number                      an integer when Number.isSafeInteger holds
 *                                 and it is not -0, else a float
 *   a bigint                      an integer, -2^64 to 2^64-1
 *   a string                      text, valid UTF-8: a lone surrogate refused
 *   a Uint8Array (a Buffer too)   bytes
 *   an array                      an array, holes as undefined
 *   a plain object                a map of its own enumerable string keys,
 *                                 in Object.keys order
 *
 * A plain object may be of another realm: its prototype is null, this
 * realm's Object.prototype, or that of a context the native datamodel made
 * (the instance's `realms`), so a payload of the datamodel's context is a
 * value too.
 *
 * The native datamodel's to_wire writes in a second mode, `wire`
 * (tinyactors-test/suites/protocol/values.txt, the encode cases): what
 * JSON.stringify leaves out (undefined, a function, a symbol) is null at
 * the top and in an array and drops its key in an object; toJSON is
 * applied (a Date is its JSON text); an ArrayBuffer, a typed array and a
 * DataView are their bytes; any other object is the map of its own
 * enumerable string keys. Its refusals are TA_ERROR_INVALID.
 *
 * and back: integers within +-(2^53-1) numbers, others bigints; bytes a
 * Uint8Array; tag 32 on text (an actor reference) its address string, never
 * written. Anything else is refused: TinyactorsError with TA_ERROR_UNSUPPORTED
 * for a value outside the table (a function, a symbol, a Date, a class's
 * instance), TA_ERROR_INVALID for one the table cannot hold (a bigint past
 * 64 bits, a lone surrogate, nesting deeper than 64, which a cycle reaches). */
#include "addon.h"

#include <string.h>

/* 2^53 - 1, Number.MAX_SAFE_INTEGER. */
#define TA_NAPI_SAFE_INTEGER 9007199254740991.0

/* One encode: the environment's instance, the arena of the call's text,
 * the writer, and the first refusal. `thrown` when a JavaScript exception is pending instead (a
 * getter threw, or Node-API failed and set one). */
typedef struct ta_napi_encoder {
    napi_env env;
    ta_napi_instance *instance;
    ta_growable_arena *arena;
    ta_cbor_writer *writer;
    ta_napi_refusal refusal;
    bool thrown;
    bool wire;
    bool addresses;
} ta_napi_encoder;

static bool ta_napi_refuse(ta_napi_encoder *encoder, ta_status status, const char *message) {
    encoder->refusal = (ta_napi_refusal){status, message};
    return false;
}

/* A Node-API call failed: its exception, or one saying so. */
static bool ta_napi_failed(ta_napi_encoder *encoder) {
    bool pending = false;
    napi_is_exception_pending(encoder->env, &pending);
    if (pending) {
        encoder->thrown = true;
        return false;
    }
    return ta_napi_refuse(encoder, TA_ERROR_FATAL, "a Node-API call failed while encoding a value");
}

#define TA_NAPI_CHECK(encoder, call) \
    do { if ((call) != napi_ok) return ta_napi_failed(encoder); } while (0)

/* Whether the UTF-16 code units `utf16` hold a surrogate that is not half
 * of a pair. */
static bool ta_napi_lone_surrogate(ta_bytes utf16) {
    const char16_t *text = (const char16_t *)utf16.pointer;
    size_t length = utf16.length / sizeof *text;
    for (size_t i = 0; i < length; i++) {
        char16_t unit = text[i];
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (i + 1 < length && text[i + 1] >= 0xDC00 && text[i + 1] <= 0xDFFF) i++;
            else return true;
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) return true;
    }
    return false;
}

/* The string `value` as UTF-8 in the call's arena (the copy Node-API
 * forces), into *out. Node-API writes a lone surrogate as U+FFFD (EF BF
 * BD), so when those bytes appear the string is read again as UTF-16 and
 * checked: a lone surrogate is refused, never replaced. */
static bool ta_napi_utf8(ta_napi_encoder *encoder, napi_value value, ta_string_view *out) {
    napi_env env = encoder->env;
    size_t length = 0;
    TA_NAPI_CHECK(encoder, napi_get_value_string_utf8(env, value, NULL, 0, &length));
    if (length > UINT32_MAX) return ta_napi_refuse(encoder, TA_ERROR_INVALID, "a string longer than 2^32-1 bytes");
    char *text = (char *)ta_growable_arena_alloc(encoder->arena, length + 1, 1);
    if (text == NULL) return ta_napi_refuse(encoder, TA_ERROR_NO_MEMORY, "no memory for a string");
    size_t written = 0;
    TA_NAPI_CHECK(encoder, napi_get_value_string_utf8(env, value, text, length + 1, &written));
    for (const char *at = text; (at = (const char *)memchr(at, 0xEF, (size_t)(text + written - at))) != NULL; at++) {
        if (text + written - at < 3 || (unsigned char)at[1] != 0xBF || (unsigned char)at[2] != 0xBD) continue;
        size_t units = 0;
        TA_NAPI_CHECK(encoder, napi_get_value_string_utf16(env, value, NULL, 0, &units));
        char16_t *wide = (char16_t *)ta_growable_arena_alloc(encoder->arena, (units + 1) * sizeof *wide, 2);
        if (wide == NULL) return ta_napi_refuse(encoder, TA_ERROR_NO_MEMORY, "no memory for a string");
        size_t read = 0;
        TA_NAPI_CHECK(encoder, napi_get_value_string_utf16(env, value, wide, units + 1, &read));
        if (ta_napi_lone_surrogate((ta_bytes){wide, read * sizeof *wide}))
            return ta_napi_refuse(encoder, TA_ERROR_INVALID, "a string with a lone surrogate is not text");
        break;
    }
    *out = (ta_string_view){text, (uint32_t)written};
    return true;
}

bool ta_napi_text_of(napi_env env, napi_value value, ta_napi_text *text) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) != napi_ok) return false;
    if (type != napi_string) {
        napi_throw_type_error(env, NULL, text->what);
        return false;
    }
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return false;
    ta_napi_encoder encoder = {env, instance, text->arena, NULL, {TA_OK, NULL}, false, false, false};
    if (ta_napi_utf8(&encoder, value, &text->view)) return true;
    if (!encoder.thrown) ta_napi_throw(env, &encoder.refusal);
    return false;
}

/* A number: an integer when Number.isSafeInteger(value) and not -0, else a
 * float (NaN, the infinities, -0, fractions, and integers past 2^53). */
static bool ta_napi_write_number(ta_napi_encoder *encoder, napi_value value) {
    double number;
    TA_NAPI_CHECK(encoder, napi_get_value_double(encoder->env, value, &number));
    bool safe = number >= -TA_NAPI_SAFE_INTEGER && number <= TA_NAPI_SAFE_INTEGER &&
                (double)(int64_t)number == number && !(number == 0 && 1 / number < 0);
    if (safe) ta_cbor_write_int(encoder->writer, (int64_t)number);
    else ta_cbor_write_float(encoder->writer, number);
    return true;
}

/* A bigint: an integer from -2^64 to 2^64-1, else TA_ERROR_INVALID. */
static bool ta_napi_write_bigint(ta_napi_encoder *encoder, napi_value value) {
    size_t count = 0;
    TA_NAPI_CHECK(encoder, napi_get_value_bigint_words(encoder->env, value, NULL, &count, NULL));
    if (count > 2) return ta_napi_refuse(encoder, TA_ERROR_INVALID, "a bigint past 64 bits");
    int sign = 0;
    uint64_t words[2] = {0, 0};
    TA_NAPI_CHECK(encoder, napi_get_value_bigint_words(encoder->env, value, &sign, &count, words));
    if (!sign) {
        if (count == 2 && words[1] != 0) return ta_napi_refuse(encoder, TA_ERROR_INVALID, "a bigint past 64 bits");
        ta_cbor_write_uint(encoder->writer, words[0]);
    } else if (count == 2 && words[1] != 0) {
        if (words[1] != 1 || words[0] != 0) return ta_napi_refuse(encoder, TA_ERROR_INVALID, "a bigint past 64 bits");
        ta_cbor_write_negative(encoder->writer, UINT64_MAX); /* -2^64 */
    } else if (words[0] == 0) ta_cbor_write_uint(encoder->writer, 0); /* -0n is 0n */
    else ta_cbor_write_negative(encoder->writer, words[0] - 1);
    return true;
}

static bool ta_napi_write(ta_napi_encoder *encoder, napi_value value, uint32_t depth);

/* Whether `prototype` is the Object.prototype of a context the native
 * datamodel made (the instance's WeakSet `realms`, when there is one). */
static bool ta_napi_realm_prototype(ta_napi_encoder *encoder, napi_value prototype, bool *found) {
    napi_env env = encoder->env;
    napi_value realms, has, result;
    *found = false;
    if (encoder->instance->realms == NULL) return true;
    TA_NAPI_CHECK(encoder, napi_get_reference_value(env, encoder->instance->realms, &realms));
    TA_NAPI_CHECK(encoder, napi_get_named_property(env, realms, "has", &has));
    TA_NAPI_CHECK(encoder, napi_call_function(env, realms, has, 1, &prototype, &result));
    TA_NAPI_CHECK(encoder, napi_get_value_bool(env, result, found));
    return true;
}

/* The wire mode's toJSON, as JSON.stringify applies it: again on what it
 * returns, each call a level of nesting. */
static bool ta_napi_wire_resolve(ta_napi_encoder *encoder, napi_value *value, uint32_t *depth) {
    napi_env env = encoder->env;
    for (;;) {
        napi_valuetype kind;
        bool is = false;
        if (*depth > TA_CBOR_DEPTH_MAX)
            return ta_napi_refuse(encoder, TA_ERROR_INVALID, "a value nested deeper than 64 (or a cycle)");
        TA_NAPI_CHECK(encoder, napi_typeof(env, *value, &kind));
        if (kind != napi_object) return true;
        TA_NAPI_CHECK(encoder, napi_is_arraybuffer(env, *value, &is));
        if (!is) TA_NAPI_CHECK(encoder, napi_is_typedarray(env, *value, &is));
        if (!is) TA_NAPI_CHECK(encoder, napi_is_dataview(env, *value, &is));
        if (is) return true;
        napi_value to_json, key;
        TA_NAPI_CHECK(encoder, napi_get_named_property(env, *value, "toJSON", &to_json));
        TA_NAPI_CHECK(encoder, napi_typeof(env, to_json, &kind));
        if (kind != napi_function) return true;
        TA_NAPI_CHECK(encoder, napi_create_string_utf8(env, "", 0, &key));
        TA_NAPI_CHECK(encoder, napi_call_function(env, *value, to_json, 1, &key, value));
        (*depth)++;
    }
}

/* What JSON.stringify leaves out: undefined, a function, a symbol. */
static bool ta_napi_wire_dropped(ta_napi_encoder *encoder, napi_value value) {
    napi_valuetype kind = napi_undefined;
    napi_typeof(encoder->env, value, &kind);
    return kind == napi_undefined || kind == napi_function || kind == napi_symbol;
}

/* One member of an array or a map in the wire mode: toJSON applied, then
 * written; `*dropped` when it is left out (the caller writes null in an
 * array, drops the key in a map). */
typedef struct ta_napi_member {
    napi_value value;
    uint32_t depth;
    bool dropped; /* out */
} ta_napi_member;

static bool ta_napi_wire_member(ta_napi_encoder *encoder, ta_napi_member *member) {
    if (!ta_napi_wire_resolve(encoder, &member->value, &member->depth)) return false;
    member->dropped = ta_napi_wire_dropped(encoder, member->value);
    return true;
}

/* The bytes of an ArrayBuffer, a typed array or a DataView (wire mode):
 * `*written` when it was one. */
static bool ta_napi_wire_bytes(ta_napi_encoder *encoder, napi_value value, bool *written) {
    napi_env env = encoder->env;
    bool is = false;
    void *data = NULL;
    size_t length = 0;
    *written = false;
    TA_NAPI_CHECK(encoder, napi_is_arraybuffer(env, value, &is));
    if (is) TA_NAPI_CHECK(encoder, napi_get_arraybuffer_info(env, value, &data, &length));
    if (!is) {
        TA_NAPI_CHECK(encoder, napi_is_typedarray(env, value, &is));
        if (is) {
            napi_typedarray_type type;
            size_t count = 0;
            TA_NAPI_CHECK(encoder, napi_get_typedarray_info(env, value, &type, &count, &data, NULL, NULL));
            static const uint8_t sizes[] = {1, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8};
            length = count * ((size_t)type < sizeof sizes ? sizes[type] : 1);
        }
    }
    if (!is) {
        TA_NAPI_CHECK(encoder, napi_is_dataview(env, value, &is));
        if (is) TA_NAPI_CHECK(encoder, napi_get_dataview_info(env, value, &length, &data, NULL, NULL));
    }
    if (!is) return true;
    ta_cbor_write_bytes(encoder->writer, (ta_bytes){data, length});
    *written = true;
    return true;
}

static bool ta_napi_write_array(ta_napi_encoder *encoder, napi_value array, uint32_t depth) {
    napi_env env = encoder->env;
    uint32_t length = 0;
    TA_NAPI_CHECK(encoder, napi_get_array_length(env, array, &length));
    ta_cbor_write_array(encoder->writer, TA_CBOR_COUNT_LATER);
    for (uint32_t i = 0; i < length; i++) {
        napi_value item;
        TA_NAPI_CHECK(encoder, napi_get_element(env, array, i, &item));
        if (encoder->wire) {
            ta_napi_member member = {item, depth + 1, false};
            if (!ta_napi_wire_member(encoder, &member)) return false;
            if (member.dropped) ta_cbor_write_simple(encoder->writer, TA_CBOR_NULL); /* null in an array */
            else if (!ta_napi_write(encoder, member.value, member.depth)) return false;
            continue;
        }
        if (!ta_napi_write(encoder, item, depth + 1)) return false;
    }
    ta_cbor_write_end(encoder->writer);
    return true;
}

/* A plain object (its prototype Object.prototype or null): its own
 * enumerable string keys in Object.keys order, each with its value. */
static bool ta_napi_write_object(ta_napi_encoder *encoder, napi_value object, uint32_t depth) {
    napi_env env = encoder->env;
    napi_value prototype, plain, keys;
    napi_valuetype kind;
    bool same = false;
    TA_NAPI_CHECK(encoder, napi_get_prototype(env, object, &prototype));
    TA_NAPI_CHECK(encoder, napi_typeof(env, prototype, &kind));
    if (kind != napi_null && !encoder->wire) {
        TA_NAPI_CHECK(encoder, napi_get_reference_value(env, encoder->instance->object, &plain));
        TA_NAPI_CHECK(encoder, napi_strict_equals(env, prototype, plain, &same));
        if (!same && !ta_napi_realm_prototype(encoder, prototype, &same)) return false;
        if (!same)
            return ta_napi_refuse(encoder, TA_ERROR_UNSUPPORTED,
                                  "only plain objects, arrays and Uint8Arrays are values (docs/values.md)");
    }
    TA_NAPI_CHECK(encoder, napi_get_all_property_names(env, object, napi_key_own_only,
                                                       napi_key_enumerable | napi_key_skip_symbols,
                                                       napi_key_numbers_to_strings, &keys));
    uint32_t count = 0;
    TA_NAPI_CHECK(encoder, napi_get_array_length(env, keys, &count));
    ta_cbor_write_map(encoder->writer, TA_CBOR_COUNT_LATER);
    for (uint32_t i = 0; i < count; i++) {
        napi_value key, item;
        ta_string_view text;
        TA_NAPI_CHECK(encoder, napi_get_element(env, keys, i, &key));
        TA_NAPI_CHECK(encoder, napi_get_property(env, object, key, &item));
        ta_napi_member member = {item, depth + 1, false};
        if (encoder->wire && !ta_napi_wire_member(encoder, &member)) return false;
        if (member.dropped) continue; /* wire mode: its key goes too */
        if (!ta_napi_utf8(encoder, key, &text)) return false;
        ta_cbor_write_text(encoder->writer, text);
        if (!ta_napi_write(encoder, member.value, member.depth)) return false;
    }
    ta_cbor_write_end(encoder->writer);
    return true;
}

/* One value at `depth` (0 for the whole value), appended to the writer.
 * False on a refusal or a pending exception; the writer is then partial. */
static bool ta_napi_write(ta_napi_encoder *encoder, napi_value value, uint32_t depth) {
    napi_env env = encoder->env;
    ta_cbor_writer *writer = encoder->writer;
    if (depth > TA_CBOR_DEPTH_MAX)
        return ta_napi_refuse(encoder, TA_ERROR_INVALID, "a value nested deeper than 64 (or a cycle)");
    napi_valuetype kind;
    TA_NAPI_CHECK(encoder, napi_typeof(env, value, &kind));
    switch (kind) {
    case napi_undefined: ta_cbor_write_simple(writer, TA_CBOR_UNDEFINED); break;
    case napi_null: ta_cbor_write_simple(writer, TA_CBOR_NULL); break;
    case napi_boolean: {
        bool truth;
        TA_NAPI_CHECK(encoder, napi_get_value_bool(env, value, &truth));
        ta_cbor_write_simple(writer, truth ? TA_CBOR_TRUE : TA_CBOR_FALSE);
        break;
    }
    case napi_number:
        if (!ta_napi_write_number(encoder, value)) return false;
        break;
    case napi_bigint:
        if (!ta_napi_write_bigint(encoder, value)) return false;
        break;
    case napi_string: {
        ta_string_view text;
        if (!ta_napi_utf8(encoder, value, &text)) return false;
        ta_cbor_write_text(writer, text);
        break;
    }
    case napi_object: {
        bool is = false;
        if (encoder->addresses && ta_napi_is_address(env, value)) { /* encode's: an actor reference, tag 32 */
            ta_string_view text;
            if (!ta_napi_utf8(encoder, ta_napi_address_text(env, value), &text)) return false;
            ta_cbor_write_tag(writer, TA_CBOR_TAG_URI);
            ta_cbor_write_text(writer, text);
            break;
        }
        TA_NAPI_CHECK(encoder, napi_is_array(env, value, &is));
        if (is) {
            if (!ta_napi_write_array(encoder, value, depth)) return false;
            break;
        }
        if (encoder->wire) {
            if (!ta_napi_wire_bytes(encoder, value, &is)) return false;
            if (!is && !ta_napi_write_object(encoder, value, depth)) return false;
            break;
        }
        if (encoder->wire) {
            if (!ta_napi_wire_bytes(encoder, value, &is)) return false;
            if (!is && !ta_napi_write_object(encoder, value, depth)) return false;
            break;
        }
        TA_NAPI_CHECK(encoder, napi_is_typedarray(env, value, &is));
        if (is) {
            napi_typedarray_type type;
            size_t length;
            void *data;
            TA_NAPI_CHECK(encoder, napi_get_typedarray_info(env, value, &type, &length, &data, NULL, NULL));
            if (type != napi_uint8_array)
                return ta_napi_refuse(encoder, TA_ERROR_UNSUPPORTED, "bytes are a Uint8Array, not another typed array");
            ta_cbor_write_bytes(writer, (ta_bytes){data, length});
            break;
        }
        if (!ta_napi_write_object(encoder, value, depth)) return false;
        break;
    }
    case napi_symbol:
    case napi_function:
    case napi_external:
    default:
        return ta_napi_refuse(encoder, TA_ERROR_UNSUPPORTED,
                              "a function, a symbol or an external is not a value (docs/values.md)");
    }
    if (writer->status != TA_OK)
        return ta_napi_refuse(encoder, writer->status,
                              writer->status == TA_ERROR_NO_MEMORY ? "no memory for the encoded value"
                                                                   : "the CBOR writer refused the value");
    return true;
}

bool ta_napi_value_write(napi_env env, napi_value value, const ta_napi_writing *writing) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return false;
    ta_napi_encoder encoder = {env, instance, writing->arena, writing->writer, {TA_OK, NULL}, false, writing->wire, writing->addresses};
    bool written;
    if (writing->wire) { /* the top: what JSON leaves out is null */
        ta_napi_member member = {value, 0, false};
        written = ta_napi_wire_member(&encoder, &member);
        if (written && member.dropped) ta_cbor_write_simple(encoder.writer, TA_CBOR_NULL);
        else if (written) written = ta_napi_write(&encoder, member.value, member.depth);
        if (!written && !encoder.thrown && encoder.refusal.status != TA_ERROR_NO_MEMORY)
            encoder.refusal.status = TA_ERROR_INVALID;
    } else written = ta_napi_write(&encoder, value, 0);
    if (writing->refused != NULL) *writing->refused = written ? TA_OK : encoder.thrown ? TA_ERROR_EXECUTION : encoder.refusal.status;
    if (written) return true;
    if (!encoder.thrown) ta_napi_throw(env, &encoder.refusal);
    return false;
}

bool ta_napi_text_kept(napi_env env, napi_value value, ta_napi_room *room) {
    size_t length = 0, written = 0, units = 0, read = 0;
    room->view = (ta_string_view){NULL, 0};
    if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return false;
    if (length > UINT32_MAX) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, "a string longer than 2^32-1 bytes"});
        return false;
    }
    if (!ta_napi_room_grow(room, length + 1)) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for a string"});
        return false;
    }
    char *text = (char *)room->buffer->pointer;
    if (napi_get_value_string_utf8(env, value, text, length + 1, &written) != napi_ok) return false;
    /* Node-API writes a lone surrogate as U+FFFD: read as UTF-16 then, past the UTF-8 */
    for (size_t at = 0; at + 3 <= written; at++) {
        if ((unsigned char)text[at] != 0xEF || (unsigned char)text[at + 1] != 0xBF || (unsigned char)text[at + 2] != 0xBD)
            continue;
        if (napi_get_value_string_utf16(env, value, NULL, 0, &units) != napi_ok) return false;
        size_t offset = (written + 2) & ~(size_t)1;
        if (!ta_napi_room_grow(room, offset + (units + 1) * sizeof(char16_t))) {
            ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for a string"});
            return false;
        }
        text = (char *)room->buffer->pointer;
        char16_t *wide = (char16_t *)(text + offset);
        if (napi_get_value_string_utf16(env, value, wide, units + 1, &read) != napi_ok) return false;
        if (ta_napi_lone_surrogate((ta_bytes){wide, read * sizeof *wide})) {
            ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, "a string with a lone surrogate is not text"});
            return false;
        }
        break;
    }
    room->view = (ta_string_view){text, (uint32_t)written};
    return true;
}

bool ta_napi_room_grow(ta_napi_room *room, size_t capacity) {
    ta_buffer *buffer = room->buffer;
    if (buffer->capacity >= capacity) return true;
    size_t grown = buffer->capacity ? buffer->capacity : 256;
    while (grown < capacity) grown *= 2;
    void *block = room->allocator->alloc(room->allocator->context, grown, 8);
    if (block == NULL) return false;
    if (buffer->pointer != NULL) room->allocator->free(room->allocator->context, buffer->pointer, buffer->capacity);
    buffer->pointer = block;
    buffer->capacity = grown;
    buffer->length = 0;
    return true;
}

/* encode(value) -> Uint8Array: the value's CBOR, copied once out of the
 * call's arena. */
napi_value ta_napi_encode(napi_env env, napi_callback_info info) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return NULL;
    size_t argc = 1;
    napi_value argument = NULL, result = NULL;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok) return NULL;
    if (argc < 1 && napi_get_undefined(env, &argument) != napi_ok) return NULL;
    ta_growable_arena_mark mark = ta_growable_arena_position(&instance->arena);
    ta_allocator scratch = ta_growable_arena_allocator(&instance->arena);
    ta_cbor_writer writer;
    ta_cbor_writer_init(&writer, (ta_buffer){NULL, 0, 0}, &scratch);
    if (ta_napi_value_write(env, argument, &(ta_napi_writing){&writer, &instance->arena, false, NULL, true})) {
        ta_bytes bytes;
        ta_status status = ta_cbor_writer_bytes(&writer, &bytes);
        void *data = NULL;
        napi_value buffer;
        if (status != TA_OK) ta_napi_throw(env, &(ta_napi_refusal){status, "the CBOR writer refused the value"});
        else if (napi_create_arraybuffer(env, bytes.length, &data, &buffer) == napi_ok) {
            if (bytes.length > 0) memcpy(data, bytes.pointer, bytes.length);
            if (napi_create_typedarray(env, napi_uint8_array, bytes.length, buffer, 0, &result) != napi_ok)
                result = NULL;
        }
    }
    ta_cbor_writer_free(&writer);
    ta_napi_arena_release(&instance->arena, mark, TA_NAPI_INSTANCE_ARENA_CAP);
    return result;
}

/* ---- reading -------------------------------------------------------------- */

/* One decode (ta_napi_decoder, addon.h): the reader over borrowed bytes.
 * No JavaScript runs while it reads, so the bytes cannot change under it. */

static napi_value ta_napi_reject(ta_napi_decoder *decoder, ta_status status, const char *message) {
    decoder->refusal = (ta_napi_refusal){status, message};
    return NULL;
}

static napi_value ta_napi_broke(ta_napi_decoder *decoder) {
    bool pending = false;
    napi_is_exception_pending(decoder->env, &pending);
    if (pending) decoder->thrown = true;
    else ta_napi_reject(decoder, TA_ERROR_FATAL, "a Node-API call failed while decoding a value");
    return NULL;
}

#define TA_NAPI_MAKE(decoder, call) \
    do { if ((call) != napi_ok) return ta_napi_broke(decoder); } while (0)

static napi_value ta_napi_read(ta_napi_decoder *decoder);

/* -1 - n: a number within -(2^53-1), else a bigint (down to -2^64). */
static napi_value ta_napi_read_negative(ta_napi_decoder *decoder, uint64_t n) {
    napi_value out;
    if (n < (uint64_t)TA_NAPI_SAFE_INTEGER) TA_NAPI_MAKE(decoder, napi_create_double(decoder->env, -1.0 - (double)n, &out));
    else if (n < UINT64_MAX) TA_NAPI_MAKE(decoder, napi_create_bigint_words(decoder->env, 1, 1, (uint64_t[]){n + 1}, &out));
    else TA_NAPI_MAKE(decoder, napi_create_bigint_words(decoder->env, 1, 2, (uint64_t[]){0, 1}, &out));
    return out;
}

static napi_value ta_napi_read_array(ta_napi_decoder *decoder, uint32_t count) {
    napi_value array;
    TA_NAPI_MAKE(decoder, napi_create_array_with_length(decoder->env, count, &array));
    for (uint32_t i = 0; i < count; i++) {
        napi_value item = ta_napi_read(decoder);
        if (item == NULL) return NULL;
        TA_NAPI_MAKE(decoder, napi_set_element(decoder->env, array, i, item));
    }
    return array;
}

/* A map: a plain object whose keys are defined, not set, so "__proto__"
 * is an own key and no setter runs; a key given twice keeps its last value. */
static napi_value ta_napi_read_map(ta_napi_decoder *decoder, uint32_t count) {
    napi_env env = decoder->env;
    napi_value object;
    TA_NAPI_MAKE(decoder, napi_create_object(env, &object));
    for (uint32_t i = 0; i < count; i++) {
        ta_cbor_item key;
        int32_t read = ta_cbor_read(&decoder->reader, &key);
        if (read != 1) return ta_napi_reject(decoder, read < 0 ? read : TA_ERROR_INVALID, "malformed or truncated CBOR");
        if (key.kind != TA_CBOR_TEXT) return ta_napi_reject(decoder, TA_ERROR_INVALID, "a map key that is not text");
        napi_property_descriptor property = {NULL, NULL, NULL, NULL, NULL, NULL,
                                             napi_writable | napi_enumerable | napi_configurable, NULL};
        TA_NAPI_MAKE(decoder, napi_create_string_utf8(env, (const char *)key.bytes.pointer, key.bytes.length, &property.name));
        property.value = ta_napi_read(decoder);
        if (property.value == NULL) return NULL;
        TA_NAPI_MAKE(decoder, napi_define_properties(env, object, 1, &property));
    }
    return object;
}

/* The next item and its children, as a JavaScript value; NULL with the
 * refusal or a pending exception. */
static napi_value ta_napi_read(ta_napi_decoder *decoder) {
    napi_env env = decoder->env;
    ta_cbor_item item;
    int32_t read = ta_cbor_read(&decoder->reader, &item);
    if (read != 1) return ta_napi_reject(decoder, read < 0 ? read : TA_ERROR_INVALID, "malformed or truncated CBOR");
    napi_value out;
    switch (item.kind) {
    case TA_CBOR_UINT:
        if (item.value <= (uint64_t)TA_NAPI_SAFE_INTEGER) TA_NAPI_MAKE(decoder, napi_create_double(env, (double)item.value, &out));
        else TA_NAPI_MAKE(decoder, napi_create_bigint_uint64(env, item.value, &out));
        return out;
    case TA_CBOR_NEGINT: return ta_napi_read_negative(decoder, item.value);
    case TA_CBOR_FLOAT: {
        double number;
        memcpy(&number, &item.value, sizeof number);
        TA_NAPI_MAKE(decoder, napi_create_double(env, number, &out));
        return out;
    }
    case TA_CBOR_BYTES: {
        void *data = NULL;
        napi_value buffer;
        TA_NAPI_MAKE(decoder, napi_create_arraybuffer(env, item.bytes.length, &data, &buffer));
        if (item.bytes.length > 0) memcpy(data, item.bytes.pointer, item.bytes.length);
        TA_NAPI_MAKE(decoder, napi_create_typedarray(env, napi_uint8_array, item.bytes.length, buffer, 0, &out));
        return out;
    }
    case TA_CBOR_TEXT:
        TA_NAPI_MAKE(decoder, napi_create_string_utf8(env, (const char *)item.bytes.pointer, item.bytes.length, &out));
        return out;
    case TA_CBOR_TAG: {
        /* An actor reference: tag 32 on text, read as its address string. */
        ta_cbor_item child;
        if (item.value != TA_CBOR_TAG_URI) return ta_napi_reject(decoder, TA_ERROR_INVALID, "a tag other than 32");
        read = ta_cbor_read(&decoder->reader, &child);
        if (read != 1) return ta_napi_reject(decoder, read < 0 ? read : TA_ERROR_INVALID, "malformed or truncated CBOR");
        if (child.kind != TA_CBOR_TEXT) return ta_napi_reject(decoder, TA_ERROR_INVALID, "tag 32 on something but text");
        if (decoder->addresses) { /* decode's: an Address */
            out = ta_napi_address_new(env, (ta_string_view){(const char *)child.bytes.pointer, child.bytes.length});
            if (out == NULL) return ta_napi_broke(decoder);
            return out;
        }
        TA_NAPI_MAKE(decoder, napi_create_string_utf8(env, (const char *)child.bytes.pointer, child.bytes.length, &out));
        return out;
    }
    case TA_CBOR_SIMPLE:
        switch (item.value) {
        case TA_CBOR_UNDEFINED: TA_NAPI_MAKE(decoder, napi_get_undefined(env, &out)); return out;
        case TA_CBOR_NULL: TA_NAPI_MAKE(decoder, napi_get_null(env, &out)); return out;
        case TA_CBOR_TRUE:
        case TA_CBOR_FALSE: TA_NAPI_MAKE(decoder, napi_get_boolean(env, item.value == TA_CBOR_TRUE, &out)); return out;
        default: return ta_napi_reject(decoder, TA_ERROR_INVALID, "a simple value other than false, true, null, undefined");
        }
    case TA_CBOR_ARRAY: return ta_napi_read_array(decoder, item.count);
    case TA_CBOR_MAP: return ta_napi_read_map(decoder, item.count);
    default: return ta_napi_reject(decoder, TA_ERROR_INVALID, "an item the value table has no row for");
    }
}

void ta_napi_decoder_init(ta_napi_decoder *decoder, napi_env env, ta_bytes cbor) {
    *decoder = (ta_napi_decoder){.env = env};
    ta_cbor_reader_init(&decoder->reader, cbor);
}

napi_value ta_napi_decoder_next(ta_napi_decoder *decoder) {
    napi_value value = ta_napi_read(decoder);
    if (value == NULL && !decoder->thrown) {
        ta_napi_throw(decoder->env, &decoder->refusal);
        decoder->thrown = true;
    }
    return value;
}

napi_value ta_napi_value_read(napi_env env, ta_bytes cbor) {
    ta_napi_decoder decoder;
    ta_napi_decoder_init(&decoder, env, cbor);
    napi_value value = ta_napi_read(&decoder);
    if (value != NULL) {
        ta_cbor_item extra;
        int32_t read = ta_cbor_read(&decoder.reader, &extra);
        if (read != 0) value = ta_napi_reject(&decoder, read < 0 ? read : TA_ERROR_INVALID, "bytes after the item");
    }
    if (value == NULL && !decoder.thrown) ta_napi_throw(env, &decoder.refusal);
    return value;
}

/* decode(bytes) -> value: bytes a Uint8Array (a Buffer too) or an
 * ArrayBuffer, read during the call. */
napi_value ta_napi_decode(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argument = NULL;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok) return NULL;
    ta_napi_bytes bytes = {"decode takes a Uint8Array or an ArrayBuffer", {NULL, 0}};
    if (!ta_napi_bytes_of(env, argc < 1 ? NULL : argument, &bytes)) return NULL;
    ta_napi_decoder decoder;
    ta_napi_decoder_init(&decoder, env, bytes.view);
    decoder.addresses = true;
    napi_value value = ta_napi_read(&decoder);
    if (value != NULL) {
        ta_cbor_item extra;
        int32_t read = ta_cbor_read(&decoder.reader, &extra);
        if (read != 0) value = ta_napi_reject(&decoder, read < 0 ? read : TA_ERROR_INVALID, "bytes after the item");
    }
    if (value == NULL && !decoder.thrown) ta_napi_throw(env, &decoder.refusal);
    return value;
}

bool ta_napi_bytes_of(napi_env env, napi_value value, ta_napi_bytes *bytes) {
    bool is = false;
    void *data = NULL;
    size_t length = 0;
    if (value != NULL && napi_is_typedarray(env, value, &is) == napi_ok && is) {
        napi_typedarray_type type;
        if (napi_get_typedarray_info(env, value, &type, &length, &data, NULL, NULL) != napi_ok) is = false;
        else is = type == napi_uint8_array;
    } else if (value != NULL && napi_is_arraybuffer(env, value, &is) == napi_ok && is) {
        if (napi_get_arraybuffer_info(env, value, &data, &length) != napi_ok) is = false;
    }
    if (!is) {
        napi_throw_type_error(env, NULL, bytes->what);
        return false;
    }
    bytes->view = (ta_bytes){data, length};
    return true;
}

/* ---- the native datamodel's documents ---------------------------------------- */

void ta_napi_document_open(ta_napi_document *document) {
    ta_buffer *buffer = document->room.buffer;
    document->mark = ta_growable_arena_position(document->arena);
    document->refused = TA_OK;
    document->out = (ta_bytes){NULL, 0};
    ta_cbor_writer_init(&document->writer, (ta_buffer){buffer->pointer, buffer->capacity, 0}, document->room.allocator);
}

bool ta_napi_document_value(napi_env env, napi_value value, ta_napi_document *document) {
    return ta_napi_value_write(env, value, &(ta_napi_writing){&document->writer, document->arena, document->wire, &document->refused, false});
}

bool ta_napi_document_close(ta_napi_document *document, bool keep) {
    ta_napi_room *room = &document->room;
    ta_buffer *buffer = room->buffer;
    ta_status status = keep ? ta_cbor_writer_bytes(&document->writer, &document->out) : TA_OK;
    bool kept = keep && status == TA_OK;
    if (keep && status != TA_OK) document->refused = status;
    if (kept && document->writer.bytes != (unsigned char *)buffer->pointer) { /* it grew: its block is the room now */
        if (buffer->pointer != NULL) room->allocator->free(room->allocator->context, buffer->pointer, buffer->capacity);
        *buffer = (ta_buffer){document->writer.bytes, document->writer.capacity, 0};
    } else if (!kept) {
        ta_cbor_writer_free(&document->writer); /* a block it grew, never the room */
        document->out = (ta_bytes){NULL, 0};
    }
    ta_napi_arena_release(document->arena, document->mark, TA_NAPI_ARENA_UNCAPPED); /* in a run: the call's leave caps it */
    return kept;
}
