/* The native datamodel's contexts (docs/plan.xml, decision d-declarations):
 * node:vm, reached with process.getBuiltinModule (a JavaScript call made
 * with Node-API, not V8's C++ API), its contexts, and the realm's script
 * (realm.js, embedded by the build) every context runs for its kit. One
 * context per host is shared by the charts that declare nothing at the top
 * of their scripts; a declaring chart's session gets one of its own. Which
 * charts declare is asked of the engine: the addon parses no JavaScript.
 * In() is one function per environment that reads the evaluating
 * datamodel from the instance, so it holds no pointer that could outlive
 * a host. */
#include "datamodel.h"

#include <string.h>

static const char ta_napi_realm_source[] =
#include "realm.inc"
    ;

/* A string of `text` (UTF-8). */
static napi_value ta_napi_string(napi_env env, ta_string_view text) {
    napi_value value = NULL;
    if (napi_create_string_utf8(env, text.pointer != NULL ? text.pointer : "", text.length, &value) != napi_ok) return NULL;
    return value;
}

/* ---- In() ---------------------------------------------------------------------- */

/* In(state): whether the evaluating session is in `state` (SCXML 5.9.1),
 * through ta_datamodel_environment_in; false outside an evaluation. */
static napi_value ta_napi_in(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argument = NULL, result = NULL, text;
    if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok) return NULL;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL) return NULL;
    ta_napi_native *native = instance->evaluating;
    ta_datamodel_environment *environment = native != NULL ? native->environment : NULL;
    bool in = false;
    if (environment != NULL && argc >= 1) {
        if (napi_coerce_to_string(env, argument, &text) != napi_ok) return NULL;
        ta_napi_room room = {&native->output, &native->host->allocator, {NULL, 0}};
        if (!ta_napi_text_kept(env, text, &room)) return NULL;
        const ta_image *image = ta_datamodel_environment_image(environment);
        uint32_t state = ta_image_state_by_name(image, ta_datamodel_environment_chart(environment), room.view);
        in = state != TA_NIL && ta_datamodel_environment_in(environment, state) != 0;
    }
    napi_get_boolean(env, in, &result);
    return result;
}

/* ---- node:vm and the realm's script ---------------------------------------------- */

/* A named property of `object`, a function called on it with `argc`
 * arguments. */
typedef struct ta_napi_method {
    napi_value object;
    const char *name;
    size_t argc;
    const napi_value *argv;
} ta_napi_method;

static napi_value ta_napi_call_method(napi_env env, const ta_napi_method *method) {
    napi_value function, result = NULL;
    if (napi_get_named_property(env, method->object, method->name, &function) != napi_ok ||
        napi_call_function(env, method->object, function, method->argc, method->argv, &result) != napi_ok)
        return NULL;
    return result;
}

/* A new instance of global[name] with one argument (or none). */
static napi_value ta_napi_construct(napi_env env, const char *name, napi_value argument) {
    napi_value global, class, result = NULL;
    if (napi_get_global(env, &global) != napi_ok || napi_get_named_property(env, global, name, &class) != napi_ok ||
        napi_new_instance(env, class, argument != NULL ? 1 : 0, argument != NULL ? &argument : NULL, &result) != napi_ok)
        return NULL;
    return result;
}

/* An options object {filename: `name`}. */
static napi_value ta_napi_script_options(napi_env env, const char *name) {
    napi_value options, filename;
    if (napi_create_object(env, &options) != napi_ok || (filename = ta_napi_string(env, (ta_string_view){name, (uint32_t)strlen(name)})) == NULL ||
        napi_set_named_property(env, options, "filename", filename) != napi_ok)
        return NULL;
    return options;
}

/* new vm.Script(source, options) */
typedef struct ta_napi_compiling {
    napi_value vm;
    napi_value source;
    napi_value options;
} ta_napi_compiling;

static napi_value ta_napi_compile_script(napi_env env, const ta_napi_compiling *compiling) {
    napi_value class, script = NULL, argv[2] = {compiling->source, compiling->options};
    if (napi_get_named_property(env, compiling->vm, "Script", &class) != napi_ok ||
        napi_new_instance(env, class, 2, argv, &script) != napi_ok)
        return NULL;
    return script;
}

/* Keeps `value` in the instance's reference `*slot`. */
static bool ta_napi_keep(napi_env env, napi_value value, napi_ref *slot) {
    return value != NULL && napi_create_reference(env, value, 1, slot) == napi_ok;
}

/* node:vm, the realm's script, the WeakSet of realms, In() and
 * JSON.stringify in the instance, made once per environment. */
