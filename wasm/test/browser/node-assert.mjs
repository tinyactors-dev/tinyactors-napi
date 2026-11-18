// node:assert/strict in a page (wasm/test/documentation.mjs's import map):
// what the example applications' tests use of it (examples/*/test.mjs),
// with node's strict meaning: equal is Object.is, deepEqual compares
// prototypes, own enumerable keys and the values of Maps, Sets, Dates,
// typed arrays and errors; throws and rejects take a RegExp, a class, a
// validation function or an object whose keys the error must match.
export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
  }
}

const show = (value) => {
  try {
    return JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? `${v}n` : v)) ?? String(value);
  } catch {
    return String(value);
  }
};

function fail(message, fallback) {
  if (message instanceof Error) throw message;
  throw new AssertionError(message ?? fallback);
}

function same(a, b, seen = new Map()) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (ArrayBuffer.isView(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  }
  if (a instanceof Error && (a.message !== b.message || a.name !== b.name)) return false;
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !same(value, b.get(key), seen)) return false;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key], seen));
}

function matchesError(error, expected) {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(String(error?.message ?? error)) || expected.test(String(error));
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && error instanceof expected) return true;
    if (Error.isPrototypeOf(expected) || expected === Error) return false;
    return expected(error) === true;
  }
  return Object.keys(expected).every((key) => {
    const want = expected[key];
    const got = error?.[key];
    return want instanceof RegExp && typeof got === 'string' ? want.test(got) : same(got, want);
  });
}

export function ok(value, message) {
  if (!value) fail(message, `expected a truthy value, got ${show(value)}`);
}

export function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) fail(message, `${show(actual)} !== ${show(expected)}`);
}

export function notEqual(actual, expected, message) {
  if (Object.is(actual, expected)) fail(message, `${show(actual)} === ${show(expected)}`);
}

export function deepEqual(actual, expected, message) {
  if (!same(actual, expected)) fail(message, `not deeply equal:\n  ${show(actual)}\n  ${show(expected)}`);
}

export function notDeepEqual(actual, expected, message) {
  if (same(actual, expected)) fail(message, `deeply equal: ${show(actual)}`);
}

export function match(string, pattern, message) {
  if (typeof string !== 'string' || !pattern.test(string)) fail(message, `${show(string)} does not match ${pattern}`);
}

export function throws(body, expected, message) {
  try {
    body();
  } catch (error) {
    if (!matchesError(error, expected)) fail(typeof expected === 'string' ? expected : message, `the error does not match: ${String(error)}`);
    return;
  }
  fail(typeof expected === 'string' ? expected : message, 'missing the expected exception');
}

export async function rejects(promise, expected, message) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    if (!matchesError(error, expected)) fail(typeof expected === 'string' ? expected : message, `the rejection does not match: ${String(error)}`);
    return;
  }
  fail(typeof expected === 'string' ? expected : message, 'missing the expected rejection');
}

export const strictEqual = equal;
export const notStrictEqual = notEqual;
export const deepStrictEqual = deepEqual;
export const notDeepStrictEqual = notDeepEqual;

const assert = Object.assign((value, message) => ok(value, message), {
  AssertionError, ok, equal, notEqual, deepEqual, notDeepEqual, match, throws, rejects, strictEqual, notStrictEqual, deepStrictEqual,
  notDeepStrictEqual,
});
assert.strict = assert;
export default assert;
