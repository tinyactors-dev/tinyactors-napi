'use strict';

// Scopes and variables. Every frame of a thread shows the same seven
// scopes, because they belong to the actor, not to a frame:
//
// | Data model    | the live data root, read again on each expansion; writable |
// | Event         | _event of the step the actor is in, or of its last one     |
// | Configuration | the active states as a tree, and what each history state recorded |
// | Queues        | the internal queue, the macrostep's event, and the host mailbox |
// | Timers        | pending delayed sends: event, target, when each is due     |
// | Invocations   | invocations, and the thread of an in-system child          |
// | System        | _sessionid, _name, the time, the definition, scheduling    |
//
// A variablesReference is valid until the system runs again (reset()).
// Reading runs no code of the operator's; writing a Data model variable
// takes a JSON value (or an expression, with the `evaluate` permission).

const { core } = require('../native');
const { TinyactorsError } = require('../errors');
const { locationText, valueAt } = require('./expressions');

const SCOPES = ['Data model', 'Event', 'Configuration', 'Queues', 'Timers', 'Invocations', 'System'];
const PREVIEW = 60;
// The Event scope names _event's fields as SCXML spells them.
const SCXML_EVENT_NAMES = { sendID: 'sendid', originType: 'origintype' };

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'function') return 'function';
  return typeof value;
}

function preview(value) {
  switch (typeof value) {
    case 'undefined': return 'undefined';
    case 'bigint': return `${value}n`;
    case 'function': return `function ${value.name || '(anonymous)'}`;
    case 'symbol': return value.toString();
    default: break;
  }
  let text;
  try {
    text = JSON.stringify(value, (key, inner) => (typeof inner === 'bigint' ? `${inner}n` : inner));
  } catch {
    text = undefined;
  }
  if (text === undefined) text = String(value);
  if (text.length <= PREVIEW) return text;
  if (Array.isArray(value)) return `[…] ${value.length} items`;
  if (value !== null && typeof value === 'object') return `{…} ${Object.keys(value).length} keys`;
  return `${text.slice(0, PREVIEW)}…`;
}

const container = (value) => value !== null && typeof value === 'object' && Object.keys(value).length > 0;

class Variables {
  #refs = new Map();
  #next = 0;
  #host;

  /**
   * `host` gives what the scopes read: `system`, `native`, `labels`,
   * `thread(id)`, `eventOf(thread)`, `mailboxNote(thread, message)`,
   * `threadOfInvocation(invocation)`.
   */
  constructor(host) {
    this.#host = host;
  }

  reset() {
    this.#refs.clear();
  }

