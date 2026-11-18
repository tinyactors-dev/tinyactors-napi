/* The native "ecmascript" datamodel's vtable, each entry forwarded to the
 * import ta_web.datamodel (docs/browser.md, "What is C and what is
 * JavaScript"): the entry, the row it is about, and the rest of its
 * arguments in the record, written right before the import and its answer
 * read right after. JavaScript does the datamodel's work (scopes,
 * evaluation, copies) with the value of each row at the row's slot.
 *
 * The rows are the host's tables, in C: a chart's (attach to detach), a
 * session's (create or deserialize to destroy), a payload's with its
 * reference count (retain and release never cross: at count 0 the row
 * goes and JavaScript drops the value, ta_web.datamodel DROP), a loop's
 * (foreach_begin to foreach_end). A row is added before the import that
 * fills its slot and removed when JavaScript refuses, so JavaScript never
 * holds a value at a slot C does not know.
 *
 * Outputs (eval_string, log, serialize, to_wire, payload_serialize, a
 * failure's message) are written by JavaScript into the host's output room
 * (ta_web_dm_output), valid until the datamodel's next call. */
#include "web.h"

#include <string.h>

/* The entries, as the import's `entry` names them. */
enum {
    TA_WEB_DM_ATTACH = 1,
    TA_WEB_DM_DETACH,
    TA_WEB_DM_CREATE,
    TA_WEB_DM_DESERIALIZE,
    TA_WEB_DM_DESTROY,
    TA_WEB_DM_INIT_DATA,
    TA_WEB_DM_BIND_EVENT,
    TA_WEB_DM_DETACH_EVENT,
    TA_WEB_DM_EVAL_CONDITION,
    TA_WEB_DM_EVAL_STRING,
    TA_WEB_DM_ASSIGN,
    TA_WEB_DM_ASSIGN_STRING,
    TA_WEB_DM_SCRIPT,
    TA_WEB_DM_LOG,
    TA_WEB_DM_FOREACH_BEGIN,
    TA_WEB_DM_FOREACH_ITEM,
    TA_WEB_DM_FOREACH_END,
    TA_WEB_DM_CAPTURE,
    TA_WEB_DM_DROP,
    TA_WEB_DM_CUSTOM,
    TA_WEB_DM_SERIALIZE,
    TA_WEB_DM_MIGRATE,
    TA_WEB_DM_TO_WIRE,
    TA_WEB_DM_FROM_WIRE,
    TA_WEB_DM_PAYLOAD_SERIALIZE,
    TA_WEB_DM_PAYLOAD_DESERIALIZE,
    TA_WEB_DM_VARIABLE,
    TA_WEB_DM_FAILURE
};

static uint32_t ta_web_slot(uint64_t handle) { return (uint32_t)handle - 1u; }

/* ---- the call: the import, with the evaluation's environment kept -------------------- */

/* What an entry asks of JavaScript: the entry, its row's slot, and the
 * environment its code may ask In() and charge of (NULL for the entries
 * that run outside a step). The record is filled by the caller. */
typedef struct ta_web_ask {
    uint32_t entry;
    uint32_t slot;
    ta_datamodel_environment *environment;
} ta_web_ask;

static ta_status ta_web_dm(ta_web_host *host, const ta_web_ask *ask) {
    ta_datamodel_environment *outer = host->evaluating;
    host->evaluating = ask->environment;
    host->env->depth++;
    int32_t status = ta_web_import_datamodel(host->id, ask->entry, ask->slot);
    host->env->depth--;
    host->evaluating = outer;
    return (ta_status)status;
}

static ta_web_host *ta_web_of(void *datamodel) { return (ta_web_host *)datamodel; }

/* The session row's slot of an instance, or TA_NIL for a handle the table
 * does not hold. */
static uint32_t ta_web_session_slot(ta_web_host *host, uint64_t instance) {
    return ta_table_get(&host->sessions, instance) != NULL ? ta_web_slot(instance) : TA_NIL;
}

static uint32_t *ta_web_words(ta_web_host *host) { return host->env->record.word; }

/* A per-instance entry whose arguments are already in the record. */
typedef struct ta_web_entry {
    const ta_datamodel_call *call;
    uint32_t entry;
} ta_web_entry;

static ta_status ta_web_instance(const ta_web_entry *entry) {
    ta_web_host *host = ta_web_of(entry->call->datamodel);
    uint32_t slot = ta_web_session_slot(host, entry->call->instance);
    if (slot == TA_NIL) return TA_ERROR_STALE;
    return ta_web_dm(host, &(ta_web_ask){entry->entry, slot, entry->call->environment});
}

