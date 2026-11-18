/* A host: its creation and free, and the inputs, each built from the
 * record's words into core's structs (web.h). */
#include "web.h"

#include <string.h>

/* ---- depth and inputs ------------------------------------------------------------ */

void ta_web_enter(ta_web_host *host) {
    host->depth++;
    host->env->depth++;
}

void ta_web_leave(ta_web_host *host) {
    host->depth--;
    host->env->depth--;
}

void ta_web_input(ta_web_host *host) { host->inputs = true; }

/* ---- the effective config, read once ----------------------------------------------- */

/* What the effective config tells the layer: system.ticksPerSecond and
 * whether an encoder runs (`telemetry`), from the REPLY of host.config
 * posted at creation, the only effect then; read with core's decoder into
 * the host's arena. The reply's bytes go to JavaScript too (ta_web.output,
 * TA_WEB_OUTPUT_CONFIG), which reads the I/O processors from them; an
 * error there refuses the creation (TA_ERROR_STATE). */
static ta_status ta_web_read_config(ta_web_host *host) {
    static const unsigned char message[] = {0xa2, 0x66, 'm', 'e', 't', 'h', 'o', 'd', 0x6b, 'h', 'o', 's', 't', '.',
                                            'c', 'o', 'n', 'f', 'i', 'g', 0x62, 'i', 'd', 0x00};
    ta_status status = ta_host_post(host->host, (ta_bytes){message, sizeof message});
    if (status != TA_OK) return status;
    const ta_host_effect *effects = NULL;
    uint32_t n = ta_host_effects(host->host, &effects);
    status = TA_ERROR_STATE;
    uint32_t level = ta_web_scratch_enter(&host->scratch);
    for (uint32_t i = 0; i < n; i++) {
        if (ta_host_effect_number(host->host, i, TA_EFFECT_FIELD_KIND) != TA_HOST_EFFECT_REPLY) continue;
        ta_cbor_document document = {ta_host_effect_bytes(host->host, i, TA_EFFECT_FIELD_WIRE), NULL, 0, 0};
        if (ta_cbor_decode(&document) != TA_ERROR_NO_MEMORY) break;
        document.tokens = (ta_cbor_token *)ta_growable_arena_alloc(&host->scratch.arena, sizeof(ta_cbor_token) * document.count, 8);
        document.capacity = document.count;
        if (document.tokens == NULL) {
            status = TA_ERROR_NO_MEMORY;
            break;
        }
        if (ta_cbor_decode(&document) != TA_OK) break;
        /* JavaScript reads the rest of it (the I/O processors' types) before the ack */
        ta_bytes wire = ta_host_effect_bytes(host->host, i, TA_EFFECT_FIELD_WIRE);
        ta_web_set_bytes(host->env->record.word, 0, wire);
        if (ta_web_import_output(host->id, TA_WEB_OUTPUT_CONFIG, (uint32_t)wire.length) != TA_OK) break;
        uint32_t result = ta_cbor_member(&document, 0, ta_string("result"));
        uint32_t system = result == TA_NIL ? TA_NIL : ta_cbor_member(&document, result, ta_string("system"));
        uint32_t rate = system == TA_NIL ? TA_NIL : ta_cbor_member(&document, system, ta_string("ticksPerSecond"));
        if (rate == TA_NIL || document.tokens[rate].kind != TA_CBOR_UINT || document.tokens[rate].value == 0) break;
        host->ticks_per_second = document.tokens[rate].value;
        host->encoder = ta_cbor_member(&document, result, ta_string("telemetry")) != TA_NIL;
        status = TA_OK;
        break;
    }
    ta_web_scratch_leave(&host->scratch, level);
    if (n > 0) {
        ta_host_effects_ack(host->host);
        host->acks++;
    }
    return status;
}

/* ---- creation and free ---------------------------------------------------------------- */

static void ta_web_tables_init(ta_web_host *host) {
    const ta_allocator *allocator = &host->env->allocator;
    ta_table_init(&host->payloads, &(ta_table_config){sizeof(ta_table_config), sizeof(ta_web_count_row), allocator});
    ta_table_init(&host->sessions, &(ta_table_config){sizeof(ta_table_config), sizeof(ta_web_session_row), allocator});
    ta_table_init(&host->charts, &(ta_table_config){sizeof(ta_table_config), sizeof(ta_web_chart_row), allocator});
    ta_table_init(&host->loops, &(ta_table_config){sizeof(ta_table_config), sizeof(ta_web_count_row), allocator});
    ta_table_init(&host->pending, &(ta_table_config){sizeof(ta_table_config), sizeof(ta_web_count_row), allocator});
}

