// A session generator that survives a throwing script: each step answers [ok, value].
export const SESSION_SOURCE = `(function* __tinyactors_session() {
  var __tinyactors_in = yield;
  for (;;) { try { __tinyactors_in = yield [true, eval(__tinyactors_in)]; } catch (__tinyactors_e) { __tinyactors_in = yield [false, __tinyactors_e]; } }
})`;
export function semantics() {
  const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f); const realm = f.contentWindow;
  const make = realm.eval(SESSION_SOURCE); const a = make(); a.next();
  const run = (code) => a.next(code).value;
  const r = {};
  r.throwKept = run('throw 0; var later = 1; function g() { return later; }')[0] === false;
  r.sessionSurvives = run('1 + 1')[1] === 2;
  r.declaredWithoutRunning = run('typeof g')[1] === 'function' && run('later')[1] === undefined;
  run('later = 5');
  r.functionClosesOverInstantiatedVar = run('g()')[1] === 5;
  r.strictBlockStillDeclares = run("'use strict'; var s1 = 1;")[0] && run('typeof s1')[1];
  r.evalOfStrictCodeKeepsVar = run('typeof s1')[1];
  r.protocolNameVisible = run('typeof __tinyactors_in')[1];
  return r;
}
