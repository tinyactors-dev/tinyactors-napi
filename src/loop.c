/* The loop (AGENTS.md, "The loop"; tinyactors-core/docs/bindings.md,
 * section 3; translated from tinyactors-cpython/src/loop.c): take,
 * handle, ack, run, as ta_napi_drain and ta_napi_turn, driven by the
 * runtime's event loop and nothing else. An input from outside a turn
 * schedules one turn with setImmediate (one pending at a time), a turn
 * that reaches its bound yields the same way, and an idle turn arms one
 * setTimeout at the deadline, replacing the last. `await host.idle()`
 * observes the turns: it settles at the next idle one. The global timers
 * are named here only (tools/lint/rules/one-timer-in-loop.yml).
 *
 * SimulatedClock is here too: a clock in milliseconds that moves only with
 * increment(ms), which schedules a turn on each host made with it; such a
 * host arms no timer. */
#include "addon.h"
#include "tinyactors_runtime.h"

#include <string.h>

/* Fuel per ta_host_run: a turn is bounded, and the event loop runs the
 * rest of the program between turns. */
#define TA_NAPI_BUDGET 10000u
/* Batches a drain takes, and runs a turn makes, before it yields: a
 * handler that answers every effect with an input never holds the turn,
 * so I/O gets its share (bindings.md, section 3: "Bound each turn"). */
#define TA_NAPI_BATCHES 64u
#define TA_NAPI_RUNS 64u
/* Takes, and batches, the last take at close makes at most. */
#define TA_NAPI_END_TAKES 64u
/* The longest delay setTimeout keeps (2^31 - 1 ms): a longer one fires at
 * once, with a warning. A deadline further away is armed at this, and
 * the idle turn it wakes arms the rest. */
#define TA_NAPI_TIMEOUT_MAX 2147483647.0

static const uint64_t ta_napi_billion = 1000000000u;

/* What a turn ends with: what the event loop does next. */
typedef enum ta_napi_next {
    TA_NAPI_NEXT_IDLE,
    TA_NAPI_NEXT_YIELD,
    TA_NAPI_NEXT_EXHAUSTED,
    TA_NAPI_NEXT_FAULT,
} ta_napi_next;

/* Which handle called a turn: the turn's second argument. */
enum { TA_NAPI_BY_IMMEDIATE = 0, TA_NAPI_BY_TIMER = 1 };

/* ---- errors ------------------------------------------------------------------- */

/* The error is kept in a one-element array: a handler may throw any value
 * (a string, undefined), and Node-API 8 references objects only. */
static void ta_napi_keep(napi_env env, ta_napi_host *host, napi_value error) {
    napi_value box;
    if (host->error != NULL) return;
    if (napi_create_array_with_length(env, 1, &box) == napi_ok && napi_set_element(env, box, 0, error) == napi_ok)
        napi_create_reference(env, box, 1, &host->error);
}

/* The host's handlerError hook (the application's onHandlerError), or
 * NULL: on the handlers object the wrapper holds. */
static napi_value ta_napi_error_hook(napi_env env, const ta_napi_host *host) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value wrapper = ta_napi_self(env, host), keys, key, handlers, hook;
    napi_valuetype type = napi_undefined;
    if (instance == NULL || wrapper == NULL || napi_get_reference_value(env, instance->keys, &keys) != napi_ok ||
        napi_get_named_property(env, keys, "handlers", &key) != napi_ok || napi_get_property(env, wrapper, key, &handlers) != napi_ok ||
        napi_typeof(env, handlers, &type) != napi_ok || type != napi_object ||
        napi_get_named_property(env, handlers, "handlerError", &hook) != napi_ok || napi_typeof(env, hook, &type) != napi_ok ||
        type != napi_function)
        return NULL;
    return hook;
}

bool ta_napi_handler_rejected(napi_env env, const ta_napi_handler_error *failure, napi_value error) {
    napi_value hook = ta_napi_error_hook(env, failure->host), ignored, argv[2];
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) napi_get_and_clear_last_exception(env, &ignored);
    if (hook == NULL) return false;
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    argv[0] = error;
    argv[1] = failure->effect != NULL ? failure->effect : undefined;
    if (napi_call_function(env, undefined, hook, 2, argv, &ignored) != napi_ok &&
        napi_get_and_clear_last_exception(env, &ignored) == napi_ok)
        ta_napi_keep(env, failure->host, ignored); /* the hook's own error: the turn's */
    return true;
}

void ta_napi_handler_failed(napi_env env, const ta_napi_handler_error *failure) {
    bool pending = false;
    napi_value error;
    if (napi_is_exception_pending(env, &pending) != napi_ok || !pending ||
        napi_get_and_clear_last_exception(env, &error) != napi_ok)
        return;
    if (!ta_napi_handler_rejected(env, failure, error)) ta_napi_keep(env, failure->host, error);
}

void ta_napi_keep_error(napi_env env, ta_napi_host *host) {
    ta_napi_handler_failed(env, &(ta_napi_handler_error){host, NULL});
}

/* The kept error, its reference deleted; NULL when none. */
static napi_value ta_napi_take_kept(napi_env env, ta_napi_host *host) {
    napi_value box = NULL, error = NULL;
    if (host->error == NULL) return NULL;
    if (napi_get_reference_value(env, host->error, &box) != napi_ok || box == NULL ||
        napi_get_element(env, box, 0, &error) != napi_ok)
        error = NULL;
    napi_delete_reference(env, host->error);
    host->error = NULL;
    return error;
}