static void ta_web_host_release(ta_web_host *host) {
    ta_web_xml_end(host);
    if (host->host != NULL) ta_host_free(host->host);
    host->host = NULL;
    if (host->quickjs != NULL) ta_datamodel_ecmascript_free(host->quickjs); /* after the host that used it */
    host->quickjs = NULL;
    ta_table_free(&host->payloads);
    ta_table_free(&host->sessions);
    ta_table_free(&host->charts);
    ta_table_free(&host->loops);
    ta_table_free(&host->pending);
    if (host->output.pointer != NULL) host->env->allocator.free(host->env->allocator.context, host->output.pointer, host->output.capacity);
    host->output = (ta_buffer){NULL, 0, 0};
    ta_growable_arena_free(&host->xml);
    ta_growable_arena_free(&host->scratch.arena);
}

/* What a new host is made from: the record's words, read at the entry of
 * ta_web_host_new or ta_web_host_restore, before anything can call
 * JavaScript. `pack` is set for a restore. */
typedef struct ta_web_making {
    ta_bytes config;
    uint32_t id, datamodel;
    ta_buffer error;
    ta_bytes pack;
    uint64_t nonce; /* ta_host_environment's: JavaScript's random bits (a restore ignores it) */
    ta_datamodel_ecmascript_config quickjs; /* the sandbox's limits, with TA_WEB_DATAMODEL_QUICKJS */
} ta_web_making;

/* A byte count of two words as a size_t: a count past wasm32's 4 GiB is
 * no limit the module can reach, so it is the largest one. */
static size_t ta_web_size_at(const uint32_t *word, uint32_t at) {
    uint64_t n = ta_web_word64(word, at);
    return n > SIZE_MAX ? SIZE_MAX : (size_t)n;
}

/* The most of the module's shadow stack (TA_WEB_STACK_SIZE, wasm-ld's -z
 * stack-size, mise/wasm.rb) quickjs may use: what the host's own frames
 * leave, 128 KiB kept for them (the deepest measured is 65,768 B,
 * docs/log.xml l-p5-pack-oz). quickjs bounds its recursion by its stack
 * limit below the stack pointer where an evaluation starts, and takes no
 * limit at all when that would pass the stack's bottom (quickjs.c,
 * update_stack_limit), so its default of 1 MiB would let a deep recursion
 * run off the stack and trap. A stackLimit of 0 or above this is this
 * (docs/log.xml, l-p5-quickjs-stack). */
#define TA_WEB_QUICKJS_STACK ((size_t)TA_WEB_STACK_SIZE - (size_t)128 * 1024)

/* The quickjs option from the record: 10 maxOps, 11-12 memoryLimit, 13-14
 * stackLimit, 15 realm (TA_DATAMODEL_ECMASCRIPT_REALM_*), each 0 for
 * core's default (JavaScript checked them as the addon does), the stack's
 * at most TA_WEB_QUICKJS_STACK. */
static ta_datamodel_ecmascript_config ta_web_quickjs_config(const uint32_t *word) {
    ta_datamodel_ecmascript_config config;
    memset(&config, 0, sizeof config);
    config.size = sizeof config;
    config.max_ops = word[10];
    config.memory_limit = ta_web_size_at(word, 11);
    config.stack_limit = ta_web_size_at(word, 13);
    if (config.stack_limit == 0 || config.stack_limit > TA_WEB_QUICKJS_STACK) config.stack_limit = TA_WEB_QUICKJS_STACK;
    config.realm = word[15];
    return config;
}

/* The label of the datamodel state the layer packs: the package's own. A
 * snapshot is the host's memory, laid out for the build that made it
 * (core's docs/durability.md: "valid for the same build of the library
 * only"), and the addon's is a 64-bit build's, so the two packages label
 * their packs apart and each refuses the other's by its label, naming it;
 * actors cross between them as hibernation blobs (docs/guide/browser.md). */
static const char ta_web_snapshot_label[] = "tinyactors-wasm";
static const char ta_web_addon_label[] = "tinyactors-napi";

/* A restore's core: the pack unpacked (its label checked), its images, and
 * ta_host_restore with `environment`; the contents kept for JavaScript. A
 * pack another program labelled is TA_ERROR_INVALID, with the record's
 * word 2 set so the message can say why: 1 another program's, 2 the
 * addon's. */
typedef struct ta_web_unpacked {
    const ta_host_environment *environment;
    ta_host_snapshot_contents contents;
    uint32_t foreign;
} ta_web_unpacked;

