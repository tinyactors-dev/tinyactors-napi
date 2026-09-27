'use strict';

// Macrosteps of the sessions a debug session watches, read from the spans
// of each turn (napi ADR 0016's mapping, decoded with decodeTraces()). A
// macrostep's microstep spans end as the next microstep begins, possibly in
// an earlier turn than the macrostep's own span, so they wait here until
// the macrostep ends. Lifecycle spans (finished, destroyed, unloaded) are
// passed on as they come.

const { decodeTraces } = require('../otlp');

const LIFECYCLE = new Set(['scxml.spawned', 'scxml.loaded', 'scxml.unloaded', 'scxml.finished', 'scxml.destroyed',
                           'scxml.withdrawn']);

class Macrosteps {
  // session ID text -> Map(macrostep number -> microstep spans)
  #open = new Map();
  #wanted;

  /** `wanted(session)` says whether a session (decimal text) is one to follow. */
  constructor(wanted) {
    this.#wanted = wanted;
  }

  /**
   * Reads one turn's trace bytes. Returns { macrosteps, lifecycle }: each
   * macrostep that ended, as Macrosteps.record() describes it, and each
   * lifecycle span as { session, kind, attributes }.
   */
  read(bytes) {
    const out = { macrosteps: [], lifecycle: [] };
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      return out;
    }
    for (const span of decodeTraces(bytes)) {
      const session = span.attributes['scxml.session_id'];
      if (session === undefined || !this.#wanted(session)) {
        continue;
      }
      if (LIFECYCLE.has(span.name)) {
        out.lifecycle.push({ session, kind: span.name.slice('scxml.'.length), attributes: span.attributes });
      } else if (span.name.startsWith('scxml.microstep')) {
        this.#microsteps(session, span.attributes['scxml.macrostep']).push(span);
      } else if (span.name.startsWith('scxml.macrostep')) {
        const number = span.attributes['scxml.macrostep'];
        const microsteps = this.#microsteps(session, number);
        this.#open.get(session).delete(number);
        out.macrosteps.push(record(session, span, microsteps));
      }
    }
    return out;
  }

  /** Forgets what waits for a session that went away. */
  forget(session) {
    this.#open.delete(session);
  }

  #microsteps(session, number) {
    let bySession = this.#open.get(session);
    if (bySession === undefined) {
      bySession = new Map();
      this.#open.set(session, bySession);
    }
    let list = bySession.get(number);
    if (list === undefined) {
      list = [];
      bySession.set(number, list);
    }
    return list;
  }
}

const list = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/*
 * { session, number, definition, event: { name, type, data } | null,
 *   microsteps: [{ number, event, transitions, transitionIDs, exited, entered, jump }],
 *   records: [{ name, attributes }] in the order they happened,
 *   states, incomplete }
 */
function record(session, span, microsteps) {
  const attributes = span.attributes;
  const events = [];
  const steps = microsteps
    .map((micro) => {
      const a = micro.attributes;
      for (const event of micro.events) events.push(event);
      const transitions = list(a['scxml.transition']);
      return {
        number: a['scxml.microstep'],
        event: a['scxml.event.name'],
        transitions,
        transitionIDs: list(a['scxml.transition.id']),
        exited: list(a['scxml.state.exited']),
        entered: list(a['scxml.state.entered']),
        // An operator transition names no chart transition (core ADR 0082).
        jump: transitions.length === 0 && a['scxml.microstep'] !== undefined && attributes['scxml.macrostep'] !== 1,
      };
    })
    .sort((left, right) => left.number - right.number);
  for (const event of span.events) events.push(event);
  events.sort((left, right) => (left.timeUnixNano < right.timeUnixNano ? -1 : left.timeUnixNano > right.timeUnixNano ? 1
    : (left.attributes['scxml.microstep'] ?? 0) - (right.attributes['scxml.microstep'] ?? 0)));
  const name = attributes['scxml.event.name'];
  return {
    session,
    number: attributes['scxml.macrostep'],
    definition: attributes['scxml.definition'],
    event: name === undefined ? null : {
      name,
      type: attributes['scxml.event.type'],
      data: attributes['scxml.event.data'],
    },
    microsteps: steps,
    records: events.map((event) => ({ name: event.name, attributes: event.attributes })),
    states: list(attributes['scxml.state']),
    incomplete: attributes['scxml.incomplete'] === true,
    error: span.status.code === 'error',
  };
}