/* ---- what JavaScript calls during an entry ------------------------------------------------- */

/* SCXML In() of the evaluating instance; 0 outside an entry that has an
 * environment. */
TA_WEB_EXPORT int32_t ta_web_dm_in(ta_web_host *host, uint32_t state) {
    return host->evaluating != NULL ? ta_datamodel_environment_in(host->evaluating, state) : 0;
}

/* Reports expensive work of the evaluating instance (core's fuel). */
TA_WEB_EXPORT void ta_web_dm_charge(ta_web_host *host, uint32_t fuel) {
    if (host->evaluating != NULL) ta_datamodel_environment_charge(host->evaluating, fuel);
}

/* Room for the datamodel's output of at least `size` bytes, the host's
 * one buffer kept between calls (its contents not kept when it grows);
 * 0 when the allocator refuses. JavaScript writes the output there and its
 * length in the record. */
TA_WEB_EXPORT uint32_t ta_web_dm_output(ta_web_host *host, uint32_t size) {
    if (size > host->output.capacity) {
        const ta_allocator *allocator = &host->env->allocator;
        size_t capacity = host->output.capacity ? host->output.capacity : 256;
        while (capacity < size) capacity *= 2;
        unsigned char *block = (unsigned char *)allocator->alloc(allocator->context, capacity, 8);
        if (block == NULL) return 0;
        if (host->output.pointer != NULL) allocator->free(allocator->context, host->output.pointer, host->output.capacity);
        host->output = (ta_buffer){block, capacity, 0};
    }
    return ta_web_address(host->output.pointer);
}

/* During a create or deserialize: the session's I/O processor `i`, its
 * type in the record's words 0-1 and its location in 2-3 (valid during
 * the entry only); 0 and empty outside one or past the count. */
TA_WEB_EXPORT uint32_t ta_web_dm_processor(ta_web_host *host, uint32_t i) {
    uint32_t *word = ta_web_words(host);
    const ta_datamodel_start *start = host->env->start;
    ta_string_view none = {"", 0};
    if (start == NULL || start->system_variables == NULL || i >= start->system_variables->io_processor_count) {
        ta_web_set_text(word, 0, none);
        ta_web_set_text(word, 2, none);
        return 0;
    }
    ta_web_set_text(word, 0, start->system_variables->io_processors[i].type);
    ta_web_set_text(word, 2, start->system_variables->io_processors[i].location);
    return 1;
}

/* ---- a chart's image, by its row ------------------------------------------------------------- */

static const ta_web_chart_row *ta_web_chart_at(const ta_web_host *host, uint32_t slot) {
    return (const ta_web_chart_row *)ta_table_at(&host->charts, slot);
}

TA_WEB_EXPORT uint32_t ta_web_chart_expression_count(const ta_web_host *host, uint32_t slot) {
    const ta_web_chart_row *row = ta_web_chart_at(host, slot);
    return row != NULL ? ta_image_expression_count(row->image, row->chart) : 0;
}

/* Expression `e` of the chart at `slot`: [status, kind, line, column,
 * source (2 words)], the source a view of the image (valid while the
 * chart is attached). */
TA_WEB_EXPORT int32_t ta_web_chart_expression(ta_web_host *host, uint32_t slot, uint32_t e) {
    const ta_web_chart_row *row = ta_web_chart_at(host, slot);
    uint32_t *word = ta_web_words(host);
    ta_expression_info info = {0, 0, 0, {"", 0}};
    ta_status status = row != NULL ? ta_image_expression(row->image, (ta_chart_item){row->chart, e}, &info) : TA_ERROR_STALE;
    word[0] = (uint32_t)status;
    word[1] = info.kind;
    word[2] = info.line;
    word[3] = info.column;
    ta_web_set_text(word, 4, info.source);
    return status;
}

TA_WEB_EXPORT uint32_t ta_web_chart_data_count(const ta_web_host *host, uint32_t slot) {
    const ta_web_chart_row *row = ta_web_chart_at(host, slot);
    return row != NULL ? ta_image_data_count(row->image, row->chart) : 0;
}

/* <data> `i` of the chart at `slot`: [status, id (2 words), expression,
 * state]. */
TA_WEB_EXPORT int32_t ta_web_chart_data(ta_web_host *host, uint32_t slot, uint32_t i) {
    const ta_web_chart_row *row = ta_web_chart_at(host, slot);
    uint32_t *word = ta_web_words(host);
    ta_data_info info = {{"", 0}, TA_NIL, 0};
    ta_status status = row != NULL ? ta_image_data(row->image, (ta_chart_item){row->chart, i}, &info) : TA_ERROR_STALE;
    word[0] = (uint32_t)status;
    ta_web_set_text(word, 1, info.id);
    word[3] = info.expression;
    word[4] = info.state;
    return status;
}

