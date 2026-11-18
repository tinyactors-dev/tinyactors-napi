/* Address (AGENTS.md, "Other systems"; translated from
 * tinyactors-cpython/src/value_types.c): an actor's address, immutable. It
 * holds its text, an own read-only property `text`; its parts are read by
 * core's parser on each access (ta_address_parse, ta_address_name_decode),
 * undefined for a part the text lacks, so no binding parses the grammar.
 * Address.fromSession and Address.fromName make one with core's formatter
 * (ta_address_format, ta_address_format_name). The calls' scratch is the
 * module's arena, a mark per call. */
#include "addon.h"

#include <string.h>

/* napi_type_tag_object's tag of an Address. */
static const napi_type_tag ta_napi_address_tag = {0x7461616464726573ULL, 0x734e41504961646bULL};

bool ta_napi_is_address(napi_env env, napi_value value) {
    napi_valuetype type = napi_undefined;
    bool tagged = false;
    return value != NULL && napi_typeof(env, value, &type) == napi_ok && type == napi_object &&
           napi_check_object_type_tag(env, value, &ta_napi_address_tag, &tagged) == napi_ok && tagged;
}

napi_value ta_napi_address_text(napi_env env, napi_value value) {
    napi_value text;
    if (!ta_napi_is_address(env, value) || napi_get_named_property(env, value, "text", &text) != napi_ok) return value;
    return text;
}

/* new Address(text): a string; the text is the object's own `text`,
 * read-only, and the object is frozen. */
static napi_value ta_napi_address_construct(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {NULL}, self, target;
    napi_valuetype type = napi_undefined;
    if (napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok || napi_get_new_target(env, info, &target) != napi_ok)
        return NULL;
    if (target == NULL) {
        napi_throw_type_error(env, NULL, "Address is a class: new Address(text)");
        return NULL;
    }
    if (argc < 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
        napi_throw_type_error(env, NULL, "an Address is made of its text, a string");
        return NULL;
    }
    napi_property_descriptor property = {"text", NULL, NULL, NULL, NULL, argv[0], napi_enumerable, NULL};
    if (napi_define_properties(env, self, 1, &property) != napi_ok ||
        napi_type_tag_object(env, self, &ta_napi_address_tag) != napi_ok || napi_object_freeze(env, self) != napi_ok)
        return NULL;
    return self;
}

napi_value ta_napi_address_new(napi_env env, ta_string_view text) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value class, argument, address = NULL;
    if (instance == NULL || napi_get_reference_value(env, instance->address, &class) != napi_ok ||
        napi_create_string_utf8(env, text.length ? text.pointer : "", text.length, &argument) != napi_ok ||
        napi_new_instance(env, class, 1, &argument, &address) != napi_ok)
        return NULL;
    return address;
}

/* ---- the parts -------------------------------------------------------------- */

/* A getter's address, parsed: its text's UTF-8 in the module's arena
 * (the caller holds a mark), and whether it is a tinyactors address. */
typedef struct ta_napi_parts {
    ta_napi_instance *instance;
    ta_address address; /* out */
    bool parsed;        /* out */
} ta_napi_parts;

static bool ta_napi_parts_of(napi_env env, napi_callback_info info, ta_napi_parts *parts) {
    size_t argc = 0;
    napi_value self = NULL, text;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) return false;
    if (!ta_napi_is_address(env, self)) {
        napi_throw_type_error(env, NULL, "not an Address");
        return false;
    }
    ta_napi_text utf8 = {&parts->instance->arena, "an Address's text is a string", {NULL, 0}};
    if (napi_get_named_property(env, self, "text", &text) != napi_ok || !ta_napi_text_of(env, text, &utf8)) return false;
    parts->parsed = ta_address_parse(utf8.view, &parts->address) == TA_OK;
    return true;
}

/* Which part a getter reads: its descriptor's data. */
enum { TA_NAPI_PART_SYSTEM = 1, TA_NAPI_PART_SESSION = 2, TA_NAPI_PART_NAME = 3 };

/* A decoded name as a string: core decodes the percent-encodings into the
 * arena (never longer than the encoding); bytes that are not UTF-8 are
 * refused, never replaced: the string's UTF-8 must give them back. */
static napi_value ta_napi_address_name(napi_env env, ta_napi_parts *parts) {
    ta_string_view name = parts->address.name;
    ta_growable_arena *arena = &parts->instance->arena;
    char *room = (char *)ta_growable_arena_alloc(arena, (size_t)name.length * 2 + 2, 1);
    napi_value result = NULL;
    if (room == NULL) return ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the name"});
    ta_buffer out = {room, name.length, 0};
    ta_status status = ta_address_name_decode(name, &out);
    if (status != TA_OK) return ta_napi_throw(env, &(ta_napi_refusal){status, "the address's name does not decode"});
    char *again = room + name.length + 1;
    size_t length = 0;
    if (napi_create_string_utf8(env, room, out.length, &result) != napi_ok ||
        napi_get_value_string_utf8(env, result, again, (size_t)out.length + 1, &length) != napi_ok)
        return NULL;
    if (length != out.length || memcmp(room, again, length) != 0)
        return ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, "the address's name is not UTF-8"});
    return result;
}

