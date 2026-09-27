#include "pump.h"

#include "napi_loads.h"
#include "napi_services.h"
#include "napi_trace.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "runtime.h"
#include "scheduler.h"
#include "system.h"

/* ------------------------------------------------------------------------
 * Options
 */

static bool tna_option(napi_env env, napi_value object, const char *name, napi_value *out) {
    bool has = false;
    *out = NULL;
    if (object == NULL || napi_has_named_property(env, object, name, &has) != napi_ok || !has) {
        return true;
    }
    if (napi_get_named_property(env, object, name, out) != napi_ok) {
        return false;
    }
    napi_valuetype type = napi_undefined;
    napi_typeof(env, *out, &type);
    if (type == napi_undefined) {
        *out = NULL;
    }
    return true;
}

/* A non-negative integer option, or `fallback` when absent. */
static bool tna_count_option(napi_env env, napi_value object, const char *name, uint32_t *inout) {
    napi_value value = NULL;
    if (!tna_option(env, object, name, &value)) {
        return false;
    }
    if (value == NULL) {
        return true;
    }
    double number = 0;
    if (napi_get_value_double(env, value, &number) != napi_ok || number < 0 || number > 4294967295.0 ||
        number != (double)(uint32_t)number) {
        char message[128];
        snprintf(message, sizeof message, "createSystem: scheduling.%s must be a non-negative integer", name);
        tna_throw(env, "invalid", message);
        return false;
    }
    *inout = (uint32_t)number;
    return true;
}

/* scheduling.maxRetainedBytes (ADR 0005 point 9): 0 or absent means no limit. */
static bool tna_bytes_option(napi_env env, napi_value object, const char *name, uint64_t *out) {
    napi_value value = NULL;
    if (!tna_option(env, object, name, &value)) {
        return false;
    }
    if (value == NULL) {
        return true;
    }
    double number = 0;
    if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0) || number > 9007199254740991.0) {
        char message[128];
        snprintf(message, sizeof message, "createSystem: scheduling.%s must be a non-negative number", name);
        tna_throw(env, "invalid", message);
        return false;
    }
    *out = (uint64_t)number;
    return true;
}

static bool tna_hook_option(napi_env env, napi_value object, const char *name, napi_ref *out) {
    napi_value value = NULL;
    if (!tna_option(env, object, name, &value)) {
        return false;
    }
    if (value == NULL) {
        return true;
    }
    napi_valuetype type = napi_undefined;
    napi_typeof(env, value, &type);
    if (type != napi_function) {
        char message[96];
        snprintf(message, sizeof message, "createSystem: %s must be a function", name);
        tna_throw(env, "invalid", message);
        return false;
    }
    return napi_create_reference(env, value, 1, out) == napi_ok;
}

/* clock: "realtime" (the default) or "manual". */
static bool tna_clock_option(napi_env env, napi_value object, tna_clock_kind *kind) {
    napi_value value = NULL;
    if (!tna_option(env, object, "clock", &value)) {
        return false;
    }
    if (value == NULL) {
        return true;
    }
    char text[16] = { 0 };
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, text, sizeof text, &length) != napi_ok ||
        (strcmp(text, "realtime") != 0 && strcmp(text, "manual") != 0)) {
        tna_throw(env, "invalid", "createSystem: clock must be \"realtime\" or \"manual\"");
        return false;
    }
    *kind = strcmp(text, "manual") == 0 ? TNA_CLOCK_MANUAL : TNA_CLOCK_REALTIME;
    return true;
}

/* A time in logical milliseconds: a non-negative safe integer. */
static bool tna_time_value(napi_env env, napi_value value, const char *what, ta_time *out) {
    double number = -1;
    if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0) || number > 9007199254740991.0 ||
        number != (double)(ta_time)number) {
        char message[128];
        snprintf(message, sizeof message, "%s must be a non-negative integer number of milliseconds", what);
        tna_throw(env, "invalid", message);
        return false;
    }
    *out = (ta_time)number;
    return true;
}

static bool tna_finished_option(napi_env env, napi_value object, bool *destroy) {
    napi_value value = NULL;
    if (!tna_option(env, object, "finished", &value)) {
        return false;
    }
    if (value == NULL) {
        return true;
    }
    char text[16] = { 0 };
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, text, sizeof text, &length) != napi_ok ||
        (strcmp(text, "destroy") != 0 && strcmp(text, "retain") != 0)) {
        tna_throw(env, "invalid", "createSystem: finished must be \"destroy\" or \"retain\"");
        return false;
    }
    *destroy = strcmp(text, "destroy") == 0;
    return true;
}

/* ------------------------------------------------------------------------
 * Waking
 */

static napi_value tna_turn_callback(napi_env env, napi_callback_info info);
static napi_value tna_timer_callback(napi_env env, napi_callback_info info);

/* Releases the hold a pending turn has on the wrapper. */
static void tna_pump_unhold(tna_napi_system *wrapper) {
    tna_napi_system_unhold(wrapper);
}

