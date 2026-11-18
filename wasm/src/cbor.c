/* CBOR as tokens (docs/browser.md, "How values cross"): core's
 * ta_cbor_writer and ta_cbor_reader in C, one token per call, and
 * JavaScript makes the values. One codec, core's: it checks UTF-8, nesting
 * and the shortest forms. A writer or a reader lives in the arena of the
 * call that made it (a host's or the environment's) and ends at that
 * call's leave. */
#include "web.h"

#include <string.h>

/* A writer and the record its calls read; a reader likewise. */
typedef struct ta_web_writer {
    ta_cbor_writer writer;
    ta_web_record *record;
} ta_web_writer;

typedef struct ta_web_reader {
    ta_cbor_reader reader;
    ta_web_record *record;
} ta_web_reader;

/* A writer in `scratch` (the environment's, or a host's), above the
 * current call's mark, growing through the arena (its earlier blocks stay
 * until the leave); 0 when the allocator refuses. */
TA_WEB_EXPORT ta_web_writer *ta_web_writer_new(ta_web_env *env, ta_web_scratch *scratch) {
    ta_web_writer *writer = (ta_web_writer *)ta_growable_arena_alloc(&scratch->arena, sizeof *writer, 8);
    unsigned char *room = (unsigned char *)ta_growable_arena_alloc(&scratch->arena, 256, 8);
    if (writer == NULL || room == NULL) return NULL;
    ta_cbor_writer_init(&writer->writer, (ta_buffer){room, 256, 0}, &scratch->view);
    writer->record = &env->record;
    return writer;
}

/* What ta_web_write writes, by `kind` (TA_CBOR_*, or TA_WEB_CBOR_END):
 *
 *   UINT, NEGINT, TAG, SIMPLE  `number`, or with TA_WEB_CBOR_WIDE the
 *                              record's words 0-1 (a value past 32 bits);
 *   ARRAY, MAP                 `number` items or pairs (TA_CBOR_COUNT_LATER:
 *                              closed by an END);
 *   TEXT, BYTES                the record's words 0-1;
 *   FLOAT                      the record's words 0-1, the double's bits;
 *   END                        closes the innermost container counted later.
 *
 * Errors stick in the writer (ta_web_writer_bytes reports the first). */
enum { TA_WEB_CBOR_END = 16, TA_WEB_CBOR_WIDE = 0x100 };

TA_WEB_EXPORT void ta_web_write(ta_web_writer *web, uint32_t kind, uint32_t number) {
    ta_cbor_writer *writer = &web->writer;
    const uint32_t *word = web->record->word;
    uint64_t value = kind & TA_WEB_CBOR_WIDE ? ta_web_word64(word, 0) : number;
    switch (kind & ~(uint32_t)TA_WEB_CBOR_WIDE) {
    case TA_CBOR_UINT: ta_cbor_write_uint(writer, value); break;
    case TA_CBOR_NEGINT: ta_cbor_write_negative(writer, value); break;
    case TA_CBOR_TAG: ta_cbor_write_tag(writer, value); break;
    case TA_CBOR_SIMPLE: ta_cbor_write_simple(writer, (uint32_t)value); break;
    case TA_CBOR_ARRAY: ta_cbor_write_array(writer, number); break;
    case TA_CBOR_MAP: ta_cbor_write_map(writer, number); break;
    case TA_CBOR_TEXT: ta_cbor_write_text(writer, ta_web_text_at(word, 0)); break;
    case TA_CBOR_BYTES: ta_cbor_write_bytes(writer, ta_web_bytes_at(word, 0)); break;
    case TA_CBOR_FLOAT: {
        uint64_t bits = ta_web_word64(word, 0);
        double d;
        memcpy(&d, &bits, sizeof d);
        ta_cbor_write_float(writer, d);
        break;
    }
    case TA_WEB_CBOR_END: ta_cbor_write_end(writer); break;
    default: ta_cbor_write_simple(writer, 24); break; /* a kind it does not know: TA_ERROR_INVALID sticks */
    }
}

/* The item written: the status, its bytes in the record's words 0-1 (a
 * view of the arena, until the call's leave). */
TA_WEB_EXPORT int32_t ta_web_writer_bytes(ta_web_writer *web) {
    ta_bytes bytes = {NULL, 0};
    ta_status status = ta_cbor_writer_bytes(&web->writer, &bytes);
    ta_web_set_bytes(web->record->word, 0, bytes);
    return status;
}

/* A reader of the record's words 0-1 (bytes JavaScript placed in the
 * call's arena, or a view core gave, valid while the reader reads), in
 * `scratch` above the current call's mark; 0 when the allocator refuses. */
TA_WEB_EXPORT ta_web_reader *ta_web_reader_new(ta_web_env *env, ta_web_scratch *scratch) {
    ta_web_reader *reader = (ta_web_reader *)ta_growable_arena_alloc(&scratch->arena, sizeof *reader, 8);
    if (reader == NULL) return NULL;
    ta_cbor_reader_init(&reader->reader, ta_web_bytes_at(env->record.word, 0));
    reader->record = &env->record;
    return reader;
}

/* The next item: 1 with the item in the record (0 kind, 1 count, 2-3
 * value: the integer, tag, simple value or the double's bits, 4-5 a
 * string's text or bytes, a view of the message, 6 depth); 0 once the item
 * is read whole; or the error, which sticks. */
TA_WEB_EXPORT int32_t ta_web_read(ta_web_reader *web) {
    ta_cbor_item item;
    int32_t got = ta_cbor_read(&web->reader, &item);
    if (got != 1) return got;
    uint32_t *word = web->record->word;
    word[0] = item.kind;
    word[1] = item.count;
    ta_web_set_word64(word, 2, item.value);
    ta_web_set_bytes(word, 4, item.bytes);
    word[6] = item.depth;
    return 1;
}
