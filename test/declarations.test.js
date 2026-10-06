'use strict';
// Top-level declarations in SCXML <script>s, as the C datamodel treats them
// (tests/unit/test_datamodel_ecmascript.c, the same kinds of charts): what a script
// declares is asked of the engine; charts with declarations are isolated, are
// stored (hibernate, snapshot, export, migrate) with their var/let/const
// bindings and function declarations, and refusals name the variable and line.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActor, createSystem, createMemoryStore, fromSCXML } = require('./binding');

const SC = (body) => `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" ${body}</scxml>`;

/* a system with a deterministic clock; log lines are collected */
function world(options = {}) {
  const logs = [];
  const system = createSystem({ clock: () => 0, logger: (...a) => logs.push(a.join(' ')), hibernation: { store: createMemoryStore(), sweepMs: 0 }, ...options });
  return { system, logs };
}
const start = (system, xml, id, systemID) => {
  const a = createActor(fromSCXML(xml, id ? { id } : {}), { system, systemID }).start();
  system.flush();
  return a;
};
/* evaluate expressions in the session: a <log> per probe event */
const probe = (exprs) => `<transition event="probe"><log label="p" expr="[${exprs.join(', ')}].join('|')"/></transition>`;
const ask = (w, a) => {
  w.logs.length = 0;
  a.send('probe');
  w.system.flush();
  return w.logs.join(';');
};
/* an implicit global works only in an isolated chart (shared: strict, error.execution) */
const REALM = `<transition event="realm"><script>try { implicitProbe = 1; } catch (e) {}</script><log label="realm" expr="typeof implicitProbe === 'number' ? 'isolated' : 'shared'"/></transition>`;
const realm = (w, a) => {
  w.logs.length = 0;
  a.send('realm');
  w.system.flush();
  return w.logs.join(';');
};

test('declarations: the engine says what a script declares (blocks, nested functions, strings do not count)', () => {
  const w = world();
  let a = start(w.system, SC(`initial="a"><script>var x = 2; const y = 3; /* let z */ var re = /[/]var/;
for (var i = 0; i &lt; 2; i++) {} let [p, q] = [4, 5]; var \\u00e9t\\u00e9 = 'summer';</script>
<state id="a">${REALM}${probe(['x * y', 'i', 'p + q', 'été', "typeof z"])}</state>`));
  assert.equal(ask(w, a), 'p 6|2|9|summer|undefined');
  assert.equal(realm(w, a), 'realm isolated');
  a = start(w.system, SC(`initial="a"><datamodel><data id="x" expr="1"/></datamodel>
<script>x = [1, 2].map(function (v) { const k = v; return k * 2; }).length; // var</script>
<state id="a">${REALM}${probe(['x'])}</state>`));
  assert.equal(ask(w, a), 'p 2');
  assert.equal(realm(w, a), 'realm shared');
  a = start(w.system, SC(`initial="a"><datamodel><data id="r" expr="0"/></datamodel>
<script>if (r === 0) { let t = 1; const u = 1; r = t + u; }
for (let i = 0; i &lt; 2; i++) r += i;
(function () { var v = 10; function w() { return v; } r += w(); })();
r += 'let s; class C {}'.length;</script>
<state id="a">${REALM}${probe(['r'])}</state>`));
  assert.equal(ask(w, a), 'p 30');
  assert.equal(realm(w, a), 'realm shared');
  /* a sloppy-mode function in a block is a var too (Annex B) */
  a = start(w.system, SC(`initial="a"><script>if (true) { function g() { return 1; } }</script><state id="a">${REALM}${probe(['g()'])}</state>`));
  assert.equal(ask(w, a), 'p 1');
  assert.equal(realm(w, a), 'realm isolated');
  assert.equal(globalThis.x, undefined, 'nothing leaks into the host global object');
  assert.equal(globalThis.implicitProbe, undefined);
  w.system.stop();
});

/* as STORE_CHART in test_datamodel_ecmascript.c (a strict function's `this` is checked
 * inside it: called through the session scope, `this` is that scope in JS) */
const STORE = SC(`initial="a"><datamodel><data id="n" expr="1"/></datamodel>
<script>var total = 10;
let items = ['a'];
const LIMIT = 3;
let later, \\u00e9t\\u00e9 = 'summer';
function add(k) { total += k; items.push(k); return total; }
implicit = { nested: [1, 2], when: new Date(0) };</script>
<script>'use strict'; function strict() { return (function () { return this === undefined; })(); }</script>
<state id="a"><onentry><script>let dead = boom();</script></onentry>
<transition event="add"><script>add(_event.data.k); later = items.length;</script></transition>
<transition event="bump"><assign location="LIMIT" expr="LIMIT + 1"/></transition>
<transition event="again"><script>let items = [];</script></transition>
<transition event="error.execution"><log label="err" expr="LIMIT"/></transition>
${probe(['total', 'items.join()', 'LIMIT', 'later', 'été', 'implicit.nested[1] + implicit.when.getTime()', 'n', 'strict()', '(function () { try { return typeof dead; } catch (e) { return e.name; } })()'])}
<transition event="call"><log label="add" expr="add(1)"/></transition>
</state>`);
const state = (total, items, later) => `p ${total}|${items}|3|${later}|summer|2|1|true|ReferenceError`;
const call = (w, a) => {
  w.logs.length = 0;
  a.send('call');
  w.system.flush();
  return w.logs.join(';');
};

