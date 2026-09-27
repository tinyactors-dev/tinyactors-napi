#include "napi_children.h"

#include <stdio.h>
#include <string.h>

#include "import.h"
#include "napi_system.h"
#include "pump.h"
#include "runtime.h"

typedef struct {
    ta_definition_id definition;
    napi_ref resolve;
} tna_child_resolver;

static ta_allocator tna_children_allocator(tna_napi_system *wrapper) {
    return tna_allocator_for(&wrapper->system->allocator, TNA_MEMORY_OTHER);
}

/* ------------------------------------------------------------------------
 * resolve(src) as a core resolver
 */

static ta_result tna_fetch_src(void *self, ta_str src, ta_arena *arena, ta_bytes *out) {
    tna_src_resolver *resolver = self;
    napi_env env = resolver->env;
    napi_value text = NULL;
    napi_value result = NULL;
    napi_value global = NULL;
    if (napi_create_string_utf8(env, src.len == 0 ? "" : src.ptr, src.len, &text) != napi_ok ||
        napi_get_global(env, &global) != napi_ok ||
        napi_call_function(env, global, resolver->resolve, 1, &text, &result) != napi_ok) {
        return TA_ERR_NOT_FOUND;
    }
    napi_valuetype type = napi_undefined;
    bool typed = false;
    if (napi_typeof(env, result, &type) != napi_ok || type == napi_undefined || type == napi_null) {
        return TA_ERR_NOT_FOUND;
    }
    size_t length = 0;
    if (type == napi_string) {
        if (napi_get_value_string_utf8(env, result, NULL, 0, &length) != napi_ok || length > UINT32_MAX - 1u) {
            return TA_ERR_NOT_FOUND;
        }
        char *copy = ta_arena_alloc(arena, length + 1u, 1);
        if (copy == NULL) {
            return TA_ERR_NOMEM;
        }
        napi_get_value_string_utf8(env, result, copy, length + 1u, &length);
        *out = (ta_bytes){ .ptr = (const uint8_t *)copy, .len = (uint32_t)length };
        return TA_OK;
    }
    napi_typedarray_type kind = napi_uint8_array;
    void *data = NULL;
    if (napi_is_typedarray(env, result, &typed) != napi_ok || !typed ||
        napi_get_typedarray_info(env, result, &kind, &length, &data, NULL, NULL) != napi_ok ||
        kind != napi_uint8_array || length > UINT32_MAX) {
        napi_throw_type_error(env, NULL, "resolve(src) must return a string, a Uint8Array or undefined");
        return TA_ERR_NOT_FOUND;
    }
    uint8_t *copy = ta_arena_alloc(arena, length == 0 ? 1u : length, 1);
    if (copy == NULL) {
        return TA_ERR_NOMEM;
    }
    memcpy(copy, data, length);
    *out = (ta_bytes){ .ptr = copy, .len = (uint32_t)length };
    return TA_OK;
}

static const ta_chart_src_resolver_vtable tna_src_resolver_vtable = { .fetch = tna_fetch_src };

ta_chart_src_resolver tna_src_resolver_adapter(tna_src_resolver *resolver) {
    if (resolver->resolve == NULL) {
        return (ta_chart_src_resolver){ 0 };
    }
    return (ta_chart_src_resolver){ .self = resolver, .v = &tna_src_resolver_vtable };
}

/* ------------------------------------------------------------------------
 * Resolvers kept per definition
 */

static napi_value tna_resolver_of(tna_napi_system *wrapper, ta_definition_id definition) {
    const tna_vec *resolvers = &wrapper->children.resolvers;
    for (uint32_t at = 0; at < resolvers->count; at += 1) {
        const tna_child_resolver *entry = tna_vec_at(resolvers, at);
        if (entry->definition == definition) {
            napi_value resolve = NULL;
            return napi_get_reference_value(wrapper->env, entry->resolve, &resolve) == napi_ok ? resolve : NULL;
        }
    }
    return NULL;
}

