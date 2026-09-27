#pragma once
/*
 * The native system (ADR 0012, ADR 0014): one ta_system and everything the
 * addon keeps for it. This module has no Node-API in it, so native tests can
 * create, close and free systems directly; napi_system.{c,h} wraps it as the
 * JavaScript System class.
 *
 * Lifecycle:
 * - tna_system_create() allocates the record with malloc (it holds the
 *   counting allocator, so it cannot count itself), initializes the
 *   allocator and the scratch arenas, and creates the ta_system with the
 *   allocator's core lane as core's allocator.
 * - tna_system_close() is idempotent and authoritative: it destroys the
 *   ta_system and the arenas. After it, the allocator's bytes in use are
 *   zero unless something leaked, and tna_system_leaked_bytes() says how
 *   many.
 * - tna_system_free() closes the system if needed and frees the record.
 *
 * Scheduling (ADRs 0005, 0007): the system owns the scheduling table and
 * its queues (scheduler.h). Adding work asks for a turn through `wake`,
 * which the Node-API layer sets (pump.c) and native tests may set to anything;
 * a flag coalesces the requests until the turn runs.
 *
 * Routing (ADR 0006): the directory and the router are installed on core
 * when the system is created. Close uninstalls both, gives back the
 * directory's address references and the mailboxes' events, and only then
 * destroys core, because core frees its address records at the end of
 * ta_system_destroy().
 *
 * Time (ADR 0007 point 3): core's clock is logical milliseconds that only
 * the host moves. With the manual clock only tna_system_advance_to() moves
 * it. With the realtime clock it follows a monotonic clock read natively,
 * relative to system creation: every turn starts by setting it, and so does
 * the host timer when it fires. After each turn the system asks the host for
 * one timer at ta_system_next_deadline(), through `arm`, but only when that
 * deadline is earlier than the one already armed; a later deadline lets the
 * armed timer fire early and arm again. Due sends are dispatched at the end
 * of a turn, at most `due` of them.
 *
 * Services (ROADMAP step 13, ADR 0001 rule 3): the log sink, the I/O
 * processors and the invokers core calls are adapters (the adapters in adapters/) that
 * queue effects (effects.h) instead of running JavaScript inside core. The
 * queue counts as work, so a system with effects waiting is not quiet, and
 * close releases what they hold while core is still alive. The in-system
 * SCXML invoker is registered at creation; it spawns its child in the same
 * system and tells the scheduler about it.
 *
 * Later steps add more plumbing (values); each one is released by
 * tna_system_close() in the order ADR 0012 gives.
 */
#include <stdbool.h>
#include <stddef.h>

#include "definitions.h"
#include "allocator.h"
#include "directory.h"
#include "effects.h"
#include "loads.h"
#include "offloads.h"
#include "adapters/trace.h"
#include "otlp.h"
#include "scheduler.h"
#include "tinyactors.h"

/* Defaults for SchedulingOptions (ADR 0007). */
#define TNA_DEFAULT_RESUMES_PER_TURN 1024u
#define TNA_DEFAULT_RESUME_BUDGET 64u
#define TNA_DEFAULT_ACTION_BUDGET 1024u
#define TNA_DEFAULT_MESSAGE_BUDGET 1024u
#define TNA_DEFAULT_DUE_BUDGET 1024u
/* Microsteps one macrostep may run before its actor is a runaway (core ADR
 * 0075): far past any ordinary chart, about a tenth of a second of work. */
#define TNA_DEFAULT_MICROSTEP_LIMIT 100000u

typedef struct tna_system tna_system;

/* Asks the host to run tna_system_turn() soon, never inside the caller. */
typedef void (*tna_wake_fn)(tna_system *system, void *context);
/*
 * Asks the host for one timer that calls tna_system_timer_fired() after
 * `delay` milliseconds, replacing any timer it armed before. It must not keep
 * the process alive (ADR 0007 point 3).
 */
typedef void (*tna_arm_fn)(tna_system *system, ta_time delay, void *context);
/* A monotonic clock in nanoseconds; only differences between readings matter. */
typedef uint64_t (*tna_now_fn)(void *context);

typedef enum { TNA_CLOCK_REALTIME = 0, TNA_CLOCK_MANUAL } tna_clock_kind;

typedef struct {
    tna_clock_kind kind;
    ta_time initial;       /* core's time at creation */
    uint64_t origin;       /* realtime: `now` at creation, in nanoseconds */
    tna_now_fn now;        /* realtime: the monotonic clock (a test may replace it) */
    void *now_context;
    tna_arm_fn arm;        /* realtime: the host timer (pump.c) */
    bool armed;            /* a host timer is pending */
    ta_time armed_deadline;
} tna_clock;

typedef struct tna_io_processor tna_io_processor;

/* What the in-system SCXML invoker asks: which definition this invoke starts. */
typedef struct {
    const ta_invoke_request *request;
    ta_definition_id *out;
    /* The child's data-model binding: the invoke's <param> and namelist
     * values the child declares as top-level <data> (SCXML 6.4), or empty.
     * The invoker releases it after the spawn. */
    ta_value *binding;
    ta_fault *fault;
    /* Set when the definition was compiled for this invoke: the hook took a
     * hold, which the invoker gives back after the spawn, so the definition
     * lives as long as its children (core ADR 0077). */
    bool *release;
} tna_child_params;

