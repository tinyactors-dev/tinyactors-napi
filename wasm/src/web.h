/* The C layer of @tinyactors/wasm (docs/browser.md, "What is C and what is
 * JavaScript"): what its files share. Every name is ours, ta_web_*; the
 * module's exports are the functions marked TA_WEB_EXPORT, its imports the
 * functions marked TA_WEB_IMPORT, all in the module "ta_web".
 *
 * Exports take and return numbers. What does not fit in three of them
 * crosses through the environment's record (ta_web_record), an array of
 * words of the layer's own, never a struct of core's:
 *
 *   - an export reads the words it takes at its entry, before it calls
 *     anything that can call JavaScript, and writes what it gives back at
 *     its exit; JavaScript writes the words right before the call and reads
 *     the answer right after it;
 *   - an import is the same the other way round: C writes the words right
 *     before it and reads JavaScript's answer right after it.
 *
 * So a call made while another is on the stack (a handler that calls the
 * host) uses the same record without disturbing the outer one. A 64-bit
 * number is two words, the low one first. Text and bytes are a pointer and
 * a length in two words, into linear memory: what JavaScript gives is
 * copied into the call's arena (ta_web_scratch_room), what C gives is a
 * view of core's memory, valid for as long as its owner says.
 *
 * No mutable globals: the state of a module instance is its environment
 * (ta_web_env), made by ta_web_env_new, and the hosts made in it. */
#ifndef TA_WEB_H
#define TA_WEB_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "tinyactors.h"
#include "tinyactors_datamodel_ecmascript.h"
#include "tinyactors_runtime.h"

#define TA_WEB_EXPORT __attribute__((visibility("default")))
#define TA_WEB_IMPORT(name) __attribute__((import_module("ta_web"), import_name(name)))

/* ---- the record ------------------------------------------------------------- */

enum { TA_WEB_RECORD_WORDS = 64 };
typedef struct ta_web_record {
    uint32_t word[TA_WEB_RECORD_WORDS];
} ta_web_record;

/* Two words, `at` and `at + 1`, as a 64-bit number. */
uint64_t ta_web_word64(const uint32_t *word, uint32_t at);
void ta_web_set_word64(uint32_t *word, uint32_t at, uint64_t value);
/* Two words, `at` and `at + 1`, as a pointer and a length. */
ta_string_view ta_web_text_at(const uint32_t *word, uint32_t at);
void ta_web_set_text(uint32_t *word, uint32_t at, ta_string_view text);
ta_bytes ta_web_bytes_at(const uint32_t *word, uint32_t at);
void ta_web_set_bytes(uint32_t *word, uint32_t at, ta_bytes bytes);

/* ---- arenas: one per lifetime, a mark per call (AGENTS.md, "The binding's memory") */

/* A growable arena with the stack of marks JavaScript's calls take: a call
 * enters (a mark), allocates its text and records above it, and leaves (a
 * release to it), on every path; a call made while it runs enters above
 * it. A leave that empties the arena gives its chunks back when it keeps
 * more than `cap` (the addon's caps: 256 KB a host's, 64 KB the
 * environment's), so one large call does not keep its high-water mark. */
enum { TA_WEB_MARKS = 64 };
typedef struct ta_web_scratch {
    ta_growable_arena arena;
    ta_allocator view; /* ta_growable_arena_allocator(&arena): a CBOR writer grows through it */
    size_t cap;
    uint32_t depth;
    uint32_t pad;
    ta_growable_arena_mark marks[TA_WEB_MARKS];
} ta_web_scratch;

#define TA_WEB_HOST_ARENA_CAP ((size_t)256 * 1024)
#define TA_WEB_ENV_ARENA_CAP ((size_t)64 * 1024)

/* Starts `scratch` over `allocator` with its cap. */
typedef struct ta_web_scratch_config {
    const ta_allocator *allocator;
    size_t cap;
} ta_web_scratch_config;
void ta_web_scratch_init(ta_web_scratch *scratch, const ta_web_scratch_config *config);
/* A call enters (its level: 1 and up; 0 when 64 calls are open) and
 * leaves (ends what it and the calls inside it allocated); module.c. */
uint32_t ta_web_scratch_enter(ta_web_scratch *scratch);
void ta_web_scratch_leave(ta_web_scratch *scratch, uint32_t level);

/* ---- the environment: one per module instance --------------------------------- */

