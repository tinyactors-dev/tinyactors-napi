/* The compiler (tinyactors/compile.h) in the module: compileCharts and
 * compileSystem, a resolver called through the import ta_web.resolve, and
 * the result's image and diagnostics. The compiler allocates through the
 * environment's allocator; a resolver's text and messages go into the
 * compilation's scratch arena (request->scratch), so nothing is kept per
 * src past the call (tinyactors-core/docs/boundary.md, section 12). */
#include "web.h"

#include <string.h>

/* The resolver's context: the environment and JavaScript's number for the
 * compilation, which the import names. */
typedef struct ta_web_compilation {
    ta_web_env *env;
    uint32_t id;
    uint32_t pad;
} ta_web_compilation;

/* A static src="": base and source in the record's words 0-3, and the
 * request kept for ta_web_resolve_room; JavaScript answers in the record:
 * 0 the status (TA_OK, a refusal's TA_ERROR_INVALID, or another status for
 * an exception that is not a refusal, which JavaScript keeps and throws
 * after the compilation), 1-2 the resolved name, 3-4 the text, 5 line,
 * 6 column, 7-8 the refusal's message. */
static ta_status ta_web_resolve(void *context, const ta_resolve_request *request, ta_resolve_result *out) {
    ta_web_compilation *compilation = (ta_web_compilation *)context;
    ta_web_env *env = compilation->env;
    uint32_t *word = env->record.word;
    const ta_resolve_request *outer = env->resolving;
    ta_web_set_text(word, 0, request->base);
    ta_web_set_text(word, 2, request->source);
    env->resolving = request;
    int32_t answered = ta_web_import_resolve(compilation->id, 0, 0);
    env->resolving = outer;
    ta_status status = answered == TA_OK ? (ta_status)word[0] : TA_ERROR_ABORTED;
    out->source.name = ta_web_text_at(word, 1);
    if (status == TA_OK) {
        out->source.text = ta_web_text_at(word, 3);
        return TA_OK;
    }
    out->error.line = word[5];
    out->error.column = word[6];
    out->error.message = ta_web_text_at(word, 7);
    return status;
}

/* Room in the compilation's scratch arena for a resolver's answer, during
 * ta_web.resolve only; 0 outside it or when the allocator refuses. */
TA_WEB_EXPORT uint32_t ta_web_resolve_room(ta_web_env *env, uint32_t size) {
    if (env->resolving == NULL) return 0;
    return ta_web_address(ta_growable_arena_alloc(env->resolving->scratch, size ? size : 1, 8));
}

/* compileCharts (`manifest` 0) or compileSystem (1). Record: 0 the address
 * of the sources' words in the call's arena (4 each: name, text), 1 their
 * count (one for a manifest), 2 flags (TA_COMPILE_*), 3 whether a resolver
 * was given, 4 JavaScript's number for the compilation. Answers the
 * result (with its diagnostics, also when the status is an error; 0 when
 * the compiler made none) and the status in the record's word 0. */
TA_WEB_EXPORT ta_compile_result *ta_web_compile(ta_web_env *env, uint32_t manifest) {
    uint32_t *word = env->record.word;
    const uint32_t *pairs = (const uint32_t *)(uintptr_t)word[0];
    uint32_t count = word[1], flags = word[2];
    bool resolver = word[3] != 0;
    ta_web_compilation compilation = {env, word[4], 0};
    ta_source *sources = count ? (ta_source *)ta_growable_arena_alloc(&env->scratch.arena, sizeof *sources * count, 8) : NULL;
    if (count && sources == NULL) {
        word[0] = (uint32_t)TA_ERROR_NO_MEMORY;
        return NULL;
    }
    for (uint32_t i = 0; i < count; i++) sources[i] = (ta_source){ta_web_text_at(pairs, 4 * i), ta_web_text_at(pairs, 4 * i + 2)};
    ta_compile_options options = {sizeof options, flags, env->allocator, resolver ? ta_web_resolve : NULL,
                                  resolver ? &compilation : NULL, NULL};
    ta_compile_result *result = NULL;
    env->depth++;
    ta_status status = manifest ? (count == 1 ? ta_compile_system(&options, sources, &result) : TA_ERROR_INVALID)
                                : ta_compile_charts(&options, (ta_source_list){sources, count}, &result);
    env->depth--;
    word[0] = (uint32_t)status;
    return result;
}