/* address.system, .session, .name: undefined when the text is no address
 * or has no such part. */
static napi_value ta_napi_address_part(napi_env env, napi_callback_info info) {
    void *data = NULL;
    size_t argc = 0;
    napi_value result = NULL;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL || napi_get_cb_info(env, info, &argc, NULL, NULL, &data) != napi_ok) return NULL;
    ta_growable_arena_mark mark = ta_growable_arena_position(&instance->arena);
    ta_napi_parts parts = {instance, {0}, false};
    if (ta_napi_parts_of(env, info, &parts)) {
        uintptr_t part = (uintptr_t)data;
        ta_address *address = &parts.address;
        if (!parts.parsed) napi_get_undefined(env, &result);
        else if (part == TA_NAPI_PART_SYSTEM)
            napi_create_string_utf8(env, address->system.length ? address->system.pointer : "", address->system.length, &result);
        else if (part == TA_NAPI_PART_SESSION && address->kind == TA_ADDRESS_SESSION)
            napi_create_bigint_uint64(env, address->session, &result);
        else if (part == TA_NAPI_PART_NAME && address->kind == TA_ADDRESS_NAME) result = ta_napi_address_name(env, &parts);
        else napi_get_undefined(env, &result);
    }
    ta_napi_arena_release(&instance->arena, mark, TA_NAPI_INSTANCE_ARENA_CAP);
    return result;
}

/* address.toString(): the text. */
static napi_value ta_napi_address_to_string(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL, text = NULL;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) return NULL;
    if (!ta_napi_is_address(env, self)) {
        napi_throw_type_error(env, NULL, "not an Address");
        return NULL;
    }
    if (napi_get_named_property(env, self, "text", &text) != napi_ok) return NULL;
    return text;
}

/* ---- made from parts ----------------------------------------------------------- */

/* Address.fromSession(system, session) and Address.fromName(system,
 * name), by core's formatter into the module's arena. */
static napi_value ta_napi_address_from(napi_env env, napi_callback_info info) {
    void *data = NULL;
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, result = NULL;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL || napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok) return NULL;
    bool session = (uintptr_t)data == TA_NAPI_PART_SESSION;
    if (argc < 2) {
        napi_throw_type_error(env, NULL, session ? "Address.fromSession(system, session)" : "Address.fromName(system, name)");
        return NULL;
    }
    ta_growable_arena *arena = &instance->arena;
    ta_growable_arena_mark mark = ta_growable_arena_position(arena);
    ta_napi_text system = {arena, "a system id is a string", {NULL, 0}};
    ta_napi_text name = {arena, "an actor's name is a string", {NULL, 0}};
    uint64_t id = 0;
    bool ok = ta_napi_text_of(env, argv[0], &system);
    if (ok && session) {
        ok = ta_napi_session_of(env, argv[1], &id);
    } else if (ok) ok = ta_napi_text_of(env, argv[1], &name);
    if (ok) {
        size_t room = session ? TA_ADDRESS_SESSION_MAX : 13u + (size_t)system.view.length + 2u + 3u * (size_t)name.view.length;
        char *pointer = (char *)ta_growable_arena_alloc(arena, room, 1);
        ta_buffer out = {pointer, room, 0};
        ta_status status = pointer == NULL ? TA_ERROR_NO_MEMORY
                           : session       ? ta_address_format(system.view, id, &out)
                                           : ta_address_format_name(system.view, name.view, &out);
        if (status != TA_OK) ta_napi_throw(env, &(ta_napi_refusal){status, "core refused the address's parts"});
        else result = ta_napi_address_new(env, (ta_string_view){pointer, (uint32_t)out.length});
    }
    ta_napi_arena_release(arena, mark, TA_NAPI_INSTANCE_ARENA_CAP);
    return result;
}

napi_status ta_napi_address_define(napi_env env, napi_value exports) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return napi_pending_exception;
    napi_property_attributes getter = napi_configurable; /* as a class's accessor: not enumerable */
    napi_property_descriptor properties[] = {
        {"system", NULL, NULL, ta_napi_address_part, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_PART_SYSTEM},
        {"session", NULL, NULL, ta_napi_address_part, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_PART_SESSION},
        {"name", NULL, NULL, ta_napi_address_part, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_PART_NAME},
        {"toString", NULL, ta_napi_address_to_string, NULL, NULL, NULL, napi_default_method, NULL},
        {"fromSession", NULL, ta_napi_address_from, NULL, NULL, NULL, napi_default_method | napi_static,
         (void *)(uintptr_t)TA_NAPI_PART_SESSION},
        {"fromName", NULL, ta_napi_address_from, NULL, NULL, NULL, napi_default_method | napi_static,
         (void *)(uintptr_t)TA_NAPI_PART_NAME},
    };
    napi_value class;
    napi_status status = napi_define_class(env, "Address", NAPI_AUTO_LENGTH, ta_napi_address_construct, NULL,
                                           sizeof properties / sizeof properties[0], properties, &class);
    if (status == napi_ok) status = napi_create_reference(env, class, 1, &instance->address);
    if (status == napi_ok) status = napi_set_named_property(env, exports, "Address", class);
    return status;
}
