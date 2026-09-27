#include "napi_datamodel.h"

#include <stdlib.h>
#include <string.h>

#include "napi_system.h"
#include "values.h"

/* ------------------------------------------------------------------------
 * Expression records (TA_EXPRESSION_HOST values)
 */

typedef struct {
    tna_values *values; /* env, allocator, torn_down */
    napi_ref ref;
    uint32_t references;
    tna_expr_kind kind;
} tna_expr_record;

static ta_result tna_expr_retain(void *self, void *value, ta_allocator allocator, void **out) {
    (void)self;
    (void)allocator;
    ((tna_expr_record *)value)->references += 1u;
    *out = value;
    return TA_OK;
}

static void tna_expr_release(void *self, void *value, ta_allocator allocator) {
    (void)self;
    (void)allocator;
    tna_expr_record *record = value;
    if (--record->references != 0) {
        return;
    }
    tna_values *values = record->values;
    if (record->ref != NULL && !*values->torn_down) {
        napi_delete_reference(values->env, record->ref);
    }
    tna_free(values->allocator,
             &(ta_allocator_free_params){ .ptr = record, .size = sizeof *record, .alignment = _Alignof(tna_expr_record) });
}

static const ta_expression_host_vtable tna_expr_vtable = { tna_expr_retain, tna_expr_release };

static const tna_expr_record *tna_record_of(const ta_expression *expression) {
    if (expression == NULL || expression->kind != TA_EXPRESSION_HOST || expression->as.host.v != &tna_expr_vtable) {
        return NULL;
    }
    return expression->as.host.value;
}

bool tna_expression_make(tna_js_datamodel *dm, napi_value value, tna_expr_kind kind, ta_expression *out) {
    tna_values *values = &dm->wrapper->values;
    tna_expr_record *record = tna_alloc(values->allocator, sizeof *record, _Alignof(tna_expr_record));
    if (record == NULL) {
        return false;
    }
    *record = (tna_expr_record){ .values = values, .references = 1u, .kind = kind };
    if (napi_create_reference(dm->env, value, 1, &record->ref) != napi_ok) {
        tna_free(values->allocator,
                 &(ta_allocator_free_params){ .ptr = record, .size = sizeof *record, .alignment = _Alignof(tna_expr_record) });
        return false;
    }
    *out = (ta_expression){ .kind = TA_EXPRESSION_HOST,
                            .as.host = { .self = NULL, .v = &tna_expr_vtable, .value = record } };
    return true;
}

void tna_expression_release(ta_expression *expression) {
    if (tna_record_of(expression) != NULL) {
        tna_expr_release(NULL, expression->as.host.value, (ta_allocator){ 0 });
    }
    *expression = (ta_expression){ .kind = TA_EXPRESSION_NONE };
}

napi_value tna_expression_value(napi_env env, const ta_expression *expression) {
    const tna_expr_record *record = tna_record_of(expression);
    napi_value value = NULL;
    if (record == NULL || napi_get_reference_value(env, record->ref, &value) != napi_ok) {
        return NULL;
    }
    return value;
}

bool tna_expression_is_literal(napi_env env, napi_value value) {
    tna_env *data = tna_env_get(env);
    napi_valuetype type = napi_undefined;
    napi_value brand = NULL;
    bool has = false;
    if (data == NULL || data->literal_brand == NULL || napi_typeof(env, value, &type) != napi_ok ||
        type != napi_object || napi_get_reference_value(env, data->literal_brand, &brand) != napi_ok ||
        napi_has_property(env, value, brand, &has) != napi_ok) {
        return false;
    }
    return has;
}

/* The shared data model behind an adapter (tna_dm_adapter): every
 * operation's `self`. */
static tna_js_datamodel *tna_dm_of(void *self) {
    return ((tna_dm_adapter *)self)->dm;
}

/* ------------------------------------------------------------------------
 * Source text: `In(state)` and data names only.
 */

typedef enum { TNA_SOURCE_OTHER = 0, TNA_SOURCE_IN, TNA_SOURCE_NAME } tna_source_kind;

static bool tna_space(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static ta_str tna_trim(ta_str text) {
    while (text.len > 0 && tna_space(text.ptr[0])) {
        text.ptr += 1;
        text.len -= 1u;
    }
    while (text.len > 0 && tna_space(text.ptr[text.len - 1u])) {
        text.len -= 1u;
    }
    return text;
}

static bool tna_identifier(ta_str text) {
    if (text.len == 0) {
        return false;
    }
    for (uint32_t at = 0; at < text.len; at += 1) {
        char c = text.ptr[at];
        bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$';
        if (!letter && !(at > 0 && c >= '0' && c <= '9')) {
            return false;
        }
    }
    return true;
}

/* Classifies source text; for In(state), `argument` is the state ID. */
static tna_source_kind tna_source(ta_str source, ta_str *argument) {
    ta_str text = tna_trim(source);
    if (tna_identifier(text)) {
        *argument = text;
        return TNA_SOURCE_NAME;
    }
    if (text.len < 4 || memcmp(text.ptr, "In(", 3) != 0 || text.ptr[text.len - 1u] != ')') {
        return TNA_SOURCE_OTHER;
    }
    ta_str inner = tna_trim((ta_str){ text.ptr + 3, text.len - 4u });
    if (inner.len >= 2 && (inner.ptr[0] == '\'' || inner.ptr[0] == '"') && inner.ptr[inner.len - 1u] == inner.ptr[0]) {
        inner = (ta_str){ inner.ptr + 1, inner.len - 2u };
    }
    if (inner.len == 0) {
        return TNA_SOURCE_OTHER;
    }
    *argument = inner;
    return TNA_SOURCE_IN;
}

/* ------------------------------------------------------------------------
 * Definitions and instances
 */

typedef struct {
    tna_js_datamodel *dm;
    const ta_expression *expressions;
    /*
     * A registered data model's compiled expressions, by expression ID: a
     * host expression each (ADR 0019). NULL for the built-in model, which
     * reads `expressions` as they are.
     */
    ta_expression *compiled;
    uint32_t count;
} tna_dm_shared;

typedef struct {
    ta_value root; /* the data object, or absent before init */
} tna_dm_instance;

static const char tna_source_refused[] =
    "the JavaScript data model takes functions; source text is only In(state) or a data name";

static const char *const tna_role_names[] = { "value", "condition", "location", "script" };

static void tna_release_compiled(ta_expression *compiled, uint32_t count, ta_allocator allocator) {
    if (compiled == NULL) {
        return;
    }
    for (uint32_t index = 0; index < count; index += 1) {
        tna_expression_release(&compiled[index]);
    }
    tna_free(allocator, &(ta_allocator_free_params){ .ptr = compiled,
                                                    .size = (size_t)count * sizeof(ta_expression),
                                                    .alignment = _Alignof(ta_expression) });
}

/* A number property of `object`, when it has one. */
static bool tna_number_property(napi_env env, napi_value object, const char *name, uint32_t *out) {
    napi_value value = NULL;
    napi_valuetype type = napi_undefined;
    double number = 0;
    if (napi_get_named_property(env, object, name, &value) != napi_ok || napi_typeof(env, value, &type) != napi_ok ||
        type != napi_number || napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0) ||
        number > 4294967295.0) {
        return false;
    }
    *out = (uint32_t)number;
    return true;
}