static ta_status ta_web_restore_core(ta_web_host *host, const ta_web_making *making, ta_web_unpacked *unpacked) {
    ta_host_snapshot_contents *contents = &unpacked->contents;
    memset(contents, 0, sizeof *contents);
    contents->size = sizeof *contents;
    ta_status status = ta_host_snapshot_unpack(making->pack, contents);
    if (status != TA_OK) return status;
    if (contents->datamodel.length != sizeof ta_web_snapshot_label - 1 ||
        memcmp(contents->datamodel.pointer, ta_web_snapshot_label, contents->datamodel.length) != 0) {
        bool addon = contents->datamodel.length == sizeof ta_web_addon_label - 1 &&
                     memcmp(contents->datamodel.pointer, ta_web_addon_label, contents->datamodel.length) == 0;
        unpacked->foreign = addon ? 2u : 1u; /* its datamodel's state is not ours */
        return TA_ERROR_INVALID;
    }
    uint32_t level = ta_web_scratch_enter(&host->scratch);
    ta_bytes *images = contents->image_count
                           ? (ta_bytes *)ta_growable_arena_alloc(&host->scratch.arena, sizeof(ta_bytes) * contents->image_count, 8)
                           : NULL;
    if (contents->image_count && images == NULL) status = TA_ERROR_NO_MEMORY;
    for (uint32_t i = 0; status == TA_OK && i < contents->image_count; i++) images[i] = ta_host_snapshot_image(making->pack, i);
    if (status == TA_OK) {
        ta_host_snapshot_input input = {making->config, {contents->host, contents->host_length}, images, contents->image_count, 0};
        status = ta_host_restore(unpacked->environment, &input, &host->host);
        if (status != TA_OK) host->host = NULL;
    }
    ta_web_scratch_leave(&host->scratch, level);
    return status;
}

/* A new host, made (ta_host_create) or restored (ta_host_restore of a
 * pack), then its effective config read; the answer in the record: word 0
 * the status, word 1 the length of the refused config's error written
 * into its room (or the room it needs, beyond its capacity). */
static ta_web_host *ta_web_host_make(ta_web_env *env, const ta_web_making *making) {
    ta_web_record *record = &env->record;
    ta_buffer error = making->error;
    ta_web_host *host = (ta_web_host *)env->allocator.alloc(env->allocator.context, sizeof *host, 8);
    record->word[1] = 0;
    if (host == NULL) {
        record->word[0] = (uint32_t)TA_ERROR_NO_MEMORY;
        return NULL;
    }
    memset(host, 0, sizeof *host);
    host->env = env;
    host->id = making->id;
    host->datamodel = making->datamodel == TA_WEB_DATAMODEL_NATIVE || making->datamodel == TA_WEB_DATAMODEL_QUICKJS
                          ? making->datamodel
                          : TA_WEB_DATAMODEL_NONE;
    host->deadline = UINT64_MAX;
    ta_web_scratch_init(&host->scratch, &(ta_web_scratch_config){&env->allocator, TA_WEB_HOST_ARENA_CAP});
    ta_growable_arena_init(&host->xml, &(ta_growable_arena_config){sizeof(ta_growable_arena_config), 0, 0, &env->allocator});
    ta_web_tables_init(host);
    host->binding = (ta_datamodel_binding){ta_web_native_vtable(), host};
    if (host->datamodel == TA_WEB_DATAMODEL_QUICKJS) {
        host->quickjs = ta_datamodel_ecmascript_new(&making->quickjs);
        if (host->quickjs == NULL) {
            record->word[0] = (uint32_t)TA_ERROR_NO_MEMORY;
            ta_web_host_release(host);
            env->allocator.free(env->allocator.context, host, sizeof *host);
            return NULL;
        }
        host->binding = ta_datamodel_ecmascript_binding(host->quickjs);
        ta_web_quickjs_time(host);
    }
    ta_host_environment environment = {sizeof environment, host->datamodel != TA_WEB_DATAMODEL_NONE ? 1u : 0u,
                                       &host->binding, env->allocator, NULL, error.pointer != NULL ? &error : NULL,
                                       making->nonce};
    ta_web_enter(host);
    struct ta_web_host *outer = env->making;
    env->making = host;
    ta_status status;
    ta_web_unpacked unpacked = {&environment, {0}, 0};
    if (making->pack.pointer == NULL) status = ta_host_create(making->config, &environment, &host->host);
    else status = ta_web_restore_core(host, making, &unpacked);
    if (status == TA_OK) status = ta_web_read_config(host);
    env->making = outer;
    ta_web_leave(host);
    record->word[0] = (uint32_t)status;
    record->word[1] = (uint32_t)error.length;
    if (making->pack.pointer != NULL) { /* what JavaScript checks of the restore: views of the pack */
        record->word[2] = unpacked.foreign;
        ta_web_set_word64(record->word, 3, unpacked.contents.time);
        ta_web_set_text(record->word, 5, unpacked.contents.system_id);
        ta_web_set_bytes(record->word, 7, (ta_bytes){unpacked.contents.state, unpacked.contents.state_length});
    }
    if (status != TA_OK) {
        ta_web_host_release(host);
        env->allocator.free(env->allocator.context, host, sizeof *host);
        return NULL;
    }
    return host;
}

