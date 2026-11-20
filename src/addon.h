/* The addon @tinyactors/node: what its files share. Every name is ours,
 * ta_napi_* (AGENTS.md, "Names"); the platform's names appear only where
 * Node-API requires them (module.c's NAPI_MODULE_INIT).
 *
 * State lives in the environment's instance data (ta_napi_instance, one per
 * main thread or worker; AGENTS.md, "C rules": no mutable globals) or, from
 * the host step on, on the Host. */
#ifndef TA_NAPI_ADDON_H
#define TA_NAPI_ADDON_H

#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tinyactors.h"
#include "tinyactors_datamodel_ecmascript.h"

/* What one environment holds, made at module init and freed at the
 * environment's teardown (napi_set_instance_data's finalizer).
 *
 *   allocator  malloc and free, each block reported to the engine with
 *              napi_adjust_external_memory (AGENTS.md, "The host's
 *              allocator"); its context is this instance;
 *   arena      the scratch of the module's own calls (encode): a mark at
 *              entry, a release at exit, so a nested call (a getter that
 *              calls encode) allocates above the outer one; its chunks are
 *              kept, so a warmed call allocates nothing;
 *   error      the class TinyactorsError, exported;
 *   object     Object.prototype of this environment's realm: a plain
 *              object's prototype (or null);
 *   keys       an object holding the symbols the addon keys its own
 *              properties with, which no export reaches: `handlers`, the
 *              key of a Host's handlers on its wrapper (host.c), and
 *              `clock`, the key of a SimulatedClock's state (loop.c). Node-API
 *              has no private symbols, so a plain Symbol held here is the
 *              key; a reference to an object, not to the symbol, since
 *              references to symbols need Node-API 10;
 *   turn       the function the event loop calls for a turn of a host
 *              (loop.c), given the Host as its argument: one per
 *              environment, so scheduling a turn makes no function;
 *   compiled   the class of a compile result (compile.c), made only by
 *              the compile calls;
 *   compile_error, resolve_error  the classes CompileError and
 *              ResolveError, subclasses of TinyactorsError, exported;
 *   address    the class Address, exported (address.c);
 *   send, entry  the classes of the thin views a handler gets, a Send and a
 *              LogEntry (effects.c), made only by the drain;
 *   rejected   the function a handler's promise calls when it rejects
 *              (effects.c), bound to its view: it fails an unanswered send
 *              and throws the rejection on;
 *   invocation the class of the record a service handler gets, an
 *              Invocation (effects.c), made only by the drain;
 *   crashed    the function a service's receive promise calls when it
 *              rejects (effects.c), bound to its invocation and its send:
 *              the service crashed, and the rejection goes on;
 *   settled, settled_rejected  the functions the last promise of a
 *              handler's chain calls when it settles (loop.c), bound to the
 *              Host's wrapper: the host's count of pending handler promises
 *              goes down, and a waiting idle() is given a turn at zero;
 *              settled_rejected throws the rejection on;
 *   started, start_failed  the functions a service handler's promise calls
 *              when it settles (effects.c), bound to its invocation: the
 *              service kept and the sends and UNINVOKE queued while it
 *              started given to it in order, or a failed start;
 *   vm, realm  node:vm (process.getBuiltinModule) and the vm.Script of
 *              the realm's script every context of the native datamodel
 *              runs (datamodel/realms.c), made on first use;
 *   application  the kit of the realm's script run in the application's
 *              own realm, made on first use: its `exported` copies a
 *              payload's value out to the application (datamodel/realms.c);
 *   realms     a WeakSet of those contexts' Object.prototype: a plain
 *              object of theirs is a value (values.c);
 *   in         In(), the function every context's scopes hold: it reads
 *              `evaluating`, the native datamodel whose entry runs now
 *              (NULL outside one), so it holds no pointer of its own;
 *   stringify  JSON.stringify, for <log> of an object;
 *   restoring  during Host.restore's construction of a Host (host.c), the
 *              snapshot it restores, taken by the constructor at its
 *              entry; NULL otherwise, so `new Host` restores nothing. */
