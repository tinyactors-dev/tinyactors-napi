/* The module instance's environment, its allocator, the record and the
 * arenas' marks (web.h). */
#include "web.h"

#include <string.h>

/* ---- the record ------------------------------------------------------------- */

uint64_t ta_web_word64(const uint32_t *word, uint32_t at) {
    return (uint64_t)word[at] | (uint64_t)word[at + 1] << 32;
}

void ta_web_set_word64(uint32_t *word, uint32_t at, uint64_t value) {
    word[at] = (uint32_t)value;
    word[at + 1] = (uint32_t)(value >> 32);
}

uint32_t ta_web_address(const void *pointer) { return (uint32_t)(uintptr_t)pointer; }

ta_string_view ta_web_text_at(const uint32_t *word, uint32_t at) {
    ta_string_view text = {(const char *)(uintptr_t)word[at], word[at + 1]};
    if (text.length == 0) text.pointer = "";
    return text;
}

void ta_web_set_text(uint32_t *word, uint32_t at, ta_string_view text) {
    word[at] = ta_web_address(text.pointer);
    word[at + 1] = text.pointer != NULL ? (uint32_t)text.length : 0;
}

ta_bytes ta_web_bytes_at(const uint32_t *word, uint32_t at) {
    return (ta_bytes){(const unsigned char *)(uintptr_t)word[at], word[at + 1]};
}

void ta_web_set_bytes(uint32_t *word, uint32_t at, ta_bytes bytes) {
    word[at] = ta_web_address(bytes.pointer);
    word[at + 1] = bytes.pointer != NULL ? (uint32_t)bytes.length : 0;
}

/* ---- the allocator ------------------------------------------------------------ */

/* The module's own blocks (tinyactors/wasm.h): every host, table, arena
 * chunk and compilation. The host asks for an alignment of at most 8
 * (tinyactors/allocator.h), which ta_wasm_alloc gives. */
static void *ta_web_allocator_alloc(void *context, size_t size, size_t align) {
    (void)context;
    return ta_wasm_alloc(size, align ? align : 1);
}

static void ta_web_allocator_free(void *context, void *ptr, size_t size) {
    (void)context;
    if (ptr != NULL) ta_wasm_free(ptr, size, 8);
}

ta_allocator ta_web_allocator(ta_web_env *env) {
    return (ta_allocator){env, ta_web_allocator_alloc, ta_web_allocator_free};
}

/* ---- arenas: a mark per call ----------------------------------------------------- */

void ta_web_scratch_init(ta_web_scratch *scratch, const ta_web_scratch_config *config) {
    memset(scratch, 0, sizeof *scratch);
    ta_growable_arena_config arena = {sizeof arena, 0, 16384, config->allocator};
    ta_growable_arena_init(&scratch->arena, &arena);
    scratch->view = ta_growable_arena_allocator(&scratch->arena);
    scratch->cap = config->cap;
}

/* A call enters: its mark's level, or 0 when the marks are all taken (a
 * call nested 64 deep), which JavaScript refuses with TA_ERROR_STATE. */
TA_WEB_EXPORT uint32_t ta_web_scratch_enter(ta_web_scratch *scratch) {
    if (scratch->depth == TA_WEB_MARKS) return 0;
    scratch->marks[scratch->depth] = ta_growable_arena_position(&scratch->arena);
    return ++scratch->depth;
}

/* The call at `level` leaves, on every path: what it and the calls inside
 * it allocated ends. The outermost leave applies the cap. */
TA_WEB_EXPORT void ta_web_scratch_leave(ta_web_scratch *scratch, uint32_t level) {
    if (level == 0 || level > scratch->depth) return;
    ta_growable_arena_release(&scratch->arena, scratch->marks[level - 1]);
    scratch->depth = level - 1;
    if (scratch->depth == 0 && ta_growable_arena_position(&scratch->arena).chunk == NULL &&
        scratch->arena.reserved > scratch->cap)
        ta_growable_arena_free(&scratch->arena); /* it may allocate again, as a new history */
}

