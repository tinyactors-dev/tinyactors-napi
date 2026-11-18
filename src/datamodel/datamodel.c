/* The native "ecmascript" datamodel's vtable (tinyactors/datamodel.h;
 * AGENTS.md, "The native "ecmascript" datamodel"; structured as
 * tinyactors-cpython/src/datamodel/datamodel.c, sharing no code or text with
 * quickjs's datamodel). A chart is a row holding its record (datamodel.h);
 * a session a row whose scope, a scope made by its chart's constructor in
 * the shared context or, for a chart whose scripts declare, the record of
 * a context of its own, is the element at the row's slot of the host's
 * one `scopes` array (rows.c). Every entry opens a handle
 * scope of its own (a run is one native call: handles would pile up until
 * it returns); an expression that throws is TA_ERROR_EXECUTION. Values
 * cross by copy, made with the receiving context's constructors (the
 * kit's `copy`); `_event` is a frozen object kept from bind_event to the
 * next one or destroy, its data the payload row's value itself in the
 * shared context. */
#include "datamodel.h"

#include <string.h>

/* ---- an entry ----------------------------------------------------------------- */

/* An entry's frame: its handle scope, and the evaluating datamodel In()
 * reads (restored at the end, for an entry inside another). */
typedef struct ta_napi_frame {
    ta_napi_native *native;
    napi_handle_scope scope;
    ta_napi_native *evaluating;
    ta_datamodel_environment *environment;
} ta_napi_frame;

static bool ta_napi_frame_open(ta_napi_native *native, ta_datamodel_environment *environment, ta_napi_frame *frame) {
    ta_napi_instance *instance = ta_napi_instance_of(native->host->env);
    frame->native = native;
    if (instance == NULL || napi_open_handle_scope(native->host->env, &frame->scope) != napi_ok) {
        napi_value ignored;
        napi_get_and_clear_last_exception(native->host->env, &ignored);
        return false;
    }
    frame->evaluating = instance->evaluating;
    frame->environment = native->environment;
    instance->failed = false; /* a new entry: the last one's failure is forgotten */
    instance->evaluating = native;
    native->environment = environment;
    return true;
}

static void ta_napi_frame_close(ta_napi_frame *frame) {
    napi_env env = frame->native->host->env;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance != NULL) instance->evaluating = frame->evaluating;
    frame->native->environment = frame->environment;
    napi_close_handle_scope(env, frame->scope);
}

/* The exception pending, cleared: the entry's error.execution, its text
 * kept for ta_napi_failure (the error path only). */
static ta_status ta_napi_failed(napi_env env) {
    napi_value exception = NULL, text;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (napi_get_and_clear_last_exception(env, &exception) != napi_ok || instance == NULL) return TA_ERROR_EXECUTION;
    size_t length = 0;
    instance->failed = true;
    if (napi_coerce_to_string(env, exception, &text) != napi_ok ||
        napi_get_value_string_utf8(env, text, instance->failure_message, sizeof instance->failure_message, &length) != napi_ok) {
        napi_value ignored; /* its toString threw */
        napi_get_and_clear_last_exception(env, &ignored);
        length = 0;
    }
    instance->failure_length = (uint32_t)length;
    return TA_ERROR_EXECUTION;
}

/* Why the last entry failed, once (datamodel.h): the code raised. */
static ta_status ta_napi_failure(const ta_datamodel_call *call, ta_datamodel_failure *out) {
    ta_napi_native *native = (ta_napi_native *)call->datamodel;
    ta_napi_instance *instance = ta_napi_instance_of(native->host->env);
    if (instance == NULL || !instance->failed) {
        out->reason = TA_DATAMODEL_FAILURE_NONE;
        return TA_OK;
    }
    out->reason = TA_DATAMODEL_FAILURE_EXCEPTION;
    out->message = (ta_string_view){instance->failure_message, instance->failure_length};
    instance->failed = false;
    return TA_OK;
}

/* The evaluation of `call`'s session (an open frame), or false. */
static bool ta_napi_evaluation_of(const ta_datamodel_call *call, ta_napi_evaluation *evaluation) {
    ta_napi_native *native = (ta_napi_native *)call->datamodel;
    napi_env env = native->host->env;
    memset(evaluation, 0, sizeof *evaluation);
    evaluation->native = native;
    evaluation->env = env;
    ta_napi_session_row *session = (ta_napi_session_row *)ta_table_get(&native->host->sessions, call->instance);
    ta_napi_chart_row *chart = session != NULL ? (ta_napi_chart_row *)ta_table_get(&native->host->charts, session->chart) : NULL;
    if (chart == NULL) return false;
    evaluation->row = *chart;
    evaluation->chart = &evaluation->row;
    napi_value held = ta_napi_slot_value(native, &(ta_napi_slot){&native->scopes, call->instance}), shared;
    if (held == NULL || (evaluation->record = ta_napi_native_get(native, chart->functions)) == NULL) return false;
    if (chart->flags & TA_NAPI_CHART_DECLARES) {
        evaluation->own = held;
        if (napi_get_element(env, held, TA_NAPI_OWN_KIT, &evaluation->kit) != napi_ok ||
            napi_get_named_property(env, evaluation->kit, "global", &evaluation->scope) != napi_ok)
            return false;
    } else {
        evaluation->scope = held;
        if ((shared = ta_napi_realm_shared(native)) == NULL ||
            napi_get_element(env, shared, TA_NAPI_REALM_KIT, &evaluation->kit) != napi_ok)
            return false;
    }
    if (call->environment != NULL) ta_datamodel_environment_charge(call->environment, 1); /* fuel once per evaluation */
    return true;
}

/* An entry over a session: its frame and its evaluation. */
typedef struct ta_napi_entry {
    ta_napi_frame frame;
    ta_napi_evaluation evaluation;
} ta_napi_entry;

static bool ta_napi_enter_entry(const ta_datamodel_call *call, ta_napi_entry *entry) {
    if (!ta_napi_frame_open((ta_napi_native *)call->datamodel, call->environment, &entry->frame)) return false;
    if (ta_napi_evaluation_of(call, &entry->evaluation)) return true;
    napi_value ignored;
    napi_get_and_clear_last_exception(entry->frame.native->host->env, &ignored);
    ta_napi_frame_close(&entry->frame);
    return false;
}

/* A string the datamodel answers (eval_string, log): its UTF-8 in the
 * output, valid until the datamodel's next call. */
static ta_status ta_napi_string_out(ta_napi_native *native, napi_value value, ta_string_view *out) {
    napi_env env = native->host->env;
    ta_napi_room room = {&native->output, &native->host->allocator, {NULL, 0}};
    napi_value text;
    if (value == NULL || napi_coerce_to_string(env, value, &text) != napi_ok || !ta_napi_text_kept(env, text, &room))
        return ta_napi_failed(env);
    *out = room.view;
    return TA_OK;
}

/* ---- charts -------------------------------------------------------------------- */

/* The names a chart's scopes have from the start: its <data> ids, then the
 * locations its <foreach>es bind as item and index (an identifier the
 * session does not declare otherwise: SCXML 4.6). */
static napi_value ta_napi_chart_names(napi_env env, const ta_datamodel_chart *chart) {
    napi_value names, name;
    uint32_t count = 0;
    if (napi_create_array(env, &names) != napi_ok) return NULL;
    uint32_t data = ta_image_data_count(chart->image, chart->chart);
    for (uint32_t i = 0; i < data; i++) {
        ta_data_info info;
        if (ta_image_data(chart->image, (ta_chart_item){chart->chart, i}, &info) != TA_OK) continue;
        if (napi_create_string_utf8(env, info.id.pointer, info.id.length, &name) != napi_ok ||
            napi_set_element(env, names, count++, name) != napi_ok)
            return NULL;
    }
    uint32_t expressions = ta_image_expression_count(chart->image, chart->chart);
    for (uint32_t e = 0; e < expressions; e++) {
        ta_expression_info info;
        if (ta_image_expression(chart->image, (ta_chart_item){chart->chart, e}, &info) != TA_OK ||
            info.kind != TA_EXPRESSION_ITEM)
            continue;
        ta_string_view item = info.source;
        while (item.length > 0 && (item.pointer[0] == ' ' || item.pointer[0] == '\t' || item.pointer[0] == '\n' || item.pointer[0] == '\r')) {
            item.pointer++;
            item.length--;
        }
        while (item.length > 0 && (item.pointer[item.length - 1] == ' ' || item.pointer[item.length - 1] == '\t' ||
                                   item.pointer[item.length - 1] == '\n' || item.pointer[item.length - 1] == '\r'))
            item.length--;
        bool identifier = item.length > 0;
        for (uint32_t i = 0; i < item.length && identifier; i++) {
            char c = item.pointer[i];
            identifier = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$' || (i > 0 && c >= '0' && c <= '9');
        }
        bool known = false;
        if (!identifier || napi_create_string_utf8(env, item.pointer, item.length, &name) != napi_ok) continue;
        for (uint32_t i = 0; i < count && !known; i++) {
            napi_value other;
            if (napi_get_element(env, names, i, &other) != napi_ok || napi_strict_equals(env, name, other, &known) != napi_ok)
                return NULL;
        }
        if (!known && napi_set_element(env, names, count++, name) != napi_ok) return NULL;
    }
    return names;
}

/* A chart's record (datamodel.h): its scopes' constructor in the shared
 * context (none for a declaring chart), its caches, its names. */
typedef struct ta_napi_record_of {
    const ta_datamodel_chart *chart;
    const ta_napi_chart_of *declaring;
    napi_value names;
} ta_napi_record_of;

static napi_value ta_napi_chart_record(ta_napi_native *native, const ta_napi_record_of *of) {
    napi_env env = native->host->env;
    napi_value record, slot, shape, shared, kit;
    if (napi_create_array_with_length(env, TA_NAPI_CHART_RECORD, &record) != napi_ok) return NULL;
    bool declares = of->declaring->declares;
    if (napi_get_undefined(env, &shape) != napi_ok) return NULL;
    if (!declares) {
        if ((shared = ta_napi_realm_shared(native)) == NULL || napi_get_element(env, shared, TA_NAPI_REALM_KIT, &kit) != napi_ok ||
            (shape = ta_napi_kit(env, kit, &(ta_napi_kit_call){"shape", 1, {of->names}})) == NULL)
            return NULL;
    }
    if (napi_set_element(env, record, TA_NAPI_CHART_SHAPE, shape) != napi_ok) return NULL;
    for (uint32_t i = TA_NAPI_CHART_GETTERS; i < TA_NAPI_CHART_HOISTS; i++)
        if (napi_create_array(env, &slot) != napi_ok || napi_set_element(env, record, i, slot) != napi_ok) return NULL;
    /* a declaring chart's names, for each session's context: kept as the
     * shape; its scripts' declarations, made again in a woken session's */
    if (declares && (napi_set_element(env, record, TA_NAPI_CHART_SHAPE, of->names) != napi_ok ||
                     napi_set_element(env, record, TA_NAPI_CHART_HOISTS, of->declaring->hoists) != napi_ok ||
                     napi_set_element(env, record, TA_NAPI_CHART_FUNCTIONS, of->declaring->functions) != napi_ok))
        return NULL;
    return record;
}