/* A new host. Record: words 0-1 the config's CBOR, 2 JavaScript's id for
 * it, 3 its datamodel (TA_WEB_DATAMODEL_*), 4-5 room for the refused
 * config's error (a pointer and a capacity; 0 for none), 6-7 random bits
 * for the host's identity (ta_host_environment.nonce), 10-15 the quickjs
 * option with TA_WEB_DATAMODEL_QUICKJS (ta_web_quickjs_config). Answers the host,
 * or 0; the record's word 0 is the status, word 1 the length of the error
 * written into the room (or the room it needs, beyond its capacity). */
TA_WEB_EXPORT ta_web_host *ta_web_host_new(ta_web_env *env) {
    const uint32_t *word = env->record.word;
    ta_web_making making = {ta_web_bytes_at(word, 0), word[2], word[3], {(unsigned char *)(uintptr_t)word[4], word[5], 0}, {NULL, 0},
                            ta_web_word64(word, 6), ta_web_quickjs_config(word)};
    return ta_web_host_make(env, &making);
}

/* Host.restore: a new host running a pack of ta_host_snapshot_pack.
 * Record: as ta_web_host_new's (10-15 the quickjs option), and 6-7 the pack (8-aligned: JavaScript
 * copies it into the call's arena). Answers the host, or 0; the record:
 * 0 the status, 1 the error's length, 2 whether the pack is another
 * program's, 3-4 the host's time when it was packed, 5-6 its system id,
 * 7-8 its datamodels' state (views of the pack). */
TA_WEB_EXPORT ta_web_host *ta_web_host_restore(ta_web_env *env) {
    const uint32_t *word = env->record.word;
    ta_web_making making = {ta_web_bytes_at(word, 0), word[2], word[3], {(unsigned char *)(uintptr_t)word[4], word[5], 0},
                            ta_web_bytes_at(word, 6), 0, ta_web_quickjs_config(word)};
    if (making.pack.pointer == NULL) making.pack.pointer = (const unsigned char *)""; /* an empty pack: core refuses it */
    return ta_web_host_make(env, &making);
}

/* Frees the host and everything it holds; not from inside a call of it
 * (TA_ERROR_STATE: JavaScript defers a close() asked from a handler to the
 * end of the turn). */
TA_WEB_EXPORT int32_t ta_web_host_free(ta_web_host *host) {
    if (host == NULL) return TA_OK;
    if (host->depth > 0 || host->turning) return TA_ERROR_STATE;
    ta_web_env *env = host->env;
    ta_web_host_release(host);
    env->allocator.free(env->allocator.context, host, sizeof *host);
    return TA_OK;
}

TA_WEB_EXPORT ta_web_scratch *ta_web_host_scratch(ta_web_host *host) { return &host->scratch; }
/* The host ta_web_host_new or _restore is making, during it (0 outside). */
TA_WEB_EXPORT ta_web_host *ta_web_host_making(ta_web_env *env) { return env->making; }
TA_WEB_EXPORT uint32_t ta_web_host_depth(const ta_web_host *host) { return host->depth; }
/* The acks so far, as a double (exact to 2^53): a thin view made at
 * another count is stale. */
TA_WEB_EXPORT double ta_web_host_acks(const ta_web_host *host) { return (double)host->acks; }
TA_WEB_EXPORT double ta_web_host_ticks_per_second(const ta_web_host *host) { return (double)host->ticks_per_second; }
TA_WEB_EXPORT uint32_t ta_web_host_encoder(const ta_web_host *host) { return host->encoder; }
/* The datamodel's binding count for a restore, and the like: which one it holds. */
TA_WEB_EXPORT uint32_t ta_web_host_datamodel(const ta_web_host *host) { return host->datamodel; }

/* ---- segments and charts ------------------------------------------------------------- */

