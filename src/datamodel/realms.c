/* The native datamodel's contexts (docs/plan.xml, decision d-declarations):
 * node:vm, reached with process.getBuiltinModule (a JavaScript call made
 * with Node-API, not V8's C++ API), its contexts, and the realm's script
 * (realm.js, embedded by the build) every context runs for its kit. One
 * context per host holds every chart and session of its native datamodel.
 * What a chart's scripts declare is asked of the engine, through the kit:
 * the addon parses no JavaScript.
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

/* A new context and its kit: its record, or NULL with an exception
 * pending. Its Object.prototype joins the instance's `realms`. */
static napi_value ta_napi_realm_new(ta_napi_native *native) {
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

napi_value ta_napi_realm_application(napi_env env) {
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