static ta_status ta_napi_chart_attach(void *datamodel, const ta_datamodel_chart *chart, void **context) {
    ta_napi_native *native = (ta_napi_native *)datamodel;
    napi_env env = native->host->env;
    ta_napi_frame frame;
    if (!ta_napi_frame_open(native, NULL, &frame)) return TA_ERROR_INVALID;
    ta_status status = TA_OK;
    ta_napi_chart_of declaring = {chart->image, chart->chart, false, false, NULL, NULL};
    napi_value names = NULL, record = NULL;
    napi_ref reference = NULL;
    if (!ta_napi_realm_declares(native, &declaring) || (names = ta_napi_chart_names(env, chart)) == NULL ||
        (record = ta_napi_chart_record(native, &(ta_napi_record_of){chart, &declaring, names})) == NULL ||
        napi_create_reference(env, record, 1, &reference) != napi_ok)
        status = (ta_napi_failed(env), TA_ERROR_INVALID); /* a chart this datamodel cannot run */
    uint64_t handle = 0;
    ta_napi_chart_row *row = status == TA_OK ? (ta_napi_chart_row *)ta_table_add(&native->host->charts, &handle) : NULL;
    if (status == TA_OK && row == NULL) {
        napi_delete_reference(env, reference);
        status = TA_ERROR_NO_MEMORY;
    }
    if (row != NULL) {
        uint32_t flags = (declaring.declares ? TA_NAPI_CHART_DECLARES : 0u) | (declaring.lexical ? TA_NAPI_CHART_LEXICAL : 0u);
        *row = (ta_napi_chart_row){reference, chart->image, chart->chart, flags, chart->segment};
        *context = (void *)(uintptr_t)handle; /* the row's handle, never a pointer */
    }
    ta_napi_frame_close(&frame);
    return status;
}

static void ta_napi_chart_detach(void *datamodel, void *context) {
    ta_napi_native *native = (ta_napi_native *)datamodel;
    uint64_t handle = (uint64_t)(uintptr_t)context;
    ta_napi_chart_row *row = (ta_napi_chart_row *)ta_table_get(&native->host->charts, handle);
    if (row == NULL) return;
    napi_ref reference = row->functions;
    ta_table_remove(&native->host->charts, handle);
    ta_napi_native_drop(native, reference);
}

/* ---- sessions ------------------------------------------------------------------- */

/* The system variables of a session, its link (realm.js, `system`), made
 * once at create in the kit's context: core's views end with the call. */
static napi_value ta_napi_system(napi_env env, napi_value kit, const ta_datamodel_system_variables *variables) {
    napi_value sessionid, name, processors, entry, type, location;
    if (napi_create_string_utf8(env, variables->sessionid.pointer, variables->sessionid.length, &sessionid) != napi_ok ||
        napi_create_string_utf8(env, variables->name.pointer != NULL ? variables->name.pointer : "", variables->name.length,
                                &name) != napi_ok ||
        napi_create_array_with_length(env, variables->io_processor_count, &processors) != napi_ok)
        return NULL;
    for (uint32_t i = 0; i < variables->io_processor_count; i++) {
        const ta_io_processor_entry *processor = &variables->io_processors[i];
        if (napi_create_string_utf8(env, processor->type.pointer, processor->type.length, &type) != napi_ok ||
            napi_create_string_utf8(env, processor->location.pointer, processor->location.length, &location) != napi_ok ||
            napi_create_array_with_length(env, 2, &entry) != napi_ok || napi_set_element(env, entry, 0, type) != napi_ok ||
            napi_set_element(env, entry, 1, location) != napi_ok || napi_set_element(env, processors, i, entry) != napi_ok)
            return NULL;
    }
    return ta_napi_kit(env, kit, &(ta_napi_kit_call){"system", 3, {sessionid, name, processors}});
}

/* The strings of _event the datamodel keeps: the three types, then the
 * session's I/O processors' types, which an event names by index (every
 * session of a host has the same ones). */
static bool ta_napi_keep_strings(ta_napi_native *native, const ta_datamodel_system_variables *variables) {
    if (native->strings != NULL || variables == NULL) return true;
    napi_env env = native->host->env;
    static const char *const types[] = {"platform", "internal", "external"};
    napi_value strings, string;
    if (napi_create_array(env, &strings) != napi_ok) return false;
    for (uint32_t i = 0; i < 3; i++)
        if (napi_create_string_utf8(env, types[i], NAPI_AUTO_LENGTH, &string) != napi_ok ||
            napi_set_element(env, strings, i, string) != napi_ok)
            return false;
    for (uint32_t i = 0; i < variables->io_processor_count; i++) {
        ta_string_view type = variables->io_processors[i].type;
        if (napi_create_string_utf8(env, type.pointer, type.length, &string) != napi_ok ||
            napi_set_element(env, strings, 3 + i, string) != napi_ok)
            return false;
    }
    return napi_create_reference(env, strings, 1, &native->strings) == napi_ok;
}

/* A session's scope (shared chart) or the record of its own context
 * (declaring chart), with its link and its init params. */
typedef struct ta_napi_start_of {
    const ta_napi_chart_row *chart;
    const ta_datamodel_system_variables *variables;
    napi_value init;   /* the params' value (of the shared context), or undefined */
    napi_value system; /* a snapshot's [sessionid, name, processors] in place of `variables`, or NULL */
} ta_napi_start_of;

/* The session's link, made in `kit`'s context: from core's system
 * variables, or from what a snapshot holds of them. */
static napi_value ta_napi_link_new(napi_env env, napi_value kit, const ta_napi_start_of *start) {
    if (start->system == NULL) return ta_napi_system(env, kit, start->variables);
    napi_value parts[3];
    for (uint32_t i = 0; i < 3; i++)
        if (napi_get_element(env, start->system, i, &parts[i]) != napi_ok) return NULL;
    return ta_napi_kit(env, kit, &(ta_napi_kit_call){"system", 3, {parts[0], parts[1], parts[2]}});
}

static napi_value ta_napi_session_new(ta_napi_native *native, const ta_napi_start_of *start) {
    napi_env env = native->host->env;
    napi_value record = ta_napi_native_get(native, start->chart->functions), shape, kit, link, init = start->init, made;
    if (record == NULL || napi_get_element(env, record, TA_NAPI_CHART_SHAPE, &shape) != napi_ok) return NULL;
    if (!(start->chart->flags & TA_NAPI_CHART_DECLARES)) {
        napi_value shared = ta_napi_realm_shared(native);
        if (shared == NULL || napi_get_element(env, shared, TA_NAPI_REALM_KIT, &kit) != napi_ok ||
            (link = ta_napi_link_new(env, kit, start)) == NULL ||
            napi_set_named_property(env, link, "init", init) != napi_ok || napi_new_instance(env, shape, 1, &link, &made) != napi_ok)
            return NULL;
        return made;
    }
    napi_value own = ta_napi_realm_new(native), slot, global;
    if (own == NULL || napi_get_element(env, own, TA_NAPI_REALM_KIT, &kit) != napi_ok ||
        (link = ta_napi_link_new(env, kit, start)) == NULL)
        return NULL;
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, init, &type) != napi_ok) return NULL;
    if (type != napi_undefined && (init = ta_napi_kit(env, kit, &(ta_napi_kit_call){"copy", 1, {init}})) == NULL) return NULL;
    if (napi_set_named_property(env, link, "init", init) != napi_ok ||
        (global = ta_napi_kit(env, kit, &(ta_napi_kit_call){"declare", 2, {shape, link}})) == NULL)
        return NULL;
    for (uint32_t i = TA_NAPI_OWN_GETTERS; i < TA_NAPI_OWN_RECORD; i++)
        if (napi_create_array(env, &slot) != napi_ok || napi_set_element(env, own, i, slot) != napi_ok) return NULL;
    return own;
}

static ta_status ta_napi_create(void *datamodel, const ta_datamodel_start *start, uint64_t *instance) {
    ta_napi_native *native = (ta_napi_native *)datamodel;
    napi_env env = native->host->env;
    ta_napi_frame frame;
    if (!ta_napi_frame_open(native, NULL, &frame)) {
        ta_napi_native_release(native, start->init); /* the init payload's reference is ours */
        return TA_ERROR_NO_MEMORY;
    }
    napi_value init = ta_napi_native_value(native, start->init);
    ta_napi_native_release(native, start->init);
    uint64_t chart_handle = (uint64_t)(uintptr_t)start->chart_context;
    ta_napi_chart_row *chart = (ta_napi_chart_row *)ta_table_get(&native->host->charts, chart_handle);
    ta_status status = TA_OK;
    napi_value made = NULL;
    if (chart == NULL || !ta_napi_keep_strings(native, start->system_variables) ||
        (made = ta_napi_session_new(native, &(ta_napi_start_of){chart, start->system_variables, init, NULL})) == NULL)
        status = ta_napi_failed(env);
    uint64_t handle = 0;
    ta_napi_session_row *row = status == TA_OK ? (ta_napi_session_row *)ta_table_add(&native->host->sessions, &handle) : NULL;
    if (status == TA_OK && row == NULL) status = TA_ERROR_NO_MEMORY;
    if (row != NULL && !ta_napi_slot_hold(native, &(ta_napi_slot){&native->scopes, handle}, made)) { /* no row without its scope */
        ta_table_remove(&native->host->sessions, handle);
        row = NULL;
        status = ta_napi_failed(env);
    }
    if (row != NULL) {
        *row = (ta_napi_session_row){chart_handle, TA_NIL, TA_NIL, TA_NIL};
        *instance = handle;
    }
    ta_napi_frame_close(&frame);
    return status;
}

static void ta_napi_destroy(const ta_datamodel_call *call) {
    ta_napi_native *native = (ta_napi_native *)call->datamodel;
    ta_napi_session_row *row = (ta_napi_session_row *)ta_table_get(&native->host->sessions, call->instance);
    if (row == NULL) return;
    ta_napi_slot_let_go(native, &(ta_napi_slot){&native->scopes, call->instance});
    ta_table_remove(&native->host->sessions, call->instance);
}

/* The session's link: its system variables and params. */
static napi_value ta_napi_link(const ta_napi_evaluation *evaluation) {
    napi_value symbol, link;
    if (napi_get_named_property(evaluation->env, evaluation->kit, "LINK", &symbol) != napi_ok ||
        napi_get_property(evaluation->env, evaluation->scope, symbol, &link) != napi_ok)
        return NULL;
    return link;
}