typedef struct ta_napi_instance {
    napi_env env;
    ta_allocator allocator;
    ta_growable_arena arena;
    napi_ref error;  /* TinyactorsError */
    napi_ref errors; /* the error classes, TinyactorsError first (module.c) */
    napi_ref object;
    napi_ref keys;
    napi_ref turn;
    napi_ref compiled;
    napi_ref compile_error;
    napi_ref checker; /* compile.c's syntax check of a chart's ECMAScript: vm.Script, made on first use */
    napi_ref resolve_error;
    napi_ref address;
    napi_ref send, entry, migrated;
    napi_ref rejected;
    napi_ref invocation, crashed, started, start_failed;
    napi_ref settled, settled_rejected;
    napi_ref vm, realm, realms, in, stringify, application;
    struct ta_napi_native *evaluating;
    struct ta_napi_restoring *restoring;
    /* why the native datamodel's last entry failed (its vtable's failure):
     * the exception's text, set where it is cleared, forgotten when the
     * next entry opens its frame */
    bool failed;
    uint32_t failure_length;
    char failure_message[256];
} ta_napi_instance;

/* The environment's instance, or NULL (and an exception pending) before
 * module init finished. */
ta_napi_instance *ta_napi_instance_of(napi_env env);

/* The allocator every host and the module's arena grow through: malloc
 * and free, each block reported to `env`'s engine with
 * napi_adjust_external_memory, a basic-env call, so it may run in a
 * finalizer. Its context is `env` itself and nothing else, so a host's
 * finalizer frees through it whatever the instance's state at the
 * environment's teardown. */
ta_allocator ta_napi_allocator(napi_env env);

/* What an arena keeps between calls (AGENTS.md, "The binding's memory"):
 * a release to a mark that empties it (the outermost call's: nothing
 * else lives in it) gives its chunks back when it keeps more than its
 * cap, so one large call (a 2 MB encode or send) does not hold its
 * high-water mark for the lifetime's rest; under the cap the chunks stay,
 * and a warmed call calls no allocator. A release nested in a call or in
 * a run passes TA_NAPI_ARENA_UNCAPPED, as does the native datamodel's
 * scratch (txml's high-water, kept: AGENTS.md); the call's leave applies
 * the cap. */
#define TA_NAPI_HOST_ARENA_CAP ((size_t)256 * 1024)
#define TA_NAPI_INSTANCE_ARENA_CAP ((size_t)64 * 1024)
#define TA_NAPI_ARENA_UNCAPPED SIZE_MAX
void ta_napi_arena_release(ta_growable_arena *arena, ta_growable_arena_mark mark, size_t cap);

/* A function's name and length as index.d.ts declares them (the
 * parameters before a rest one, the optional ones counted, as JavaScript
 * counts them), which the wasm package's functions have as written:
 * napi_define_class and napi_define_properties make every function with
 * length 0, and a module-level one with an empty name. */
typedef struct ta_napi_arity {
    const char *name;
    uint32_t length;
} ta_napi_arity;

/* Gives each function `object` holds under a name of `arities` (a table
 * ending in {NULL, 0}) that name and its length, as a function's own are:
 * not writable, not enumerable, configurable. */
napi_status ta_napi_arities(napi_env env, napi_value object, const ta_napi_arity *arities);

/* A refusal: the message and the status core names (ta_status_name). */
typedef struct ta_napi_refusal {
    ta_status status;
    const char *message;
} ta_napi_refusal;

/* Throws a TinyactorsError with `message` and `status` set to
 * ta_status_name(refusal->status); returns NULL, for a napi_callback to
 * return. */
napi_value ta_napi_throw(napi_env env, const ta_napi_refusal *refusal);

/* An error core wrote, {"code", "message", "data": {"reason", "path"}}
 * (a refused config's, a reply's), and the status the call gave. */
typedef struct ta_napi_core_error {
    napi_value error; /* the decoded map; anything else: no code, reason, path */
    ta_status status;
} ta_napi_core_error;

/* Throws a TinyactorsError with the error's message, `code`, `reason` and
 * `path`, and `status` ta_status_name(status), none for TA_OK (a reply's
 * error); returns NULL. */
napi_value ta_napi_throw_core_error(napi_env env, const ta_napi_core_error *error);

/* ---- values.c: the value table (docs/values.md) ------------------------- */

/* Where a value is written: the CBOR writer, and the arena the call's
 * text goes to (the module's for encode, the host's for a host's call). */
typedef struct ta_napi_writing {
    ta_cbor_writer *writer;
    ta_growable_arena *arena;
    bool wire; /* the native datamodel's to_wire: values.txt's ECMAScript rules (values.c) */
    ta_status *refused; /* out, when not NULL: the refusal's status (TA_ERROR_EXECUTION: an exception) */
    bool addresses; /* encode's: an Address is tag 32 on its text */
} ta_napi_writing;