void tna_children_forget(tna_napi_system *wrapper, ta_definition_id definition) {
    /* In a finalizer or after the environment's cleanup hook no reference
     * may be deleted; the environment takes them with it. */
    bool usable = wrapper->dm.js_usable && !wrapper->env_data->torn_down;
    tna_vec *resolvers = &wrapper->children.resolvers;
    uint32_t kept = 0;
    for (uint32_t at = 0; at < resolvers->count; at += 1u) {
        tna_child_resolver *entry = tna_vec_at(resolvers, at);
        if (entry->definition == definition) {
            if (usable) {
                napi_delete_reference(wrapper->env, entry->resolve);
            }
            continue;
        }
        *(tna_child_resolver *)tna_vec_at(resolvers, kept) = *entry;
        kept += 1u;
    }
    resolvers->count = kept;
}

ta_result tna_children_keep_resolver(tna_napi_system *wrapper, ta_definition_id definition, napi_value resolve) {
    tna_child_resolver entry = { .definition = definition };
    if (napi_create_reference(wrapper->env, resolve, 1, &entry.resolve) != napi_ok) {
        return TA_ERR_NOMEM;
    }
    ta_result result = tna_vec_push(&wrapper->children.resolvers, &entry);
    if (result != TA_OK) {
        napi_delete_reference(wrapper->env, entry.resolve);
    }
    return result;
}

/* ------------------------------------------------------------------------
 * Compiling a child chart (core ADR 0077)
 */

/* The family of an unnamed child: its parent's, with "/invoke" added. */
typedef struct {
    char text[256];
    ta_definition_identity identity;
} tna_child_family;

static void tna_child_family_of(tna_napi_system *wrapper, ta_definition_id parent, tna_child_family *out) {
    static const char suffix[] = "/invoke";
    ta_definition_inspection view;
    size_t length = 0;
    if (ta_definition_inspect(wrapper->system->core, parent, &view) == TA_OK) {
        length = view.identity.family.name.len;
        if (length > sizeof out->text - sizeof suffix) {
            length = sizeof out->text - sizeof suffix;
        }
        if (length != 0) {
            memcpy(out->text, view.identity.family.name.ptr, length);
        }
    }
    memcpy(out->text + length, suffix, sizeof suffix - 1u);
    length += sizeof suffix - 1u;
    /* An empty revision names only the family, for a chart with no name. */
    out->identity = (ta_definition_identity){ .family = { .name = { .ptr = out->text, .len = (uint32_t)length } } };
}

/*
 * Compiles and registers chart text as a child of `parent`, holding it.
 * `name` is what its spans call the text (core ADR 0085): the src it was
 * fetched from, or empty for a child written inside its parent, whose lines
 * count from the start of its <content> and so are not its parent's lines.
 */
static ta_result tna_compile_child(tna_napi_system *wrapper, ta_bytes text, ta_str name, ta_definition_id parent,
                                   napi_value resolve, ta_definition_id *out, tna_import_failure *failure) {
    tna_child_family family;
    tna_child_family_of(wrapper, parent, &family);
    tna_src_resolver fetcher = { .env = wrapper->env, .resolve = resolve };
    ta_datamodel choices[2u + TNA_DM_REGISTERED_MAX];
    uint32_t count = tna_js_datamodel_choices(&wrapper->dm, choices);
    ta_result result = tna_import_scxml(wrapper->system, &(tna_import_params){
                                                            .input = text,
                                                            .name = name,
                                                            .datamodels = choices,
                                                            .datamodel_count = count,
                                                            .out = out,
                                                            .failure = failure,
                                                            .resolver = tna_src_resolver_adapter(&fetcher),
                                                            .identity = &family.identity,
                                                        });
    if (result == TA_OK && resolve != NULL && tna_children_keep_resolver(wrapper, *out, resolve) != TA_OK) {
        (void)ta_system_release_definition(wrapper->system->core, *out);
        return TA_ERR_NOMEM;
    }
    return result;
}

/* ------------------------------------------------------------------------
 * Nesting the children of a chart when it is defined
 */

static bool tna_is_scxml_type(ta_str type) {
    static const char scxml[] = "http://www.w3.org/TR/scxml/";
    return type.len == sizeof scxml - 1u && memcmp(type.ptr, scxml, type.len) == 0;
}

