// Charts the tests share, on the ECMAScript datamodel the test task names
// (TA_NAPI_DATAMODEL, or a page's runner: test/runtime.mjs; each file runs
// once on "native" and once on "quickjs"; "native", the default, when run
// on its own), and the helpers that make a host run them. Actors are
// observed with what the inputs give: an actor that reaches a final state
// ends, so host.actor stops finding it (named() below).
import { compileCharts, Host, StaleError, TinyactorsError } from '@tinyactors/node';
import { datamodel, macrotask, wasm } from './runtime.mjs';

export const DATAMODEL = datamodel;
/** The Host options that name the datamodel under test. */
export const ENGINE = { datamodel: DATAMODEL };
/** The Host options that name the system. */
export const CONFIG = { system: 't' };
/** The label a snapshot of the package under test holds: each package
 * labels its own, and refuses the other's. */
export const LABEL = wasm ? 'tinyactors-wasm' : 'tinyactors-napi';

/** An SCXML document `name` whose body is `body`. */
export function scxml(name, body, { datamodel = 'ecmascript', initial = 's' } = {}) {
  return `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="${datamodel}" name="${name}" initial="${initial}">\n${body}\n</scxml>`;
}

/** The image of `charts`, an object of name -> text, read before the
 * compile result is closed. */
export function image(charts) {
  const compiled = compileCharts(Object.entries(charts).map(([name, text]) => ({ name: `${name}.scxml`, text })));
  try {
    return compiled.image;
  } finally {
    compiled.close();
  }
}

/** A host on the datamodel under test running `charts` (an object of
 * name -> text), with `options` over the system and the datamodel. */
export function hostWith(charts, options = {}) {
  return new Host(image(charts), { ...CONFIG, ...ENGINE, ...options });
}

/** The session of the live actor named `name`, or undefined. */
export function named(host, name) {
  try {
    return host.actor(name).id;
  } catch (error) {
    if (error instanceof StaleError) return undefined;
    throw error;
  }
}

/** An I/O processor whose receive is `receive`. */
export const processor = (receive) => ({ receive });

/** A chart that ends on `event` whose data's `n` is 1. */
export const WAITER = scxml('waiter', `
  <state id="s"><transition event="go" cond="_event.data &amp;&amp; _event.data.n === 1" target="done"/></state>
  <final id="done"/>`);

/** A chart that ends on `event`, whatever its data. */
export const ENDER = scxml('ender', `
  <state id="s"><transition event="go" target="done"/></state>
  <final id="done"/>`);

/** Whether two byte arrays (Uint8Arrays: a Buffer is one) hold the same bytes. */
export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Where `needle`'s bytes first appear in `bytes`, or -1. */
export function indexOfBytes(bytes, needle) {
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    let j = 0;
    while (j < needle.length && bytes[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

export function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: ${String(actual)}, expected ${String(expected)}`);
}

export function throws(body, check, what) {
  try {
    body();
  } catch (error) {
    check(error);
    return;
  }
  throw new Error(`${what}: not refused`);
}

export const typeError = (error) => {
  if (!(error instanceof TypeError)) throw error;
};

export const status = (name) => (error) => {
  if (!(error instanceof TinyactorsError)) throw error;
  equal(error.status, name, 'status');
};

export const tick = () => macrotask();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits, by event-loop turns only, until `done()` holds (at most `limit`
 * turns); the host is never asked to drive. */
export async function until(done, limit = 200) {
  for (let i = 0; i < limit && !done(); i++) await tick();
  return done();
}