static ta_status ta_napi_init_data(const ta_datamodel_call *call, uint32_t declaration) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    ta_napi_evaluation *evaluation = &entry.evaluation;
    napi_env env = evaluation->env;
    ta_data_info info;
    ta_status status = TA_OK;
    napi_value id, value = NULL, link, init, undefined;
    napi_get_undefined(env, &undefined);
    if (ta_image_data(evaluation->row.image, (ta_chart_item){evaluation->row.chart, declaration}, &info) != TA_OK ||
        napi_create_string_utf8(env, info.id.pointer, info.id.length, &id) != napi_ok) {
        ta_napi_frame_close(&entry.frame);
        return ta_napi_failed(env);
    }
    /* the spawn's or invoke's params override the <data> of their names */
    napi_valuetype type = napi_undefined;
    bool given = false;
    if ((link = ta_napi_link(evaluation)) != NULL && napi_get_named_property(env, link, "init", &init) == napi_ok &&
        napi_typeof(env, init, &type) == napi_ok && type == napi_object &&
        napi_has_own_property(env, init, id, &given) == napi_ok && given)
        napi_get_property(env, init, id, &value);
    if (value == NULL && info.expression != TA_NIL && (value = ta_napi_evaluate(evaluation, info.expression)) == NULL)
        status = ta_napi_failed(env);
    if (napi_set_property(env, evaluation->scope, id, value != NULL ? value : undefined) != napi_ok && status == TA_OK)
        status = ta_napi_failed(env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

/* ---- _event --------------------------------------------------------------------- */

/* The string of `text` kept at `index` of a chart's list (its names,
 * invoke ids or origins): the one there when its text is the same, else a
 * new one, kept there when the place was empty. A text that differs (an id
 * generated per execution) gets a string of its own. */
typedef struct ta_napi_kept_at {
    napi_value list;
    uint32_t index;
} ta_napi_kept_at;

static napi_value ta_napi_kept(napi_env env, const ta_napi_kept_at *at, ta_string_view text) {
    napi_value made = NULL, kept;
    napi_valuetype type = napi_undefined;
    if (at->list != NULL && at->index != TA_NIL && napi_get_element(env, at->list, at->index, &kept) == napi_ok &&
        napi_typeof(env, kept, &type) == napi_ok && type == napi_string) {
        char room[256];
        size_t length = 0;
        if (text.length < sizeof room && napi_get_value_string_utf8(env, kept, room, sizeof room, &length) == napi_ok &&
            length == text.length && memcmp(room, text.pointer, length) == 0)
            return kept; /* the chart's string for this text */
    }
    if (napi_create_string_utf8(env, text.pointer, text.length, &made) != napi_ok) return NULL;
    if (at->list != NULL && at->index != TA_NIL && type == napi_undefined)
        napi_set_element(env, at->list, at->index, made); /* the first: kept */
    return made;
}

/* Optional text: undefined when empty. */
static napi_value ta_napi_optional(napi_env env, ta_string_view text) {
    napi_value value = NULL;
    if (text.length == 0) napi_get_undefined(env, &value);
    else napi_create_string_utf8(env, text.pointer, text.length, &value);
    return value;
}

static ta_status ta_napi_bind_event(const ta_datamodel_call *call, const ta_event_view *view) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    ta_napi_evaluation *evaluation = &entry.evaluation;
    ta_napi_native *native = evaluation->native;
    napi_env env = evaluation->env;
    napi_value fields, names, invokeids, origins, strings, field, event, link, undefined;
    napi_get_undefined(env, &undefined);
    bool ok = napi_create_array_with_length(env, 8, &fields) == napi_ok &&
              napi_get_element(env, evaluation->record, TA_NAPI_CHART_NAMES, &names) == napi_ok &&
              napi_get_element(env, evaluation->record, TA_NAPI_CHART_INVOKEIDS, &invokeids) == napi_ok &&
              napi_get_element(env, evaluation->record, TA_NAPI_CHART_ORIGINS, &origins) == napi_ok &&
              (strings = ta_napi_native_get(native, native->strings)) != NULL;
    /* name, type, sendid, origin, origintype, invokeid, data, raw */
    ok = ok && (field = ta_napi_kept(env, &(ta_napi_kept_at){names, view->name_id}, view->name)) != NULL &&
         napi_set_element(env, fields, 0, field) == napi_ok &&
         napi_get_element(env, strings, view->type % 3, &field) == napi_ok && napi_set_element(env, fields, 1, field) == napi_ok &&
         napi_set_element(env, fields, 2, ta_napi_optional(env, view->sendid)) == napi_ok;
    field = view->origin.length ? ta_napi_kept(env, &(ta_napi_kept_at){origins, view->invoke_slot}, view->origin) : undefined;
    ok = ok && field != NULL && napi_set_element(env, fields, 3, field) == napi_ok;
    /* the origintype: the I/O processor's type the datamodel keeps, when it is that one */
    field = view->origintype.length == 0 ? undefined
            : view->origintype_id != TA_NIL
                ? ta_napi_kept(env, &(ta_napi_kept_at){strings, 3 + view->origintype_id}, view->origintype)
                : ta_napi_optional(env, view->origintype);
    ok = ok && field != NULL && napi_set_element(env, fields, 4, field) == napi_ok;
    field = view->invokeid.length ? ta_napi_kept(env, &(ta_napi_kept_at){invokeids, view->invoke_slot}, view->invokeid)
                                  : undefined;
    ok = ok && field != NULL && napi_set_element(env, fields, 5, field) == napi_ok;
    /* the data: the payload row's value itself; a session of its own context gets its copy */
    field = ta_napi_native_value(native, view->data);
    if (ok && evaluation->own != NULL && view->data != 0)
        field = ta_napi_kit(env, evaluation->kit, &(ta_napi_kit_call){"copy", 1, {field}});
    ok = ok && field != NULL && napi_set_element(env, fields, 6, field) == napi_ok &&
         napi_set_element(env, fields, 7,
                          view->size >= sizeof *view ? ta_napi_optional(env, view->raw) : undefined) == napi_ok &&
         (event = ta_napi_kit(env, evaluation->kit, &(ta_napi_kit_call){"event", 1, {fields}})) != NULL;
    /* _event is read-only to the chart: a non-writable property, defined again */
    napi_property_descriptor property = {"_event", NULL, NULL, NULL, NULL, NULL, napi_enumerable | napi_configurable, NULL};
    property.value = ok ? event : NULL;
    ok = ok && napi_define_properties(env, evaluation->scope, 1, &property) == napi_ok;
    /* an event has come: the params were read by init_data */
    if (ok && (link = ta_napi_link(evaluation)) != NULL) napi_set_named_property(env, link, "init", undefined);
    ta_napi_session_row *row = ok ? (ta_napi_session_row *)ta_table_get(&native->host->sessions, call->instance) : NULL;
    if (row != NULL) { /* core's ids of the strings, for a blob */
        row->name_id = view->name_id;
        row->invoke_slot = view->invoke_slot;
        row->origintype_id = view->origintype_id;
    }
    ta_status status = ok ? TA_OK : ta_napi_failed(env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

/* SCXML keeps _event bound to the last event (5.10): nothing to drop. */
static void ta_napi_detach_event(const ta_datamodel_call *call) {
    (void)call;
}

/* ---- evaluations ------------------------------------------------------------------ */

static ta_status ta_napi_eval_condition(const ta_datamodel_call *call, ta_expression e, int *out) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    napi_env env = entry.evaluation.env;
    napi_value value = ta_napi_evaluate(&entry.evaluation, e), truth;
    bool is = false;
    ta_status status = value != NULL && napi_coerce_to_bool(env, value, &truth) == napi_ok &&
                               napi_get_value_bool(env, truth, &is) == napi_ok
                           ? TA_OK
                           : ta_napi_failed(env);
    if (status == TA_OK) *out = is ? 1 : 0;
    ta_napi_frame_close(&entry.frame);
    return status;
}

static ta_status ta_napi_eval_string(const ta_datamodel_call *call, ta_expression e, ta_string_view *out) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    napi_value value = ta_napi_evaluate(&entry.evaluation, e);
    ta_status status = value != NULL ? ta_napi_string_out(entry.evaluation.native, value, out) : ta_napi_failed(entry.evaluation.env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

static ta_status ta_napi_assign_entry(const ta_datamodel_call *call, ta_expression location, ta_expression e) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    napi_value value = ta_napi_evaluate(&entry.evaluation, e);
    bool ok = value != NULL && ta_napi_assign(&entry.evaluation, &(ta_napi_assignment){location, value});
    ta_status status = ok ? TA_OK : ta_napi_failed(entry.evaluation.env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

static ta_status ta_napi_assign_string(const ta_datamodel_call *call, ta_expression location, ta_string_view text) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    napi_env env = entry.evaluation.env;
    napi_value value = NULL;
    bool ok = napi_create_string_utf8(env, text.pointer != NULL ? text.pointer : "", text.length, &value) == napi_ok &&
              ta_napi_assign(&entry.evaluation, &(ta_napi_assignment){location, value});
    ta_status status = ok ? TA_OK : ta_napi_failed(env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

static ta_status ta_napi_script_entry(const ta_datamodel_call *call, ta_expression e) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    ta_status status = ta_napi_evaluate(&entry.evaluation, e) != NULL ? TA_OK : ta_napi_failed(entry.evaluation.env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

/* <log>: an object (not a function) as its JSON, else as a string. */
static ta_status ta_napi_log(const ta_datamodel_call *call, ta_expression e, ta_string_view *out) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    napi_env env = entry.evaluation.env;
    napi_value value = ta_napi_evaluate(&entry.evaluation, e), stringify, json, undefined;
    napi_valuetype type = napi_undefined;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (value != NULL && instance != NULL && napi_typeof(env, value, &type) == napi_ok && type == napi_object &&
        napi_get_reference_value(env, instance->stringify, &stringify) == napi_ok && napi_get_undefined(env, &undefined) == napi_ok) {
        if (napi_call_function(env, undefined, stringify, 1, &value, &json) == napi_ok &&
            napi_typeof(env, json, &type) == napi_ok && type == napi_string)
            value = json;
        else {
            napi_value ignored; /* a cycle: its text instead */
            napi_get_and_clear_last_exception(env, &ignored);
        }
    }
    ta_status status = value != NULL ? ta_napi_string_out(entry.evaluation.native, value, out) : ta_napi_failed(env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

/* ---- <foreach> ------------------------------------------------------------------ */

static ta_status ta_napi_foreach_begin(const ta_datamodel_call *call, ta_expression array, ta_datamodel_loop *loop) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    ta_napi_native *native = entry.evaluation.native;
    napi_env env = entry.evaluation.env;
    napi_value value = ta_napi_evaluate(&entry.evaluation, array), items, item;
    bool is = false;
    uint32_t length = 0;
    ta_status status = TA_OK;
    /* an array, copied shallowly: the loop walks the items it had */
    if (value == NULL || napi_is_array(env, value, &is) != napi_ok || !is || napi_get_array_length(env, value, &length) != napi_ok ||
        length > (uint32_t)INT32_MAX || napi_create_array_with_length(env, length, &items) != napi_ok)
        status = ta_napi_failed(env);
    for (uint32_t i = 0; status == TA_OK && i < length; i++)
        if (napi_get_element(env, value, i, &item) != napi_ok || napi_set_element(env, items, i, item) != napi_ok)
            status = ta_napi_failed(env);
    napi_ref reference = NULL;
    if (status == TA_OK && napi_create_reference(env, items, 1, &reference) != napi_ok) status = ta_napi_failed(env);
    uint64_t handle = 0;
    ta_napi_loop_row *row = status == TA_OK ? (ta_napi_loop_row *)ta_table_add(&native->host->loops, &handle) : NULL;
    if (status == TA_OK && row == NULL) {
        napi_delete_reference(env, reference);
        status = TA_ERROR_NO_MEMORY;
    }
    if (row != NULL) {
        row->items = reference;
        loop->iter = handle;
        loop->n = length;
    }
    ta_napi_frame_close(&entry.frame);
    return status;
}

static ta_status ta_napi_foreach_item(const ta_datamodel_call *call, const ta_datamodel_loop *loop) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    ta_napi_native *native = entry.evaluation.native;
    napi_env env = entry.evaluation.env;
    ta_napi_loop_row *row = (ta_napi_loop_row *)ta_table_get(&native->host->loops, loop->iter);
    napi_value items = row != NULL ? ta_napi_native_get(native, row->items) : NULL, item, index;
    bool ok = items != NULL && napi_get_element(env, items, loop->i, &item) == napi_ok &&
              ta_napi_assign(&entry.evaluation, &(ta_napi_assignment){loop->item, item});
    if (ok && loop->index != TA_NIL)
        ok = napi_create_uint32(env, loop->i, &index) == napi_ok &&
             ta_napi_assign(&entry.evaluation, &(ta_napi_assignment){loop->index, index});
    ta_status status = ok ? TA_OK : ta_napi_failed(env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

static void ta_napi_foreach_end(const ta_datamodel_call *call, const ta_datamodel_loop *loop) {
    ta_napi_native *native = (ta_napi_native *)call->datamodel;
    ta_napi_loop_row *row = (ta_napi_loop_row *)ta_table_get(&native->host->loops, loop->iter);
    if (row == NULL) return;
    napi_ref reference = row->items;
    ta_table_remove(&native->host->loops, loop->iter);
    ta_napi_native_drop(native, reference);
}

/* ---- payloads ----------------------------------------------------------------------- */

/* A namelist entry's key: its location's text, trimmed. */
static napi_value ta_napi_location_name(const ta_napi_evaluation *evaluation, ta_expression location) {
    ta_expression_info info;
    napi_value name = NULL;
    if (!ta_napi_expression_of(&evaluation->row, location, &info)) return NULL;
    ta_string_view text = info.source;
    while (text.length > 0 && (text.pointer[0] == ' ' || text.pointer[0] == '\t' || text.pointer[0] == '\n' || text.pointer[0] == '\r')) {
        text.pointer++;
        text.length--;
    }
    while (text.length > 0 && (text.pointer[text.length - 1] == ' ' || text.pointer[text.length - 1] == '\t' ||
                               text.pointer[text.length - 1] == '\n' || text.pointer[text.length - 1] == '\r'))
        text.length--;
    napi_create_string_utf8(evaluation->env, text.pointer, text.length, &name);
    return name;
}

/* What a <send>, <invoke> or <donedata> captures, copied into the shared
 * context: actors share no mutable value (bindings.md, section 8). */
static ta_status ta_napi_capture(const ta_datamodel_call *call, const ta_datamodel_capture *capture, ta_payload *out) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_EXECUTION;
    ta_napi_evaluation *evaluation = &entry.evaluation;
    napi_env env = evaluation->env;
    napi_value shared = ta_napi_realm_shared(evaluation->native), kit = NULL, captured = NULL, names, values, name, value;
    bool ok = shared != NULL && napi_get_element(env, shared, TA_NAPI_REALM_KIT, &kit) == napi_ok;
    if (ok && capture->content != TA_NIL) {
        value = ta_napi_evaluate(evaluation, capture->content);
        captured = value != NULL ? ta_napi_kit(env, kit, &(ta_napi_kit_call){"copy", 1, {value}}) : NULL;
    } else if (ok) {
        uint32_t count = 0;
        ok = napi_create_array(env, &names) == napi_ok && napi_create_array(env, &values) == napi_ok;
        for (uint32_t i = 0; ok && i < capture->namelist_count; i++)
            ok = (name = ta_napi_location_name(evaluation, capture->namelist[i])) != NULL &&
                 (value = ta_napi_evaluate(evaluation, capture->namelist[i])) != NULL &&
                 napi_set_element(env, names, count, name) == napi_ok && napi_set_element(env, values, count++, value) == napi_ok;
        for (uint32_t i = 0; ok && i < capture->param_count; i++) {
            ta_string_view text = ta_image_string(evaluation->row.image, capture->params[2 * i]);
            ok = napi_create_string_utf8(env, text.pointer, text.length, &name) == napi_ok &&
                 (value = ta_napi_evaluate(evaluation, capture->params[2 * i + 1])) != NULL &&
                 napi_set_element(env, names, count, name) == napi_ok && napi_set_element(env, values, count++, value) == napi_ok;
        }
        captured = ok ? ta_napi_kit(env, kit, &(ta_napi_kit_call){"record", 2, {names, values}}) : NULL;
    }
    ta_status status = captured != NULL ? ta_napi_native_add(evaluation->native, captured, out) : ta_napi_failed(env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

static ta_status ta_napi_custom(const ta_datamodel_call *call, uint32_t definition) {
    (void)call;
    (void)definition;
    return TA_ERROR_UNSUPPORTED;
}

/* ---- hibernation ----------------------------------------------------------------------- */

/* Appends `text` to the reason, truncated, NUL-terminated. */
static void ta_napi_reason_add(ta_napi_native *native, const char *text) {
    size_t at = strlen(native->reason);
    for (; *text != '\0' && at + 1 < sizeof native->reason; text++) native->reason[at++] = *text;
    native->reason[at] = '\0';
}

/* Why a value could not be stored: `what` ("variable 'name'", "_event"),
 * then the message of the pending exception, which is cleared. */
static void ta_napi_reason(ta_napi_native *native, const char *what, napi_value name) {
    napi_env env = native->host->env;
    napi_value error = NULL, message;
    napi_get_and_clear_last_exception(env, &error);
    native->reason[0] = '\0';
    ta_napi_reason_add(native, what);
    size_t at = strlen(native->reason), length = 0;
    if (name != NULL && at + 2 < sizeof native->reason &&
        napi_get_value_string_utf8(env, name, native->reason + at, sizeof native->reason - at - 1, &length) == napi_ok)
        native->reason[at + length] = '\0';
    ta_napi_reason_add(native, name != NULL ? "' cannot be stored: " : " cannot be stored: ");
    at = strlen(native->reason);
    napi_valuetype type = napi_undefined;
    if (error != NULL && napi_typeof(env, error, &type) == napi_ok && type == napi_object &&
        napi_get_named_property(env, error, "message", &message) == napi_ok && napi_typeof(env, message, &type) == napi_ok &&
        type == napi_string && at + 1 < sizeof native->reason &&
        napi_get_value_string_utf8(env, message, native->reason + at, sizeof native->reason - at, &length) == napi_ok)
        return;
    napi_get_and_clear_last_exception(env, &error);
    ta_napi_reason_add(native, "it is not a value of the value table");
}

/* What a refused document answers core: no memory, or a state that cannot
 * be stored. */
static ta_status ta_napi_unstored(const ta_napi_document *document) {
    return document->refused == TA_ERROR_NO_MEMORY ? TA_ERROR_NO_MEMORY : TA_ERROR_UNSUPPORTED;
}

static const char *const ta_napi_event_fields[] = {"name", "type", "sendid", "origin", "origintype", "invokeid", "data", "raw"};

/* _event as a blob holds it: its eight fields, then core's ids of its
 * name, its invoke and its origintype; null when no event came yet. */
typedef struct ta_napi_event_out {
    napi_value event;
    const ta_napi_session_row *row;
} ta_napi_event_out;

static bool ta_napi_event_write(ta_napi_native *native, const ta_napi_event_out *event, ta_napi_document *document) {
    napi_env env = native->host->env;
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, event->event, &type) != napi_ok) return false;
    if (type != napi_object) {
        ta_cbor_write_simple(&document->writer, TA_CBOR_NULL);
        return true;
    }
    ta_cbor_write_array(&document->writer, 11);
    for (uint32_t i = 0; i < 8; i++) {
        napi_value field;
        if (napi_get_named_property(env, event->event, ta_napi_event_fields[i], &field) != napi_ok ||
            !ta_napi_document_value(env, field, document)) {
            ta_napi_reason(native, "_event", NULL);
            return false;
        }
    }
    ta_cbor_write_uint(&document->writer, event->row->name_id);
    ta_cbor_write_uint(&document->writer, event->row->invoke_slot);
    ta_cbor_write_uint(&document->writer, event->row->origintype_id);
    return true;
}

/* A session's state written into the datamodel's output: its variables
 * and its _event as one CBOR map {"vars": {name: value}, "event": [...] |
 * null}, through the value table (no format that runs code when read:
 * bindings.md section 8). Then core calls destroy, which removes the row:
 * a hibernated session holds nothing in the engine. A value outside the
 * table keeps it resident (TA_ERROR_UNSUPPORTED, `reason` says which), and
 * so does a chart whose scripts declare with let, const or class, which a
 * new context cannot be given again. A declaring session's function
 * declarations are not written: the wake makes them again from the
 * chart's scripts. */
static ta_status ta_napi_serialize(const ta_datamodel_call *call, ta_bytes *out) {
    ta_napi_native *native = (ta_napi_native *)call->datamodel;
    *out = (ta_bytes){NULL, 0};
    native->reason[0] = '\0';
    ta_napi_session_row *found = (ta_napi_session_row *)ta_table_get(&native->host->sessions, call->instance);
    if (found == NULL) return TA_ERROR_INVALID;
    ta_napi_session_row row = *found; /* a copy: JavaScript runs below */
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_INVALID;
    ta_napi_evaluation *evaluation = &entry.evaluation;
    napi_env env = evaluation->env;
    if (evaluation->row.flags & TA_NAPI_CHART_LEXICAL) {
        ta_napi_reason_add(native, "the chart's scripts declare with let, const or class at their top level: "
                                   "a new context cannot be given those bindings again, so its sessions stay resident");
        ta_napi_frame_close(&entry.frame);
        return TA_ERROR_UNSUPPORTED;
    }
    napi_value remade = NULL, variables = NULL, names, values, name, value, event;
    napi_valuetype type = napi_undefined;
    uint32_t count = 0;
    bool ok = napi_get_element(env, evaluation->record, TA_NAPI_CHART_FUNCTIONS, &remade) == napi_ok &&
              napi_typeof(env, remade, &type) == napi_ok && (type == napi_object || napi_create_array(env, &remade) == napi_ok) &&
              (variables = ta_napi_kit(env, evaluation->kit, &(ta_napi_kit_call){"stored", 2, {evaluation->scope, remade}})) != NULL &&
              napi_get_element(env, variables, 0, &names) == napi_ok && napi_get_element(env, variables, 1, &values) == napi_ok &&
              napi_get_array_length(env, names, &count) == napi_ok &&
              napi_get_named_property(env, evaluation->scope, "_event", &event) == napi_ok;
    if (!ok) {
        ta_napi_reason(native, "the session", NULL);
        ta_napi_frame_close(&entry.frame);
        return TA_ERROR_UNSUPPORTED;
    }
    ta_napi_document document;
    memset(&document, 0, sizeof document);
    document.room = (ta_napi_room){&native->output, &native->host->allocator, {NULL, 0}};
    document.arena = &native->host->arena;
    ta_napi_document_open(&document);
    ta_cbor_write_map(&document.writer, 2);
    ta_cbor_write_text(&document.writer, (ta_string_view){"vars", 4});
    ta_cbor_write_map(&document.writer, count);
    for (uint32_t i = 0; ok && i < count; i++) {
        ok = napi_get_element(env, names, i, &name) == napi_ok && napi_get_element(env, values, i, &value) == napi_ok &&
             ta_napi_document_value(env, name, &document);
        if (ok && !ta_napi_document_value(env, value, &document)) {
            ta_napi_reason(native, "variable '", name);
            ok = false;
        }
    }
    if (ok) {
        ta_cbor_write_text(&document.writer, (ta_string_view){"event", 5});
        ok = ta_napi_event_write(native, &(ta_napi_event_out){event, &row}, &document);
    }
    if (!ok && document.refused == TA_OK) document.refused = TA_ERROR_EXECUTION;
    bool kept = ta_napi_document_close(&document, ok);
    ta_status status = kept ? TA_OK : ta_napi_unstored(&document);
    if (kept) *out = document.out;
    else if (native->reason[0] == '\0') ta_napi_reason(native, "the session", NULL);
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
    ta_napi_frame_close(&entry.frame);
    return status;
}

/* `text` as the string kept at `index` of a chart's list, when its text is
 * the same (a string of the blob's is kept there when the place is empty). */
static napi_value ta_napi_kept_string(napi_env env, const ta_napi_kept_at *at, napi_value text) {
    napi_value kept;
    napi_valuetype type = napi_undefined, mine = napi_undefined;
    bool same = false;
    if (napi_typeof(env, text, &mine) != napi_ok || mine != napi_string || at->list == NULL || at->index == TA_NIL ||
        napi_get_element(env, at->list, at->index, &kept) != napi_ok || napi_typeof(env, kept, &type) != napi_ok)
        return text;
    if (type == napi_string && napi_strict_equals(env, kept, text, &same) == napi_ok && same) return kept;
    if (type == napi_undefined) napi_set_element(env, at->list, at->index, text);
    return text;
}

/* An id of a blob's event (a number), TA_NIL for anything else. */
static uint32_t ta_napi_blob_id(napi_env env, napi_value fields, uint32_t index) {
    napi_value value;
    napi_valuetype type = napi_undefined;
    uint32_t id = TA_NIL;
    if (napi_get_element(env, fields, index, &value) != napi_ok || napi_typeof(env, value, &type) != napi_ok ||
        type != napi_number || napi_get_value_uint32(env, value, &id) != napi_ok)
        return TA_NIL;
    return id;
}

/* A woken session's _event from the fields a blob holds, its strings
 * shared with the chart's (by core's ids, when the text is the same) and
 * the datamodel's, its data copied into the session's context. The ids go
 * to `row`. */
typedef struct ta_napi_event_in {
    napi_value fields; /* the blob's array of 11 */
    napi_value kit, record;
    ta_napi_session_row *row; /* out: the ids */
} ta_napi_event_in;

static napi_value ta_napi_event_from(ta_napi_native *native, const ta_napi_event_in *in) {
    napi_env env = native->host->env;
    napi_value fields, field, names, invokeids, origins, strings = ta_napi_native_get(native, native->strings), made[8];
    uint32_t length = 0;
    bool array = false;
    if (napi_is_array(env, in->fields, &array) != napi_ok || !array || napi_get_array_length(env, in->fields, &length) != napi_ok ||
        length != 11 || strings == NULL || napi_get_element(env, in->record, TA_NAPI_CHART_NAMES, &names) != napi_ok ||
        napi_get_element(env, in->record, TA_NAPI_CHART_INVOKEIDS, &invokeids) != napi_ok ||
        napi_get_element(env, in->record, TA_NAPI_CHART_ORIGINS, &origins) != napi_ok)
        return NULL;
    for (uint32_t i = 0; i < 8; i++)
        if (napi_get_element(env, in->fields, i, &made[i]) != napi_ok) return NULL;
    in->row->name_id = ta_napi_blob_id(env, in->fields, 8);
    in->row->invoke_slot = ta_napi_blob_id(env, in->fields, 9);
    in->row->origintype_id = ta_napi_blob_id(env, in->fields, 10);
    made[0] = ta_napi_kept_string(env, &(ta_napi_kept_at){names, in->row->name_id}, made[0]);
    for (uint32_t i = 0; i < 3; i++) { /* the type: one of the datamodel's three */
        bool same = false;
        if (napi_get_element(env, strings, i, &field) == napi_ok && napi_strict_equals(env, field, made[1], &same) == napi_ok && same)
            made[1] = field;
    }
    made[3] = ta_napi_kept_string(env, &(ta_napi_kept_at){origins, in->row->invoke_slot}, made[3]);
    uint32_t origintype = in->row->origintype_id < TA_NIL - 3 ? 3 + in->row->origintype_id : TA_NIL;
    made[4] = ta_napi_kept_string(env, &(ta_napi_kept_at){strings, origintype}, made[4]);
    made[5] = ta_napi_kept_string(env, &(ta_napi_kept_at){invokeids, in->row->invoke_slot}, made[5]);
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, made[6], &type) != napi_ok ||
        (type != napi_undefined && (made[6] = ta_napi_kit(env, in->kit, &(ta_napi_kit_call){"copy", 1, {made[6]}})) == NULL) ||
        napi_create_array_with_length(env, 8, &fields) != napi_ok)
        return NULL;
    for (uint32_t i = 0; i < 8; i++)
        if (napi_set_element(env, fields, i, made[i]) != napi_ok) return NULL;
    return ta_napi_kit(env, in->kit, &(ta_napi_kit_call){"event", 1, {fields}});
}

/* A session from a blob serialize wrote, for its chart now: a new scope
 * (or, for a declaring chart, a new context, its scripts' declarations
 * made again), the variables of the blob its chart declares (all of them
 * on a declaring session's global), and its _event. Every variable of the
 * blob is kept in the session's link as its `init` until the first event
 * or migrate takes it, as a spawn's params are: when the blob is of an
 * older version of the chart, migrate answers them as the old bindings. */
static ta_status ta_napi_deserialize(void *datamodel, const ta_datamodel_start *start, uint64_t *instance) {
    ta_napi_native *native = (ta_napi_native *)datamodel;
    napi_env env = native->host->env;
    ta_napi_frame frame;
    if (!ta_napi_frame_open(native, NULL, &frame)) return TA_ERROR_NO_MEMORY;
    uint64_t chart_handle = (uint64_t)(uintptr_t)start->chart_context;
    ta_napi_chart_row *found = (ta_napi_chart_row *)ta_table_get(&native->host->charts, chart_handle);
    ta_napi_chart_row chart = found != NULL ? *found : (ta_napi_chart_row){NULL, NULL, 0, 0, 0};
    ta_napi_session_row row = {chart_handle, TA_NIL, TA_NIL, TA_NIL};
    napi_value state = NULL, vars = NULL, fields = NULL, made = NULL, record, kit, target, context, shared, undefined, event;
    napi_valuetype type = napi_undefined;
    bool ok = found != NULL && napi_get_undefined(env, &undefined) == napi_ok && ta_napi_keep_strings(native, start->system_variables) &&
              (record = ta_napi_native_get(native, chart.functions)) != NULL &&
              (state = ta_napi_value_read(env, start->state)) != NULL && napi_typeof(env, state, &type) == napi_ok &&
              type == napi_object && napi_get_named_property(env, state, "vars", &vars) == napi_ok &&
              napi_typeof(env, vars, &type) == napi_ok && type == napi_object &&
              napi_get_named_property(env, state, "event", &fields) == napi_ok &&
              (made = ta_napi_session_new(native, &(ta_napi_start_of){&chart, start->system_variables, vars, NULL})) != NULL;
    if (ok && (chart.flags & TA_NAPI_CHART_DECLARES)) /* its own context: the declarations again, then the values */
        ok = napi_get_element(env, made, TA_NAPI_OWN_KIT, &kit) == napi_ok &&
             napi_get_element(env, made, TA_NAPI_OWN_CONTEXT, &context) == napi_ok &&
             napi_get_named_property(env, kit, "global", &target) == napi_ok && ta_napi_realm_hoist(native, record, context);
    else if (ok)
        ok = (shared = ta_napi_realm_shared(native)) != NULL && napi_get_element(env, shared, TA_NAPI_REALM_KIT, &kit) == napi_ok &&
             (target = made) != NULL;
    ok = ok && ta_napi_kit(env, kit, &(ta_napi_kit_call){"restore", 2, {target, vars}}) != NULL &&
         napi_typeof(env, fields, &type) == napi_ok;
    if (ok && type != napi_null && type != napi_undefined) {
        event = ta_napi_event_from(native, &(ta_napi_event_in){fields, kit, record, &row});
        napi_property_descriptor property = {"_event", NULL, NULL, NULL, NULL, event, napi_enumerable | napi_configurable, NULL};
        ok = event != NULL && napi_define_properties(env, target, 1, &property) == napi_ok;
    }
    ta_status status = TA_OK;
    if (!ok) status = (ta_napi_failed(env), TA_ERROR_INVALID);
    uint64_t handle = 0;
    ta_napi_session_row *added = status == TA_OK ? (ta_napi_session_row *)ta_table_add(&native->host->sessions, &handle) : NULL;
    if (status == TA_OK && added == NULL) status = TA_ERROR_NO_MEMORY;
    if (added != NULL && !ta_napi_slot_hold(native, &(ta_napi_slot){&native->scopes, handle}, made)) {
        ta_table_remove(&native->host->sessions, handle);
        added = NULL;
        status = (ta_napi_failed(env), TA_ERROR_INVALID);
    }
    if (added != NULL) {
        *added = row;
        *instance = handle;
    }
    ta_napi_frame_close(&frame);
    return status;
}

/* After deserialize, when the blob was written for an older version of
 * the chart: the old bindings, exactly the old chart's variables as the
 * blob held them, as one payload (an object of name -> value), taken from
 * the link; on a declaring session's global the old variables the new
 * chart does not declare are dropped. Core then initializes the new
 * chart's added <data> and raises error.platform.upgrade with it. */
static ta_status ta_napi_migrate(const ta_datamodel_call *call, ta_payload *bindings) {
    *bindings = 0;
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_INVALID;
    ta_napi_evaluation *evaluation = &entry.evaluation;
    napi_env env = evaluation->env;
    napi_value old = ta_napi_kit(env, evaluation->kit, &(ta_napi_kit_call){"upgrade", 1, {evaluation->scope}});
    napi_valuetype type = napi_undefined;
    ta_status status = TA_OK;
    if (old == NULL || napi_typeof(env, old, &type) != napi_ok) status = ta_napi_failed(env);
    else if (type == napi_object && !ta_napi_native_payload(evaluation->native, old, bindings)) {
        napi_value error = NULL;
        napi_get_and_clear_last_exception(env, &error);
        status = TA_ERROR_NO_MEMORY; /* the blob's values are the value table's: only memory refuses them */
    }
    ta_napi_frame_close(&entry.frame);
    return status;
}

/* ---- neutral values ------------------------------------------------------------------ */

/* A payload as one CBOR document in the output: to_wire's (`wire`), or the
 * value table's for payload_serialize; the document's refusal, or NULL
 * row's TA_ERROR_INVALID. */
typedef struct ta_napi_payload_out {
    ta_payload payload;
    bool wire;
    ta_bytes *out;
} ta_napi_payload_out;

static ta_status ta_napi_payload_document(ta_napi_native *native, const ta_napi_payload_out *payload) {
    napi_env env = native->host->env;
    ta_napi_frame frame;
    *payload->out = (ta_bytes){NULL, 0};
    if (ta_table_get(&native->host->payloads, payload->payload) == NULL) return TA_ERROR_INVALID;
    if (!ta_napi_frame_open(native, native->environment, &frame)) return TA_ERROR_NO_MEMORY;
    ta_napi_document document;
    memset(&document, 0, sizeof document);
    document.room = (ta_napi_room){&native->output, &native->host->allocator, {NULL, 0}};
    document.arena = &native->host->arena;
    document.wire = payload->wire;
    ta_napi_document_open(&document);
    bool ok = ta_napi_document_value(env, ta_napi_native_value(native, payload->payload), &document);
    if (!ok) ta_napi_failed(env);
    ta_status status = ta_napi_document_close(&document, ok) ? TA_OK : ta_napi_unstored(&document);
    if (status == TA_OK) *payload->out = document.out;
    ta_napi_frame_close(&frame);
    return status;
}

/* A payload as CBOR (values.txt's ECMAScript to_wire), in the output:
 * TA_ERROR_INVALID when it cannot be a neutral value. */
static ta_status ta_napi_to_wire(void *datamodel, ta_payload payload, ta_bytes *out) {
    ta_status status = ta_napi_payload_document((ta_napi_native *)datamodel, &(ta_napi_payload_out){payload, true, out});
    return status == TA_ERROR_UNSUPPORTED ? TA_ERROR_INVALID : status;
}

/* A payload as the value table's CBOR (a delayed send's in an export blob):
 * TA_ERROR_UNSUPPORTED for a value outside the table. */
static ta_status ta_napi_payload_serialize(void *datamodel, ta_payload payload, ta_bytes *out) {
    return ta_napi_payload_document((ta_napi_native *)datamodel, &(ta_napi_payload_out){payload, false, out});
}

/* A payload from CBOR: read, then copied into the shared context. */
static ta_status ta_napi_from_wire(void *datamodel, ta_bytes cbor, ta_payload *out) {
    ta_napi_native *native = (ta_napi_native *)datamodel;
    napi_env env = native->host->env;
    ta_napi_frame frame;
    if (!ta_napi_frame_open(native, native->environment, &frame)) return TA_ERROR_NO_MEMORY;
    napi_value value = ta_napi_value_read(env, cbor);
    ta_status status = value != NULL && ta_napi_native_payload(native, value, out) ? TA_OK : TA_ERROR_INVALID;
    if (status != TA_OK) ta_napi_failed(env);
    ta_napi_frame_close(&frame);
    return status;
}

/* A <data> variable for inspection (actor.context): the value itself as a
 * payload, which core writes out with to_wire at once and releases; not
 * a copy, which would refuse what to_wire writes (a function dropped, a
 * Date as its JSON). */
static ta_status ta_napi_variable(const ta_datamodel_call *call, ta_string_view name, ta_payload *out) {
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(call, &entry)) return TA_ERROR_INVALID;
    ta_napi_evaluation *evaluation = &entry.evaluation;
    napi_env env = evaluation->env;
    bool declared = false;
    uint32_t count = ta_image_data_count(evaluation->row.image, evaluation->row.chart);
    for (uint32_t i = 0; i < count && !declared; i++) {
        ta_data_info info;
        declared = ta_image_data(evaluation->row.image, (ta_chart_item){evaluation->row.chart, i}, &info) == TA_OK &&
                   info.id.length == name.length && memcmp(info.id.pointer, name.pointer, name.length) == 0;
    }
    napi_value key, value;
    napi_valuetype type = napi_undefined;
    ta_status status = declared && napi_create_string_utf8(env, name.pointer, name.length, &key) == napi_ok &&
                               napi_get_property(env, evaluation->scope, key, &value) == napi_ok &&
                               napi_typeof(env, value, &type) == napi_ok
                           ? TA_OK
                           : TA_ERROR_INVALID;
    *out = 0; /* undefined: no payload, which core writes as CBOR undefined (datamodel.h) */
    if (status == TA_OK && type != napi_undefined) status = ta_napi_native_add(evaluation->native, value, out);
    if (status != TA_OK) ta_napi_failed(env);
    ta_napi_frame_close(&entry.frame);
    return status;
}

/* ---- snapshots: the tables' namespaces and every row's values ------------------ */

/* Where a snapshot's state goes: the outer writer, which grows through the
 * host's allocator. */
typedef struct ta_napi_snapshot_out {
    ta_napi_native *native;
    ta_cbor_writer *writer;
} ta_napi_snapshot_out;

/* One value as CBOR bytes of its own, appended to the writer, so a value
 * nests as deep in a snapshot as in a send: TA_OK, or the refusal's status
 * (TA_ERROR_EXECUTION: an exception) with the exception pending. */
static ta_status ta_napi_snapshot_value(const ta_napi_snapshot_out *out, napi_value value) {
    ta_napi_native *native = out->native;
    napi_env env = native->host->env;
    ta_napi_document document;
    memset(&document, 0, sizeof document);
    document.room = (ta_napi_room){&native->output, &native->host->allocator, {NULL, 0}};
    document.arena = &native->host->arena;
    ta_napi_document_open(&document);
    bool ok = ta_napi_document_value(env, value, &document);
    if (!ok && document.refused == TA_OK) document.refused = TA_ERROR_EXECUTION;
    if (!ta_napi_document_close(&document, ok)) {
        if (ok) ta_napi_throw(env, &(ta_napi_refusal){document.refused, "no memory for the snapshot"});
        return document.refused == TA_OK ? TA_ERROR_NO_MEMORY : document.refused;
    }
    ta_cbor_write_bytes(out->writer, document.out);
    return TA_OK;
}

/* A refusal of the snapshot because of a session's value: the pending
 * exception becomes the reason (which variable, and why), thrown as
 * TA_ERROR_UNSUPPORTED; no memory stays itself. */
typedef struct ta_napi_unstorable {
    const char *what; /* "variable '", "_event", "the params" */
    napi_value name;  /* the variable's, or NULL */
    ta_status status; /* the value's refusal */
} ta_napi_unstorable;

static bool ta_napi_snapshot_refuse(ta_napi_native *native, const ta_napi_unstorable *unstorable) {
    napi_env env = native->host->env;
    if (unstorable->status == TA_ERROR_NO_MEMORY) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the snapshot"});
        return false;
    }
    if (unstorable->what != NULL) ta_napi_reason(native, unstorable->what, unstorable->name);
    ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_UNSUPPORTED, native->reason});
    return false;
}