/* Record: words 0-1 the image's bytes. Answers [status, segment]. */
TA_WEB_EXPORT int32_t ta_web_host_add_image(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_bytes image = ta_web_bytes_at(record->word, 0);
    uint32_t segment = 0;
    ta_web_enter(host);
    ta_status status = ta_host_add_image(host->host, image, &segment);
    ta_web_leave(host);
    record->word[0] = (uint32_t)status;
    record->word[1] = segment;
    return status;
}

/* Record: words 0-1 the chart's name. Answers [status, segment, chart]. */
TA_WEB_EXPORT int32_t ta_web_host_chart(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_host_chart_ref ref = {0, 0};
    ta_status status = ta_host_chart(host->host, ta_web_text_at(record->word, 0), &ref);
    record->word[0] = (uint32_t)status;
    record->word[1] = ref.segment;
    record->word[2] = ref.chart;
    return status;
}

TA_WEB_EXPORT int32_t ta_web_host_boot(ta_web_host *host, uint32_t segment) {
    ta_web_enter(host);
    ta_status status = ta_host_boot(host->host, segment);
    ta_web_leave(host);
    if (status == TA_OK) ta_web_input(host);
    return status;
}

/* ---- actors ---------------------------------------------------------------------------- */

/* Record: 0 segment, 1 chart, 2-3 name, 4-5 params (a payload handle, 0:
 * none), 6-7 traceparent. Answers [status, session (2 words)]. The params
 * move to core on success and are released on a refusal. */
TA_WEB_EXPORT int32_t ta_web_host_spawn(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_spawn spawn = {record->word[0], record->word[1], ta_web_text_at(record->word, 2), ta_web_word64(record->word, 4),
                      ta_web_text_at(record->word, 6)};
    uint64_t session = 0;
    ta_web_enter(host);
    ta_status status = ta_host_spawn(host->host, &spawn, &session);
    if (status != TA_OK && spawn.params != 0) ta_web_payload_release(host, spawn.params);
    ta_web_leave(host);
    if (status == TA_OK) ta_web_input(host);
    record->word[0] = (uint32_t)status;
    ta_web_set_word64(record->word, 1, session);
    return status;
}

/* An event's words, from `at` (TA_WEB_EVENT_WORDS of them): session (2),
 * flags, token, name (2), sendid (2), origin (2), origintype (2), data (a
 * payload handle, 2), raw (2), traceparent (2), trace_flags. */
enum { TA_WEB_EVENT_WORDS = 19 };
static ta_event_in ta_web_event_at(const uint32_t *word) {
    ta_event_in event;
    memset(&event, 0, sizeof event);
    event.size = sizeof event;
    event.session = ta_web_word64(word, 0);
    event.flags = word[2];
    event.token = word[3];
    event.name = ta_web_text_at(word, 4);
    event.sendid = ta_web_text_at(word, 6);
    event.origin = ta_web_text_at(word, 8);
    event.origintype = ta_web_text_at(word, 10);
    event.data = ta_web_word64(word, 12);
    event.raw = ta_web_text_at(word, 14);
    event.traceparent = ta_web_text_at(word, 16);
    event.trace_flags = word[18];
    return event;
}

/* Record: an event's words from 0. Answers [status]. The data moves to
 * core on success and is released on a refusal. */
TA_WEB_EXPORT int32_t ta_web_host_send(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_event_in event = ta_web_event_at(record->word);
    ta_web_enter(host);
    ta_status status = ta_host_send(host->host, &event);
    if (status != TA_OK && event.data != 0) ta_web_payload_release(host, event.data);
    ta_web_leave(host);
    if (status == TA_OK) ta_web_input(host);
    record->word[0] = (uint32_t)status;
    return status;
}

/* Record: 0 the address of `count` events' words in the call's arena
 * (TA_WEB_EVENT_WORDS each, as ta_web_host_send takes them), 1 count.
 * Answers [accepted, the refusal's status]: the length of the accepted
 * prefix; the data of every event not accepted is released. The core
 * structs are made in the host's arena, above the call's mark. */
