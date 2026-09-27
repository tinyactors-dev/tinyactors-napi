#include "trace.h"

#include "../system.h"

static void tna_trace_write(void *self, const ta_trace_record *record) {
    tna_system_trace(self, record); /* writing a record cannot fail (core ADR 0067) */
}

static const ta_trace_sink_vtable tna_trace_vtable = { .write = tna_trace_write };

ta_trace_sink tna_trace_sink_adapter(tna_system *system, const tna_trace_masks *masks) {
    return (ta_trace_sink){ .self = system, .v = &tna_trace_vtable, .kinds = masks->kinds,
                            .watched_kinds = masks->watched_kinds, .unsampled_kinds = masks->unsampled_kinds };
}