/* Writes `value` into writing->writer as the value table's CBOR. On a
 * refusal a TinyactorsError is thrown (or the exception a getter threw
 * stays pending) and the result is false; the writer is then the caller's
 * to free, its contents partial. Allocates the call's text in
 * writing->arena: the caller holds a mark around the call. */
bool ta_napi_value_write(napi_env env, napi_value value, const ta_napi_writing *writing);

/* The value of one CBOR item filling `cbor`, or NULL with a TinyactorsError
 * thrown. The bytes are read during the call only. */
napi_value ta_napi_value_read(napi_env env, ta_bytes cbor);

/* A decode that goes item by item through bytes the caller keeps for its
 * whole length: a caller reads a container's head with ta_cbor_read on
 * `reader` and the values inside it with ta_napi_decoder_next, so a large
 * document (a snapshot's rows) is never one JavaScript value. No
 * JavaScript runs while it reads (values are made, properties defined,
 * never set). */
typedef struct ta_napi_decoder {
    napi_env env;
    ta_cbor_reader reader;
    ta_napi_refusal refusal;
    bool thrown;
    bool addresses; /* decode's: tag 32 is an Address, not its text */
} ta_napi_decoder;

void ta_napi_decoder_init(ta_napi_decoder *decoder, napi_env env, ta_bytes cbor);

/* The value of the next item of the decoder's bytes, or NULL with a
 * TinyactorsError thrown. */
napi_value ta_napi_decoder_next(ta_napi_decoder *decoder);

/* A string as UTF-8 in text->arena (the copy Node-API forces), a lone
 * surrogate refused: text->view. A value that is not a string throws a
 * TypeError saying text->what; a refusal a TinyactorsError. The caller
 * holds a mark around the call. */
typedef struct ta_napi_text {
    ta_growable_arena *arena;
    const char *what;
    ta_string_view view; /* out */
} ta_napi_text;
bool ta_napi_text_of(napi_env env, napi_value value, ta_napi_text *text);

/* A block kept between calls (the native datamodel's last output): a
 * buffer grown through `allocator`, its old block freed; `view` the text
 * a call wrote into it. */
typedef struct ta_napi_room {
    ta_buffer *buffer;
    const ta_allocator *allocator;
    ta_string_view view; /* out */
} ta_napi_room;
/* At least `capacity` bytes in room->buffer, its contents not kept. */
bool ta_napi_room_grow(ta_napi_room *room, size_t capacity);
/* A string's UTF-8 in the room (room->view), a lone surrogate refused
 * (TinyactorsError TA_ERROR_INVALID); false with an exception pending. */
bool ta_napi_text_kept(napi_env env, napi_value value, ta_napi_room *room);

/* A session an input takes: a bigint from 1 to 2^64-1 or a number that is
 * a safe integer from 1; false with a TypeError for anything else. */
bool ta_napi_session_of(napi_env env, napi_value value, uint64_t *session);

/* Optional text: undefined or null is none (an empty view), a string its
 * UTF-8 in text->arena, anything else a TypeError saying text->what. */
bool ta_napi_optional_text(napi_env env, napi_value value, ta_napi_text *text);

/* The bytes of a Uint8Array (a Buffer too) or an ArrayBuffer, for the call
 * (bytes->view); false with a TypeError saying bytes->what for anything
 * else, NULL included. */
typedef struct ta_napi_bytes {
    const char *what;
    ta_bytes view; /* out */
} ta_napi_bytes;
bool ta_napi_bytes_of(napi_env env, napi_value value, ta_napi_bytes *bytes);

/* The exports encode(value) and decode(bytes). */
napi_value ta_napi_encode(napi_env env, napi_callback_info info);
napi_value ta_napi_decode(napi_env env, napi_callback_info info);
napi_value ta_napi_decode_traces(napi_env env, napi_callback_info info);

/* ---- host.c: the Host (AGENTS.md, "The binding's memory") ------------- */