/* A table's handle namespace (ta_table_snapshot) as bytes, written in the
 * datamodel's output first. */
static bool ta_napi_snapshot_layout(const ta_napi_snapshot_out *out, const ta_table *table) {
    ta_napi_native *native = out->native;
    ta_buffer probe = {NULL, 0, 0};
    ta_table_snapshot(table, &probe); /* TA_ERROR_NO_MEMORY: probe.length is the room */
    ta_napi_room room = {&native->output, &native->host->allocator, {NULL, 0}};
    bool ok = ta_napi_room_grow(&room, probe.length > 0 ? probe.length : 1);
    ta_buffer layout = {native->output.pointer, native->output.capacity, 0};
    ok = ok && ta_table_snapshot(table, &layout) == TA_OK;
    if (ok) ta_cbor_write_bytes(out->writer, (ta_bytes){layout.pointer, layout.length});
    else ta_napi_throw(native->host->env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for the snapshot"});
    return ok;
}

/* One session row: [handle, segment, chart index, {name: bytes}, _event's
 * fields as bytes (null when no event came), the link's [sessionid, name,
 * processors] as bytes, its init as bytes or null, the names a restore
 * added as bytes]. Its variables are what hibernation writes. */
static bool ta_napi_snapshot_session(const ta_napi_snapshot_out *out, uint32_t slot) {
    ta_napi_native *native = out->native;
    ta_napi_host *host = native->host;
    napi_env env = host->env;
    uint64_t handle = ta_table_handle(&host->sessions, slot);
    ta_napi_session_row row = *(ta_napi_session_row *)ta_table_at(&host->sessions, slot);
    ta_datamodel_call call = {native, handle, NULL};
    ta_napi_entry entry;
    if (!ta_napi_enter_entry(&call, &entry)) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, "a session without its chart"});
        return false;
    }
    ta_napi_evaluation *evaluation = &entry.evaluation;
    native->reason[0] = '\0';
    bool ok = true;
    if (evaluation->row.flags & TA_NAPI_CHART_LEXICAL) {
        ta_napi_reason_add(native, "a session of a chart whose scripts declare with let, const or class at their top "
                                   "level: a new context cannot be given those bindings again");
        ok = ta_napi_snapshot_refuse(native, &(ta_napi_unstorable){NULL, NULL, TA_ERROR_UNSUPPORTED});
    }
    napi_value remade = NULL, variables = NULL, names = NULL, values = NULL, event = NULL, link = NULL, name, value, part;
    napi_valuetype type = napi_undefined;
    uint32_t count = 0;
    ok = ok && napi_get_element(env, evaluation->record, TA_NAPI_CHART_FUNCTIONS, &remade) == napi_ok &&
         napi_typeof(env, remade, &type) == napi_ok && (type == napi_object || napi_create_array(env, &remade) == napi_ok) &&
         (variables = ta_napi_kit(env, evaluation->kit, &(ta_napi_kit_call){"stored", 2, {evaluation->scope, remade}})) != NULL &&
         napi_get_element(env, variables, 0, &names) == napi_ok && napi_get_element(env, variables, 1, &values) == napi_ok &&
         napi_get_array_length(env, names, &count) == napi_ok &&
         napi_get_named_property(env, evaluation->scope, "_event", &event) == napi_ok &&
         (link = ta_napi_kit(env, evaluation->kit, &(ta_napi_kit_call){"linked", 1, {evaluation->scope}})) != NULL;
    ta_cbor_writer *writer = out->writer;
    ta_napi_room room = {&native->output, &host->allocator, {NULL, 0}};
    if (ok) {
        ta_cbor_write_array(writer, 8);
        ta_cbor_write_uint(writer, handle);
        ta_cbor_write_uint(writer, evaluation->row.segment);
        ta_cbor_write_uint(writer, evaluation->row.chart);
        ta_cbor_write_map(writer, count);
    }
    for (uint32_t i = 0; ok && i < count; i++) {
        ok = napi_get_element(env, names, i, &name) == napi_ok && napi_get_element(env, values, i, &value) == napi_ok &&
             ta_napi_text_kept(env, name, &room); /* the name's UTF-8 in the output, copied into the writer */
        if (ok) ta_cbor_write_text(writer, room.view);
        ta_status status = ok ? ta_napi_snapshot_value(out, value) : TA_OK;
        if (status != TA_OK) ok = ta_napi_snapshot_refuse(native, &(ta_napi_unstorable){"variable '", name, status});
    }
    if (ok) { /* _event, as a blob holds it */
        ta_napi_document document;
        memset(&document, 0, sizeof document);
        document.room = (ta_napi_room){&native->output, &host->allocator, {NULL, 0}};
        document.arena = &host->arena;
        ta_napi_document_open(&document);
        bool written = ta_napi_event_write(native, &(ta_napi_event_out){event, &row}, &document);
        if (ta_napi_document_close(&document, written)) ta_cbor_write_bytes(writer, document.out);
        else ok = ta_napi_snapshot_refuse(native, &(ta_napi_unstorable){NULL, NULL,
                                                                       written ? TA_ERROR_NO_MEMORY : TA_ERROR_UNSUPPORTED});
    }
    /* the link: [sessionid, name, processors], then init and added */
    napi_value system = NULL, init = NULL, added = NULL;
    ok = ok && napi_create_array_with_length(env, 3, &system) == napi_ok;
    for (uint32_t i = 0; ok && i < 3; i++)
        ok = napi_get_element(env, link, i, &part) == napi_ok && napi_set_element(env, system, i, part) == napi_ok;
    ok = ok && napi_get_element(env, link, 3, &init) == napi_ok && napi_get_element(env, link, 4, &added) == napi_ok;
    if (ok) {
        ta_status status = ta_napi_snapshot_value(out, system);
        if (status != TA_OK) ok = ta_napi_snapshot_refuse(native, &(ta_napi_unstorable){"the system variables", NULL, status});
    }
    if (ok && napi_typeof(env, init, &type) == napi_ok && type == napi_undefined) ta_cbor_write_simple(writer, TA_CBOR_NULL);
    else if (ok) {
        ta_status status = ta_napi_snapshot_value(out, init);
        if (status != TA_OK) ok = ta_napi_snapshot_refuse(native, &(ta_napi_unstorable){"the params", NULL, status});
    }
    if (ok) {
        ta_status status = ta_napi_snapshot_value(out, added);
        if (status != TA_OK) ok = ta_napi_snapshot_refuse(native, &(ta_napi_unstorable){"the session", NULL, status});
    }
    ta_napi_frame_close(&entry.frame);
    return ok;
}

