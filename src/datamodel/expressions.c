/* The native datamodel's expressions (AGENTS.md, "Rules the suite cannot
 * see": compiled once, lazily, as a strict function inside `with
 * (scope)`). Each expression is a vm.Script of its own, compiled at its
 * first evaluation, so a syntax error is that evaluation's
 * error.execution and the chart's other expressions still run (docs/plan.xml,
 * finding x-syntax). In the shared context it runs once to give a function
 * of the scope, kept in the chart's record; in a declaring session's own
 * context, a script runs as global code and every other expression is a
 * strict function made once per session from the chart's vm.Script. */
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
static const char ta_napi_strict_block[] = "'use strict';{\n";
static const char ta_napi_own_value[] = "(function(){'use strict';return (\n";
static const char ta_napi_own_value_end[] = "\n);})";
static const char ta_napi_own_setter[] = "(function(__v){'use strict';(\n";
static const char ta_napi_own_setter_end[] = "\n) = __v;})";

#define TA_NAPI_TEXT(text) ((ta_string_view){(text), sizeof(text) - 1})

bool ta_napi_expression_of(const ta_napi_chart_row *chart, ta_expression e, ta_expression_info *info) {
    return chart->image != NULL && ta_image_expression(chart->image, (ta_chart_item){chart->chart, e}, info) == TA_OK;
}