/* What a module instance holds (ta_web_env_new):
 *
 *   record     the call's words, first, so its address is the
 *              environment's;
 *   allocator  the module's ta_wasm_alloc and ta_wasm_free (wasi-libc's
 *              aligned_alloc and free), what every host, table, arena and
 *              compilation grows through;
 *   scratch    the arena of the module's own calls (encode, decode,
 *              compile), a mark per call;
 *   resolving  during a compilation's resolver import, its request (the
 *              compiler's scratch arena takes the resolver's text);
 *   start      during a datamodel's create or deserialize import, what it
 *              starts from (its system variables are valid then only);
 *   making     during ta_web_host_new and _restore, the host being made,
 *              which a datamodel import (a restore's chart_attach) names
 *              before JavaScript has its pointer;
 *   depth      exports on the stack, entered and left by every export that
 *              can call an import (a test reads it after a throwing import:
 *              it is back at 0). */
typedef struct ta_web_env {
    ta_web_record record;
    ta_allocator allocator;
    ta_web_scratch scratch;
    const ta_resolve_request *resolving;
    const ta_datamodel_start *start;
    struct ta_web_host *making;
    uint32_t depth;
    uint32_t pad;
} ta_web_env;

/* The allocator over ta_wasm_alloc and ta_wasm_free: the only calls of
 * them (the lint rule web-allocation-in-the-allocator). */
ta_allocator ta_web_allocator(ta_web_env *env);

/* A pointer as a word, for the record. */
uint32_t ta_web_address(const void *pointer);

/* ---- the host ---------------------------------------------------------------- */

/* The datamodels a host holds: the null datamodel only, the native
 * "ecmascript" one, whose entries call the import ta_web.datamodel
 * (datamodel.c), or core's quickjs one, in the same module (quickjs.c). */
enum { TA_WEB_DATAMODEL_NONE = 0, TA_WEB_DATAMODEL_NATIVE = 1, TA_WEB_DATAMODEL_QUICKJS = 2 };

/* The rows of a host's tables (ta_table): handles are kept, never row
 * pointers across an add. JavaScript keeps the value of a row at its slot
 * (handle - 1, low word) in an array of its own: a payload's value, a
 * session's scope, a chart's compiled functions, a loop's items, a typed
 * method's handlers. */
typedef struct ta_web_chart_row {
    const ta_image *image;
    uint32_t chart, segment, binding;
    uint32_t pad;
} ta_web_chart_row;
typedef struct ta_web_session_row {
    uint64_t chart; /* its chart's row */
} ta_web_session_row;
typedef struct ta_web_count_row {
    uint32_t count; /* a payload's references */
    uint32_t pad;
} ta_web_count_row;

/* One host (ta_web_host_new), made with the environment's allocator and
 * freed by ta_web_host_free.
 *
 *   id          JavaScript's number for it, which every import names;
 *   host        core's host;
 *   scratch     the arena of the host's calls, a mark per call;
 *   tables      payloads, sessions, charts, loops, and pending typed
 *               methods;
 *   binding     the datamodel's binding: the native one's
 *               (TA_WEB_DATAMODEL_NATIVE) or quickjs's;
 *   quickjs     quickjs's datamodel (TA_WEB_DATAMODEL_QUICKJS), freed
 *               after the host that used it;
 *   quickjs_room the last quickjs state's length: the next snapshot's
 *               guess;
 *   output      the datamodel's last output (eval_string, log, to_wire,
 *               serialize, payload_serialize, failure), grown through the
 *               allocator, valid until the datamodel's next call;
 *   evaluating  during a datamodel entry, its environment (In(), charge);
 *   xml         the arena of an XML parse's tree (txml), a mark per parse;
 *   depth       calls of the host on the stack;
 *   turning     a turn runs: a second turn is refused;
 *   batch       a take is open, from it to its ack: an output taken then
 *               joins it, one taken without opens a batch of its own;
 *   inputs      an input came since the turn's last run;
 *   retake      a take of traces (1) or logs (2) the allocator refused,
 *               retried at the next turn;
 *   acks        acks so far, bumped right after each ack: a thin view made
 *               at another count is stale;
 *   ticks_per_second  system.ticksPerSecond, read from host.config once;
 *   ticks_offset added to the ticks the clock reads (a restore's);
 *   deadline    the last idle run's next_deadline (UINT64_MAX: none);
 *   wall        the last wall time given to core: it never goes back;
 *   pool, fault the detail of the last TA_RUN_EXHAUSTED, TA_RUN_FAULT;
 *   encoder     the effective config has `telemetry`. */