/* A string of the chart's image by its id (a capture's param names): its
 * pointer, the length in the record's word 0. */
TA_WEB_EXPORT uint32_t ta_web_chart_string(ta_web_host *host, uint32_t slot, uint32_t sid) {
    const ta_web_chart_row *row = ta_web_chart_at(host, slot);
    ta_string_view text = row != NULL ? ta_image_string(row->image, sid) : (ta_string_view){"", 0};
    ta_web_words(host)[0] = (uint32_t)text.length;
    return ta_web_address(text.pointer);
}

/* The index of state `name` (the record's words 0-1) in the chart at
 * `slot`, TA_NIL for none: In()'s argument. */
TA_WEB_EXPORT uint32_t ta_web_chart_state(ta_web_host *host, uint32_t slot) {
    const ta_web_chart_row *row = ta_web_chart_at(host, slot);
    return row != NULL ? ta_image_state_by_name(row->image, row->chart, ta_web_text_at(ta_web_words(host), 0)) : TA_NIL;
}

/* ---- payloads ----------------------------------------------------------------------------- */

/* A payload's row for a value JavaScript makes (an input's data, a
 * spawn's params): its slot + 1, the handle in the record's words 0-1; 0
 * when the allocator refuses. One reference, moved to core by the input
 * that takes it, released by a refusal. */
TA_WEB_EXPORT uint32_t ta_web_payload_new(ta_web_host *host) {
    uint64_t handle = 0;
    ta_web_count_row *row = (ta_web_count_row *)ta_table_add(&host->payloads, &handle);
    if (row == NULL) return 0;
    row->count = 1;
    ta_web_set_word64(ta_web_words(host), 0, handle);
    return (uint32_t)handle;
}

void ta_web_payload_release(ta_web_host *host, ta_payload payload) {
    ta_web_count_row *row = (ta_web_count_row *)ta_table_get(&host->payloads, payload);
    if (row == NULL) return;
    if (--row->count > 0) return;
    ta_table_remove(&host->payloads, payload);
    /* JavaScript moves the value to its list of drops, emptied after the
       outer call returns: dropping it can run JavaScript (a finalizer) */
    ta_web_dm(host, &(ta_web_ask){TA_WEB_DM_DROP, ta_web_slot(payload), NULL});
}

/* The record's slot of a payload made for an entry (capture, migrate,
 * from_wire, variable, payload_deserialize): added before, kept when
 * JavaScript stored a value (the record's word 0 nonzero), removed
 * otherwise. */
typedef struct ta_web_making {
    ta_web_host *host;
    ta_web_ask ask;
    ta_payload *out;
} ta_web_making;

static ta_status ta_web_make_payload(ta_web_making *making) {
    ta_web_host *host = making->host;
    uint64_t handle = 0;
    *making->out = 0;
    ta_web_count_row *row = (ta_web_count_row *)ta_table_add(&host->payloads, &handle);
    if (row == NULL) return TA_ERROR_NO_MEMORY;
    row->count = 1;
    making->ask.slot = ta_web_slot(handle);
    ta_status status = ta_web_dm(host, &making->ask);
    bool stored = ta_web_words(host)[0] != 0;
    if (status != TA_OK || !stored) {
        ta_table_remove(&host->payloads, handle);
        return status;
    }
    *making->out = handle;
    return TA_OK;
}

/* ---- the vtable ---------------------------------------------------------------------------- */

static ta_status ta_web_chart_attach(void *datamodel, const ta_datamodel_chart *chart, void **chart_context) {
    ta_web_host *host = ta_web_of(datamodel);
    uint64_t handle = 0;
    ta_web_chart_row *row = (ta_web_chart_row *)ta_table_add(&host->charts, &handle);
    if (row == NULL) return TA_ERROR_NO_MEMORY;
    *row = (ta_web_chart_row){chart->image, chart->chart, chart->segment, chart->binding, 0};
    uint32_t *word = ta_web_words(host);
    word[0] = chart->chart;
    word[1] = chart->segment;
    word[2] = chart->binding;
    ta_status status = ta_web_dm(host, &(ta_web_ask){TA_WEB_DM_ATTACH, ta_web_slot(handle), NULL});
    if (status != TA_OK) {
        ta_table_remove(&host->charts, handle);
        return status;
    }
    *chart_context = (void *)(uintptr_t)(ta_web_slot(handle) + 1u);
    return TA_OK;
}

