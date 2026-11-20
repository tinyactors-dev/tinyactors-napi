/* The loop (tinyactors-core/docs/embedding.md, section 2; bindings.md,
 * section 3): the drain and the turn, in C. No take or ack is exported, so
 * no handler can nest a drain or skip an ack (docs/browser.md, "What is C
 * and what is JavaScript"); a handler gets its effect through the import
 * ta_web.effect, and may call the host's inputs from there. */
#include "web.h"

/* Fuel a run gets, runs a turn makes and batches a drain takes before
 * the turn yields to the event loop: the addon's bounds (src/loop.c). */
enum { TA_WEB_BUDGET = 10000, TA_WEB_RUNS = 64, TA_WEB_BATCHES = 64 };

/* What ta_web_turn answers: what the driver does next. */
enum {
    TA_WEB_NEXT_YIELD = 0,     /* turn again after the event loop ran (a macrotask) */
    TA_WEB_NEXT_IDLE = 1,      /* nothing runnable: arm one timer at the deadline (ta_web_host_delay) */
    TA_WEB_NEXT_EXHAUSTED = 2, /* the allocator refused a pool (ta_web_host_detail: a TA_POOL_*) */
    TA_WEB_NEXT_FAULT = 3,     /* the run faulted (ta_web_host_detail: its status) */
    TA_WEB_NEXT_REFUSED = 4    /* a turn inside a call of the host, or inside another turn */
};

/* ---- time --------------------------------------------------------------------------- */

static const uint64_t ta_web_billion = 1000000000u;

/* Nanoseconds as ticks at the host's rate, exactly. */
static uint64_t ta_web_ticks(const ta_web_host *host, uint64_t nanoseconds) {
    uint64_t seconds = nanoseconds / ta_web_billion, rest = nanoseconds % ta_web_billion;
    return seconds * host->ticks_per_second + rest * host->ticks_per_second / ta_web_billion;
}

static uint64_t ta_web_nanoseconds(double value) {
    if (!(value > 0)) return 0;
    if (value >= 18446744073709551615.0) return UINT64_MAX;
    return (uint64_t)value;
}

/* The host's clocks now (ta_web.clock): the ticks of the monotonic clock
 * plus the restore's offset, and the wall clock, which never goes back. */
static ta_host_time ta_web_now(ta_web_host *host) {
    uint64_t monotonic = ta_web_nanoseconds(ta_web_import_clock(host->id, 0));
    uint64_t wall = ta_web_nanoseconds(ta_web_import_clock(host->id, 1));
    if (wall < host->wall) wall = host->wall;
    host->wall = wall;
    return (ta_host_time){ta_web_ticks(host, monotonic) + host->ticks_offset, wall};
}

/* Both clocks, and quickjs's (its Date reads the real wall clock, which a
 * wasm module has only when it is given). */
static void ta_web_advance(ta_web_host *host) {
    ta_host_advance_time(host->host, ta_web_now(host));
    ta_web_quickjs_time(host);
}

/* Both clocks before an input that depends on them (spawn, a typed
 * method: a trace.watch ends at a time of the host's clock). */
TA_WEB_EXPORT void ta_web_host_advance(ta_web_host *host) {
    ta_web_enter(host); /* inside a run core does nothing (host.h) */
    ta_web_advance(host);
    ta_web_leave(host);
}

/* The offset that makes the ticks the clock reads now `time` (record words
 * 0-1): a restore's, so the clock goes on from the snapshot's time. */
TA_WEB_EXPORT void ta_web_host_clock_resume(ta_web_host *host) {
    uint64_t time = ta_web_word64(host->env->record.word, 0);
    host->ticks_offset = 0;
    ta_web_enter(host);
    host->ticks_offset = time - ta_web_now(host).monotonic;
    ta_web_leave(host);
}

/* host.now(): the host's clock as it reads now (the restore's offset in),
 * in milliseconds at its rate; it advances nothing. */
TA_WEB_EXPORT double ta_web_host_now(ta_web_host *host) {
    ta_web_enter(host);
    ta_time now = ta_web_now(host).monotonic;
    ta_web_leave(host);
    return (double)now * 1000.0 / (double)host->ticks_per_second;
}

/* A time of the host's clock (ticks, `low` and `high` its two halves) as
 * milliseconds on the clock ta_web_host_now reads: actor.get's
 * timers[].due (bindings.md, section 3). */
TA_WEB_EXPORT double ta_web_host_milliseconds(ta_web_host *host, uint32_t low, uint32_t high) {
    uint64_t ticks = (uint64_t)low | (uint64_t)high << 32;
    return (double)ticks * 1000.0 / (double)host->ticks_per_second;
}

