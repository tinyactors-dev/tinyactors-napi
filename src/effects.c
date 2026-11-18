/* The effects (AGENTS.md, "Lifetimes and thin views"; translated from
 * tinyactors-cpython/src/effects.c): dispatch of one effect of the open
 * batch, and the objects JavaScript sees of them.
 *
 * A thin view (a Send, a LogEntry, a Migrated) is a small object whose state is an
 * array under the instance's `view` symbol: the Host's wrapper, the ack
 * count of its batch, the effect's index, the send's I/O processor, its
 * flags (record, answered, failed), then one slot per field, a hole until
 * the field is read. A field is converted on first read and cached; a read
 * with another ack count throws TA_ERROR_STALE. When a handler returns a
 * thenable, its view is filled with every field before the ack and marked
 * a record: it never goes stale, and answer() and fail() work while the
 * host lives (docs/plan.xml, decision d-async). The state is the engine's
 * memory, as a Python view's fields are Python's: the addon allocates
 * nothing per effect. */
#include "addon.h"

#include <string.h>

/* ---- the state of a view ------------------------------------------------------- */

enum {
    TA_NAPI_VIEW_HOST,
    TA_NAPI_VIEW_ACKS,
    TA_NAPI_VIEW_INDEX,
    TA_NAPI_VIEW_PROCESSOR,
    TA_NAPI_VIEW_FLAGS,
    TA_NAPI_VIEW_FIELDS /* the first field's slot */
};

enum { TA_NAPI_VIEW_RECORD = 1u, TA_NAPI_VIEW_ANSWERED = 2u, TA_NAPI_VIEW_FAILED = 4u };

/* A Send's fields, in the order a record is filled. */
enum {
    TA_NAPI_SEND_SESSION,
    TA_NAPI_SEND_EVENT,
    TA_NAPI_SEND_TARGET,
    TA_NAPI_SEND_SENDID,
    TA_NAPI_SEND_DATA,
    TA_NAPI_SEND_TYPE,
    TA_NAPI_SEND_ORIGIN,
    TA_NAPI_SEND_TRACEPARENT,
    TA_NAPI_SEND_COUNT
};

/* A LogEntry's fields. */
enum { TA_NAPI_ENTRY_SESSION, TA_NAPI_ENTRY_LABEL, TA_NAPI_ENTRY_TEXT, TA_NAPI_ENTRY_COUNT };

/* A Migrated's fields: the session, the segment and the chart (its name)
 * it moved to, its migration. */
enum { TA_NAPI_MIGRATED_SESSION, TA_NAPI_MIGRATED_SEGMENT, TA_NAPI_MIGRATED_CHART, TA_NAPI_MIGRATED_MIGRATION,
       TA_NAPI_MIGRATED_COUNT };

/* What a getter reads, its descriptor's data: the view's kind and field. */
enum { TA_NAPI_KIND_SEND = 0, TA_NAPI_KIND_ENTRY = 1, TA_NAPI_KIND_MIGRATED = 2 };
#define TA_NAPI_GETTER(kind, field) ((void *)(uintptr_t)(((kind) << 8) | (field)))

/* A view as C reads it, for one call. */
typedef struct ta_napi_view {
    napi_value self, state, wrapper;
    ta_napi_host *host;
    double acks;
    uint32_t index, processor, flags;
} ta_napi_view;

static napi_value ta_napi_undefined(napi_env env) {
    napi_value undefined = NULL;
    napi_get_undefined(env, &undefined);
    return undefined;
}

static bool ta_napi_is(napi_env env, napi_value value, napi_valuetype want) {
    napi_valuetype type = napi_undefined;
    return value != NULL && napi_typeof(env, value, &type) == napi_ok && type == want;
}

/* The instance's symbol `name`. */
static napi_value ta_napi_key(napi_env env, const char *name) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value keys, key;
    if (instance == NULL || napi_get_reference_value(env, instance->keys, &keys) != napi_ok ||
        napi_get_named_property(env, keys, name, &key) != napi_ok)
        return NULL;
    return key;
}

/* A number of a view's state: slot `slot` of `state` into `value`. */
typedef struct ta_napi_slot {
    napi_value state;
    uint32_t slot;
    uint32_t *value; /* out */
} ta_napi_slot;

static bool ta_napi_state_uint32(napi_env env, const ta_napi_slot *slot) {
    napi_value value;
    return napi_get_element(env, slot->state, slot->slot, &value) == napi_ok &&
           napi_get_value_uint32(env, value, slot->value) == napi_ok;
}

/* `self` as a view; false with a TypeError when it is none. */
static bool ta_napi_view_of(napi_env env, napi_value self, ta_napi_view *view) {
    napi_value key = ta_napi_key(env, "view"), acks;
    bool array = false;
    memset(view, 0, sizeof *view);
    view->self = self;
    if (key == NULL) return false;
    if (!ta_napi_is(env, self, napi_object) || napi_get_property(env, self, key, &view->state) != napi_ok ||
        napi_is_array(env, view->state, &array) != napi_ok || !array ||
        napi_get_element(env, view->state, TA_NAPI_VIEW_HOST, &view->wrapper) != napi_ok ||
        napi_get_element(env, view->state, TA_NAPI_VIEW_ACKS, &acks) != napi_ok ||
        napi_get_value_double(env, acks, &view->acks) != napi_ok ||
        !ta_napi_state_uint32(env, &(ta_napi_slot){view->state, TA_NAPI_VIEW_INDEX, &view->index}) ||
        !ta_napi_state_uint32(env, &(ta_napi_slot){view->state, TA_NAPI_VIEW_PROCESSOR, &view->processor}) ||
        !ta_napi_state_uint32(env, &(ta_napi_slot){view->state, TA_NAPI_VIEW_FLAGS, &view->flags})) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        napi_throw_type_error(env, NULL, "not a view of an effect");
        return false;
    }
    view->host = ta_napi_host_of(env, &(ta_napi_host_check){view->wrapper, false});
    return view->host != NULL;
}

/* The flags as the state holds them now: a handler's answer() sets them
 * through a view of its own, so a copy read before it is out of date. */
static bool ta_napi_view_flags(napi_env env, ta_napi_view *view) {
    return ta_napi_state_uint32(env, &(ta_napi_slot){view->state, TA_NAPI_VIEW_FLAGS, &view->flags});
}

static bool ta_napi_view_flag(napi_env env, ta_napi_view *view, uint32_t flag) {
    napi_value flags;
    if (!ta_napi_view_flags(env, view)) return false;
    view->flags |= flag;
    return napi_create_uint32(env, view->flags, &flags) == napi_ok &&
           napi_set_element(env, view->state, TA_NAPI_VIEW_FLAGS, flags) == napi_ok;
}

/* The view's batch is still open (or it is a record); else TA_ERROR_STALE. */
static bool ta_napi_view_live(napi_env env, const ta_napi_view *view) {
    if (view->flags & TA_NAPI_VIEW_RECORD) return true;
    if (view->host->host != NULL && (double)view->host->acks == view->acks) return true;
    ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STALE, "the effect's batch was acknowledged: read its fields in the "
                                                          "handler, or return a promise from it"});
    return false;
}

/* ---- the fields ----------------------------------------------------------------- */

/* A text field as a string; empty text as undefined when `empty_none`. */
typedef struct ta_napi_text_field {
    uint32_t field;
    bool empty_none;
} ta_napi_text_field;

static napi_value ta_napi_effect_text(napi_env env, const ta_napi_view *view, const ta_napi_text_field *field) {
    ta_string_view text = ta_host_effect_text(view->host->host, view->index, field->field);
    napi_value result = NULL;
    if (text.length == 0 && field->empty_none) return ta_napi_undefined(env);
    napi_create_string_utf8(env, text.length ? text.pointer : "", text.length, &result);
    return result;
}

static napi_value ta_napi_effect_session(napi_env env, const ta_napi_view *view) {
    napi_value result = NULL;
    napi_create_bigint_uint64(env, ta_host_effect_number(view->host->host, view->index, TA_EFFECT_FIELD_SESSION), &result);
    return result;
}

/* An address the effect gives as text, as an Address (empty: undefined). */
static napi_value ta_napi_effect_address(napi_env env, const ta_napi_view *view, uint32_t field) {
    ta_string_view text = ta_host_effect_text(view->host->host, view->index, field);
    if (text.length == 0) return ta_napi_undefined(env);
    return ta_napi_address_new(env, text);
}

/* The send's data: undefined without a payload; the native datamodel's
 * the payload row's value (retained by core until the ack) copied into the
 * application's realm on first read, an XML node as its text; quickjs's
 * decoded from its CBOR (a view of quickjs's memory until its next call,
 * read at once). */
static napi_value ta_napi_effect_data(napi_env env, const ta_napi_view *view) {
    ta_napi_host *host = view->host;
    ta_payload payload = (ta_payload)ta_host_effect_number(host->host, view->index, TA_EFFECT_FIELD_PAYLOAD);
    uint32_t datamodel = (uint32_t)ta_host_effect_number(host->host, view->index, TA_EFFECT_FIELD_DATAMODEL);
    if (payload == 0 || datamodel == TA_NIL) return ta_napi_undefined(env);
    if (host->datamodel == TA_NAPI_DATAMODEL_NATIVE) return ta_napi_native_exported(&host->native, payload);
    if (host->quickjs == NULL) return ta_napi_undefined(env);
    ta_bytes cbor;
    ta_status status = ta_datamodel_ecmascript_payload_to_cbor(host->quickjs, payload, &cbor);
    if (status != TA_OK) return ta_napi_throw(env, &(ta_napi_refusal){status, "the send's data could not be read"});
    return ta_napi_value_read(env, cbor);
}

/* The handlers object on the wrapper; undefined once closed. */
static napi_value ta_napi_handlers(napi_env env, napi_value wrapper) {
    napi_value key = ta_napi_key(env, "handlers"), handlers = NULL;
    if (key == NULL || napi_get_property(env, wrapper, key, &handlers) != napi_ok) return NULL;
    return handlers;
}

/* handlers[list][index]: undefined when there is none. */
typedef struct ta_napi_handler_at {
    const char *list;
    uint32_t index;
} ta_napi_handler_at;

static napi_value ta_napi_handler_of(napi_env env, napi_value wrapper, const ta_napi_handler_at *at) {
    napi_value handlers = ta_napi_handlers(env, wrapper), list, value;
    if (handlers == NULL) return NULL;
    if (!ta_napi_is(env, handlers, napi_object)) return ta_napi_undefined(env);
    if (napi_get_named_property(env, handlers, at->list, &list) != napi_ok) return NULL;
    if (at->index == UINT32_MAX) return list; /* the handler itself (log) */
    if (!ta_napi_is(env, list, napi_object)) return ta_napi_undefined(env);
    if (napi_get_element(env, list, at->index, &value) != napi_ok) return NULL;
    return value;
}

static napi_value ta_napi_send_field(napi_env env, const ta_napi_view *view, uint32_t field) {
    switch (field) {
    case TA_NAPI_SEND_SESSION: return ta_napi_effect_session(env, view);
    case TA_NAPI_SEND_EVENT: return ta_napi_effect_text(env, view, &(ta_napi_text_field){TA_EFFECT_FIELD_EVENT, false});
    case TA_NAPI_SEND_TARGET: /* another system's address for the transport (0), else the processor's text */
        if (view->processor == 0) return ta_napi_effect_address(env, view, TA_EFFECT_FIELD_TARGET);
        return ta_napi_effect_text(env, view, &(ta_napi_text_field){TA_EFFECT_FIELD_TARGET, true});
    case TA_NAPI_SEND_SENDID: return ta_napi_effect_text(env, view, &(ta_napi_text_field){TA_EFFECT_FIELD_SENDID, true});
    case TA_NAPI_SEND_DATA: return ta_napi_effect_data(env, view);
    case TA_NAPI_SEND_TYPE: /* the config's type; undefined for the transport and a service */
        if (view->processor == TA_NIL) return ta_napi_undefined(env);
        return ta_napi_handler_of(env, view->wrapper, &(ta_napi_handler_at){"types", view->processor});
    case TA_NAPI_SEND_ORIGIN: /* the sender's address, formatted by core on first ask */
        return ta_napi_effect_address(env, view, TA_EFFECT_FIELD_ORIGIN);
    default: /* formatted by core from the binary context on first ask; empty when untraced */
        return ta_napi_effect_text(env, view, &(ta_napi_text_field){TA_EFFECT_FIELD_TRACEPARENT, true});
    }
}

