/* The fields of an effect of the open batch, for thin views: JavaScript
 * asks for one when it is read (docs/browser.md, "Lifetimes"). Core bounds
 * every index and field: one past the batch, or a field the effect kind
 * does not set, answers 0 or empty (host.h). */
#include "web.h"

/* A number field (TA_EFFECT_FIELD_KIND .. _PENDING) as 64 bits: a session,
 * a payload handle. */
TA_WEB_EXPORT uint64_t ta_web_effect_number(const ta_web_host *host, uint32_t index, uint32_t field) {
    return ta_host_effect_number(host->host, index, field);
}

/* A number field that fits in 32 bits (kind, segment, token, IO_PROCESSOR,
 * flags, migration, chart, counts): no BigInt crosses. */
TA_WEB_EXPORT uint32_t ta_web_effect_word(const ta_web_host *host, uint32_t index, uint32_t field) {
    return (uint32_t)ta_host_effect_number(host->host, index, field);
}

/* A text field (TA_EFFECT_FIELD_TARGET .. _ORIGIN): its pointer, the
 * length in the record's word 0; borrowed until the ack. */
TA_WEB_EXPORT uint32_t ta_web_effect_text(ta_web_host *host, uint32_t index, uint32_t field) {
    ta_string_view text = ta_host_effect_text(host->host, index, field);
    host->env->record.word[0] = (uint32_t)text.length;
    return ta_web_address(text.pointer);
}

/* A bytes field (TA_EFFECT_FIELD_WIRE): its pointer, the length in the
 * record's word 0; borrowed until the ack. */
TA_WEB_EXPORT uint32_t ta_web_effect_bytes(ta_web_host *host, uint32_t index, uint32_t field) {
    ta_bytes bytes = ta_host_effect_bytes(host->host, index, field);
    host->env->record.word[0] = (uint32_t)bytes.length;
    return ta_web_address(bytes.pointer);
}

/* A migration's pending sessions and failures, read at its MIGRATION_DONE
 * (valid until the next run): record 0 the migration, 1 room for word 2
 * sessions (two words each), 3 room for word 4 failures (three words each:
 * the session's two and the status), in the call's arena. Core's failure
 * records are read here, in the host's arena, and written as those words.
 * Answers [pending written, failed written]. */
TA_WEB_EXPORT void ta_web_host_migration_result(ta_web_host *host) {
    uint32_t *word = host->env->record.word;
    uint32_t migration = word[0];
    ta_uint64_array pending = {(uint64_t *)(uintptr_t)word[1], word[2]};
    uint32_t *failures = (uint32_t *)(uintptr_t)word[3], capacity = word[4];
    uint32_t got = pending.capacity ? ta_host_migration_pending(host->host, migration, pending) : 0;
    uint32_t lost = 0;
    uint32_t level = ta_web_scratch_enter(&host->scratch);
    ta_host_migration_failures failed = {
        capacity ? (ta_host_migration_failure *)ta_growable_arena_alloc(&host->scratch.arena, sizeof(ta_host_migration_failure) * capacity, 8) : NULL,
        capacity};
    if (failed.pointer != NULL) {
        lost = ta_host_migration_failed(host->host, migration, failed);
        if (lost > capacity) lost = capacity;
        for (uint32_t i = 0; i < lost; i++) {
            ta_web_set_word64(failures, 3 * i, failed.pointer[i].session);
            failures[3 * i + 2] = (uint32_t)failed.pointer[i].status;
        }
    }
    ta_web_scratch_leave(&host->scratch, level);
    word[0] = got < pending.capacity ? got : pending.capacity;
    word[1] = lost;
}