static bool ta_napi_space(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

bool ta_napi_strict_directive(ta_string_view source) {
    uint32_t at = 0;
    while (at < source.length && ta_napi_space(source.pointer[at])) at++;
    if (source.length - at < 12) return false;
    char quote = source.pointer[at];
    return (quote == '\'' || quote == '"') && memcmp(source.pointer + at + 1, "use strict", 10) == 0 &&
           source.pointer[at + 11] == quote;
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
 * kept there at its first use; null kept when it did not compile, so it is
 * not compiled again. `shared` makes a function of the script, run in the
 * shared context (read only here, when it compiles: an evaluation does not
 * read it); without it the vm.Script itself is kept. */
typedef struct ta_napi_compiled {
    napi_value cache;
    bool shared; /* false: keep the vm.Script */
    ta_napi_script_of shape;
} ta_napi_compiled;

static napi_value ta_napi_compiled_of(ta_napi_evaluation *evaluation, const ta_napi_compiled *compiled) {
    napi_env env = evaluation->env;
    napi_value kept;
    napi_valuetype type = napi_undefined;
    uint32_t e = compiled->shape.index;
    if (napi_get_element(env, compiled->cache, e, &kept) != napi_ok || napi_typeof(env, kept, &type) != napi_ok) return NULL;
    if (type == napi_null) return ta_napi_fail(env, "the expression did not compile");
    if (type != napi_undefined) return kept;
    napi_value made = ta_napi_script(evaluation->native, &compiled->shape), shared, context;
    if (made != NULL && compiled->shared)
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

/* A declaring session's function for `e`, made in its context from the
 * chart's vm.Script (`cache` the session's own, `scripts` the chart's). */
typedef struct ta_napi_own_of {
    uint32_t cache, scripts; /* TA_NAPI_OWN_GETTERS / _SETTERS, TA_NAPI_CHART_GETTERS / _SETTERS */
    ta_napi_script_of shape;
} ta_napi_own_of;

static napi_value ta_napi_own_function(ta_napi_evaluation *evaluation, const ta_napi_own_of *of) {
    napi_env env = evaluation->env;
    napi_value cache, scripts, context, kept;
    napi_valuetype type = napi_undefined;
    uint32_t e = of->shape.index;
    if (napi_get_element(env, evaluation->own, of->cache, &cache) != napi_ok ||
        napi_get_element(env, cache, e, &kept) != napi_ok || napi_typeof(env, kept, &type) != napi_ok)
        return NULL;
    if (type == napi_function) return kept;
    if (napi_get_element(env, evaluation->record, of->scripts, &scripts) != napi_ok ||
        napi_get_element(env, evaluation->own, TA_NAPI_OWN_CONTEXT, &context) != napi_ok)
        return NULL;
    napi_value script = ta_napi_compiled_of(evaluation, &(ta_napi_compiled){scripts, false, of->shape});
    napi_value made = script != NULL ? ta_napi_run_in(env, script, context) : NULL;
    if (made == NULL || napi_set_element(env, cache, e, made) != napi_ok) return NULL;
    return made;
}

napi_value ta_napi_evaluate(ta_napi_evaluation *evaluation, ta_expression e) {
    napi_env env = evaluation->env;
    ta_expression_info info;
    if (!ta_napi_expression_of(&evaluation->row, e, &info)) return ta_napi_fail(env, "no such expression");
    if (info.kind == TA_EXPRESSION_CONTENT) return ta_napi_content(evaluation, info.source);
    /* a chart's top-level <script> is global code; one in executable content
     * runs in a block, so its let, const and class are its own at each run */
    bool script = info.kind == TA_EXPRESSION_SCRIPT || info.kind == TA_EXPRESSION_GLOBAL_SCRIPT;
    bool block = info.kind == TA_EXPRESSION_SCRIPT;
    ta_string_view source = script ? info.source : ta_napi_trimmed(info.source);
    napi_value result = NULL, function, undefined;
    if (napi_get_undefined(env, &undefined) != napi_ok) return NULL;
    if (evaluation->own == NULL) { /* the shared context: a function of the scope */
        napi_value cache;
        if (napi_get_element(env, evaluation->record, TA_NAPI_CHART_GETTERS, &cache) != napi_ok) return NULL;
        ta_napi_script_of shape = script ? (ta_napi_script_of){TA_NAPI_TEXT(ta_napi_shared_script), source,
                                                               TA_NAPI_TEXT(ta_napi_shared_script_end), e}
                                         : (ta_napi_script_of){TA_NAPI_TEXT(ta_napi_shared_value), source,
                                                               TA_NAPI_TEXT(ta_napi_shared_value_end), e};
        function = ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, true, shape});
        if (function == NULL ||
            napi_call_function(env, undefined, function, 1, &evaluation->scope, &result) != napi_ok)
            return NULL;
        return result;
    }
    if (script) { /* its own context: global code, so its declarations are the session's */
        napi_value scripts, context;
        if (napi_get_element(env, evaluation->record, TA_NAPI_CHART_GETTERS, &scripts) != napi_ok ||
            napi_get_element(env, evaluation->own, TA_NAPI_OWN_CONTEXT, &context) != napi_ok)
            return NULL;
        /* a block takes no directive: a script that starts with 'use strict'
         * is strict as a whole, as it was when it ran as global code */
        ta_napi_script_of shape = !block ? (ta_napi_script_of){{"\n", 1}, source, {NULL, 0}, e}
                                  : ta_napi_strict_directive(source)
                                      ? (ta_napi_script_of){TA_NAPI_TEXT(ta_napi_strict_block), source, {"\n}", 2}, e}
                                      : (ta_napi_script_of){{"{\n", 2}, source, {"\n}", 2}, e};
        napi_value made = ta_napi_compiled_of(evaluation, &(ta_napi_compiled){scripts, false, shape});
        return made != NULL ? ta_napi_run_in(env, made, context) : NULL;
    }
    ta_napi_own_of of = {TA_NAPI_OWN_GETTERS, TA_NAPI_CHART_GETTERS,
                         {TA_NAPI_TEXT(ta_napi_own_value), source, TA_NAPI_TEXT(ta_napi_own_value_end), e}};
    function = ta_napi_own_function(evaluation, &of);
    if (function == NULL || napi_call_function(env, undefined, function, 0, NULL, &result) != napi_ok) return NULL;
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
    if (evaluation->own == NULL) {
        napi_value cache, function, argv[2] = {evaluation->scope, assignment->value};
        if (napi_get_element(env, evaluation->record, TA_NAPI_CHART_SETTERS, &cache) != napi_ok) return false;
        ta_napi_script_of shape = {TA_NAPI_TEXT(ta_napi_shared_setter), source, TA_NAPI_TEXT(ta_napi_shared_setter_end), e};
        function = ta_napi_compiled_of(evaluation, &(ta_napi_compiled){cache, true, shape});
        return function != NULL && napi_call_function(env, undefined, function, 2, argv, &result) == napi_ok;
    }
    ta_napi_own_of of = {TA_NAPI_OWN_SETTERS, TA_NAPI_CHART_SETTERS,
                         {TA_NAPI_TEXT(ta_napi_own_setter), source, TA_NAPI_TEXT(ta_napi_own_setter_end), e}};
    napi_value function = ta_napi_own_function(evaluation, &of);
    napi_value value = assignment->value;
    return function != NULL && napi_call_function(env, undefined, function, 1, &value, &result) == napi_ok;
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