/* A payload row [handle, references, bytes] or a <foreach>'s [handle,
 * bytes], in a handle scope of its own. */
typedef struct ta_napi_snapshot_row {
    ta_table *table;
    uint32_t slot;
    bool payload;
} ta_napi_snapshot_row;

static bool ta_napi_snapshot_other(const ta_napi_snapshot_out *out, const ta_napi_snapshot_row *row) {
    ta_napi_native *native = out->native;
    napi_env env = native->host->env;
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) return false;
    uint64_t handle = ta_table_handle(row->table, row->slot);
    napi_value value;
    if (row->payload) {
        ta_napi_payload_row *payload = (ta_napi_payload_row *)ta_table_at(row->table, row->slot);
        ta_cbor_write_array(out->writer, 3);
        ta_cbor_write_uint(out->writer, handle);
        ta_cbor_write_uint(out->writer, payload->count);
        value = ta_napi_native_value(native, handle);
    } else {
        ta_napi_loop_row *loop = (ta_napi_loop_row *)ta_table_at(row->table, row->slot);
        ta_cbor_write_array(out->writer, 2);
        ta_cbor_write_uint(out->writer, handle);
        value = ta_napi_native_get(native, loop->items);
        if (value == NULL) napi_get_undefined(env, &value);
    }
    native->reason[0] = '\0';
    ta_status status = ta_napi_snapshot_value(out, value);
    bool ok = status == TA_OK ||
              ta_napi_snapshot_refuse(native, &(ta_napi_unstorable){row->payload ? "a payload" : "a <foreach>'s items", NULL, status});
    napi_close_handle_scope(env, scope);
    return ok;
}