/* The wake callback (system.h): setImmediate(turn). */
static void tna_pump_wake(tna_system *system, void *context) {
    tna_napi_system *wrapper = context;
    napi_env env = wrapper->env;
    napi_value global = NULL;
    napi_value set_immediate = NULL;
    napi_value turn = NULL;
    napi_value ignored = NULL;
    napi_handle_scope scope = NULL;
    bool ok = napi_open_handle_scope(env, &scope) == napi_ok;
    ok = ok && napi_get_global(env, &global) == napi_ok &&
         napi_get_named_property(env, global, "setImmediate", &set_immediate) == napi_ok &&
         napi_get_reference_value(env, wrapper->turn_function, &turn) == napi_ok && turn != NULL;
    if (ok) {
        wrapper->holders += 1u; /* the pending turn holds the wrapper */
        if (napi_call_function(env, global, set_immediate, 1, &turn, &ignored) != napi_ok) {
            wrapper->holders -= 1u;
            ok = false;
        }
    }
    if (!ok) {
        system->turn_pending = false; /* a later request tries again */
    }
    if (scope != NULL) {
        napi_close_handle_scope(env, scope);
    }
}

/* Calls global[name](arguments...) and stores the result in `out` (may be NULL). */
static bool tna_call_global(napi_env env, const char *name, size_t argc, const napi_value *argv, napi_value *out) {
    napi_value global = NULL;
    napi_value function = NULL;
    napi_value ignored = NULL;
    return napi_get_global(env, &global) == napi_ok && napi_get_named_property(env, global, name, &function) == napi_ok &&
           napi_call_function(env, global, function, argc, argv, out != NULL ? out : &ignored) == napi_ok;
}

/* Clears the armed timer, if any, and drops its hold. JavaScript must be callable. */
static void tna_pump_clear_timer(napi_env env, tna_napi_system *wrapper) {
    if (wrapper->timeout != NULL) {
        napi_value timeout = NULL;
        if (napi_get_reference_value(env, wrapper->timeout, &timeout) == napi_ok && timeout != NULL) {
            (void)tna_call_global(env, "clearTimeout", 1, &timeout, NULL);
        }
        napi_delete_reference(env, wrapper->timeout);
        wrapper->timeout = NULL;
    }
    if (wrapper->timer_held) {
        wrapper->timer_held = false;
        tna_napi_system_unhold(wrapper);
    }
}

/* The arm callback (system.h): setTimeout(timer, delay).unref(). */
static void tna_pump_arm(tna_system *system, ta_time delay, void *context) {
    tna_napi_system *wrapper = context;
    napi_env env = wrapper->env;
    napi_handle_scope scope = NULL;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
        system->clock.armed = false;
        return;
    }
    tna_pump_clear_timer(env, wrapper);
    napi_value argv[2] = { NULL, NULL };
    napi_value timeout = NULL;
    bool ok = napi_get_reference_value(env, wrapper->timer_function, &argv[0]) == napi_ok && argv[0] != NULL &&
              napi_create_double(env, (double)delay, &argv[1]) == napi_ok &&
              tna_call_global(env, "setTimeout", 2, argv, &timeout);
    if (ok) {
        wrapper->holders += 1u; /* the pending timer holds the wrapper */
        wrapper->timer_held = true;
        napi_valuetype type = napi_undefined;
        napi_value unref = NULL;
        napi_value ignored = NULL;
        if (napi_typeof(env, timeout, &type) == napi_ok && (type == napi_object || type == napi_function) &&
            napi_get_named_property(env, timeout, "unref", &unref) == napi_ok &&
            napi_typeof(env, unref, &type) == napi_ok && type == napi_function) {
            (void)napi_call_function(env, timeout, unref, 0, NULL, &ignored);
        }
        ok = napi_create_reference(env, timeout, 1, &wrapper->timeout) == napi_ok;
    }
    if (!ok) {
        /* No timer: a later turn tries again. Clear a pending exception. */
        bool pending = false;
        napi_value error = NULL;
        if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
            napi_get_and_clear_last_exception(env, &error);
        }
        system->clock.armed = false;
    }
    napi_close_handle_scope(env, scope);
}

