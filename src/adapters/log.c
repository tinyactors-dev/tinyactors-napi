#include "log.h"

#include "../system.h"

static void tna_log_write(void *self, const ta_log_record *record) {
    tna_system *system = self;
    if (system->tracing) {
        tna_otlp_log(&system->otlp, record); /* an OTLP log record (napi ADR 0017 section 7) */
    }
    if (!system->log_to_js) {
        return;
    }
    tna_effect effect = {
        .kind = TNA_EFFECT_LOG,
        .source = record->source,
        .label = record->label,
        .has_value = record->has_value,
    };
    if (effect.source.kind == TA_ACTOR_REF_NAMED) {
        ta_address_retain(effect.source.as.named);
    }
    if (record->has_value) {
        effect.value = record->value;
        ta_value_retain(&effect.value);
    }
    (void)tna_system_effect(system, &effect); /* a <log> cannot fail (SCXML 4.7) */
}

static const ta_log_sink_vtable tna_log_vtable = { .write = tna_log_write };

ta_log_sink tna_log_sink_adapter(tna_system *system) {
    return (ta_log_sink){ .self = system, .v = &tna_log_vtable };
}