  #add(entry) {
    this.#next += 1;
    this.#refs.set(this.#next, entry);
    return this.#next;
  }

  #entry(reference) {
    const entry = this.#refs.get(Number(reference));
    if (entry === undefined) {
      throw new TinyactorsError(`variablesReference ${reference} is not valid (any more)`, 'invalid');
    }
    return entry;
  }

  scopes(thread) {
    return SCOPES.map((name) => ({
      name,
      variablesReference: this.#add(name === 'Data model' ? { kind: 'data', thread: thread.id, path: [] }
        : { kind: 'scope', thread: thread.id, name }),
      expensive: false,
      ...(name === 'Data model' ? { presentationHint: 'locals' } : {}),
    }));
  }

  /** A value as evaluate answers it: text, and a reference when it has children. */
  present(value, data) {
    const body = { result: preview(value), type: typeOf(value), variablesReference: 0 };
    if (container(value)) {
      body.variablesReference = this.#add(data ?? { kind: 'value', value });
      if (Array.isArray(value)) body.indexedVariables = value.length;
      else body.namedVariables = Object.keys(value).length;
    }
    return body;
  }

  /** The children of a reference, paged by `start` and `count`. */
  variables(reference, { start = 0, count = 0, filter } = {}) {
    const entry = this.#entry(reference);
    let children = this.#children(entry);
    if (filter === 'indexed' || filter === 'named') {
      children = children.filter((child) => (filter === 'indexed') === child.indexed);
    }
    children = children.slice(start);
    if (count > 0) children = children.slice(0, count);
    return children.map((child) => child.variable);
  }

  /**
   * The data-model location a Variables-pane variable names, as
   * { thread, path }, or undefined for any other variable.
   */
  location(reference, name) {
    const entry = this.#refs.get(Number(reference));
    if (entry === undefined || entry.kind !== 'data') return undefined;
    const thread = this.#host.thread(entry.thread);
    const parent = valueAt(this.#host.system.inspect(thread.actor).data, entry.path);
    return { thread, path: [...entry.path, keyOf(parent, name)] };
  }

  /** Writes `value` at a Data model variable; answers the DAP setVariable body. */
  set(reference, name, value) {
    const entry = this.#entry(reference);
    if (entry.kind !== 'data') {
      throw new TinyactorsError('only the Data model can be written; the other scopes are views of core state', 'invalid');
    }
    const thread = this.#host.thread(entry.thread);
    const root = this.#host.system.inspect(thread.actor).data;
    const parent = valueAt(root, entry.path);
    if (parent === null || typeof parent !== 'object') {
      throw new TinyactorsError(`${locationText(entry.path) || 'the data root'} is not an object any more`, 'invalid');
    }
    const key = keyOf(parent, name);
    parent[key] = value;
    const body = this.present(value, { kind: 'data', thread: entry.thread, path: [...entry.path, key] });
    return { value: body.result, type: body.type, variablesReference: body.variablesReference,
             indexedVariables: body.indexedVariables, namedVariables: body.namedVariables };
  }

  #children(entry) {
    switch (entry.kind) {
      case 'data': {
        const thread = this.#host.thread(entry.thread);
        const value = valueAt(this.#host.system.inspect(thread.actor).data, entry.path);
        return entries(value).map(([key, child, indexed]) => this.#variable(key, child, indexed, {
          evaluateName: locationText([...entry.path, key]),
          data: { kind: 'data', thread: entry.thread, path: [...entry.path, key] },
        }));
      }
      case 'value':
        return entries(entry.value).map(([key, child, indexed]) => this.#variable(key, child, indexed, {}));
      default:
        return this.#scope(this.#host.thread(entry.thread), entry.name)
          .map(([key, child]) => this.#variable(key, child, false, {}));
    }
  }

  #variable(key, value, indexed, { evaluateName, data }) {
    const variable = { name: indexed ? `[${key}]` : String(key), value: preview(value), type: typeOf(value),
                       variablesReference: 0 };
    if (evaluateName !== undefined) variable.evaluateName = evaluateName;
    if (container(value)) {
      variable.variablesReference = this.#add(data ?? { kind: 'value', value });
      if (Array.isArray(value)) variable.indexedVariables = value.length;
      else variable.namedVariables = Object.keys(value).length;
    }
    return { variable, indexed };
  }

  // The read-only scopes, as [name, value] pairs.
  #scope(thread, name) {
    const { system } = this.#host;
    const view = system.inspect(thread.actor);
    switch (name) {
      // _event's SCXML names, as the test host's adapter shows them.
      case 'Event': return Object.entries(this.#host.eventOf(thread, view) ?? {})
        .map(([key, value]) => [SCXML_EVENT_NAMES[key] ?? key, value]);
      case 'Configuration': return this.#configuration(thread, view);
      case 'Queues': return [
        ['internal', view.internalEvents],
        ['current', view.currentEvent],
        ['mailbox', system.mailbox(thread.actor).map((message) => this.#host.mailboxNote(message))],
      ];
      case 'Timers': return view.delayedSends.map((send, index) => [send.id ?? `(no ID) ${index + 1}`, {
        event: send.event, target: send.destination ?? send.target, due: send.due, in: `${send.due - system.time}ms`,
        data: send.data, submitted: send.submitted,
      }]);
      case 'Invocations': return view.invocations.map((invocation) => {
        const child = this.#host.threadOfInvocation(invocation);
        return [this.#host.labels.invocation(invocation.id), { type: invocation.type, active: invocation.active,
                                         autoforward: invocation.autoforward,
                                         thread: child === undefined ? null : `${child.id} ${child.label}` }];
      });
      case 'System': return [
        ['_sessionid', String(view.sessionID)],
        ['_name', this.#host.documentName(view)],
        ['now', system.time],
        ['actor', `${view.actor.slot}:${view.actor.generation}`],
        ['definition', { ...view.definition, id: String(view.definitionID) }],
        ['residency', view.residency],
        ['scheduling', view.scheduling],
        ['published', view.published],
        ['allocatedBytes', view.allocatedBytes],
      ];
      default: return [];
    }
  }

  #configuration(thread, view) {
    const { labels, native } = this.#host;
    const definition = view.definitionID;
    const states = labels.states(definition);
    const tree = {};
    for (const name of view.activeStates) {
      const chain = [];
      let at = states.find((state) => state.name === name);
      while (at !== undefined) {
        chain.unshift(at.name);
        at = at.parent === null ? undefined : states[at.parent];
      }
      let node = tree;
      for (const link of chain) {
        node[link] ??= {};
        node = node[link];
      }
    }
    const pairs = [['active', tree]];
    const history = {};
    for (const state of states) {
      if (state.kind.startsWith('history')) {
        const recorded = core.actor_history(native, thread.actor.slot, thread.actor.generation, state.id);
        history[state.name] = recorded.map((id) => labels.state(definition, id));
      }
    }
    if (Object.keys(history).length > 0) pairs.push(['history', history]);
    return pairs;
  }
}

function entries(value) {
  if (Array.isArray(value)) return value.map((child, index) => [index, child, true]);
  if (value !== null && typeof value === 'object') return Object.entries(value).map(([key, child]) => [key, child, false]);
  return [];
}

// The key a variable's name stands for in its container: `[3]` of an array.
function keyOf(parent, name) {
  const match = /^\[(\d+)\]$/.exec(name);
  return Array.isArray(parent) && match !== null ? Number(match[1]) : name;
}

module.exports = { Variables, preview, typeOf };