bool ta_napi_throw_kept(napi_env env, ta_napi_host *host) {
    napi_value error = ta_napi_take_kept(env, host);
    if (error == NULL) return false;
    napi_throw(env, error);
    return true;
}

/* A refusal as the error value it throws, not thrown. */
static napi_value ta_napi_error_of(napi_env env, const ta_napi_refusal *refusal) {
    napi_value error = NULL;
    ta_napi_throw(env, refusal);
    if (napi_get_and_clear_last_exception(env, &error) != napi_ok) return NULL;
    return error;
}

/* ---- one drain at a time -------------------------------------------------------- */

void ta_napi_drain(napi_env env, ta_napi_drain_state *state) {
    ta_napi_host *host = state->host;
    ta_napi_batch batch = {state, NULL, 0};
    uint32_t count;
    state->bounded = false;
    for (uint32_t batches = 0;; batches++) {
        /* the bound before a take: a take opens a batch, and one left open
         * between turns would take in an output the application pulls
         * then (metrics, hibernate), whose ack would end effects nobody
         * dispatched */
        if (batches == TA_NAPI_BATCHES) {
            state->bounded = true;
            return;
        }
        if ((count = ta_host_effects(host->host, &batch.effects)) == 0) return;
        batch.count = count;
        host->batch = true;
        for (uint32_t i = 0; i < count; i++) ta_napi_dispatch(env, &batch, i); /* handlers may call the host:
                                                                                  inputs apply now, effects
                                                                                  come with the next take */
        ta_host_effects_ack(host->host); /* everything handed out for the batch ends */
        host->batch = false;
        host->acks++;                    /* its thin views are stale from here: core keeps no batch counter */
        if (host->depth <= 1) ta_napi_native_flush(&host->native); /* outside core, not nested */
    }
}

/* ---- the clocks ----------------------------------------------------------------- */

/* Nanoseconds as the host's ticks. */
static uint64_t ta_napi_ticks(const ta_napi_host *host, uint64_t nanoseconds) {
    uint64_t seconds = nanoseconds / ta_napi_billion, rest = nanoseconds % ta_napi_billion;
    return seconds * host->ticks_per_second + rest * host->ticks_per_second / ta_napi_billion;
}

uint64_t ta_napi_ticks_after(const ta_napi_host *host, uint64_t nanoseconds) {
    uint64_t ticks = ta_napi_ticks(host, nanoseconds);
    uint64_t back = ticks / host->ticks_per_second * ta_napi_billion +
                    ticks % host->ticks_per_second * ta_napi_billion / host->ticks_per_second;
    return back < nanoseconds ? ticks + 1 : ticks;
}

/* Ticks as milliseconds. */
double ta_napi_milliseconds(const ta_napi_host *host, uint64_t ticks) {
    return (double)ticks * 1000.0 / (double)host->ticks_per_second;
}

/* The nanoseconds of a SimulatedClock's time (an ArrayBuffer of one
 * uint64); false when it is not one any more (detached). */
static bool ta_napi_clock_read(napi_env env, napi_value time, uint64_t *nanoseconds) {
    void *data = NULL;
    size_t length = 0;
    if (napi_get_arraybuffer_info(env, time, &data, &length) != napi_ok || data == NULL ||
        length != sizeof *nanoseconds)
        return false;
    memcpy(nanoseconds, data, sizeof *nanoseconds);
    return true;
}

/* Date.now() as nanoseconds since the Unix epoch; 0: unknown (host.h). */
static uint64_t ta_napi_wall_ns(napi_env env) {
    napi_value global, date, now, result;
    double milliseconds = 0;
    if (napi_get_global(env, &global) != napi_ok || napi_get_named_property(env, global, "Date", &date) != napi_ok ||
        napi_get_named_property(env, date, "now", &now) != napi_ok ||
        napi_call_function(env, date, now, 0, NULL, &result) != napi_ok ||
        napi_get_value_double(env, result, &milliseconds) != napi_ok || !(milliseconds > 0)) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        return 0;
    }
    return (uint64_t)(milliseconds * 1e6);
}

/* The host's clocks now: a simulated clock's time is its wall clock too;
 * else the monotonic clock (ta_runtime_now_ns) and Date.now(). The wall
 * clock never goes back (host.h: "Neither goes back"). */
static ta_host_time ta_napi_now(napi_env env, ta_napi_host *host) {
    uint64_t nanoseconds = 0, wall = 0;
    napi_value time;
    if (host->clock != NULL) {
        if (napi_get_reference_value(env, host->clock, &time) == napi_ok && time != NULL)
            ta_napi_clock_read(env, time, &nanoseconds);
        wall = nanoseconds;
    } else {
        nanoseconds = ta_runtime_now_ns();
        wall = ta_napi_wall_ns(env);
    }
    if (wall < host->wall) wall = host->wall;
    host->wall = wall;
    return (ta_host_time){ta_napi_ticks(host, nanoseconds) + host->ticks_offset, wall};
}

/* The offset makes the ticks the clock reads now `time` (unsigned, so an
 * offset "down" wraps and adds up right): a new SimulatedClock, or the
 * runtime's clock in another process or after a reboot. */
void ta_napi_clock_resume(napi_env env, ta_napi_host *host, uint64_t time) {
    host->ticks_offset = 0;
    host->ticks_offset = time - ta_napi_now(env, host).monotonic;
}