static ta_napi_instance *ta_napi_realm_module(napi_env env) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL || instance->realm != NULL) return instance;
    napi_value global, process, vm = NULL, source, options, script, realms, in, json, stringify;
    napi_value specifier = ta_napi_string(env, (ta_string_view){"node:vm", 7});
    if (specifier == NULL || napi_get_global(env, &global) != napi_ok ||
        napi_get_named_property(env, global, "process", &process) != napi_ok)
        return NULL;
    vm = ta_napi_call_method(env, &(ta_napi_method){process, "getBuiltinModule", 1, &specifier});
    if (vm == NULL) return NULL;
    if ((source = ta_napi_string(env, (ta_string_view){ta_napi_realm_source, sizeof ta_napi_realm_source - 1})) == NULL ||
        (options = ta_napi_script_options(env, "tinyactors:realm.js")) == NULL ||
        (script = ta_napi_compile_script(env, &(ta_napi_compiling){vm, source, options})) == NULL ||
        (realms = ta_napi_construct(env, "WeakSet", NULL)) == NULL ||
        napi_create_function(env, "In", NAPI_AUTO_LENGTH, ta_napi_in, NULL, &in) != napi_ok ||
        napi_get_named_property(env, global, "JSON", &json) != napi_ok ||
        napi_get_named_property(env, json, "stringify", &stringify) != napi_ok)
        return NULL;
    if (!ta_napi_keep(env, vm, &instance->vm) || !ta_napi_keep(env, realms, &instance->realms) ||
        !ta_napi_keep(env, in, &instance->in) || !ta_napi_keep(env, stringify, &instance->stringify) ||
        !ta_napi_keep(env, script, &instance->realm))
        return NULL;
    return instance;
}

napi_value ta_napi_run_in(napi_env env, napi_value script, napi_value context) {
    return ta_napi_call_method(env, &(ta_napi_method){script, "runInContext", 1, &context});
}

napi_value ta_napi_realm_new(ta_napi_native *native) {
    napi_env env = native->host->env;
    ta_napi_instance *instance = ta_napi_realm_module(env);
    if (instance == NULL) return NULL;
    napi_value vm, realm, realms, args[2], context, made, kit, prototype, record;
    if (napi_get_reference_value(env, instance->vm, &vm) != napi_ok ||
        napi_get_reference_value(env, instance->realm, &realm) != napi_ok ||
        napi_get_reference_value(env, instance->realms, &realms) != napi_ok ||
        napi_get_reference_value(env, instance->in, &args[0]) != napi_ok ||
        napi_get_reference_value(env, instance->address, &args[1]) != napi_ok)
        return NULL;
    if ((context = ta_napi_call_method(env, &(ta_napi_method){vm, "createContext", 0, NULL})) == NULL ||
        (made = ta_napi_run_in(env, realm, context)) == NULL || napi_call_function(env, context, made, 2, args, &kit) != napi_ok ||
        napi_get_named_property(env, kit, "objectPrototype", &prototype) != napi_ok ||
        ta_napi_call_method(env, &(ta_napi_method){realms, "add", 1, &prototype}) == NULL ||
        napi_create_array_with_length(env, 2, &record) != napi_ok ||
        napi_set_element(env, record, TA_NAPI_REALM_CONTEXT, context) != napi_ok ||
        napi_set_element(env, record, TA_NAPI_REALM_KIT, kit) != napi_ok)
        return NULL;
    return record;
}

/* The kit of the realm's script run in the application's realm, made once
 * per environment: what it makes is the application's (instanceof Array
 * holds there). */
static napi_value ta_napi_realm_application(napi_env env) {
    ta_napi_instance *instance = ta_napi_realm_module(env);
    napi_value kit = NULL, realm, made, args[2], global;
    if (instance == NULL) return NULL;
    if (instance->application != NULL && napi_get_reference_value(env, instance->application, &kit) == napi_ok && kit != NULL)
        return kit;
    if (napi_get_reference_value(env, instance->realm, &realm) != napi_ok ||
        napi_get_reference_value(env, instance->in, &args[0]) != napi_ok ||
        napi_get_reference_value(env, instance->address, &args[1]) != napi_ok || napi_get_global(env, &global) != napi_ok ||
        (made = ta_napi_call_method(env, &(ta_napi_method){realm, "runInThisContext", 0, NULL})) == NULL ||
        napi_call_function(env, global, made, 2, args, &kit) != napi_ok || !ta_napi_keep(env, kit, &instance->application))
        return NULL;
    return kit;
}

napi_value ta_napi_native_exported(ta_napi_native *native, ta_payload payload) {
    napi_env env = native->host->env;
    napi_value value = ta_napi_native_value(native, payload), kit;
    napi_valuetype type = napi_undefined;
    if (value == NULL || napi_typeof(env, value, &type) != napi_ok || (type != napi_object && type != napi_function)) return value;
    if ((kit = ta_napi_realm_application(env)) == NULL) return NULL;
    return ta_napi_kit(env, kit, &(ta_napi_kit_call){"exported", 1, {value}});
}