/*
 * Mail a chart sent to a target that does not exist when it is sent (napi
 * ADR 0022): the sender gets error.communication instead of a dead letter.
 */
typedef struct {
    tna_dead_reason reason; /* TNA_DEAD_NOT_FOUND, TNA_DEAD_DONE or TNA_DEAD_UNLOADED */
    const ta_actor_ref *destination;
} tna_unreachable;

/*
 * A quarantined invoked child's report to its parent (napi ADR 0025):
 * error.communication.invoke.<id>.quarantined, kept until core takes it and
 * the parent is scheduled, so running out of memory delays it but never
 * loses it.
 */
typedef struct {
    ta_actor_id parent;
    ta_invoke_id invoke_id;
    /* The child's step when it faulted (core ADR 0067). */
    ta_trace_parent trace;
    /* The fault, as the fault hook sees it: core's result and the call. */
    ta_result code;
    const char *operation;
    /* Core took the report; making the parent runnable is what is left. */
    bool reported;
} tna_quarantine_report;

struct tna_system {
    tna_allocator allocator;
    tna_scratch scratch;
    ta_system *core;
    tna_sched sched;
    tna_directory directory; /* installed on core at creation (ADR 0006) */
    /* Loads of unloaded actors, and their wake-ups (loads.h, napi ADR 0020). */
    tna_loads loads;
    /* Actors offloaded to bytes while unloaded (core ADR 0074). */
    tna_offloads offloads;
    tna_turn_budgets budgets;
    uint32_t due_budget;   /* due sends dispatched in one turn, at least 1 */
    tna_clock clock;
    tna_wake_fn wake;
    void *wake_context;
    bool turn_pending; /* wake was called and the turn has not run yet */
    bool closed;
    /*
     * Set around every core call (ADR 0013 point 4). A generated entry point
     * that finds it set throws "reentrant": data-model, I/O and invoker
     * callbacks may run JavaScript, but that JavaScript cannot call core.
     */
    bool inside_core;
    /* Bytes still in use when close finished; nonzero means a leak. */
    size_t leaked_bytes;
    /*
     * Called by close after core is destroyed and before the leak count:
     * the Node-API layer frees what core released into it (the value-box
     * free list, ADR 0011).
     */
    void (*after_core)(void *context);
    void *after_core_context;
    /* Effects waiting for JavaScript (effects.h), in the turn arena. */
    tna_effects effects;
    /* The trace encoder (otlp.h), while a sink is installed (napi ADR 0016):
     * core's records become OTLP spans as they are written, and the pump
     * hands the spans that ended to JavaScript as bytes, once per turn. */
    tna_otlp otlp;
    bool tracing;
    /* <log> records go to JavaScript's log sink (setLogSink). */
    bool log_to_js;
    /* What the sink asks core for, and what is watched (napi ADR 0017). */
    tna_trace_masks trace_masks;
    tna_trace_watch trace_watch;
    /* The definition lifecycle as core tells it (core ADR 0079): counts and origins. */
    tna_definitions definitions;
    /* The last service handle a JavaScript invoker's start was given. */
    uint64_t next_service;
    /*
     * The in-system SCXML invoker (adapters/invoker.c) asks the Node-API
     * layer which registered definition an invoke starts: the child nested
     * when the parent was defined, the one its content or src names, or
     * chart text it compiles (napi ADR 0024, napi_children.h). TA_OP_ERROR with `fault` saying why, TA_OP_NOMEM.
     */
    ta_op_status (*child_definition)(void *context, const tna_child_params *params);
    void *child_context;
    /*
     * The data of the error.communication a chart gets for mail to a target
     * that does not exist (napi ADR 0022): the Node-API layer makes
     * { reason, target }. False leaves the event without data.
     */
    bool (*unreachable_data)(void *context, const tna_unreachable *unreachable, ta_value *out);
    void *unreachable_context;
    /*
     * The data of the error a quarantined child's parent gets (napi ADR
     * 0025): the Node-API layer makes { code, message }, as the fault hook
     * sees them. False: no memory, so the report waits for a later turn.
     * Without the callback the event has no data.
     */
    bool (*quarantine_data)(void *context, const tna_quarantine_report *report, ta_value *out);
    void *quarantine_context;
    /* Reports to parents that core has not taken yet (tna_quarantine_report). */
    tna_vec quarantine_reports;
    /* One record per registered I/O processor type (adapters/io.h, core ADR 0068). */
    tna_vec io_processors; /* tna_io_processor * */
    /* Turn duration and timer lateness (host_metrics.h, napi ADR 0017 section 7). */
    tna_host_metrics metrics;
    /* Set while core dispatches due delayed sends: what the router is handed
     * then is a timer firing, and its lateness is recorded. */
    bool dispatching_due;
};

