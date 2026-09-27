#pragma once
/*
 * The external-event router (ADR 0006), installed on every system when it is
 * created. Core hands it every event between sessions: every <send> to
 * another actor or to self, and later done.invoke and the like. This module
 * has no Node-API in it, so native tests drive it.
 *
 * submit() resolves the destination and puts the event in a mailbox
 * (ADR 0005). It never delivers directly, never calls back into the
 * interpreter, and never destroys or unloads an actor (core relies on that
 * when it offers a refused due send again, core ADR 0054):
 * - a runtime ID is used as it is (core already turned a session ID into the
 *   current runtime ID, core ADR 0066);
 * - a named address is resolved through the system's directory (ADR 0006
 *   point 1). A name with no resident actor is not a router error: when its
 *   family has a loader, the event waits while the loader brings the actor
 *   back (loads.h, napi ADR 0020); otherwise it is accepted as a dead letter
 *   with reason `not-found`, or `unloaded` for an unloaded entry.
 *
 * The envelope keeps the event by retaining it (tinyactors-core ADRs 0050
 * and 0065): the data, and a named origin's address, are shared, never
 * copied. RETRY is only for resource limits: the queue is at
 * maxQueuedMessages, or an envelope cannot be allocated (ADR 0006 point 3).
 */
#include "scheduler.h"
#include "tinyactors.h"

typedef struct tna_system tna_system;

ta_external_event_router tna_router_adapter(tna_system *system);

/*
 * Accepts a message for a named destination, as submit() does: the waiting
 * mailbox of a load in flight for it, or of a new load when its family has
 * a loader and it has no resident actor (napi ADR 0020); otherwise the
 * resident actor's mailbox, or a dead letter when the name has none. `message->target`
 * is ignored. On TA_OK the system owns the event's references and the waiter;
 * `address` stays the caller's. TA_ERR_BUSY: the queue is full;
 * TA_ERR_NOMEM: nothing accepted.
 */
ta_result tna_router_post_named(tna_system *system, ta_address *address, const tna_message *message);