/*
 * The refusal of expression `index`: the thrown value's message, and the
 * span of the source it names when it has numeric `offset` and `length`
 * (ADR 0019 section 1). The message is kept in `dm->rejection`, which core
 * copies before it next calls the data model.
 */
static void tna_compile_refused(tna_js_datamodel *dm, const ta_datamodel_prepare_definition_params *params,
                                uint32_t index, const char *fallback) {
    napi_env env = dm->env;
    napi_value error = NULL;
    bool pending = false;
    size_t length = 0;
    uint32_t offset = 0;
    uint32_t span = 0;
    bool located = false;
    dm->rejection[0] = '\0';
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending &&
        napi_get_and_clear_last_exception(env, &error) == napi_ok && error != NULL) {
        napi_valuetype type = napi_undefined;
        napi_value message = NULL;
        if (napi_typeof(env, error, &type) == napi_ok && type == napi_object) {
            located = tna_number_property(env, error, "offset", &offset) && tna_number_property(env, error, "length", &span);
            if (napi_get_named_property(env, error, "message", &message) != napi_ok) {
                message = NULL;
            }
        } else {
            message = error;
        }
        napi_value text = NULL;
        if (message != NULL && napi_coerce_to_string(env, message, &text) == napi_ok) {
            napi_get_value_string_utf8(env, text, dm->rejection, sizeof dm->rejection, &length);
        } else {
            napi_get_and_clear_last_exception(env, &error);
        }
    }
    if (length == 0) {
        length = strlen(fallback);
        if (length >= sizeof dm->rejection) {
            length = sizeof dm->rejection - 1u;
        }
        memcpy(dm->rejection, fallback, length);
        dm->rejection[length] = '\0';
    }
    if (params->rejected != NULL) {
        *params->rejected = (ta_expression_rejection){
            .expression = index,
            .offset = located ? offset : 0,
            .length = located ? span : 0,
            .message = { dm->rejection, (uint32_t)length },
        };
    }
}

/*
 * A registered data model compiles every source expression with the user's
 * compiler (ADR 0019): compile(source, role) returns a function for a value,
 * a condition or a script, and a { get, set } location for a location. lib/
 * normalizes a data name into a location before the result gets here.
 */
static ta_result tna_compile_all(tna_dm_adapter *adapter, const ta_datamodel_prepare_definition_params *params,
                                 ta_expression **out) {
    tna_js_datamodel *dm = adapter->dm;
    napi_env env = dm->env;
    *out = NULL;
    if (params->expression_count == 0) {
        return TA_OK;
    }
    if (!dm->js_usable) {
        return TA_ERR_UNSUPPORTED;
    }
    ta_expression *compiled = tna_alloc(params->allocator, (size_t)params->expression_count * sizeof(ta_expression),
                                        _Alignof(ta_expression));
    if (compiled == NULL) {
        return TA_ERR_NOMEM;
    }
    for (uint32_t index = 0; index < params->expression_count; index += 1) {
        compiled[index] = (ta_expression){ .kind = TA_EXPRESSION_NONE };
    }
    napi_handle_scope scope = NULL;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
        tna_release_compiled(compiled, params->expression_count, params->allocator);
        return TA_ERR_NOMEM;
    }
    napi_value compile = NULL;
    napi_value undefined = NULL;
    ta_result result = napi_get_reference_value(env, adapter->compile, &compile) == napi_ok && compile != NULL &&
                               napi_get_undefined(env, &undefined) == napi_ok
                           ? TA_OK
                           : TA_ERR_NOMEM;
    for (uint32_t index = 0; result == TA_OK && index < params->expression_count; index += 1) {
        const ta_expression *expression = &params->expressions[index];
        if (expression->kind != TA_EXPRESSION_SOURCE) {
            continue;
        }
        ta_expr_role role = params->roles != NULL ? params->roles[index] : TA_EXPR_ROLE_VALUE;
        napi_value argv[2] = { NULL, NULL };
        napi_value made = NULL;
        napi_valuetype type = napi_undefined;
        if (napi_create_string_utf8(env, expression->as.source.ptr, expression->as.source.len, &argv[0]) != napi_ok ||
            napi_create_string_utf8(env, tna_role_names[role <= TA_EXPR_ROLE_SCRIPT ? role : 0], NAPI_AUTO_LENGTH,
                                    &argv[1]) != napi_ok) {
            result = TA_ERR_NOMEM;
        } else if (napi_call_function(env, undefined, compile, 2, argv, &made) != napi_ok) {
            tna_compile_refused(dm, params, index, "the compiler refused this expression");
            result = TA_ERR_INVALID;
        } else if (napi_typeof(env, made, &type) != napi_ok ||
                   (role == TA_EXPR_ROLE_LOCATION ? type != napi_object : type != napi_function)) {
            tna_compile_refused(dm, params, index,
                                role == TA_EXPR_ROLE_LOCATION ? "compile() must return a { get, set } location here"
                                                              : "compile() must return a function here");
            result = TA_ERR_INVALID;
        } else if (!tna_expression_make(dm, made, role == TA_EXPR_ROLE_LOCATION ? TNA_EXPR_LOCATION : TNA_EXPR_FUNCTION,
                                        &compiled[index])) {
            result = TA_ERR_NOMEM;
        }
    }
    napi_close_handle_scope(env, scope);
    if (result != TA_OK) {
        tna_release_compiled(compiled, params->expression_count, params->allocator);
        return result;
    }
    *out = compiled;
    return TA_OK;
}

static ta_result tna_dm_prepare(void *self, const ta_datamodel_prepare_definition_params *params) {
    tna_dm_adapter *adapter = self;
    tna_js_datamodel *dm = adapter->dm;
    ta_expression *compiled = NULL;
    if (adapter->compile != NULL) {
        ta_result result = tna_compile_all(adapter, params, &compiled);
        if (result != TA_OK) {
            return result;
        }
    }
    for (uint32_t index = 0; compiled == NULL && index < params->expression_count; index += 1) {
        const ta_expression *expression = &params->expressions[index];
        ta_str argument = { NULL, 0 };
        bool refused = false;
        if (expression->kind == TA_EXPRESSION_SOURCE) {
            refused = tna_source(expression->as.source, &argument) == TNA_SOURCE_OTHER;
        } else if (expression->kind == TA_EXPRESSION_HOST) {
            refused = tna_record_of(expression) == NULL;
        }
        if (refused) {
            if (params->rejected != NULL) {
                *params->rejected = (ta_expression_rejection){
                    .expression = index,
                    .message = { tna_source_refused, (uint32_t)(sizeof tna_source_refused - 1u) },
                };
            }
            return expression->kind == TA_EXPRESSION_HOST ? TA_ERR_UNSUPPORTED : TA_ERR_INVALID;
        }
    }
    tna_dm_shared *shared = tna_alloc(params->allocator, sizeof *shared, _Alignof(tna_dm_shared));
    if (shared == NULL) {
        tna_release_compiled(compiled, params->expression_count, params->allocator);
        return TA_ERR_NOMEM;
    }
    *shared = (tna_dm_shared){
        .dm = dm, .expressions = params->expressions, .compiled = compiled, .count = params->expression_count
    };
    *params->shared = shared;
    return TA_OK;
}

static void tna_dm_destroy_definition(void *self, void *shared, ta_allocator allocator) {
    (void)self;
    if (shared != NULL) {
        tna_dm_shared *data = shared;
        tna_release_compiled(data->compiled, data->count, allocator);
        tna_free(allocator,
                 &(ta_allocator_free_params){ .ptr = shared, .size = sizeof(tna_dm_shared), .alignment = _Alignof(tna_dm_shared) });
    }
}