/* Says which child of which chart was refused, and why. */
static void tna_child_refused(tna_import_failure *failure, uint32_t invoke, ta_result result) {
    char reason[sizeof failure->message];
    size_t length = strlen(failure->message);
    memcpy(reason, failure->message, length + 1u);
    if (result != TA_ERR_INVALID && result != TA_ERR_UNSUPPORTED) {
        snprintf(reason, sizeof reason, "%s", result == TA_ERR_DEFINITION_MISMATCH
                                                  ? "its identity is taken by another chart"
                                                  : "it could not be compiled");
        failure->located = false;
    }
    if (failure->located) {
        snprintf(failure->message, sizeof failure->message,
                 "the child chart of <invoke> %u is refused at line %u, column %u of its content: %s", invoke,
                 failure->line, failure->column, reason);
    } else {
        snprintf(failure->message, sizeof failure->message, "the child chart of <invoke> %u is refused: %s", invoke,
                 reason);
    }
    /* The position is in the child's text, not the document being defined. */
    failure->located = false;
}

ta_result tna_children_nest(tna_napi_system *wrapper, ta_definition_id definition, napi_value resolve,
                            tna_import_failure *failure) {
    ta_system *core = wrapper->system->core;
    tna_vec pending;
    tna_vec_init(&pending, tna_children_allocator(wrapper), TNA_LAYOUT(ta_definition_id));
    ta_result result = tna_vec_push(&pending, &definition);
    while (result == TA_OK && pending.count != 0) {
        ta_definition_id parent = *(const ta_definition_id *)tna_vec_at(&pending, pending.count - 1u);
        pending.count -= 1u;
        ta_definition_inspection view;
        if (ta_definition_inspect(core, parent, &view) != TA_OK) {
            continue;
        }
        for (uint32_t invoke = 0; result == TA_OK && invoke < view.invoke_count; invoke += 1u) {
            ta_invoke_info info;
            if (ta_definition_invoke(core, &(ta_definition_invoke_params){ .definition = parent, .invoke = invoke,
                                                                         .out = &info }) != TA_OK ||
                info.nested != 0 || info.has_type_expr || !tna_is_scxml_type(info.type)) {
                continue;
            }
            ta_content_info content;
            ta_bytes text = { 0 };
            ta_str name = { 0 };
            ta_arena arena;
            bool fetched = false;
            if (info.content != TA_CONTENT_ID_NONE) {
                if (ta_definition_content(core, &(ta_definition_content_params){
                                                    .definition = parent, .content = info.content, .out = &content }) != TA_OK) {
                    continue;
                }
                text = content.bytes;
            } else if (info.src != TA_CONTENT_ID_NONE && resolve != NULL) {
                if (ta_definition_content(core, &(ta_definition_content_params){
                                                    .definition = parent, .content = info.src, .out = &content }) != TA_OK) {
                    continue;
                }
                if (ta_arena_init(&arena, tna_children_allocator(wrapper), 4096) != TA_OK) {
                    result = TA_ERR_NOMEM;
                    break;
                }
                fetched = true;
                tna_src_resolver fetcher = { .env = wrapper->env, .resolve = resolve };
                name = (ta_str){ .ptr = (const char *)content.bytes.ptr, .len = content.bytes.len };
                result = tna_fetch_src(&fetcher, name, &arena, &text);
                if (result == TA_ERR_NOT_FOUND) {
                    *failure = (tna_import_failure){ .stage = TA_IMPORT_STAGE_DECODE, .located = false };
                    snprintf(failure->message, sizeof failure->message,
                             "the child chart of <invoke> %u is refused: resolve(src) knows no chart for src %.*s", invoke,
                             (int)content.bytes.len, (const char *)content.bytes.ptr);
                    result = TA_ERR_INVALID;
                }
            } else {
                continue;
            }
            ta_definition_id child = 0;
            if (result == TA_OK) {
                wrapper->system->definitions.registering = TNA_ORIGIN_NESTED;
                result = tna_compile_child(wrapper, text, name, parent, resolve, &child, failure);
                wrapper->system->definitions.registering = TNA_ORIGIN_HOST;
                if (result != TA_OK && result != TA_ERR_NOMEM) {
                    tna_child_refused(failure, invoke, result);
                    result = result == TA_ERR_UNSUPPORTED ? TA_ERR_UNSUPPORTED : TA_ERR_INVALID;
                }
            }
            if (fetched) {
                ta_arena_destroy(&arena);
            }
            if (result != TA_OK) {
                break;
            }
            /* The parent holds the child; the hold registration took goes back. */
            result = ta_definition_nest(core, &(ta_definition_nest_params){ .parent = parent, .invoke = invoke,
                                                                          .child = child });
            (void)ta_system_release_definition(core, child);
            if (result == TA_OK) {
                result = tna_vec_push(&pending, &child);
            }
        }
    }
    tna_vec_destroy(&pending);
    return result;
}

