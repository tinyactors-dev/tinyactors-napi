'use strict';

// Breakpoints: function breakpoints by name, line breakpoints on the
// element a source line holds (core ADR 0085), the exception filters, and
// data breakpoints on data-model locations. Each is found in the records of
// a macrostep that ended (lib/debug/macrosteps). A live actor is never
// stopped, so every breakpoint is a tracepoint: the session says where it
// would have stopped. A line breakpoint with a log message is a logpoint:
// it writes its message instead.

const { TinyactorsError } = require('../errors');

const EXCEPTION_FILTERS = Object.freeze([
  { filter: 'error.execution', label: 'error.execution',
    description: 'An action, a guard or a <data> failed, and core raised error.execution' },
  { filter: 'error.communication', label: 'error.communication',
    description: 'A <send> or an invocation could not reach its target' },
  { filter: 'error.platform', label: 'error.platform', description: 'The platform raised an error event' },
  { filter: 'ignored', label: 'Ignored events',
    description: 'An event was taken and enabled no transition (core ADR 0072)' },
  { filter: 'stopped', label: 'Out of memory', description: 'A run stopped because an allocation failed (core ADR 0070)' },
  { filter: 'runaway', label: 'Runaway macrosteps',
    description: 'A macrostep ran its microstep limit, and the actor was quarantined (core ADR 0075)' },
]);
const FILTERS = EXCEPTION_FILTERS.map((entry) => entry.filter);
const ERRORS = FILTERS.slice(0, 3);

// SCXML event descriptors match by prefix at dot boundaries (SCXML 3.12.1).
function matchesEvent(descriptor, name) {
  if (typeof name !== 'string') return false;
  const bare = descriptor.replace(/\.\*$/, '').replace(/\.$/, '');
  return bare === '*' || name === bare || name.startsWith(`${bare}.`);
}

const normalize = (text) => text.replaceAll('->', '→').replace(/\s+/g, ' ').trim();

// `5` and `>= 5` stop from the fifth hit on, `== 5` only at it, `% 5` at
// every fifth.
function hitConditionMet(text, hits) {
  if (text === undefined || text === null || String(text).trim() === '') return true;
  const match = /^\s*(>=|>|==|<=|<|%)?\s*(\d+)\s*$/.exec(String(text));
  if (match === null) return true;
  const count = Number(match[2]);
  switch (match[1]) {
    case '>': return hits > count;
    case '==': return hits === count;
    case '<=': return hits <= count;
    case '<': return hits < count;
    case '%': return count > 0 && hits % count === 0;
    default: return hits >= count;
  }
}

function parseFunction(name) {
  let match = /^exit:\s*(\S+)$/.exec(name);
  if (match !== null) return { kind: 'exit', target: match[1] };
  match = /^on:\s*(\S+)$/.exec(name);
  if (match !== null) return { kind: 'on', target: match[1] };
  if (/(→|->)/.test(name)) return { kind: 'transition', target: normalize(name) };
  return { kind: 'entry', target: name };
}

function describe(breakpoint) {
  switch (breakpoint.kind) {
    case 'entry': return `entered ${breakpoint.target}`;
    case 'exit': return `exited ${breakpoint.target}`;
    case 'on': return `took ${breakpoint.target}`;
    default: return breakpoint.target;
  }
}

// A line breakpoint's element, as the breakpoint's description names it.
function describeLine(breakpoint) {
  const { element } = breakpoint;
  return `line ${breakpoint.line} (${element.kind} ${element.name ?? element.id})`;
}

// The line breakpoints of one DAP Source are kept under its path, or its
// sourceReference for a virtual source (napi ADR 0026).
const sourceKey = (source) => (source.path !== undefined ? `path ${source.path}` : `reference ${source.sourceReference}`);

// A condition that is not blank.
function hasCondition(breakpoint) {
  return breakpoint.condition !== undefined && breakpoint.condition !== null && String(breakpoint.condition).trim() !== '';
}