bool tna_pump_init(napi_env env, tna_napi_system *wrapper, napi_value facade, napi_value options) {
    wrapper->env = env;
    wrapper->destroy_finished = true;
    napi_valuetype type = napi_undefined;
    if (options != NULL) {
        napi_typeof(env, options, &type);
        if (type == napi_undefined || type == napi_null) {
            options = NULL;
        } else if (type != napi_object) {
            tna_throw(env, "invalid", "createSystem options must be an object");
            return false;
        }
    }
    napi_value scheduling = NULL;
    napi_value initial_value = NULL;
    tna_clock_kind clock = TNA_CLOCK_REALTIME;
    ta_time initial = 0;
    /* Microsteps one macrostep may run before its actor is quarantined as a
     * runaway (core ADR 0075); 0 for no limit. */
    uint32_t microstep_limit = TNA_DEFAULT_MICROSTEP_LIMIT;
    tna_turn_budgets *budgets = &wrapper->system->budgets;
    if (!tna_option(env, options, "scheduling", &scheduling) ||
        !tna_count_option(env, scheduling, "resumeBudget", &budgets->microsteps) ||
        !tna_count_option(env, scheduling, "actionBudget", &budgets->actions) ||
        !tna_count_option(env, scheduling, "resumesPerTurn", &budgets->resumes) ||
        !tna_count_option(env, scheduling, "messageBudget", &budgets->messages) ||
        !tna_count_option(env, scheduling, "maxQueuedMessages", &wrapper->system->sched.max_queued) ||
        !tna_bytes_option(env, scheduling, "maxRetainedBytes", &wrapper->system->sched.max_retained) ||
        !tna_count_option(env, scheduling, "dueBudget", &wrapper->system->due_budget) ||
        !tna_count_option(env, scheduling, "microstepLimit", &microstep_limit) ||
        !tna_clock_option(env, options, &clock) || !tna_option(env, options, "initialTime", &initial_value) ||
        (initial_value != NULL && !tna_time_value(env, initial_value, "createSystem: initialTime", &initial)) ||
        !tna_finished_option(env, options, &wrapper->destroy_finished) ||
        !tna_hook_option(env, options, "done", &wrapper->done_hook) ||
        !tna_hook_option(env, options, "fault", &wrapper->fault_hook) ||
        !tna_hook_option(env, options, "deadLetter", &wrapper->dead_letter_hook)) {
        return false;
    }
    if (budgets->microsteps == 0 || budgets->resumes == 0 || budgets->messages == 0 || wrapper->system->due_budget == 0) {
        tna_throw(env, "invalid",
                  "createSystem: scheduling.resumeBudget, resumesPerTurn, messageBudget and dueBudget must be at least 1");
        return false;
    }
    /* A delivered event holds a core event block until its actor is resumed,
     * the next turn at the latest, so core caches a turn's worth of them and
     * delivery makes no allocator call once warm (core ADR 0069). */
    (void)ta_system_set_event_block_cache(wrapper->system->core, budgets->messages);
    ta_system_set_microstep_limit(wrapper->system->core, microstep_limit);
    if (tna_system_set_clock(wrapper->system, clock, initial) != TA_OK) {
        tna_throw(env, "invalid", "createSystem: cannot set the clock");
        return false;
    }
    napi_value turn = NULL;
    napi_value timer = NULL;
    if (napi_create_function(env, "tinyactorsTurn", NAPI_AUTO_LENGTH, tna_turn_callback, wrapper, &turn) != napi_ok ||
        napi_create_reference(env, turn, 1, &wrapper->turn_function) != napi_ok ||
        napi_create_function(env, "tinyactorsTimer", NAPI_AUTO_LENGTH, tna_timer_callback, wrapper, &timer) != napi_ok ||
        napi_create_reference(env, timer, 1, &wrapper->timer_function) != napi_ok ||
        (facade != NULL && napi_create_reference(env, facade, 0, &wrapper->facade) != napi_ok)) {
        tna_throw(env, "out-of-memory", "cannot set up the pump");
        return false;
    }
    wrapper->system->wake = tna_pump_wake;
    wrapper->system->wake_context = wrapper;
    wrapper->system->clock.arm = tna_pump_arm;
    return true;
}

/* ------------------------------------------------------------------------
 * Hooks
 */

/* The ActorID view of `actor` (ADR 0002), or NULL without a class or facade. */
napi_value tna_actor_view(napi_env env, tna_napi_system *wrapper, ta_actor_id actor) {
    tna_env *data = wrapper->env_data;
    napi_value actor_class = NULL;
    napi_value argv[3] = { NULL, NULL, NULL };
    napi_value view = NULL;
    if (data->actor_class == NULL || wrapper->facade == NULL ||
        napi_get_reference_value(env, data->actor_class, &actor_class) != napi_ok || actor_class == NULL ||
        napi_get_reference_value(env, wrapper->facade, &argv[0]) != napi_ok || argv[0] == NULL ||
        napi_create_uint32(env, ta_actor_id_slot(actor), &argv[1]) != napi_ok ||
        napi_create_uint32(env, ta_actor_id_generation(actor), &argv[2]) != napi_ok ||
        napi_new_instance(env, actor_class, 3, argv, &view) != napi_ok) {
        return NULL;
    }
    return view;
}

/* The author's ID of the top-level final the actor reached, or undefined. */
static napi_value tna_final_state(napi_env env, tna_system *system, ta_actor_id actor) {
    napi_value result = NULL;
    napi_get_undefined(env, &result);
    ta_actor_inspection view;
    if (ta_actor_inspect(system->core, actor, &view) != TA_OK || view.final_state == TA_STATE_NONE) {
        return result;
    }
    ta_state_info info;
    if (ta_definition_state(system->core, &(ta_definition_state_params){
                                              .definition = view.definition_id,
                                              .state = view.final_state,
                                              .out = &info,
                                          }) != TA_OK) {
        return result;
    }
    napi_create_string_utf8(env, info.id.ptr, info.id.len, &result);
    return result;
}

