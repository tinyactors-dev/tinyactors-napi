#pragma once
/*
 * The pump (ADR 0007): the Node-API side of scheduling.
 *
 * - Turns are scheduled with the global setImmediate, called from native
 *   code with one native turn function per system. setImmediate callbacks
 *   run after the event loop has polled for I/O, so I/O and timer callbacks
 *   run between two turns and at most one turn runs per loop iteration. A
 *   pending immediate keeps the process alive, and nothing else does.
 * - The system asks for a turn through its wake callback (system.h), which
 *   the pump sets. A pending turn holds the native System wrapper, so the
 *   turn function never runs against freed memory.
 * - A turn runs the native scheduler (scheduler.h), then calls the hooks
 *   for the turn's records, after the last core call (ADR 0007 point 5):
 *   `done` with { actor, finalState, data } (ADR 0012), then destroys the
 *   actor when `finished` is "destroy"; `fault` with
 *   { actor, operation, code, message } (ADR 0008); `deadLetter` with
 *   { target, event, reason } for a message whose target is gone, finished,
 *   or refused it (ADR 0008; at most `messageBudget` per turn); and, after the
 *   turn's traces, the effects handler with "runaway" and the actor for each
 *   actor a runaway macrostep quarantined (ADR 0026). An exception from a hook
 *   does not stop the turn: the first one is rethrown when the turn ends,
 *   so it surfaces as an uncaught exception from the setImmediate callback.
 * - flush() returns a native promise that settles at the end of the turn
 *   that leaves the system quiet. close() rejects the waiting ones.
 * - Time (ADR 0007 point 3): the system's arm callback (system.h) calls the
 *   global setTimeout from native code, clearing the timer it armed before,
 *   and unrefs the Timeout through its `unref` method, so an idle system
 *   does not keep the process alive. A pending timer holds the wrapper like
 *   a pending turn. The manual clock arms no timer; advanceTo() moves time
 *   and waits like flush().
 *
 * Handle scopes: the scheduler has no Node-API in it, so it opens no scope
 * around a resume. No JavaScript runs inside a resume until the JavaScript
 * data model (step 11), whose callbacks open their own scope.
 */
#include <node_api.h>
#include <stdbool.h>

#include "napi_system.h"

/*
 * Reads the scheduling options and hooks from `options` (an object, or
 * undefined) and installs the wake callback. Throws and returns false on bad
 * options.
 */
bool tna_pump_init(napi_env env, tna_napi_system *wrapper, napi_value facade, napi_value options);
/* Rejects waiting flush promises (when `env_usable`) and drops the pump's references. */
void tna_pump_close(tna_napi_system *wrapper, bool env_usable);
/* flush(): a promise that settles when the system is quiet. */
napi_value tna_pump_flush(napi_env env, tna_napi_system *wrapper);
/* advanceTo(time): manual clock only; moves time, then waits like flush(). */
napi_value tna_pump_advance_to(napi_env env, tna_napi_system *wrapper, napi_value time);

/* Helpers the pump and the services layer (napi_services.h) share. */
/* The ActorID view of `actor` (ADR 0002), or NULL without a class or facade. */
napi_value tna_actor_view(napi_env env, tna_napi_system *wrapper, ta_actor_id actor);
/* { family, name } for an address. */
/*
 * The fault hook's `message` for a failed core call, such as "resume failed:
 * runaway" (ADR 0008). A quarantined child's parent gets the same text
 * (napi ADR 0025).
 */
void tna_fault_message(const char *operation, ta_result code, char *buffer, size_t size);
napi_value tna_address_object(napi_env env, const ta_actor_address *address);
/* The dotted text of an event name, formatted by core (ADR 0004), or NULL. */
napi_value tna_event_text(napi_env env, tna_system *system, ta_event_name_id name);
/* Calls `hook` with `argument`; the turn's first exception is kept, not thrown. */
void tna_call_hook(napi_env env, napi_ref hook, napi_value argument, napi_value *first_error);
/* A WARN log about `actor` (0: none) through the trace sink, when one wants
 * logs (napi ADR 0017 section 7). */
void tna_pump_host_log(tna_system *system, ta_actor_id actor, tna_otlp_host_log_params log);
/* Resolves the flush() promises when the system has settled. */
void tna_pump_settle_waiters(napi_env env, tna_napi_system *wrapper);