/* The rows of the host's tables (ta_table, tinyactors/table.h): handles
 * are kept, never row pointers across an add. Each holds at most one
 * napi_ref, deleted before its row is removed and when the tables are
 * freed with the host (napi_delete_reference is a basic-env call). The
 * native datamodel (p1-datamodel) and the typed methods (p1-methods) fill
 * them; the host makes and frees the tables.
 *
 *   chart    a chart the native datamodel attached: its compiled
 *            functions, made lazily;
 *   session  its chart's row and its _event's string ids (24 B); its
 *            scope (or its context) is the native datamodel's `scopes`
 *            element at the row's slot, not a napi_ref;
 *   payload  a value crossing between actors: an object's napi_ref, and
 *            its reference count; a primitive is the native datamodel's
 *            `values` element at the row's slot (no napi_ref, no box);
 *   loop     a <foreach> in progress: the items it walks;
 *   pending  a typed method's message: its handlers are kept on the
 *            wrapper (never by a strong napi_ref, which would keep a host
 *            whose handlers close over it from the collector); `slot` is
 *            their place there. */
typedef struct ta_napi_chart_row {
    napi_ref functions;   /* its record (datamodel/datamodel.h) */
    const ta_image *image; /* the image it is attached from, until chart_detach */
    uint32_t chart;       /* its index in the image */
    uint32_t segment;     /* the segment that attached it (ta_datamodel_chart.segment): with
                             `chart`, what names a session's chart in a snapshot, since two
                             segments may run one image */
} ta_napi_chart_row;

/* A session's row: its chart's row (never 0 once filled), and core's ids
 * of its _event's strings (the name, the invoke's slot, the origintype:
 * TA_NIL for none), which a hibernation blob carries so a woken session
 * shares the chart's strings again. Its scope is not in the row: it is
 * element `slot` of the native datamodel's `scopes` array, the slot of the
 * row's handle, so a session holds no napi_ref of its own. */
typedef struct ta_napi_session_row {
    uint64_t chart;
    uint32_t name_id, invoke_slot, origintype_id;
} ta_napi_session_row;

typedef struct ta_napi_payload_row {
    napi_ref value; /* an object's (a function's) value; NULL: a primitive, in `values` */
    uint32_t count;
} ta_napi_payload_row;

typedef struct ta_napi_loop_row {
    napi_ref items;
} ta_napi_loop_row;

typedef struct ta_napi_pending_row {
    uint32_t slot;
    uint32_t method; /* its index in methods.c's table: a result to convert (actor.get's times) */
} ta_napi_pending_row;

/* The native "ecmascript" datamodel of a host (src/datamodel/; AGENTS.md,
 * "The native "ecmascript" datamodel"): its rows are the host's tables.
 *
 *   shared       the record [context, kit] of the host's one shared
 *                node:vm context, made on first use;
 *   scopes       an array of the sessions' scopes (a scope object, or a
 *                declaring session's own context's record), each at its
 *                row's slot (ta_table's handle: generation << 32 | slot + 1),
 *                made on first use: one napi_ref for every session;
 *   values       the payloads' values, each at its row's slot, as `scopes`
 *                for a primitive payload (an element needs no box; an object
                is a napi_ref, which costs node less per event);
 *   drops        an array holding the values whose last reference went,
 *                emptied by the flush after the outer call into core;
 *   strings      ["platform", "internal", "external", the I/O processors'
 *                types...]: _event's strings by core's ids;
 *   environment  the evaluating entry's (In() reads it);
 *   scratch      the arena of the datamodel's calls that need memory for
 *                the call only (an XML parse: txml's tree), a mark per
 *                call, its chunks kept, so a warmed parse makes no call of
 *                the host's allocator;
 *   output       the datamodel's last output (eval_string, log, to_wire,
 *                serialize, payload_serialize), valid until its next call;
 *   reason       why the last serialize refused (TA_ERROR_UNSUPPORTED: which
 *                variable, and why), "" after a success: host.hibernate's
 *                message;
 *   freeing      the host is being freed: rows go with basic-env calls
 *                only (a finalizer may be freeing it). */
struct ta_napi_host;
typedef struct ta_napi_native {
    struct ta_napi_host *host;
    napi_ref shared, scopes, values, drops, strings;
    ta_datamodel_environment *environment;
    ta_growable_arena scratch;
    ta_buffer output;
    char reason[256];
    bool freeing;
} ta_napi_native;

/* The datamodels a host can hold: one of the two "ecmascript" ones
 * (AGENTS.md, "The native "ecmascript" datamodel"). */
typedef enum ta_napi_datamodel_kind {
    TA_NAPI_DATAMODEL_NATIVE = 0,
    TA_NAPI_DATAMODEL_QUICKJS = 1,
} ta_napi_datamodel_kind;

