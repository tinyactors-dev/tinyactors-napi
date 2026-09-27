#include "invoker.h"

#include "../system.h"

static ta_op_status tna_invoke_fault(ta_fault *fault, ta_result code, const char *message, uint32_t length) {
    *fault = (ta_fault){ .code = code, .message = { .ptr = message, .len = length } };
    return TA_OP_ERROR;
}

#define TNA_FAULT(fault, code, text) tna_invoke_fault((fault), (code), (text), (uint32_t)(sizeof(text) - 1u))

/* ------------------------------------------------------------------------
 * JavaScript invokers
 */

static ta_op_status tna_js_start(void *self, const ta_invoker_start_params *params) {
    tna_system *system = self;
    const ta_invoke_request *request = params->request;
    uint64_t service = system->next_service + 1u;
    tna_effect effect = {
        .kind = TNA_EFFECT_INVOKE_START,
        .parent = request->parent,
        .invoke_id = request->invoke_id,
        .service = service,
        .type = request->type,
        .value = request->data,
        .target = request->src,
        .target_text = request->src_text,
        .params = request->params,
        .content_type = request->content_type,
        .content = request->content,
        .autoforward = request->autoforward,
        .trace = request->trace,
    };
    ta_value_retain(&effect.value);
    ta_value_retain(&effect.target);
    ta_value_retain(&effect.params);
    if (!tna_system_effect(system, &effect)) {
        return TNA_FAULT(params->fault, TA_ERR_NOMEM, "the invoker could not queue the start");
    }
    system->next_service = service;
    *params->service_handle = service;
    return TA_OP_OK;
}

static ta_op_status tna_js_cancel(void *self, uint64_t service, ta_fault *fault) {
    (void)fault;
    tna_system *system = self;
    tna_effect effect = { .kind = TNA_EFFECT_INVOKE_CANCEL, .service = service };
    (void)tna_system_effect(system, &effect); /* dropped only while closing */
    return TA_OP_OK;
}

static ta_op_status tna_js_forward(void *self, const ta_invoker_forward_params *params) {
    tna_system *system = self;
    tna_effect effect = { .kind = TNA_EFFECT_INVOKE_FORWARD, .service = params->service_handle };
    ta_event_retain(params->event, &effect.forwarded);
    if (!tna_system_effect(system, &effect)) {
        return TNA_FAULT(params->fault, TA_ERR_NOMEM, "the invoker could not queue the forwarded event");
    }
    return TA_OP_OK;
}

static const ta_invoker_vtable tna_js_invoker_vtable = {
    .start = tna_js_start,
    .cancel = tna_js_cancel,
    .forward = tna_js_forward,
};

ta_invoker tna_js_invoker_adapter(tna_system *system) {
    return (ta_invoker){ .self = system, .v = &tna_js_invoker_vtable };
}

/* ------------------------------------------------------------------------
 * The in-system SCXML invoker
 */

static ta_op_status tna_scxml_start(void *self, const ta_invoker_start_params *params) {
    tna_system *system = self;
    const ta_invoke_request *request = params->request;
    if (system->effects.closed) {
        return TNA_FAULT(params->fault, TA_ERR_INVALID, "invoker.scxml: the system is closing");
    }
    ta_definition_id definition = 0;
    ta_value binding = { NULL, NULL };
    bool release = false;
    if (system->child_definition == NULL) {
        return TNA_FAULT(params->fault, TA_ERR_INVALID, "invoker.scxml: the system is closing");
    }
    ta_op_status status = system->child_definition(system->child_context,
                                                   &(tna_child_params){ .request = request,
                                                                        .out = &definition,
                                                                        .binding = &binding,
                                                                        .fault = params->fault,
                                                                        .release = &release });
    if (status != TA_OP_OK) {
        return status;
    }
    ta_actor_id child = 0;
    ta_result result = ta_actor_spawn(system->core, &(ta_actor_spawn_params){
                                                        .definition = definition,
                                                        .datamodel_binding = binding.v != NULL ? &binding : NULL,
                                                        .parent = &(ta_actor_parent){ .actor = request->parent,
                                                                                      .invoke_id = request->invoke_id },
                                                        .out = &child,
                                                        /* The child's bootstrap runs under the invoking step. */
                                                        .trace = request->trace,
                                                    });
    ta_value_release(&binding);
    if (release) {
        /* The child holds it now; without one, it is freed here (core ADR 0077). */
        (void)ta_system_release_definition(system->core, definition);
    }
    if (result != TA_OK) {
        return TNA_FAULT(params->fault, result, "invoker.scxml: could not spawn the child");
    }
    if (tna_sched_add(&system->sched, child) != TA_OK) {
        (void)ta_actor_destroy(system->core, child);
        return TNA_FAULT(params->fault, TA_ERR_NOMEM, "invoker.scxml: could not schedule the child");
    }
    tna_system_want_turn(system);
    *params->service_handle = child;
    return TA_OP_OK;
}

static ta_op_status tna_scxml_cancel(void *self, uint64_t service, ta_fault *fault) {
    (void)fault;
    tna_system *system = self;
    ta_result result = ta_actor_destroy(system->core, service);
    if (result == TA_OK || result == TA_ERR_NOT_FOUND) {
        tna_sched_remove(&system->sched, service, TNA_DEAD_DESTROYED);
        tna_system_want_turn(system);
    }
    return TA_OP_OK;
}

static ta_op_status tna_scxml_forward(void *self, const ta_invoker_forward_params *params) {
    tna_system *system = self;
    ta_event event;
    ta_event_retain(params->event, &event);
    ta_result result = tna_sched_post(&system->sched, &(tna_message){ .target = params->service_handle, .event = &event });
    if (result != TA_OK) {
        ta_event_release(&event);
        return TNA_FAULT(params->fault, result, "invoker.scxml: the child's mailbox did not accept the event");
    }
    tna_system_want_turn(system);
    return TA_OP_OK;
}

static const ta_invoker_vtable tna_scxml_invoker_vtable = {
    .start = tna_scxml_start,
    .cancel = tna_scxml_cancel,
    .forward = tna_scxml_forward,
};

ta_result tna_scxml_invoker_register(tna_system *system) {
    static const char type[] = "http://www.w3.org/TR/scxml/";
    ta_atom atom = 0;
    ta_result result = ta_system_intern_atom(system->core, (ta_str){ .ptr = type, .len = sizeof type - 1u }, &atom);
    if (result != TA_OK) {
        return result;
    }
    return ta_system_register_invoker(system->core, atom,
                                      (ta_invoker){ .self = system, .v = &tna_scxml_invoker_vtable });
}