/* TA_ERR_NOMEM when the record or core cannot be allocated. */
ta_result tna_system_create(tna_system **out);
void tna_system_close(tna_system *system);
bool tna_system_closed(const tna_system *system);
size_t tna_system_leaked_bytes(const tna_system *system);
void tna_system_free(tna_system *system);

/*
 * Accepts a message and asks for a turn (ADR 0005). On TA_OK the system owns
 * the event's references and the message's waiter. TA_ERR_BUSY: the queue is
 * full (max_queued or max_retained); TA_ERR_NOMEM: nothing accepted.
 */
ta_result tna_system_post(tna_system *system, const tna_message *message);

/*
 * Queues an effect (effects.h), which hands over its references, and asks
 * for a turn. False when it was dropped (closing, or no memory).
 */
bool tna_system_effect(tna_system *system, const tna_effect *effect);

/* Encodes a trace record (otlp.h) and asks for a turn. */
void tna_system_trace(tna_system *system, const ta_trace_record *record);
/* Wall-clock time in nanoseconds since the Unix epoch. */
uint64_t tna_system_wall_ns(void);
/* How far behind the earliest pending delayed send is, in seconds: 0 when
 * nothing is overdue. A value that keeps growing means timers are not
 * being served. */
double tna_system_overdue_seconds(const tna_system *system);
/* A turn that began at `started_ns` (tna_monotonic_ns) ended: records how
 * long it took, with the turn's sampled macrostep as its exemplar. */
void tna_system_record_turn(tna_system *system, uint64_t started_ns);
/* A delayed send due at `due` fired now: records how late (host_metrics.h). */
void tna_system_record_lateness(tna_system *system, ta_time due, const ta_trace_parent *trace);
/*
 * A send core dispatches outside its sender's run (a timer) failed: core
 * raises error.communication in the sender and starts a macrostep for it,
 * which the scheduler cannot see (napi ADR 0022). This makes the sender
 * runnable, and asks for a turn. Nothing happens inside a run, or for a
 * sender the table does not know.
 */
void tna_system_wake_sender(tna_system *system, const ta_actor_ref *sender);
/* Installs core's log sink when JavaScript or the trace encoder wants
 * <log> records (napi ADR 0017 section 7), and the null sink otherwise. */
ta_result tna_system_refresh_log_sink(tna_system *system);
/* 64 random bits from the OS, to seed core's trace-ID generator once per
 * sink (core ADR 0073: core never reads the OS). */
uint64_t tna_system_os_seed(tna_system *system);
/*
 * Gives `context` a new trace from core's generator (core ADR 0073) when
 * tracing is on and it has none, so a delivery or spawn that brings no
 * traceparent starts a trace (napi ADR 0016 point 4). Core's sampler sets
 * the sampled flag. `detail` is kept.
 */
void tna_system_start_trace(tna_system *system, ta_trace_context *context);
/* Asks for a turn unless one is pending or the system is quiet or closed. */
void tna_system_want_turn(tna_system *system);
/*
 * Runs one turn (ADR 0007 point 1). The turn's records stay in
 * system->sched until tna_system_end_turn(), which resets the turn arena and
 * asks for the next turn when work remains.
 */
void tna_system_turn(tna_system *system);
/*
 * Cancels the send() waiter at `index` (ADR 0005 point 11). A message still
 * waiting for a load is withdrawn from the load's mailbox (napi ADR 0020),
 * as one in an actor's mailbox is; otherwise tna_sched_cancel(). True when
 * the waiter was cancelled; the caller settles and gives it back.
 */
bool tna_system_cancel(tna_system *system, uint32_t index);
void tna_system_end_turn(tna_system *system);
/*
 * No runnable or ready actors, no dead letters to report, no effects or load
 * requests waiting for JavaScript, and nothing due at core's current time
 * (ADR 0007 point 4). A load JavaScript is running does not count: flush()
 * waits for it separately (pump.c).
 */
bool tna_system_quiet(const tna_system *system);

/*
 * Chooses the clock before anything runs: `kind`, and core's time at
 * creation. TA_ERR_INVALID when the system has run or is closed.
 */
ta_result tna_system_set_clock(tna_system *system, tna_clock_kind kind, ta_time initial);
/*
 * Realtime: moves core's time to the monotonic clock, unless a core call is
 * running. Manual: nothing.
 */
void tna_system_sync_time(tna_system *system);
/*
 * Manual clock: moves core's time to `time` and asks for a turn when
 * something is due. TA_ERR_INVALID when the clock is realtime or `time` is
 * earlier than core's time; TA_ERR_BUSY inside a core call.
 */
ta_result tna_system_advance_to(tna_system *system, ta_time time);
/* A deadline may have moved earlier (a wake-up was added, napi ADR 0020):
 * ask for a turn if something is due, and arm the host timer for the rest. */
void tna_system_arm_timer(tna_system *system);
/* The host timer fired: move time, ask for a turn, and arm for what is left. */
void tna_system_timer_fired(tna_system *system);
/* The default monotonic clock (CLOCK_MONOTONIC), in nanoseconds. */
uint64_t tna_monotonic_ns(void *context);