class Breakpoints {
  #functions = [];
  #data = [];
  #lines = new Map();
  #filters = new Set();

  /** Whether the client asked to stop for the exception filter `filter`. */
  wants(filter) {
    return this.#filters.has(filter);
  }
  #next = 0;

  #allLines() {
    return [...this.#lines.values()].flatMap(({ entries }) => entries).filter((entry) => entry.element !== undefined);
  }

  /**
   * setBreakpoints for one source, { path } or { sourceReference } (napi
   * ADR 0026): replaces that source's breakpoints. `resolve(line)` answers
   * the element the line stands for, as { element: { kind, id, name },
   * line, column, source }, or a string saying why there is none. Answers
   * DAP Breakpoint objects.
   */
  setLines(source, specs, resolve) {
    const entries = [];
    const answered = specs.map((spec) => {
      const id = (this.#next += 1);
      const found = resolve(Number(spec?.line));
      if (typeof found === 'string' || found === undefined) {
        entries.push({ id, spec });
        return { id, verified: false, message: found ?? `no state, transition or action at line ${spec?.line}` };
      }
      const breakpoint = { id, kind: 'line', spec, line: found.line, element: found.element, condition: spec.condition,
                           hitCondition: spec.hitCondition, logMessage: spec.logMessage, hits: 0 };
      entries.push(breakpoint);
      return { id, verified: true, line: found.line, column: found.column, source: found.source };
    });
    this.#lines.set(sourceKey(source), { source, entries });
    return answered;
  }

  /** The placed breakpoints of every kind that have a condition. */
  get conditioned() {
    const lines = [...this.#lines.values()].flatMap(({ entries }) => entries.filter((entry) => entry.kind === 'line'));
    return [...lines, ...this.#functions, ...this.#data].filter((breakpoint) => hasCondition(breakpoint));
  }

  /** The sources with line breakpoints and what the client asked for, to resolve again later. */
  get lineRequests() {
    return [...this.#lines.values()].map(({ source, entries }) => ({ source, specs: entries.map((entry) => entry.spec),
                                                                      ids: entries.map((entry) => entry.id) }));
  }

  /**
   * Resolves a source's line breakpoints again (after attaching), keeping
   * their IDs. Answers the DAP Breakpoint objects, for `breakpoint` events.
   */
  relocate(source, resolve) {
    const entries = this.#lines.get(sourceKey(source))?.entries ?? [];
    const answered = [];
    this.#lines.set(sourceKey(source), { source, entries: entries.map((entry) => {
      const found = resolve(Number(entry.spec?.line));
      if (typeof found === 'string' || found === undefined) {
        answered.push({ id: entry.id, verified: false,
                        message: found ?? `no state, transition or action at line ${entry.spec?.line}` });
        return { id: entry.id, spec: entry.spec };
      }
      answered.push({ id: entry.id, verified: true, line: found.line, column: found.column, source: found.source });
      return { ...entry, kind: 'line', line: found.line, element: found.element, condition: entry.spec.condition,
               hitCondition: entry.spec.hitCondition, logMessage: entry.spec.logMessage, hits: entry.hits ?? 0 };
    }) });
    return answered;
  }

  /**
   * setFunctionBreakpoints: replaces them all. `check(breakpoint)` answers
   * undefined or why the breakpoint cannot be verified. Answers DAP
   * Breakpoint objects.
   */
  setFunctions(specs, check) {
    this.#functions = [];
    return specs.map((spec) => {
      const name = String(spec?.name ?? '').trim();
      const breakpoint = { id: (this.#next += 1), name, ...parseFunction(name), condition: spec?.condition,
                           hitCondition: spec?.hitCondition, hits: 0 };
      const problem = name === '' ? 'a function breakpoint needs a name' : check(breakpoint);
      if (problem !== undefined) {
        return { id: breakpoint.id, verified: false, message: problem };
      }
      this.#functions.push(breakpoint);
      return { id: breakpoint.id, verified: true };
    });
  }

  setFilters(filters) {
    const unknown = filters.filter((filter) => !FILTERS.includes(filter));
    if (unknown.length > 0) {
      throw new TinyactorsError(`unknown exception filter(s): ${unknown.join(', ')}`, 'invalid');
    }
    this.#filters = new Set(filters);
  }

  /**
   * setDataBreakpoints: replaces them all. A dataId is the thread's label
   * and a path of keys as JSON: `acct_1 ["failures"]`. `check(breakpoint)`
   * as for functions.
   */
  setData(specs, check) {
    this.#data = [];
    return specs.map((spec) => {
      const parsed = Breakpoints.parseDataID(spec?.dataId);
      const id = (this.#next += 1);
      if (parsed === undefined) {
        return { id, verified: false, message: `${JSON.stringify(spec?.dataId)} is not a data-model location` };
      }
      if (spec.accessType !== undefined && spec.accessType !== 'write') {
        return { id, verified: false, message: 'only writes can be watched: core traces assignments, not reads' };
      }
      const breakpoint = { id, ...parsed, dataId: spec.dataId, condition: spec.condition,
                           hitCondition: spec.hitCondition, hits: 0 };
      const problem = check(breakpoint);
      if (problem !== undefined) {
        return { id, verified: false, message: problem };
      }
      this.#data.push(breakpoint);
      return { id, verified: true };
    });
  }

  static dataID(label, path) {
    return `${label} ${JSON.stringify(path)}`;
  }

  // A label can have spaces (`renewal/r1 invocation kid`), so the path is what
  // follows the first ` [` that starts a JSON array.
  static parseDataID(text) {
    if (typeof text !== 'string') return undefined;
    for (let at = text.indexOf(' ['); at > 0; at = text.indexOf(' [', at + 1)) {
      let path;
      try {
        path = JSON.parse(text.slice(at + 1));
      } catch {
        continue;
      }
      return Array.isArray(path) && path.length > 0 ? { label: text.slice(0, at), path } : undefined;
    }
    return undefined;
  }

  /**
   * The hits in a macrostep that ended, of the actor labelled `label`:
   * [{ kind: 'function' | 'exception' | 'data', breakpoints, description,
   * exception }]. `location(expressionID)` names an <assign>'s location;
   * `fires(breakpoint)` confirms a condition.
   */
  hits(macrostep, { label, location, fires, log }) {
    const out = [];
    const exception = this.#exception(macrostep);
    if (exception !== undefined) out.push(exception);
    const lines = this.#allLines().filter((breakpoint) => lineRan(breakpoint.element, macrostep))
      .filter((breakpoint) => this.#fire(breakpoint, fires))
      .filter((breakpoint) => (breakpoint.logMessage ? (log(breakpoint), false) : true));
    if (lines.length > 0) {
      out.push({ kind: 'line', breakpoints: lines.map((entry) => entry.id),
                 description: lines.map(describeLine).join(', ') });
    }
    const functions = this.#functions.filter((breakpoint) => {
      switch (breakpoint.kind) {
        case 'on': return macrostep.event !== null && matchesEvent(breakpoint.target, macrostep.event.name);
        case 'entry': return macrostep.microsteps.some((micro) => micro.entered.includes(breakpoint.target));
        case 'exit': return macrostep.microsteps.some((micro) => micro.exited.includes(breakpoint.target));
        default: return macrostep.microsteps.some((micro) => micro.transitions.some((text) => {
          const shown = normalize(text);
          return shown === breakpoint.target || shown.startsWith(`${breakpoint.target} on `);
        }));
      }
    }).filter((breakpoint) => this.#fire(breakpoint, fires));
    if (functions.length > 0) {
      out.push({ kind: 'function', breakpoints: functions.map((entry) => entry.id),
                 description: functions.map(describe).join(', ') });
    }
    const written = macrostep.records.filter((entry) => entry.name === 'scxml.assign')
      .map((entry) => ({ location: location(entry.attributes['scxml.expression.id']),
                         value: entry.attributes['scxml.value'] }))
      .filter((entry) => entry.location !== undefined);
    const data = this.#data.filter((breakpoint) => breakpoint.label === label &&
      written.some((entry) => overlap(breakpoint.path, entry.location)))
      .filter((breakpoint) => this.#fire(breakpoint, fires));
    if (data.length > 0) {
      const writes = written.filter((entry) => data.some((breakpoint) => overlap(breakpoint.path, entry.location)));
      out.push({ kind: 'data', breakpoints: data.map((entry) => entry.id),
                 description: writes.map((entry) => `${entry.location.join('.')}${entry.value === undefined ? ' written'
                   : ` = ${entry.value}`}`).join(', ') });
    }
    return out;
  }

  #fire(breakpoint, fires) {
    if (hasCondition(breakpoint) && !fires(breakpoint)) {
      return false;
    }
    breakpoint.hits += 1;
    return hitConditionMet(breakpoint.hitCondition, breakpoint.hits);
  }

  #exception(macrostep) {
    if (this.#filters.size === 0) return undefined;
    const candidates = [];
    if (macrostep.event !== null) {
      const filter = ERRORS.find((name) => matchesEvent(name, macrostep.event.name));
      if (filter !== undefined) candidates.push({ filter, name: macrostep.event.name, data: macrostep.event.data });
    }
    let fault;
    for (const entry of macrostep.records) {
      const a = entry.attributes;
      if (entry.name === 'scxml.error') {
        fault = faultText(a);
      } else if (entry.name === 'scxml.raise') {
        const filter = ERRORS.find((name) => matchesEvent(name, a['scxml.event.name']));
        if (filter !== undefined) candidates.push({ filter, name: a['scxml.event.name'], fault });
      } else if (entry.name === 'scxml.ignored') {
        candidates.push({ filter: 'ignored', name: a['scxml.event.name'] });
      } else if (entry.name === 'scxml.stopped') {
        candidates.push({ filter: 'stopped', name: undefined });
      }
    }
    const hit = candidates.find((candidate) => this.#filters.has(candidate.filter));
    if (hit === undefined) return undefined;
    const description = hit.filter === 'ignored' ? `${hit.name} enabled no transition`
      : hit.filter === 'stopped' ? 'an allocation failed; the run stopped where it stood'
        : [hit.name, hit.fault].filter((part) => part !== undefined).join(': ');
    return { kind: 'exception', breakpoints: [], description, exception: hit };
  }
}

// What faulted and why, from a record's attributes: the action (or the
// transition whose guard failed) and the fault's message, as the test
// host's adapter says it too.
function faultText(a) {
  const parts = [a['scxml.action'] ?? a['scxml.transition'], a['scxml.fault.message']]
    .filter((part) => part !== undefined && part !== '');
  return parts.length === 0 ? a['scxml.fault.detail'] : parts.join(': ');
}

// Whether a macrostep ran the element a line breakpoint stands for.
function lineRan(element, macrostep) {
  switch (element.kind) {
    case 'state': return macrostep.microsteps.some((micro) => micro.entered.includes(element.name));
    case 'transition': return macrostep.microsteps.some((micro) => micro.transitionIDs.includes(element.id));
    default: return macrostep.records.some((entry) => entry.attributes['scxml.action.id'] === element.id);
  }
}

// A write to `written` touches `watched` when one path is a prefix of the other.
function overlap(watched, written) {
  const length = Math.min(watched.length, written.length);
  for (let at = 0; at < length; at += 1) {
    if (String(watched[at]) !== String(written[at])) return false;
  }
  return true;
}

module.exports = { Breakpoints, EXCEPTION_FILTERS, matchesEvent };
