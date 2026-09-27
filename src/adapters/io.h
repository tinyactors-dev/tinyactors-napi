#pragma once
/*
 * JavaScript I/O processors (core ADRs 0015, 0046, 0068, ADR 0001 rule 3).
 *
 * Each registered type has one record, the adapter's `self`. Core calls it
 * inside a core call, for a <send> whose type names it, including a delayed
 * send when it falls due. The adapter queues the send as an effect
 * (effects.h), retaining its target and data and copying literal content,
 * and answers success: the processor runs at the end of the turn, so it
 * cannot fail the send synchronously. A processor that throws or rejects is
 * reported to the sender as an error.communication event (lib/system.js).
 *
 * The record also renders text core asks for (core ADR 0068) without
 * running JavaScript, from templates given at registration:
 * - `location`, this session's address through the processor
 *   (_ioprocessors): {session} is the session ID, {family} and {name} its
 *   named address;
 * - `origin`, the URI of a COMPUTED origin: {token} is its token.
 * A template that is absent, or that names an address the session does not
 * have, renders nothing.
 */
#include "tinyactors.h"

typedef struct tna_system tna_system;

typedef struct {
    ta_atom type;
    ta_str location; /* empty: no location */
    ta_str origin;   /* empty: no computed origins */
    uint32_t *index; /* the registry index core gave the type */
} tna_io_registration;

/* Registers (or re-registers) a type; TA_ERR_NOMEM, or core's refusal. */
ta_result tna_io_register(tna_system *system, const tna_io_registration *registration);
/* True when the processor at registry `index` renders computed origins. */
bool tna_io_renders_origins(const tna_system *system, uint32_t index);
/* Frees every record; core must no longer hold them (after ta_system_destroy). */
void tna_io_close(tna_system *system);