napi_value ta_napi_realm_shared(ta_napi_native *native) {
    napi_env env = native->host->env;
    napi_value record = ta_napi_native_get(native, native->shared), drops;
    if (record != NULL) return record;
    if ((record = ta_napi_realm_new(native)) == NULL || napi_create_array(env, &drops) != napi_ok ||
        !ta_napi_keep(env, record, &native->shared) || !ta_napi_keep(env, drops, &native->drops))
        return NULL;
    return record;
}

napi_value ta_napi_kit(napi_env env, napi_value kit, const ta_napi_kit_call *call) {
    return ta_napi_call_method(env, &(ta_napi_method){kit, call->name, call->argc, call->argv});
}

napi_value ta_napi_script(ta_napi_native *native, const ta_napi_script_of *of) {
    napi_env env = native->host->env;
    ta_napi_instance *instance = ta_napi_realm_module(env);
    if (instance == NULL) return NULL;
    size_t length = (size_t)of->prefix.length + of->source.length + of->suffix.length;
    ta_napi_room room = {&native->output, &native->host->allocator, {NULL, 0}};
    if (!ta_napi_room_grow(&room, length + 1)) {
        ta_napi_throw(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, "no memory for an expression's source"});
        return NULL;
    }
    char *text = (char *)native->output.pointer;
    size_t at = 0;
    const ta_string_view parts[] = {of->prefix, of->source, of->suffix};
    for (size_t i = 0; i < 3; i++) {
        if (parts[i].length > 0) memcpy(text + at, parts[i].pointer, parts[i].length);
        at += parts[i].length;
    }
    char name[32] = "<expr:";
    size_t used = 6;
    char digits[12];
    size_t count = 0;
    uint32_t index = of->index;
    do {
        digits[count++] = (char)('0' + index % 10);
        index /= 10;
    } while (index > 0 && count < sizeof digits);
    while (count > 0) name[used++] = digits[--count];
    name[used++] = '>';
    name[used] = '\0';
    napi_value vm, source, options;
    if (napi_get_reference_value(env, instance->vm, &vm) != napi_ok ||
        (source = ta_napi_string(env, (ta_string_view){text, (uint32_t)at})) == NULL ||
        (options = ta_napi_script_options(env, name)) == NULL)
        return NULL;
    return ta_napi_compile_script(env, &(ta_napi_compiling){vm, source, options});
}

/* ---- which charts declare ------------------------------------------------------------ */

/* The number of the global object's own names in `context`. */
static bool ta_napi_global_names(ta_napi_native *native, napi_value context, uint32_t *count) {
    napi_env env = native->host->env;
    static const char counting[] = "Object.getOwnPropertyNames(globalThis).length";
    napi_value script = ta_napi_script(native, &(ta_napi_script_of){{counting, sizeof counting - 1}, {NULL, 0}, {NULL, 0}, 0});
    napi_value value = script != NULL ? ta_napi_run_in(env, script, context) : NULL;
    return value != NULL && napi_get_value_uint32(env, value, count) == napi_ok;
}

/* One run of a script instantiated in `context` without running a
 * statement (`throw 0;` ahead of it): true when it was only that throw;
 * false when instantiating it threw (a redeclaration, a syntax error). */
static bool ta_napi_probe(ta_napi_native *native, napi_value script, napi_value context) {
    napi_env env = native->host->env;
    napi_value thrown = NULL;
    if (ta_napi_run_in(env, script, context) != NULL) return true;
    if (napi_get_and_clear_last_exception(env, &thrown) != napi_ok) return false;
    napi_valuetype type = napi_undefined;
    double number = -1;
    return napi_typeof(env, thrown, &type) == napi_ok && type == napi_number &&
           napi_get_value_double(env, thrown, &number) == napi_ok && number == 0;
}