bool ta_napi_native_snapshot(ta_napi_native *native, ta_cbor_writer *writer) {
    ta_napi_host *host = native->host;
    ta_napi_snapshot_out out = {native, writer};
    ta_cbor_write_map(writer, 6);
    ta_table *tables[] = {&host->sessions, &host->payloads, &host->loops};
    static const ta_string_view layouts[] = {{"sessions", 8}, {"payloads", 8}, {"loops", 5}};
    bool ok = true;
    for (uint32_t i = 0; ok && i < 3; i++) {
        ta_cbor_write_text(writer, layouts[i]);
        ok = ta_napi_snapshot_layout(&out, tables[i]);
    }
    if (ok) {
        ta_cbor_write_text(writer, (ta_string_view){"rows", 4});
        ta_cbor_write_array(writer, host->sessions.count);
    }
    for (uint32_t slot = 0; ok && slot < host->sessions.capacity; slot++)
        if (ta_table_at(&host->sessions, slot) != NULL) ok = ta_napi_snapshot_session(&out, slot);
    if (ok) {
        ta_cbor_write_text(writer, (ta_string_view){"values", 6});
        ta_cbor_write_array(writer, host->payloads.count);
    }
    for (uint32_t slot = 0; ok && slot < host->payloads.capacity; slot++)
        if (ta_table_at(&host->payloads, slot) != NULL)
            ok = ta_napi_snapshot_other(&out, &(ta_napi_snapshot_row){&host->payloads, slot, true});
    if (ok) {
        ta_cbor_write_text(writer, (ta_string_view){"items", 5});
        ta_cbor_write_array(writer, host->loops.count);
    }
    for (uint32_t slot = 0; ok && slot < host->loops.capacity; slot++)
        if (ta_table_at(&host->loops, slot) != NULL)
            ok = ta_napi_snapshot_other(&out, &(ta_napi_snapshot_row){&host->loops, slot, false});
    return ok;
}