static uint32_t ta_web_chart_slot(void *chart_context) { return (uint32_t)(uintptr_t)chart_context - 1u; }

static void ta_web_chart_detach(void *datamodel, void *chart_context) {
    ta_web_host *host = ta_web_of(datamodel);
    uint32_t slot = ta_web_chart_slot(chart_context);
    uint64_t handle = ta_table_handle(&host->charts, slot);
    if (handle == 0) return;
    ta_web_dm(host, &(ta_web_ask){TA_WEB_DM_DETACH, slot, NULL});
    ta_table_remove(&host->charts, handle);
}

/* create and deserialize: the session's row, then the entry with its
 * start in the record (0 the chart's slot, 1-2 init (create) or the state's
 * bytes (deserialize), 3-4 _sessionid, 5-6 _name, 7 the I/O processors'
 * count, read with ta_web_dm_processor). */
typedef struct ta_web_starting {
    uint32_t entry;
    const ta_datamodel_start *start;
    uint64_t *instance;
} ta_web_starting;

static ta_status ta_web_start(ta_web_host *host, const ta_web_starting *starting) {
    const ta_datamodel_start *start = starting->start;
    uint32_t chart = ta_web_chart_slot(start->chart_context);
    uint64_t handle = 0;
    ta_web_session_row *row = (ta_web_session_row *)ta_table_add(&host->sessions, &handle);
    if (row == NULL) return TA_ERROR_NO_MEMORY;
    row->chart = ta_table_handle(&host->charts, chart);
    uint32_t *word = ta_web_words(host);
    word[0] = chart;
    if (starting->entry == TA_WEB_DM_CREATE) ta_web_set_word64(word, 1, start->init);
    else ta_web_set_bytes(word, 1, start->state);
    const ta_datamodel_system_variables *variables = start->system_variables;
    ta_string_view none = {"", 0};
    ta_web_set_text(word, 3, variables != NULL ? variables->sessionid : none);
    ta_web_set_text(word, 5, variables != NULL ? variables->name : none);
    word[7] = variables != NULL ? variables->io_processor_count : 0;
    const ta_datamodel_start *outer = host->env->start;
    host->env->start = start;
    ta_status status = ta_web_dm(host, &(ta_web_ask){starting->entry, ta_web_slot(handle), NULL});
    host->env->start = outer;
    if (status != TA_OK) {
        ta_table_remove(&host->sessions, handle);
        return status;
    }
    *starting->instance = handle;
    return TA_OK;
}

static ta_status ta_web_create(void *datamodel, const ta_datamodel_start *start, uint64_t *instance) {
    return ta_web_start(ta_web_of(datamodel), &(ta_web_starting){TA_WEB_DM_CREATE, start, instance});
}

static ta_status ta_web_deserialize(void *datamodel, const ta_datamodel_start *start, uint64_t *instance) {
    return ta_web_start(ta_web_of(datamodel), &(ta_web_starting){TA_WEB_DM_DESERIALIZE, start, instance});
}

static void ta_web_destroy(const ta_datamodel_call *call) {
    ta_web_host *host = ta_web_of(call->datamodel);
    uint32_t slot = ta_web_session_slot(host, call->instance);
    if (slot == TA_NIL) return;
    ta_web_dm(host, &(ta_web_ask){TA_WEB_DM_DESTROY, slot, NULL});
    ta_table_remove(&host->sessions, call->instance);
}

static ta_status ta_web_init_data(const ta_datamodel_call *call, uint32_t declaration) {
    ta_web_words(ta_web_of(call->datamodel))[0] = declaration;
    return ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_INIT_DATA});
}

/* Record: 0 type, 1 name_id, 2 invoke_slot, 3 origintype_id, 4-5 name,
 * 6-7 sendid, 8-9 origin, 10-11 origintype, 12-13 invokeid, 14-15 data (a
 * payload handle, retained by JavaScript's own row if it keeps it: it is
 * core's until the next bind_event), 16-17 raw. The strings are valid
 * during the entry only. */
static ta_status ta_web_bind_event(const ta_datamodel_call *call, const ta_event_view *event) {
    uint32_t *word = ta_web_words(ta_web_of(call->datamodel));
    word[0] = event->type;
    word[1] = event->name_id;
    word[2] = event->invoke_slot;
    word[3] = event->origintype_id;
    ta_web_set_text(word, 4, event->name);
    ta_web_set_text(word, 6, event->sendid);
    ta_web_set_text(word, 8, event->origin);
    ta_web_set_text(word, 10, event->origintype);
    ta_web_set_text(word, 12, event->invokeid);
    ta_web_set_word64(word, 14, event->data);
    ta_web_set_text(word, 16, event->raw);
    return ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_BIND_EVENT});
}