test('declarations: stored and woken again and again (var, let, const, uninitialized, functions)', () => {
  const w = world();
  const a = start(w.system, STORE);
  assert.deepEqual(w.logs, ['err 3'], 'boom() is not defined');
  a.send({ type: 'add', k: 5 });
  w.system.flush();
  assert.equal(w.system.hibernate(a), 1);
  assert.equal(ask(w, a), state(15, 'a,5', 2));
  assert.equal(call(w, a), 'add 16', 'the re-created function sees the restored globals');
  assert.equal(w.system.hibernate(a), 1, 'a re-created function is stored again');
  assert.equal(ask(w, a), state(16, 'a,5,1', 2));
  assert.equal(call(w, a), 'add 17');
  w.logs.length = 0;
  a.send('bump'); /* assigning the const: error.execution */
  w.system.flush();
  assert.deepEqual(w.logs, ['err 3']);
  w.logs.length = 0;
  a.send('again'); /* a global let declared twice, as in one realm: error.execution */
  w.system.flush();
  assert.deepEqual(w.logs, ['err 3']);
  a.send({ type: 'add', k: 2 });
  w.system.flush();
  assert.equal(w.system.hibernate(a), 1);
  assert.equal(ask(w, a), state(19, 'a,5,1,1,2', 5));
  assert.equal(a.getSnapshot().context.total, 19);
  w.system.stop();
});

test('declarations: system snapshots restore them in a new system', () => {
  const w = world();
  start(w.system, STORE, 'store', 'keeper');
  w.system.get('keeper').send({ type: 'add', k: 5 });
  w.system.flush();
  const snap = w.system.snapshot();
  w.system.stop();
  const logs = [];
  const system = createSystem({ restore: snap, clock: () => 0, logger: (...x) => logs.push(x.join(' ')) });
  const b = system.get('keeper');
  b.send('probe');
  b.send('call');
  system.flush();
  assert.deepEqual(logs, [state(15, 'a,5', 2), 'add 16']);
  assert.ok(system.snapshot() instanceof Uint8Array, 'stored again from the restored system');
  system.stop();
});

/* what cannot be stored is refused, saying what and where; the actor goes on */
function refused(xml, want) {
  const w = world();
  const a = start(w.system, xml);
  assert.throws(() => w.system.hibernate(a), (e) => e.message.includes(want), want);
  assert.equal(a.hibernated, false);
  assert.throws(() => w.system.snapshot(), (e) => e.message.includes(want), 'a snapshot says the same');
  assert.throws(() => w.system.export(a), (e) => e.message.includes(want), 'so does an export');
  assert.equal(a.getSnapshot().status, 'active', 'still there');
  w.system.stop();
}

test('declarations: refusals name the variable and the line', () => {
  refused(
    '<scxml xmlns="http://www.w3.org/2005/07/scxml" datamodel="ecmascript" initial="a">\n<script>\nvar ok = 1;\nconst helper = (x) => x * 2;</script><state id="a"/></scxml>',
    "variable 'helper' cannot be stored: it holds a function (line 4); only top-level function declarations are stored (re-created on restore): write `function helper(...) {...}`",
  );
  refused(SC('initial="a"><script>var handlers = { go: function () {} };</script><state id="a"/>'), "variable 'handlers' cannot be stored: handlers.go is a function (line 1)");
  refused(SC('initial="a"><script>class Shape {}</script><state id="a"/>'), "variable 'Shape' cannot be stored: it is a class");
  refused(SC('initial="a"><script>function P() {} P.prototype.area = function () {};</script><state id="a"/>'), "function 'P' cannot be stored: P.prototype.area was added");
  refused(SC('initial="a"><script>var err = new Error(\'x\');</script><state id="a"/>'), "variable 'err' cannot be stored: err is an Error object");
  refused(SC('initial="a"><datamodel><data id="m" expr="new Map([[1, [Promise.resolve()]]])"/></datamodel><state id="a"/>'), "variable 'm' cannot be stored: m (value 0)[0] is a Promise object");
  /* an alias of a declared function is not the declaration */
  refused(SC('initial="a"><script>function f() {} var g = f;</script><state id="a"/>'), "variable 'g' cannot be stored: it holds a function");
});

test('declarations: live migration keeps the new chart\'s names; functions are its code, not data', async () => {
  const v1 = SC(`name="counter" initial="a"><script>var total = 10; let items = ['x']; function add(k) { total += k; return total; }</script>
<state id="a"><transition event="add"><script>add(_event.data.k);</script></transition></state>`);
  const v2 = SC(`name="counter" initial="a"><datamodel><data id="seen" expr="null"/></datamodel>
<script>let items = []; var total; function add(k) { total += 10 * k; return total; }</script>
<state id="a"><transition event="error.platform.upgrade"><assign location="seen" expr="Object.keys(_event.data).sort().join()"/></transition>
<transition event="add"><script>add(_event.data.k);</script></transition>
<transition event="probe"><log label="p" expr="[total, items.join(), seen, add(0)].join('|')"/></transition></state>`);
  const w = world();
  const a = start(w.system, v1, 'counter');
  a.send({ type: 'add', k: 5 });
  w.system.flush();
  w.system.reload(fromSCXML(v2, { id: 'counter' }));
  const m = w.system.migrate(a);
  w.system.flush();
  assert.equal((await m.done).migrated, 1);
  a.send({ type: 'add', k: 1 });
  w.system.flush();
  /* the bindings came along (items: v1's value, as a variable v2 declares too); add is v2's */
  assert.equal(ask(w, a), 'p 25|x|items,total|25');
  assert.equal(w.system.hibernate(a), 1, 'stored after the upgrade');
  assert.equal(ask(w, a), 'p 25|x|items,total|25');
  w.system.stop();
});