static napi_status tna_set(napi_env env, napi_value object, const char *name, napi_value value) {
    return value == NULL ? napi_ok : napi_set_named_property(env, object, name, value);
}

/*
 * Calls `hook` with `argument`. An exception is kept as the turn's first
 * one, if it is the first, and cleared, so the turn goes on.
 */
void tna_call_hook(napi_env env, napi_ref hook, napi_value argument, napi_value *first_error) {
    napi_value function = NULL;
    napi_value global = NULL;
    napi_value ignored = NULL;
    if (napi_get_reference_value(env, hook, &function) != napi_ok || function == NULL ||
        napi_get_global(env, &global) != napi_ok) {
        return;
    }
    if (napi_call_function(env, global, function, 1, &argument, &ignored) != napi_ok) {
        napi_value error = NULL;
        bool pending = false;
        if (napi_is_exception_pending(env, &pending) == napi_ok && pending &&
            napi_get_and_clear_last_exception(env, &error) == napi_ok && *first_error == NULL) {
            *first_error = error;
        }
    }
}

static void tna_destroy_finished(tna_system *system, ta_actor_id actor) {
    system->inside_core = true;
    ta_result result = ta_actor_destroy(system->core, actor);
    system->inside_core = false;
    if (result == TA_OK || result == TA_ERR_NOT_FOUND) {
        tna_sched_remove(&system->sched, actor, TNA_DEAD_DONE);
    }
}

/* The actor's completion data (<donedata>), or undefined (ADR 0012, ADR 0011). */
static napi_value tna_completion_data(napi_env env, tna_system *system, ta_actor_id actor) {
    napi_value data = NULL;
    ta_actor_completion completion = { 0 };
    system->inside_core = true;
    ta_result result = ta_actor_get_completion(system->core, actor, &completion);
    system->inside_core = false;
    if (result != TA_OK || !completion.has_data || !tna_value_get(env, &completion.data, &data)) {
        napi_get_undefined(env, &data);
    }
    if (result == TA_OK && completion.has_data) {
        ta_value_release(&completion.data);
    }
    return data;
}

static void tna_done_record(napi_env env, tna_napi_system *wrapper, const tna_turn_record *record, napi_value *first_error) {
    tna_system *system = wrapper->system;
    if (wrapper->done_hook != NULL && tna_sched_lookup(&system->sched, record->actor) != NULL) {
        napi_value view = tna_actor_view(env, wrapper, record->actor);
        napi_value argument = NULL;
        napi_value data = tna_completion_data(env, system, record->actor);
        if (view != NULL && napi_create_object(env, &argument) == napi_ok &&
            tna_set(env, argument, "actor", view) == napi_ok &&
            tna_set(env, argument, "finalState", tna_final_state(env, system, record->actor)) == napi_ok &&
            tna_set(env, argument, "data", data) == napi_ok) {
            tna_call_hook(env, wrapper->done_hook, argument, first_error);
        }
    }
    /* The hook may have closed the system or destroyed the actor itself. */
    if (wrapper->destroy_finished && !tna_system_closed(system) &&
        tna_sched_lookup(&system->sched, record->actor) != NULL) {
        tna_destroy_finished(system, record->actor);
    }
}

/* A WARN log about `actor` through the trace sink, when one wants logs
 * (napi ADR 0017 section 7): the actor's session and definition, if it is
 * still resident, name it. */
void tna_pump_host_log(tna_system *system, ta_actor_id actor, tna_otlp_host_log_params log) {
    if (!system->tracing) {
        return;
    }
    ta_actor_inspection view;
    if (actor != 0 && ta_actor_inspect(system->core, actor, &view) == TA_OK) {
        log.session = view.session_id;
        log.definition = view.definition_id;
    }
    tna_otlp_host_log(&system->otlp, &log);
}

void tna_fault_message(const char *operation, ta_result code, char *buffer, size_t size) {
    snprintf(buffer, size, "%s failed: %s", operation, tna_result_code(code));
}

static void tna_fault_record(napi_env env, tna_napi_system *wrapper, const tna_turn_record *record, napi_value *first_error) {
    const char *code = tna_result_code(record->code);
    char message[160];
    tna_fault_message(record->operation, record->code, message, sizeof message);
    char body[200];
    int length = snprintf(body, sizeof body, "actor quarantined: %s", message);
    tna_pump_host_log(wrapper->system, record->actor,
                 (tna_otlp_host_log_params){ .event_name = { "tinyactors.actor.quarantined", 28 },
                                      .body = { body, length > 0 ? (uint32_t)length : 0u },
                                      .key = { "tinyactors.fault.code", 21 },
                                      .value = { code, (uint32_t)strlen(code) } });
    if (wrapper->fault_hook == NULL) {
        return;
    }
    napi_value argument = NULL;
    napi_value operation = NULL;
    napi_value code_value = NULL;
    napi_value message_value = NULL;
    napi_value view = tna_actor_view(env, wrapper, record->actor);
    if (view != NULL && napi_create_object(env, &argument) == napi_ok &&
        napi_create_string_utf8(env, record->operation, NAPI_AUTO_LENGTH, &operation) == napi_ok &&
        napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) == napi_ok &&
        napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) == napi_ok &&
        tna_set(env, argument, "actor", view) == napi_ok && tna_set(env, argument, "operation", operation) == napi_ok &&
        tna_set(env, argument, "code", code_value) == napi_ok &&
        tna_set(env, argument, "message", message_value) == napi_ok) {
        tna_call_hook(env, wrapper->fault_hook, argument, first_error);
    }
}