/* One Host, wrapped by its JavaScript object (napi_wrap, type-tagged).
 * Made with the host's allocator, freed by the wrapper's finalizer; the
 * core host inside is freed by close() or, as a fallback, by the
 * finalizer.
 *
 *   env         the environment that made it: every call checks it;
 *   self        a weak reference to the wrapper, whose own property under
 *               the instance's `handlers` symbol holds the handlers;
 *   allocator   ta_napi_allocator(env), the context of every block;
 *   host        core's host; NULL once freed (`closed`);
 *   datamodels  the environment's one datamodel (core reads the list for
 *               the host's life);
 *   arena       the scratch of the host's calls, a mark per call;
 *   depth       calls of the Host on the stack (ta_napi_enter, _leave);
 *   turning     a turn is running: close() waits for its end;
 *   closing     close() was asked while a call or a turn ran;
 *   batch       a take is open, from it to its ack: an output taken then
 *               joins it, one taken without opens a batch of its own;
 *   inputs      an input came since the turn's last run: turn again;
 *   retake      a take of traces (1) or logs (2) the allocator refused:
 *               retried at the next turn (core gives no second effect);
 *   acks        acks so far, bumped right after each ta_host_effects_ack:
 *               a thin view made at another count is stale;
 *   ticks_per_second  system.ticksPerSecond, read once at creation;
 *   deadline    the last idle run's next_deadline (UINT64_MAX: none);
 *   wall        the last wall time given to core: it never goes back;
 *   pool, fault the detail of the last TA_RUN_EXHAUSTED, TA_RUN_FAULT;
 *   clock       a SimulatedClock's time (an ArrayBuffer of one uint64 of
 *               nanoseconds), or NULL: the runtime's clocks;
 *   immediate, timer  the handles of the one pending setImmediate and the
 *               one setTimeout at the deadline, or NULL; each holds the
 *               Host as its callback's argument, so a pending timer keeps
 *               it from the collector;
 *   idle        the deferred of the promise idle() returns until the next
 *               idle turn (`idle_promise`, the same to every caller);
 *   error       the turn's first error (a handler threw: any value, in a
 *               one-element array), reported after
 *               the turn;
 *   encoder     the effective config has `telemetry`;
 *   telemetry   a telemetry handler was given (the last take goes to it);
 *   endings     during the last take at close, an array of what the
 *               telemetry handler returned (its promises), for
 *               [Symbol.asyncDispose] to await; a value of the close's
 *               native call, NULL outside it;
 *   promises    the promises handlers returned (and the chains the addon
 *               made of them) that have not settled: idle() waits for none
 *               to be pending;
 *   processors  the effective config's ioProcessors, numbered from 1 as
 *               the effects' IO_PROCESSOR numbers them (0: the SCXML
 *               processor, the transport's). */
typedef struct ta_napi_host {
    napi_env env;
    ta_napi_native native;
    napi_ref self;
    ta_allocator allocator;
    ta_host *host;
    ta_napi_datamodel_kind datamodel;
    ta_datamodel_ecmascript *quickjs;
    ta_datamodel_binding datamodels[1];
    ta_growable_arena arena;
    ta_allocator arena_allocator;
    ta_table charts, sessions, payloads, loops, pending;
    uint32_t depth;
    bool turning, closing, batch, inputs;
    uint8_t retake;
    uint64_t acks;
    uint64_t ticks_per_second;
    uint64_t deadline, wall;
    uint32_t pool;
    ta_status fault;
    napi_ref clock, immediate, timer, idle_promise, error;
    napi_deferred idle;
    bool encoder, telemetry;
    napi_value endings;
    uint32_t processors;
    uint32_t promises;
    uint64_t ticks_offset; /* added to the clock's ticks (mod 2^64): a restored host goes on
                              from its snapshot's time (0 for a new host) */
    size_t quickjs_room;   /* the last quickjs state's length: the next snapshot's guess */
} ta_napi_host;

/* A call of the Host: the host and its arena's mark at entry. */
typedef struct ta_napi_call {
    ta_napi_host *host;
    ta_growable_arena_mark mark;
} ta_napi_call;

/* The Host `self` stands for, checked: its type tag (a method called on
 * another object is refused, never misread), the environment that made
 * it, and, with `open`, that it is not closed. NULL with an exception
 * pending. */
