#include "definitions.h"

void tna_definitions_init(tna_definitions *definitions, ta_allocator allocator) {
    *definitions = (tna_definitions){ .registering = TNA_ORIGIN_HOST };
    tna_map_init(&definitions->origins, allocator);
}

void tna_definitions_destroy(tna_definitions *definitions) {
    tna_map_destroy(&definitions->origins);
}

tna_definition_origin tna_definitions_origin(const tna_definitions *definitions, ta_definition_id definition) {
    uint64_t origin = TNA_ORIGIN_HOST;
    (void)tna_map_get(&definitions->origins, definition, &origin);
    return origin < TNA_ORIGINS ? (tna_definition_origin)origin : TNA_ORIGIN_HOST;
}

tna_definition_origin tna_definitions_note(tna_definitions *definitions, const ta_definition_event *event) {
    switch (event->kind) {
        case TA_DEFINITION_EVENT_REGISTERED: {
            definitions->registered += 1u;
            tna_definition_origin origin = definitions->registering;
            /* The host's are the default: only a child's origin is kept. */
            if (origin != TNA_ORIGIN_HOST && tna_map_put(&definitions->origins, event->definition, origin) != TA_OK) {
                return TNA_ORIGIN_HOST;
            }
            return origin;
        }
        case TA_DEFINITION_EVENT_RETIRED:
            definitions->retired += 1u;
            return tna_definitions_origin(definitions, event->definition);
        case TA_DEFINITION_EVENT_FREED: {
            definitions->freed += 1u;
            tna_definition_origin origin = tna_definitions_origin(definitions, event->definition);
            (void)tna_map_remove(&definitions->origins, event->definition);
            return origin;
        }
    }
    return TNA_ORIGIN_HOST;
}

const char *tna_definition_origin_name(tna_definition_origin origin) {
    switch (origin) {
        case TNA_ORIGIN_NESTED: return "nested";
        case TNA_ORIGIN_INVOKE: return "invoke";
        default: return "host";
    }
}

void tna_definitions_alive(const tna_definitions *definitions, const ta_system *core,
                           uint64_t alive[TNA_ORIGINS][2]) {
    for (uint32_t origin = 0; origin < TNA_ORIGINS; origin += 1u) {
        alive[origin][0] = 0;
        alive[origin][1] = 0;
    }
    ta_definition_id page[256];
    uint32_t from = 0;
    for (;;) {
        uint32_t count = 0;
        ta_result result = ta_system_definitions(core, &(ta_system_definitions_params){
                                                           .from = from,
                                                           .limit = 256,
                                                           .definitions = page,
                                                           .capacity = 256,
                                                           .count = &count,
                                                       });
        if (result != TA_OK) {
            return;
        }
        for (uint32_t at = 0; at < count; at += 1u) {
            ta_definition_inspection view;
            if (ta_definition_inspect(core, page[at], &view) != TA_OK) {
                continue;
            }
            alive[tna_definitions_origin(definitions, page[at])][view.retired ? 1 : 0] += 1u;
        }
        if (count < 256) {
            return;
        }
        from = (uint32_t)(page[count - 1u] & 0xffffffffu) + 1u;
    }
}