static napi_value ta_napi_entry_field(napi_env env, const ta_napi_view *view, uint32_t field) {
    if (field == TA_NAPI_ENTRY_SESSION) return ta_napi_effect_session(env, view);
    uint32_t which = field == TA_NAPI_ENTRY_LABEL ? TA_EFFECT_FIELD_AUXILIARY : TA_EFFECT_FIELD_EVENT;
    return ta_napi_effect_text(env, view, &(ta_napi_text_field){which, false});
}

/* A MIGRATED effect's field: the chart is EVENT's text, the numbers its
 * own fields. */
static napi_value ta_napi_migrated_field(napi_env env, const ta_napi_view *view, uint32_t field) {
    napi_value result = NULL;
    if (field == TA_NAPI_MIGRATED_SESSION) return ta_napi_effect_session(env, view);
    if (field == TA_NAPI_MIGRATED_CHART) return ta_napi_effect_text(env, view, &(ta_napi_text_field){TA_EFFECT_FIELD_EVENT, false});
    uint32_t which = field == TA_NAPI_MIGRATED_SEGMENT ? TA_EFFECT_FIELD_SEGMENT : TA_EFFECT_FIELD_MIGRATION;
    napi_create_uint32(env, (uint32_t)ta_host_effect_number(view->host->host, view->index, which), &result);
    return result;
}

/* A field of a view, by kind: cached, or converted now and cached. */
typedef struct ta_napi_field {
    uint32_t kind, field;
} ta_napi_field;

static napi_value ta_napi_view_read(napi_env env, const ta_napi_view *view, const ta_napi_field *field) {
    uint32_t slot = TA_NAPI_VIEW_FIELDS + field->field;
    bool cached = false;
    napi_value value = NULL;
    if (napi_has_element(env, view->state, slot, &cached) != napi_ok) return NULL;
    if (cached) return napi_get_element(env, view->state, slot, &value) == napi_ok ? value : NULL;
    if (!ta_napi_view_live(env, view)) return NULL;
    value = field->kind == TA_NAPI_KIND_SEND    ? ta_napi_send_field(env, view, field->field)
            : field->kind == TA_NAPI_KIND_ENTRY ? ta_napi_entry_field(env, view, field->field)
                                                : ta_napi_migrated_field(env, view, field->field);
    if (value == NULL || napi_set_element(env, view->state, slot, value) != napi_ok) return NULL;
    return value;
}

/* A getter of a Send, a LogEntry or a Migrated. */
static napi_value ta_napi_view_get(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL;
    void *data = NULL;
    ta_napi_view view;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, &data) != napi_ok || !ta_napi_view_of(env, self, &view))
        return NULL;
    uintptr_t which = (uintptr_t)data;
    return ta_napi_view_read(env, &view, &(ta_napi_field){(uint32_t)(which >> 8), (uint32_t)(which & 0xffu)});
}

static napi_value ta_napi_send_read(napi_env env, const ta_napi_view *view, uint32_t field) {
    return ta_napi_view_read(env, view, &(ta_napi_field){TA_NAPI_KIND_SEND, field});
}

/* send.message: the outgoing half of a send between systems, the object
 * host.send(message) takes on the other side (ta_event_in's fields). A
 * text field the send lacks (sendid, origin, traceparent) is null, as
 * Python's message has None: encoded, every binding reads it as absent
 * (Python's host.send refuses undefined, its UNDEFINED, for a text). */
static napi_value ta_napi_send_message(napi_env env, napi_callback_info info) {
    static const char *const keys[] = {"target", "event", "data", "sendid", "origin", "traceparent"};
    static const uint32_t fields[] = {TA_NAPI_SEND_TARGET, TA_NAPI_SEND_EVENT,  TA_NAPI_SEND_DATA,
                                      TA_NAPI_SEND_SENDID, TA_NAPI_SEND_ORIGIN, TA_NAPI_SEND_TRACEPARENT};
    size_t argc = 0;
    napi_value self = NULL, message;
    ta_napi_view view;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok || !ta_napi_view_of(env, self, &view) ||
        napi_create_object(env, &message) != napi_ok)
        return NULL;
    for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) {
        napi_value value = ta_napi_send_read(env, &view, fields[i]);
        napi_valuetype type = napi_undefined;
        if (value == NULL || napi_typeof(env, value, &type) != napi_ok) return NULL;
        if (type == napi_undefined && i >= 3 && napi_get_null(env, &value) != napi_ok) return NULL; /* text fields */
        if (napi_set_named_property(env, message, keys[i], value) != napi_ok) return NULL;
    }
    return message;
}

/* ---- answering a send ------------------------------------------------------------- */

/* The answer or the failure of a send: ta_host_send to its session with
 * its sendid (bindings.md, section 4). `name` NULL: the failure.
 * `traceparent` NULL: the send's own trace. */
typedef struct ta_napi_answer {
    napi_value name, data, traceparent, origin, raw;
} ta_napi_answer;

/* What an answer or a failure came to: refused (an exception pending),
 * delivered, or not delivered because the sender ended meanwhile. */
typedef enum ta_napi_replied { TA_NAPI_REPLY_REFUSED, TA_NAPI_REPLY_DELIVERED, TA_NAPI_REPLY_ENDED } ta_napi_replied;

static ta_napi_replied ta_napi_send_reply(napi_env env, ta_napi_view *view, const ta_napi_answer *answer) {
    if (!ta_napi_view_flags(env, view) || !ta_napi_view_live(env, view))
        return TA_NAPI_REPLY_REFUSED; /* a thin view answers before its ack, whatever was read */
    if (view->flags & (TA_NAPI_VIEW_ANSWERED | TA_NAPI_VIEW_FAILED)) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STATE, view->flags & TA_NAPI_VIEW_FAILED
                                                                  ? "the send was failed already"
                                                                  : "the send was answered already"});
        return TA_NAPI_REPLY_REFUSED;
    }
    napi_value session = ta_napi_send_read(env, view, TA_NAPI_SEND_SESSION);
    napi_value sendid = session ? ta_napi_send_read(env, view, TA_NAPI_SEND_SENDID) : NULL;
    napi_value type = sendid ? ta_napi_send_read(env, view, TA_NAPI_SEND_TYPE) : NULL;
    if (type == NULL) return TA_NAPI_REPLY_REFUSED;
    napi_value traceparent = answer->traceparent;
    if (traceparent == NULL) traceparent = ta_napi_send_read(env, view, TA_NAPI_SEND_TRACEPARENT);
    ta_napi_call call;
    if (traceparent == NULL || !ta_napi_enter(env, view->wrapper, &call)) return TA_NAPI_REPLY_REFUSED;
    ta_napi_host *host = call.host;
    ta_event_in event;
    memset(&event, 0, sizeof event);
    event.size = sizeof event;
    bool lossless = false;
    ta_napi_text sendid_text = {&host->arena, "a sendid is a string", {NULL, 0}};
    ta_napi_text trace_text = {&host->arena, "a traceparent is W3C text, a string, or null for a new trace", {NULL, 0}};
    ta_napi_text name_text = {&host->arena, "an answer's event is a string", {NULL, 0}};
    ta_napi_text type_text = {&host->arena, "a processor's type is a string", {NULL, 0}};
    ta_napi_text origin_text = {&host->arena, "an origin is an address, a string or an Address", {NULL, 0}};
    ta_napi_text raw_text = {&host->arena, "raw is the message as read, a string", {NULL, 0}};
    bool ok = napi_get_value_bigint_uint64(env, session, &event.session, &lossless) == napi_ok &&
              ta_napi_optional_text(env, sendid, &sendid_text) && ta_napi_optional_text(env, traceparent, &trace_text);
    ta_host_location location;
    if (ok && ta_host_locate(host->host, event.session, &location) != TA_OK) { /* the sender ended: nobody to tell */
        ta_napi_leave(&call);
        return TA_NAPI_REPLY_ENDED;
    }
    ta_napi_replied replied = TA_NAPI_REPLY_REFUSED;
    ta_napi_payload_for payload = {event.session, {0, 0}, answer->data, 0};
    if (ok && answer->name == NULL) event.flags = TA_EVENT_IN_ERROR_COMMUNICATION; /* the name is not repeated */
    else if (ok)
        ok = ta_napi_text_of(env, answer->name, &name_text) && ta_napi_optional_text(env, type, &type_text) &&
             ta_napi_optional_text(env, ta_napi_address_text(env, answer->origin), &origin_text) &&
             ta_napi_optional_text(env, answer->raw, &raw_text) && ta_napi_host_payload(env, host, &payload);
    if (ok) {
        event.sendid = sendid_text.view;
        event.traceparent = trace_text.view;
        event.name = name_text.view;
        event.origintype = type_text.view;
        event.origin = origin_text.view;
        event.raw = raw_text.view;
        event.data = payload.payload;
        ta_status status = ta_host_send(host->host, &event);
        if (status == TA_ERROR_STALE) { /* the sender ended: nobody to tell */
            ta_napi_host_payload_release(host, payload.payload); /* still ours */
            replied = TA_NAPI_REPLY_ENDED;
        } else if (status != TA_OK) {
            ta_napi_host_payload_release(host, payload.payload); /* still ours */
            ta_napi_throw(env, &(ta_napi_refusal){status, answer->name ? "the answer was refused" : "the failure was refused"});
        } else if (ta_napi_view_flag(env, view, answer->name ? TA_NAPI_VIEW_ANSWERED : TA_NAPI_VIEW_FAILED)) {
            replied = TA_NAPI_REPLY_DELIVERED;
            ta_napi_schedule(env, host);
        }
    }
    ta_napi_leave(&call);
    return replied;
}

/* What answer() and fail() return: true when delivered, false when the
 * sender ended meanwhile; NULL (an exception pending) when refused. */
static napi_value ta_napi_replied_value(napi_env env, ta_napi_replied replied) {
    napi_value result = NULL;
    if (replied == TA_NAPI_REPLY_REFUSED) return NULL;
    napi_get_boolean(env, replied == TA_NAPI_REPLY_DELIVERED, &result);
    return result;
}

/* send.answer(event, data?, {traceparent, origin, raw}?): true when
 * delivered, false when the sender ended meanwhile. */
static napi_value ta_napi_send_answer(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {NULL, NULL, NULL}, self = NULL, keys, key;
    ta_napi_view view;
    if (napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok || !ta_napi_view_of(env, self, &view)) return NULL;
    napi_value undefined = ta_napi_undefined(env);
    for (size_t i = argc; i < 3; i++) argv[i] = undefined;
    ta_napi_answer answer = {argv[0], argv[1], NULL, undefined, undefined};
    if (!ta_napi_is(env, argv[2], napi_undefined)) {
        static const char *const known[] = {"traceparent", "origin", "raw"};
        uint32_t count = 0;
        if (!ta_napi_is(env, argv[2], napi_object) || napi_get_property_names(env, argv[2], &keys) != napi_ok ||
            napi_get_array_length(env, keys, &count) != napi_ok) {
            napi_throw_type_error(env, NULL, "an answer's options are an object of traceparent, origin, raw");
            return NULL;
        }
        for (uint32_t i = 0; i < count; i++) {
            char name[16];
            size_t length = 0;
            bool found = false;
            if (napi_get_element(env, keys, i, &key) != napi_ok ||
                napi_get_value_string_utf8(env, key, name, sizeof name, &length) != napi_ok)
                return NULL;
            for (size_t j = 0; j < 3 && !found; j++) found = strlen(known[j]) == length && memcmp(known[j], name, length) == 0;
            if (!found) {
                napi_throw_type_error(env, NULL, "an answer's options are traceparent, origin and raw");
                return NULL;
            }
        }
        napi_value traceparent;
        if (napi_get_named_property(env, argv[2], "traceparent", &traceparent) != napi_ok ||
            napi_get_named_property(env, argv[2], "origin", &answer.origin) != napi_ok ||
            napi_get_named_property(env, argv[2], "raw", &answer.raw) != napi_ok)
            return NULL;
        if (!ta_napi_is(env, traceparent, napi_undefined)) answer.traceparent = traceparent; /* null: a new trace */
    }
    if (!ta_napi_is(env, answer.name, napi_string)) {
        napi_throw_type_error(env, NULL, "answer(event, data?, options?): the event is a string");
        return NULL;
    }
    return ta_napi_replied_value(env, ta_napi_send_reply(env, &view, &answer));
}