static void ta_web_detach_event(const ta_datamodel_call *call) { ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_DETACH_EVENT}); }

static ta_status ta_web_eval_condition(const ta_datamodel_call *call, ta_expression e, int *out) {
    uint32_t *word = ta_web_words(ta_web_of(call->datamodel));
    word[0] = e;
    ta_status status = ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_EVAL_CONDITION});
    *out = status == TA_OK && word[0] != 0;
    return status;
}

/* An entry whose answer is the output room's text (record word 0 its
 * length). */
typedef struct ta_web_texting {
    const ta_datamodel_call *call;
    uint32_t entry;
    ta_expression e;
    ta_string_view *out;
} ta_web_texting;

static ta_status ta_web_text_entry(const ta_web_texting *texting) {
    ta_web_host *host = ta_web_of(texting->call->datamodel);
    uint32_t *word = ta_web_words(host);
    word[0] = texting->e;
    ta_status status = ta_web_instance(&(ta_web_entry){texting->call, texting->entry});
    uint32_t length = word[0];
    if (status == TA_OK && (length > host->output.capacity || (length > 0 && host->output.pointer == NULL))) status = TA_ERROR_INVALID;
    *texting->out = status == TA_OK && length > 0 ? (ta_string_view){(const char *)host->output.pointer, length} : (ta_string_view){"", 0};
    return status;
}

static ta_status ta_web_eval_string(const ta_datamodel_call *call, ta_expression e, ta_string_view *out) {
    return ta_web_text_entry(&(ta_web_texting){call, TA_WEB_DM_EVAL_STRING, e, out});
}

static ta_status ta_web_log(const ta_datamodel_call *call, ta_expression e, ta_string_view *out) {
    return ta_web_text_entry(&(ta_web_texting){call, TA_WEB_DM_LOG, e, out});
}

static ta_status ta_web_assign(const ta_datamodel_call *call, ta_expression location, ta_expression value) {
    uint32_t *word = ta_web_words(ta_web_of(call->datamodel));
    word[0] = location;
    word[1] = value;
    return ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_ASSIGN});
}

static ta_status ta_web_assign_string(const ta_datamodel_call *call, ta_expression location, ta_string_view value) {
    uint32_t *word = ta_web_words(ta_web_of(call->datamodel));
    word[0] = location;
    ta_web_set_text(word, 1, value);
    return ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_ASSIGN_STRING});
}

static ta_status ta_web_script(const ta_datamodel_call *call, ta_expression e) {
    ta_web_words(ta_web_of(call->datamodel))[0] = e;
    return ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_SCRIPT});
}

static ta_status ta_web_custom(const ta_datamodel_call *call, uint32_t custom) {
    ta_web_words(ta_web_of(call->datamodel))[0] = custom;
    return ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_CUSTOM});
}

/* foreach: a loop's row for its items. Record: 0 the array expression,
 * 1 the loop's slot; JavaScript answers word 0, the number of items. */
static ta_status ta_web_foreach_begin(const ta_datamodel_call *call, ta_expression array, ta_datamodel_loop *loop) {
    ta_web_host *host = ta_web_of(call->datamodel);
    uint64_t handle = 0;
    if (ta_table_add(&host->loops, &handle) == NULL) return TA_ERROR_NO_MEMORY;
    uint32_t *word = ta_web_words(host);
    word[0] = array;
    word[1] = ta_web_slot(handle);
    ta_status status = ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_FOREACH_BEGIN});
    if (status != TA_OK) {
        ta_table_remove(&host->loops, handle);
        return status;
    }
    loop->iter = handle;
    loop->n = word[0];
    return TA_OK;
}

/* Record: 0 the loop's slot, 1 the item's index, 2 the item's location,
 * 3 the index's location (TA_NIL: none). */
static ta_status ta_web_foreach_item(const ta_datamodel_call *call, const ta_datamodel_loop *loop) {
    ta_web_host *host = ta_web_of(call->datamodel);
    if (ta_table_get(&host->loops, loop->iter) == NULL) return TA_ERROR_STALE;
    uint32_t *word = ta_web_words(host);
    word[0] = ta_web_slot(loop->iter);
    word[1] = loop->i;
    word[2] = loop->item;
    word[3] = loop->index;
    return ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_FOREACH_ITEM});
}

