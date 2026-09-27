#pragma once
/*
 * Services from JavaScript (ROADMAP step 13): I/O processors, invokers and
 * the log sink (core ADRs 0015, 0016, 0045, 0046; ADR 0001 rule 3).
 *
 * Registration is hand-written (ADR 0013: ta_system_register_io,
 * ta_system_register_invoker and ta_system_set_log_sink are plumbing-owned).
 * lib/system.js keeps the JavaScript processors, invokers and sink; native
 * code only tells core which types exist and installs the adapters.
 *
 * Dispatch: core's calls into the adapters become effects (effects.h). At
 * the end of a turn the pump calls tna_services_dispatch(), which hands each
 * effect to the environment's effects handler (setupEffects, addon.c) as
 * handler(system, kind, payload), in the order core made the calls:
 *
 * - "log":    { source, label, hasValue, value }
 * - "io":     { source, sendID, event, type, target, data } plus
 *             { content, contentType } for a literal <content>
 * - "invoke-start":   { handle, parent, invocationID, invokeID, type, source,
 *                       content, contentType, params, autoforward }
 * - "invoke-cancel":  { handle }
 * - "invoke-forward": { handle, event: { name, data } }
 *
 * `source` is an ActorID view, or { family, name } for a named actor.
 * `sendID` is the send ID text core gives the send (core ADR 0048), or null.
 *
 * Reporting (reportInvoke): an event or done report from a JavaScript
 * invocation goes to the parent's mailbox as an external event whose
 * invoke_id names the invocation, as ta_actor_report_invoke() would deliver
 * it, so it keeps the mailbox's order and backpressure instead of failing
 * when the parent is busy. An unavailable report goes through core, which
 * retires the invocation and queues error.communication internally; the
 * parent is then made runnable.
 */
#include <node_api.h>

#include "napi_system.h"

/* Hands every queued effect to JavaScript. An exception becomes the turn's first error. */
void tna_services_dispatch(napi_env env, tna_napi_system *wrapper, napi_value *first_error);
/* Sets up the in-system SCXML invoker's children (napi_children.h). */
void tna_services_init(tna_napi_system *wrapper);

/* System methods (napi_system.c's property table). */
napi_value tna_register_io_method(napi_env env, napi_callback_info info);
napi_value tna_open_scope_method(napi_env env, napi_callback_info info);
napi_value tna_close_scope_method(napi_env env, napi_callback_info info);
/*
 * The origin option of post()/send() (core ADR 0068): { type, uri } makes a
 * MESSAGE origin, { type, scope } a SCOPED one, { type, token } a COMPUTED
 * one. Undefined leaves no origin. Throws and answers false otherwise.
 */
bool tna_origin_argument(napi_env env, tna_system *system, napi_value value, ta_origin *out);
napi_value tna_register_invoker_method(napi_env env, napi_callback_info info);
napi_value tna_set_log_sink_method(napi_env env, napi_callback_info info);
napi_value tna_report_invoke_method(napi_env env, napi_callback_info info);