/* ------------------------------------------------------------------------
 * The invoker's question
 */

static ta_op_status tna_child_fault(tna_napi_system *wrapper, ta_fault *fault, ta_result code, const char *message) {
    size_t length = strlen(message);
    if (length >= sizeof wrapper->children.failure) {
        length = sizeof wrapper->children.failure - 1u;
    }
    if (message != wrapper->children.failure) {
        memcpy(wrapper->children.failure, message, length);
    }
    wrapper->children.failure[length] = '\0';
    *fault = (ta_fault){ .code = code, .message = { .ptr = wrapper->children.failure, .len = (uint32_t)length } };
    return TA_OP_ERROR;
}

/* A definition ID carried as a bigint or a safe integer, as builder charts do. */
static bool tna_definition_value(napi_env env, napi_value js, ta_definition_id *out) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, js, &type) != napi_ok) {
        return false;
    }
    if (type == napi_bigint) {
        uint64_t id = 0;
        bool lossless = false;
        if (napi_get_value_bigint_uint64(env, js, &id, &lossless) != napi_ok || !lossless || id == 0) {
            return false;
        }
        *out = id;
        return true;
    }
    if (type == napi_number) {
        double number = 0;
        if (napi_get_value_double(env, js, &number) != napi_ok || !(number >= 1) || number > 9007199254740991.0 ||
            number != (double)(uint64_t)number) {
            return false;
        }
        *out = (uint64_t)number;
        return true;
    }
    return false;
}

/* The invoking parent: its definition, and the resolver it was defined with (or NULL). */
typedef struct {
    ta_definition_id definition;
    napi_value resolve;
} tna_invoking;

static tna_invoking tna_parent_of(tna_napi_system *wrapper, ta_actor_id parent) {
    ta_actor_inspection inspection;
    if (ta_actor_inspect(wrapper->system->core, parent, &inspection) != TA_OK) {
        return (tna_invoking){ 0 };
    }
    return (tna_invoking){ .definition = inspection.definition_id,
                           .resolve = tna_resolver_of(wrapper, inspection.definition_id) };
}

/* Clears what a resolver or a compiler threw inside the invoke; true when something had. */
static bool tna_clear_exception(napi_env env, char *message, size_t capacity) {
    bool pending = false;
    napi_value error = NULL;
    if (napi_is_exception_pending(env, &pending) != napi_ok || !pending ||
        napi_get_and_clear_last_exception(env, &error) != napi_ok) {
        return false;
    }
    napi_value text = NULL;
    size_t length = 0;
    if (napi_coerce_to_string(env, error, &text) == napi_ok &&
        napi_get_value_string_utf8(env, text, message, capacity, &length) == napi_ok) {
        return true;
    }
    message[0] = '\0';
    return true;
}

/* Compiles chart text from `<content expr>` or `srcexpr` for this invoke,
 * holding it until the invoker has spawned the child (core ADR 0077).
 * `name` is the src it was fetched from, or empty. */
static ta_op_status tna_compile_for_invoke(tna_napi_system *wrapper, const tna_child_params *params, ta_bytes text,
                                           ta_str name, tna_invoking parent) {
    tna_import_failure failure;
    wrapper->system->definitions.registering = TNA_ORIGIN_INVOKE;
    ta_result result =
        tna_compile_child(wrapper, text, name, parent.definition, parent.resolve, params->out, &failure);
    wrapper->system->definitions.registering = TNA_ORIGIN_HOST;
    char thrown[512];
    if (tna_clear_exception(wrapper->env, thrown, sizeof thrown)) {
        if (result == TA_OK) {
            (void)ta_system_release_definition(wrapper->system->core, *params->out);
        }
        return tna_child_fault(wrapper, params->fault, TA_ERR_INVALID, thrown);
    }
    if (result == TA_ERR_NOMEM) {
        return TA_OP_NOMEM;
    }
    if (result != TA_OK) {
        char *message = wrapper->children.failure;
        if (result == TA_ERR_DEFINITION_MISMATCH) {
            snprintf(message, sizeof wrapper->children.failure,
                     "invoker.scxml: the child chart is refused: its identity is taken by another chart");
        } else if (failure.located) {
            snprintf(message, sizeof wrapper->children.failure,
                     "invoker.scxml: the child chart is refused at line %u, column %u: %s", failure.line,
                     failure.column, failure.message);
        } else {
            snprintf(message, sizeof wrapper->children.failure, "invoker.scxml: the child chart is refused: %s",
                     failure.message);
        }
        return tna_child_fault(wrapper, params->fault, result, message);
    }
    *params->release = true;
    return TA_OP_OK;
}