typedef struct ta_web_host {
    ta_web_env *env;
    uint32_t id;
    uint32_t datamodel;
    ta_host *host;
    ta_web_scratch scratch;
    ta_table payloads, sessions, charts, loops, pending;
    ta_datamodel_binding binding;
    ta_datamodel_ecmascript *quickjs;
    size_t quickjs_room;
    ta_buffer output;
    ta_datamodel_environment *evaluating;
    ta_growable_arena xml;
    ta_growable_arena_mark xml_mark;
    void *xml_parser; /* the open parse's txml_parser, until ta_web_xml_end */
    bool xml_open;
    uint32_t depth;
    bool turning, batch, inputs;
    uint8_t retake;
    uint64_t acks;
    uint64_t ticks_per_second, ticks_offset;
    uint64_t deadline, wall;
    uint32_t pool;
    ta_status fault;
    bool encoder;
} ta_web_host;

/* What an export of a host does at its entry and exit: the depth of the
 * host and of the environment. */
void ta_web_enter(ta_web_host *host);
void ta_web_leave(ta_web_host *host);

/* An input came: a turn that is running goes on with another run. */
void ta_web_input(ta_web_host *host);

/* A payload's last reference went: its row goes, and JavaScript drops the
 * value at its slot (datamodel.c). */
void ta_web_payload_release(ta_web_host *host, ta_payload payload);

/* Ends an open XML parse (xml.c): its parser and blocks go. */
void ta_web_xml_end(ta_web_host *host);

/* quickjs's clock: the wall time the host reads now (ta_web.clock's 2, the
 * real one, whatever clock the host runs on), set before every run and
 * evaluation outside one (quickjs.c). */
void ta_web_quickjs_time(ta_web_host *host);

/* Room for the datamodel's output of at least `size` bytes (datamodel.c):
 * the host's one buffer kept between calls; 0 when the allocator refuses. */
uint32_t ta_web_dm_output(ta_web_host *host, uint32_t size);

/* The native datamodel's vtable (datamodel.c). */
const ta_datamodel_vtable *ta_web_native_vtable(void);

/* ---- imports: every one catches what JavaScript throws and answers a status ---- */

/* An effect JavaScript sees (loop.c's drain): `index` in the open batch,
 * `extra` what C found for it (a REPLY's pending slot + 1). A TRACES or
 * LOGS take goes to ta_web.output instead (TA_WEB_OUTPUT_TRACES, _LOGS),
 * its length TA_WEB_TAKE_REFUSED when the allocator refused it. */
enum { TA_WEB_TAKE_REFUSED = 0xFFFFFFFFu };
TA_WEB_IMPORT("effect") int32_t ta_web_import_effect(uint32_t host, uint32_t index, uint32_t extra);
/* A host's output taken outside a drain (metrics, a hibernation blob, a
 * snapshot, the effective config at creation, the last take of traces and
 * logs at close): its bytes in the record's words 0 and 1, copied by
 * JavaScript before the ack. `kind` is TA_WEB_OUTPUT_*. */
enum {
    TA_WEB_OUTPUT_METRICS = 1,
    TA_WEB_OUTPUT_BLOB = 2,
    TA_WEB_OUTPUT_SNAPSHOT = 3,
    TA_WEB_OUTPUT_CONFIG = 4, /* the effective config's REPLY at creation (host.config) */
    TA_WEB_OUTPUT_TRACES = 5, /* the last take at close (ta_web_host_end) */
    TA_WEB_OUTPUT_LOGS = 6
};
TA_WEB_IMPORT("output") int32_t ta_web_import_output(uint32_t host, uint32_t kind, uint32_t length);
/* The host's clocks now, in nanoseconds: `which` 0 the monotonic clock,
 * 1 the wall clock (since the Unix epoch; 0: unknown), 2 the real wall
 * clock (Date.now(), whatever clock the host runs on: what quickjs's Date
 * reads, as the addon's reads the system's). */
TA_WEB_IMPORT("clock") double ta_web_import_clock(uint32_t host, uint32_t which);
/* A static src="" a compilation asks for (compile.c): base and source in
 * the record; JavaScript answers in it. */
TA_WEB_IMPORT("resolve") int32_t ta_web_import_resolve(uint32_t compilation, uint32_t pad, uint32_t pad2);
/* An entry of the native datamodel (datamodel.c): `entry` a
 * TA_WEB_DM_*, `slot` the row it is about, the rest in the record. */
TA_WEB_IMPORT("datamodel") int32_t ta_web_import_datamodel(uint32_t host, uint32_t entry, uint32_t slot);

#endif /* TA_WEB_H */