bool ta_napi_realm_declares(ta_napi_native *native, ta_napi_chart_of *chart) {
    napi_env env = native->host->env;
    chart->declares = chart->lexical = false;
    chart->hoists = chart->functions = NULL;
    uint32_t count = ta_image_expression_count(chart->image, chart->chart);
    napi_value scratch = NULL, context = NULL, kit = NULL, hoists = NULL, strict = NULL, strict_kit = NULL;
    uint32_t before = 0, after = 0;
    /* A function declared in a sloppy block (a script in executable
     * content) is the global's var too (Annex B), and a declaration made
     * again when the script runs: its name is found as the names a strict
     * block, which makes no such var, leaves out, in a second scratch
     * context where every script is instantiated the strict way. */
    bool blocks = false;
    for (uint32_t e = 0; e < count && !blocks; e++) {
        ta_expression_info info;
        blocks = ta_image_expression(chart->image, (ta_chart_item){chart->chart, e}, &info) == TA_OK &&
                 info.kind == TA_EXPRESSION_SCRIPT && !ta_napi_strict_directive(info.source);
    }
    for (uint32_t e = 0; e < count; e++) {
        ta_expression_info info;
        if (ta_image_expression(chart->image, (ta_chart_item){chart->chart, e}, &info) != TA_OK ||
            (info.kind != TA_EXPRESSION_SCRIPT && info.kind != TA_EXPRESSION_GLOBAL_SCRIPT))
            continue;
        if (context == NULL) { /* a scratch context, once per chart that has a script */
            if ((scratch = ta_napi_realm_new(native)) == NULL ||
                napi_get_element(env, scratch, TA_NAPI_REALM_CONTEXT, &context) != napi_ok ||
                napi_get_element(env, scratch, TA_NAPI_REALM_KIT, &kit) != napi_ok ||
                napi_create_array(env, &hoists) != napi_ok || !ta_napi_global_names(native, context, &before))
                return false;
            napi_value made = blocks ? ta_napi_realm_new(native) : NULL;
            if (blocks && (made == NULL || napi_get_element(env, made, TA_NAPI_REALM_CONTEXT, &strict) != napi_ok ||
                           napi_get_element(env, made, TA_NAPI_REALM_KIT, &strict_kit) != napi_ok))
                return false;
        }
        /* as the session runs it (ta_napi_evaluate): a script in executable
         * content in a block, whose lexical declarations are not the global's */
        static const char ahead[] = "throw 0;\n", ahead_block[] = "throw 0;{\n", ahead_strict[] = "'use strict';throw 0;{\n";
        bool block = info.kind == TA_EXPRESSION_SCRIPT, directive = block && ta_napi_strict_directive(info.source);
        ta_napi_script_of block_of = {{directive ? ahead_strict : ahead_block, directive ? sizeof ahead_strict - 1 : sizeof ahead_block - 1},
                                      info.source, {"\n}", 2}, e};
        napi_value script = ta_napi_script(native, block ? &block_of
                                                         : &(ta_napi_script_of){{ahead, sizeof ahead - 1}, info.source, {NULL, 0}, e});
        if (script == NULL) { /* a syntax error: its evaluation's error.execution */
            napi_value ignored;
            napi_get_and_clear_last_exception(env, &ignored);
            continue;
        }
        if (napi_set_element(env, hoists, e, script) != napi_ok) return false;
        if (strict != NULL) { /* the strict way: a sloppy block's functions make no var there */
            napi_value strict_script = block && !directive
                ? ta_napi_script(native, &(ta_napi_script_of){{ahead_strict, sizeof ahead_strict - 1}, info.source, {"\n}", 2}, e})
                : script;
            if (strict_script == NULL || !ta_napi_probe(native, strict_script, strict)) { /* not strict code: as it is */
                napi_value ignored;
                napi_get_and_clear_last_exception(env, &ignored);
                ta_napi_probe(native, script, strict);
                napi_get_and_clear_last_exception(env, &ignored);
            }
        }
        if (!ta_napi_probe(native, script, context)) {
            chart->declares = chart->lexical = true; /* its declarations clash with the global's */
            continue;
        }
        if (!ta_napi_global_names(native, context, &after)) return false;
        /* var and function names are the global's now; let, const and class
         * ones are refused when instantiated again */
        bool again = ta_napi_probe(native, script, context);
        chart->declares = chart->declares || after != before || !again;
        chart->lexical = chart->lexical || !again;
        before = after;
    }
    if (!chart->declares) return true;
    chart->hoists = hoists;
    if (strict_kit != NULL) {
        napi_value strict_names = ta_napi_kit(env, strict_kit, &(ta_napi_kit_call){"globals", 0, {NULL}});
        chart->functions = strict_names != NULL ? ta_napi_kit(env, kit, &(ta_napi_kit_call){"remade", 1, {strict_names}}) : NULL;
    } else chart->functions = ta_napi_kit(env, kit, &(ta_napi_kit_call){"functions", 0, {NULL}});
    return chart->functions != NULL;
}

bool ta_napi_realm_hoist(ta_napi_native *native, napi_value record, napi_value context) {
    napi_env env = native->host->env;
    napi_value hoists, script;
    uint32_t length = 0;
    if (napi_get_element(env, record, TA_NAPI_CHART_HOISTS, &hoists) != napi_ok || napi_get_array_length(env, hoists, &length) != napi_ok)
        return false;
    for (uint32_t e = 0; e < length; e++) {
        bool has = false;
        if (napi_has_element(env, hoists, e, &has) != napi_ok) return false;
        if (!has) continue;
        if (napi_get_element(env, hoists, e, &script) != napi_ok) return false;
        if (!ta_napi_probe(native, script, context)) {
            napi_throw_error(env, NULL, "a script's declarations could not be made again");
            return false;
        }
    }
    return true;
}
