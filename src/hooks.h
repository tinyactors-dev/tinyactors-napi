#pragma once
/*
 * Post-call hooks (ADR 0013): bindings.rb names the core functions whose
 * generated binding calls one of these after a successful call, so the
 * plumbing sees the change. A hook that fails makes the call throw with its
 * result.
 *
 * - tna_hook_actor_created: after ta_actor_spawn, ta_actor_load,
 *   ta_actor_reconstruct and ta_actor_prepare_replacement. It fills the
 *   actor's scheduling entry and puts it on the runnable queue for bootstrap
 *   (ADR 0005). If that cannot be allocated, it destroys the new actor
 *   again and answers TA_ERR_NOMEM, so no actor exists that the scheduler
 *   does not know.
 * - tna_hook_actor_removed: after ta_actor_destroy. It moves the actor's
 *   mailbox to the dead letters, clears its scheduling entry, and asks for a
 *   turn so the dead letters are reported.
 * - tna_hook_actor_unloaded: after ta_actor_unload. The same, with the dead
 *   letters' reason `unloaded`. The JavaScript API refuses to unload an
 *   actor that has mail waiting, so this only happens through the raw
 *   generated layer (ROADMAP step 14).
 * - tna_hook_actor_activated: after ta_actor_activate_replacement. The mail
 *   still waiting for the incumbent moves to the front of the replacement's
 *   mailbox, so nothing accepted for the address is lost when the incumbent
 *   is destroyed (ROADMAP step 14).
 *
 * - tna_hook_actor_abandoned: after ta_actor_abandon. The send() that
 *   followed the abandoned macrostep rejects with `abandoned`, and a runnable
 *   actor stands between macrosteps again (ADR 0026, core ADR 0082).
 *
 * Hooks take the native system, not a call, so they stay free of Node-API
 * and native tests can drive them.
 */
#include "system.h"
#include "tinyactors.h"

ta_result tna_hook_actor_created(tna_system *system, ta_actor_id actor);
ta_result tna_hook_actor_removed(tna_system *system, ta_actor_id actor);
ta_result tna_hook_actor_unloaded(tna_system *system, ta_actor_id actor);
ta_result tna_hook_actor_activated(tna_system *system, const ta_actor_activate_replacement_params *params);
ta_result tna_hook_actor_abandoned(tna_system *system, ta_actor_id actor);
