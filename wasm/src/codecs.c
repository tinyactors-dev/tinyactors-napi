/* Core's codecs the API exposes without a host (docs/api-map.md): an
 * Address's parts and its formatting (tinyactors/address.h), and SCXML's
 * BasicHTTP (tinyactors/basic_http.h). Each is a module call: its text in
 * the environment's arena, above the call's mark (JavaScript enters and
 * leaves it), and what it gives back a view there, read by JavaScript
 * before the leave. */
#include "web.h"

/* ---- Address ------------------------------------------------------------------------- */

/* Record: 0-1 an address's text. Answers the status (TA_OK when it is a
 * tinyactors address) and, when it is, the record: 0 kind (TA_ADDRESS_*),
 * 1-2 the system id, 3-4 the session, 5-6 the name (still
 * percent-encoded), views of the text. */
TA_WEB_EXPORT int32_t ta_web_address_parse(ta_web_env *env) {
    uint32_t *word = env->record.word;
    ta_address address;
    ta_status status = ta_address_parse(ta_web_text_at(word, 0), &address);
    if (status != TA_OK) return status;
    word[0] = address.kind;
    ta_web_set_text(word, 1, address.system);
    ta_web_set_word64(word, 3, address.kind == TA_ADDRESS_SESSION ? address.session : 0);
    ta_web_set_text(word, 5, address.kind == TA_ADDRESS_NAME ? address.name : (ta_string_view){NULL, 0});
    return TA_OK;
}

/* Record: 0-1 a name, percent-encoded. Answers the status; the decoded
 * bytes in the record's words 0-1, in the environment's arena (never
 * longer than the encoding). */
TA_WEB_EXPORT int32_t ta_web_address_name(ta_web_env *env) {
    uint32_t *word = env->record.word;
    ta_string_view name = ta_web_text_at(word, 0);
    void *room = ta_growable_arena_alloc(&env->scratch.arena, name.length ? name.length : 1, 1);
    if (room == NULL) return TA_ERROR_NO_MEMORY;
    ta_buffer out = {room, name.length, 0};
    ta_status status = ta_address_name_decode(name, &out);
    ta_web_set_bytes(word, 0, (ta_bytes){room, status == TA_OK ? out.length : 0});
    return status;
}

/* Address.fromSession (`kind` TA_ADDRESS_SESSION; record 0-1 the system id,
 * 2-3 the session) and Address.fromName (TA_ADDRESS_NAME; 0-1 the system
 * id, 2-3 the name): core's formatter into the environment's arena.
 * Answers the status, the text in the record's words 0-1. */
TA_WEB_EXPORT int32_t ta_web_address_format(ta_web_env *env, uint32_t kind) {
    uint32_t *word = env->record.word;
    ta_string_view system = ta_web_text_at(word, 0);
    bool session = kind == TA_ADDRESS_SESSION;
    uint64_t id = ta_web_word64(word, 2);
    ta_string_view name = ta_web_text_at(word, 2);
    size_t room = session ? TA_ADDRESS_SESSION_MAX : 13u + (size_t)system.length + 2u + 3u * (size_t)name.length;
    void *pointer = ta_growable_arena_alloc(&env->scratch.arena, room, 1);
    if (pointer == NULL) return TA_ERROR_NO_MEMORY;
    ta_buffer out = {pointer, room, 0};
    ta_status status = session ? ta_address_format(system, id, &out) : ta_address_format_name(system, name, &out);
    ta_web_set_bytes(word, 0, (ta_bytes){pointer, status == TA_OK ? out.length : 0});
    return status;
}

/* ---- BasicHTTP ------------------------------------------------------------------------- */

/* encodeHTTPPost. Record: 0-1 url, 2-3 event, 4 the address of the
 * fields' words (4 each: name, value), 5 their count, 6-7 body. Answers
 * the status; the request in the record's words 0-1, in the environment's
 * arena. A request that does not fit tells its length and is written again
 * into room for it. */
TA_WEB_EXPORT int32_t ta_web_http_encode(ta_web_env *env) {
    uint32_t *word = env->record.word;
    const uint32_t *pairs = (const uint32_t *)(uintptr_t)word[4];
    uint32_t count = word[5];
    ta_http_field *fields = count ? (ta_http_field *)ta_growable_arena_alloc(&env->scratch.arena, sizeof *fields * count, 8) : NULL;
    if (count && fields == NULL) return TA_ERROR_NO_MEMORY;
    for (uint32_t i = 0; i < count; i++) fields[i] = (ta_http_field){ta_web_text_at(pairs, 4 * i), ta_web_text_at(pairs, 4 * i + 2)};
    ta_http_post post = {ta_web_text_at(word, 0), ta_web_text_at(word, 2), fields, count, 0, ta_web_text_at(word, 6)};
    size_t room = 256;
    ta_status status = TA_ERROR_NO_MEMORY;
    ta_buffer out = {NULL, 0, 0};
    for (int attempt = 0; attempt < 2 && status == TA_ERROR_NO_MEMORY; attempt++) {
        void *pointer = ta_growable_arena_alloc(&env->scratch.arena, room, 1);
        if (pointer == NULL) break;
        out = (ta_buffer){pointer, room, 0};
        status = ta_http_encode_post(&post, &out);
        room = out.length; /* the length it needs */
    }
    ta_web_set_bytes(word, 0, (ta_bytes){out.pointer, status == TA_OK ? out.length : 0});
    return status;
}

/* parseHTTPRequest. Record: 0-1 the message. Answers the status; the
 * record: 0-1 method, 2-3 target, 4-5 body, 6-7 event, 8 the fields'
 * count, 9 the address of their words (4 each: name, value), views in the
 * environment's arena (its decoded strings) or of the message. */
TA_WEB_EXPORT int32_t ta_web_http_parse(ta_web_env *env) {
    uint32_t *word = env->record.word;
    ta_bytes message = ta_web_bytes_at(word, 0);
    ta_growable_arena *arena = &env->scratch.arena;
    ta_http_request *request = (ta_http_request *)ta_growable_arena_alloc(arena, sizeof *request, 8);
    void *scratch = ta_growable_arena_alloc(arena, message.length + 1, 1);
    if (request == NULL || scratch == NULL) return TA_ERROR_NO_MEMORY;
    ta_status status = ta_http_parse_request(message, &(ta_buffer){scratch, message.length + 1, 0}, request);
    if (status != TA_OK) return status;
    uint32_t *fields = (uint32_t *)ta_growable_arena_alloc(arena, sizeof(uint32_t) * 4 * (request->field_count + 1), 8);
    if (fields == NULL) return TA_ERROR_NO_MEMORY;
    for (uint32_t i = 0; i < request->field_count; i++) {
        ta_web_set_text(fields, 4 * i, request->fields[i].name);
        ta_web_set_text(fields, 4 * i + 2, request->fields[i].value);
    }
    ta_web_set_text(word, 0, request->method);
    ta_web_set_text(word, 2, request->target);
    ta_web_set_text(word, 4, request->body);
    ta_web_set_text(word, 6, request->event);
    word[8] = request->field_count;
    word[9] = ta_web_address(fields);
    return TA_OK;
}