/* { family, name }: a named target that had no resident actor (ADR 0006). */
napi_value tna_address_object(napi_env env, const ta_actor_address *address) {
    napi_value object = NULL;
    napi_value family = NULL;
    napi_value name = NULL;
    if (napi_create_object(env, &object) != napi_ok ||
        napi_create_string_utf8(env, address->family.name.ptr, address->family.name.len, &family) != napi_ok ||
        napi_create_string_utf8(env, address->name.ptr, address->name.len, &name) != napi_ok ||
        tna_set(env, object, "family", family) != napi_ok || tna_set(env, object, "name", name) != napi_ok) {
        return NULL;
    }
    return object;
}

/* The dotted text of an event name, formatted by core (ADR 0004), or NULL. */
napi_value tna_event_text(napi_env env, tna_system *system, ta_event_name_id name) {
    char stack[256];
    uint32_t needed = 0;
    ta_event_name_format_params params = { .name = name, .buffer = stack, .capacity = sizeof stack, .needed = &needed };
    ta_result result = ta_event_name_format(system->core, &params);
    char *text = stack;
    if (result == TA_ERR_NOMEM && needed > sizeof stack) {
        text = ta_arena_alloc(&system->scratch.turn, needed, 1);
        if (text == NULL) {
            return NULL;
        }
        params.buffer = text;
        params.capacity = needed;
        result = ta_event_name_format(system->core, &params);
    }
    napi_value out = NULL;
    if (result != TA_OK || napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &out) != napi_ok) {
        return NULL;
    }
    return out;
}

/*
 * deadLetter({ target, event, reason, data?, traceparent? }) (ADR 0008);
 * counted in stats either way. `target` is an ActorID, or { family, name }
 * for a named target that had no resident actor. `data` and `traceparent`
 * are what posting it again needs (napi ADR 0020's restart outbox); each is
 * absent when the message had none.
 */
static void tna_dead_letter_record(napi_env env, tna_napi_system *wrapper, const tna_turn_record *record,
                                   napi_value *first_error) {
    const char *reason_text = tna_dead_reason_name(record->reason);
    char body[64];
    int length = snprintf(body, sizeof body, "dead-lettered: %s", reason_text);
    tna_pump_host_log(wrapper->system, record->actor,
                 (tna_otlp_host_log_params){ .event_name = { "tinyactors.message.dead_lettered", 32 },
                                      .body = { body, length > 0 ? (uint32_t)length : 0u },
                                      .has_event = true,
                                      .event = record->event,
                                      .key = { "tinyactors.dead_letter.reason", 29 },
                                      .value = { reason_text, (uint32_t)strlen(reason_text) } });
    if (wrapper->dead_letter_hook == NULL) {
        return;
    }
    napi_value argument = NULL;
    napi_value reason = NULL;
    napi_value view = record->has_address ? tna_address_object(env, &record->address)
                                          : tna_actor_view(env, wrapper, record->actor);
    napi_value event = tna_event_text(env, wrapper->system, record->event);
    if (view == NULL || napi_create_object(env, &argument) != napi_ok ||
        napi_create_string_utf8(env, reason_text, NAPI_AUTO_LENGTH, &reason) != napi_ok ||
        tna_set(env, argument, "target", view) != napi_ok || tna_set(env, argument, "event", event) != napi_ok ||
        tna_set(env, argument, "reason", reason) != napi_ok) {
        return;
    }
    napi_value data = NULL;
    if (record->data.v != NULL &&
        (!tna_value_get(env, &record->data, &data) || tna_set(env, argument, "data", data) != napi_ok)) {
        return;
    }
    if (record->has_trace) {
        char text[64];
        uint32_t needed = 0;
        napi_value traceparent = NULL;
        if (ta_traceparent_format(&(ta_traceparent_format_params){
                .parent = record->trace, .buffer = text, .capacity = sizeof text, .needed = &needed }) == TA_OK &&
            needed > 0u && needed <= sizeof text &&
            napi_create_string_utf8(env, text, needed - 1u, &traceparent) == napi_ok) {
            tna_set(env, argument, "traceparent", traceparent);
        }
    }
    tna_call_hook(env, wrapper->dead_letter_hook, argument, first_error);
}

/* ------------------------------------------------------------------------
 * send() promises (ADR 0005 point 11)
 */

