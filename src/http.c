/* encodeHTTPPost and parseHTTPRequest (docs/api-map.md): SCXML's BasicHTTP
 * codec of core (tinyactors/basic_http.h), for a transport the application
 * runs. The addon writes no HTTP of its own: ta_http_encode_post writes
 * the request, ta_http_parse_request reads one. Both are module calls with
 * no host: their scratch is the module's arena, a mark per call, and what
 * they give back is copied once (a Buffer, strings). */
#include "addon.h"

#include <string.h>

/* A property of `object` (undefined when absent). */
static napi_value ta_napi_http_property(napi_env env, napi_value object, const char *name) {
    napi_value value = NULL;
    if (napi_get_named_property(env, object, name, &value) != napi_ok) return NULL;
    return value;
}

/* The form fields of a post: an array of {name, value} strings, each
 * string's UTF-8 in the arena; undefined or null is none. */
typedef struct ta_napi_http_fields {
    ta_growable_arena *arena;
    ta_http_field *fields; /* out */
    uint32_t count;        /* out */
} ta_napi_http_fields;

static bool ta_napi_http_fields_of(napi_env env, napi_value value, ta_napi_http_fields *out) {
    napi_valuetype type = napi_undefined;
    bool array = false;
    uint32_t length = 0;
    if (napi_typeof(env, value, &type) != napi_ok) return false;
    if (type == napi_undefined || type == napi_null) return true;
    if (napi_is_array(env, value, &array) != napi_ok || !array || napi_get_array_length(env, value, &length) != napi_ok) {
        napi_throw_type_error(env, NULL, "a post's fields are an array of {name, value}");
        return false;
    }
    out->fields = (ta_http_field *)ta_growable_arena_alloc(out->arena, sizeof(ta_http_field) * (length ? length : 1),
                                                           _Alignof(ta_http_field));
    if (out->fields == NULL) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the post's fields"});
        return false;
    }
    for (uint32_t i = 0; i < length; i++) {
        napi_value field;
        ta_napi_text name = {out->arena, "a field's name is a string", {NULL, 0}};
        ta_napi_text text = {out->arena, "a field's value is a string", {NULL, 0}};
        if (napi_get_element(env, value, i, &field) != napi_ok || napi_typeof(env, field, &type) != napi_ok) return false;
        if (type != napi_object) {
            napi_throw_type_error(env, NULL, "a post's fields are an array of {name, value}");
            return false;
        }
        napi_value given_name = ta_napi_http_property(env, field, "name");
        napi_value given_value = ta_napi_http_property(env, field, "value");
        if (given_name == NULL || given_value == NULL || !ta_napi_text_of(env, given_name, &name) ||
            !ta_napi_text_of(env, given_value, &text))
            return false;
        out->fields[i] = (ta_http_field){name.view, text.view};
    }
    out->count = length;
    return true;
}

/* encodeHTTPPost({url, event, fields, body}) -> Buffer: the request
 * ta_http_encode_post writes, into the arena, then copied once. A request
 * that does not fit tells its length, and is written again into room for
 * it. Keys the object does not use are ignored, as host.send(message)
 * ignores them. */
static napi_value ta_napi_http_encode(napi_env env, napi_callback_info info) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    size_t argc = 1;
    napi_value post = NULL, result = NULL;
    napi_valuetype type = napi_undefined;
    if (instance == NULL || napi_get_cb_info(env, info, &argc, &post, NULL, NULL) != napi_ok) return NULL;
    if (argc < 1 || napi_typeof(env, post, &type) != napi_ok || type != napi_object) {
        napi_throw_type_error(env, NULL, "encodeHTTPPost takes {url, event, fields, body}");
        return NULL;
    }
    ta_growable_arena *arena = &instance->arena;
    ta_growable_arena_mark mark = ta_growable_arena_position(arena);
    ta_napi_text url = {arena, "a post's url is a string", {NULL, 0}};
    ta_napi_text event = {arena, "a post's event is a string", {NULL, 0}};
    ta_napi_text body = {arena, "a post's body is a string", {NULL, 0}};
    ta_napi_http_fields fields = {arena, NULL, 0};
    napi_value given_url = ta_napi_http_property(env, post, "url");
    napi_value given_event = ta_napi_http_property(env, post, "event");
    napi_value given_fields = ta_napi_http_property(env, post, "fields");
    napi_value given_body = ta_napi_http_property(env, post, "body");
    if (given_url != NULL && given_event != NULL && given_fields != NULL && given_body != NULL &&
        ta_napi_text_of(env, given_url, &url) && ta_napi_optional_text(env, given_event, &event) &&
        ta_napi_http_fields_of(env, given_fields, &fields) && ta_napi_optional_text(env, given_body, &body)) {
        ta_http_post request = {url.view, event.view, fields.fields, fields.count, 0, body.view};
        size_t room = 256;
        ta_status status = TA_ERROR_NO_MEMORY;
        ta_buffer out = {NULL, 0, 0};
        for (int attempt = 0; attempt < 2 && status == TA_ERROR_NO_MEMORY; attempt++) {
            void *pointer = ta_growable_arena_alloc(arena, room, 1);
            if (pointer == NULL) break;
            out = (ta_buffer){pointer, room, 0};
            status = ta_http_encode_post(&request, &out);
            room = out.length; /* the length it needs */
        }
        void *data = NULL;
        if (status != TA_OK)
            ta_napi_throw(env, &(ta_napi_refusal){status, status == TA_ERROR_INVALID
                                                              ? "a post's url is http://host[:port]/path"
                                                              : "no memory for the request"});
        else if (napi_create_buffer_copy(env, out.length, out.pointer, &data, &result) != napi_ok)
            result = NULL;
    }
    ta_napi_arena_release(arena, mark, TA_NAPI_INSTANCE_ARENA_CAP);
    return result;
}

