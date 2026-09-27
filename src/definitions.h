#pragma once
/*
 * The definition lifecycle as the host counts it (core ADR 0079, napi ADR
 * 0017 section 7): how many definitions core registered, retired and freed,
 * and, for each definition still alive, who registered it.
 *
 * Core tells the addon of every event through its definition sink; this
 * module keeps what the metrics and the churn logs need:
 * - three counters, one per event kind;
 * - the origin of each live definition: the host (JavaScript's define()),
 *   nested (an inline child an import compiled when its parent was
 *   defined), or invoke (chart text compiled when an <invoke> ran). Core
 *   does not know who asked it to register a chart, so the addon marks
 *   the calls it makes on a child's behalf (`registering`) and every other
 *   registration is the host's. A definition leaves the map when core frees
 *   it, so the map is the size of what is alive.
 *
 * A steadily climbing registered count with a freed count that keeps pace
 * is churn: an invoke that compiles new chart text every time.
 *
 * This module has no Node-API in it.
 */
#include <stdint.h>

#include "containers.h"
#include "tinyactors.h"

typedef enum {
    TNA_ORIGIN_HOST = 0,
    TNA_ORIGIN_NESTED,
    TNA_ORIGIN_INVOKE,
    TNA_ORIGINS
} tna_definition_origin;

typedef struct {
    tna_map origins; /* definition ID -> tna_definition_origin, for NESTED and INVOKE */
    uint64_t registered;
    uint64_t retired;
    uint64_t freed;
    /* The origin of the registrations core makes now; HOST outside a child's compile. */
    tna_definition_origin registering;
} tna_definitions;

void tna_definitions_init(tna_definitions *definitions, ta_allocator allocator);
void tna_definitions_destroy(tna_definitions *definitions);

/*
 * Counts one event and keeps or forgets the definition's origin, which it
 * returns: the origin being registered for REGISTERED, the one kept for
 * RETIRED and FREED. If the origin cannot be kept for lack of memory, the
 * definition reads as the host's.
 */
tna_definition_origin tna_definitions_note(tna_definitions *definitions, const ta_definition_event *event);

tna_definition_origin tna_definitions_origin(const tna_definitions *definitions, ta_definition_id definition);

const char *tna_definition_origin_name(tna_definition_origin origin);

/*
 * The live definitions by origin and by whether they are retired (still
 * alive because a child or an actor uses them): `alive[origin][retired]`.
 * It walks core's definitions (core ADR 0078).
 */
void tna_definitions_alive(const tna_definitions *definitions, const ta_system *core,
                           uint64_t alive[TNA_ORIGINS][2]);