/* The error code a dead letter's reason gives a send() (ADR 0008). */
static const char *const tna_dead_codes[TNA_DEAD_REASONS] = {
    [TNA_DEAD_NOT_FOUND] = "not-found",
    [TNA_DEAD_DONE] = "done",
    [TNA_DEAD_DESTROYED] = "not-found",
    [TNA_DEAD_REFUSED] = "invalid",
    [TNA_DEAD_UNLOADED] = "unloaded",
    [TNA_DEAD_REJECTED] = "rejected",
    [TNA_DEAD_LOAD_FAILED] = "load-failed",
    [TNA_DEAD_LOAD_TIMEOUT] = "load-timeout",
    [TNA_DEAD_WAITING_FULL] = "waiting-full",
};

static napi_value tna_settlement_error(napi_env env, const tna_settlement *settlement) {
    char message[160];
    napi_value error = NULL;
    if (settlement->kind == TNA_SETTLE_DEAD) {
        const char *reason_text = tna_dead_reason_name(settlement->reason);
        snprintf(message, sizeof message, "send: the message became a dead letter (%s)", reason_text);
        error = tna_error(env, tna_dead_codes[settlement->reason], message);
        napi_value detail = NULL;
        napi_value reason = NULL;
        if (error != NULL && napi_create_object(env, &detail) == napi_ok &&
            napi_create_string_utf8(env, reason_text, NAPI_AUTO_LENGTH, &reason) == napi_ok &&
            tna_set(env, detail, "reason", reason) == napi_ok) {
            napi_set_named_property(env, error, "detail", detail);
        }
        return error;
    }
    if (settlement->kind == TNA_SETTLE_ABANDONED) {
        return tna_error(env, "abandoned",
                         "send: an operator abandoned the message's macrostep (core ADR 0082); what it did so far stays");
    }
    const char *code = tna_result_code(settlement->code);
    snprintf(message, sizeof message, "send: the message's macrostep failed (%s); the actor is quarantined", code);
    return tna_error(env, code, message);
}

/* { actor, status, completion }: the macrostep ended with the actor stable or done. */
static napi_value tna_settlement_result(napi_env env, tna_napi_system *wrapper, const tna_settlement *settlement) {
    napi_value result = NULL;
    napi_value status = NULL;
    bool done = settlement->kind == TNA_SETTLE_DONE;
    if (napi_create_object(env, &result) != napi_ok ||
        napi_create_string_utf8(env, done ? "done" : "stable", NAPI_AUTO_LENGTH, &status) != napi_ok ||
        tna_set(env, result, "actor", tna_actor_view(env, wrapper, settlement->actor)) != napi_ok ||
        tna_set(env, result, "status", status) != napi_ok) {
        return NULL;
    }
    if (done) {
        tna_set(env, result, "completion", tna_completion_data(env, wrapper->system, settlement->actor));
    }
    return result;
}

/*
 * Settles the send() promises whose messages settled (ADR 0007: after the
 * last core call of the turn). Runs before the hooks, so a finished actor's
 * completion is still readable before finished: "destroy" removes it, and
 * again after them, for settlements the hooks caused.
 */
static void tna_settle_sends(napi_env env, tna_napi_system *wrapper) {
    tna_sched *sched = &wrapper->system->sched;
    tna_settlement settlement;
    while (tna_sched_settlement_pop(sched, &settlement)) {
        tna_waiter *waiter = tna_sched_waiter(sched, settlement.waiter);
        if (waiter == NULL || waiter->host == NULL) {
            continue;
        }
        napi_deferred deferred = waiter->host;
        tna_sched_waiter_give(sched, settlement.waiter);
        napi_handle_scope scope = NULL;
        napi_open_handle_scope(env, &scope);
        if (settlement.kind == TNA_SETTLE_STABLE || settlement.kind == TNA_SETTLE_DONE) {
            napi_value result = tna_settlement_result(env, wrapper, &settlement);
            if (result != NULL) {
                napi_resolve_deferred(env, deferred, result);
            } else {
                napi_reject_deferred(env, deferred, tna_error(env, "out-of-memory", "send: cannot build the result"));
            }
        } else {
            napi_reject_deferred(env, deferred, tna_settlement_error(env, &settlement));
        }
        if (scope != NULL) {
            napi_close_handle_scope(env, scope);
        }
    }
}

/*
 * What a debugger hears of an actor (ADR 0026), after the turn's traces, so
 * that it has the macrostep's spans already: "runaway" when a macrostep was
 * stopped at its microstep limit (core ADR 0075) and the actor was
 * quarantined. The effects handler hears it with the actor.
 */
static void tna_runaway_effect(napi_env env, tna_napi_system *wrapper, const tna_turn_record *record,
                               napi_value *first_error) {
    tna_env *data = wrapper->env_data;
    napi_value handler = NULL;
    napi_value argv[3] = { NULL, NULL, NULL };
    if (data->effects_handler == NULL || wrapper->facade == NULL ||
        napi_get_reference_value(env, data->effects_handler, &handler) != napi_ok || handler == NULL ||
        napi_get_reference_value(env, wrapper->facade, &argv[0]) != napi_ok || argv[0] == NULL ||
        napi_create_string_utf8(env, "runaway", NAPI_AUTO_LENGTH, &argv[1]) != napi_ok ||
        (argv[2] = tna_actor_view(env, wrapper, record->actor)) == NULL) {
        return;
    }
    napi_value global = NULL;
    napi_value ignored = NULL;
    napi_get_global(env, &global);
    if (napi_call_function(env, global, handler, 3, argv, &ignored) != napi_ok) {
        napi_value error = NULL;
        bool pending = false;
        if (napi_is_exception_pending(env, &pending) == napi_ok && pending &&
            napi_get_and_clear_last_exception(env, &error) == napi_ok && *first_error == NULL) {
            *first_error = error;
        }
    }
}