void ta_napi_advance(napi_env env, ta_napi_host *host) {
    if (host->host != NULL) ta_host_advance_time(host->host, ta_napi_now(env, host));
}

/* Milliseconds from now to the host's deadline (0 when it is due). */
static double ta_napi_delay(napi_env env, ta_napi_host *host) {
    ta_time now = ta_napi_now(env, host).monotonic;
    if (host->deadline <= now) return 0.0;
    return ta_napi_milliseconds(host, host->deadline - now);
}

/* ---- one turn ---------------------------------------------------------------------- */

static ta_napi_next ta_napi_turn(napi_env env, ta_napi_host *host) {
    ta_napi_drain_state drain = {host, NULL, false};
    ta_napi_drain(env, &drain); /* what inputs and posts appended: a pending reply needs no run */
    if (drain.bounded) return TA_NAPI_NEXT_YIELD;
    if (host->retake) { /* a take the allocator refused: again, in a batch of its own */
        host->batch = true;
        if (host->retake & 1u) ta_napi_take(env, host, true);
        if (host->retake & 2u) ta_napi_take(env, host, false);
        ta_host_effects_ack(host->host);
        host->batch = false;
        host->acks++;
    }
    ta_napi_advance(env, host); /* ticks at host.config's rate, wall ns */
    for (uint32_t runs = 0;; runs++) {
        host->inputs = false;
        ta_run run = ta_host_run(host->host, TA_NAPI_BUDGET); /* bounded: fuel per call */
        if (host->encoder) ta_napi_advance(env, host); /* the run's span records are stamped between the
                                                          clocks around it, not stretched over the
                                                          handlers that come after it */
        ta_napi_drain(env, &drain);
        bool bounded = drain.bounded || runs + 1 == TA_NAPI_RUNS;
        if (bounded && run.status != TA_RUN_EXHAUSTED && run.status != TA_RUN_FAULT)
            return TA_NAPI_NEXT_YIELD; /* the turn's bound: let I/O run, then turn again */
        switch (run.status) {
        case TA_RUN_EFFECTS:      /* senders waited for the batch the drain acked: they go on now */
        case TA_RUN_EFFECTS_FULL: continue; /* run again now */
        case TA_RUN_YIELDED:      return TA_NAPI_NEXT_YIELD; /* budget spent, actors still runnable */
        case TA_RUN_IDLE:         if (host->inputs) return TA_NAPI_NEXT_YIELD; /* handlers fed inputs in
                                                                                the drain: turn again */
                                  host->deadline = run.next_deadline; /* UINT64_MAX: none */
                                  return TA_NAPI_NEXT_IDLE;
        case TA_RUN_EXHAUSTED:    host->pool = run.detail; /* a TA_POOL_* */
                                  return TA_NAPI_NEXT_EXHAUSTED;
        case TA_RUN_FAULT:        host->fault = (ta_status)run.detail; /* negative: ta_status_name */
                                  return TA_NAPI_NEXT_FAULT;
        default:                  host->fault = TA_ERROR_UNSUPPORTED; /* a status unknown here */
                                  return TA_NAPI_NEXT_FAULT;
        }
    }
}

/* The pools of TA_RUN_EXHAUSTED's detail, by core's names (system.h). */
static const char *const ta_napi_pools[] = {
    "the host's allocator refused memory for the host's own (TA_POOL_NONE)",
    "the host's allocator refused memory for the pool of events (TA_POOL_EVENTS)",
    "the host's allocator refused memory for the pool of instances and strings (TA_POOL_SLAB)",
    "the host's allocator refused memory for the pool of timers (TA_POOL_TIMERS)",
    "the host's allocator refused memory for the pool of actors (TA_POOL_ACTORS)",
    "the host's allocator refused memory for the pool of requests (TA_POOL_REQUESTS)",
};

/* The turn's first error, or NULL: a handler's, then an exhausted pool
 * (TA_ERROR_NO_MEMORY naming the pool; the next turn goes on where the run
 * stopped), then a fault (its status, ta_status_name). */
static napi_value ta_napi_turn_error(napi_env env, ta_napi_host *host, ta_napi_next next) {
    napi_value error = ta_napi_take_kept(env, host);
    if (error != NULL) return error;
    if (next == TA_NAPI_NEXT_EXHAUSTED) {
        const char *message = host->pool < sizeof ta_napi_pools / sizeof ta_napi_pools[0]
                                  ? ta_napi_pools[host->pool]
                                  : "the host's allocator refused memory for a pool (TA_POOL_*)";
        return ta_napi_error_of(env, &(ta_napi_refusal){TA_ERROR_NO_MEMORY, message});
    }
    if (next == TA_NAPI_NEXT_FAULT) return ta_napi_error_of(env, &(ta_napi_refusal){host->fault, "the host's run faulted"});
    return NULL;
}

/* ---- the event loop -------------------------------------------------------------------- */

/* A call of a global function of this realm (setImmediate, setTimeout and
 * their clear functions), looked up at each call. */
typedef struct ta_napi_global_call {
    const char *name;
    size_t argc;
    const napi_value *argv;
} ta_napi_global_call;

static bool ta_napi_call_global(napi_env env, const ta_napi_global_call *call, napi_value *result) {
    napi_value global, function, ignored;
    if (result == NULL) result = &ignored;
    return napi_get_global(env, &global) == napi_ok && napi_get_named_property(env, global, call->name, &function) == napi_ok &&
           napi_call_function(env, global, function, call->argc, call->argv, result) == napi_ok;
}

