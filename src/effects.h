#pragma once
/*
 * Effects (ROADMAP step 13, ADR 0001 rule 3): what core asks of a host
 * service while it runs, kept until JavaScript can hear it.
 *
 * Core calls the log sink, the I/O processors and the invokers
 * synchronously, inside a core call. JavaScript must not run there, so each
 * adapter (the adapters in adapters/) copies what the call borrowed into an effect and
 * queues it here. The pump hands the queue to JavaScript at the end of the
 * turn, after the last core call (ADR 0007 point 5), in the order core made
 * the calls.
 *
 * Memory (ADR 0014): an effect and the text and bytes it copies live in the
 * turn arena, so a steady stream of effects makes no allocator call. An
 * effect queued outside a turn (a core call made from a JavaScript API call,
 * such as destroy() cancelling an invocation) waits in the arena for the next
 * turn, which the queue asks for; the arena is only reset at the end of a
 * turn, after the queue was drained. What an effect retains (values, a named
 * source's address, a forwarded event) goes back with tna_effect_release().
 *
 * This module has no Node-API in it.
 */
#include <stdbool.h>
#include <stdint.h>

#include "tinyactors.h"

typedef enum {
    TNA_EFFECT_LOG,           /* <log>: a record for the log sink */
    TNA_EFFECT_IO,            /* <send> to a registered I/O processor */
    TNA_EFFECT_INVOKE_START,  /* an invocation of a JavaScript invoker starts */
    TNA_EFFECT_INVOKE_CANCEL, /* ... is cancelled */
    TNA_EFFECT_INVOKE_FORWARD /* ... gets an autoforwarded event */
} tna_effect_kind;

typedef struct tna_effect {
    tna_effect_kind kind;
    struct tna_effect *next;
    /* LOG, IO: the actor that ran the action; a named address is retained. */
    ta_actor_ref source;
    /* LOG: the label, copied. */
    ta_str label;
    /* LOG: has_value and value; IO: value is the data; START: the data. */
    bool has_value;
    ta_value value;
    /* IO: the evaluated targetexpr; START: the evaluated srcexpr. */
    ta_value target;
    /* IO: a literal target; START: a literal src; copied, ptr NULL when none. */
    ta_str target_text;
    /* START: the params. */
    ta_value params;
    /* IO: the send. */
    ta_send_id send_id;
    ta_event_name_id event;
    /* IO: the processor type; START: the invoker type. */
    ta_atom type;
    /* IO, START: literal <content>, copied. */
    ta_str content_type;
    ta_bytes content;
    /* START, CANCEL, FORWARD. */
    ta_actor_id parent;
    ta_invoke_id invoke_id;
    uint64_t service;
    bool autoforward;
    /* FORWARD: the event, retained. */
    ta_event forwarded;
    /* IO, START: the sending or invoking step's trace parent (core ADR 0067),
     * for JavaScript to pass on as a traceparent. */
    ta_trace_parent trace;
} tna_effect;

typedef struct {
    ta_arena *arena;   /* the turn arena */
    tna_effect *first;
    tna_effect *last;
    uint32_t count;
    bool closed;       /* the system is closing: new effects are dropped */
    uint64_t dropped;  /* effects that could not be queued (no memory, or closing) */
} tna_effects;

void tna_effects_init(tna_effects *effects, ta_arena *arena);
/*
 * Queues a copy of `effect`, which hands over the references it holds
 * (values, source address, forwarded event). Copies the label, the content
 * type, the content and a literal target into the arena. False when the effect cannot be
 * queued (no memory, or the queue is closed); its references are then
 * released.
 */
bool tna_effects_push(tna_effects *effects, const tna_effect *effect);
/* The next effect, removed from the queue, or NULL. Release it after use. */
tna_effect *tna_effects_pop(tna_effects *effects);
/* Releases what an effect retains. */
void tna_effect_release(tna_effect *effect);
/* Closes the queue and releases every queued effect. */
void tna_effects_close(tna_effects *effects);