/* ------------------------------------------------------------------------
 * Flush waiters
 */

static bool tna_add_waiter(tna_napi_system *wrapper, napi_deferred deferred) {
    if (wrapper->waiter_count == wrapper->waiter_capacity) {
        uint32_t capacity = wrapper->waiter_capacity == 0 ? 4u : wrapper->waiter_capacity * 2u;
        napi_deferred *grown = realloc(wrapper->waiters, capacity * sizeof *grown);
        if (grown == NULL) {
            return false;
        }
        wrapper->waiters = grown;
        wrapper->waiter_capacity = capacity;
    }
    wrapper->waiters[wrapper->waiter_count] = deferred;
    wrapper->waiter_count += 1u;
    return true;
}

static void tna_resolve_waiters(napi_env env, tna_napi_system *wrapper) {
    napi_value undefined = NULL;
    napi_get_undefined(env, &undefined);
    /* A waiter's continuation runs later (a microtask), so the list is stable here. */
    uint32_t count = wrapper->waiter_count;
    wrapper->waiter_count = 0;
    for (uint32_t index = 0; index < count; index += 1) {
        napi_resolve_deferred(env, wrapper->waiters[index], undefined);
    }
}

/* Quiet, with no turn pending and no load waiting for its loader (napi ADR 0020). */
static bool tna_settled(const tna_system *system) {
    return tna_system_closed(system) ||
           (tna_system_quiet(system) && !system->turn_pending && system->loads.in_flight == 0);
}

void tna_pump_settle_waiters(napi_env env, tna_napi_system *wrapper) {
    if (tna_settled(wrapper->system)) {
        tna_resolve_waiters(env, wrapper);
    }
}

napi_value tna_pump_flush(napi_env env, tna_napi_system *wrapper) {
    napi_deferred deferred = NULL;
    napi_value promise = NULL;
    if (napi_create_promise(env, &deferred, &promise) != napi_ok) {
        return tna_throw(env, "out-of-memory", "cannot create a promise");
    }
    if (tna_settled(wrapper->system)) {
        napi_value undefined = NULL;
        napi_get_undefined(env, &undefined);
        napi_resolve_deferred(env, deferred, undefined);
        return promise;
    }
    if (!tna_add_waiter(wrapper, deferred)) {
        napi_reject_deferred(env, deferred, tna_error(env, "out-of-memory", "cannot wait for the system"));
    }
    return promise;
}

/* ------------------------------------------------------------------------
 * The turn
 */

static napi_value tna_turn_callback(napi_env env, napi_callback_info info) {
    void *data = NULL;
    if (napi_get_cb_info(env, info, NULL, NULL, NULL, &data) != napi_ok || data == NULL) {
        return NULL;
    }
    tna_napi_system *wrapper = data;
    tna_system *system = wrapper->system;
    napi_value first_error = NULL;
    uint64_t started = tna_monotonic_ns(NULL);
    if (!tna_system_closed(system)) {
        tna_system_turn(system);
        tna_settle_sends(env, wrapper);
        for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
            if (tna_system_closed(system)) {
                break; /* a hook closed the system */
            }
            if (record->kind == TNA_RECORD_DONE) {
                tna_done_record(env, wrapper, record, &first_error);
            } else if (record->kind == TNA_RECORD_FAULT) {
                tna_fault_record(env, wrapper, record, &first_error);
            } else {
                tna_dead_letter_record(env, wrapper, record, &first_error);
            }
        }
        /* Loads the turn started go to lib/system.js's loader runner (napi ADR 0020). */
        if (!tna_system_closed(system)) {
            tna_loads_dispatch(env, wrapper, &first_error);
        }
        /* Services run after the hooks, in the order core called them (step 13). */
        tna_services_dispatch(env, wrapper, &first_error);
        /* Then the turn's trace records, as one batch (napi ADR 0015). */
        if (!tna_system_closed(system)) {
            tna_trace_dispatch(env, wrapper, &first_error);
        }
        /* Then the runaways (ADR 0026), which a debugger reads with those
         * traces. */
        for (const tna_turn_record *record = system->sched.records; record != NULL; record = record->next) {
            if (tna_system_closed(system)) {
                break;
            }
            if (record->kind == TNA_RECORD_FAULT && record->code == TA_ERR_RUNAWAY &&
                tna_sched_lookup(&system->sched, record->actor) != NULL) {
                napi_handle_scope scope = NULL;
                napi_open_handle_scope(env, &scope);
                tna_runaway_effect(env, wrapper, record, &first_error);
                if (scope != NULL) {
                    napi_close_handle_scope(env, scope);
                }
            }
        }
        if (!tna_system_closed(system)) {
            tna_settle_sends(env, wrapper);
        }
        tna_system_end_turn(system);
        if (tna_settled(system)) {
            tna_resolve_waiters(env, wrapper);
        }
        if (!tna_system_closed(system)) {
            tna_system_record_turn(system, started);
        }
    }
    tna_pump_unhold(wrapper);
    if (first_error != NULL) {
        napi_throw(env, first_error);
    }
    return NULL;
}

