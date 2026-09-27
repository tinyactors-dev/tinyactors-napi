'use strict';

// Expressions over an actor's data model. The JavaScript data model's data
// is plain JavaScript objects (napi ADR 0001), so an expression is
// JavaScript: the data's properties are in scope by name, `this` and `data`
// are the data root, and `event`, `sessionID`, `name` and `inState(state)`
// are what a chart's own expressions see in their context. A leading dot is
// the data root, as in the jq form the test host uses: `.failures`.
//
// Evaluating an expression runs arbitrary code in the process that hosts
// the actor. The debug session lets it only with the `evaluate` permission;
// reading and writing a location by path (the Variables pane, setVariable
// with a JSON value, completions) runs no code of the operator's.

const { TinyactorsError } = require('../errors');

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// `.a.b` → `data.a.b`; anything else is left as it is.
function source(text) {
  const trimmed = text.trim();
  return /^\.[A-Za-z_$]/.test(trimmed) ? `data${trimmed}` : trimmed;
}

function compile(parameters, body) {
  try {
    // A function the Function constructor makes is not strict, so `with`
    // puts the data's properties in scope.
    return new Function(...parameters, body);
  } catch (error) {
    throw new TinyactorsError(`the expression does not parse: ${error.message}`, 'invalid');
  }
}

const SCOPE = ['data', 'event', 'sessionID', 'name', 'inState'];

function argumentsOf(scope) {
  const data = scope.data ?? {};
  return [data, scope.event, scope.sessionID, scope.name, (state) => scope.activeStates?.includes(state) ?? false];
}

/**
 * Evaluates `text` against `scope`: { data, event, sessionID, name,
 * activeStates }. Throws `invalid` when it does not parse, and rethrows what
 * the expression throws, as `invalid` with its message.
 */
function evaluate(text, scope) {
  const fn = compile(SCOPE, `with (data) { return (${source(text)}\n); }`);
  const args = argumentsOf(scope);
  try {
    return fn.apply(args[0], args);
  } catch (error) {
    throw new TinyactorsError(`the expression threw: ${error?.message ?? error}`, 'invalid');
  }
}

/** Assigns `value` to the location expression `text` (`failures`, `.items[0].qty`). */
function assign(text, value, scope) {
  const fn = compile([...SCOPE, '__value'], `with (data) { (${source(text)}) = __value; }`);
  const args = argumentsOf(scope);
  try {
    fn.apply(args[0], [...args, value]);
  } catch (error) {
    throw new TinyactorsError(`the assignment threw: ${error?.message ?? error}`, 'invalid');
  }
}

/**
 * A location as a path of keys, without running code: `failures`,
 * `.items[0].qty`, `data.items[0]`. Undefined when `text` is not a plain
 * path.
 */
function pathOf(text) {
  let rest = text.trim();
  if (rest.startsWith('data.') || rest.startsWith('data[')) rest = rest.slice(4);
  else if (rest.startsWith('this.') || rest.startsWith('this[')) rest = rest.slice(4);
  if (!rest.startsWith('.') && !rest.startsWith('[')) rest = `.${rest}`;
  const path = [];
  const step = /^(?:\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/;
  while (rest !== '') {
    const match = step.exec(rest);
    if (match === null) return undefined;
    if (match[1] !== undefined) path.push(match[1]);
    else if (match[2] !== undefined) path.push(Number(match[2]));
    else path.push(JSON.parse(match[3]));
    rest = rest.slice(match[0].length);
  }
  return path.length === 0 ? undefined : path;
}

/** `.a.b[0]` for a path of keys. */
function locationText(path) {
  return path.map((key) => (typeof key === 'number' ? `[${key}]`
    : IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`)).join('');
}

/** The value at `path` in `root`, or undefined. */
function valueAt(root, path) {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[key];
  }
  return value;
}

/**
 * Completions for the data location that ends `text`: the keys of the
 * object it names that start with what was typed. [{ label, start }] with
 * `start` the column the typed prefix starts at.
 */
function locations(text, root) {
  // `.a.b` or `a.b` (the object, then what was typed of a key), or a bare name.
  const dotted = /((?:\.?[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)?\.([A-Za-z_$][\w$]*)?$/;
  const bare = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/;
  const match = new RegExp(`${dotted.source}|${bare.source}`).exec(text);
  if (match === null || root === null || typeof root !== 'object') return [];
  let container = root;
  let prefix;
  if (match[3] !== undefined) {
    prefix = match[3];
  } else {
    prefix = match[2] ?? '';
    const parent = match[1] === undefined ? [] : pathOf(match[1]);
    if (parent === undefined) return [];
    container = parent.length === 0 ? root : valueAt(root, parent);
  }
  if (container === null || typeof container !== 'object') return [];
  const start = text.length - prefix.length;
  return Object.keys(container).filter((key) => key.startsWith(prefix)).map((label) => ({ label, start }));
}

module.exports = { evaluate, assign, pathOf, locationText, valueAt, locations };
