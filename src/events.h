#pragma once
/*
 * Dotted event-name interning (ADR 0004). No Node-API: native tests drive it.
 *
 * JavaScript keeps a Map from event-name text to ta_event_name_id per system
 * (lib/events.js). A cache miss calls tna_event_name_intern() once; a name
 * that was seen before does no string work at all, and native post paths take
 * the numeric ID. Names are never un-interned, because core interning is
 * monotonic, so the cache never needs invalidation.
 *
 * Validation happens here, once per name: the text must be non-empty, have
 * no empty segment ("a..b", ".a", "a."), and at most TNA_EVENT_NAME_MAX_DEPTH
 * segments. Core checks the same rules again.
 */
#include <stddef.h>

#include "tinyactors.h"

/* Core's limit on the segments of one event name. */
#define TNA_EVENT_NAME_MAX_DEPTH 64u

/* TA_ERR_INVALID for malformed text; TA_ERR_NOMEM from core. */
ta_result tna_event_name_intern(ta_system *system, ta_str text, ta_event_name_id *out);