/* ---- restore ----------------------------------------------------------------------- */

static bool ta_napi_restore_refuse(napi_env env, const char *message) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return false; /* the first error says more */
    ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_INVALID, message});
    return false;
}

/* An unsigned integer of the snapshot (a number, or a bigint past 2^53). */
static bool ta_napi_restore_uint(napi_env env, napi_value value, uint64_t *out) {
    napi_valuetype type = napi_undefined;
    double number = -1;
    bool lossless = false;
    if (value == NULL || napi_typeof(env, value, &type) != napi_ok) return false;
    if (type == napi_bigint) return napi_get_value_bigint_uint64(env, value, out, &lossless) == napi_ok && lossless;
    if (type != napi_number || napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0) ||
        number > 9007199254740991.0 || number != (double)(uint64_t)number)
        return false;
    *out = (uint64_t)number;
    return true;
}

/* The value of a snapshot's bytes (a Uint8Array), made in the application's
 * realm; NULL with an exception pending. */
static napi_value ta_napi_restore_value(napi_env env, napi_value bytes) {
    ta_napi_bytes view = {"not a snapshot of the native datamodel", {NULL, 0}};
    if (!ta_napi_bytes_of(env, bytes, &view)) return NULL;
    return ta_napi_value_read(env, view.view);
}

/* A table's namespace back from its bytes. */
static bool ta_napi_restore_layout(napi_env env, ta_table *table, napi_value layout) {
    ta_napi_bytes view = {"not a snapshot of the native datamodel", {NULL, 0}};
    if (!ta_napi_bytes_of(env, layout, &view)) return false;
    ta_status status = ta_table_restore(table, view.view);
    if (status == TA_OK) return true;
    ta_napi_throw(env, &(ta_napi_refusal){status, status == TA_ERROR_NO_MEMORY ? "no memory for the restore"
                                                                               : "a table of the snapshot does not restore"});
    return false;
}

/* The strings of _event (ta_napi_keep_strings) from a restored session's
 * processors, [type, location] pairs: every session of a host has the same. */
static bool ta_napi_restore_strings(ta_napi_native *native, napi_value processors) {
    if (native->strings != NULL) return true;
    napi_env env = native->host->env;
    static const char *const types[] = {"platform", "internal", "external"};
    napi_value strings, string, pair;
    uint32_t count = 0;
    if (napi_create_array(env, &strings) != napi_ok || napi_get_array_length(env, processors, &count) != napi_ok) return false;
    for (uint32_t i = 0; i < 3; i++)
        if (napi_create_string_utf8(env, types[i], NAPI_AUTO_LENGTH, &string) != napi_ok ||
            napi_set_element(env, strings, i, string) != napi_ok)
            return false;
    for (uint32_t i = 0; i < count; i++)
        if (napi_get_element(env, processors, i, &pair) != napi_ok || napi_get_element(env, pair, 0, &string) != napi_ok ||
            napi_set_element(env, strings, 3 + i, string) != napi_ok)
            return false;
    return napi_create_reference(env, strings, 1, &native->strings) == napi_ok;
}

/* The chart row of a session's attachment, by its segment and index (the
 * restore attached the charts again under new handles); 0 for none. The
 * last found is tried first: a population mostly shares a chart. */
typedef struct ta_napi_attachment {
    uint32_t segment, chart;
    uint64_t found; /* in: the last one found; out: this one's */
} ta_napi_attachment;

static void ta_napi_restore_chart(ta_napi_native *native, ta_napi_attachment *attachment) {
    ta_table *charts = &native->host->charts;
    ta_napi_chart_row *last = attachment->found ? (ta_napi_chart_row *)ta_table_get(charts, attachment->found) : NULL;
    if (last != NULL && last->segment == attachment->segment && last->chart == attachment->chart) return;
    attachment->found = 0;
    for (uint32_t slot = 0; slot < charts->capacity && attachment->found == 0; slot++) {
        ta_napi_chart_row *row = (ta_napi_chart_row *)ta_table_at(charts, slot);
        if (row != NULL && row->segment == attachment->segment && row->chart == attachment->chart)
            attachment->found = ta_table_handle(charts, slot);
    }
}

/* One session back at its handle: a new scope (or a new context, its
 * scripts' declarations made again), its link from the snapshot's, its
 * variables, its _event. */
typedef struct ta_napi_session_in {
    napi_value entry;
    ta_napi_attachment *attachment;
} ta_napi_session_in;

