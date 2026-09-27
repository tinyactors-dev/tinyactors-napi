'use strict';

// Where a chart's elements were written (core ADR 0085): statechart()
// records the file, line and column of the builder call that wrote each
// state, transition, initial transition and action, define(text, { format:
// 'scxml', name }) records where in the named document each one is, and
// Definition.sourceOf() reads one back by core's ID. This is how the
// debugger gives stack frames a source, maps a line breakpoint to the
// element on that line, answers breakpointLocations, and puts goto targets
// on lines.
//
// A chart whose spans name no file a client can open (an SCXML document
// defined without a name, a child chart inline in its parent's <content>,
// a child fetched from a URI that is not a file) is shown as a virtual
// source instead (napi ADR 0026): the SCXML the codec writes from the
// definition, with where it wrote each element (core ADR 0085,
// ta_definition_encode with its source map), which the client asks for by
// `sourceReference`. A chart SCXML cannot express (a builder chart whose
// expressions are functions) and that keeps no spans has neither, and the
// adapter then works as it did before: frames on line 0, lines unverified.

const { core } = require('../native');
const { Definition } = require('../definition');
const { TinyactorsError } = require('../errors');

const KINDS = ['state', 'transition', 'action'];
const SCXML = 'application/scxml+xml';

// A span's source as a path a client can open, or undefined: a `file:`
// URL loses its scheme, and a URI of any other scheme is not a file. A
// Windows drive letter is not a scheme.
function pathOf(source) {
  if (typeof source !== 'string' || source === '') return undefined;
  if (source.startsWith('file://')) return decodeURIComponent(source.slice('file://'.length));
  if (source.startsWith('file:')) return decodeURIComponent(source.slice('file:'.length));
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(source) ? undefined : source;
}

const basename = (path) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