/* The host timer fired (ADR 0007 point 3): move time, and turn if something is due. */
static napi_value tna_timer_callback(napi_env env, napi_callback_info info) {
    void *data = NULL;
    if (napi_get_cb_info(env, info, NULL, NULL, NULL, &data) != napi_ok || data == NULL) {
        return NULL;
    }
    tna_napi_system *wrapper = data;
    if (wrapper->timeout != NULL && !wrapper->env_data->torn_down) {
        napi_delete_reference(env, wrapper->timeout);
    }
    wrapper->timeout = NULL;
    bool held = wrapper->timer_held;
    wrapper->timer_held = false;
    if (!tna_system_closed(wrapper->system)) {
        tna_system_timer_fired(wrapper->system);
    }
    if (held) {
        tna_napi_system_unhold(wrapper); /* may free a finalized wrapper */
    }
    return NULL;
}

napi_value tna_pump_advance_to(napi_env env, tna_napi_system *wrapper, napi_value time_value) {
    tna_system *system = wrapper->system;
    if (system->clock.kind != TNA_CLOCK_MANUAL) {
        return tna_throw(env, "invalid", "advanceTo() needs a system with clock: \"manual\"");
    }
    ta_time time = 0;
    if (!tna_time_value(env, time_value, "advanceTo(): time", &time)) {
        return NULL;
    }
    ta_result result = tna_system_advance_to(system, time);
    if (result == TA_ERR_BUSY) {
        return tna_throw(env, "reentrant", "advanceTo() cannot run inside a core call");
    }
    if (result != TA_OK) {
        return tna_throw(env, "invalid", "advanceTo(): time must not move backwards");
    }
    return tna_pump_flush(env, wrapper);
}

/* ------------------------------------------------------------------------
 * Close
 */

static void tna_delete(napi_env env, napi_ref *ref, bool env_usable) {
    if (*ref != NULL && env_usable) {
        napi_delete_reference(env, *ref);
    }
    *ref = NULL;
}

void tna_pump_close(tna_napi_system *wrapper, bool env_usable) {
    napi_env env = wrapper->env;
    if (env == NULL) {
        return;
    }
    wrapper->system->wake = NULL;
    wrapper->system->clock.arm = NULL;
    wrapper->system->clock.armed = false;
    if (env_usable) {
        tna_pump_clear_timer(env, wrapper);
    } else if (wrapper->timeout != NULL && !wrapper->env_data->torn_down) {
        /*
         * No JavaScript can run here (finalizer), so the timer stays pending
         * and keeps its hold; its callback finds the system closed and drops
         * the hold. It is unreferenced, so it keeps nothing alive.
         */
        napi_delete_reference(env, wrapper->timeout);
        wrapper->timeout = NULL;
    }
    if (env_usable && wrapper->waiter_count > 0) {
        napi_value error = tna_error(env, "closed", "the system was closed");
        for (uint32_t index = 0; index < wrapper->waiter_count; index += 1) {
            napi_reject_deferred(env, wrapper->waiters[index], error);
        }
    }
    /* send() promises still pending reject with "closed" (ADR 0012). */
    tna_sched *sched = &wrapper->system->sched;
    napi_value closed = env_usable && sched->waiters_live > 0 ? tna_error(env, "closed", "the system was closed") : NULL;
    for (uint32_t index = 1; index < sched->waiters.count; index += 1) {
        tna_waiter *waiter = tna_sched_waiter(sched, index);
        if (waiter->state != TNA_WAITER_FREE) {
            if (closed != NULL && waiter->host != NULL) {
                napi_reject_deferred(env, waiter->host, closed);
            }
            tna_sched_waiter_give(sched, index);
        }
    }
    /* Waiters that cannot be settled (finalizer, teardown) are abandoned. */
    wrapper->waiter_count = 0;
    free(wrapper->waiters);
    wrapper->waiters = NULL;
    wrapper->waiter_capacity = 0;
    bool refs_usable = !wrapper->env_data->torn_down;
    tna_delete(env, &wrapper->turn_function, refs_usable);
    tna_delete(env, &wrapper->timer_function, refs_usable);
    tna_delete(env, &wrapper->facade, refs_usable);
    tna_delete(env, &wrapper->done_hook, refs_usable);
    tna_delete(env, &wrapper->fault_hook, refs_usable);
    tna_delete(env, &wrapper->dead_letter_hook, refs_usable);
}