static void ta_web_foreach_end(const ta_datamodel_call *call, const ta_datamodel_loop *loop) {
    ta_web_host *host = ta_web_of(call->datamodel);
    if (ta_table_get(&host->loops, loop->iter) == NULL) return;
    ta_web_words(host)[0] = ta_web_slot(loop->iter);
    ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_FOREACH_END});
    ta_table_remove(&host->loops, loop->iter);
}

/* Record: 0 the session's slot (the ask's slot is the new payload's), 1
 * kind, 2 the namelist's count, 3 the params' count, 4 content, 5 the
 * namelist's address (location expression ids), 6 the params' address
 * (pairs of a name's string id and an expression id): arrays of words in
 * the image. JavaScript answers word 0: nonzero when it stored a value
 * (else the capture is 0, none). */
static ta_status ta_web_capture(const ta_datamodel_call *call, const ta_datamodel_capture *spec, ta_payload *out) {
    ta_web_host *host = ta_web_of(call->datamodel);
    uint32_t session = ta_web_session_slot(host, call->instance);
    if (session == TA_NIL) return TA_ERROR_STALE;
    uint32_t *word = ta_web_words(host);
    word[0] = session;
    word[1] = spec->kind;
    word[2] = spec->namelist_count;
    word[3] = spec->param_count;
    word[4] = spec->content;
    word[5] = ta_web_address(spec->namelist);
    word[6] = ta_web_address(spec->params);
    return ta_web_make_payload(&(ta_web_making){host, {TA_WEB_DM_CAPTURE, 0, call->environment}, out});
}

static void ta_web_retain(void *datamodel, ta_payload payload) {
    ta_web_count_row *row = (ta_web_count_row *)ta_table_get(&ta_web_of(datamodel)->payloads, payload);
    if (row != NULL) row->count++;
}

static void ta_web_release(void *datamodel, ta_payload payload) { ta_web_payload_release(ta_web_of(datamodel), payload); }

/* An entry whose answer is the output room's bytes (record word 0 its
 * length): serialize, and with a payload's slot to_wire and
 * payload_serialize. */
typedef struct ta_web_bytes_entry {
    ta_web_host *host;
    ta_web_ask ask;
    ta_bytes *out;
} ta_web_bytes_entry;

static ta_status ta_web_bytes_answer(const ta_web_bytes_entry *entry) {
    ta_web_host *host = entry->host;
    ta_status status = ta_web_dm(host, &entry->ask);
    uint32_t length = ta_web_words(host)[0];
    if (status == TA_OK && (length > host->output.capacity || (length > 0 && host->output.pointer == NULL))) status = TA_ERROR_INVALID;
    *entry->out = status == TA_OK ? (ta_bytes){host->output.pointer, length} : (ta_bytes){NULL, 0};
    return status;
}

static ta_status ta_web_serialize(const ta_datamodel_call *call, ta_bytes *out) {
    ta_web_host *host = ta_web_of(call->datamodel);
    uint32_t slot = ta_web_session_slot(host, call->instance);
    if (slot == TA_NIL) return TA_ERROR_STALE;
    return ta_web_bytes_answer(&(ta_web_bytes_entry){host, {TA_WEB_DM_SERIALIZE, slot, NULL}, out});
}

static ta_status ta_web_payload_bytes(ta_web_host *host, ta_payload payload, const ta_web_bytes_entry *entry) {
    if (ta_table_get(&host->payloads, payload) == NULL) return TA_ERROR_STALE;
    return ta_web_bytes_answer(entry);
}

static ta_status ta_web_to_wire(void *datamodel, ta_payload payload, ta_bytes *out) {
    ta_web_host *host = ta_web_of(datamodel);
    return ta_web_payload_bytes(host, payload, &(ta_web_bytes_entry){host, {TA_WEB_DM_TO_WIRE, ta_web_slot(payload), NULL}, out});
}

static ta_status ta_web_payload_serialize(void *datamodel, ta_payload payload, ta_bytes *out) {
    ta_web_host *host = ta_web_of(datamodel);
    return ta_web_payload_bytes(host, payload, &(ta_web_bytes_entry){host, {TA_WEB_DM_PAYLOAD_SERIALIZE, ta_web_slot(payload), NULL}, out});
}

/* Record: 0 the session's slot (the ask's slot is the new payload's). */
static ta_status ta_web_migrate(const ta_datamodel_call *call, ta_payload *bindings) {
    ta_web_host *host = ta_web_of(call->datamodel);
    uint32_t session = ta_web_session_slot(host, call->instance);
    if (session == TA_NIL) return TA_ERROR_STALE;
    ta_web_words(host)[0] = session;
    return ta_web_make_payload(&(ta_web_making){host, {TA_WEB_DM_MIGRATE, 0, call->environment}, bindings});
}