TA_WEB_EXPORT uint32_t ta_web_host_send_many(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    const uint32_t *words = (const uint32_t *)(uintptr_t)record->word[0];
    uint32_t count = record->word[1], accepted = 0;
    record->word[1] = TA_OK;
    if (count == 0) {
        record->word[0] = 0;
        return 0;
    }
    ta_event_in *events = (ta_event_in *)ta_growable_arena_alloc(&host->scratch.arena, sizeof *events * count, 8);
    if (events == NULL) {
        record->word[0] = 0;
        record->word[1] = (uint32_t)TA_ERROR_NO_MEMORY;
        return 0;
    }
    for (uint32_t i = 0; i < count; i++) events[i] = ta_web_event_at(words + i * TA_WEB_EVENT_WORDS);
    ta_web_enter(host);
    accepted = ta_host_send_many(host->host, events, count);
    ta_status status = TA_OK;
    if (accepted < count) {
        ta_event_in again = events[accepted];
        status = ta_host_send(host->host, &again); /* the refusal's status: the same event, refused again */
        if (status == TA_OK) accepted++;
        for (uint32_t i = accepted; i < count; i++)
            if (events[i].data != 0) ta_web_payload_release(host, events[i].data);
    }
    ta_web_leave(host);
    if (accepted > 0) ta_web_input(host);
    record->word[0] = accepted;
    record->word[1] = (uint32_t)status;
    return accepted;
}

TA_WEB_EXPORT int32_t ta_web_host_terminate(ta_web_host *host, uint32_t low, uint32_t high) {
    ta_web_enter(host);
    ta_status status = ta_host_terminate(host->host, (uint64_t)low | (uint64_t)high << 32);
    ta_web_leave(host);
    if (status == TA_OK) ta_web_input(host);
    return status;
}

/* Record: words 0-1 a name. Answers [session (2 words)], 0 for none. */
TA_WEB_EXPORT void ta_web_host_actor_by_name(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_web_set_word64(record->word, 0, ta_host_actor_by_name(host->host, ta_web_text_at(record->word, 0)));
}

/* Record: words 0-1 an address. Answers [status, session (2 words)]. */
TA_WEB_EXPORT int32_t ta_web_host_resolve(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    uint64_t session = 0;
    ta_status status = ta_host_resolve(host->host, ta_web_text_at(record->word, 0), &session);
    record->word[0] = (uint32_t)status;
    ta_web_set_word64(record->word, 1, session);
    return status;
}

/* ---- the control plane ------------------------------------------------------------------- */

/* A typed method's row in the pending table, whose handle is the message's
 * id: answers its slot + 1, the handle in the record's words 0-1; 0 when
 * the allocator refuses. JavaScript keeps the method's handlers at the
 * slot. */
TA_WEB_EXPORT uint32_t ta_web_pending_add(ta_web_host *host) {
    uint64_t handle = 0;
    if (ta_table_add(&host->pending, &handle) == NULL) return 0;
    ta_web_set_word64(host->env->record.word, 0, handle);
    return (uint32_t)handle;
}

/* A pending row whose message was never posted (its params could not be
 * written): it goes. */
TA_WEB_EXPORT void ta_web_pending_remove(ta_web_host *host, uint32_t low, uint32_t high) {
    ta_table_remove(&host->pending, (uint64_t)low | (uint64_t)high << 32);
}

/* Record: words 0-1 the message's CBOR, 2-3 its pending row's handle (0:
 * none, a message with no id). Answers the status; the row goes on a
 * refusal. */
TA_WEB_EXPORT int32_t ta_web_host_post(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_bytes message = ta_web_bytes_at(record->word, 0);
    uint64_t pending = ta_web_word64(record->word, 2);
    ta_web_enter(host);
    ta_status status = ta_host_post(host->host, message);
    ta_web_leave(host);
    if (status != TA_OK && pending != 0) ta_table_remove(&host->pending, pending);
    if (status == TA_OK) ta_web_input(host);
    return status;
}

/* ---- outputs: taken, copied by JavaScript, acknowledged ------------------------------------- */

/* Gives an output to JavaScript (ta_web.output), which copies it: with a
 * batch open (a handler's call) it joins that batch; with none it opened
 * a batch of its own, acknowledged here. The status the import answered. */
typedef struct ta_web_taken {
    uint32_t kind;
    ta_bytes bytes;
} ta_web_taken;

static int32_t ta_web_give(ta_web_host *host, const ta_web_taken *taken) {
    bool own = !host->batch;
    ta_web_set_bytes(host->env->record.word, 0, taken->bytes);
    int32_t answered = ta_web_import_output(host->id, taken->kind, (uint32_t)taken->bytes.length);
    if (own) {
        ta_host_effects_ack(host->host);
        host->acks++;
    }
    return answered;
}

/* host.metrics(): the ExportMetricsServiceRequest, given to ta_web.output. */
TA_WEB_EXPORT int32_t ta_web_host_metrics(ta_web_host *host) {
    ta_bytes bytes;
    ta_web_enter(host);
    ta_status status = ta_host_metrics(host->host, &bytes);
    if (status == TA_OK && ta_web_give(host, &(ta_web_taken){TA_WEB_OUTPUT_METRICS, bytes}) != TA_OK) status = TA_ERROR_NO_MEMORY;
    ta_web_leave(host);
    return status;
}

