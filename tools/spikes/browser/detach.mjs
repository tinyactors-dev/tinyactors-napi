export function detach() {
  const f = document.createElement('iframe'); f.style.display = 'none'; document.documentElement.appendChild(f);
  const w = f.contentWindow; const ev = w.eval; const make = w.eval(`(function* () { var i = yield; for (;;) { try { i = yield [true, eval(i)]; } catch (e) { i = yield [false, e]; } } })`);
  const s = make(); s.next(); s.next('var n = 1; function f() { return n + 1; }');
  f.remove();
  const r = { contentWindowAfter: f.contentWindow === null };
  try { r.generatorAfterDetach = s.next('f()').value; } catch (e) { r.generatorAfterDetach = 'threw ' + e; }
  try { r.evalAfterDetach = ev('1 + 2'); } catch (e) { r.evalAfterDetach = 'threw ' + e; }
  try { r.newSessionAfterDetach = make().next().done === false; } catch (e) { r.newSessionAfterDetach = 'threw ' + e; }
  try { r.arrayCtorAfterDetach = Array.isArray(new w.Array(1, 2)); } catch (e) { r.arrayCtorAfterDetach = 'threw ' + e; }
  return r;
}