/* send.fail(): error.communication for the sender, with the send's sendid
 * and trace; false when the sender ended, as answer(). */
static napi_value ta_napi_send_fail(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL;
    ta_napi_view view;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok || !ta_napi_view_of(env, self, &view)) return NULL;
    ta_napi_answer answer = {NULL, ta_napi_undefined(env), NULL, NULL, NULL};
    return ta_napi_replied_value(env, ta_napi_send_reply(env, &view, &answer));
}

/* Fails a send nobody answered, for a handler that could not (ADR 0009: a
 * runtime that cannot do what an effect asks answers with a failure); what
 * that throws is dropped. */
static void ta_napi_send_fail_unanswered(napi_env env, ta_napi_view *view) {
    if (!ta_napi_view_flags(env, view)) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        return;
    }
    if (view->flags & (TA_NAPI_VIEW_ANSWERED | TA_NAPI_VIEW_FAILED) || view->host->host == NULL) return;
    ta_napi_answer answer = {NULL, ta_napi_undefined(env), NULL, NULL, NULL};
    if (ta_napi_send_reply(env, view, &answer) == TA_NAPI_REPLY_REFUSED) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
    }
}

/* The handler threw (or its thenable could not be followed): its send is
 * failed unless answered, and the error kept for the turn. */
static void ta_napi_send_raised(napi_env env, ta_napi_view *view) {
    napi_value error = NULL;
    if (napi_get_and_clear_last_exception(env, &error) != napi_ok) error = NULL;
    ta_napi_send_fail_unanswered(env, view);
    if (error != NULL) napi_throw(env, error);
    ta_napi_keep_error(env, view->host);
}

/* A handler's promise rejected (bound to its view): the send is failed if
 * nobody answered it, and the rejection goes on, so the promise `then`
 * made rejects unhandled and the runtime reports it (decision d-errors). */
static napi_value ta_napi_send_rejected(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL};
    ta_napi_view view;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return NULL;
    if (argc < 2) argv[1] = ta_napi_undefined(env);
    if (ta_napi_view_of(env, argv[0], &view)) ta_napi_send_fail_unanswered(env, &view);
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
    napi_throw(env, argv[1]);
    return NULL;
}

/* ---- dispatch ------------------------------------------------------------------------ */

/* A new view of effect `index`: its class (send or entry), its fields'
 * slots holes until read. */
typedef struct ta_napi_view_spec {
    ta_napi_host *host;
    napi_ref class;
    uint32_t index, processor, fields;
} ta_napi_view_spec;

static bool ta_napi_view_new(napi_env env, const ta_napi_view_spec *spec, ta_napi_view *view) {
    ta_napi_host *host = spec->host;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value class, keys, argv[2], acks, index, processor, flags;
    memset(view, 0, sizeof *view);
    view->host = host;
    view->wrapper = ta_napi_self(env, host);
    view->acks = (double)host->acks;
    view->index = spec->index;
    view->processor = spec->processor;
    if (instance == NULL || view->wrapper == NULL || napi_get_reference_value(env, spec->class, &class) != napi_ok ||
        napi_get_reference_value(env, instance->keys, &keys) != napi_ok ||
        napi_create_array_with_length(env, TA_NAPI_VIEW_FIELDS + spec->fields, &view->state) != napi_ok ||
        napi_create_double(env, view->acks, &acks) != napi_ok || napi_create_uint32(env, spec->index, &index) != napi_ok ||
        napi_create_uint32(env, spec->processor, &processor) != napi_ok || napi_create_uint32(env, 0, &flags) != napi_ok ||
        napi_set_element(env, view->state, TA_NAPI_VIEW_HOST, view->wrapper) != napi_ok ||
        napi_set_element(env, view->state, TA_NAPI_VIEW_ACKS, acks) != napi_ok ||
        napi_set_element(env, view->state, TA_NAPI_VIEW_INDEX, index) != napi_ok ||
        napi_set_element(env, view->state, TA_NAPI_VIEW_PROCESSOR, processor) != napi_ok ||
        napi_set_element(env, view->state, TA_NAPI_VIEW_FLAGS, flags) != napi_ok)
        return false;
    argv[0] = keys;
    argv[1] = view->state;
    return napi_new_instance(env, class, 2, argv, &view->self) == napi_ok;
}

/* The constructor of Send and LogEntry: only the drain makes one (it
 * passes the instance's keys, which no export reaches, and the state). */
static napi_value ta_napi_view_construct(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, self = NULL, keys, key;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    bool same = false;
    if (instance == NULL || napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok ||
        napi_get_reference_value(env, instance->keys, &keys) != napi_ok)
        return NULL;
    if (argc < 2 || napi_strict_equals(env, argv[0], keys, &same) != napi_ok || !same) {
        napi_throw_type_error(env, NULL, "a view of an effect is made by the host and given to its handler");
        return NULL;
    }
    if (napi_get_named_property(env, keys, "view", &key) != napi_ok) return NULL;
    napi_property_descriptor property = {NULL, key, NULL, NULL, NULL, argv[1], napi_default, NULL};
    if (napi_define_properties(env, self, 1, &property) != napi_ok) return NULL;
    return self;
}

/* Every field read into its slot, then the view marked a record. */
static bool ta_napi_send_materialize(napi_env env, ta_napi_view *view) {
    for (uint32_t field = 0; field < TA_NAPI_SEND_COUNT; field++)
        if (ta_napi_send_read(env, view, field) == NULL) return false;
    return ta_napi_view_flag(env, view, TA_NAPI_VIEW_RECORD);
}

/* A handler returned a thenable (decision d-async): the view is filled
 * before the ack, and its rejection is followed with the rejection
 * function bound to the view. False with an exception pending (reading
 * `then` threw, a field, or `then` itself). */
static bool ta_napi_send_follow(napi_env env, ta_napi_view *view, napi_value result) {
    napi_value then;
    if (!ta_napi_is(env, result, napi_object) && !ta_napi_is(env, result, napi_function)) return true;
    if (napi_get_named_property(env, result, "then", &then) != napi_ok) return false;
    if (!ta_napi_is(env, then, napi_function)) return true; /* not a thenable: nothing outlives the ack */
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value rejected, bind, bound, argv[2];
    if (instance == NULL || !ta_napi_send_materialize(env, view) ||
        napi_get_reference_value(env, instance->rejected, &rejected) != napi_ok ||
        napi_get_named_property(env, rejected, "bind", &bind) != napi_ok)
        return false;
    argv[0] = ta_napi_undefined(env);
    argv[1] = view->self;
    if (napi_call_function(env, rejected, bind, 2, argv, &bound) != napi_ok) return false;
    argv[1] = bound;
    napi_value chained;
    if (napi_call_function(env, result, then, 2, argv, &chained) != napi_ok) return false;
    ta_napi_follow(env, view->host, chained); /* idle() waits for it */
    return true;
}

static void ta_napi_dispatch_service_send(napi_env env, ta_napi_host *host, uint32_t index);

/* A SEND to an I/O processor (IO_PROCESSOR i + 1 for the config's
 * ioProcessors[i]) or to the transport (0, another system's address): its
 * handler gets the host and a thin view; without a handler the send is
 * failed. A send to an invoked service (TA_NIL) goes to its service, by
 * (segment, token). */
static void ta_napi_dispatch_send(napi_env env, ta_napi_host *host, uint32_t index) {
    uint32_t processor = (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_IO_PROCESSOR);
    if (processor == TA_NIL) {
        ta_napi_dispatch_service_send(env, host, index);
        return;
    }
    if (processor > host->processors) return;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    ta_napi_view view;
    if (instance == NULL || !ta_napi_view_new(env, &(ta_napi_view_spec){host, instance->send, index, processor, TA_NAPI_SEND_COUNT}, &view)) {
        ta_napi_keep_error(env, host);
        return;
    }
    napi_value handler = ta_napi_handler_of(env, view.wrapper, &(ta_napi_handler_at){"processors", processor});
    if (handler == NULL) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_is(env, handler, napi_function)) { /* no handler: a failed completion */
        ta_napi_answer answer = {NULL, ta_napi_undefined(env), NULL, NULL, NULL};
        if (ta_napi_send_reply(env, &view, &answer) == TA_NAPI_REPLY_REFUSED) ta_napi_keep_error(env, host);
        return;
    }
    napi_value argv[2] = {view.wrapper, view.self}, result;
    if (napi_call_function(env, ta_napi_undefined(env), handler, 2, argv, &result) != napi_ok ||
        !ta_napi_send_follow(env, &view, result))
        ta_napi_send_raised(env, &view);
}

/* A LOG: the log handler gets the host and a thin LogEntry; without one
 * the line is discarded. */
static void ta_napi_dispatch_log(napi_env env, ta_napi_host *host, uint32_t index) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value wrapper = ta_napi_self(env, host), handler = NULL, result;
    if (instance == NULL || wrapper == NULL) return;
    handler = ta_napi_handler_of(env, wrapper, &(ta_napi_handler_at){"log", UINT32_MAX});
    if (handler == NULL) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_is(env, handler, napi_function)) return;
    ta_napi_view view;
    if (!ta_napi_view_new(env, &(ta_napi_view_spec){host, instance->entry, index, 0, TA_NAPI_ENTRY_COUNT}, &view)) {
        ta_napi_keep_error(env, host);
        return;
    }
    napi_value argv[2] = {wrapper, view.self};
    if (napi_call_function(env, ta_napi_undefined(env), handler, 2, argv, &result) != napi_ok) ta_napi_keep_error(env, host);
    else ta_napi_follow(env, host, result);
}

/* A MIGRATED: an actor moved; the migrated handler gets the host and a
 * thin Migrated view; without one nothing is read. */
static void ta_napi_dispatch_migrated(napi_env env, ta_napi_host *host, uint32_t index) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value wrapper = ta_napi_self(env, host), handler = NULL, result;
    if (instance == NULL || wrapper == NULL) return;
    handler = ta_napi_handler_of(env, wrapper, &(ta_napi_handler_at){"migrated", UINT32_MAX});
    if (handler == NULL) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_is(env, handler, napi_function)) return;
    ta_napi_view view;
    if (!ta_napi_view_new(env, &(ta_napi_view_spec){host, instance->migrated, index, 0, TA_NAPI_MIGRATED_COUNT}, &view)) {
        ta_napi_keep_error(env, host);
        return;
    }
    napi_value argv[2] = {wrapper, view.self};
    if (napi_call_function(env, ta_napi_undefined(env), handler, 2, argv, &result) != napi_ok) ta_napi_keep_error(env, host);
    else ta_napi_follow(env, host, result);
}

/* The result of a MIGRATION_DONE: {migration, migrated, failed, pending},
 * `failed` the sessions it could not move, each {session, reason} with the
 * status that refused it named by core, and `pending` the sessions it left
 * behind, both read now (ta_host_migration_failed, ta_host_migration_pending:
 * valid until the next run) into the host's arena, under a mark of its own. */
