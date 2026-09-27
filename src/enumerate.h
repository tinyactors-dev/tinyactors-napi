#pragma once
/*
 * Cursor-paged actor enumeration (ADR 0003, core ADR 0062). This module has
 * no Node-API in it, so native tests cover it.
 *
 * One page is one call of ta_system_visit_actors() with a start position and
 * a limit. The page copies what it keeps while core visits: here the
 * (slot, generation) of each actor, straight into the caller's buffer, which
 * the Node-API layer makes the backing store of the page's Uint32Array. The
 * inspection core hands the visitor is borrowed only during the visit, so
 * nothing else of it is kept.
 *
 * Positions are opaque: a caller passes 0 for the first page and then only
 * a `next` this module gave it. The iteration ends when `next` is
 * TA_ACTOR_VISIT_END; a last page that is exactly full takes one more call,
 * which visits nothing (core ADR 0062).
 */
#include <stdint.h>

#include "system.h"
#include "tinyactors.h"

typedef struct {
    uint32_t from;   /* 0, or the `next` of the previous page */
    uint32_t limit;  /* actors per page, at least 1 */
    uint32_t *pairs; /* room for 2 * limit values: slot, generation, ... */
    uint32_t count;  /* out: actors on this page */
    uint32_t next;   /* out: where the next page starts, or TA_ACTOR_VISIT_END */
} tna_id_page;

/*
 * Fills one page of actor IDs from an open system. TA_ERR_INVALID for a zero
 * limit or no buffer; TA_ERR_BUSY inside a core call, because the walk is a
 * core call (ADR 0013 point 4).
 */
ta_result tna_enumerate_ids(tna_system *system, tna_id_page *page);
