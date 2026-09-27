#pragma once
/*
 * Invokers (core ADR 0016, ADR 0001 rule 3).
 *
 * - JavaScript invokers: one adapter serves every type registered with
 *   registerInvoker(). Core's start, cancel and forward run inside a core
 *   call, so the adapter queues each as an effect (effects.h) and the pump
 *   runs the JavaScript invoker at the end of the turn. start answers at
 *   once with a fresh service handle; cancel and forward name it. Effects
 *   stay in order, so a cancel queued in the same turn as its start follows
 *   it.
 * - The in-system SCXML invoker (type "http://www.w3.org/TR/scxml/", which
 *   core also gives "scxml"): start spawns the child in the same system with
 *   core's parent link, so core routes #_<invokeid>, #_parent and
 *   done.invoke itself, and tells the scheduler about the child. The child
 *   is the definition nested for the invoke when its parent was defined, the
 *   registered definition its content or src names, or chart text the
 *   Node-API layer compiles for it (system->child_definition, napi ADR 0024).
 *   The invoke's
 *   params become the child's data-model binding. cancel destroys the child;
 *   forward posts the event to the child's mailbox.
 */
#include "tinyactors.h"

typedef struct tna_system tna_system;

ta_invoker tna_js_invoker_adapter(tna_system *system);
/* Registers the SCXML invoker on core; called when a system is created. */
ta_result tna_scxml_invoker_register(tna_system *system);