static napi_value ta_napi_migration_result(napi_env env, ta_napi_host *host, uint32_t index) {
    uint32_t id = (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_MIGRATION);
    uint32_t count = (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_PENDING);
    uint32_t failed_count = (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_FAILED);
    napi_value result, number, pending, failed, session, entry, reason;
    if (napi_create_object(env, &result) != napi_ok) return NULL;
    if (napi_create_uint32(env, id, &number) != napi_ok || napi_set_named_property(env, result, "migration", number) != napi_ok ||
        napi_create_uint32(env, (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_MIGRATED), &number) != napi_ok ||
        napi_set_named_property(env, result, "migrated", number) != napi_ok)
        return NULL;
    ta_growable_arena_mark mark = ta_growable_arena_position(&host->arena);
    uint64_t *left = count ? (uint64_t *)ta_growable_arena_alloc(&host->arena, sizeof(uint64_t) * count, 8) : NULL;
    ta_host_migration_failure *failures =
        failed_count ? (ta_host_migration_failure *)ta_growable_arena_alloc(&host->arena, sizeof *failures * failed_count, 8) : NULL;
    bool room = (count == 0 || left != NULL) && (failed_count == 0 || failures != NULL);
    uint32_t got = room && left != NULL ? ta_host_migration_pending(host->host, id, (ta_uint64_array){left, count}) : 0;
    uint32_t lost = room && failures != NULL ? ta_host_migration_failed(host->host, id, (ta_host_migration_failures){failures, failed_count}) : 0;
    if (got > count) got = count;
    if (lost > failed_count) lost = failed_count;
    bool ok = room && napi_create_array_with_length(env, got, &pending) == napi_ok &&
              napi_create_array_with_length(env, lost, &failed) == napi_ok;
    for (uint32_t i = 0; ok && i < got; i++)
        ok = napi_create_bigint_uint64(env, left[i], &session) == napi_ok && napi_set_element(env, pending, i, session) == napi_ok;
    for (uint32_t i = 0; ok && i < lost; i++) {
        const char *name = ta_status_name((ta_status)failures[i].status);
        ok = napi_create_object(env, &entry) == napi_ok &&
             napi_create_bigint_uint64(env, failures[i].session, &session) == napi_ok &&
             napi_set_named_property(env, entry, "session", session) == napi_ok &&
             napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &reason) == napi_ok &&
             napi_set_named_property(env, entry, "reason", reason) == napi_ok && napi_object_freeze(env, entry) == napi_ok &&
             napi_set_element(env, failed, i, entry) == napi_ok;
    }
    ta_napi_arena_release(&host->arena, mark, TA_NAPI_ARENA_UNCAPPED);
    if (!ok) {
        if (!room) ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the migration's failed and pending sessions"});
        return NULL;
    }
    return napi_set_named_property(env, result, "failed", failed) == napi_ok && napi_object_freeze(env, failed) == napi_ok &&
                   napi_set_named_property(env, result, "pending", pending) == napi_ok && napi_object_freeze(env, pending) == napi_ok
               ? result
               : NULL;
}

/* A MIGRATION_DONE: the host's migrationDone handler gets the host and the
 * result; without one nothing is read. */
static void ta_napi_dispatch_migration_done(napi_env env, ta_napi_host *host, uint32_t index) {
    napi_value wrapper = ta_napi_self(env, host), handler = NULL, argv[2], result;
    if (wrapper == NULL) return;
    handler = ta_napi_handler_of(env, wrapper, &(ta_napi_handler_at){"migrationDone", UINT32_MAX});
    if (handler == NULL) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_is(env, handler, napi_function)) return;
    argv[0] = wrapper;
    if ((argv[1] = ta_napi_migration_result(env, host, index)) == NULL ||
        napi_call_function(env, ta_napi_undefined(env), handler, 2, argv, &result) != napi_ok)
        ta_napi_keep_error(env, host);
    else ta_napi_follow(env, host, result);
}

/* A WAKE: a hibernated session has work (an event, a due delayed send:
 * `migration` undefined) or a migration asks for it (`migration` its id);
 * the wake handler gets the host, the session and the migration, and calls
 * host.wake with the blob, now or later. Without one the effect is
 * dropped: the session stays hibernated and its events wait. A promise it
 * returns is followed, so idle() waits for it; its rejection is an
 * unhandled rejection. */
static void ta_napi_dispatch_wake(napi_env env, ta_napi_host *host, uint32_t index) {
    napi_value wrapper = ta_napi_self(env, host), handler = NULL, argv[3], result;
    if (wrapper == NULL) return;
    handler = ta_napi_handler_of(env, wrapper, &(ta_napi_handler_at){"wake", UINT32_MAX});
    if (handler == NULL) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_is(env, handler, napi_function)) return;
    uint64_t migration = ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_MIGRATION); /* 0: none asked */
    argv[0] = wrapper;
    argv[2] = ta_napi_undefined(env);
    if (napi_create_bigint_uint64(env, ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_SESSION), &argv[1]) != napi_ok ||
        (migration != 0 && napi_create_double(env, (double)migration, &argv[2]) != napi_ok) ||
        napi_call_function(env, ta_napi_undefined(env), handler, 3, argv, &result) != napi_ok)
        ta_napi_keep_error(env, host);
    else ta_napi_follow(env, host, result);
}

/* The application's exporter gets the request as a Buffer it keeps (one
 * copy, boundary.md section 7), in a handle scope of its own; posting it,
 * retrying and capping what waits are the application's. Without a handler
 * the request is dropped, so the encoder goes on. In the last take
 * (host->endings set) what the handler returns is kept for
 * [Symbol.asyncDispose] to await. */
void ta_napi_telemetry(napi_env env, ta_napi_host *host, const ta_napi_export *export) {
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) return;
    napi_value wrapper = ta_napi_self(env, host), handler = NULL, argv[3], result;
    if (wrapper != NULL) handler = ta_napi_handler_of(env, wrapper, &(ta_napi_handler_at){"telemetry", UINT32_MAX});
    if (handler == NULL) ta_napi_keep_error(env, host);
    else if (ta_napi_is(env, handler, napi_function)) {
        argv[0] = wrapper;
        if (napi_create_string_utf8(env, export->signal, NAPI_AUTO_LENGTH, &argv[1]) != napi_ok ||
            napi_create_buffer_copy(env, export->data.length, export->data.pointer, NULL, &argv[2]) != napi_ok ||
            napi_call_function(env, ta_napi_undefined(env), handler, 3, argv, &result) != napi_ok)
            ta_napi_keep_error(env, host);
        else if (host->endings == NULL) ta_napi_follow(env, host, result); /* idle() waits for it */
        else if (
                 (ta_napi_is(env, result, napi_object) || ta_napi_is(env, result, napi_function))) {
            uint32_t length = 0; /* a promise, or a thenable: awaited by [Symbol.asyncDispose] */
            if (napi_get_array_length(env, host->endings, &length) != napi_ok ||
                napi_set_element(env, host->endings, length, result) != napi_ok)
                ta_napi_keep_error(env, host);
        }
    }
    napi_close_handle_scope(env, scope);
}

void ta_napi_take(napi_env env, ta_napi_host *host, bool traces) {
    ta_bytes taken; /* the host's view, until the ack */
    ta_status status = traces ? ta_host_traces(host->host, &taken) : ta_host_logs(host->host, &taken);
    uint8_t bit = traces ? 1u : 2u;
    if (status == TA_OK) {
        host->retake &= (uint8_t)~bit;
        if (taken.length) ta_napi_telemetry(env, host, &(ta_napi_export){traces ? "traces" : "logs", taken});
        return;
    }
    if (status == TA_ERROR_NO_MEMORY && !(host->retake & bit)) {
        host->retake |= bit; /* the request stays staged; no other effect comes until a take */
        ta_napi_throw(env, &(ta_napi_refusal){status, traces ? "the take of traces was refused"
                                                             : "the take of logs was refused"});
        ta_napi_keep_error(env, host);
    }
}

/* ---- invoked services: the application runs them ---------------------------------- */

/* An Invocation (translated from tinyactors-cpython/src/effects.c): what its
 * INVOKE said, read once before the ack (the service runs until done or
 * cancelled), and how to answer the invoker. Its state is an array under
 * the instance's `invocation` symbol, as a view's is: the Host's wrapper,
 * core's segment and token, its flags, then its fields. The services that
 * run are kept on the handlers object the wrapper holds, in a Map keyed by
 * core's (segment, token) as one bigint, each entry [invocation, service]:
 * nothing but the wrapper holds them, so they go with it at close (dropped,
 * not stopped) and a service that closes over its host is still collected.
 * No table of invoke ids: core's token is the key. */
enum {
    TA_NAPI_INVOCATION_HOST,
    TA_NAPI_INVOCATION_SEGMENT,
    TA_NAPI_INVOCATION_TOKEN,
    TA_NAPI_INVOCATION_FLAGS,
    TA_NAPI_INVOCATION_SESSION,
    TA_NAPI_INVOCATION_INVOKEID,
    TA_NAPI_INVOCATION_TYPE,
    TA_NAPI_INVOCATION_SRC,
    TA_NAPI_INVOCATION_DATA,
    TA_NAPI_INVOCATION_TRACEPARENT,
    TA_NAPI_INVOCATION_QUEUE, /* while it starts: the records of its sends */
    TA_NAPI_INVOCATION_COUNT
};

/* ended: done, cancelled or failed, answers refused; failed: it never ran
 * (or crashed), so sends to it fail; restored: started again after a
 * restore (TA_EFFECT_FLAG_RESTORED); starting: its handler returned a
 * promise that has not settled, so what comes for it is queued;
 * uninvoked: an UNINVOKE came while it was starting. */
enum {
    TA_NAPI_INVOCATION_ENDED = 1u,
    TA_NAPI_INVOCATION_FAILED = 2u,
    TA_NAPI_INVOCATION_RESTORED = 4u,
    TA_NAPI_INVOCATION_STARTING = 8u,
    TA_NAPI_INVOCATION_UNINVOKED = 16u
};

/* The getters' data: a field's slot, or one of these. */
enum { TA_NAPI_INVOCATION_GET_RESTORED = 100, TA_NAPI_INVOCATION_GET_RUNNING = 101 };

/* The invocation failed (it could not start, or crashed): error.communication
 * for the invoker, and core marks the invocation over, so a restore does not
 * announce it again (system.h, TA_EVENT_IN_ERROR_COMMUNICATION). */
#define TA_NAPI_INVOCATION_FAILURE (TA_EVENT_IN_ERROR_COMMUNICATION | TA_EVENT_IN_FROM_INVOKE)

/* An invocation as C reads it, for one call. */
typedef struct ta_napi_invocation {
    napi_value self, state, wrapper;
    ta_napi_host *host;
    uint32_t segment, token, flags;
} ta_napi_invocation;

/* `self` as an invocation; false with a TypeError when it is none. */
static bool ta_napi_invocation_of(napi_env env, napi_value self, ta_napi_invocation *invocation) {
    napi_value key = ta_napi_key(env, "invocation");
    bool array = false;
    memset(invocation, 0, sizeof *invocation);
    invocation->self = self;
    if (key == NULL) return false;
    if (!ta_napi_is(env, self, napi_object) || napi_get_property(env, self, key, &invocation->state) != napi_ok ||
        napi_is_array(env, invocation->state, &array) != napi_ok || !array ||
        napi_get_element(env, invocation->state, TA_NAPI_INVOCATION_HOST, &invocation->wrapper) != napi_ok ||
        !ta_napi_state_uint32(env, &(ta_napi_slot){invocation->state, TA_NAPI_INVOCATION_SEGMENT, &invocation->segment}) ||
        !ta_napi_state_uint32(env, &(ta_napi_slot){invocation->state, TA_NAPI_INVOCATION_TOKEN, &invocation->token}) ||
        !ta_napi_state_uint32(env, &(ta_napi_slot){invocation->state, TA_NAPI_INVOCATION_FLAGS, &invocation->flags})) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        napi_throw_type_error(env, NULL, "not an Invocation");
        return false;
    }
    invocation->host = ta_napi_host_of(env, &(ta_napi_host_check){invocation->wrapper, false});
    return invocation->host != NULL;
}

/* Sets `flag` in the state, read again first (a nested call may have set
 * another). */
static bool ta_napi_invocation_flag(napi_env env, ta_napi_invocation *invocation, uint32_t flag) {
    napi_value flags;
    if (!ta_napi_state_uint32(env, &(ta_napi_slot){invocation->state, TA_NAPI_INVOCATION_FLAGS, &invocation->flags}))
        return false;
    invocation->flags |= flag;
    return napi_create_uint32(env, invocation->flags, &flags) == napi_ok &&
           napi_set_element(env, invocation->state, TA_NAPI_INVOCATION_FLAGS, flags) == napi_ok;
}