/* host.hibernate(session): the blob, given to ta_web.output; a blob
 * JavaScript could not copy is woken back from the view before the ack. */
TA_WEB_EXPORT int32_t ta_web_host_hibernate(ta_web_host *host, uint32_t low, uint32_t high) {
    uint64_t session = (uint64_t)low | (uint64_t)high << 32;
    ta_bytes blob;
    ta_web_enter(host);
    ta_status status = ta_host_hibernate(host->host, session, &blob);
    if (status == TA_OK) {
        bool own = !host->batch;
        ta_web_set_bytes(host->env->record.word, 0, blob);
        if (ta_web_import_output(host->id, TA_WEB_OUTPUT_BLOB, (uint32_t)blob.length) != TA_OK) {
            ta_host_wake(host->host, session, blob); /* the actor stays resident */
            status = TA_ERROR_NO_MEMORY;
        }
        if (own) {
            ta_host_effects_ack(host->host);
            host->acks++;
        }
    }
    ta_web_leave(host);
    return status;
}

/* Record: 0-1 the session, 2-3 its blob. */
TA_WEB_EXPORT int32_t ta_web_host_wake(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    uint64_t session = ta_web_word64(record->word, 0);
    ta_bytes blob = ta_web_bytes_at(record->word, 2);
    ta_web_enter(host);
    ta_status status = ta_host_wake(host->host, session, blob);
    ta_web_leave(host);
    if (status == TA_OK) ta_web_input(host);
    return status;
}

/* Record: 0 max_scan, 1 the room for at most word 2 sessions (8 bytes
 * each, in the call's arena). Answers how many it wrote. */
TA_WEB_EXPORT uint32_t ta_web_host_sweep(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    uint32_t max_scan = record->word[0];
    ta_uint64_array out = {(uint64_t *)(uintptr_t)record->word[1], record->word[2]};
    return ta_host_sweep(host->host, max_scan, out);
}

/* Record: 0-1 a chart's name (empty: every chart), 2-3 a session (0: all),
 * 4 flags (TA_HOST_MIGRATE_*), 5-6 the timeout in ticks. Answers [status,
 * the migration's id]. */
TA_WEB_EXPORT int32_t ta_web_host_migrate(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_host_migration request = {ta_web_text_at(record->word, 0), ta_web_word64(record->word, 2), record->word[4], 0,
                                 ta_web_word64(record->word, 5)};
    uint32_t migration = 0;
    ta_web_enter(host);
    ta_status status = ta_host_migrate(host->host, &request, &migration);
    ta_web_leave(host);
    if (status == TA_OK) ta_web_input(host);
    record->word[0] = (uint32_t)status;
    record->word[1] = migration;
    return status;
}

/* host.snapshot(): record 0-1 the datamodel's label, 2-3 its state; the
 * pack written once into the host's arena (its probed size), given to
 * ta_web.output, the arena's block gone at the call's leave. */
TA_WEB_EXPORT int32_t ta_web_host_snapshot(ta_web_host *host) {
    ta_web_record *record = &host->env->record;
    ta_datamodel_state state = {ta_web_text_at(record->word, 0), ta_web_bytes_at(record->word, 2)};
    ta_buffer probe = {NULL, 0, 0};
    ta_web_enter(host);
    ta_status status = ta_host_snapshot_pack(host->host, &state, &probe);
    if (status == TA_ERROR_NO_MEMORY && probe.length > 0) {
        uint32_t level = ta_web_scratch_enter(&host->scratch);
        ta_buffer out = {(unsigned char *)ta_growable_arena_alloc(&host->scratch.arena, probe.length, 8), probe.length, 0};
        status = out.pointer == NULL ? TA_ERROR_NO_MEMORY : ta_host_snapshot_pack(host->host, &state, &out);
        if (status == TA_OK) {
            ta_web_set_bytes(record->word, 0, (ta_bytes){out.pointer, out.length});
            if (ta_web_import_output(host->id, TA_WEB_OUTPUT_SNAPSHOT, (uint32_t)out.length) != TA_OK) status = TA_ERROR_NO_MEMORY;
        }
        ta_web_scratch_leave(&host->scratch, level);
    }
    ta_web_leave(host);
    return status;
}

/* Whether the host is quiescent for a snapshot (ta_host_snapshot with an
 * empty buffer: TA_ERROR_NO_MEMORY is only its room), checked before any
 * datamodel state is built: TA_ERROR_STATE from a handler, with an effect
 * or a reply pending, or during a migration. */
