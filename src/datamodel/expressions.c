/* The native datamodel's expressions (AGENTS.md, "Rules the suite cannot
 * see": compiled once, lazily, as a strict function inside `with
 * (scope)`). Each expression is a vm.Script of its own, compiled at its
 * first evaluation and run once in the shared context to give a function
 * of the scope, kept in the chart's record, so a syntax error is that
 * evaluation's error.execution and the chart's other expressions still run
 * (docs/plan.xml, finding x-syntax). A script is compiled between the head
 * and tail the kit gave at chart_attach (its top-level vars read from the
 * scope and written back), or refused with the kit's reason. */
#include "datamodel.h"

#include <string.h>

/* The shapes an expression is compiled in: sloppy outside, so `with`
 * reaches the scope; strict inside, so an undeclared assignment throws. */
static const char ta_napi_shared_value[] = "(function(__s){with(__s){return (function(){'use strict';return (\n";
static const char ta_napi_shared_value_end[] = "\n);})();}})";
static const char ta_napi_shared_script[] = "(function(__s){with(__s){(function(){'use strict';\n";
static const char ta_napi_shared_script_end[] = "\n})();}})";
static const char ta_napi_shared_setter[] = "(function(__s,__v){with(__s){(function(){'use strict';(\n";
static const char ta_napi_shared_setter_end[] = "\n) = __v;})();}})";
#define TA_NAPI_TEXT(text) ((ta_string_view){(text), sizeof(text) - 1})

bool ta_napi_expression_of(const ta_napi_chart_row *chart, ta_expression e, ta_expression_info *info) {
    return chart->image != NULL && ta_image_expression(chart->image, (ta_chart_item){chart->chart, e}, info) == TA_OK;
}

static bool ta_napi_space(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

/* A value's source without a trailing `;` (expr="new Foo();"). */
static ta_string_view ta_napi_trimmed(ta_string_view source) {
    while (source.length > 0 && (source.pointer[source.length - 1] == ';' || ta_napi_space(source.pointer[source.length - 1])))
        source.length--;
    return source;
}

static napi_value ta_napi_fail(napi_env env, const char *message) {
    napi_throw_error(env, NULL, message);
    return NULL;
}

/* The compiled form of `e` in `cache` (a JavaScript array), compiled and
 * kept there at its first use: a function of the scope, run once in the
 * shared context. Null is kept when it did not compile, so it is not
 * compiled again; a string is a refusal, thrown at each evaluation. */
typedef struct ta_napi_compiled {
    napi_value cache;
    ta_napi_script_of shape;
} ta_napi_compiled;

static napi_value ta_napi_compiled_of(ta_napi_evaluation *evaluation, const ta_napi_compiled *compiled) {
    napi_env env = evaluation->env;
    napi_value kept;
    napi_valuetype type = napi_undefined;
    uint32_t e = compiled->shape.index;
    if (napi_get_element(env, compiled->cache, e, &kept) != napi_ok || napi_typeof(env, kept, &type) != napi_ok) return NULL;
    if (type == napi_null) return ta_napi_fail(env, "the expression did not compile");
    if (type == napi_string) {
        napi_value error;
        if (napi_create_error(env, NULL, kept, &error) == napi_ok) napi_throw(env, error);
        return NULL;
    }
    if (type != napi_undefined) return kept;
    napi_value made = ta_napi_script(evaluation->native, &compiled->shape), shared, context;
    if (made != NULL)
        made = (shared = ta_napi_realm_shared(evaluation->native)) != NULL &&
                       napi_get_element(env, shared, TA_NAPI_REALM_CONTEXT, &context) == napi_ok
                   ? ta_napi_run_in(env, made, context)
                   : NULL;
    if (made == NULL) { /* kept as null, and this evaluation fails with the SyntaxError */
        napi_value error = NULL, null;
        napi_get_and_clear_last_exception(env, &error);
        if (napi_get_null(env, &null) == napi_ok) napi_set_element(env, compiled->cache, e, null);
        if (error != NULL) napi_throw(env, error);
        return NULL;
    }
    if (napi_set_element(env, compiled->cache, e, made) != napi_ok) return NULL;
    return made;
}

/* A script's function: compiled between the head and tail chart_attach
 * kept for it (the texts copied into the host's arena for the call), or
 * its refusal kept in the cache; the plain shape for a script that does
 * not parse, whose evaluation then throws the SyntaxError. */
static napi_value ta_napi_script_function(ta_napi_evaluation *evaluation, napi_value cache, const ta_napi_script_of *plain) {
    napi_env env = evaluation->env;
    napi_value kept, scripts, prepared, part;
    napi_valuetype type = napi_undefined;
    uint32_t e = plain->index;
    if (napi_get_element(env, cache, e, &kept) != napi_ok || napi_typeof(env, kept, &type) != napi_ok) return NULL;
    if (type != napi_undefined) return ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, *plain});
    if (napi_get_element(env, evaluation->record, TA_NAPI_CHART_SCRIPTS, &scripts) != napi_ok ||
        napi_get_element(env, scripts, e, &prepared) != napi_ok || napi_typeof(env, prepared, &type) != napi_ok)
        return NULL;
    if (type == napi_string) { /* refused: kept, and thrown at each evaluation */
        if (napi_set_element(env, cache, e, prepared) != napi_ok) return NULL;
        return ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, *plain});
    }
    if (type != napi_object) return ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, *plain});
    ta_growable_arena *arena = &evaluation->native->host->arena;
    ta_growable_arena_mark mark = ta_growable_arena_position(arena);
    ta_napi_text head = {arena, "a script's head", {NULL, 0}}, tail = {arena, "a script's tail", {NULL, 0}};
    napi_value made = NULL;
    if (napi_get_element(env, prepared, 0, &part) == napi_ok && ta_napi_text_of(env, part, &head) &&
        napi_get_element(env, prepared, 1, &part) == napi_ok && ta_napi_text_of(env, part, &tail))
        made = ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, {head.view, plain->source, tail.view, e}});
    ta_napi_arena_release(arena, mark, TA_NAPI_ARENA_UNCAPPED);
    return made;
}

