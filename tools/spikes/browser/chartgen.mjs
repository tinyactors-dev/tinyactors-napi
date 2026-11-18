// M2's refined spike: one session function per declaring chart, made once
// at chart_attach from the text of its chart-level scripts (new Function in
// the host's realm; no parser of ours), and one call of it per session. The
// session's let, const, class, var and function bindings are the function's;
// a generator declared in it (hoisted, so it exists before a script can
// throw) runs every later evaluation as a direct eval, which sees them and
// keeps the vars a script of executable content declares. Runs in a page
// (an iframe's realm) and in node or bun (a node:vm context): chartgen(realm).
export function chartFunction(realm, { data = [], scripts = [] }) {
  const body = `
  function* __tinyactors_loop() {
    var __tinyactors_in = yield;
    for (;;) {
      var __tinyactors_out;
      try { __tinyactors_out = [true, eval(__tinyactors_in)]; } catch (__tinyactors_e) { __tinyactors_out = [false, __tinyactors_e]; }
      __tinyactors_in = yield __tinyactors_out;
    }
  }
  __tinyactors_session.loop = __tinyactors_loop(); __tinyactors_session.loop.next();
  __tinyactors_session.eval = eval;
  if (__tinyactors_session.restoring) throw 0;
  ${data.length ? `var ${data.join(', ')};` : ''}
  ${scripts.join(';\n')}`;
  return new realm.Function('__tinyactors_session', body);
}
export function session(make, restoring = false) {
  const s = { restoring };
  try { make(s); s.started = [true]; } catch (e) { s.started = restoring && e === 0 ? [true] : [false, e]; }
  s.run = (code) => s.loop.next(code).value;
  return s;
}
export function chartgen(realm, now = () => performance.now()) {
  const r = {};
  // let, const, class across chart-level scripts; forward references; closures
  const lexical = chartFunction(realm, { data: ['n'], scripts: ['const LIMIT = 2; function f() { return LATER * 2; }', 'let count = 10; class K { get v() { return count; } }', 'const LATER = 3;'] });
  const a = session(lexical); const b = session(lexical);
  r.lexicalStarted = a.started[0];
  r.constSeen = a.run('LIMIT')[1] === 2;
  r.forwardReference = a.run('f()')[1] === 6;
  a.run('count = count + 1');
  r.letKeptAndOwn = a.run('new K().v')[1] === 11 && b.run('count')[1] === 10;
  r.constAssignmentThrows = a.run('LIMIT = 5')[0] === false;
  r.dataIDsAreBindings = a.run('n = 4; n')[1] === 4 && b.run('n')[1] === undefined;
  r.nothingOnRealmGlobal = realm.Function('return typeof LIMIT + typeof count + typeof n')() === 'undefinedundefinedundefined';
  // executable content: a var it declares persists in the session; a let is its own per run (the addon's test)
  r.execVarPersists = [1, 2, 3].map(() => a.run("var seen = (typeof seen === 'number' ? seen : 0) + 1; let k = seen; seen")[1]).join() === '1,2,3';
  r.execVarOwnPerSession = b.run('typeof seen')[1] === 'undefined';
  // a chart-level script that throws: the session runs on, and the later chart-level scripts do not run (the addon runs them)
  const throwing = chartFunction(realm, { scripts: ["var x = 1; throw new Error('first');", 'var y = 2;'] });
  const t = session(throwing);
  r.throwReported = t.started[0] === false && String(t.started[1]) === 'Error: first';
  r.throwSessionUsable = t.run('x')[1] === 1;
  r.throwLaterScriptRan = t.run('y')[1] === 2;
  // restore of a var/function chart: instantiated without running, then the variables set
  const vars = chartFunction(realm, { scripts: ['var total = 5; function twice() { return total * 2; }'] });
  const w = session(vars, true);
  r.restoreInstantiates = w.run('typeof twice')[1] === 'function' && w.run('total')[1] === undefined;
  w.run('total = 21');
  r.restoreClosures = w.run('twice()')[1] === 42;
  // a sloppy undeclared assignment lands on the realm's global: found by a count of its names, and moved into the session
  const before = Object.getOwnPropertyNames(realm).length;
  a.run('undeclaredZ = 7');
  r.undeclaredOnRealmGlobal = Object.getOwnPropertyNames(realm).length === before + 1;
  const N = 2000; let t0 = now(); for (let i = 0; i < N; i++) Object.getOwnPropertyNames(realm).length; r.globalNamesCountUs = +((now() - t0) * 1000 / N).toFixed(2);
  // refusals at attach
  const refusal = (scripts) => { try { const m = chartFunction(realm, { scripts }); const s = session(m); return s.eval === realm.eval ? (s.started[0] ? 'accepted' : 'threw ' + s.started[1]) : 'eval shadowed'; } catch (e) { return e.name; } };
  r.declaresProtocolName = refusal(['let __tinyactors_loop = 1;']);
  r.declaresVarEval = refusal(['var eval = 1;']);
  r.declaresFunctionEval = refusal(['function eval() {}']);
  r.declaresLetArguments = refusal(['let arguments = 1;']);
  r.argumentsIsFunctions = session(lexical).run('typeof arguments')[1];
  // the cost: one session function call and its loop per session
  const sessions = []; t0 = now(); for (let i = 0; i < 10000; i++) sessions.push(session(lexical)); r.sessionUs = +((now() - t0) * 1000 / 10000).toFixed(2);
  t0 = now(); for (let i = 0; i < 100000; i++) a.run('count < 3'); r.evalNs = +((now() - t0) * 1e6 / 100000).toFixed(1);
  globalThis.__chartgenKeep = sessions;
  return r;
}
export function makeSessions(realm, n) {
  const make = chartFunction(realm, { data: ['n', 'items', 'name'], scripts: ['const LIMIT = 2; var count = 0; function inc() { return ++count; }'] });
  (globalThis.__chartgenHeld ||= []).push(...Array.from({ length: n }, () => session(make)));
}