/* Clears a pending handle with `clear` (clearImmediate, clearTimeout) and
 * deletes its reference. */
typedef struct ta_napi_handle {
    napi_ref *reference;
    const char *clear;
} ta_napi_handle;

static void ta_napi_clear(napi_env env, const ta_napi_handle *handle) {
    napi_ref reference = *handle->reference;
    napi_value value;
    if (reference == NULL) return;
    *handle->reference = NULL;
    if (napi_get_reference_value(env, reference, &value) == napi_ok && value != NULL &&
        !ta_napi_call_global(env, &(ta_napi_global_call){handle->clear, 1, &value}, NULL)) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
    }
    napi_delete_reference(env, reference);
}

napi_value ta_napi_self(napi_env env, const ta_napi_host *host) {
    napi_value self = NULL;
    if (host->self == NULL || napi_get_reference_value(env, host->self, &self) != napi_ok) return NULL;
    return self;
}

/* setImmediate(turn, self, by) (`delay` < 0) or setTimeout(turn, delay,
 * self, by): the handle referenced in `reference`; false with an exception
 * pending. */
typedef struct ta_napi_arming {
    double delay;
    napi_ref *reference;
} ta_napi_arming;

static bool ta_napi_arm(napi_env env, ta_napi_host *host, const ta_napi_arming *arming) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value argv[4], handle, self = ta_napi_self(env, host);
    if (instance == NULL || self == NULL || napi_get_reference_value(env, instance->turn, &argv[0]) != napi_ok)
        return false;
    bool timer = arming->delay >= 0;
    if (timer) {
        if (napi_create_double(env, arming->delay, &argv[1]) != napi_ok) return false;
        argv[2] = self;
    } else argv[1] = self;
    if (napi_create_uint32(env, timer ? TA_NAPI_BY_TIMER : TA_NAPI_BY_IMMEDIATE, &argv[timer ? 3 : 2]) != napi_ok)
        return false;
    ta_napi_global_call call = {timer ? "setTimeout" : "setImmediate", timer ? 4u : 3u, argv};
    return ta_napi_call_global(env, &call, &handle) && napi_create_reference(env, handle, 1, arming->reference) == napi_ok;
}

void ta_napi_schedule(napi_env env, ta_napi_host *host) {
    host->inputs = true;
    if (host->host == NULL || host->turning || host->immediate != NULL) return;
    if (!ta_napi_arm(env, host, &(ta_napi_arming){-1.0, &host->immediate})) ta_napi_keep_error(env, host);
}

/* ---- the handlers' promises ------------------------------------------------------- */

/* settled(wrapper, value) and settled_rejected(wrapper, reason), bound to
 * the Host's wrapper: one pending promise fewer; at none, a waiting idle()
 * gets a turn, which settles it when the host is idle too. The rejected
 * one throws the reason on, so the chain's last promise rejects unhandled. */
static napi_value ta_napi_settled(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, undefined = NULL;
    void *rejected = NULL;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, &rejected) != napi_ok) return NULL;
    napi_get_undefined(env, &undefined);
    if (argc < 2) argv[1] = undefined;
    ta_napi_host *host = argc >= 1 ? ta_napi_host_of(env, &(ta_napi_host_check){argv[0], false}) : NULL;
    if (host == NULL) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
    } else if (host->promises > 0 && --host->promises == 0 && host->host != NULL && host->idle != NULL) {
        ta_napi_schedule(env, host);
        if (host->error != NULL && host->depth == 0 && !host->turning) ta_napi_throw_kept(env, host);
    }
    if (rejected != NULL) {
        /* with a handlerError hook the rejection is the hook's; else thrown on */
        if (host != NULL && ta_napi_handler_rejected(env, &(ta_napi_handler_error){host, NULL}, argv[1])) return undefined;
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        napi_throw(env, argv[1]);
        return NULL;
    }
    return undefined;
}

void ta_napi_follow(napi_env env, ta_napi_host *host, napi_value promise) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value then, functions[2], bound[2], bind, argv[2], wrapper = ta_napi_self(env, host), ignored;
    napi_valuetype type = napi_undefined;
    if (instance == NULL || wrapper == NULL || promise == NULL || napi_typeof(env, promise, &type) != napi_ok ||
        (type != napi_object && type != napi_function))
        return;
    bool ok = napi_get_named_property(env, promise, "then", &then) == napi_ok && napi_typeof(env, then, &type) == napi_ok &&
              type == napi_function && napi_get_reference_value(env, instance->settled, &functions[0]) == napi_ok &&
              napi_get_reference_value(env, instance->settled_rejected, &functions[1]) == napi_ok;
    for (int i = 0; ok && i < 2; i++) {
        argv[0] = NULL;
        napi_get_undefined(env, &argv[0]);
        argv[1] = wrapper;
        ok = napi_get_named_property(env, functions[i], "bind", &bind) == napi_ok &&
             napi_call_function(env, functions[i], bind, 2, argv, &bound[i]) == napi_ok;
    }
    if (ok && napi_call_function(env, promise, then, 2, bound, &ignored) == napi_ok) {
        host->promises++;
        return;
    }
    napi_get_and_clear_last_exception(env, &ignored); /* not followed: idle() does not wait for it */
}

