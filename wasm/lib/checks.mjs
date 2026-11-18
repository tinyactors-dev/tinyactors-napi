// The checks of the API's arguments, as the addon makes them (src/host.c,
// src/values.c): each a TypeError naming what was expected, never a value
// wrapped or saturated.

// A session an input takes: a bigint from 1 to 2^64-1, or a number that is
// a safe integer from 1; as a bigint.
export function sessionOf(value) {
  if (typeof value === 'bigint') {
    if (value >= 1n && value < 1n << 64n) return value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return BigInt(value);
  throw new TypeError('a session is a bigint from 1 to 2^64-1 or a safe integer from 1');
}

// A non-negative integer at most `limit` (2^32-1 unless said).
export function countOf(value, what, limit = 4294967295) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= limit) return value;
  throw new TypeError(what);
}

// Bytes in: a Uint8Array (a Buffer too) or an ArrayBuffer, as a Uint8Array
// over the same memory.
export function bytesOf(value, what) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(what);
}

// Text: a string, else a TypeError naming `what`.
export function textOf(value, what) {
  if (typeof value !== 'string') throw new TypeError(what);
  return value;
}

// Optional text: undefined and null are none (''), else a string.
export function optionalText(value, what) {
  if (value === undefined || value === null) return '';
  return textOf(value, what);
}

// Every own key of `object` one of `names`: an option misspelled is
// refused, not ignored.
export function onlyKnown(object, names, what) {
  for (const key of Object.keys(object)) {
    if (!names.includes(key)) throw new TypeError(`unknown ${what}: ${key}`);
  }
}

// Options of an input: undefined, or an object of `names`.
export function inputOptions(value, names, what) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') throw new TypeError('options are an object');
  onlyKnown(value, names, what);
  return value;
}