/* A string of a view core wrote, refused when it is not UTF-8 (a decoded
 * field may hold any byte): never replaced. `room` holds the view's length
 * plus one, for the string's UTF-8 read back. */
typedef struct ta_napi_http_string {
    ta_string_view view;
    char *room;
} ta_napi_http_string;

static napi_value ta_napi_http_string_of(napi_env env, const ta_napi_http_string *string) {
    napi_value result = NULL;
    size_t length = 0;
    ta_string_view view = string->view;
    if (napi_create_string_utf8(env, view.length ? view.pointer : "", view.length, &result) != napi_ok ||
        napi_get_value_string_utf8(env, result, string->room, (size_t)view.length + 1, &length) != napi_ok)
        return NULL;
    if (length != view.length || (length > 0 && memcmp(view.pointer, string->room, length) != 0))
        return ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, "the request holds text that is not UTF-8"});
    return result;
}

/* The request's fields, as the result object's properties. */
typedef struct ta_napi_http_parsed {
    const ta_http_request *request;
    char *room; /* the message's length plus one */
    napi_value result;
} ta_napi_http_parsed;

static bool ta_napi_http_result(napi_env env, const ta_napi_http_parsed *parsed) {
    const ta_http_request *request = parsed->request;
    const char *names[] = {"method", "target", "body", "event"};
    const ta_string_view views[] = {request->method, request->target, request->body, request->event};
    for (size_t i = 0; i < 4; i++) {
        napi_value value = ta_napi_http_string_of(env, &(ta_napi_http_string){views[i], parsed->room});
        if (value == NULL || napi_set_named_property(env, parsed->result, names[i], value) != napi_ok) return false;
    }
    napi_value fields;
    if (napi_create_array_with_length(env, request->field_count, &fields) != napi_ok) return false;
    for (uint32_t i = 0; i < request->field_count; i++) {
        napi_value field, name, value;
        if (napi_create_object(env, &field) != napi_ok ||
            (name = ta_napi_http_string_of(env, &(ta_napi_http_string){request->fields[i].name, parsed->room})) == NULL ||
            (value = ta_napi_http_string_of(env, &(ta_napi_http_string){request->fields[i].value, parsed->room})) == NULL ||
            napi_set_named_property(env, field, "name", name) != napi_ok ||
            napi_set_named_property(env, field, "value", value) != napi_ok || napi_object_freeze(env, field) != napi_ok ||
            napi_set_element(env, fields, i, field) != napi_ok)
            return false;
    }
    return napi_object_freeze(env, fields) == napi_ok && napi_set_named_property(env, parsed->result, "fields", fields) == napi_ok &&
           napi_object_freeze(env, parsed->result) == napi_ok;
}

/* parseHTTPRequest(message) -> {method, target, body, event, fields}: the
 * message read during the call, its decoded strings in the arena's
 * scratch (at most the message's length, basic_http.h), the request
 * struct there too. */
static napi_value ta_napi_http_parse(napi_env env, napi_callback_info info) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    size_t argc = 1;
    napi_value message = NULL, result = NULL;
    if (instance == NULL || napi_get_cb_info(env, info, &argc, &message, NULL, NULL) != napi_ok) return NULL;
    ta_napi_bytes bytes = {"parseHTTPRequest takes the message's bytes: a Uint8Array or an ArrayBuffer", {NULL, 0}};
    if (!ta_napi_bytes_of(env, argc < 1 ? NULL : message, &bytes)) return NULL;
    ta_growable_arena *arena = &instance->arena;
    ta_growable_arena_mark mark = ta_growable_arena_position(arena);
    size_t length = bytes.view.length;
    ta_http_request *request = (ta_http_request *)ta_growable_arena_alloc(arena, sizeof *request, _Alignof(ta_http_request));
    char *scratch = (char *)ta_growable_arena_alloc(arena, length + 1, 1);
    char *room = (char *)ta_growable_arena_alloc(arena, length + 1, 1);
    if (request == NULL || scratch == NULL || room == NULL)
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory to read the request"});
    else {
        ta_status status = ta_http_parse_request(bytes.view, &(ta_buffer){scratch, length + 1, 0}, request);
        if (status != TA_OK) ta_napi_throw(env, &(ta_napi_refusal){status, "the message is not an HTTP request"});
        else if (napi_create_object(env, &result) != napi_ok ||
                 !ta_napi_http_result(env, &(ta_napi_http_parsed){request, room, result}))
            result = NULL;
    }
    ta_napi_arena_release(arena, mark, TA_NAPI_INSTANCE_ARENA_CAP);
    return result;
}

napi_status ta_napi_http_define(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"encodeHTTPPost", NULL, ta_napi_http_encode, NULL, NULL, NULL, napi_enumerable, NULL},
        {"parseHTTPRequest", NULL, ta_napi_http_parse, NULL, NULL, NULL, napi_enumerable, NULL},
    };
    return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties);
}