/* Milliseconds from now to the host's deadline: 0 when it is due, -1 for
 * none (UINT64_MAX). */
TA_WEB_EXPORT double ta_web_host_delay(ta_web_host *host) {
    if (host->deadline == UINT64_MAX) return -1.0;
    ta_web_enter(host);
    ta_time now = ta_web_now(host).monotonic;
    ta_web_leave(host);
    if (host->deadline <= now) return 0.0;
    return (double)(host->deadline - now) * 1000.0 / (double)host->ticks_per_second;
}

/* The detail of the last TA_WEB_NEXT_EXHAUSTED (a TA_POOL_*) or
 * TA_WEB_NEXT_FAULT (a status, ta_status_name). */
TA_WEB_EXPORT int32_t ta_web_host_detail(const ta_web_host *host, uint32_t fault) {
    return fault ? (int32_t)host->fault : (int32_t)host->pool;
}

/* ---- the drain ------------------------------------------------------------------------- */

/* A REPLY's pending row: the row whose handle is the reply's `id`, found
 * in O(1) and removed (the generation refuses a stale id); its slot + 1,
 * or 0 when no row has that id (dropped: not ours). */
static uint32_t ta_web_reply_slot(ta_web_host *host, uint32_t index) {
    ta_cbor_reader reader;
    ta_cbor_item item;
    ta_cbor_reader_init(&reader, ta_host_effect_bytes(host->host, index, TA_EFFECT_FIELD_WIRE));
    if (ta_cbor_read(&reader, &item) != 1 || item.kind != TA_CBOR_MAP) return 0;
    for (uint32_t pairs = item.count; pairs > 0; pairs--) {
        if (ta_cbor_read(&reader, &item) != 1) return 0;
        bool id = item.kind == TA_CBOR_TEXT && item.bytes.length == 2 && ((const unsigned char *)item.bytes.pointer)[0] == 'i' &&
                  ((const unsigned char *)item.bytes.pointer)[1] == 'd';
        if (ta_cbor_read(&reader, &item) != 1) return 0;
        if (id) {
            if (item.kind != TA_CBOR_UINT || ta_table_get(&host->pending, item.value) == NULL) return 0;
            ta_table_remove(&host->pending, item.value);
            return (uint32_t)item.value;
        }
        /* skip the value's children: containers nest; read until the depth is back */
        uint32_t depth = item.depth;
        if (item.kind == TA_CBOR_ARRAY || item.kind == TA_CBOR_MAP || item.kind == TA_CBOR_TAG) {
            ta_cbor_reader probe = reader;
            ta_cbor_item next;
            while (ta_cbor_read(&probe, &next) == 1 && next.depth > depth) reader = probe;
        }
    }
    return 0;
}

/* A take of traces or logs (the encoder's TRACES, LOGS): its bytes to
 * JavaScript (ta_web.output, TA_WEB_OUTPUT_TRACES or _LOGS), which copies
 * them for the telemetry handler; a take the allocator refused is reported
 * once (the length TA_WEB_TAKE_REFUSED) and retried at the next turn (core
 * gives no second effect until a take). */
static void ta_web_take(ta_web_host *host, bool traces) {
    ta_bytes taken;
    ta_status status = traces ? ta_host_traces(host->host, &taken) : ta_host_logs(host->host, &taken);
    uint8_t bit = traces ? 1u : 2u;
    uint32_t kind = traces ? TA_WEB_OUTPUT_TRACES : TA_WEB_OUTPUT_LOGS;
    if (status == TA_OK) {
        host->retake &= (uint8_t)~bit;
        if (taken.length == 0) return;
        ta_web_set_bytes(host->env->record.word, 0, taken);
        ta_web_import_output(host->id, kind, (uint32_t)taken.length);
        return;
    }
    if (status == TA_ERROR_NO_MEMORY && !(host->retake & bit)) {
        host->retake |= bit;
        ta_web_set_bytes(host->env->record.word, 0, (ta_bytes){NULL, 0});
        ta_web_import_output(host->id, kind, TA_WEB_TAKE_REFUSED);
    }
}

/* One effect of the open batch: what JavaScript never sees is handled
 * here, the rest goes to ta_web.effect. */