/* Room for `size` bytes above the current call's mark, 8-aligned, for the
 * text and records JavaScript writes for the call; 0 when the allocator
 * refuses. */
TA_WEB_EXPORT uint32_t ta_web_scratch_room(ta_web_scratch *scratch, uint32_t size) {
    return ta_web_address(ta_growable_arena_alloc(&scratch->arena, size ? size : 1, 8));
}

/* What the arena holds now, for a test of the cap: its reserved bytes. */
TA_WEB_EXPORT uint32_t ta_web_scratch_reserved(const ta_web_scratch *scratch) {
    return (uint32_t)scratch->arena.reserved;
}

/* ---- the environment ---------------------------------------------------------- */

/* A module instance's environment, after _initialize; 0 when the
 * allocator refuses. One per instance is enough: hosts and compilations
 * name it. */
TA_WEB_EXPORT ta_web_env *ta_web_env_new(void) {
    ta_web_env *env = (ta_web_env *)ta_web_allocator_alloc(NULL, sizeof *env, 8);
    if (env == NULL) return NULL;
    memset(env, 0, sizeof *env);
    env->allocator = ta_web_allocator(env);
    ta_web_scratch_init(&env->scratch, &(ta_web_scratch_config){&env->allocator, TA_WEB_ENV_ARENA_CAP});
    return env;
}

TA_WEB_EXPORT void ta_web_env_free(ta_web_env *env) {
    if (env == NULL) return;
    ta_growable_arena_free(&env->scratch.arena);
    ta_web_allocator_free(NULL, env, sizeof *env);
}

TA_WEB_EXPORT ta_web_record *ta_web_env_record(ta_web_env *env) { return &env->record; }
TA_WEB_EXPORT ta_web_scratch *ta_web_env_scratch(ta_web_env *env) { return &env->scratch; }
TA_WEB_EXPORT uint32_t ta_web_env_depth(const ta_web_env *env) { return env->depth; }

/* core's name of a status (ta_status_name), NUL-terminated. */
TA_WEB_EXPORT const char *ta_web_status_name(int32_t status) { return ta_status_name((ta_status)status); }

/* The version of core the module was built from: major << 16 | minor << 8 | patch. */
TA_WEB_EXPORT uint32_t ta_web_version(void) {
    return (uint32_t)TA_VERSION_MAJOR << 16 | (uint32_t)TA_VERSION_MINOR << 8 | (uint32_t)TA_VERSION_PATCH;
}

/* Where the shadow stack is now: the address of a local of this frame. Two
 * calls from JavaScript's top level answer the same unless something left
 * frames on the stack (an exception that crossed wasm frames does:
 * docs/browser.md, "Exceptions, ..."); a test compares them. */
TA_WEB_EXPORT uint32_t ta_web_stack(void) {
    volatile uint32_t here = 0;
    return ta_web_address((const void *)&here);
}

#ifdef TA_WEB_STACK_PROBE
/* The stack's measure (mise run wasm:stack; never in the shipped module):
 * wasm-ld's bounds of the shadow stack, the part below the current frame
 * painted with a pattern, and the deepest byte a later call overwrote. */
#define TA_WEB_PROBE_EXPORT TA_WEB_EXPORT /* not a layer export: mise/wasm.rb adds these to the probe build only */
extern const unsigned char __stack_low; /* the linker's, not data of ours: the stack is written by the frames, painted below */
extern const unsigned char __stack_high;

TA_WEB_PROBE_EXPORT uint32_t ta_web_stack_size(void) { return (uint32_t)(&__stack_high - &__stack_low); }

TA_WEB_PROBE_EXPORT void ta_web_stack_paint(void) {
    volatile unsigned char here = 0;
    for (volatile unsigned char *p = (volatile unsigned char *)(uintptr_t)&__stack_low; p < &here - 256; p++) *p = 0xa5;
}

/* Bytes of the stack used at the deepest point since the paint. */
TA_WEB_PROBE_EXPORT uint32_t ta_web_stack_used(void) {
    const unsigned char *p = &__stack_low;
    while (p < &__stack_high && *p == 0xa5) p++;
    return (uint32_t)(&__stack_high - p);
}
#endif