typedef struct ta_napi_host_check {
    napi_value self;
    bool open;
} ta_napi_host_check;
ta_napi_host *ta_napi_host_of(napi_env env, const ta_napi_host_check *check);

/* Enters a call of an open host (its arena's mark, depth); false with an
 * exception pending. Every enter is matched by a leave on every path. */
bool ta_napi_enter(napi_env env, napi_value self, ta_napi_call *call);
/* Releases the arena to the call's mark; the outermost call does a close
 * asked meanwhile. */
void ta_napi_leave(ta_napi_call *call);

/* A value for a session's datamodel (AGENTS.md, "The binding's memory"):
 * `value` made a payload of the datamodel of `session`'s chart, or, with
 * session 0, of `chart`'s. Undefined is no payload (0). On a quickjs host
 * it is the value's CBOR in the host's arena, read by
 * ta_datamodel_ecmascript_payload_from_cbor. False with an exception
 * pending (a session that is not there: TA_ERROR_STALE; a chart whose
 * datamodel takes no data: TypeError). */
typedef struct ta_napi_payload_for {
    uint64_t session;
    ta_host_chart_ref chart;
    napi_value value;
    ta_payload payload; /* out */
} ta_napi_payload_for;
bool ta_napi_host_payload(napi_env env, ta_napi_host *host, ta_napi_payload_for *target);
/* A payload the host refused, released: it is still ours. */
void ta_napi_host_payload_release(ta_napi_host *host, ta_payload payload);

/* Defines the class Host on `exports`. */
napi_status ta_napi_host_define(napi_env env, napi_value exports);

/* ---- datamodel/: the native "ecmascript" datamodel ----------------------- */

const ta_datamodel_vtable *ta_napi_native_vtable(void);
/* `value` copied into the shared context, a payload with one reference;
 * false with an exception pending (a value that cannot cross: TypeError). */
bool ta_napi_native_payload(ta_napi_native *native, napi_value value, ta_payload *out);
/* A payload's value itself (the row's, not a copy); undefined for none. */
napi_value ta_napi_native_value(ta_napi_native *native, ta_payload payload);
/* A payload's value as the application gets it: copied with the
 * application's realm's constructors (its arrays are Arrays there), an XML
 * node as its XML text; a primitive as it is. NULL with an exception
 * pending. */
napi_value ta_napi_native_exported(ta_napi_native *native, ta_payload payload);
/* The kit of the realm's script run in the application's realm, made once
 * per environment: what it makes is the application's (instanceof Array
 * holds there), and the compile call asks it what a script declares. NULL
 * with an exception pending. */
napi_value ta_napi_realm_application(napi_env env);
/* The drops let go: after the outer call into core returns. */
void ta_napi_native_flush(ta_napi_native *native);
/* After ta_host_free: the datamodel's own references and output, with
 * basic-env calls only. */
void ta_napi_native_free(ta_napi_native *native);
/* The datamodel's state for a host snapshot, appended to `writer` as one
 * CBOR map: the session, payload and loop tables' handle namespaces
 * (ta_table_snapshot) and every row, each value as CBOR bytes of its own
 * (the value table's), a session's chart named by its segment and index.
 * False with an exception pending: a TinyactorsError TA_ERROR_UNSUPPORTED
 * for a value outside the value table (`reason` says which) or a chart
 * whose scripts declare with let, const or class, TA_ERROR_NO_MEMORY. */
bool ta_napi_native_snapshot(ta_napi_native *native, ta_cbor_writer *writer);
/* That state back into the fresh datamodel of a restored host, whose
 * charts ta_host_restore attached: the namespaces restored, every row
 * filled at its handle. A row twice, a row the tables do not hold, or a
 * session whose chart the host lacks is refused (TinyactorsError
 * TA_ERROR_INVALID); false with the exception pending. */
bool ta_napi_native_restore(ta_napi_native *native, ta_bytes state);

/* A CBOR document the native datamodel writes into its last output
 * (to_wire, serialize, payload_serialize): opened, its values written with
 * the value table (`wire`: to_wire's mode) and its own items with
 * ta_cbor_write_*, then closed. The values' text goes into `arena` under a
 * mark the document takes at open and releases at close. */