napi_value ta_napi_evaluate(ta_napi_evaluation *evaluation, ta_expression e) {
    napi_env env = evaluation->env;
    ta_expression_info info;
    if (!ta_napi_expression_of(&evaluation->row, e, &info)) return ta_napi_fail(env, "no such expression");
    if (info.kind == TA_EXPRESSION_CONTENT) return ta_napi_content(evaluation, info.source);
    bool script = info.kind == TA_EXPRESSION_SCRIPT || info.kind == TA_EXPRESSION_GLOBAL_SCRIPT;
    napi_value result = NULL, function, undefined, cache;
    if (napi_get_undefined(env, &undefined) != napi_ok ||
        napi_get_element(env, evaluation->record, TA_NAPI_CHART_GETTERS, &cache) != napi_ok)
        return NULL;
    if (script)
        function = ta_napi_script_function(evaluation, cache,
                                           &(ta_napi_script_of){TA_NAPI_TEXT(ta_napi_shared_script), info.source,
                                                                TA_NAPI_TEXT(ta_napi_shared_script_end), e});
    else
        function = ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, {TA_NAPI_TEXT(ta_napi_shared_value), ta_napi_trimmed(info.source),
                                                                                TA_NAPI_TEXT(ta_napi_shared_value_end), e}});
    if (function == NULL || napi_call_function(env, undefined, function, 1, &evaluation->scope, &result) != napi_ok) return NULL;
    return result;
}

/* The identifier a location starts with (ASCII; empty when it starts
 * with anything else). */
static ta_string_view ta_napi_leading_name(ta_string_view source) {
    uint32_t at = 0, length = 0;
    while (at < source.length && ta_napi_space(source.pointer[at])) at++;
    for (; at + length < source.length; length++) {
        char c = source.pointer[at + length];
        bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$';
        if (!letter && !(length > 0 && c >= '0' && c <= '9')) break;
    }
    return (ta_string_view){source.pointer + at, length};
}

bool ta_napi_assign(ta_napi_evaluation *evaluation, const ta_napi_assignment *assignment) {
    napi_env env = evaluation->env;
    ta_expression e = assignment->location;
    ta_expression_info info;
    if (!ta_napi_expression_of(&evaluation->row, e, &info)) {
        ta_napi_fail(env, "no such location");
        return false;
    }
    /* SCXML 5.4: a location the session does not have is error.execution,
     * so is a system variable; the name must be the scope's own */
    ta_string_view name = ta_napi_leading_name(info.source);
    napi_value key, undefined, result;
    bool own = false;
    if (name.length == 0 || napi_create_string_utf8(env, name.pointer, name.length, &key) != napi_ok ||
        napi_has_own_property(env, evaluation->scope, key, &own) != napi_ok || !own) {
        ta_napi_fail(env, "an assignment to a location the session does not declare");
        return false;
    }
    if (napi_get_undefined(env, &undefined) != napi_ok) return false;
    ta_string_view source = ta_napi_trimmed(info.source);
    napi_value cache, function, argv[2] = {evaluation->scope, assignment->value};
    if (napi_get_element(env, evaluation->record, TA_NAPI_CHART_SETTERS, &cache) != napi_ok) return false;
    ta_napi_script_of shape = {TA_NAPI_TEXT(ta_napi_shared_setter), source, TA_NAPI_TEXT(ta_napi_shared_setter_end), e};
    function = ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, shape});
    return function != NULL && napi_call_function(env, undefined, function, 2, argv, &result) == napi_ok;
}

/* ---- SCXML B.2: <content> and <data> text --------------------------------------- */

napi_value ta_napi_content(ta_napi_evaluation *evaluation, ta_string_view text) {
    napi_env env = evaluation->env;
    napi_value source, value, ignored;
    if (napi_create_string_utf8(env, text.pointer != NULL ? text.pointer : "", text.length, &source) != napi_ok) return NULL;
    value = ta_napi_kit(env, evaluation->kit, &(ta_napi_kit_call){"parse", 1, {source}});
    if (value != NULL) return value; /* JSON */
    napi_get_and_clear_last_exception(env, &ignored);
    uint32_t at = 0;
    while (at < text.length && ta_napi_space(text.pointer[at])) at++;
    if (at < text.length && text.pointer[at] == '<') { /* XML: a document */
        value = ta_napi_dom(&(ta_napi_xml){evaluation->native, evaluation->kit, text});
        bool pending = false;
        if (value != NULL || (napi_is_exception_pending(env, &pending) == napi_ok && pending)) return value;
    }
    /* else the text, its runs of whitespace one space, trimmed */
    ta_napi_room room = {&evaluation->native->output, &evaluation->native->host->allocator, {NULL, 0}};
    if (!ta_napi_room_grow(&room, (size_t)text.length + 1)) return ta_napi_fail(env, "no memory for the content");
    char *out = (char *)evaluation->native->output.pointer;
    size_t length = 0;
    for (uint32_t i = 0; i < text.length; i++) {
        if (!ta_napi_space(text.pointer[i])) out[length++] = text.pointer[i];
        else if (length > 0 && out[length - 1] != ' ') out[length++] = ' ';
    }
    while (length > 0 && out[length - 1] == ' ') length--;
    if (napi_create_string_utf8(env, out, length, &value) != napi_ok) return NULL;
    return value;
}
