#pragma once
/*
 * The Node-API side of loading unloaded actors on demand (napi ADR 0020).
 * The loads themselves are portable (loads.h); this file hands each new load
 * to lib/system.js's loader runner after a turn, and takes back the
 * outcome. After a turn that started loads, the environment's effect
 * handler (setupEffects) is called as handler(system, "loads", requests),
 * with an array of { index, generation, family, name, why }.
 *
 * Methods of the native System (lib/system.js calls them):
 * - setLoaderFamily(family, maxWaiting): registers a family's loader limit;
 *   0 removes the loader.
 * - completeLoad(index, generation, outcome, slot?, actorGeneration?,
 *   detail?): finishes a load. `outcome` is "loaded" or "spawned" (the
 *   actor at slot/actorGeneration is resident at the address), or
 *   "not-found", "rejected", "failed" or "timed-out". Failures write a WARN
 *   log with `detail`. Returns false when the load had finished already.
 * - loadTrace(index, generation): the trace parent a load runs under (the
 *   first waiting message's), as generated load and spawn read it.
 * - wakeAt(family, name, time) and cancelWake(family, name): an unloaded
 *   actor's wake-up for its own timers.
 */
#include <node_api.h>

#include "napi_system.h"

void tna_loads_dispatch(napi_env env, tna_napi_system *wrapper, napi_value *first_error);
napi_value tna_set_loader_family_method(napi_env env, napi_callback_info info);
napi_value tna_complete_load_method(napi_env env, napi_callback_info info);
napi_value tna_load_trace_method(napi_env env, napi_callback_info info);
napi_value tna_wake_at_method(napi_env env, napi_callback_info info);
napi_value tna_cancel_wake_method(napi_env env, napi_callback_info info);
/* Offloaded actors (core ADR 0074). */
napi_value tna_set_offload_values_method(napi_env env, napi_callback_info info);
napi_value tna_offload_method(napi_env env, napi_callback_info info);
napi_value tna_has_offloaded_method(napi_env env, napi_callback_info info);
napi_value tna_drop_offloaded_method(napi_env env, napi_callback_info info);
napi_value tna_load_offloaded_method(napi_env env, napi_callback_info info);