typedef struct ta_napi_document {
    ta_napi_room room;        /* the datamodel's output, where the bytes end up */
    ta_growable_arena *arena;
    bool wire;
    ta_cbor_writer writer;    /* between open and close */
    ta_growable_arena_mark mark;
    ta_status refused;        /* out: the last refused value's status (TA_ERROR_EXECUTION: an exception) */
    ta_bytes out;             /* out, after a close that keeps: a view of the room */
} ta_napi_document;
void ta_napi_document_open(ta_napi_document *document);
/* One value appended; false with the exception pending (a TinyactorsError
 * of document->refused, or what a getter threw). */
bool ta_napi_document_value(napi_env env, napi_value value, ta_napi_document *document);
/* Closes it: with `keep`, its bytes in the room (document->out), false when
 * the writer failed (document->refused its status); without, its bytes
 * dropped. The arena is released to the document's mark either way. */
bool ta_napi_document_close(ta_napi_document *document, bool keep);

/* ---- address.c: Address (AGENTS.md, "Other systems") -------------------- */

/* Whether `value` is an Address (its type tag). */
bool ta_napi_is_address(napi_env env, napi_value value);
/* An Address of `text` (UTF-8), or NULL with an exception pending. */
napi_value ta_napi_address_new(napi_env env, ta_string_view text);
/* `value`'s text when it is an Address, else `value` itself: what an input
 * that takes an address or a string reads. */
napi_value ta_napi_address_text(napi_env env, napi_value value);
/* Defines the class Address on `exports`. */
napi_status ta_napi_address_define(napi_env env, napi_value exports);

/* ---- http.c: BasicHTTP's codec (tinyactors/basic_http.h) ---------------- */

/* encodeHTTPPost and parseHTTPRequest on `exports`. */
napi_status ta_napi_http_define(napi_env env, napi_value exports);

/* ---- compile.c: the compiler ------------------------------------------- */

/* compileCharts, compileSystem, CompileError and ResolveError on
 * `exports`; the class of a compile result in the instance. */
napi_status ta_napi_compile_define(napi_env env, napi_value exports);

/* ---- loop.c: the loop (AGENTS.md, "The loop") ----------------------------- */

/* What a drain hands each effect to. `reply` is set while the host is
 * made: the WIRE of the host.config REPLY, read before the ack. */
typedef struct ta_napi_drain_state {
    ta_napi_host *host;
    napi_value reply; /* out: the last REPLY's decoded WIRE, or NULL */
    bool bounded;     /* out: it stopped at its bound of batches */
} ta_napi_drain_state;

/* A take: the drain's state and the take's records, until the ack. */
typedef struct ta_napi_batch {
    ta_napi_drain_state *state;
    const ta_host_effect *effects;
    uint32_t count;
} ta_napi_batch;

/* The Host's wrapper; NULL when it is gone. */
napi_value ta_napi_self(napi_env env, const ta_napi_host *host);

/* One drain: take, handle every effect of the batch, ack (acks bumped
 * right after), and take again until a take is empty or the bound of
 * batches is reached, checked before a take. Never nested; a handler
 * never takes or acks. A handler's error is kept on the host (`error`). */
void ta_napi_drain(napi_env env, ta_napi_drain_state *state);

/* Keeps the pending exception as the host's error, unless one is kept
 * already (the first is reported); the exception is cleared. */
/* A handler's error: given to the host's handlerError hook, called with
 * (error, effect) where `effect` is the view or record the handler got
 * (NULL: undefined), or else kept for the turn (the first one kept). A
 * throw of the hook's own is kept. ta_napi_handler_failed takes the
 * pending exception (nothing when none is); ta_napi_handler_rejected a
 * promise's rejection, answering whether a hook took it (the exception
 * pending before it is cleared). ta_napi_keep_error is handler_failed with
 * no effect. */
typedef struct ta_napi_handler_error {
    ta_napi_host *host;
    napi_value effect;
} ta_napi_handler_error;
void ta_napi_handler_failed(napi_env env, const ta_napi_handler_error *failure);
bool ta_napi_handler_rejected(napi_env env, const ta_napi_handler_error *failure, napi_value error);
void ta_napi_keep_error(napi_env env, ta_napi_host *host);
/* Throws the kept error, cleared; false when none was kept. */
bool ta_napi_throw_kept(napi_env env, ta_napi_host *host);

/* Both clocks, converted with ticksPerSecond: before an input that
 * depends on them and at creation (a turn does it before every run). */
void ta_napi_advance(napi_env env, ta_napi_host *host);
/* A duration in nanoseconds as the host's ticks, rounded up (migrate's
 * timeout: never sooner than asked). */
