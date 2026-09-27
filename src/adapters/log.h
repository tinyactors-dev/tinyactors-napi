#pragma once
/*
 * The buffered log sink (core ADR 0045, ADR 0001 rule 3). Core writes a
 * <log> record inside a core call; the adapter queues it as an effect
 * (effects.h), copying the label and retaining the value, and the pump hands
 * it to the JavaScript sink at the end of the turn. Installed only while a
 * sink is set: without one, a <log> only evaluates its expression.
 */
#include "tinyactors.h"

typedef struct tna_system tna_system;

ta_log_sink tna_log_sink_adapter(tna_system *system);