/* The waiting idle() settled: resolved, or rejected with `error`. */
static void ta_napi_settle(napi_env env, ta_napi_host *host, napi_value error) {
    napi_deferred deferred = host->idle;
    if (deferred == NULL) return;
    host->idle = NULL;
    if (host->idle_promise != NULL) napi_delete_reference(env, host->idle_promise);
    host->idle_promise = NULL;
    napi_value undefined;
    if (error != NULL) napi_reject_deferred(env, deferred, error);
    else if (napi_get_undefined(env, &undefined) == napi_ok) napi_resolve_deferred(env, deferred, undefined);
}

/* A turn went idle: the idle hook (the application layer's bound of
 * resident actors) gets it, outside any batch, inside the turn's call; a
 * promise it returns is followed, so idle() waits for it. */
static void ta_napi_idle_hook(napi_env env, ta_napi_host *host) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value wrapper = ta_napi_self(env, host), keys, key, handlers, hook, undefined, result;
    napi_valuetype type = napi_undefined;
    if (instance == NULL || wrapper == NULL || napi_get_undefined(env, &undefined) != napi_ok ||
        napi_get_reference_value(env, instance->keys, &keys) != napi_ok || napi_get_named_property(env, keys, "handlers", &key) != napi_ok ||
        napi_get_property(env, wrapper, key, &handlers) != napi_ok || napi_typeof(env, handlers, &type) != napi_ok ||
        type != napi_object || napi_get_named_property(env, handlers, "idle", &hook) != napi_ok ||
        napi_typeof(env, hook, &type) != napi_ok || type != napi_function) {
        ta_napi_keep_error(env, host); /* none pending: nothing */
        return;
    }
    if (napi_call_function(env, undefined, hook, 0, NULL, &result) != napi_ok) ta_napi_keep_error(env, host);
    else ta_napi_follow(env, host, result);
}

/* One turn, called by the event loop with the Host and which handle it
 * was. The turn's first error rejects a waiting idle(); with none waiting
 * it is thrown from here, after the next turn is scheduled or the timer
 * armed, so the host goes on (an uncaught error the runtime reports). */
static napi_value ta_napi_loop_turn(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {NULL, NULL}, undefined;
    uint32_t by = TA_NAPI_BY_IMMEDIATE;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || napi_get_undefined(env, &undefined) != napi_ok)
        return NULL;
    if (argc < 2 || napi_get_value_uint32(env, argv[1], &by) != napi_ok) return undefined;
    ta_napi_host *host = ta_napi_host_of(env, &(ta_napi_host_check){argv[0], false});
    if (host == NULL) return NULL;
    napi_ref *fired = by == TA_NAPI_BY_TIMER ? &host->timer : &host->immediate;
    if (*fired != NULL) napi_delete_reference(env, *fired); /* it ran: nothing to clear */
    *fired = NULL;
    ta_napi_call call;
    if (host->host == NULL || host->turning || !ta_napi_enter(env, argv[0], &call)) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        return undefined;
    }
    host->turning = true;
    ta_napi_next next = ta_napi_turn(env, host);
    host->turning = false;
    if (next == TA_NAPI_NEXT_IDLE && !host->closing && host->host != NULL) ta_napi_idle_hook(env, host);
    napi_value error = ta_napi_turn_error(env, host, next);
    bool settle = false;
    if (next == TA_NAPI_NEXT_YIELD && !host->closing) {
        ta_napi_schedule(env, host); /* yield to the event loop, then turn again */
    } else {
        ta_napi_clear(env, &(ta_napi_handle){&host->timer, "clearTimeout"}); /* one timer, replacing the last */
        if (next == TA_NAPI_NEXT_IDLE && host->deadline != UINT64_MAX && host->clock == NULL && !host->closing) {
            double delay = ta_napi_delay(env, host);
            ta_napi_arming arming = {delay < TA_NAPI_TIMEOUT_MAX ? delay : TA_NAPI_TIMEOUT_MAX, &host->timer};
            if (!ta_napi_arm(env, host, &arming)) ta_napi_keep_error(env, host);
        }
        /* idle, no handler's promise pending, and no input the idle hook made */
        settle = next != TA_NAPI_NEXT_IDLE || (host->promises == 0 && host->immediate == NULL);
    }
    if (error == NULL) error = ta_napi_take_kept(env, host); /* scheduling or arming failed */
    /* a close a handler asked for runs at the leave: the waiters are kept
     * from it (it would reject them as closed before idle) and settle
     * after it, so its last take's error reaches them */
    bool closing = host->closing && host->depth == 1;
    napi_deferred waiter = closing ? host->idle : NULL;
    napi_ref waiter_promise = closing ? host->idle_promise : NULL;
    if (closing) {
        host->idle = NULL;
        host->idle_promise = NULL;
    }
    ta_napi_leave(&call);
    if (closing) {
        if (error == NULL) error = ta_napi_take_kept(env, host); /* the last take's error */
        host->idle = waiter;
        host->idle_promise = waiter_promise;
        settle = true;
    }
    if (error != NULL && host->idle != NULL) {
        ta_napi_settle(env, host, error); /* the waiters get it */
        error = NULL;
    } else if (settle) ta_napi_settle(env, host, NULL);
    if (error != NULL) {
        napi_throw(env, error);
        return NULL;
    }
    return undefined;
}