uint64_t ta_napi_ticks_after(const ta_napi_host *host, uint64_t nanoseconds);
/* The host's ticks as milliseconds, on the clock host.now() reads. */
double ta_napi_milliseconds(const ta_napi_host *host, uint64_t ticks);

/* A restored host's clock goes on from `time`, its snapshot's: the ticks
 * the clock reads are offset to read `time` now, whatever the clock. */
void ta_napi_clock_resume(napi_env env, ta_napi_host *host, uint64_t time);

/* A handler returned `promise` (any thenable): it is followed, the host
 * counting it pending until it settles, so idle() waits for it. The
 * caller passes the last promise of its own chain (a send's then with its
 * rejection function), whose rejection is thrown on: an unhandled
 * rejection, as before it was followed. What is no thenable, or a then
 * that throws, is not followed (the exception cleared). */
void ta_napi_follow(napi_env env, ta_napi_host *host, napi_value promise);

/* An input from outside a turn schedules one turn (setImmediate, one
 * pending at a time); from a turn's handler it makes the turn go on. */
void ta_napi_schedule(napi_env env, ta_napi_host *host);

/* The host made with options.clock (a SimulatedClock, or undefined):
 * its time read from then on, the host held weakly by the clock. False
 * with a TypeError thrown for anything else. After the wrap. */
bool ta_napi_clock_attach(napi_env env, ta_napi_host *host, napi_value clock);

/* close()'s loop side, before the host is freed: the timers cleared, a
 * waiting idle() rejected, and with a telemetry handler trace.end and the
 * last take of traces and logs (bounded). */
void ta_napi_loop_stop(napi_env env, ta_napi_host *host);

/* ---- effects.c: the effects (AGENTS.md, "Lifetimes and thin views") ------ */

/* One effect of the open batch, in a handle scope of its own: a SEND to
 * its I/O processor's handler (or the transport's) as a thin Send view, a
 * LOG to the log handler as a LogEntry view, a MIGRATED to the migrated
 * handler as a Migrated view, a MIGRATION_DONE to migrationDone with its
 * result, a REQUEST answered in C,
 * TRACES and LOGS taken, a REPLY's WIRE kept for the caller; the rest
 * dropped. A handler's error is kept on the host (ta_napi_keep_error). */
void ta_napi_dispatch(napi_env env, const ta_napi_batch *batch, uint32_t index);

/* An OTLP request the host wrote: its signal ("traces", "logs") and the
 * host's view of its bytes, until the ack. */
typedef struct ta_napi_export {
    const char *signal;
    ta_bytes data;
} ta_napi_export;

/* Hands a request to the telemetry handler, copied once into a Buffer; a
 * handler's error is kept on the host. Without a handler, nothing. */
void ta_napi_telemetry(napi_env env, ta_napi_host *host, const ta_napi_export *export);

/* A take of traces (`traces`) or logs, handed to the telemetry handler;
 * one the allocator refused is reported once and retried at the next turn
 * (host->retake). */
void ta_napi_take(napi_env env, ta_napi_host *host, bool traces);

/* The classes Send, LogEntry and Migrated and the rejection function, in the
 * instance; nothing is exported (index.d.ts declares them as interfaces). */
napi_status ta_napi_effects_define(napi_env env, napi_value exports);

/* ---- methods.c: the typed methods (AGENTS.md, "What reaches the application") */

/* A REPLY of the open batch: a typed method's (its id a pending row's
 * handle) has its row removed and its handler called, NULL returned; a
 * stale or unknown id is dropped (NULL). The reply of a message posted with
 * id 0, the creation's host.config, is returned decoded for its caller. A
 * handler's error is kept on the host. */
napi_value ta_napi_reply(napi_env env, ta_napi_host *host, uint32_t index);

/* The typed methods (actorState ... traceSpansDecode) on the prototype of
 * `host_class`. */
napi_status ta_napi_methods_define(napi_env env, napi_value host_class);

/* host.idle(), host.now() and host.nextDeadline. */
napi_value ta_napi_host_idle(napi_env env, napi_callback_info info);
napi_value ta_napi_host_now(napi_env env, napi_callback_info info);
napi_value ta_napi_host_next_deadline(napi_env env, napi_callback_info info);

/* The turn function in the instance, the clock's symbol, and the class
 * SimulatedClock on `exports`. */
napi_status ta_napi_loop_define(napi_env env, napi_value exports);

#endif /* TA_NAPI_ADDON_H */