static ta_op_status tna_child_definition_of(void *context, const tna_child_params *params) {
    tna_napi_system *wrapper = context;
    napi_env env = wrapper->env;
    const ta_invoke_request *request = params->request;
    if (env == NULL || wrapper->env_data->torn_down) {
        return tna_child_fault(wrapper, params->fault, TA_ERR_INVALID, "invoker.scxml: the environment is gone");
    }
    /* Nested when the parent was defined: already compiled (core ADR 0077). */
    if (request->definition != 0) {
        *params->out = request->definition;
        return TA_OP_OK;
    }
    napi_value data = NULL;
    napi_value src = NULL;
    if (request->data.v != NULL && tna_value_get(env, &request->data, &data)) {
        if (tna_definition_value(env, data, params->out)) {
            return TA_OP_OK;
        }
    }
    if (request->src.v != NULL && tna_value_get(env, &request->src, &src)) {
        if (tna_definition_value(env, src, params->out)) {
            return TA_OP_OK;
        }
    }
    /* A literal src arrives as text, never as a data-model value, so a chart
     * on the null data model can name one too. */
    if (request->src_text.ptr != NULL &&
        napi_create_string_utf8(env, request->src_text.ptr, request->src_text.len, &src) != napi_ok) {
        return tna_child_fault(wrapper, params->fault, TA_ERR_INVALID, "invoker.scxml: the src is not text");
    }
    tna_invoking parent = tna_parent_of(wrapper, request->parent);
    /* SCXML 6.4: content from <content expr> is the child chart's text. */
    napi_valuetype data_type = napi_undefined;
    if (data != NULL && napi_typeof(env, data, &data_type) == napi_ok && data_type == napi_string) {
        size_t length = 0;
        if (napi_get_value_string_utf8(env, data, NULL, 0, &length) != napi_ok || length > UINT32_MAX - 1u) {
            return tna_child_fault(wrapper, params->fault, TA_ERR_INVALID, "invoker.scxml: the content is not text");
        }
        char *text = ta_arena_alloc(&wrapper->system->scratch.call, length + 1u, 1);
        if (text == NULL) {
            return TA_OP_NOMEM;
        }
        napi_get_value_string_utf8(env, data, text, length + 1u, &length);
        return tna_compile_for_invoke(wrapper, params, (ta_bytes){ .ptr = (const uint8_t *)text, .len = (uint32_t)length },
                                      (ta_str){ 0 }, parent);
    }
    /* A literal <content> not nested at define time: a computed type, or a
     * chart defined without SCXML. */
    if (request->content.len != 0) {
        return tna_compile_for_invoke(wrapper, params, request->content, (ta_str){ 0 }, parent);
    }
    napi_valuetype src_type = napi_undefined;
    if (src != NULL && napi_typeof(env, src, &src_type) == napi_ok && src_type == napi_string) {
        if (parent.resolve == NULL) {
            return tna_child_fault(wrapper, params->fault, TA_ERR_NOT_FOUND,
                                   "invoker.scxml: the invoke's src needs the parent's definition to have a resolve(src)");
        }
        size_t length = 0;
        napi_get_value_string_utf8(env, src, NULL, 0, &length);
        char *text = ta_arena_alloc(&wrapper->system->scratch.call, length + 1u, 1);
        if (text == NULL) {
            return TA_OP_NOMEM;
        }
        napi_get_value_string_utf8(env, src, text, length + 1u, &length);
        tna_src_resolver fetcher = { .env = env, .resolve = parent.resolve };
        ta_bytes chart = { 0 };
        ta_result fetched = tna_fetch_src(&fetcher, (ta_str){ .ptr = text, .len = (uint32_t)length },
                                          &wrapper->system->scratch.call, &chart);
        char thrown[512];
        if (tna_clear_exception(env, thrown, sizeof thrown)) {
            return tna_child_fault(wrapper, params->fault, TA_ERR_INVALID, thrown);
        }
        if (fetched == TA_ERR_NOMEM) {
            return TA_OP_NOMEM;
        }
        if (fetched != TA_OK) {
            snprintf(wrapper->children.failure, sizeof wrapper->children.failure,
                     "invoker.scxml: resolve(src) knows no chart for src %.*s", (int)length, text);
            return tna_child_fault(wrapper, params->fault, TA_ERR_NOT_FOUND, wrapper->children.failure);
        }
        return tna_compile_for_invoke(wrapper, params, chart, (ta_str){ .ptr = text, .len = (uint32_t)length }, parent);
    }
    return tna_child_fault(wrapper, params->fault, TA_ERR_INVALID,
                           "invoker.scxml: the invoke names no child: no definition, no <content> and no src");
}

