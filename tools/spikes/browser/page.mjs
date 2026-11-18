import { bench } from './bench.mjs';
import { iframeRealm, SESSION_SOURCE, semantics } from './realms.mjs';
window.spike = {
  async boundary() { return bench(await (await fetch('/calls.wasm')).arrayBuffer()); },
  semantics() { return semantics(iframeRealm()); },
  shadowRealm() { return typeof globalThis.ShadowRealm; },
  makeIframes(n) { const t0 = performance.now(); window.kept = window.kept || []; for (let i = 0; i < n; i++) { const w = iframeRealm(); w.eval('globalThis.kit = { copy: (v) => v, scope: function S() { this.a = 1; } }'); window.kept.push(w); } return (performance.now() - t0) / n; },
  makeGenerators(n) {
    const realm = window.genRealm || (window.genRealm = iframeRealm());
    const make = realm.eval(SESSION_SOURCE); window.gens = window.gens || [];
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { const s = make(); s.next(); s.next('var count = 0, items = [], name = "s"; function inc() { return ++count; }'); window.gens.push(s); }
    return (performance.now() - t0) / n;
  },
  makeScopes(n) {
    const realm = window.scopeRealm || (window.scopeRealm = iframeRealm());
    const S = realm.eval('(function () { const proto = Object.freeze(Object.create(null)); function Scope() { this.count = 0; this.items = []; this.name = "s"; this._event = undefined; } Scope.prototype = proto; return Scope; })()');
    window.scopes = window.scopes || []; const t0 = performance.now();
    for (let i = 0; i < n; i++) window.scopes.push(new S());
    return (performance.now() - t0) / n;
  },
  evalCosts() {
    const realm = window.genRealm || (window.genRealm = iframeRealm());
    const make = realm.eval(SESSION_SOURCE); const s = make(); s.next(); s.next('var count = 0;');
    const N = 200000; let t0 = performance.now(); for (let i = 0; i < N; i++) s.next('count < 3'); const direct = (performance.now() - t0) * 1e6 / N;
    const scope = { count: 0 }; const fn = realm.eval('(function (scope) { with (scope) return function () { "use strict"; return count < 3; }; })')(scope);
    t0 = performance.now(); for (let i = 0; i < N; i++) fn(); const compiled = (performance.now() - t0) * 1e6 / N;
    return { 'a generator session: direct eval of "count < 3", ns': +direct.toFixed(1), 'a shared scope: compiled with-function, ns': +compiled.toFixed(1) };
  },
  async scheduling() {
    const chain = (schedule, n) => new Promise((resolve) => { let i = 0; const t0 = performance.now(); const step = () => (++i === n ? resolve((performance.now() - t0) / n) : schedule(step)); schedule(step); });
    const mc = new MessageChannel(); let pending = null; mc.port1.onmessage = () => { const f = pending; pending = null; f(); };
    return { 'setTimeout(0) chained, ms per turn': +(await chain((f) => setTimeout(f, 0), 200)).toFixed(3),
      'MessageChannel chained, ms per turn': +(await chain((f) => { pending = f; mc.port2.postMessage(0); }, 200)).toFixed(3) };
  },
  worker() { return new Promise((resolve) => { const w = new Worker('/worker.mjs', { type: 'module' }); w.onmessage = (e) => resolve(e.data); }); },
};