/* Record: 0-1 the CBOR (from_wire) or the blob (payload_deserialize),
 * valid during the entry. */
typedef struct ta_web_reading {
    uint32_t entry;
    ta_bytes bytes;
    ta_payload *out;
} ta_web_reading;

static ta_status ta_web_read_payload(ta_web_host *host, const ta_web_reading *reading) {
    ta_web_set_bytes(ta_web_words(host), 0, reading->bytes);
    ta_status status = ta_web_make_payload(&(ta_web_making){host, {reading->entry, 0, NULL}, reading->out});
    if (status == TA_OK && *reading->out == 0) status = TA_ERROR_INVALID; /* a value always comes back */
    return status;
}

static ta_status ta_web_from_wire(void *datamodel, ta_bytes cbor, ta_payload *out) {
    return ta_web_read_payload(ta_web_of(datamodel), &(ta_web_reading){TA_WEB_DM_FROM_WIRE, cbor, out});
}

static ta_status ta_web_payload_deserialize(void *datamodel, ta_bytes blob, ta_payload *out) {
    return ta_web_read_payload(ta_web_of(datamodel), &(ta_web_reading){TA_WEB_DM_PAYLOAD_DESERIALIZE, blob, out});
}

/* Record: 0 the session's slot, 1-2 the location's name (the ask's slot
 * is the new payload's; none stored: undefined, *out 0). */
static ta_status ta_web_variable(const ta_datamodel_call *call, ta_string_view name, ta_payload *out) {
    ta_web_host *host = ta_web_of(call->datamodel);
    uint32_t session = ta_web_session_slot(host, call->instance);
    if (session == TA_NIL) return TA_ERROR_STALE;
    uint32_t *word = ta_web_words(host);
    word[0] = session;
    ta_web_set_text(word, 1, name);
    return ta_web_make_payload(&(ta_web_making){host, {TA_WEB_DM_VARIABLE, 0, NULL}, out});
}

/* JavaScript answers: 0 the reason (TA_DATAMODEL_FAILURE_*), 1 the
 * message's length in the output room. */
static ta_status ta_web_failure(const ta_datamodel_call *call, ta_datamodel_failure *out) {
    ta_web_host *host = ta_web_of(call->datamodel);
    ta_status status = ta_web_instance(&(ta_web_entry){call, TA_WEB_DM_FAILURE});
    uint32_t *word = ta_web_words(host);
    uint32_t length = word[1];
    out->reason = status == TA_OK ? word[0] : TA_DATAMODEL_FAILURE_NONE;
    out->pad = 0;
    out->message = status == TA_OK && length > 0 && length <= host->output.capacity && host->output.pointer != NULL
                       ? (ta_string_view){(const char *)host->output.pointer, length}
                       : (ta_string_view){"", 0};
    return status;
}

static const ta_datamodel_vtable ta_web_native = {
    sizeof(ta_datamodel_vtable),
    TA_DATAMODEL_EVENT_DETACHABLE,
    "ecmascript",
    ta_web_chart_attach,
    ta_web_chart_detach,
    ta_web_create,
    ta_web_destroy,
    ta_web_init_data,
    ta_web_bind_event,
    ta_web_detach_event,
    ta_web_eval_condition,
    ta_web_eval_string,
    ta_web_assign,
    ta_web_assign_string,
    ta_web_script,
    ta_web_log,
    ta_web_foreach_begin,
    ta_web_foreach_item,
    ta_web_foreach_end,
    ta_web_capture,
    ta_web_retain,
    ta_web_release,
    ta_web_custom,
    ta_web_serialize,
    ta_web_deserialize,
    ta_web_migrate,
    ta_web_to_wire,
    ta_web_from_wire,
    ta_web_payload_serialize,
    ta_web_payload_deserialize,
    ta_web_variable,
    ta_web_failure,
};

const ta_datamodel_vtable *ta_web_native_vtable(void) { return &ta_web_native; }

/* A payload JavaScript holds a reference on (a record that outlives the
 * ack keeps the send's data): one more reference, or one less (the row
 * and the value go at 0). On quickjs a drop is its release, of a payload
 * JavaScript made and core refused. */
TA_WEB_EXPORT void ta_web_payload_retain(ta_web_host *host, uint32_t low, uint32_t high) {
    ta_web_retain(host, (uint64_t)low | (uint64_t)high << 32);
}

TA_WEB_EXPORT void ta_web_payload_drop(ta_web_host *host, uint32_t low, uint32_t high) {
    ta_payload payload = (uint64_t)low | (uint64_t)high << 32;
    if (host->quickjs != NULL) host->binding.vtable->release(host->binding.datamodel, payload); /* quickjs's own */
    else ta_web_payload_release(host, payload);
}