static uint32_t tna_dm_instance_size(void *self, void *shared) {
    (void)self;
    (void)shared;
    return (uint32_t)sizeof(tna_dm_instance);
}

static uint32_t tna_dm_instance_alignment(void *self, void *shared) {
    (void)self;
    (void)shared;
    return (uint32_t)_Alignof(tna_dm_instance);
}

/* ------------------------------------------------------------------------
 * One callback: a handle scope, the call in progress, and faults.
 */

typedef struct {
    tna_js_datamodel *dm;
    tna_dm_instance *instance;
    ta_fault *fault;
    napi_handle_scope scope;
    const ta_dm_host *saved_host;
    void *saved_instance;
    napi_ref saved_event;
    bool saved_text_failed;
} tna_frame;

static void tna_fault(tna_frame *frame, const char *message) {
    if (frame->fault == NULL) {
        return;
    }
    *frame->fault = (ta_fault){ .code = TA_ERR_INVALID, .message = { message, (uint32_t)strlen(message) } };
    napi_env env = frame->dm->env;
    bool pending = false;
    napi_value error = NULL;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending &&
        napi_get_and_clear_last_exception(env, &error) == napi_ok && error != NULL) {
        ta_value data;
        if (tna_value_make(&frame->dm->wrapper->values, error, &data)) {
            frame->fault->data = data;
        }
    }
}

static ta_op_status tna_fail(tna_frame *frame, const char *message) {
    tna_fault(frame, message);
    return TA_OP_ERROR;
}

static bool tna_begin(tna_frame *frame, tna_js_datamodel *dm, void *instance, const ta_dm_host *host, ta_fault *fault) {
    *frame = (tna_frame){ .dm = dm, .instance = instance, .fault = fault };
    if (!dm->js_usable) {
        tna_fault(frame, "javascript: no JavaScript can run while the system closes");
        return false;
    }
    if (napi_open_handle_scope(dm->env, &frame->scope) != napi_ok) {
        tna_fault(frame, "javascript: cannot open a handle scope");
        return false;
    }
    frame->saved_host = dm->host;
    frame->saved_instance = dm->instance;
    frame->saved_event = dm->event;
    frame->saved_text_failed = dm->text_failed;
    dm->host = host;
    dm->instance = instance;
    dm->event = NULL;
    dm->text_failed = false;
    return true;
}

static void tna_end(tna_frame *frame) {
    tna_js_datamodel *dm = frame->dm;
    if (dm->event != NULL) {
        napi_delete_reference(dm->env, dm->event);
    }
    dm->host = frame->saved_host;
    dm->instance = frame->saved_instance;
    dm->event = frame->saved_event;
    dm->text_failed = frame->saved_text_failed;
    napi_close_handle_scope(dm->env, frame->scope);
}

static bool tna_root(tna_frame *frame, napi_value *out) {
    return frame->instance != NULL && tna_value_get(frame->dm->env, &frame->instance->root, out);
}

static bool tna_context(tna_frame *frame, napi_value *out) {
    return napi_get_reference_value(frame->dm->env, frame->dm->context, out) == napi_ok && *out != NULL;
}

/*
 * Calls into JavaScript. A call during which core could not render a system
 * variable fails, even when the chart's code caught the getter's exception.
 */
static bool tna_js_call(tna_frame *frame, napi_value self, napi_value function, size_t argc, const napi_value *argv,
                        napi_value *result) {
    napi_value ignored = NULL;
    return napi_call_function(frame->dm->env, self, function, argc, argv, result == NULL ? &ignored : result) ==
               napi_ok &&
           !frame->dm->text_failed;
}

/* Calls `function` with `this` = the root and (args..., context). */
static bool tna_invoke(tna_frame *frame, napi_value function, size_t argc, const napi_value *args, napi_value *result) {
    napi_value argv[3];
    napi_value root = NULL;
    if (argc > 2 || !tna_root(frame, &root) || !tna_context(frame, &argv[argc])) {
        return false;
    }
    for (size_t at = 0; at < argc; at += 1) {
        argv[at] = args[at];
    }
    return tna_js_call(frame, root, function, argc + 1u, argv, result);
}

/* Expression `id` as the data model runs it: compiled when it was (ADR 0019). */
static const ta_expression *tna_expression(const tna_dm_shared *shared, ta_expr_id id) {
    if (shared == NULL || id >= shared->count) {
        return NULL;
    }
    if (shared->compiled != NULL && shared->compiled[id].kind == TA_EXPRESSION_HOST) {
        return &shared->compiled[id];
    }
    return &shared->expressions[id];
}

static bool tna_named_property(tna_frame *frame, ta_str name, napi_value *key) {
    return napi_create_string_utf8(frame->dm->env, name.ptr, name.len, key) == napi_ok;
}

/* root[name] */
static bool tna_read_name(tna_frame *frame, ta_str name, napi_value *out) {
    napi_value root = NULL;
    napi_value key = NULL;
    return tna_root(frame, &root) && tna_named_property(frame, name, &key) &&
           napi_get_property(frame->dm->env, root, key, out) == napi_ok;
}

/* In(state): false for a state the chart does not have (SCXML B.1). */
static bool tna_in_state(const ta_dm_host *host, ta_str id) {
    ta_state_id state = 0;
    return ta_dm_host_find_state(host, id, &state) == TA_OK && ta_dm_host_in_state(host, state);
}

/*
 * Evaluates expression `id` as a value. A function is called; a literal is
 * its value; a location is read; a data name reads the root; In(state) is a
 * boolean.
 */
static bool tna_evaluate(tna_frame *frame, const tna_dm_shared *shared, ta_expr_id id, napi_value *out) {
    napi_env env = frame->dm->env;
    const ta_expression *expression = tna_expression(shared, id);
    if (expression == NULL) {
        return false;
    }
    if (expression->kind == TA_EXPRESSION_SOURCE) {
        ta_str argument = { NULL, 0 };
        switch (tna_source(expression->as.source, &argument)) {
        case TNA_SOURCE_NAME:
            return tna_read_name(frame, argument, out);
        case TNA_SOURCE_IN:
            return napi_get_boolean(env, tna_in_state(frame->dm->host, argument), out) == napi_ok;
        default:
            return false;
        }
    }
    const tna_expr_record *record = tna_record_of(expression);
    napi_value value = tna_expression_value(env, expression);
    if (record == NULL || value == NULL) {
        return false;
    }
    switch (record->kind) {
    case TNA_EXPR_FUNCTION:
        return tna_invoke(frame, value, 0, NULL, out);
    case TNA_EXPR_LITERAL:
        return napi_get_named_property(env, value, "value", out) == napi_ok;
    case TNA_EXPR_LOCATION: {
        napi_value get = NULL;
        return napi_get_named_property(env, value, "get", &get) == napi_ok && tna_invoke(frame, get, 0, NULL, out);
    }
    }
    return false;
}

/* ------------------------------------------------------------------------
 * The vtable
 */