/* Clears `flag` in the state, read again first. */
static bool ta_napi_invocation_unflag(napi_env env, ta_napi_invocation *invocation, uint32_t flag) {
    napi_value flags;
    if (!ta_napi_state_uint32(env, &(ta_napi_slot){invocation->state, TA_NAPI_INVOCATION_FLAGS, &invocation->flags}))
        return false;
    invocation->flags &= ~flag;
    return napi_create_uint32(env, invocation->flags, &flags) == napi_ok &&
           napi_set_element(env, invocation->state, TA_NAPI_INVOCATION_FLAGS, flags) == napi_ok;
}

/* The key of an invocation in the Map: core's (segment, token). */
static napi_value ta_napi_invocation_key(napi_env env, uint32_t segment, uint32_t token) {
    napi_value key = NULL;
    napi_create_bigint_uint64(env, (uint64_t)segment << 32 | token, &key);
    return key;
}

/* A call of the running services' Map on the wrapper's handlers:
 * map[method](key, value?). Undefined once the host closed (no handlers). */
typedef struct ta_napi_services_call {
    const char *method;
    napi_value key, value; /* value NULL: get and delete */
} ta_napi_services_call;

static napi_value ta_napi_services(napi_env env, napi_value wrapper, const ta_napi_services_call *call) {
    napi_value handlers = ta_napi_handlers(env, wrapper), map, method, result = NULL;
    if (handlers == NULL) return NULL;
    if (!ta_napi_is(env, handlers, napi_object)) return ta_napi_undefined(env);
    napi_value argv[2] = {call->key, call->value};
    if (call->key == NULL || napi_get_named_property(env, handlers, "invocations", &map) != napi_ok ||
        napi_get_named_property(env, map, call->method, &method) != napi_ok ||
        napi_call_function(env, map, method, call->value ? 2 : 1, argv, &result) != napi_ok)
        return NULL;
    return result;
}

/* The [invocation, service] kept for (segment, token), or undefined. */
static napi_value ta_napi_invocation_entry(napi_env env, napi_value wrapper, const ta_napi_invocation *of) {
    return ta_napi_services(env, wrapper, &(ta_napi_services_call){"get", ta_napi_invocation_key(env, of->segment, of->token), NULL});
}

/* The entry of effect `index`'s (segment, token) and its invocation read;
 * false when there is none (done, or never kept) or the read failed (the
 * error kept on the host). */
typedef struct ta_napi_effect_entry {
    ta_napi_host *host;
    uint32_t index;
    napi_value entry, service;     /* out */
    ta_napi_invocation invocation; /* out */
} ta_napi_effect_entry;

static bool ta_napi_effect_entry_of(napi_env env, ta_napi_effect_entry *found) {
    ta_napi_host *host = found->host;
    uint32_t index = found->index;
    napi_value wrapper = ta_napi_self(env, host), record;
    ta_napi_invocation of = {NULL, NULL, NULL, host, (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_SEGMENT),
                             (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_TOKEN), 0};
    if (wrapper == NULL) return false;
    found->entry = ta_napi_invocation_entry(env, wrapper, &of);
    if (found->entry == NULL) {
        ta_napi_keep_error(env, host);
        return false;
    }
    if (!ta_napi_is(env, found->entry, napi_object)) return false;
    if (napi_get_element(env, found->entry, 0, &record) != napi_ok ||
        napi_get_element(env, found->entry, 1, &found->service) != napi_ok ||
        !ta_napi_invocation_of(env, record, &found->invocation)) {
        ta_napi_keep_error(env, host);
        return false;
    }
    return true;
}

/* An event from the service to its invoker (TA_EVENT_IN_FROM_INVOKE), its
 * done (TA_EVENT_IN_INVOKE_DONE), or its failure (TA_NAPI_INVOCATION_FAILURE,
 * with the failed send's sendid when there is one). */
typedef struct ta_napi_service_event {
    uint32_t flags;
    napi_value name;        /* NULL: none (done, failure) */
    napi_value data;        /* undefined: none */
    napi_value traceparent; /* NULL: the invocation's; null: a new trace */
    napi_value sendid;      /* NULL: none */
} ta_napi_service_event;

static bool ta_napi_invocation_post(napi_env env, ta_napi_invocation *invocation, const ta_napi_service_event *what) {
    ta_napi_host *host = invocation->host;
    bool failure = (what->flags & TA_EVENT_IN_ERROR_COMMUNICATION) != 0;
    if (!ta_napi_state_uint32(env, &(ta_napi_slot){invocation->state, TA_NAPI_INVOCATION_FLAGS, &invocation->flags}))
        return false;
    if (((invocation->flags & TA_NAPI_INVOCATION_ENDED) && !failure) || host->host == NULL) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STALE, host->host == NULL ? "the Host is closed"
                                                                                 : "the invocation ended: done, cancelled or failed"});
        return false;
    }
    napi_value traceparent = what->traceparent, session;
    if (traceparent == NULL && napi_get_element(env, invocation->state, TA_NAPI_INVOCATION_TRACEPARENT, &traceparent) != napi_ok)
        return false;
    if (napi_get_element(env, invocation->state, TA_NAPI_INVOCATION_SESSION, &session) != napi_ok) return false;
    ta_napi_call call;
    if (!ta_napi_enter(env, invocation->wrapper, &call)) return false;
    ta_event_in event;
    memset(&event, 0, sizeof event);
    event.size = sizeof event;
    event.flags = what->flags;
    event.token = invocation->token;
    bool lossless = false;
    ta_napi_text name_text = {&host->arena, "a service's event is a string", {NULL, 0}};
    ta_napi_text trace_text = {&host->arena, "a traceparent is W3C text, a string, or null for a new trace", {NULL, 0}};
    ta_napi_text sendid_text = {&host->arena, "a sendid is a string", {NULL, 0}};
    bool ok = napi_get_value_bigint_uint64(env, session, &event.session, &lossless) == napi_ok &&
              (what->name == NULL || ta_napi_text_of(env, what->name, &name_text)) &&
              ta_napi_optional_text(env, traceparent, &trace_text) &&
              (what->sendid == NULL || ta_napi_optional_text(env, what->sendid, &sendid_text));
    ta_napi_payload_for payload = {event.session, {0, 0}, what->data, 0};
    if (ok && !failure) ok = ta_napi_host_payload(env, host, &payload);
    if (ok) {
        event.name = name_text.view;
        event.traceparent = trace_text.view;
        event.sendid = sendid_text.view;
        event.data = payload.payload;
        ta_status status = ta_host_send(host->host, &event);
        if (status != TA_OK) {
            ta_napi_host_payload_release(host, payload.payload); /* still ours */
            ta_napi_throw(env, &(ta_napi_refusal){status, what->flags & TA_EVENT_IN_INVOKE_DONE ? "the done was refused"
                                                          : failure                            ? "the failure was refused"
                                                                                               : "the event was refused"});
            ok = false;
        } else ta_napi_schedule(env, host);
    }
    ta_napi_leave(&call);
    return ok;
}

/* The invocation ended (done, cancelled): its entry goes, and with it the
 * host's hold on the service. */
static bool ta_napi_invocation_end(napi_env env, ta_napi_invocation *invocation) {
    if (!ta_napi_invocation_flag(env, invocation, TA_NAPI_INVOCATION_ENDED)) return false;
    return ta_napi_services(env, invocation->wrapper,
                            &(ta_napi_services_call){"delete", ta_napi_invocation_key(env, invocation->segment, invocation->token), NULL}) != NULL;
}

/* The invocation failed (its start, or its service crashed): unless it
 * ended already, it is marked failed, kept without its service (dropped,
 * not stopped) so later sends fail too until the UNINVOKE, and the invoker
 * gets error.communication (with `sendid` when a send failed). The pending
 * exception, if any, stays pending. */
typedef struct ta_napi_invocation_failure {
    napi_value sendid; /* NULL: none */
    bool tell;         /* false: nobody is told (cancelled in the run that started it) */
} ta_napi_invocation_failure;

static void ta_napi_invocation_fail(napi_env env, ta_napi_invocation *invocation, const ta_napi_invocation_failure *failure) {
    napi_value raised = NULL, ignored, entry;
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) napi_get_and_clear_last_exception(env, &raised);
    if (ta_napi_state_uint32(env, &(ta_napi_slot){invocation->state, TA_NAPI_INVOCATION_FLAGS, &invocation->flags}) &&
        !(invocation->flags & TA_NAPI_INVOCATION_ENDED) &&
        ta_napi_invocation_flag(env, invocation, TA_NAPI_INVOCATION_ENDED | TA_NAPI_INVOCATION_FAILED) &&
        napi_create_array_with_length(env, 2, &entry) == napi_ok && napi_set_element(env, entry, 0, invocation->self) == napi_ok &&
        napi_set_element(env, entry, 1, ta_napi_undefined(env)) == napi_ok &&
        ta_napi_services(env, invocation->wrapper,
                         &(ta_napi_services_call){"set", ta_napi_invocation_key(env, invocation->segment, invocation->token), entry}) != NULL &&
        failure->tell) {
        ta_napi_service_event failed = {TA_NAPI_INVOCATION_FAILURE, NULL, ta_napi_undefined(env), NULL, failure->sendid};
        ta_napi_invocation_post(env, invocation, &failed);
    }
    napi_get_and_clear_last_exception(env, &ignored); /* what the failure's post threw is nobody's news */
    if (raised != NULL) napi_throw(env, raised);
}

/* sendBack's and done's options: {traceparent}, `traceparent` NULL when
 * absent (the invocation's trace), null a new trace. */
static bool ta_napi_invocation_options(napi_env env, napi_value options, napi_value *traceparent) {
    napi_value keys, key;
    uint32_t count = 0;
    *traceparent = NULL;
    if (ta_napi_is(env, options, napi_undefined)) return true;
    if (!ta_napi_is(env, options, napi_object) || napi_get_property_names(env, options, &keys) != napi_ok ||
        napi_get_array_length(env, keys, &count) != napi_ok) {
        napi_throw_type_error(env, NULL, "an invocation's options are an object of traceparent");
        return false;
    }
    for (uint32_t i = 0; i < count; i++) {
        char name[16];
        size_t length = 0;
        if (napi_get_element(env, keys, i, &key) != napi_ok ||
            napi_get_value_string_utf8(env, key, name, sizeof name, &length) != napi_ok)
            return false;
        if (length != 11 || memcmp(name, "traceparent", 11) != 0) {
            napi_throw_type_error(env, NULL, "an invocation's options are traceparent only");
            return false;
        }
    }
    napi_value value;
    if (napi_get_named_property(env, options, "traceparent", &value) != napi_ok) return false;
    if (!ta_napi_is(env, value, napi_undefined)) *traceparent = value;
    return true;
}

/* invocation.sendBack(event, data?, {traceparent}?) */
static napi_value ta_napi_invocation_send_back(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {NULL, NULL, NULL}, self = NULL;
    ta_napi_invocation invocation;
    if (napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok || !ta_napi_invocation_of(env, self, &invocation))
        return NULL;
    napi_value undefined = ta_napi_undefined(env), traceparent;
    for (size_t i = argc; i < 3; i++) argv[i] = undefined;
    if (!ta_napi_is(env, argv[0], napi_string)) {
        napi_throw_type_error(env, NULL, "sendBack(event, data?, options?): the event is a string");
        return NULL;
    }
    if (!ta_napi_invocation_options(env, argv[2], &traceparent)) return NULL;
    ta_napi_service_event what = {TA_EVENT_IN_FROM_INVOKE, argv[0], argv[1], traceparent, NULL};
    return ta_napi_invocation_post(env, &invocation, &what) ? undefined : NULL;
}

/* invocation.done(data?, {traceparent}?): done.invoke.<invokeid> for the
 * invoker; the service is dropped. */