/**
 * The console's summary of a macrostep, as lines: the event, each
 * microstep with what ran in it, and the configuration it ended in. The
 * session writes them as one output, as the test host's adapter does.
 * `location(definition, expressionID)` names an <assign>'s location.
 */
function summarize(macrostep, label, location) {
  const lines = [];
  const event = macrostep.event;
  const head = event === null ? (macrostep.number === 1 ? 'bootstrap' : '(no event)')
    : `${event.name}${event.data === undefined ? '' : ` ${event.data}`}`;
  lines.push(`${label} macrostep ${macrostep.number}: ${head}${macrostep.incomplete ? ' (incomplete)' : ''}`);
  const byMicrostep = new Map();
  const before = [];
  for (const entry of macrostep.records) {
    const micro = entry.attributes['scxml.microstep'];
    if (micro === undefined || micro === 0) {
      before.push(entry);
    } else {
      if (!byMicrostep.has(micro)) byMicrostep.set(micro, []);
      byMicrostep.get(micro).push(entry);
    }
  }
  for (const entry of before) {
    const text = describe(entry, macrostep.definition, location);
    if (text !== undefined) lines.push(`  ${text}`);
  }
  for (const micro of macrostep.microsteps) {
    let taken;
    if (micro.jump) {
      taken = `goto: exited ${micro.exited.join(' ') || 'nothing'}, entered ${micro.entered.join(' ') || 'nothing'}`;
    } else if (micro.transitions.length === 0) {
      taken = 'initial';
    } else {
      taken = micro.transitions.join('; ');
    }
    lines.push(`  ${taken}`);
    for (const entry of byMicrostep.get(micro.number) ?? []) {
      const text = describe(entry, macrostep.definition, location);
      if (text !== undefined) lines.push(`    ${text}`);
    }
  }
  if (macrostep.states.length > 0) {
    lines.push(`  now in ${macrostep.states.join(' ')}`);
  }
  return lines;
}

// One record of a macrostep as a line, or undefined for those not shown.
function describe(entry, definition, location) {
  const a = entry.attributes;
  const value = a['scxml.value'] === undefined ? '' : ` = ${a['scxml.value']}`;
  switch (entry.name) {
    case 'scxml.condition':
      return `${a['scxml.transition'] ?? a['scxml.action'] ?? 'condition'}: ${a['scxml.result'] === true}`;
    case 'scxml.assign': {
      const where = location(definition, a['scxml.expression.id']);
      return `assign ${where ?? `(${a['scxml.action'] ?? 'a location'})`}${value}`;
    }
    case 'scxml.raise':
      return `raise ${a['scxml.event.name']}`;
    case 'scxml.send':
      return `send ${a['scxml.event.name'] ?? ''}${a['scxml.send_id'] === undefined ? '' : ` (${a['scxml.send_id']})`}`;
    case 'scxml.cancel':
      return `cancel ${a['scxml.send_id'] ?? ''}`;
    case 'scxml.error': {
      const message = a['scxml.fault.message'] === undefined ? '' : `: ${a['scxml.fault.message']}`;
      return `failed: ${a['scxml.action'] ?? 'an action'}${message}`;
    }
    case 'scxml.invoke':
      return `invoke ${a['scxml.invoke_id'] ?? ''}`;
    case 'scxml.invoke.cancel':
      return `cancel invocation ${a['scxml.invoke_id'] ?? ''}`;
    case 'scxml.ignored':
      return `${a['scxml.event.name']} enabled no transition`;
    case 'scxml.abandoned':
      return 'abandoned by an operator';
    case 'scxml.stopped':
      return 'the run stopped: an allocation failed';
    default:
      return undefined;
  }
}

module.exports = { Macrosteps, summarize };