// Whether a client's path names the same file as a span's.
function samePath(left, right) {
  if (left === undefined || right === undefined) return false;
  const a = left.replaceAll('\\', '/');
  const b = right.replaceAll('\\', '/');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// Whether an element is in the DAP Source a client named: a virtual source
// by its reference, a file by its path.
function inSource(element, source) {
  const reference = Number(source?.sourceReference ?? 0);
  if (reference > 0) return element.reference === reference;
  return samePath(source?.path, element.path);
}

class Sources {
  #system;
  #native;
  #allocate;
  #elements = new Map();
  // Definition → its virtual source: { reference, name, text }, or null
  // when it has none. The reference outlives forget(), so a breakpoint set
  // on it is placed again when the chart is defined again.
  #virtuals = new Map();
  #references = new Map();

  /** `allocate()` answers a new sourceReference, unique in the session. */
  constructor(system, native, allocate) {
    this.#system = system;
    this.#native = native;
    this.#allocate = allocate;
  }

  /**
   * Where one element was written, or undefined: { path, line, column } in
   * a file, or { reference, name, line, column } in a virtual source, as
   * elements() lists it.
   */
  place(definition, kind, id) {
    if (id === null || id === undefined) return undefined;
    return this.elements(definition).find((element) => element.kind === kind && element.id === id);
  }

  /** The DAP Source object for a place. */
  static source(place) {
    if (place.path !== undefined) return { name: basename(place.path), path: place.path };
    return { name: place.name, sourceReference: place.reference, origin: 'SCXML written from the definition' };
  }

  /**
   * Every located state, transition and action of a definition, as { kind,
   * id, path, line, column } or { kind, id, reference, name, line, column },
   * by line.
   */
  elements(definition) {
    const key = String(definition);
    let list = this.#elements.get(key);
    if (list !== undefined) return list;
    list = this.#inFiles(definition);
    if (list.length === 0) {
      const virtual = this.#virtual(definition);
      list = virtual === null ? [] : virtual.elements;
    }
    list.sort((left, right) => left.line - right.line || (left.column ?? 0) - (right.column ?? 0));
    this.#elements.set(key, list);
    return list;
  }

  /** The files a definition's spans name. */
  files(definition) {
    return [...new Set(this.elements(definition).filter((element) => element.path !== undefined)
      .map((element) => element.path))];
  }

  /** The DAP Source of a definition's virtual source, or undefined when it has none. */
  virtualSource(definition) {
    const first = this.elements(definition).find((element) => element.reference !== undefined);
    return first === undefined ? undefined : Sources.source(first);
  }

  /** The text of a virtual source, as the `source` request answers it, or undefined. */
  content(reference) {
    for (const virtual of this.#virtuals.values()) {
      if (virtual !== null && virtual.reference === Number(reference)) {
        return { content: virtual.text, mimeType: SCXML };
      }
    }
    return undefined;
  }

  /**
   * The element a line breakpoint in `source` (a DAP Source) at `line`
   * stands for: the first element on that line, else the nearest one after
   * it; an action before a transition before a state on the same line, as
   * the innermost element there. Undefined when the source holds none of
   * the definition's elements.
   */
  locate(definition, source, line) {
    const inFile = this.elements(definition).filter((element) => inSource(element, source));
    const rank = { action: 0, transition: 1, state: 2 };
    const byRank = (list) => [...list].sort((left, right) => rank[left.kind] - rank[right.kind]);
    const on = inFile.filter((element) => element.line === line);
    if (on.length > 0) return byRank(on)[0];
    const after = inFile.filter((element) => element.line > line);
    if (after.length === 0) return undefined;
    const next = after[0].line;
    return byRank(after.filter((element) => element.line === next))[0];
  }

  /** The elements of `source` (a DAP Source) on the lines from `line` to `endLine`. */
  lines(definition, source, line, endLine = line) {
    return this.elements(definition).filter((element) => inSource(element, source) &&
      element.line >= line && element.line <= endLine);
  }

  /**
   * Forgets what was read of a definition. A chart defined again after it
   * moved is answered by the same definition (core ADR 0077), which then
   * says where the chart is written now (core ADR 0085).
   */
  forget(definition) {
    this.#elements.delete(String(definition));
    this.#virtuals.delete(String(definition));
  }

  // The elements whose spans name a file.
  #inFiles(definition) {
    const facade = new Definition(this.#system, this.#native, definition);
    const list = [];
    for (const [kind, count] of this.#counts(definition)) {
      for (let id = 0; id < count; id += 1) {
        const found = facade.sourceOf(kind, id);
        const path = pathOf(found?.source);
        if (path !== undefined && found.line > 0) list.push({ kind, id, path, line: found.line, column: found.column });
      }
    }
    return list;
  }

  #counts(definition) {
    const counts = core.definition_inspect(this.#native, definition);
    return [['state', counts.state_count], ['transition', counts.transition_count], ['action', counts.action_count]];
  }

  // The chart written as SCXML, with its elements' places in that text, or
  // null when SCXML cannot express it.
  #virtual(definition) {
    const key = String(definition);
    if (this.#virtuals.has(key)) return this.#virtuals.get(key);
    let encoded;
    try {
      encoded = this.#native.encodeDefinition(BigInt(definition));
    } catch (error) {
      if (!(error instanceof TinyactorsError && (error.code === 'unsupported' || error.code === 'not-found'))) throw error;
      this.#virtuals.set(key, null);
      return null;
    }
    let reference = this.#references.get(key);
    if (reference === undefined) {
      reference = this.#allocate();
      this.#references.set(key, reference);
    }
    const family = core.definition_inspect(this.#native, definition).identity.family.name;
    const name = `${family}.scxml`;
    const elements = [];
    for (const kind of KINDS) {
      encoded.spans[kind].forEach((span, id) => {
        if (span !== null) elements.push({ kind, id, reference, name, line: span.line, column: span.column });
      });
    }
    const virtual = { reference, name, text: encoded.text, elements };
    this.#virtuals.set(key, virtual);
    return virtual;
  }
}

module.exports = { Sources };