/* idle(): the promise of the next idle turn, the same to every caller
 * until it settles; it schedules a turn when none is pending. */
napi_value ta_napi_host_idle(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL, promise = NULL;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) return NULL;
    ta_napi_host *closed = ta_napi_host_of(env, &(ta_napi_host_check){self, false});
    if (closed == NULL) return NULL; /* another object: a TypeError, thrown */
    if (closed->host == NULL) { /* closed: a promise, rejected, as a waiting idle() is at close */
        napi_deferred deferred;
        napi_value error = ta_napi_error_of(env, &(ta_napi_refusal){TA_ERROR_STATE, "the Host is closed"});
        if (error == NULL || napi_create_promise(env, &deferred, &promise) != napi_ok ||
            napi_reject_deferred(env, deferred, error) != napi_ok)
            return NULL;
        return promise;
    }
    ta_napi_call call;
    if (!ta_napi_enter(env, self, &call)) return NULL;
    ta_napi_host *host = call.host;
    if (host->idle_promise != NULL && napi_get_reference_value(env, host->idle_promise, &promise) == napi_ok &&
        promise != NULL) {
        ta_napi_leave(&call);
        return promise;
    }
    if (napi_create_promise(env, &host->idle, &promise) != napi_ok ||
        napi_create_reference(env, promise, 1, &host->idle_promise) != napi_ok) {
        ta_napi_leave(&call);
        return NULL;
    }
    if (host->immediate == NULL) ta_napi_schedule(env, host); /* a turn inside this one settles it at its end */
    ta_napi_leave(&call);
    return promise;
}

/* host.now(): the host's clock in milliseconds as it reads now (a
 * SimulatedClock's time, or the runtime's monotonic clock), on the scale
 * core's time is on: a restored host's goes on from its snapshot's. It
 * reads, and advances nothing. */
napi_value ta_napi_host_now(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL, result = NULL;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) return NULL;
    ta_napi_call call;
    if (!ta_napi_enter(env, self, &call)) return NULL;
    napi_create_double(env, ta_napi_milliseconds(call.host, ta_napi_now(env, call.host).monotonic), &result);
    ta_napi_leave(&call);
    return result;
}

napi_value ta_napi_host_next_deadline(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL, result = NULL;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) return NULL;
    ta_napi_host *host = ta_napi_host_of(env, &(ta_napi_host_check){self, false});
    if (host == NULL) return NULL;
    if (host->host == NULL || host->deadline == UINT64_MAX) napi_get_undefined(env, &result);
    else napi_create_double(env, ta_napi_delay(env, host), &result);
    return result;
}

/* trace.end, then the last take of traces and logs, before ta_host_free
 * (bindings.md, section 4): the spans still open are ended and go to the
 * telemetry handler with the rest (a handler's error is kept). A call on
 * the stack, as a drain is: a handler's close() is this one, its
 * metrics() joins the open batch. Bounded: a handler that makes inputs
 * here (a spawn) makes more records at every take. What the handler
 * returns is gathered in host->endings, for [Symbol.asyncDispose]. */
static void ta_napi_end_traces(napi_env env, ta_napi_host *host) {
    unsigned char room[64];
    ta_cbor_writer writer;
    ta_cbor_writer_init(&writer, (ta_buffer){room, sizeof room, 0}, &host->arena_allocator);
    ta_cbor_write_map(&writer, 1);
    ta_cbor_write_text(&writer, ta_string("method"));
    ta_cbor_write_text(&writer, ta_string("trace.end"));
    ta_bytes message;
    if (napi_create_array(env, &host->endings) != napi_ok) host->endings = NULL;
    host->depth++;
    if (ta_cbor_writer_bytes(&writer, &message) == TA_OK && ta_host_post(host->host, message) == TA_OK) {
        const ta_host_effect *effects;
        for (uint32_t batches = 0; batches < TA_NAPI_END_TAKES && ta_host_effects(host->host, &effects) > 0; batches++) {
            host->batch = true;
            ta_bytes taken;
            for (uint32_t takes = 0; takes < TA_NAPI_END_TAKES && ta_host_traces(host->host, &taken) == TA_OK && taken.length; takes++)
                ta_napi_telemetry(env, host, &(ta_napi_export){"traces", taken});
            for (uint32_t takes = 0; takes < TA_NAPI_END_TAKES && ta_host_logs(host->host, &taken) == TA_OK && taken.length; takes++)
                ta_napi_telemetry(env, host, &(ta_napi_export){"logs", taken});
            ta_host_effects_ack(host->host);
            host->batch = false;
            host->acks++;
        }
    }
    host->depth--;
    host->closing = false; /* a close asked by a handler here: this one */
    ta_cbor_writer_free(&writer);
}

/* The timers cleared and a waiting idle() rejected. */
static void ta_napi_loop_quiet(napi_env env, ta_napi_host *host) {
    ta_napi_clear(env, &(ta_napi_handle){&host->timer, "clearTimeout"});
    ta_napi_clear(env, &(ta_napi_handle){&host->immediate, "clearImmediate"});
    if (host->idle != NULL) {
        napi_value error = ta_napi_error_of(env, &(ta_napi_refusal){TA_ERROR_STATE, "the Host was closed before it was idle"});
        ta_napi_settle(env, host, error);
    }
}