static ta_result tna_dm_init_instance(void *self, const ta_datamodel_init_instance_params *params) {
    tna_js_datamodel *dm = tna_dm_of(self);
    tna_dm_instance *instance = params->instance;
    *instance = (tna_dm_instance){ .root = { NULL, NULL } };
    if (params->binding != NULL && params->binding->v != NULL) {
        instance->root = *params->binding;
        ta_value_retain(&instance->root);
        return TA_OK;
    }
    if (!dm->js_usable) {
        return TA_ERR_UNSUPPORTED;
    }
    napi_handle_scope scope = NULL;
    napi_value root = NULL;
    if (napi_open_handle_scope(dm->env, &scope) != napi_ok) {
        return TA_ERR_NOMEM;
    }
    bool made = napi_create_object(dm->env, &root) == napi_ok && tna_value_make(&dm->wrapper->values, root, &instance->root);
    napi_close_handle_scope(dm->env, scope);
    return made ? TA_OK : TA_ERR_NOMEM;
}

static void tna_dm_destroy_instance(void *self, void *shared, void *instance) {
    (void)self;
    (void)shared;
    tna_dm_instance *data = instance;
    ta_value_release(&data->root);
    data->root = (ta_value){ NULL, NULL };
}

static ta_op_status tna_dm_declare(void *self, const ta_datamodel_declare_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_env env = frame.dm->env;
    napi_value root = NULL;
    napi_value key = NULL;
    napi_value undefined = NULL;
    bool has = false;
    ta_op_status status = TA_OP_OK;
    if (!tna_root(&frame, &root) || !tna_named_property(&frame, params->name, &key) ||
        napi_has_own_property(env, root, key, &has) != napi_ok) {
        status = tna_fail(&frame, "javascript: could not declare data");
    } else if (has) {
        if (params->bound != NULL) {
            *params->bound = true;
        }
    } else if (napi_get_undefined(env, &undefined) != napi_ok || napi_set_property(env, root, key, undefined) != napi_ok) {
        status = tna_fail(&frame, "javascript: could not declare data");
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_set_named(void *self, const ta_datamodel_set_named_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_env env = frame.dm->env;
    napi_value root = NULL;
    napi_value key = NULL;
    napi_value value = NULL;
    ta_op_status status = TA_OP_OK;
    if (!tna_value_get(env, params->value, &value)) {
        status = tna_fail(&frame, "javascript: data value is not a JavaScript value");
    } else if (!tna_root(&frame, &root) || !tna_named_property(&frame, params->name, &key) ||
               napi_set_property(env, root, key, value) != napi_ok) {
        status = tna_fail(&frame, "javascript: could not set data");
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_eval_condition(void *self, const ta_datamodel_eval_condition_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_value value = NULL;
    napi_value flag = NULL;
    ta_op_status status = TA_OP_OK;
    if (!tna_evaluate(&frame, params->shared, params->expr, &value) ||
        napi_coerce_to_bool(frame.dm->env, value, &flag) != napi_ok ||
        napi_get_value_bool(frame.dm->env, flag, params->out) != napi_ok) {
        status = tna_fail(&frame, "javascript: condition threw");
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_eval_value(void *self, const ta_datamodel_eval_value_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_value value = NULL;
    ta_op_status status = TA_OP_OK;
    if (!tna_evaluate(&frame, params->shared, params->expr, &value)) {
        status = tna_fail(&frame, "javascript: expression threw");
    } else if (!tna_value_make(&frame.dm->wrapper->values, value, params->out)) {
        status = tna_fail(&frame, "javascript: cannot keep the value");
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_read_location(void *self, const ta_datamodel_read_location_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    const ta_expression *expression = tna_expression(params->shared, params->location);
    const tna_expr_record *record = tna_record_of(expression);
    ta_str name = { NULL, 0 };
    napi_value value = NULL;
    ta_op_status status = TA_OP_OK;
    bool location = record != NULL ? record->kind == TNA_EXPR_LOCATION
                                   : expression != NULL && expression->kind == TA_EXPRESSION_SOURCE &&
                                         tna_source(expression->as.source, &name) == TNA_SOURCE_NAME;
    if (!location) {
        status = tna_fail(&frame, "javascript: not a location");
    } else if (!tna_evaluate(&frame, params->shared, params->location, &value)) {
        status = tna_fail(&frame, "javascript: location threw");
    } else if (!tna_value_make(&frame.dm->wrapper->values, value, params->out)) {
        status = tna_fail(&frame, "javascript: cannot keep the value");
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_assign(void *self, const ta_datamodel_assign_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_env env = frame.dm->env;
    const ta_expression *expression = tna_expression(params->shared, params->location);
    const tna_expr_record *record = tna_record_of(expression);
    napi_value value = NULL;
    ta_op_status status = TA_OP_OK;
    if (!tna_value_get(env, params->value, &value)) {
        status = tna_fail(&frame, "javascript: assigned value is not a JavaScript value");
    } else if (record != NULL && record->kind == TNA_EXPR_LOCATION) {
        napi_value location = tna_expression_value(env, expression);
        napi_value set = NULL;
        if (location == NULL || napi_get_named_property(env, location, "set", &set) != napi_ok ||
            !tna_invoke(&frame, set, 1, &value, NULL)) {
            status = tna_fail(&frame, "javascript: assign threw");
        }
    } else {
        ta_str name = { NULL, 0 };
        napi_value root = NULL;
        napi_value key = NULL;
        bool has = false;
        if (record != NULL || expression == NULL || expression->kind != TA_EXPRESSION_SOURCE ||
            tna_source(expression->as.source, &name) != TNA_SOURCE_NAME) {
            status = tna_fail(&frame, "javascript: not a location");
        } else if (!tna_root(&frame, &root) || !tna_named_property(&frame, name, &key) ||
                   napi_has_own_property(env, root, key, &has) != napi_ok) {
            status = tna_fail(&frame, "javascript: invalid location");
        } else if (!has) {
            status = tna_fail(&frame, "javascript: assignment to an undeclared data name");
        } else if (napi_set_property(env, root, key, value) != napi_ok) {
            status = tna_fail(&frame, "javascript: assign threw");
        }
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_execute_script(void *self, const ta_datamodel_execute_script_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    const ta_expression *expression = tna_expression(params->shared, params->script);
    const tna_expr_record *record = tna_record_of(expression);
    napi_value function = tna_expression_value(frame.dm->env, expression);
    ta_op_status status = TA_OP_OK;
    if (record == NULL || record->kind != TNA_EXPR_FUNCTION || function == NULL) {
        status = tna_fail(&frame, "javascript: a script must be a function");
    } else if (!tna_invoke(&frame, function, 0, NULL, NULL)) {
        status = tna_fail(&frame, "javascript: script threw");
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_make_params(void *self, const ta_datamodel_make_params_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_env env = frame.dm->env;
    napi_value object = NULL;
    ta_op_status status = TA_OP_OK;
    if (napi_create_object(env, &object) != napi_ok) {
        status = tna_fail(&frame, "javascript: could not make params");
    }
    for (uint32_t at = 0; status == TA_OP_OK && at < params->count; at += 1) {
        napi_value key = NULL;
        napi_value value = NULL;
        if (!tna_value_get(env, &params->values[at].value, &value)) {
            status = tna_fail(&frame, "javascript: parameter is not a JavaScript value");
        } else if (!tna_named_property(&frame, params->values[at].name, &key) ||
                   napi_set_property(env, object, key, value) != napi_ok) {
            status = tna_fail(&frame, "javascript: could not make params");
        }
    }
    if (status == TA_OP_OK && !tna_value_make(&frame.dm->wrapper->values, object, params->out)) {
        status = tna_fail(&frame, "javascript: cannot keep the params");
    }
    tna_end(&frame);
    return status;
}

static ta_result tna_dm_inspect(void *self, const ta_datamodel_inspect_params *params) {
    (void)self;
    const tna_dm_instance *instance = params->instance;
    *params->out = instance->root;
    ta_value_retain(params->out);
    return TA_OK;
}

static ta_op_status tna_dm_value_text(void *self, const ta_datamodel_value_text_params *params) {
    tna_js_datamodel *dm = tna_dm_of(self);
    if (!tna_value_ours(params->value)) {
        *params->fault = (ta_fault){ .code = TA_ERR_UNSUPPORTED,
                                     .message = { "javascript: not a JavaScript value", 34 } };
        return TA_OP_ERROR;
    }
    tna_frame frame;
    if (!tna_begin(&frame, dm, params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    /* Only copying the text can run out of memory, and that changes nothing
     * the chart can see: core stops and asks again (core ADR 0070). */
    ta_result result = tna_value_text(&dm->wrapper->values, params->value, params->out);
    ta_op_status status = result == TA_OK      ? TA_OP_OK
                          : result == TA_ERR_NOMEM ? TA_OP_NOMEM
                                                   : tna_fail(&frame, "javascript: value has no text");
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_text_value(void *self, const ta_datamodel_text_value_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_value text = NULL;
    ta_op_status status = TA_OP_OK;
    if (napi_create_string_utf8(frame.dm->env, params->text.ptr, params->text.len, &text) != napi_ok ||
        !tna_value_make(&frame.dm->wrapper->values, text, params->out)) {
        status = tna_fail(&frame, "javascript: could not make text");
    }
    tna_end(&frame);
    return status;
}

/* Literal content: JSON when it parses, otherwise the text (a string). */
/*
 * Content that is not JSON is a space-normalized string (SCXML B.2.2): runs
 * of XML whitespace become one space, and none leads or trails.
 * TA_OP_NOMEM when the copy cannot be allocated, which changes nothing.
 */
static ta_op_status tna_space_normalized(napi_env env, tna_values *values, ta_bytes content, napi_value *out) {
    char *normal = tna_alloc(values->allocator, content.len == 0 ? 1u : content.len, 1);
    if (normal == NULL) {
        return TA_OP_NOMEM;
    }
    size_t length = 0;
    bool space = false;
    for (uint32_t at = 0; at < content.len; at += 1) {
        char c = (char)content.ptr[at];
        if (tna_space(c)) {
            space = length != 0;
            continue;
        }
        if (space) {
            normal[length++] = ' ';
            space = false;
        }
        normal[length++] = c;
    }
    napi_status status = napi_create_string_utf8(env, normal, length, out);
    tna_free(values->allocator,
             &(ta_allocator_free_params){ .ptr = normal, .size = content.len == 0 ? 1u : content.len, .alignment = 1 });
    return status == napi_ok ? TA_OP_OK : TA_OP_ERROR;
}

static ta_op_status tna_dm_import_content(void *self, const ta_datamodel_import_content_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_env env = frame.dm->env;
    napi_value text = NULL;
    napi_value parse = NULL;
    napi_value global = NULL;
    napi_value value = NULL;
    ta_op_status status = TA_OP_OK;
    if (napi_create_string_utf8(env, (const char *)params->content.ptr, params->content.len, &text) != napi_ok) {
        status = tna_fail(&frame, "javascript: content is not text");
    } else {
        if (napi_get_reference_value(env, frame.dm->json_parse, &parse) != napi_ok ||
            napi_get_global(env, &global) != napi_ok ||
            napi_call_function(env, global, parse, 1, &text, &value) != napi_ok) {
            napi_value ignored = NULL;
            bool pending = false;
            if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
                napi_get_and_clear_last_exception(env, &ignored);
            }
            status = tna_space_normalized(env, &frame.dm->wrapper->values, params->content, &value);
            if (status == TA_OP_ERROR) {
                status = tna_fail(&frame, "javascript: content is not text");
            }
        }
        if (status == TA_OP_OK && !tna_value_make(&frame.dm->wrapper->values, value, params->out)) {
            status = tna_fail(&frame, "javascript: could not import content");
        }
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_foreach_snapshot(void *self, const ta_datamodel_foreach_snapshot_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    napi_env env = frame.dm->env;
    napi_value array = NULL;
    napi_value from = NULL;
    napi_value global = NULL;
    napi_value snapshot = NULL;
    uint32_t length = 0;
    bool is_array = false;
    ta_op_status status = TA_OP_OK;
    if (!tna_evaluate(&frame, params->shared, params->array, &array)) {
        status = tna_fail(&frame, "javascript: foreach array threw");
    } else if (napi_is_array(env, array, &is_array) != napi_ok || !is_array) {
        status = tna_fail(&frame, "javascript: foreach array is not an array");
    } else if (napi_get_reference_value(env, frame.dm->array_from, &from) != napi_ok ||
               napi_get_global(env, &global) != napi_ok ||
               !tna_js_call(&frame, global, from, 1, &array, &snapshot) ||
               napi_get_array_length(env, snapshot, &length) != napi_ok) {
        status = tna_fail(&frame, "javascript: cannot copy the foreach array");
    } else if (!tna_value_make(&frame.dm->wrapper->values, snapshot, params->out)) {
        status = tna_fail(&frame, "javascript: cannot keep the foreach array");
    } else {
        *params->count = length;
    }
    tna_end(&frame);
    return status;
}

/*
 * A variable name, as SCXML 4.6 requires of <foreach>'s `item` and `index`:
 * an identifier, [A-Za-z_$] then [A-Za-z0-9_$]. A byte past ASCII is taken
 * as part of a Unicode identifier.
 */
static bool tna_variable_name(ta_str name) {
    if (name.len == 0) {
        return false;
    }
    for (uint32_t at = 0; at < name.len; at += 1) {
        unsigned char c = (unsigned char)name.ptr[at];
        bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$' || c >= 0x80u;
        if (!letter && !(at != 0 && c >= '0' && c <= '9')) {
            return false;
        }
    }
    return true;
}

static ta_op_status tna_dm_foreach_bind(void *self, const ta_datamodel_foreach_bind_params *params) {
    tna_frame frame;
    if (!tna_begin(&frame, tna_dm_of(self), params->instance, params->host, params->fault)) {
        return TA_OP_ERROR;
    }
    /* Checked before anything is bound, so a bad name changes nothing. */
    if (!tna_variable_name(params->item) ||
        (params->index_name.ptr != NULL && !tna_variable_name(params->index_name))) {
        ta_op_status refused = tna_fail(&frame, "javascript: a <foreach> item or index is not a variable name");
        tna_end(&frame);
        return refused;
    }
    napi_env env = frame.dm->env;
    napi_value snapshot = NULL;
    napi_value item = NULL;
    napi_value root = NULL;
    napi_value key = NULL;
    ta_op_status status = TA_OP_OK;
    if (!tna_value_get(env, params->snapshot, &snapshot) || napi_get_element(env, snapshot, params->index, &item) != napi_ok ||
        !tna_root(&frame, &root) || !tna_named_property(&frame, params->item, &key) ||
        napi_set_property(env, root, key, item) != napi_ok) {
        status = tna_fail(&frame, "javascript: cannot bind the foreach item");
    } else if (params->index_name.ptr != NULL) {
        napi_value index = NULL;
        if (!tna_named_property(&frame, params->index_name, &key) ||
            napi_create_uint32(env, params->index, &index) != napi_ok || napi_set_property(env, root, key, index) != napi_ok) {
            status = tna_fail(&frame, "javascript: cannot bind the foreach index");
        }
    }
    tna_end(&frame);
    return status;
}

static ta_op_status tna_dm_value_encode(void *self, const ta_datamodel_value_encode_params *params);
static ta_op_status tna_dm_value_decode(void *self, const ta_datamodel_value_decode_params *params);

static const ta_datamodel_vtable tna_dm_vtable = {
    .name = { "javascript", 10 },
    .prepare_definition = tna_dm_prepare,
    .destroy_definition = tna_dm_destroy_definition,
    .instance_size = tna_dm_instance_size,
    .instance_alignment = tna_dm_instance_alignment,
    .init_instance = tna_dm_init_instance,
    .destroy_instance = tna_dm_destroy_instance,
    .declare = tna_dm_declare,
    .set_named = tna_dm_set_named,
    .eval_condition = tna_dm_eval_condition,
    .eval_value = tna_dm_eval_value,
    .read_location = tna_dm_read_location,
    .assign = tna_dm_assign,
    .execute_script = tna_dm_execute_script,
    .make_params = tna_dm_make_params,
    .inspect = tna_dm_inspect,
    .value_text = tna_dm_value_text,
    .text_value = tna_dm_text_value,
    .import_content = tna_dm_import_content,
    .foreach_snapshot = tna_dm_foreach_snapshot,
    .foreach_bind = tna_dm_foreach_bind,
    .value_encode = tna_dm_value_encode,
    .value_decode = tna_dm_value_decode,
};

/* ------------------------------------------------------------------------
 * Offloading (core ADR 0074)
 *
 * A value's bytes start with a tag: 'S' and v8.serialize's bytes, which
 * v8.deserialize reads back as a new object, so the value leaves the
 * JavaScript heap; or 'H' and the value box itself, retained, for a value
 * serialization refuses (a function, a class instance with private state)
 * or when the system keeps every value by handle. A handle keeps the object
 * alive: it frees only core's part of the actor.
 */

#define TNA_OFFLOAD_SERIALIZED 'S'
#define TNA_OFFLOAD_HANDLE 'H'

static ta_allocator tna_offload_allocator(tna_js_datamodel *dm) {
    return tna_allocator_for(&dm->wrapper->system->allocator, TNA_MEMORY_OTHER);
}

static void tna_clear_exception(napi_env env) {
    bool pending = false;
    napi_value ignored = NULL;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
        napi_get_and_clear_last_exception(env, &ignored);
    }
}

/* TA_OP_ERROR when serialization refuses the value, so the caller keeps it by handle. */
static ta_op_status tna_offload_serialize(tna_js_datamodel *dm, const ta_datamodel_value_encode_params *params) {
    napi_env env = dm->env;
    napi_value value = NULL;
    napi_value serialize = NULL;
    napi_value global = NULL;
    napi_value buffer = NULL;
    void *data = NULL;
    size_t length = 0;
    if (!tna_value_get(env, params->value, &value) ||
        napi_get_reference_value(env, dm->serialize, &serialize) != napi_ok || serialize == NULL ||
        napi_get_global(env, &global) != napi_ok ||
        napi_call_function(env, global, serialize, 1, &value, &buffer) != napi_ok ||
        napi_get_buffer_info(env, buffer, &data, &length) != napi_ok) {
        tna_clear_exception(env);
        return TA_OP_ERROR;
    }
    uint8_t *copy = ta_arena_alloc(params->arena, length + 1u, 1);
    if (copy == NULL) {
        return TA_OP_NOMEM;
    }
    copy[0] = TNA_OFFLOAD_SERIALIZED;
    if (length != 0) {
        memcpy(copy + 1, data, length);
    }
    *params->out = (ta_bytes){ .ptr = copy, .len = length + 1u };
    return TA_OP_OK;
}

static ta_op_status tna_offload_handle(tna_js_datamodel *dm, const ta_datamodel_value_encode_params *params) {
    if (!dm->offloading) {
        return TA_OP_ERROR;
    }
    uint8_t *copy = ta_arena_alloc(params->arena, 1u + sizeof(ta_value), _Alignof(ta_value));
    if (copy == NULL) {
        return TA_OP_NOMEM;
    }
    /* One slot at a time: an actor holds few values, and the store frees the
     * array at exactly its count. */
    if (dm->handle_count == dm->handle_capacity) {
        uint32_t capacity = dm->handle_capacity + 1u;
        ta_allocator allocator = tna_offload_allocator(dm);
        ta_value *grown = tna_alloc(allocator, (size_t)capacity * sizeof(ta_value), _Alignof(ta_value));
        if (grown == NULL) {
            return TA_OP_NOMEM;
        }
        if (dm->handle_count != 0) {
            memcpy(grown, dm->handles, (size_t)dm->handle_count * sizeof(ta_value));
        }
        if (dm->handles != NULL) {
            tna_free(allocator, &(ta_allocator_free_params){ .ptr = dm->handles,
                                                             .size = (size_t)dm->handle_capacity * sizeof(ta_value),
                                                             .alignment = _Alignof(ta_value) });
        }
        dm->handles = grown;
        dm->handle_capacity = capacity;
    }
    ta_value kept = *params->value;
    ta_value_retain(&kept);
    dm->handles[dm->handle_count++] = kept;
    copy[0] = TNA_OFFLOAD_HANDLE;
    memcpy(copy + 1, &kept, sizeof kept);
    *params->out = (ta_bytes){ .ptr = copy, .len = 1u + sizeof kept };
    return TA_OP_OK;
}

static ta_op_status tna_dm_value_encode(void *self, const ta_datamodel_value_encode_params *params) {
    tna_js_datamodel *dm = ((tna_dm_adapter *)self)->dm;
    if (!tna_value_ours(params->value)) {
        return TA_OP_ERROR;
    }
    if (!dm->by_handle && dm->serialize != NULL && dm->js_usable) {
        ta_op_status status = tna_offload_serialize(dm, params);
        if (status != TA_OP_ERROR) {
            return status;
        }
    }
    return tna_offload_handle(dm, params);
}

static ta_op_status tna_dm_value_decode(void *self, const ta_datamodel_value_decode_params *params) {
    tna_js_datamodel *dm = ((tna_dm_adapter *)self)->dm;
    if (params->bytes.len < 1u) {
        return TA_OP_ERROR;
    }
    if (params->bytes.ptr[0] == TNA_OFFLOAD_HANDLE && params->bytes.len == 1u + sizeof(ta_value)) {
        ta_value kept;
        memcpy(&kept, params->bytes.ptr + 1, sizeof kept);
        if (!tna_value_ours(&kept)) {
            return TA_OP_ERROR;
        }
        ta_value_retain(&kept);
        *params->out = kept;
        return TA_OP_OK;
    }
    napi_env env = dm->env;
    napi_value buffer = NULL;
    napi_value deserialize = NULL;
    napi_value global = NULL;
    napi_value value = NULL;
    if (params->bytes.ptr[0] != TNA_OFFLOAD_SERIALIZED || dm->deserialize == NULL || !dm->js_usable) {
        return TA_OP_ERROR;
    }
    void *copied = NULL;
    if (napi_create_buffer_copy(env, params->bytes.len - 1u, params->bytes.ptr + 1, &copied, &buffer) != napi_ok ||
        napi_get_reference_value(env, dm->deserialize, &deserialize) != napi_ok || deserialize == NULL ||
        napi_get_global(env, &global) != napi_ok ||
        napi_call_function(env, global, deserialize, 1, &buffer, &value) != napi_ok) {
        tna_clear_exception(env);
        return TA_OP_ERROR;
    }
    return tna_value_make(&dm->wrapper->values, value, params->out) ? TA_OP_OK : TA_OP_NOMEM;
}

bool tna_js_datamodel_set_offload(tna_js_datamodel *dm, const tna_offload_values *values) {
    napi_ref serialize = NULL;
    napi_ref deserialize = NULL;
    if (values->serialize != NULL && values->deserialize != NULL &&
        (napi_create_reference(dm->env, values->serialize, 1, &serialize) != napi_ok ||
         napi_create_reference(dm->env, values->deserialize, 1, &deserialize) != napi_ok)) {
        if (serialize != NULL) {
            napi_delete_reference(dm->env, serialize);
        }
        return false;
    }
    if (dm->serialize != NULL) {
        napi_delete_reference(dm->env, dm->serialize);
    }
    if (dm->deserialize != NULL) {
        napi_delete_reference(dm->env, dm->deserialize);
    }
    dm->serialize = serialize;
    dm->deserialize = deserialize;
    dm->by_handle = values->by_handle;
    return true;
}

void tna_js_datamodel_offload_begin(tna_js_datamodel *dm) {
    dm->offloading = true;
    dm->handles = NULL;
    dm->handle_count = 0;
    dm->handle_capacity = 0;
}

/* The array's capacity is its count, as the offload store frees it. */
tna_offload_handles tna_js_datamodel_offload_end(tna_js_datamodel *dm) {
    tna_offload_handles taken = { .handles = dm->handles, .count = dm->handle_count };
    dm->offloading = false;
    dm->handles = NULL;
    dm->handle_count = 0;
    dm->handle_capacity = 0;
    return taken;
}

void tna_js_datamodel_release_handles(tna_js_datamodel *dm, tna_offload_handles handles) {
    for (uint32_t index = 0; index < handles.count; index += 1) {
        ta_value_release(&handles.handles[index]);
    }
    if (handles.handles != NULL) {
        tna_free(tna_offload_allocator(dm),
                 &(ta_allocator_free_params){ .ptr = handles.handles, .size = (size_t)handles.count * sizeof(ta_value),
                                              .alignment = _Alignof(ta_value) });
    }
}

ta_datamodel tna_js_datamodel_adapter(tna_js_datamodel *dm) {
    return (ta_datamodel){ .self = &dm->builtin, .v = &dm->builtin.vtable };
}

static void tna_adapter_init(tna_dm_adapter *adapter, tna_js_datamodel *dm, ta_str name) {
    *adapter = (tna_dm_adapter){ .dm = dm, .vtable = tna_dm_vtable };
    memcpy(adapter->name, name.ptr, name.len);
    adapter->name[name.len] = '\0';
    adapter->vtable.name = (ta_str){ adapter->name, name.len };
}

ta_result tna_js_datamodel_register(tna_js_datamodel *dm, ta_str name, napi_value compile) {
    if (name.len == 0 || name.len >= TNA_DM_NAME_MAX || dm->registered_count >= TNA_DM_REGISTERED_MAX ||
        (name.len == 10 && memcmp(name.ptr, "javascript", 10) == 0) || (name.len == 4 && memcmp(name.ptr, "null", 4) == 0)) {
        return TA_ERR_INVALID;
    }
    for (uint32_t index = 0; index < dm->registered_count; index += 1) {
        const tna_dm_adapter *other = &dm->registered[index];
        if (other->vtable.name.len == name.len && memcmp(other->name, name.ptr, name.len) == 0) {
            return TA_ERR_INVALID;
        }
    }
    tna_dm_adapter *adapter = &dm->registered[dm->registered_count];
    tna_adapter_init(adapter, dm, name);
    if (napi_create_reference(dm->env, compile, 1, &adapter->compile) != napi_ok) {
        return TA_ERR_NOMEM;
    }
    dm->registered_count += 1u;
    return TA_OK;
}

uint32_t tna_js_datamodel_choices(tna_js_datamodel *dm, ta_datamodel *out) {
    uint32_t count = 0;
    out[count++] = tna_js_datamodel_adapter(dm);
    out[count++] = ta_null_datamodel();
    for (uint32_t index = 0; index < dm->registered_count; index += 1) {
        out[count++] = (ta_datamodel){ .self = &dm->registered[index], .v = &dm->registered[index].vtable };
    }
    return count;
}

/* ------------------------------------------------------------------------
 * The evaluation context
 */

static tna_js_datamodel *tna_context_dm(napi_env env, napi_callback_info info, size_t *argc, napi_value *argv) {
    void *data = NULL;
    if (napi_get_cb_info(env, info, argc, argv, NULL, &data) != napi_ok || data == NULL) {
        return NULL;
    }
    tna_js_datamodel *dm = data;
    if (dm->host == NULL) {
        tna_throw(env, "invalid", "the evaluation context is valid only while its expression runs");
        return NULL;
    }
    return dm;
}

/*
 * System-variable text (core's view, ADR 0068): a string, or undefined when
 * the variable has no value. When core cannot render it for lack of memory,
 * it throws and marks the call failed (see `text_failed`), so the failure
 * reaches core as TA_OP_ERROR instead of reading as undefined.
 */
static bool tna_host_io_text(napi_env env, tna_js_datamodel *dm, ta_dm_text_kind kind, uint32_t io_index,
                             napi_value *out) {
    ta_str text = { 0 };
    *out = NULL;
    ta_result result = ta_dm_host_text(dm->host, &(ta_dm_text_params){ .kind = kind, .io_index = io_index, .out = &text });
    if (result == TA_OK) {
        return napi_create_string_utf8(env, text.len == 0 ? "" : text.ptr, text.len, out) == napi_ok;
    }
    if (result == TA_ERR_NOT_FOUND) {
        return napi_get_undefined(env, out) == napi_ok;
    }
    dm->text_failed = true;
    tna_throw(env, "out-of-memory", "core could not render a system variable");
    return false;
}

static bool tna_host_text(napi_env env, tna_js_datamodel *dm, ta_dm_text_kind kind, napi_value *out) {
    return tna_host_io_text(env, dm, kind, 0, out);
}

static napi_value tna_get_data(napi_env env, napi_callback_info info) {
    tna_js_datamodel *dm = tna_context_dm(env, info, NULL, NULL);
    napi_value root = NULL;
    if (dm == NULL || dm->instance == NULL || !tna_value_get(env, &((tna_dm_instance *)dm->instance)->root, &root)) {
        return NULL;
    }
    return root;
}

static const char *const tna_event_types[] = { "external", "internal", "platform" };

/* object[name] = the variable's text, unless it has no value. */
static bool tna_set_text(napi_env env, tna_js_datamodel *dm, napi_value object, const char *name, ta_dm_text_kind kind) {
    napi_value text = NULL;
    napi_valuetype type = napi_undefined;
    if (!tna_host_text(env, dm, kind, &text) || napi_typeof(env, text, &type) != napi_ok) {
        return false;
    }
    return type == napi_undefined || napi_set_named_property(env, object, name, text) == napi_ok;
}

/*
 * _event: built once per callback, on first use, and held by a reference
 * until the callback ends (each getter call has its own handle scope).
 */
static napi_value tna_get_event(napi_env env, napi_callback_info info) {
    tna_js_datamodel *dm = tna_context_dm(env, info, NULL, NULL);
    if (dm == NULL) {
        return NULL;
    }
    napi_value cached = NULL;
    if (dm->event != NULL && napi_get_reference_value(env, dm->event, &cached) == napi_ok && cached != NULL) {
        return cached;
    }
    const ta_event *event = ta_dm_host_event(dm->host);
    napi_value object = NULL;
    napi_value type = NULL;
    napi_value data = NULL;
    if (event == NULL) {
        napi_get_undefined(env, &object);
        return object;
    }
    napi_value name = NULL;
    if (napi_create_object(env, &object) != napi_ok || !tna_host_text(env, dm, TA_DM_TEXT_EVENT_NAME, &name) ||
        napi_set_named_property(env, object, "name", name) != napi_ok ||
        napi_create_string_utf8(env, tna_event_types[event->type <= TA_EVENT_PLATFORM ? event->type : 0], NAPI_AUTO_LENGTH,
                                &type) != napi_ok ||
        napi_set_named_property(env, object, "type", type) != napi_ok ||
        !tna_set_text(env, dm, object, "sendID", TA_DM_TEXT_EVENT_SENDID) ||
        !tna_set_text(env, dm, object, "origin", TA_DM_TEXT_EVENT_ORIGIN) ||
        !tna_set_text(env, dm, object, "originType", TA_DM_TEXT_EVENT_ORIGINTYPE) ||
        !tna_set_text(env, dm, object, "invocationID", TA_DM_TEXT_EVENT_INVOKEID) ||
        !tna_value_get(env, &event->data, &data) || napi_set_named_property(env, object, "data", data) != napi_ok) {
        return NULL;
    }
    napi_create_reference(env, object, 1, &dm->event);
    return object;
}

static napi_value tna_get_session_id(napi_env env, napi_callback_info info) {
    tna_js_datamodel *dm = tna_context_dm(env, info, NULL, NULL);
    napi_value text = NULL;
    return dm != NULL && tna_host_text(env, dm, TA_DM_TEXT_SESSION_ID, &text) ? text : NULL;
}

static napi_value tna_get_name(napi_env env, napi_callback_info info) {
    tna_js_datamodel *dm = tna_context_dm(env, info, NULL, NULL);
    napi_value text = NULL;
    return dm != NULL && tna_host_text(env, dm, TA_DM_TEXT_SESSION_NAME, &text) ? text : NULL;
}

/* _ioprocessors: the SCXML Event I/O Processor, by its type URI and "scxml". */
/*
 * _ioprocessors: one {location} per processor core lists, keyed by its type
 * (SCXML 5.10, ADR 0068). The SCXML processor, index 0, is also "scxml".
 */
static napi_value tna_get_io_processors(napi_env env, napi_callback_info info) {
    tna_js_datamodel *dm = tna_context_dm(env, info, NULL, NULL);
    if (dm == NULL) {
        return NULL;
    }
    napi_value processors = NULL;
    if (napi_create_object(env, &processors) != napi_ok) {
        return NULL;
    }
    for (uint32_t index = 0;; index += 1) {
        /* Processors are listed until the type at an index has no value. */
        napi_value key = NULL;
        napi_valuetype kind = napi_undefined;
        if (!tna_host_io_text(env, dm, TA_DM_TEXT_IO_TYPE, index, &key) || napi_typeof(env, key, &kind) != napi_ok) {
            return NULL;
        }
        if (kind == napi_undefined) {
            break;
        }
        napi_value entry = NULL;
        napi_value location = NULL;
        if (napi_create_object(env, &entry) != napi_ok ||
            !tna_host_io_text(env, dm, TA_DM_TEXT_IO_LOCATION, index, &location) ||
            napi_typeof(env, location, &kind) != napi_ok) {
            return NULL;
        }
        if (kind == napi_string) {
            napi_set_named_property(env, entry, "location", location);
        }
        if (napi_set_property(env, processors, key, entry) != napi_ok) {
            return NULL;
        }
        if (index == 0) {
            napi_set_named_property(env, processors, "scxml", entry);
        }
    }
    return processors;
}

static napi_value tna_in_state_method(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = { NULL };
    tna_js_datamodel *dm = tna_context_dm(env, info, &argc, argv);
    if (dm == NULL) {
        return NULL;
    }
    char stack[256];
    size_t length = 0;
    napi_valuetype type = napi_undefined;
    if (argc < 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, argv[0], stack, sizeof stack, &length) != napi_ok) {
        return tna_throw(env, "invalid", "inState(): expected a state ID");
    }
    napi_value result = NULL;
    napi_get_boolean(env, tna_in_state(dm->host, (ta_str){ stack, (uint32_t)length }), &result);
    return result;
}

static bool tna_global_function(napi_env env, const char *object_name, const char *function_name, napi_ref *out) {
    napi_value global = NULL;
    napi_value object = NULL;
    napi_value function = NULL;
    return napi_get_global(env, &global) == napi_ok &&
           napi_get_named_property(env, global, object_name, &object) == napi_ok &&
           napi_get_named_property(env, object, function_name, &function) == napi_ok &&
           napi_create_reference(env, function, 1, out) == napi_ok;
}

bool tna_js_datamodel_init(tna_js_datamodel *dm, tna_napi_system *wrapper, napi_env env) {
    *dm = (tna_js_datamodel){ .wrapper = wrapper, .env = env, .js_usable = true };
    tna_adapter_init(&dm->builtin, dm, (ta_str){ "javascript", 10 });
    napi_value context = NULL;
    napi_property_descriptor properties[] = {
        { "data", NULL, NULL, tna_get_data, NULL, NULL, napi_enumerable, dm },
        { "event", NULL, NULL, tna_get_event, NULL, NULL, napi_enumerable, dm },
        { "sessionID", NULL, NULL, tna_get_session_id, NULL, NULL, napi_enumerable, dm },
        { "name", NULL, NULL, tna_get_name, NULL, NULL, napi_enumerable, dm },
        { "ioProcessors", NULL, NULL, tna_get_io_processors, NULL, NULL, napi_enumerable, dm },
        { "inState", NULL, tna_in_state_method, NULL, NULL, NULL, napi_enumerable, dm },
    };
    return napi_create_object(env, &context) == napi_ok &&
           napi_define_properties(env, context, sizeof properties / sizeof properties[0], properties) == napi_ok &&
           napi_object_freeze(env, context) == napi_ok && napi_create_reference(env, context, 1, &dm->context) == napi_ok &&
           tna_global_function(env, "JSON", "parse", &dm->json_parse) &&
           tna_global_function(env, "Array", "from", &dm->array_from);
}

void tna_js_datamodel_close(tna_js_datamodel *dm, bool refs_usable) {
    napi_ref *refs[] = { &dm->context, &dm->json_parse, &dm->array_from, &dm->serialize, &dm->deserialize };
    for (size_t at = 0; at < sizeof refs / sizeof refs[0]; at += 1) {
        if (*refs[at] != NULL && refs_usable) {
            napi_delete_reference(dm->env, *refs[at]);
        }
        *refs[at] = NULL;
    }
    /* The compilers go with the system (ADR 0019 section 3). */
    for (uint32_t index = 0; index < dm->registered_count; index += 1) {
        if (dm->registered[index].compile != NULL && refs_usable) {
            napi_delete_reference(dm->env, dm->registered[index].compile);
        }
        dm->registered[index].compile = NULL;
    }
}