TA_WEB_EXPORT int32_t ta_web_host_quiescent(ta_web_host *host) {
    ta_buffer quiet = {NULL, 0, 0};
    ta_status status = ta_host_snapshot(host->host, &quiet);
    return status == TA_ERROR_NO_MEMORY ? TA_OK : status;
}

/* ---- lookups --------------------------------------------------------------------------- */

/* Whether `session` lives (ta_host_locate): an answer to a send whose
 * sender ended has nobody to tell. */
TA_WEB_EXPORT int32_t ta_web_host_locate(ta_web_host *host, uint32_t low, uint32_t high) {
    ta_host_location location;
    return ta_host_locate(host->host, (uint64_t)low | (uint64_t)high << 32, &location);
}

/* The chart a value would be a payload for, and whether its datamodel is
 * "ecmascript" (the one that takes data): record 0-1 a session (0: the
 * chart of words 2-3 instead), 2 a segment, 3 a chart. Answers 1 when it
 * takes data, 0 when not, TA_ERROR_STALE for a session that does not
 * live. */
TA_WEB_EXPORT int32_t ta_web_host_takes_data(ta_web_host *host) {
    const uint32_t *word = host->env->record.word;
    uint64_t session = ta_web_word64(word, 0);
    ta_host_chart_ref chart = {word[2], word[3]};
    if (session != 0) {
        ta_host_location location;
        if (ta_host_locate(host->host, session, &location) != TA_OK) return TA_ERROR_STALE;
        ta_system *system = ta_host_system(host->host, location.segment);
        ta_actor_info info;
        memset(&info, 0, sizeof info);
        info.size = sizeof info;
        if (system == NULL || ta_actor_info_get(system, location.actor, &info) != TA_OK) return TA_ERROR_STALE;
        chart = (ta_host_chart_ref){location.segment, info.chart};
    }
    ta_host_segment_info segment;
    memset(&segment, 0, sizeof segment);
    segment.size = sizeof segment;
    if (ta_host_segment_info_get(host->host, chart.segment, &segment) != TA_OK || segment.image == NULL) return 0;
    ta_string_view datamodel = ta_image_chart_datamodel(segment.image, chart.chart);
    return datamodel.length == 10 && memcmp(datamodel.pointer, "ecmascript", 10) == 0;
}

/* ---- the stop ------------------------------------------------------------------------------ */

/* Takes, and batches, the last take at close makes at most (the addon's). */
enum { TA_WEB_END_TAKES = 64 };

/* trace.end, then the last take of traces and logs, before the host is
 * freed (bindings.md, section 4): the spans still open are ended and given
 * to ta_web.output (TA_WEB_OUTPUT_TRACES, _LOGS) for the telemetry
 * handler. A call on the stack, as a drain is: a handler's close() is this
 * one (JavaScript defers it), its metrics() joins the open batch.
 * Bounded: a handler that makes inputs here makes more records at every
 * take. */
TA_WEB_EXPORT void ta_web_host_end(ta_web_host *host) {
    static const unsigned char message[] = {0xa1, 0x66, 'm', 'e', 't', 'h', 'o', 'd', 0x69,
                                            't',  'r',  'a', 'c', 'e', '.', 'e', 'n', 'd'};
    if (host->host == NULL || host->turning || host->depth > 0) return;
    ta_web_enter(host);
    if (ta_host_post(host->host, (ta_bytes){message, sizeof message}) == TA_OK) {
        const ta_host_effect *effects = NULL;
        for (uint32_t batches = 0; batches < TA_WEB_END_TAKES && ta_host_effects(host->host, &effects) > 0; batches++) {
            host->batch = true;
            ta_bytes taken;
            for (uint32_t takes = 0; takes < TA_WEB_END_TAKES && ta_host_traces(host->host, &taken) == TA_OK && taken.length; takes++) {
                ta_web_set_bytes(host->env->record.word, 0, taken);
                ta_web_import_output(host->id, TA_WEB_OUTPUT_TRACES, (uint32_t)taken.length);
            }
            for (uint32_t takes = 0; takes < TA_WEB_END_TAKES && ta_host_logs(host->host, &taken) == TA_OK && taken.length; takes++) {
                ta_web_set_bytes(host->env->record.word, 0, taken);
                ta_web_import_output(host->id, TA_WEB_OUTPUT_LOGS, (uint32_t)taken.length);
            }
            ta_host_effects_ack(host->host);
            host->batch = false;
            host->acks++;
        }
    }
    ta_web_leave(host);
}