void ta_napi_loop_stop(napi_env env, ta_napi_host *host) {
    host->endings = NULL;
    ta_napi_loop_quiet(env, host);
    if (host->host == NULL || !host->encoder || !host->telemetry) return;
    ta_napi_end_traces(env, host);
    ta_napi_loop_quiet(env, host); /* what a handler there scheduled or awaited: the host is going */
}

/* ---- SimulatedClock -------------------------------------------------------------------- */

/* napi_type_tag_object's tag of a SimulatedClock. */
static const napi_type_tag ta_napi_clock_tag = {0x7461636c6f636b4eULL, 0x4150496c6f636b31ULL};

/* A clock's state, an object on it under the instance's `clock` symbol:
 * `time`, an ArrayBuffer of one uint64 of nanoseconds, which the hosts
 * made with it reference and read, and `hosts`, an array of WeakRefs to
 * them: the clock keeps no host from the collector. */
static napi_value ta_napi_clock_state(napi_env env, napi_value clock) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    bool tagged = false;
    napi_valuetype type = napi_undefined;
    napi_value keys, key, state;
    if (instance == NULL) return NULL;
    if (clock == NULL || napi_typeof(env, clock, &type) != napi_ok || type != napi_object ||
        napi_check_object_type_tag(env, clock, &ta_napi_clock_tag, &tagged) != napi_ok || !tagged) {
        napi_throw_type_error(env, NULL, "not a SimulatedClock");
        return NULL;
    }
    if (napi_get_reference_value(env, instance->keys, &keys) != napi_ok ||
        napi_get_named_property(env, keys, "clock", &key) != napi_ok || napi_get_property(env, clock, key, &state) != napi_ok)
        return NULL;
    return state;
}

static bool ta_napi_clock_now(napi_env env, napi_value state, uint64_t *nanoseconds) {
    napi_value time;
    if (napi_get_named_property(env, state, "time", &time) != napi_ok) return false;
    if (!ta_napi_clock_read(env, time, nanoseconds)) {
        napi_throw_error(env, NULL, "the SimulatedClock's time is gone");
        return false;
    }
    return true;
}

/* new SimulatedClock() */
static napi_value ta_napi_clock_new(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self, target, state, time, hosts, keys, key;
    void *data = NULL;
    ta_napi_instance *instance = ta_napi_instance_of(env);
    if (instance == NULL || napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok ||
        napi_get_new_target(env, info, &target) != napi_ok)
        return NULL;
    if (target == NULL) {
        napi_throw_type_error(env, NULL, "SimulatedClock is a class: new SimulatedClock()");
        return NULL;
    }
    if (napi_create_arraybuffer(env, sizeof(uint64_t), &data, &time) != napi_ok) return NULL;
    memset(data, 0, sizeof(uint64_t));
    if (napi_create_object(env, &state) != napi_ok || napi_create_array(env, &hosts) != napi_ok ||
        napi_set_named_property(env, state, "time", time) != napi_ok ||
        napi_set_named_property(env, state, "hosts", hosts) != napi_ok ||
        napi_get_reference_value(env, instance->keys, &keys) != napi_ok ||
        napi_get_named_property(env, keys, "clock", &key) != napi_ok)
        return NULL;
    napi_property_descriptor property = {NULL, key, NULL, NULL, NULL, state, napi_default, NULL};
    if (napi_define_properties(env, self, 1, &property) != napi_ok ||
        napi_type_tag_object(env, self, &ta_napi_clock_tag) != napi_ok)
        return NULL;
    return self;
}

/* clock.now: milliseconds since the clock was made. */
static napi_value ta_napi_clock_milliseconds(napi_env env, napi_callback_info info) {
    size_t argc = 0;
    napi_value self = NULL, result = NULL;
    uint64_t nanoseconds = 0;
    if (napi_get_cb_info(env, info, &argc, NULL, &self, NULL) != napi_ok) return NULL;
    napi_value state = ta_napi_clock_state(env, self);
    if (state == NULL || !ta_napi_clock_now(env, state, &nanoseconds)) return NULL;
    napi_create_double(env, (double)nanoseconds / 1e6, &result);
    return result;
}

/* A host's WeakRef deref'd: the Host, open, or NULL. */
static ta_napi_host *ta_napi_clock_host(napi_env env, napi_value reference) {
    napi_value deref, value;
    napi_valuetype type = napi_undefined;
    if (napi_get_named_property(env, reference, "deref", &deref) != napi_ok ||
        napi_call_function(env, reference, deref, 0, NULL, &value) != napi_ok ||
        napi_typeof(env, value, &type) != napi_ok || type != napi_object)
        return NULL;
    void *data = NULL;
    if (napi_unwrap(env, value, &data) != napi_ok || data == NULL) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        return NULL;
    }
    ta_napi_host *host = (ta_napi_host *)data;
    return host->env == env && host->host != NULL ? host : NULL;
}

/* clock.increment(ms): moves the clock and schedules a turn on every open
 * host made with it, like any input; it turns nothing itself. The hosts
 * that were collected or closed are forgotten. */
