const vm = process.getBuiltinModule('node:vm');
const ctx = vm.createContext({});
const make = vm.runInContext(`(function* () { var i = yield; for (;;) { try { i = yield [true, eval(i)]; } catch (e) { i = yield [false, e]; } } })`, ctx);
const a = make(); a.next(); const b = make(); b.next();
a.next('var count = 0; function inc() { return ++count; }'); a.next('inc()');
console.log(typeof Bun !== 'undefined' ? 'bun' : 'node', 'count', a.next('count').value, 'isolated', b.next('typeof count').value, 'onGlobal', vm.runInContext('typeof count', ctx));
const u8 = new Uint8Array(new WebAssembly.Memory({ initial: 1 }).buffer); const N = 1e7; let c = 0; const t0 = performance.now(); for (let i = 0; i < N; i++) if (u8.byteLength === 0) c++; console.log('byteLength check ns', ((performance.now() - t0) * 1e6 / N).toFixed(2));
