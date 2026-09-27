#include "import.h"

#include <stdio.h>
#include <string.h>

#include "allocator.h"
#include "ta_scxml.h"

/* Block size of the import's arena; a large document grows it on demand. */
#define TNA_IMPORT_ARENA_BLOCK ((size_t)16384)

static void tna_import_text(tna_import_failure *failure, ta_str text) {
    size_t length = text.len < sizeof failure->message - 1u ? text.len : sizeof failure->message - 1u;
    if (length != 0) {
        memcpy(failure->message, text.ptr, length);
    }
    failure->message[length] = '\0';
}

/* A decode error: the codec's phrase, and the element and attribute it is about. */
static void tna_import_decode(tna_import_failure *failure, const ta_chart_error *error) {
    snprintf(failure->message, sizeof failure->message, "%.*s%s%.*s%s%.*s", (int)error->message.len,
             error->message.ptr != NULL ? error->message.ptr : "", error->construct.len != 0 ? " in <" : "",
             (int)error->construct.len, error->construct.ptr != NULL ? error->construct.ptr : "",
             error->construct.len != 0 ? (error->attribute.len != 0 ? "> attribute " : ">") : "",
             (int)error->attribute.len, error->attribute.ptr != NULL ? error->attribute.ptr : "");
}

static void tna_import_describe(tna_import_failure *failure, const ta_import_error *error, ta_arena *arena) {
    *failure = (tna_import_failure){
        .stage = error->stage,
        .located = error->located,
        .line = error->at.line,
        .column = error->at.column,
        .offset = error->at.offset,
    };
    if (error->stage == TA_IMPORT_STAGE_DECODE) {
        tna_import_decode(failure, &error->as.decode);
        return;
    }
    ta_str text = { 0 };
    if (error->stage == TA_IMPORT_STAGE_COMPILE &&
        ta_compile_error_format(&(ta_compile_error_format_params){
            .error = &error->as.compile, .arena = arena, .out = &text }) == TA_OK) {
        tna_import_text(failure, text);
        return;
    }
    tna_import_text(failure, (ta_str){ "the document was refused", 24 });
}

ta_result tna_import_scxml(tna_system *system, const tna_import_params *params) {
    ta_scxml_codec codec;
    ta_result result = ta_scxml_codec_init(&codec, &(ta_scxml_codec_params){ 0 });
    if (result != TA_OK) {
        return result;
    }
    ta_allocator allocator = tna_allocator_for(&system->allocator, TNA_MEMORY_CORE);
    ta_arena arena;
    result = ta_arena_init(&arena, allocator, TNA_IMPORT_ARENA_BLOCK);
    if (result != TA_OK) {
        return result;
    }
    ta_import_error error = { 0 };
    result = ta_definition_import(system->core, &(ta_definition_import_params){
                                                    .codec = ta_scxml_codec_adapter(&codec),
                                                    .input = params->input,
                                                    .name = params->name,
                                                    .arena = &arena,
                                                    .resolver = params->resolver,
                                                    .identity = params->identity,
                                                    .datamodels = params->datamodels,
                                                    .datamodel_count = params->datamodel_count,
                                                    .allocator = allocator,
                                                    .out = params->out,
                                                    .error = &error,
                                                });
    if ((result == TA_ERR_INVALID || result == TA_ERR_UNSUPPORTED) && params->failure != NULL) {
        tna_import_describe(params->failure, &error, &arena);
    }
    ta_arena_destroy(&arena);
    return result;
}

ta_result tna_encode_arena(tna_system *system, ta_arena *arena) {
    return ta_arena_init(arena, tna_allocator_for(&system->allocator, TNA_MEMORY_CORE), TNA_IMPORT_ARENA_BLOCK);
}

ta_result tna_encode_scxml(tna_system *system, const tna_encode_params *params) {
    ta_scxml_codec codec;
    ta_result result = ta_scxml_codec_init(&codec, &(ta_scxml_codec_params){ 0 });
    if (result != TA_OK) {
        return result;
    }
    ta_chart_error error = { 0 };
    result = ta_definition_encode(system->core, &(ta_definition_encode_params){
                                                    .definition = params->definition,
                                                    .codec = ta_scxml_codec_adapter(&codec),
                                                    .arena = params->arena,
                                                    .out = params->out,
                                                    .spans = params->spans,
                                                    .error = &error,
                                                });
    if (result == TA_ERR_INVALID && params->failure != NULL) {
        *params->failure = (tna_import_failure){ .stage = TA_IMPORT_STAGE_DECODE };
        tna_import_decode(params->failure, &error);
    }
    return result;
}