/* The image's bytes: the pointer, the length in the record's word 0;
 * valid until ta_web_compile_free. */
TA_WEB_EXPORT uint32_t ta_web_compile_image(ta_web_env *env, const ta_compile_result *result) {
    ta_string_view image = ta_compile_image(result);
    env->record.word[0] = (uint32_t)image.length;
    return ta_web_address(image.pointer);
}

TA_WEB_EXPORT uint32_t ta_web_compile_diagnostic_count(const ta_compile_result *result) {
    const ta_diagnostic *diagnostics = NULL;
    return ta_compile_diagnostics(result, &diagnostics);
}

/* Diagnostic `i` in the record: 0 severity, 1 code, 2 line, 3 column, 4-5
 * file, 6-7 message, views valid until ta_web_compile_free. */
TA_WEB_EXPORT void ta_web_compile_diagnostic(ta_web_env *env, const ta_compile_result *result, uint32_t i) {
    const ta_diagnostic *diagnostics = NULL;
    uint32_t n = ta_compile_diagnostics(result, &diagnostics);
    uint32_t *word = env->record.word;
    if (i >= n) {
        for (uint32_t w = 0; w < 8; w++) word[w] = 0;
        return;
    }
    const ta_diagnostic *d = &diagnostics[i];
    word[0] = d->severity;
    word[1] = d->code;
    word[2] = d->line;
    word[3] = d->column;
    ta_web_set_text(word, 4, d->file);
    ta_web_set_text(word, 6, d->message);
}

TA_WEB_EXPORT void ta_web_compile_free(ta_compile_result *result) { ta_compile_free(result); }

/* ---- the syntax check of "ecmascript" charts (wasm/lib/compile.mjs) ------------------------ */

/* The result's image opened into a ta_image in the environment's arena,
 * above the caller's mark: its chart count in the record's word 0; 0 when
 * it does not open (core's to refuse) or the allocator refuses. */
TA_WEB_EXPORT ta_image *ta_web_image_open(ta_web_env *env, const ta_compile_result *result) {
    ta_image *image = (ta_image *)ta_growable_arena_alloc(&env->scratch.arena, sizeof *image, 8);
    ta_string_view bytes = ta_compile_image(result);
    env->record.word[0] = 0;
    if (image == NULL || ta_image_open((ta_bytes){bytes.pointer, bytes.length}, image) != TA_OK) return NULL;
    ta_image_info about;
    memset(&about, 0, sizeof about);
    about.size = sizeof about;
    ta_image_get_info(image, &about);
    env->record.word[0] = about.chart_count;
    return image;
}

/* Chart `c` of the image: its datamodel's name in the record's words 0-1,
 * its source's name in 2-3; answers its expression count. */
TA_WEB_EXPORT uint32_t ta_web_image_chart(ta_web_env *env, const ta_image *image, uint32_t c) {
    uint32_t *word = env->record.word;
    ta_web_set_text(word, 0, ta_image_chart_datamodel(image, c));
    ta_web_set_text(word, 2, ta_image_chart_source(image, c));
    return ta_image_expression_count(image, c);
}

/* Expression `e` of the chart in the record's word 0: [status, kind, line,
 * column, source (2 words)], the source a view of the image. */
TA_WEB_EXPORT int32_t ta_web_image_expression(ta_web_env *env, const ta_image *image, uint32_t e) {
    uint32_t *word = env->record.word;
    ta_expression_info info = {0, 0, 0, {"", 0}};
    ta_status status = ta_image_expression(image, (ta_chart_item){word[0], e}, &info);
    word[0] = (uint32_t)status;
    word[1] = info.kind;
    word[2] = info.line;
    word[3] = info.column;
    ta_web_set_text(word, 4, info.source);
    return status;
}
