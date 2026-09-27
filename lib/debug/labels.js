'use strict';

// Names for the compiled IDs a debugger shows, read with core's lookups by
// ID (core ADRs 0042 and 0071) and cached: a definition never changes while
// it is registered. Core supplies facts and the host builds labels
// (core ADR 0071 section 3): `active → past_due on payment.failed` for a
// transition, `assign 2` for the second action of its block.

const { core } = require('../native');
const { TinyactorsError } = require('../errors');

const NONE = 4294967295;

class Labels {
  #native;
  #cache = new Map();

  constructor(native) {
    this.#native = native;
  }

  static none(id) {
    return id === undefined || id === null || id === NONE;
  }

  // One lookup, cached; undefined when core does not know it.
  #lookup(definition, kind, id, fetch) {
    const key = `${definition}:${kind}:${id}`;
    if (this.#cache.has(key)) {
      return this.#cache.get(key);
    }
    let value;
    try {
      value = fetch();
    } catch (error) {
      if (!(error instanceof TinyactorsError && (error.code === 'not-found' || error.code === 'invalid'))) {
        throw error;
      }
    }
    this.#cache.set(key, value);
    return value;
  }

  /** { id, parent, kind } of a state by compiled ID, or undefined. */
  stateInfo(definition, id) {
    if (Labels.none(id)) return undefined;
    return this.#lookup(definition, 'state', id, () => core.definition_state(this.#native, definition, id));
  }

  /** A state's author ID, or undefined. */
  state(definition, id) {
    return this.stateInfo(definition, id)?.id;
  }

  /** Every state of the definition as { id, name, parent, kind }, in document order. */
  states(definition) {
    return this.#lookup(definition, 'states', 0, () => {
      const count = core.definition_inspect(this.#native, definition).state_count;
      const out = [];
      for (let id = 0; id < count; id += 1) {
        const info = core.definition_state(this.#native, definition, id);
        out.push({ id, name: info.id, parent: info.parent === NONE ? null : info.parent, kind: info.kind });
      }
      return out;
    });
  }

  /** The compiled ID of the state named `name`, or undefined. */
  stateID(definition, name) {
    return this.states(definition).find((state) => state.name === name)?.id;
  }

  /**
   * The text of an invocation's ID (core ADR 0049): the author's `<invoke
   * id>`, or the one core generated; its number when core no longer has it.
   */
  invocation(id) {
    try {
      return core.system_invoke_id_text(this.#native, id);
    } catch {
      return String(id);
    }
  }

  /** `source → targets on event`: the label the trace encoder writes too. */
  transition(definition, id) {
    const info = this.#lookup(definition, 'transition', id, () => core.definition_transition(this.#native, definition, id));
    if (info === undefined) return `transition ${id}`;
    const source = this.state(definition, info.source) ?? 'the document';
    const targets = info.targets.map((target) => this.state(definition, target));
    let text = targets.length === 0 ? source : `${source} → ${targets.join(' ')}`;
    if (info.event !== undefined && info.event !== '') text += ` on ${info.event}`;
    return info.type === 'internal' ? `${text} (internal)` : text;
  }

  /** { kind, block, owner, block_index, index } of an action, or undefined. */
  actionInfo(definition, id) {
    if (Labels.none(id)) return undefined;
    return this.#lookup(definition, 'action', id, () => core.definition_action(this.#native, definition, id));
  }

  /** `assign 2`: the element and its place in its block, from 1. */
  action(definition, id) {
    const info = this.actionInfo(definition, id);
    return info === undefined ? `action ${id}` : `${info.kind} ${info.index + 1}`;
  }

  /** The <if> and <foreach> actions around an action, innermost first. */
  enclosing(definition, id) {
    const chain = [];
    let info = this.actionInfo(definition, id);
    while (info !== undefined && ['then', 'else', 'foreach'].includes(info.block)) {
      chain.push(info.owner);
      info = this.actionInfo(definition, info.owner);
    }
    return chain;
  }

  /** An expression's source text, or undefined for a JavaScript function. */
  expression(definition, id) {
    if (Labels.none(id)) return undefined;
    const text = this.#lookup(definition, 'expression', id, () => core.definition_expression(this.#native, definition, id));
    return typeof text === 'string' ? text : undefined;
  }

  /** The event descriptors the definition's transitions listen for, sorted. */
  events(definition) {
    return this.#lookup(definition, 'events', 0, () => {
      const count = core.definition_inspect(this.#native, definition).transition_count;
      const names = new Set();
      for (let id = 0; id < count; id += 1) {
        const event = core.definition_transition(this.#native, definition, id).event;
        for (const name of (event ?? '').split(/\s+/)) {
          if (name !== '') names.add(name);
        }
      }
      return [...names].sort();
    });
  }
}

module.exports = { Labels, NONE };