static napi_value ta_napi_invocation_done(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, self = NULL;
    ta_napi_invocation invocation;
    if (napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok || !ta_napi_invocation_of(env, self, &invocation))
        return NULL;
    napi_value undefined = ta_napi_undefined(env), traceparent;
    for (size_t i = argc; i < 2; i++) argv[i] = undefined;
    if (!ta_napi_invocation_options(env, argv[1], &traceparent)) return NULL;
    ta_napi_service_event what = {TA_EVENT_IN_INVOKE_DONE, NULL, argv[0], traceparent, NULL};
    if (!ta_napi_invocation_post(env, &invocation, &what)) return NULL;
    return ta_napi_invocation_end(env, &invocation) ? undefined : NULL;
}

/* A getter of an Invocation: a field's slot, restored, or running. */
static napi_value ta_napi_invocation_get(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL, value = NULL;
    void *data = NULL;
    ta_napi_invocation invocation;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, &data) != napi_ok || !ta_napi_invocation_of(env, self, &invocation))
        return NULL;
    uintptr_t which = (uintptr_t)data;
    if (which == TA_NAPI_INVOCATION_GET_RESTORED)
        napi_get_boolean(env, (invocation.flags & TA_NAPI_INVOCATION_RESTORED) != 0, &value);
    else if (which == TA_NAPI_INVOCATION_GET_RUNNING)
        napi_get_boolean(env, !(invocation.flags & TA_NAPI_INVOCATION_ENDED) && invocation.host->host != NULL, &value);
    else
        napi_get_element(env, invocation.state, (uint32_t)which, &value);
    return value;
}

/* The constructor of Invocation: only the drain makes one (it passes the
 * instance's keys, which no export reaches, and the state). */
static napi_value ta_napi_invocation_construct(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, self = NULL, keys, key;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    bool same = false;
    if (instance == NULL || napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok ||
        napi_get_reference_value(env, instance->keys, &keys) != napi_ok)
        return NULL;
    if (argc < 2 || napi_strict_equals(env, argv[0], keys, &same) != napi_ok || !same) {
        napi_throw_type_error(env, NULL, "an Invocation is made by the host and given to its service handler");
        return NULL;
    }
    if (napi_get_named_property(env, keys, "invocation", &key) != napi_ok) return NULL;
    napi_property_descriptor property = {NULL, key, NULL, NULL, NULL, argv[1], napi_default, NULL};
    if (napi_define_properties(env, self, 1, &property) != napi_ok) return NULL;
    return self;
}

/* A text field of the INVOKE as a string shared with the last invocation's
 * when the text is the same (`last[slot]`, on the handlers object), so a
 * population of invocations holds one string of its type, src and
 * invokeid; empty text is undefined when `empty_none`. */
typedef struct ta_napi_shared_text {
    napi_value last;
    uint32_t slot, field;
    bool empty_none;
} ta_napi_shared_text;

static napi_value ta_napi_invocation_text(napi_env env, const ta_napi_view *view, const ta_napi_shared_text *shared) {
    napi_value made = ta_napi_effect_text(env, view, &(ta_napi_text_field){shared->field, shared->empty_none}), before;
    bool same = false;
    if (made == NULL || shared->last == NULL || !ta_napi_is(env, made, napi_string)) return made;
    if (napi_get_element(env, shared->last, shared->slot, &before) == napi_ok && ta_napi_is(env, before, napi_string) &&
        napi_strict_equals(env, made, before, &same) == napi_ok && same)
        return before;
    napi_set_element(env, shared->last, shared->slot, made);
    return made;
}

/* The record of INVOKE `index`, every field read now (it outlives the ack);
 * NULL with an exception pending. */
static napi_value ta_napi_invocation_new(napi_env env, ta_napi_host *host, uint32_t index) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value wrapper = ta_napi_self(env, host), handlers = wrapper ? ta_napi_handlers(env, wrapper) : NULL;
    napi_value state, class, keys, last = NULL, value, argv[2], self;
    ta_napi_view view = {NULL, NULL, wrapper, host, (double)host->acks, index, TA_NIL, 0};
    uint32_t flags = (ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_FLAGS) & TA_EFFECT_FLAG_RESTORED)
                         ? TA_NAPI_INVOCATION_RESTORED
                         : 0;
    if (instance == NULL || handlers == NULL || napi_get_named_property(env, handlers, "last", &last) != napi_ok ||
        napi_create_array_with_length(env, TA_NAPI_INVOCATION_COUNT, &state) != napi_ok ||
        napi_set_element(env, state, TA_NAPI_INVOCATION_HOST, wrapper) != napi_ok)
        return NULL;
    const uint32_t numbers[] = {(uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_SEGMENT),
                                (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_TOKEN), flags};
    for (uint32_t i = 0; i < 3; i++)
        if (napi_create_uint32(env, numbers[i], &value) != napi_ok ||
            napi_set_element(env, state, TA_NAPI_INVOCATION_SEGMENT + i, value) != napi_ok)
            return NULL;
    napi_value fields[] = {
        ta_napi_effect_session(env, &view),
        ta_napi_invocation_text(env, &view, &(ta_napi_shared_text){last, 0, TA_EFFECT_FIELD_SENDID, false}),
        ta_napi_invocation_text(env, &view, &(ta_napi_shared_text){last, 1, TA_EFFECT_FIELD_EVENT, false}),
        ta_napi_invocation_text(env, &view, &(ta_napi_shared_text){last, 2, TA_EFFECT_FIELD_TARGET, false}),
        NULL,
        ta_napi_effect_text(env, &view, &(ta_napi_text_field){TA_EFFECT_FIELD_TRACEPARENT, true}),
    };
    fields[4] = ta_napi_effect_data(env, &view);
    for (uint32_t i = 0; i < sizeof fields / sizeof fields[0]; i++)
        if (fields[i] == NULL || napi_set_element(env, state, TA_NAPI_INVOCATION_SESSION + i, fields[i]) != napi_ok) return NULL;
    if (napi_get_reference_value(env, instance->invocation, &class) != napi_ok ||
        napi_get_reference_value(env, instance->keys, &keys) != napi_ok)
        return NULL;
    argv[0] = keys;
    argv[1] = state;
    return napi_new_instance(env, class, 2, argv, &self) == napi_ok ? self : NULL;
}

/* An UNINVOKE of the same (segment, token) later in the open batch: the
 * invoker cancelled it in the run that started it, so a failure to start
 * is nobody's news. */
static bool ta_napi_uninvoked_in_batch(const ta_napi_batch *batch, uint32_t index) {
    ta_host *core = batch->state->host->host;
    uint64_t segment = ta_host_effect_number(core, index, TA_EFFECT_FIELD_SEGMENT);
    uint64_t token = ta_host_effect_number(core, index, TA_EFFECT_FIELD_TOKEN);
    for (uint32_t i = index + 1; i < batch->count; i++)
        if (batch->effects[i].kind == TA_EFFECT_UNINVOKE && ta_host_effect_number(core, i, TA_EFFECT_FIELD_SEGMENT) == segment &&
            ta_host_effect_number(core, i, TA_EFFECT_FIELD_TOKEN) == token)
            return true;
    return false;
}

/* `value` is a thenable: an object or function whose `then` is a function.
 * False with an exception pending when reading `then` threw. */
static bool ta_napi_thenable(napi_env env, napi_value value, bool *thenable) {
    napi_value then;
    *thenable = false;
    if (!ta_napi_is(env, value, napi_object) && !ta_napi_is(env, value, napi_function)) return true;
    if (napi_get_named_property(env, value, "then", &then) != napi_ok) return false;
    *thenable = ta_napi_is(env, then, napi_function);
    return true;
}

/* Appends `item` to the queue of an invocation that is starting. */
static bool ta_napi_invocation_queue(napi_env env, const ta_napi_invocation *invocation, napi_value item) {
    napi_value queue;
    uint32_t length = 0;
    return napi_get_element(env, invocation->state, TA_NAPI_INVOCATION_QUEUE, &queue) == napi_ok &&
           napi_get_array_length(env, queue, &length) == napi_ok && napi_set_element(env, queue, length, item) == napi_ok;
}

/* A service handler returned a thenable: the invocation is starting until
 * it settles. Its entry is kept with no service, so the sends and an
 * UNINVOKE that come meanwhile find it and are queued (records made before
 * their ack), and the thenable is followed with `started` and
 * `start_failed` bound to the record. False with an exception pending. */
static bool ta_napi_invocation_start(napi_env env, ta_napi_invocation *invocation, napi_value thenable) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value queue, entry, then, bind, functions[2], bound[2], argv[2];
    napi_ref refs[2];
    if (instance == NULL || napi_create_array(env, &queue) != napi_ok ||
        napi_set_element(env, invocation->state, TA_NAPI_INVOCATION_QUEUE, queue) != napi_ok ||
        !ta_napi_invocation_flag(env, invocation, TA_NAPI_INVOCATION_STARTING))
        return false;
    refs[0] = instance->started;
    refs[1] = instance->start_failed;
    for (int i = 0; i < 2; i++) {
        argv[0] = ta_napi_undefined(env);
        argv[1] = invocation->self;
        if (napi_get_reference_value(env, refs[i], &functions[i]) != napi_ok ||
            napi_get_named_property(env, functions[i], "bind", &bind) != napi_ok ||
            napi_call_function(env, functions[i], bind, 2, argv, &bound[i]) != napi_ok)
            return false;
    }
    napi_value chained;
    if (napi_get_named_property(env, thenable, "then", &then) != napi_ok ||
        napi_call_function(env, thenable, then, 2, bound, &chained) != napi_ok)
        return false;
    ta_napi_follow(env, invocation->host, chained); /* idle() waits for the start */
    if (invocation->flags & TA_NAPI_INVOCATION_ENDED) return true; /* done() in the handler: nothing to keep */
    return napi_create_array_with_length(env, 2, &entry) == napi_ok && napi_set_element(env, entry, 0, invocation->self) == napi_ok &&
           napi_set_element(env, entry, 1, ta_napi_undefined(env)) == napi_ok &&
           ta_napi_services(env, invocation->wrapper,
                            &(ta_napi_services_call){"set", ta_napi_invocation_key(env, invocation->segment, invocation->token), entry}) != NULL;
}

/* TA_EFFECT_INVOKE: the handler registered for the type starts the
 * service; what it returns is kept, by (segment, token), until done or
 * UNINVOKE. A promise of the service (an async handler) makes the
 * invocation starting until it settles (ta_napi_invocation_start). No
 * handler, or one that throws: error.communication for the invoker
 * (unless it cancelled it already in this batch) and the entry kept as
 * failed; a handler's error is reported after the turn, while a type with
 * no handler throws nothing: a chart (an untrusted one on quickjs) picks
 * the type, and the application's process is not its to end. */
static void ta_napi_dispatch_invoke(napi_env env, const ta_napi_batch *batch, uint32_t index) {
    ta_napi_host *host = batch->state->host;
    napi_value wrapper = ta_napi_self(env, host), handlers = wrapper ? ta_napi_handlers(env, wrapper) : NULL;
    if (handlers == NULL || !ta_napi_is(env, handlers, napi_object)) return;
    napi_value record = ta_napi_invocation_new(env, host, index), services, type, handler = NULL, result = NULL, entry;
    ta_napi_invocation invocation;
    if (record == NULL || !ta_napi_invocation_of(env, record, &invocation)) {
        ta_napi_keep_error(env, host);
        return;
    }
    bool own = false, thenable = false, started = false;
    if (napi_get_named_property(env, handlers, "services", &services) != napi_ok ||
        napi_get_element(env, invocation.state, TA_NAPI_INVOCATION_TYPE, &type) != napi_ok ||
        (ta_napi_is(env, services, napi_object) &&
         (napi_has_own_property(env, services, type, &own) != napi_ok ||
          (own && napi_get_property(env, services, type, &handler) != napi_ok)))) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (handler != NULL && ta_napi_is(env, handler, napi_function)) {
        napi_value argv[2] = {wrapper, record};
        started = napi_call_function(env, ta_napi_undefined(env), handler, 2, argv, &result) == napi_ok &&
                  ta_napi_thenable(env, result, &thenable);
        if (started && thenable) {
            if (ta_napi_invocation_start(env, &invocation, result)) return;
            started = false;
        }
    }
    if (!started) { /* it does not run: kept as failed, so sends to it fail too, until the UNINVOKE */
        ta_napi_invocation_fail(env, &invocation, &(ta_napi_invocation_failure){NULL, !ta_napi_uninvoked_in_batch(batch, index)});
        bool pending = false;
        if (napi_is_exception_pending(env, &pending) == napi_ok && pending) ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_state_uint32(env, &(ta_napi_slot){invocation.state, TA_NAPI_INVOCATION_FLAGS, &invocation.flags})) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (invocation.flags & TA_NAPI_INVOCATION_ENDED) return; /* the handler called done(): nothing to keep */
    if (napi_create_array_with_length(env, 2, &entry) != napi_ok || napi_set_element(env, entry, 0, record) != napi_ok ||
        napi_set_element(env, entry, 1, result) != napi_ok ||
        ta_napi_services(env, wrapper, &(ta_napi_services_call){"set", ta_napi_invocation_key(env, invocation.segment, invocation.token), entry}) == NULL)
        ta_napi_keep_error(env, host);
}