static bool ta_napi_restore_session(ta_napi_native *native, const ta_napi_session_in *in) {
    napi_env env = native->host->env;
    napi_value parts[8], system, processors, init, vars, given, keys, name, value, event_fields, added, record, kit, target, context,
        shared, made, undefined;
    uint32_t length = 0;
    bool array = false;
    if (napi_is_array(env, in->entry, &array) != napi_ok || !array || napi_get_array_length(env, in->entry, &length) != napi_ok ||
        length != 8)
        return ta_napi_restore_refuse(env, "not a session of a snapshot");
    for (uint32_t i = 0; i < 8; i++)
        if (napi_get_element(env, in->entry, i, &parts[i]) != napi_ok) return false;
    uint64_t handle = 0, segment = 0, index = 0;
    if (!ta_napi_restore_uint(env, parts[0], &handle) || !ta_napi_restore_uint(env, parts[1], &segment) ||
        !ta_napi_restore_uint(env, parts[2], &index) || segment > UINT32_MAX || index > UINT32_MAX)
        return ta_napi_restore_refuse(env, "not a session of a snapshot");
    in->attachment->segment = (uint32_t)segment;
    in->attachment->chart = (uint32_t)index;
    ta_napi_restore_chart(native, in->attachment);
    ta_napi_chart_row *found = (ta_napi_chart_row *)ta_table_get(&native->host->charts, in->attachment->found);
    ta_napi_session_row *slot = (ta_napi_session_row *)ta_table_get(&native->host->sessions, handle);
    if (found == NULL) return ta_napi_restore_refuse(env, "a session whose chart the restored host does not have");
    if (slot == NULL || slot->chart != 0) return ta_napi_restore_refuse(env, "a session the snapshot's tables do not hold, or twice");
    ta_napi_chart_row chart = *found;
    ta_napi_session_row row = {in->attachment->found, TA_NIL, TA_NIL, TA_NIL};
    napi_valuetype type = napi_undefined;
    uint32_t count = 0;
    bool ok = napi_get_undefined(env, &undefined) == napi_ok && (record = ta_napi_native_get(native, chart.functions)) != NULL &&
              (system = ta_napi_restore_value(env, parts[5])) != NULL && napi_is_array(env, system, &array) == napi_ok && array &&
              napi_get_element(env, system, 2, &processors) == napi_ok && napi_is_array(env, processors, &array) == napi_ok &&
              array && ta_napi_restore_strings(native, processors) && (shared = ta_napi_realm_shared(native)) != NULL &&
              napi_get_element(env, shared, TA_NAPI_REALM_KIT, &kit) == napi_ok && napi_typeof(env, parts[6], &type) == napi_ok;
    init = undefined;
    if (ok && type != napi_null) /* the params, in the shared context as a spawn's are */
        ok = (init = ta_napi_restore_value(env, parts[6])) != NULL &&
             (init = ta_napi_kit(env, kit, &(ta_napi_kit_call){"copy", 1, {init}})) != NULL;
    /* the variables, each from its own bytes */
    given = parts[3];
    ok = ok && napi_typeof(env, given, &type) == napi_ok && type == napi_object && napi_create_object(env, &vars) == napi_ok &&
         napi_get_property_names(env, given, &keys) == napi_ok && napi_get_array_length(env, keys, &count) == napi_ok;
    for (uint32_t i = 0; ok && i < count; i++)
        ok = napi_get_element(env, keys, i, &name) == napi_ok && napi_get_property(env, given, name, &value) == napi_ok &&
             (value = ta_napi_restore_value(env, value)) != NULL && napi_set_property(env, vars, name, value) == napi_ok;
    ok = ok && (made = ta_napi_session_new(native, &(ta_napi_start_of){&chart, NULL, init, system})) != NULL;
    if (ok && (chart.flags & TA_NAPI_CHART_DECLARES)) /* its own context: the declarations again, then the values */
        ok = napi_get_element(env, made, TA_NAPI_OWN_KIT, &kit) == napi_ok &&
             napi_get_element(env, made, TA_NAPI_OWN_CONTEXT, &context) == napi_ok &&
             napi_get_named_property(env, kit, "global", &target) == napi_ok && ta_napi_realm_hoist(native, record, context);
    else if (ok) target = made;
    ok = ok && ta_napi_kit(env, kit, &(ta_napi_kit_call){"restore", 2, {target, vars}}) != NULL &&
         (added = ta_napi_restore_value(env, parts[7])) != NULL &&
         ta_napi_kit(env, kit, &(ta_napi_kit_call){"relink", 2, {target, added}}) != NULL &&
         (event_fields = ta_napi_restore_value(env, parts[4])) != NULL && napi_typeof(env, event_fields, &type) == napi_ok;
    if (ok && type != napi_null && type != napi_undefined) {
        napi_value event = ta_napi_event_from(native, &(ta_napi_event_in){event_fields, kit, record, &row});
        napi_property_descriptor property = {"_event", NULL, NULL, NULL, NULL, event, napi_enumerable | napi_configurable, NULL};
        ok = event != NULL && napi_define_properties(env, target, 1, &property) == napi_ok;
    }
    if (!ok) return ta_napi_restore_refuse(env, "not a session of a snapshot");
    if (!ta_napi_slot_hold(native, &(ta_napi_slot){&native->scopes, handle}, made)) return false;
    slot = (ta_napi_session_row *)ta_table_get(&native->host->sessions, handle); /* JavaScript ran: get it again */
    *slot = row;
    return true;
}

/* A payload's or a <foreach>'s row back at its handle, its value copied
 * into the shared context. */
typedef struct ta_napi_other_in {
    napi_value entry;
    bool payload;
} ta_napi_other_in;

static bool ta_napi_restore_other(ta_napi_native *native, const ta_napi_other_in *in) {
    napi_env env = native->host->env;
    napi_value parts[3], shared, kit, value;
    uint32_t length = 0, want = in->payload ? 3 : 2;
    bool array = false;
    uint64_t handle = 0, references = 1;
    const char *what = in->payload ? "a payload the snapshot's tables do not hold, or twice"
                                   : "a <foreach> the snapshot's tables do not hold, or twice";
    if (napi_is_array(env, in->entry, &array) != napi_ok || !array || napi_get_array_length(env, in->entry, &length) != napi_ok ||
        length != want)
        return ta_napi_restore_refuse(env, what);
    for (uint32_t i = 0; i < want; i++)
        if (napi_get_element(env, in->entry, i, &parts[i]) != napi_ok) return false;
    if (!ta_napi_restore_uint(env, parts[0], &handle) || (in->payload && (!ta_napi_restore_uint(env, parts[1], &references) ||
                                                                          references == 0 || references > UINT32_MAX)))
        return ta_napi_restore_refuse(env, what);
    ta_table *table = in->payload ? &native->host->payloads : &native->host->loops;
    void *row = ta_table_get(table, handle); /* a payload's count, a loop's reference: 0 until filled */
    if (row == NULL || (in->payload ? ((ta_napi_payload_row *)row)->count != 0 : ((ta_napi_loop_row *)row)->items != NULL))
        return ta_napi_restore_refuse(env, what);
    napi_valuetype type = napi_undefined;
    if ((shared = ta_napi_realm_shared(native)) == NULL || napi_get_element(env, shared, TA_NAPI_REALM_KIT, &kit) != napi_ok ||
        (value = ta_napi_restore_value(env, parts[want - 1])) == NULL ||
        (value = ta_napi_kit(env, kit, &(ta_napi_kit_call){"copy", 1, {value}})) == NULL)
        return ta_napi_restore_refuse(env, what);
    if (napi_typeof(env, value, &type) != napi_ok) return false;
    bool object = type == napi_object || type == napi_function;
    if (!in->payload && !object) return ta_napi_restore_refuse(env, "a <foreach>'s items are not an array");
    napi_ref reference = NULL; /* as ta_napi_native_add holds them: a primitive payload in `values` */
    if (object ? napi_create_reference(env, value, 1, &reference) != napi_ok
               : !ta_napi_slot_hold(native, &(ta_napi_slot){&native->values, handle}, value))
        return false;
    row = ta_table_get(table, handle); /* JavaScript ran: get it again */
    if (in->payload) *(ta_napi_payload_row *)row = (ta_napi_payload_row){reference, (uint32_t)references};
    else ((ta_napi_loop_row *)row)->items = reference;
    return true;
}

/* The name of the snapshot's next member, in the order
 * ta_napi_native_snapshot writes them. */
static bool ta_napi_restore_key(ta_napi_decoder *decoder, ta_string_view name) {
    ta_cbor_item item;
    return ta_cbor_read(&decoder->reader, &item) == 1 && item.kind == TA_CBOR_TEXT && item.bytes.length == name.length &&
           memcmp(item.bytes.pointer, name.pointer, name.length) == 0;
}

/* The state goes into JavaScript a row at a time: the decoder reads the
 * map's heads itself and makes one row's value, then the next, so a
 * population of sessions is never one value in the engine's heap (as one
 * value, a million rows made each restore's collections slower than the
 * last: tools/scale.mjs, "restore"). */
bool ta_napi_native_restore(ta_napi_native *native, ta_bytes bytes) {
    ta_napi_host *host = native->host;
    napi_env env = host->env;
    if (host->sessions.count || host->payloads.count || host->loops.count) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_STATE, "the native datamodel is not a fresh one"});
        return false;
    }
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) return false;
    static const ta_string_view names[] = {{"sessions", 8}, {"payloads", 8}, {"loops", 5},
                                           {"rows", 4},     {"values", 6},   {"items", 5}};
    ta_table *tables[] = {&host->sessions, &host->payloads, &host->loops};
    ta_napi_decoder decoder;
    ta_napi_decoder_init(&decoder, env, bytes);
    ta_cbor_item item;
    bool ok = ta_cbor_read(&decoder.reader, &item) == 1 && item.kind == TA_CBOR_MAP && item.count == 6;
    for (uint32_t i = 0; ok && i < 3; i++) {
        napi_value layout;
        ok = ta_napi_restore_key(&decoder, names[i]) && (layout = ta_napi_decoder_next(&decoder)) != NULL &&
             ta_napi_restore_layout(env, tables[i], layout);
    }
    ta_napi_attachment attachment = {0, 0, 0};
    for (uint32_t k = 0; ok && k < 3; k++) {
        /* every live handle has its row, once */
        ok = ta_napi_restore_key(&decoder, names[3 + k]) && ta_cbor_read(&decoder.reader, &item) == 1 &&
             item.kind == TA_CBOR_ARRAY && item.count == tables[k]->count;
        for (uint32_t i = 0, rows = ok ? item.count : 0; ok && i < rows; i++) {
            napi_handle_scope row;
            napi_value entry;
            ok = napi_open_handle_scope(env, &row) == napi_ok;
            if (!ok) break;
            ok = (entry = ta_napi_decoder_next(&decoder)) != NULL &&
                 (k == 0 ? ta_napi_restore_session(native, &(ta_napi_session_in){entry, &attachment})
                         : ta_napi_restore_other(native, &(ta_napi_other_in){entry, k == 1}));
            napi_close_handle_scope(env, row);
        }
    }
    ok = ok && ta_cbor_read(&decoder.reader, &item) == 0; /* nothing after the map */
    if (!ok) ta_napi_restore_refuse(env, "not a snapshot of the native datamodel");
    napi_close_handle_scope(env, scope); /* the exception, if any, stays pending */
    return ok; /* on failure the host is freed: the rows filled so far go with it */
}

static const ta_datamodel_vtable ta_napi_vtable = {
    .size = sizeof(ta_datamodel_vtable),
    .flags = TA_DATAMODEL_EVENT_DETACHABLE,
    .name = "ecmascript",
    .chart_attach = ta_napi_chart_attach,
    .chart_detach = ta_napi_chart_detach,
    .create = ta_napi_create,
    .destroy = ta_napi_destroy,
    .init_data = ta_napi_init_data,
    .bind_event = ta_napi_bind_event,
    .detach_event = ta_napi_detach_event,
    .eval_condition = ta_napi_eval_condition,
    .eval_string = ta_napi_eval_string,
    .assign = ta_napi_assign_entry,
    .assign_string = ta_napi_assign_string,
    .script = ta_napi_script_entry,
    .log = ta_napi_log,
    .foreach_begin = ta_napi_foreach_begin,
    .foreach_item = ta_napi_foreach_item,
    .foreach_end = ta_napi_foreach_end,
    .capture = ta_napi_capture,
    .retain = ta_napi_native_retain,
    .release = ta_napi_native_release,
    .custom = ta_napi_custom,
    .serialize = ta_napi_serialize,
    .deserialize = ta_napi_deserialize,
    .migrate = ta_napi_migrate,
    .to_wire = ta_napi_to_wire,
    .from_wire = ta_napi_from_wire,
    .payload_serialize = ta_napi_payload_serialize,
    .payload_deserialize = ta_napi_from_wire, /* the same CBOR: one reference, copied into the shared context */
    .variable = ta_napi_variable,
    .failure = ta_napi_failure,
};

const ta_datamodel_vtable *ta_napi_native_vtable(void) {
    return &ta_napi_vtable;
}