static napi_value ta_napi_clock_increment(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {NULL}, self = NULL, undefined, hosts, live;
    double milliseconds = -1;
    uint64_t nanoseconds = 0;
    napi_valuetype type = napi_undefined;
    if (napi_get_cb_info(env, info, &argc, argv, &self, NULL) != napi_ok || napi_get_undefined(env, &undefined) != napi_ok)
        return NULL;
    napi_value state = ta_napi_clock_state(env, self);
    if (state == NULL) return NULL;
    if (argc < 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_number ||
        napi_get_value_double(env, argv[0], &milliseconds) != napi_ok) {
        napi_throw_type_error(env, NULL, "increment(ms): a number of milliseconds");
        return NULL;
    }
    if (!(milliseconds >= 0) || !ta_napi_clock_now(env, state, &nanoseconds)) {
        if (!(milliseconds >= 0)) napi_throw_range_error(env, NULL, "increment(ms): not negative, not NaN");
        return NULL;
    }
    double step = milliseconds * 1e6 + 0.5;
    if (step >= 18446744073709551616.0 - (double)nanoseconds) { /* 2^64, and infinity */
        napi_throw_range_error(env, NULL, "increment(ms): the clock would pass 2^64 nanoseconds");
        return NULL;
    }
    nanoseconds += (uint64_t)step;
    napi_value time;
    void *data = NULL;
    size_t length = 0;
    if (napi_get_named_property(env, state, "time", &time) != napi_ok ||
        napi_get_arraybuffer_info(env, time, &data, &length) != napi_ok || length != sizeof nanoseconds)
        return NULL;
    memcpy(data, &nanoseconds, sizeof nanoseconds);
    uint32_t count = 0, kept = 0;
    if (napi_get_named_property(env, state, "hosts", &hosts) != napi_ok || napi_get_array_length(env, hosts, &count) != napi_ok ||
        napi_create_array(env, &live) != napi_ok)
        return NULL;
    for (uint32_t i = 0; i < count; i++) {
        napi_value reference;
        if (napi_get_element(env, hosts, i, &reference) != napi_ok) return NULL;
        ta_napi_host *host = ta_napi_clock_host(env, reference);
        if (host == NULL) continue;
        if (napi_set_element(env, live, kept++, reference) != napi_ok) return NULL;
        ta_napi_schedule(env, host);
        if (host->error != NULL && !host->turning && host->depth == 0) { /* scheduling failed: say so here */
            ta_napi_throw_kept(env, host);
            return NULL;
        }
    }
    if (napi_set_named_property(env, state, "hosts", live) != napi_ok) return NULL;
    return undefined;
}

bool ta_napi_clock_attach(napi_env env, ta_napi_host *host, napi_value clock) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, clock, &type) != napi_ok) return false;
    if (type == napi_undefined) return true;
    napi_value state = ta_napi_clock_state(env, clock), time, hosts, global, constructor, reference, self;
    if (state == NULL) {
        napi_value ignored;
        napi_get_and_clear_last_exception(env, &ignored);
        napi_throw_type_error(env, NULL, "clock is a SimulatedClock");
        return false;
    }
    uint32_t count = 0;
    self = ta_napi_self(env, host);
    return self != NULL && napi_get_named_property(env, state, "time", &time) == napi_ok &&
           napi_create_reference(env, time, 1, &host->clock) == napi_ok &&
           napi_get_named_property(env, state, "hosts", &hosts) == napi_ok &&
           napi_get_array_length(env, hosts, &count) == napi_ok && napi_get_global(env, &global) == napi_ok &&
           napi_get_named_property(env, global, "WeakRef", &constructor) == napi_ok &&
           napi_new_instance(env, constructor, 1, &self, &reference) == napi_ok &&
           napi_set_element(env, hosts, count, reference) == napi_ok;
}

napi_status ta_napi_loop_define(napi_env env, napi_value exports) {
    ta_napi_instance *instance = ta_napi_instance_of(env);
    napi_value turn, keys, description, symbol, class;
    if (instance == NULL) return napi_pending_exception;
    napi_status status = napi_create_function(env, "turn", NAPI_AUTO_LENGTH, ta_napi_loop_turn, NULL, &turn);
    if (status == napi_ok) status = napi_create_reference(env, turn, 1, &instance->turn);
    napi_value settled, settled_rejected;
    if (status == napi_ok) status = napi_create_function(env, "settled", NAPI_AUTO_LENGTH, ta_napi_settled, NULL, &settled);
    if (status == napi_ok) status = napi_create_reference(env, settled, 1, &instance->settled);
    if (status == napi_ok)
        status = napi_create_function(env, "settledRejected", NAPI_AUTO_LENGTH, ta_napi_settled, (void *)instance, &settled_rejected);
    if (status == napi_ok) status = napi_create_reference(env, settled_rejected, 1, &instance->settled_rejected);
    if (status == napi_ok) status = napi_get_reference_value(env, instance->keys, &keys);
    if (status == napi_ok) status = napi_create_string_utf8(env, "tinyactors.clock", NAPI_AUTO_LENGTH, &description);
    if (status == napi_ok) status = napi_create_symbol(env, description, &symbol);
    if (status == napi_ok) status = napi_set_named_property(env, keys, "clock", symbol);
    napi_property_descriptor properties[] = {
        {"increment", NULL, ta_napi_clock_increment, NULL, NULL, NULL, napi_default_method, NULL},
        {"now", NULL, NULL, ta_napi_clock_milliseconds, NULL, NULL, napi_configurable, NULL},
    };
    if (status == napi_ok)
        status = napi_define_class(env, "SimulatedClock", NAPI_AUTO_LENGTH, ta_napi_clock_new, NULL,
                                   sizeof properties / sizeof properties[0], properties, &class);
    if (status == napi_ok) status = napi_set_named_property(env, exports, "SimulatedClock", class);
    return status;
}