static void ta_web_dispatch(ta_web_host *host, uint32_t index) {
    uint32_t kind = (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_KIND);
    switch (kind) {
    case TA_EFFECT_REQUEST: {
        /* a fetch at run time: refused in C until it is built (the addon's
         * rule); the requester gets error.execution */
        ta_resume resume = {(uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_SEGMENT),
                            (uint32_t)ta_host_effect_number(host->host, index, TA_EFFECT_FIELD_TOKEN), TA_ERROR_INVALID, 0, 0};
        if (ta_host_resume(host->host, &resume) == TA_OK) ta_web_input(host);
        break;
    }
    case TA_HOST_EFFECT_REPLY: {
        uint32_t slot = ta_web_reply_slot(host, index);
        if (slot != 0) ta_web_import_effect(host->id, index, slot);
        break;
    }
    case TA_HOST_EFFECT_TRACES: ta_web_take(host, true); break;
    case TA_HOST_EFFECT_LOGS: ta_web_take(host, false); break;
    case TA_EFFECT_DONE:
    case TA_EFFECT_ERROR:
    case TA_EFFECT_SEND:
    case TA_EFFECT_LOG:
    case TA_EFFECT_WAKE:
    case TA_EFFECT_INVOKE:
    case TA_EFFECT_UNINVOKE:
    case TA_HOST_EFFECT_MIGRATED:
    case TA_HOST_EFFECT_MIGRATION_DONE: ta_web_import_effect(host->id, index, 0); break;
    default: /* DONE, ERROR: no application callback; SEGMENT_FREED: the host keeps the images;
                a NOTIFICATION nobody defined */
        break;
    }
}

/* Take, dispatch every effect, ack, until a take is empty or the bound:
 * answers whether it stopped at the bound (the turn then yields; no batch
 * stays open between turns, since it stops before a take). */
static bool ta_web_drain(ta_web_host *host) {
    for (uint32_t batches = 0; batches < TA_WEB_BATCHES; batches++) {
        const ta_host_effect *effects = NULL;
        uint32_t n = ta_host_effects(host->host, &effects);
        if (n == 0) return false;
        host->batch = true;
        for (uint32_t i = 0; i < n; i++) ta_web_dispatch(host, i); /* handlers may call the host: inputs
                                                                      apply now, effects come next take */
        ta_host_effects_ack(host->host); /* everything handed out for it ends */
        host->batch = false;
        host->acks++; /* this batch's thin views are stale from here */
    }
    return true;
}

/* One turn of the host: drains what inputs and posts appended, advances
 * the clocks, then runs and drains until the run is idle, yields, or the
 * turn reaches its bound. Answers a TA_WEB_NEXT_*. A turn from inside a
 * call of the host or another turn is refused (TA_WEB_NEXT_REFUSED). */
TA_WEB_EXPORT uint32_t ta_web_turn(ta_web_host *host) {
    if (host->host == NULL || host->turning || host->depth > 0) return TA_WEB_NEXT_REFUSED;
    host->turning = true;
    ta_web_enter(host);
    uint32_t next = TA_WEB_NEXT_YIELD;
    if (ta_web_drain(host)) goto done;
    if (host->retake) { /* a take the allocator refused: again, in a batch of its own */
        host->batch = true;
        if (host->retake & 1u) ta_web_take(host, true);
        if (host->retake & 2u) ta_web_take(host, false);
        ta_host_effects_ack(host->host);
        host->batch = false;
        host->acks++;
    }
    ta_web_advance(host);
    for (uint32_t runs = 0;; runs++) {
        host->inputs = false;
        ta_run run = ta_host_run(host->host, TA_WEB_BUDGET); /* bounded: fuel per call */
        if (host->encoder) ta_web_advance(host); /* the run's spans are stamped between the clocks around it */
        bool bounded = ta_web_drain(host) || runs + 1 == TA_WEB_RUNS;
        if (bounded && run.status != TA_RUN_EXHAUSTED && run.status != TA_RUN_FAULT) break; /* yield */
        if (run.status == TA_RUN_EFFECTS || run.status == TA_RUN_EFFECTS_FULL) continue; /* run again now */
        if (run.status == TA_RUN_YIELDED) break;                                          /* budget spent */
        if (run.status == TA_RUN_IDLE) {
            if (host->inputs) break; /* handlers fed inputs in the drain: turn again */
            host->deadline = run.next_deadline; /* UINT64_MAX: none */
            next = TA_WEB_NEXT_IDLE;
        } else if (run.status == TA_RUN_EXHAUSTED) {
            host->pool = run.detail; /* a TA_POOL_* */
            next = TA_WEB_NEXT_EXHAUSTED;
        } else {
            host->fault = run.status == TA_RUN_FAULT ? (ta_status)run.detail : TA_ERROR_UNSUPPORTED;
            next = TA_WEB_NEXT_FAULT;
        }
        break;
    }
done:
    ta_web_leave(host);
    host->turning = false;
    return next;
}
