// Realm options for the native datamodel in a browser page.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function iframeRealm() {
  const f = document.createElement('iframe');
  f.style.display = 'none';
  document.body.appendChild(f);
  return f.contentWindow;
}
// A session whose declarations persist: a sloppy generator, each script a direct eval in it.
export const SESSION_SOURCE = `(function* __tinyactors_session() {
  var __tinyactors_in = yield;
  for (;;) __tinyactors_in = yield eval(__tinyactors_in);
})`;
export function semantics(realm) {
  const make = realm.eval(SESSION_SOURCE);
  const a = make(); a.next(); const b = make(); b.next();
  const run = (s, code) => s.next(code).value;
  const r = {};
  run(a, 'var count = 0; function inc() { return ++count; }');
  run(a, 'inc(); inc();');
  r.varPersists = run(a, 'count') === 2;
  r.closureSeesVar = run(a, 'inc()') === 3;
  r.isolatedFromOtherSession = run(b, 'typeof count') === 'undefined';
  r.notOnRealmGlobal = run(a, "typeof globalThis.count") === 'undefined';
  r.notOnPageGlobal = typeof window.count === 'undefined';
  run(a, 'let lexical = 1;');
  r.letPersists = run(a, 'typeof lexical') !== 'undefined';
  run(a, 'throw0 = 0'); // an undeclared assignment in sloppy code: lands on the realm's global
  r.undeclaredAssignmentGoesToRealmGlobal = realm.throw0 === 0;
  try { run(a, 'throw 0; var later = 1; function g() {}'); } catch (e) { r.instantiateThrows = e === 0; }
  r.instantiateWithoutRunning = run(a, 'typeof g') === 'function' && run(a, 'later') === undefined;
  return r;
}
export async function heapOf(fn) { return fn; }