/* A service's receive promise rejected (bound to its invocation and its
 * send, a record): the service crashed, unless it ended meanwhile; the
 * rejection goes on, so the promise `then` made rejects unhandled and the
 * runtime reports it (decision d-errors). */
static napi_value ta_napi_service_crashed(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {NULL, NULL, NULL}, ignored;
    ta_napi_invocation invocation;
    ta_napi_view view;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return NULL;
    if (argc < 3) argv[2] = ta_napi_undefined(env);
    if (ta_napi_invocation_of(env, argv[0], &invocation) && ta_napi_view_of(env, argv[1], &view)) {
        napi_value sendid = ta_napi_send_read(env, &view, TA_NAPI_SEND_SENDID);
        if (sendid != NULL) ta_napi_invocation_fail(env, &invocation, &(ta_napi_invocation_failure){sendid, true});
    }
    napi_get_and_clear_last_exception(env, &ignored);
    napi_throw(env, argv[2]);
    return NULL;
}

/* A send for a running service's receive: called on the service with
 * `view` (a thin view in the drain, or a record queued while it started).
 * A receive that returns a promise has its view filled now, before the
 * ack, and a rejection is a crash. False with the error pending when it
 * threw: the service crashed (the invoker gets error.communication with
 * the send's sendid). */
typedef struct ta_napi_delivery {
    ta_napi_invocation *invocation;
    napi_value service, receive;
    ta_napi_view *view;
} ta_napi_delivery;

static bool ta_napi_service_receive(napi_env env, const ta_napi_delivery *delivery) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    ta_napi_view *view = delivery->view;
    napi_value argv[2] = {view->wrapper, view->self}, result;
    bool thenable = false;
    bool ok = instance != NULL && napi_call_function(env, delivery->service, delivery->receive, 2, argv, &result) == napi_ok &&
              ta_napi_thenable(env, result, &thenable);
    if (ok && thenable) { /* filled before the ack; a rejection is a crash */
        napi_value crashed, bind, bound = NULL, then, args[3];
        ok = ta_napi_send_materialize(env, view) && napi_get_reference_value(env, instance->crashed, &crashed) == napi_ok &&
             napi_get_named_property(env, crashed, "bind", &bind) == napi_ok;
        args[0] = ta_napi_undefined(env);
        args[1] = delivery->invocation->self;
        args[2] = view->self;
        ok = ok && napi_call_function(env, crashed, bind, 3, args, &bound) == napi_ok &&
             napi_get_named_property(env, result, "then", &then) == napi_ok;
        args[1] = bound;
        napi_value chained = NULL;
        ok = ok && napi_call_function(env, result, then, 2, args, &chained) == napi_ok;
        if (ok) ta_napi_follow(env, delivery->invocation->host, chained); /* idle() waits for it */
    }
    if (!ok) {
        napi_value raised = NULL, ignored;
        if (napi_get_and_clear_last_exception(env, &raised) != napi_ok) raised = NULL;
        napi_value sendid = ta_napi_send_read(env, view, TA_NAPI_SEND_SENDID);
        if (sendid == NULL) napi_get_and_clear_last_exception(env, &ignored);
        ta_napi_invocation_fail(env, delivery->invocation, &(ta_napi_invocation_failure){sendid, true});
        if (raised != NULL) napi_throw(env, raised);
    }
    return ok;
}

/* A method of a service (receive, stop), or NULL when it has none (an
 * object without one, a value that is no object) or reading it threw (the
 * error pending, `threw` set). */
typedef struct ta_napi_method {
    napi_value service;
    const char *name;
    bool threw; /* out */
} ta_napi_method;

static napi_value ta_napi_service_method(napi_env env, ta_napi_method *of) {
    napi_value method = NULL;
    of->threw = false;
    if (!ta_napi_is(env, of->service, napi_object) && !ta_napi_is(env, of->service, napi_function)) return NULL;
    if (napi_get_named_property(env, of->service, of->name, &method) != napi_ok) {
        of->threw = true;
        return NULL;
    }
    return ta_napi_is(env, method, napi_function) ? method : NULL;
}

/* A send to an invoked service (IO_PROCESSOR TA_NIL): its service's
 * receive(host, send), called on the service, with the send as a thin
 * view; a service without receive, or none (done): dropped; one that
 * failed to start or crashed: the send fails with error.communication; a
 * receive that throws: the service crashed. A receive that returns a
 * promise has its view filled before the ack, and a rejection is a crash.
 * A service that is starting gets the send as a record, queued for it. */
static void ta_napi_dispatch_service_send(napi_env env, ta_napi_host *host, uint32_t index) {
    ta_napi_effect_entry found = {host, index, NULL, NULL, {NULL, NULL, NULL, NULL, 0, 0, 0}};
    if (!ta_napi_effect_entry_of(env, &found)) return;
    if (found.invocation.flags & TA_NAPI_INVOCATION_FAILED) { /* a service that never ran: the send fails, as core's do */
        napi_value sendid = ta_napi_effect_text(env, &(ta_napi_view){NULL, NULL, found.invocation.wrapper, host, (double)host->acks, index, TA_NIL, 0},
                                                &(ta_napi_text_field){TA_EFFECT_FIELD_SENDID, true});
        ta_napi_service_event failed = {TA_NAPI_INVOCATION_FAILURE, NULL, ta_napi_undefined(env), NULL, sendid};
        if (sendid == NULL || !ta_napi_invocation_post(env, &found.invocation, &failed)) ta_napi_keep_error(env, host);
        return;
    }
    bool starting = (found.invocation.flags & TA_NAPI_INVOCATION_STARTING) != 0;
    ta_napi_method of = {found.service, "receive", false};
    napi_value receive = starting ? NULL : ta_napi_service_method(env, &of);
    if (of.threw) ta_napi_keep_error(env, host);
    if (!starting && receive == NULL) return;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    ta_napi_view view;
    if (instance == NULL || !ta_napi_view_new(env, &(ta_napi_view_spec){host, instance->send, index, TA_NIL, TA_NAPI_SEND_COUNT}, &view)) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (starting) { /* a record now, for the service once it started */
        if (!ta_napi_send_materialize(env, &view) || !ta_napi_invocation_queue(env, &found.invocation, view.self))
            ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_service_receive(env, &(ta_napi_delivery){&found.invocation, found.service, receive, &view}))
        ta_napi_keep_error(env, host);
}

/* TA_EFFECT_UNINVOKE: the invoker cancelled it (it left the state, or
 * ended); its entry goes, then the service's stop(host), called on the
 * service; none for one that failed or crashed. One that is starting is
 * marked uninvoked: it is stopped once it resolves. */
static void ta_napi_dispatch_uninvoke(napi_env env, ta_napi_host *host, uint32_t index) {
    ta_napi_effect_entry found = {host, index, NULL, NULL, {NULL, NULL, NULL, NULL, 0, 0, 0}};
    if (!ta_napi_effect_entry_of(env, &found)) return; /* done already, or never kept */
    bool failed = (found.invocation.flags & TA_NAPI_INVOCATION_FAILED) != 0;
    bool starting = (found.invocation.flags & TA_NAPI_INVOCATION_STARTING) != 0;
    napi_value result;
    if (starting && !ta_napi_invocation_flag(env, &found.invocation, TA_NAPI_INVOCATION_UNINVOKED)) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (!ta_napi_invocation_end(env, &found.invocation)) {
        ta_napi_keep_error(env, host);
        return;
    }
    if (failed || starting) return;
    ta_napi_method of = {found.service, "stop", false};
    napi_value stop = ta_napi_service_method(env, &of), argv[1] = {found.invocation.wrapper};
    if (of.threw || (stop != NULL && napi_call_function(env, found.service, stop, 1, argv, &result) != napi_ok))
        ta_napi_keep_error(env, host);
}

/* The queue of a starting invocation taken out of its state; NULL with an
 * exception pending. */
static napi_value ta_napi_invocation_settle(napi_env env, ta_napi_invocation *invocation) {
    napi_value queue;
    if (napi_get_element(env, invocation->state, TA_NAPI_INVOCATION_QUEUE, &queue) != napi_ok ||
        napi_set_element(env, invocation->state, TA_NAPI_INVOCATION_QUEUE, ta_napi_undefined(env)) != napi_ok ||
        !ta_napi_invocation_unflag(env, invocation, TA_NAPI_INVOCATION_STARTING))
        return NULL;
    return queue;
}

/* A service handler's promise resolved with the service (bound to its
 * invocation; between turns, never inside a run). Cancelled meanwhile
 * (an UNINVOKE): its stop(host), and the sends queued for it are dropped,
 * since the invoker has gone and nothing could answer them. Done in its
 * start: nothing kept, the sends dropped, as a done service's are. Else
 * the service is kept and the queued sends given to its receive in order;
 * a receive that throws is a crash, and the first error is thrown on, so
 * the promise `then` made rejects unhandled and the runtime reports it.
 * After close nothing is given: the service is dropped, not stopped. */
static napi_value ta_napi_service_started(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, queue, entry, item, raised = NULL, result;
    ta_napi_invocation invocation;
    uint32_t length = 0;
    bool threw = false;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return NULL;
    if (argc < 2) argv[1] = ta_napi_undefined(env);
    if (!ta_napi_invocation_of(env, argv[0], &invocation) || (queue = ta_napi_invocation_settle(env, &invocation)) == NULL)
        return NULL;
    if (invocation.host->host == NULL) return ta_napi_undefined(env); /* closed: dropped, not started */
    napi_value service = argv[1], args[1] = {invocation.wrapper};
    if (invocation.flags & TA_NAPI_INVOCATION_UNINVOKED) { /* cancelled while it started: stopped now */
        ta_napi_method of = {service, "stop", false};
        napi_value stop = ta_napi_service_method(env, &of);
        if (!of.threw && stop != NULL) napi_call_function(env, service, stop, 1, args, &result);
        return NULL; /* undefined, or what stop threw, thrown on */
    }
    if (invocation.flags & TA_NAPI_INVOCATION_ENDED) return ta_napi_undefined(env); /* done in its start */
    if (napi_create_array_with_length(env, 2, &entry) != napi_ok || napi_set_element(env, entry, 0, invocation.self) != napi_ok ||
        napi_set_element(env, entry, 1, service) != napi_ok ||
        ta_napi_services(env, invocation.wrapper,
                         &(ta_napi_services_call){"set", ta_napi_invocation_key(env, invocation.segment, invocation.token), entry}) == NULL ||
        napi_get_array_length(env, queue, &length) != napi_ok)
        return NULL;
    for (uint32_t i = 0; i < length && invocation.host->host != NULL; i++) {
        ta_napi_view view;
        threw = false;
        if (napi_get_element(env, queue, i, &item) != napi_ok || !ta_napi_view_of(env, item, &view) ||
            !ta_napi_state_uint32(env, &(ta_napi_slot){invocation.state, TA_NAPI_INVOCATION_FLAGS, &invocation.flags}))
            return NULL;
        if (invocation.flags & TA_NAPI_INVOCATION_FAILED) { /* crashed on an earlier send: this one fails, as core's do */
            napi_value sendid = ta_napi_send_read(env, &view, TA_NAPI_SEND_SENDID);
            ta_napi_service_event failure = {TA_NAPI_INVOCATION_FAILURE, NULL, ta_napi_undefined(env), NULL, sendid};
            threw = sendid == NULL || !ta_napi_invocation_post(env, &invocation, &failure);
        } else if (!(invocation.flags & TA_NAPI_INVOCATION_ENDED)) { /* done by an earlier receive: dropped */
            ta_napi_method of = {service, "receive", false};
            napi_value receive = ta_napi_service_method(env, &of);
            threw = of.threw;
            if (!threw && receive != NULL)
                threw = !ta_napi_service_receive(env, &(ta_napi_delivery){&invocation, service, receive, &view});
        }
        napi_value error = NULL;
        if (threw && napi_get_and_clear_last_exception(env, &error) == napi_ok && raised == NULL) raised = error;
    }
    if (raised != NULL) napi_throw(env, raised);
    return raised != NULL ? NULL : ta_napi_undefined(env);
}