/* ---- snapshots of the native datamodel: its tables' namespaces and rows ------------------------ */

/* The table a snapshot names: 0 sessions, 1 payloads, 2 loops. */
static ta_table *ta_web_dm_table(ta_web_host *host, uint32_t which) {
    switch (which) {
    case 0: return &host->sessions;
    case 1: return &host->payloads;
    case 2: return &host->loops;
    default: return NULL;
    }
}

/* Table `which`'s handle namespace (ta_table_snapshot) in the output room:
 * its address in the record's word 0, its length in word 1. */
TA_WEB_EXPORT int32_t ta_web_dm_layout(ta_web_host *host, uint32_t which) {
    ta_table *table = ta_web_dm_table(host, which);
    if (table == NULL) return TA_ERROR_INVALID;
    ta_buffer probe = {NULL, 0, 0};
    ta_status status = ta_table_snapshot(table, &probe);
    if (status != TA_OK && status != TA_ERROR_NO_MEMORY) return status;
    if (ta_web_dm_output(host, probe.length > 0 ? (uint32_t)probe.length : 1) == 0) return TA_ERROR_NO_MEMORY;
    ta_buffer out = {host->output.pointer, host->output.capacity, 0};
    status = ta_table_snapshot(table, &out);
    uint32_t *word = ta_web_words(host);
    word[0] = ta_web_address(out.pointer);
    word[1] = (uint32_t)out.length;
    return status;
}

/* The live rows of table `which`, three words each at the address in the
 * record's word 0, at most word 1 of them: the handle (two words), then a
 * payload's reference count or a session's chart slot (0 for a loop).
 * Answers how many it wrote. */
TA_WEB_EXPORT uint32_t ta_web_dm_rows(ta_web_host *host, uint32_t which) {
    ta_table *table = ta_web_dm_table(host, which);
    uint32_t *word = ta_web_words(host);
    uint32_t *out = (uint32_t *)(uintptr_t)word[0], room = word[1], n = 0;
    if (table == NULL) return 0;
    for (uint32_t slot = 0; slot < table->capacity && n < room; slot++) {
        void *row = ta_table_at(table, slot);
        if (row == NULL) continue;
        uint64_t handle = ta_table_handle(table, slot);
        uint32_t value = 0;
        if (which == 0) {
            uint64_t chart = ((const ta_web_session_row *)row)->chart;
            value = ta_table_get(&host->charts, chart) != NULL ? ta_web_slot(chart) : TA_NIL;
        } else if (which == 1)
            value = ((const ta_web_count_row *)row)->count;
        ta_web_set_word64(out, 3 * n, handle);
        out[3 * n + 2] = value;
        n++;
    }
    return n;
}

/* Table `which`'s namespace back from the bytes in the record's words 0-1
 * (ta_table_restore: TA_ERROR_STATE unless it is empty). */
TA_WEB_EXPORT int32_t ta_web_dm_restore(ta_web_host *host, uint32_t which) {
    ta_table *table = ta_web_dm_table(host, which);
    if (table == NULL) return TA_ERROR_INVALID;
    return ta_table_restore(table, ta_web_bytes_at(ta_web_words(host), 0));
}

/* A restored row filled: the handle in the record's words 0-1, in word 2
 * a payload's reference count (1 and up) or a session's chart slot (a live
 * chart); TA_ERROR_INVALID for a handle the table does not hold, a row
 * filled already, or a value that does not fit. A loop's row holds
 * nothing in C: JavaScript checks it. */
TA_WEB_EXPORT int32_t ta_web_dm_fill(ta_web_host *host, uint32_t which) {
    ta_table *table = ta_web_dm_table(host, which);
    const uint32_t *word = ta_web_words(host);
    uint64_t handle = ta_web_word64(word, 0);
    uint32_t value = word[2];
    void *row = table != NULL ? ta_table_get(table, handle) : NULL;
    if (row == NULL) return TA_ERROR_INVALID;
    if (which == 0) {
        ta_web_session_row *session = (ta_web_session_row *)row;
        uint64_t chart = ta_table_handle(&host->charts, value);
        if (session->chart != 0 || chart == 0) return TA_ERROR_INVALID;
        session->chart = chart;
    } else if (which == 1) {
        ta_web_count_row *payload = (ta_web_count_row *)row;
        if (payload->count != 0 || value == 0) return TA_ERROR_INVALID;
        payload->count = value;
    }
    return TA_OK;
}
