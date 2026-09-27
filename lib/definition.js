'use strict';

// Definition facade (ADRs 0001 and 0013). A Definition is a system and a
// definition ID, and nothing else: its identity, inspection and retired flag
// are read from core on every access, so the addon keeps no copy of a fact
// core owns.

const { core } = require('./native');
const { TinyactorsError } = require('./errors');

const utf8 = new TextDecoder('utf-8', { fatal: true });

// Core stores a revision as bytes. It reads back as a string when the bytes
// are valid UTF-8, and as a Uint8Array otherwise.
function revisionOf(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return new Uint8Array(bytes);
  }
}

function identityOf(identity) {
  return { family: identity.family.name, revision: revisionOf(identity.revision) };
}

class Definition {
  #native;

  constructor(system, native, id) {
    this.#native = native;
    Object.defineProperty(this, 'system', { value: system, enumerable: true });
    Object.defineProperty(this, 'id', { value: id, enumerable: true });
  }

  /** The family and revision, read from core. */
  get identity() {
    return identityOf(core.definition_inspect(this.#native, this.id).identity);
  }

  /**
   * True once retire() has run. Core frees a retired definition as soon as
   * no resident actor uses it, and a freed definition's ID is stale, so
   * `not-found` also means retired: nothing else frees a registered
   * definition while its system is open.
   */
  get retired() {
    try {
      return core.definition_inspect(this.#native, this.id).retired;
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        return true;
      }
      throw error;
    }
  }

  /** A snapshot of core's view of this definition. */
  inspect() {
    const view = core.definition_inspect(this.#native, this.id);
    const inspection = {
      id: view.id,
      identity: identityOf(view.identity),
      datamodel: view.datamodel,
      binding: view.binding,
      retired: view.retired,
      actorCount: view.actor_count,
      stateCount: view.state_count,
      actorFixedBytes: view.actor_fixed_bytes,
      definitionBytes: view.definition_bytes,
      holds: view.holds,
      nestedBy: view.holders,
    };
    // Nesting is reported from parent to child (core ADR 0078): a child can
    // be nested by several parents, so it names none.
    const nested = [];
    for (let invoke = 0; invoke < view.invoke_count; invoke += 1) {
      const child = core.definition_invoke(this.#native, this.id, invoke).nested;
      if (child !== undefined && BigInt(child) !== 0n) {
        nested.push(child);
      }
    }
    if (nested.length > 0) {
      inspection.nested = nested;
    }
    if (view.document_name !== undefined && view.document_name !== '') {
      inspection.name = view.document_name;
    }
    return inspection;
  }

  /**
   * Where element `id` of `kind` ('state', 'transition', 'action' or
   * 'expression') was written (core ADR 0085): the file, and the line and
   * column of its builder call, or undefined when the definition keeps no
   * span for it. A chart built with statechart() records every state,
   * transition, initial transition and action; IDs are core's, as in
   * inspect() and trace records.
   */
  sourceOf(kind, id) {
    let found;
    try {
      found = core.definition_span(this.#native, this.id, kind, id);
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        return undefined;
      }
      throw error;
    }
    const { span, source } = found;
    // Core keeps zero for a column the front end did not know (a spec's
    // span may give only a line); the place leaves it out.
    const place = { source: source ?? '', line: span.line };
    if (span.column !== undefined && span.column !== 0) {
      place.column = span.column;
    }
    if (span.end_line !== undefined && span.end_line !== 0) {
      place.endLine = span.end_line;
      if (span.end_column !== undefined && span.end_column !== 0) {
        place.endColumn = span.end_column;
      }
    }
    if (span.length !== undefined && span.length !== 0) {
      place.offset = Number(span.offset ?? 0n);
      place.length = span.length;
    }
    return place;
  }

  /**
   * Prevent new actors from using this definition. Actors that use it keep
   * running; core frees it when the last one is gone. Idempotent.
   */
  retire() {
    core.system_retire_definition(this.#native, this.id);
  }
}

module.exports = { Definition, identityOf };