/* A service handler's promise rejected (bound to its invocation): a failed
 * start, unless it ended meanwhile (done, or cancelled: nobody is told).
 * The invoker gets error.communication, then each send queued for it with
 * its sendid, and the entry stays failed until the UNINVOKE. The rejection
 * goes on, an unhandled rejection the runtime reports. */
static napi_value ta_napi_service_start_failed(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, queue, item, ignored;
    ta_napi_invocation invocation;
    uint32_t length = 0;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return NULL;
    if (argc < 2) argv[1] = ta_napi_undefined(env);
    if (ta_napi_invocation_of(env, argv[0], &invocation) && (queue = ta_napi_invocation_settle(env, &invocation)) != NULL &&
        invocation.host->host != NULL && !(invocation.flags & TA_NAPI_INVOCATION_ENDED)) {
        ta_napi_invocation_fail(env, &invocation, &(ta_napi_invocation_failure){NULL, true});
        napi_get_and_clear_last_exception(env, &ignored);
        if (napi_get_array_length(env, queue, &length) != napi_ok) length = 0;
        for (uint32_t i = 0; i < length && invocation.host->host != NULL; i++) {
            ta_napi_view view;
            napi_value sendid = NULL;
            if (napi_get_element(env, queue, i, &item) == napi_ok && ta_napi_view_of(env, item, &view) && (sendid = ta_napi_send_read(env, &view, TA_NAPI_SEND_SENDID)) != NULL) {
                ta_napi_service_event failure = {TA_NAPI_INVOCATION_FAILURE, NULL, ta_napi_undefined(env), NULL, sendid};
                ta_napi_invocation_post(env, &invocation, &failure);
            }
            napi_get_and_clear_last_exception(env, &ignored); /* a failure core refuses is nobody's news */
        }
    }
    napi_get_and_clear_last_exception(env, &ignored);
    napi_throw(env, argv[1]);
    return NULL;
}

void ta_napi_dispatch(napi_env env, const ta_napi_batch *batch, uint32_t index) {
    ta_napi_drain_state *state = batch->state;
    ta_napi_host *host = state->host;
    napi_escapable_handle_scope scope;
    if (napi_open_escapable_handle_scope(env, &scope) != napi_ok) return; /* one per effect: a turn is one native call */
    switch (batch->effects[index].kind) {
    case TA_EFFECT_SEND: ta_napi_dispatch_send(env, host, index); break;
    case TA_EFFECT_LOG: ta_napi_dispatch_log(env, host, index); break;
    case TA_EFFECT_WAKE: ta_napi_dispatch_wake(env, host, index); break;
    case TA_HOST_EFFECT_MIGRATED: ta_napi_dispatch_migrated(env, host, index); break;
    case TA_HOST_EFFECT_MIGRATION_DONE: ta_napi_dispatch_migration_done(env, host, index); break;
    case TA_EFFECT_INVOKE: ta_napi_dispatch_invoke(env, batch, index); break;
    case TA_EFFECT_UNINVOKE: ta_napi_dispatch_uninvoke(env, host, index); break;
    case TA_EFFECT_REQUEST: {
        /* a fetch at run time: refused in C until it is built (AGENTS.md,
         * "Layers and the resolver"); the requester gets error.execution */
        ta_resume resume = {(uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_SEGMENT),
                            (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_TOKEN), TA_ERROR_INVALID, 0, 0};
        ta_host_resume(host->host, &resume);
        ta_napi_schedule(env, host); /* an input: the turn runs it */
        break;
    }
    case TA_HOST_EFFECT_REPLY: { /* a typed method's, handled there; the creation's host.config kept */
        napi_value reply = ta_napi_reply(env, host, index);
        if (reply != NULL && napi_escape_handle(env, scope, reply, &state->reply) != napi_ok) state->reply = NULL;
        break;
    }
    case TA_HOST_EFFECT_TRACES: ta_napi_take(env, host, true); break;
    case TA_HOST_EFFECT_LOGS: ta_napi_take(env, host, false); break;
    default: /* DONE, ERROR: no application callback; SEGMENT_FREED: dropped, the host keeps the
                images, the addon none; a NOTIFICATION it does not know (none is defined); the
                rest has no API yet */
        break;
    }
    napi_close_escapable_handle_scope(env, scope);
}

napi_status ta_napi_effects_define(napi_env env, napi_value exports) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    (void)exports;
    if (instance == NULL) return napi_pending_exception;
    napi_property_attributes getter = napi_configurable; /* as a class's accessor: not enumerable */
    napi_property_descriptor send[] = {
        {"session", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_SESSION)},
        {"event", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_EVENT)},
        {"target", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_TARGET)},
        {"sendid", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_SENDID)},
        {"data", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_DATA)},
        {"type", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_TYPE)},
        {"origin", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_ORIGIN)},
        {"traceparent", NULL, NULL, ta_napi_view_get, NULL, NULL, getter,
         TA_NAPI_GETTER(TA_NAPI_KIND_SEND, TA_NAPI_SEND_TRACEPARENT)},
        {"message", NULL, NULL, ta_napi_send_message, NULL, NULL, getter, NULL},
        {"answer", NULL, ta_napi_send_answer, NULL, NULL, NULL, napi_default_method, NULL},
        {"fail", NULL, ta_napi_send_fail, NULL, NULL, NULL, napi_default_method, NULL},
    };
    napi_property_descriptor entry[] = {
        {"session", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_ENTRY, TA_NAPI_ENTRY_SESSION)},
        {"label", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_ENTRY, TA_NAPI_ENTRY_LABEL)},
        {"text", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_ENTRY, TA_NAPI_ENTRY_TEXT)},
    };
    napi_property_descriptor migrated[] = {
        {"session", NULL, NULL, ta_napi_view_get, NULL, NULL, getter,
         TA_NAPI_GETTER(TA_NAPI_KIND_MIGRATED, TA_NAPI_MIGRATED_SESSION)},
        {"segment", NULL, NULL, ta_napi_view_get, NULL, NULL, getter,
         TA_NAPI_GETTER(TA_NAPI_KIND_MIGRATED, TA_NAPI_MIGRATED_SEGMENT)},
        {"chart", NULL, NULL, ta_napi_view_get, NULL, NULL, getter, TA_NAPI_GETTER(TA_NAPI_KIND_MIGRATED, TA_NAPI_MIGRATED_CHART)},
        {"migration", NULL, NULL, ta_napi_view_get, NULL, NULL, getter,
         TA_NAPI_GETTER(TA_NAPI_KIND_MIGRATED, TA_NAPI_MIGRATED_MIGRATION)},
    };
    napi_property_descriptor invocation[] = {
        {"session", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_SESSION},
        {"invokeid", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_INVOKEID},
        {"type", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_TYPE},
        {"src", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_SRC},
        {"data", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_DATA},
        {"traceparent", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_TRACEPARENT},
        {"restored", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_GET_RESTORED},
        {"running", NULL, NULL, ta_napi_invocation_get, NULL, NULL, getter, (void *)(uintptr_t)TA_NAPI_INVOCATION_GET_RUNNING},
        {"sendBack", NULL, ta_napi_invocation_send_back, NULL, NULL, NULL, napi_default_method, NULL},
        {"done", NULL, ta_napi_invocation_done, NULL, NULL, NULL, napi_default_method, NULL},
    };
    napi_value send_class, entry_class, migrated_class, invocation_class, rejected, crashed, started, start_failed, keys,
        description, symbol;
    napi_status status = napi_define_class(env, "Send", NAPI_AUTO_LENGTH, ta_napi_view_construct, NULL,
                                           sizeof send / sizeof send[0], send, &send_class);
    if (status == napi_ok) status = napi_create_reference(env, send_class, 1, &instance->send);
    napi_value prototype;
    if (status == napi_ok) status = napi_get_named_property(env, send_class, "prototype", &prototype);
    if (status == napi_ok) status = ta_napi_arities(env, prototype, (const ta_napi_arity[]){{"answer", 3}, {NULL, 0}});
    if (status == napi_ok)
        status = napi_define_class(env, "LogEntry", NAPI_AUTO_LENGTH, ta_napi_view_construct, NULL,
                                   sizeof entry / sizeof entry[0], entry, &entry_class);
    if (status == napi_ok) status = napi_create_reference(env, entry_class, 1, &instance->entry);
    if (status == napi_ok)
        status = napi_define_class(env, "Migrated", NAPI_AUTO_LENGTH, ta_napi_view_construct, NULL,
                                   sizeof migrated / sizeof migrated[0], migrated, &migrated_class);
    if (status == napi_ok) status = napi_create_reference(env, migrated_class, 1, &instance->migrated);
    if (status == napi_ok)
        status = napi_create_function(env, "rejected", NAPI_AUTO_LENGTH, ta_napi_send_rejected, NULL, &rejected);
    if (status == napi_ok) status = napi_create_reference(env, rejected, 1, &instance->rejected);
    if (status == napi_ok)
        status = napi_define_class(env, "Invocation", NAPI_AUTO_LENGTH, ta_napi_invocation_construct, NULL,
                                   sizeof invocation / sizeof invocation[0], invocation, &invocation_class);
    if (status == napi_ok) status = napi_create_reference(env, invocation_class, 1, &instance->invocation);
    if (status == napi_ok) status = napi_get_named_property(env, invocation_class, "prototype", &prototype);
    if (status == napi_ok)
        status = ta_napi_arities(env, prototype, (const ta_napi_arity[]){{"sendBack", 3}, {"done", 2}, {NULL, 0}});
    if (status == napi_ok)
        status = napi_create_function(env, "crashed", NAPI_AUTO_LENGTH, ta_napi_service_crashed, NULL, &crashed);
    if (status == napi_ok) status = napi_create_reference(env, crashed, 1, &instance->crashed);
    if (status == napi_ok)
        status = napi_create_function(env, "started", NAPI_AUTO_LENGTH, ta_napi_service_started, NULL, &started);
    if (status == napi_ok) status = napi_create_reference(env, started, 1, &instance->started);
    if (status == napi_ok)
        status = napi_create_function(env, "startFailed", NAPI_AUTO_LENGTH, ta_napi_service_start_failed, NULL, &start_failed);
    if (status == napi_ok) status = napi_create_reference(env, start_failed, 1, &instance->start_failed);
    if (status == napi_ok) status = napi_get_reference_value(env, instance->keys, &keys);
    if (status == napi_ok) status = napi_create_string_utf8(env, "tinyactors.view", NAPI_AUTO_LENGTH, &description);
    if (status == napi_ok) status = napi_create_symbol(env, description, &symbol);
    if (status == napi_ok) status = napi_set_named_property(env, keys, "view", symbol);
    if (status == napi_ok) status = napi_create_string_utf8(env, "tinyactors.invocation", NAPI_AUTO_LENGTH, &description);
    if (status == napi_ok) status = napi_create_symbol(env, description, &symbol);
    if (status == napi_ok) status = napi_set_named_property(env, keys, "invocation", symbol);
    return status;
}