/*
 * The child's binding (SCXML 6.4): of the invoke's <param> and namelist
 * values, only those whose names the child declares as top-level <data>.
 * A name it does not declare is not added.
 */
static ta_op_status tna_child_binding(tna_napi_system *wrapper, const tna_child_params *params) {
    const ta_invoke_request *request = params->request;
    napi_env env = wrapper->env;
    napi_value given = NULL;
    napi_valuetype type = napi_undefined;
    if (request->params.v == NULL || !tna_value_get(env, &request->params, &given) ||
        napi_typeof(env, given, &type) != napi_ok || type != napi_object) {
        return TA_OP_OK;
    }
    ta_arena arena;
    if (ta_arena_init(&arena, tna_children_allocator(wrapper), 4096) != TA_OK) {
        return TA_OP_NOMEM;
    }
    const ta_scxml_spec *spec = NULL;
    ta_result result = ta_definition_export(wrapper->system->core, &(ta_definition_export_params){
                                                                       .definition = *params->out,
                                                                       .arena = &arena,
                                                                       .out = &spec,
                                                                   });
    napi_value bound = NULL;
    bool made = result == TA_OK && napi_create_object(env, &bound) == napi_ok;
    for (const ta_scxml_data_spec *data = made ? spec->data : NULL; made && data != NULL && data->name.len != 0;
         data += 1) {
        napi_value key = NULL;
        napi_value value = NULL;
        bool has = false;
        made = napi_create_string_utf8(env, data->name.ptr, data->name.len, &key) == napi_ok &&
               napi_has_own_property(env, given, key, &has) == napi_ok;
        if (made && has) {
            made = napi_get_property(env, given, key, &value) == napi_ok &&
                   napi_set_property(env, bound, key, value) == napi_ok;
        }
    }
    ta_arena_destroy(&arena);
    if (result == TA_ERR_NOMEM || (made && !tna_value_make(&wrapper->values, bound, params->binding))) {
        return TA_OP_NOMEM;
    }
    if (!made) {
        return tna_child_fault(wrapper, params->fault, TA_ERR_INVALID, "invoker.scxml: could not bind the child's params");
    }
    return TA_OP_OK;
}

static ta_op_status tna_child_definition(void *context, const tna_child_params *params) {
    ta_op_status status = tna_child_definition_of(context, params);
    if (status == TA_OP_OK) {
        status = tna_child_binding(context, params);
        if (status != TA_OP_OK && *params->release) {
            (void)ta_system_release_definition(((tna_napi_system *)context)->system->core, *params->out);
            *params->release = false;
        }
    }
    return status;
}

void tna_children_init(tna_napi_system *wrapper) {
    ta_allocator allocator = tna_children_allocator(wrapper);
    tna_vec_init(&wrapper->children.resolvers, allocator, TNA_LAYOUT(tna_child_resolver));
    wrapper->children.failure[0] = '\0';
    wrapper->system->child_definition = tna_child_definition;
    wrapper->system->child_context = wrapper;
}

void tna_children_close(tna_napi_system *wrapper) {
    /* Core's teardown told of every definition it freed, so nothing is left. */
    tna_vec_destroy(&wrapper->children.resolvers);
    wrapper->system->child_definition = NULL;
}
