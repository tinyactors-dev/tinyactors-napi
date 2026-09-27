'use strict';

// SCXML documents with a data model in JavaScript (ADR 0019, core ADR
// 0076): registerDatamodel() compiles source text for the built-in data
// model, and define(xml, { format: 'scxml' }) imports a document through the
// SCXML codec. Runs on Node and Bun.

const assert = require('node:assert/strict');
const { nativeOf } = require('../lib/system');
const { core } = require('../lib/native');
const { createSystem, statechart, TinyactorsError } = require('..');
const { ecmascript } = require('../tools/ecmascript-datamodel');

const NS = 'xmlns="http://www.w3.org/2005/07/scxml" version="1.0"';

// A small compiler in the style of tools/ecmascript-datamodel.js, recording
// what it was asked to compile.
function recordingCompiler(calls) {
  return {
    compile(source, role) {
      calls.push([source, role]);
      if (role === 'location') {
        return source.trim();
      }
      const body = role === 'script' ? source : `return (${source});`;
      const run = new Function('context', `with (this) { ${body} }`);
      return function (context) { return run.call(this, context); };
    },
  };
}

function assertRefused(fn, code, check) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.code, code, error.message);
    check?.(error);
    return true;
  });
}

// Each role, and compile called once per source expression at define time.
async function roles() {
  const system = createSystem();
  const calls = [];
  system.registerDatamodel('ecmascript', recordingCompiler(calls));
  const xml = `<scxml ${NS} name="roles" datamodel="ecmascript">
  <datamodel><data id="count" expr="0"/><data id="log" expr="[]"/></datamodel>
  <state id="idle">
    <onentry><script>log.push('entered')</script></onentry>
    <transition event="inc" type="internal"><assign location="count" expr="count + 1"/></transition>
    <transition event="check" cond="count &gt; 1" target="big"/>
  </state>
  <state id="big"/>
</scxml>`;
  const definition = system.define(xml, { format: 'scxml' });
  assert.deepEqual(calls.map(([, role]) => role).sort(), ['condition', 'location', 'script', 'value', 'value', 'value'].sort());
  assert.equal(new Set(calls.map(([source]) => source)).size, calls.length, 'compile runs once per expression');
  assert.equal(definition.inspect().datamodel, 'ecmascript');
  const actor = system.spawn(definition);
  await system.flush();
  actor.post('inc');
  actor.post('inc');
  actor.post('check');
  await system.flush();
  assert.deepEqual(actor.inspect().data, { count: 2, log: ['entered'] });
  assert.deepEqual(actor.inspect().activeStates, ['big']);
  assert.equal(calls.length, 6, 'nothing is compiled after define');
  system.close();
}

// An imported chart and the same chart built with statechart() behave alike.
async function sameAsBuilder() {
  const system = createSystem();
  system.registerDatamodel('ecmascript', ecmascript);
  const imported = system.define(`<scxml ${NS} name="twin" datamodel="ecmascript">
  <datamodel><data id="n" expr="10"/></datamodel>
  <state id="a">
    <transition event="add" type="internal"><assign location="n" expr="n + _event.data"/></transition>
    <transition event="go" cond="n &gt;= 15" target="b"/>
  </state>
  <state id="b"/>
</scxml>`, { format: 'scxml' });
  const built = system.define(
    statechart({ family: 'twin-builder', revision: 'v1' })
      .data('n', 10)
      .state('a', (s) => {
        s.on('add', (t) => t.assign('n', function ({ event }) { return this.n + event.data; }));
        s.on('go', (t) => t.when(({ data }) => data.n >= 15).target('b'));
      })
      .state('b'),
  );
  const results = [];
  for (const definition of [imported, built]) {
    const actor = system.spawn(definition);
    await system.flush();
    actor.post('go');
    actor.post('add', 3);
    actor.post('go');
    actor.post('add', 4);
    actor.post('go');
    await system.flush();
    results.push({ data: actor.inspect().data, states: actor.inspect().activeStates });
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], { data: { n: 17 }, states: ['b'] });
  system.close();
}

// Refusals: where in the document, and why.
async function refusals() {
  const system = createSystem();
  system.registerDatamodel('ecmascript', {
    compile(source, role) {
      const at = source.indexOf('@');
      if (at >= 0) {
        throw Object.assign(new SyntaxError('no @ here'), { offset: at, length: 1 });
      }
      return role === 'location' ? source : () => true;
    },
  });
  const document = (expr) => `<scxml ${NS} name="refused" datamodel="ecmascript">
  <datamodel><data id="x" expr="${expr}"/></datamodel>
  <state id="a"/>
</scxml>`;
  const source = document('1 + @');
  assertRefused(() => system.define(source, { format: 'scxml' }), 'invalid', (error) => {
    assert.equal(error.detail.stage, 'compile');
    assert.match(error.message, /no @ here/);
    assert.equal(error.detail.line, 2, error.message);
    const expected = source.split('\n')[1].indexOf('@') + 1;
    assert.equal(error.detail.column, expected, 'the offset points into the attribute');
  });
  // A data model nobody registered: the attribute is named, with its place.
  assertRefused(() => system.define(document('1').replace('"ecmascript"', '"xpath"'), { format: 'scxml' }), 'unsupported',
    (error) => {
      assert.match(error.message, /xpath/);
      assert.equal(error.detail.line, 1);
    });
  // Malformed XML is a decode refusal.
  assertRefused(() => system.define('<scxml', { format: 'scxml' }), 'invalid', (error) => {
    assert.equal(error.detail.stage, 'decode');
  });
  // What compile() returns is checked for its role.
  const strict = createSystem();
  strict.registerDatamodel('ecmascript', { compile: () => 42 });
  assertRefused(() => strict.define(document('1'), { format: 'scxml' }), 'invalid', (error) => {
    assert.match(error.message, /must return a function/);
  });
  strict.close();
  // Names napi owns, and a name registered twice.
  assert.throws(() => system.registerDatamodel('javascript', { compile() {} }), /registerDatamodel/);
  assert.throws(() => system.registerDatamodel('null', { compile() {} }), /registerDatamodel/);
  assert.throws(() => system.registerDatamodel('ecmascript', { compile() {} }), /registerDatamodel/);
  assert.throws(() => system.define('<scxml/>', { format: 'yaml' }), /unknown format/);
  system.close();
}

// A document without a datamodel attribute gets the built-in JavaScript
// data model, which is also available by its own name; core's null data
// model only by naming it.
async function builtinNames() {
  const system = createSystem();
  const plain = system.define(`<scxml ${NS} name="plain"><state id="a"/></scxml>`, { format: 'scxml' });
  assert.equal(plain.inspect().datamodel, 'javascript');
  const none = system.define(`<scxml ${NS} name="none" datamodel="null"><state id="a"/></scxml>`, { format: 'scxml' });
  assert.equal(none.inspect().datamodel, 'null');
  const js = system.define(`<scxml ${NS} name="js" datamodel="javascript">
  <datamodel><data id="n"/></datamodel>
  <state id="a"><transition event="e" cond="In('a')" target="b"/></state><state id="b"/>
</scxml>`, { format: 'scxml' });
  assert.equal(js.inspect().datamodel, 'javascript');
  const actor = system.spawn(js);
  await system.flush();
  actor.post('e');
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['b']);
  system.close();
}

// Compiled functions follow the builder's rules (ADR 0013): calling core is
// reentrant, posting works; compile() itself cannot call the system.
async function reentrancy() {
  const system = createSystem();
  const probe = system.define(statechart({ family: 'probe', revision: 'v1' })
    .state('idle', (s) => s.on('hi', (t) => t.target('greeted'))).state('greeted'));
  const target = system.spawn(probe);
  system.registerDatamodel('ecmascript', {
    compile(source, role) {
      if (source === 'defineAgain()') {
        system.define(`<scxml ${NS} name="nested"><state id="a"/></scxml>`, { format: 'scxml' });
      }
      return ecmascript.compile(source, role);
    },
  });
  globalThis.__tinyactorsImportProbe = { system, target, probe };
  const actor = system.spawn(system.define(`<scxml ${NS} name="calls" datamodel="ecmascript">
  <datamodel><data id="code" expr="null"/><data id="error" expr="null"/></datamodel>
  <state id="a">
    <transition event="core" type="internal"><script>
      try { globalThis.__tinyactorsImportProbe.system.spawn(globalThis.__tinyactorsImportProbe.probe); }
      catch (error) { code = error.code; }
    </script></transition>
    <transition event="post" type="internal"><script>globalThis.__tinyactorsImportProbe.target.post('hi')</script></transition>
    <transition event="error.execution" type="internal"><assign location="error" expr="String(_event.data &amp;&amp; _event.data.message)"/></transition>
  </state>
</scxml>`, { format: 'scxml' }));
  await system.flush();
  // Interning a new event name is a core call, so it is interned before the
  // compiled script posts it, as for builder charts (a dead letter, here).
  system.post({ family: 'nobody', name: 'here' }, 'hi');
  actor.post('core');
  actor.post('post');
  await system.flush();
  assert.equal(actor.inspect().data.code, 'reentrant');
  assert.deepEqual(target.inspect().activeStates, ['greeted'], 'a compiled script can post');
  assertRefused(() => system.define(`<scxml ${NS} name="inner" datamodel="ecmascript">
  <datamodel><data id="x" expr="defineAgain()"/></datamodel><state id="a"/>
</scxml>`, { format: 'scxml' }), 'invalid', (error) => assert.match(error.message, /reentrant|core call/));
  delete globalThis.__tinyactorsImportProbe;
  system.close();
}

// When memory runs out, a compiled expression's chart behaves as the same
// chart built with statechart(): the built-in data model decides what to
// report, not the compiler (ADR 0019 section 3, core ADR 0070). Here a
// <send> computes a new, very long event name; turning it into text for core
// is an allocation the data model makes. It changes nothing, so the data
// model answers TA_OP_NOMEM: the run stops where it stands, napi retries it
// (ADR 0008), and once memory is back the send completes, once, with no
// error.execution the chart could see.
async function outOfMemory() {
  const system = createSystem();
  const segment = 'x'.repeat(200_000);
  globalThis.__tinyactorsImportName = () => `long.${segment}`;
  system.registerDatamodel('ecmascript', ecmascript);
  const imported = system.define(`<scxml ${NS} name="memory" datamodel="ecmascript">
  <datamodel><data id="seen" expr="0"/><data id="errors" expr="0"/></datamodel>
  <state id="a">
    <transition event="go" type="internal"><send eventexpr="globalThis.__tinyactorsImportName()" target="#_internal"/></transition>
    <transition event="long" type="internal"><assign location="seen" expr="seen + 1"/></transition>
    <transition event="error.execution" type="internal"><assign location="errors" expr="errors + 1"/></transition>
  </state>
</scxml>`, { format: 'scxml' });
  const built = system.define(
    statechart({ family: 'memory-builder', revision: 'v1' })
      .data('seen', 0)
      .data('errors', 0)
      .state('a', (s) => {
        s.on('go', (t) => t.send(() => globalThis.__tinyactorsImportName(), (m) => m.to('#_internal')));
        s.on('long', (t) => t.assign('seen', function () { return this.seen + 1; }));
        s.on('error.execution', (t) => t.assign('errors', function () { return this.errors + 1; }));
      }),
  );
  const native = nativeOf(system);
  const results = [];
  const turns = (count) => new Promise((resolve) => {
    const step = (left) => (left === 0 ? resolve() : setImmediate(() => step(left - 1)));
    step(count);
  });
  for (const definition of [imported, built]) {
    const actor = system.spawn(definition);
    await system.flush();
    actor.post('go');
    native.refuseAllocationsFrom(100_000);
    // Not flush(): the run keeps stopping until memory is back.
    await turns(20);
    assert.deepEqual(actor.inspect().data, { seen: 0, errors: 0 }, 'stopped, with nothing done twice or lost');
    native.refuseAllocationsFrom(0);
    await system.flush();
    actor.post('go');
    await system.flush();
    results.push(actor.inspect().data);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], { seen: 2, errors: 0 });
  delete globalThis.__tinyactorsImportName;
  system.close();
}

// <data src> and <script src> go through define()'s resolve(src) (core ADR
// 0053): a string or a Uint8Array is the content, undefined refuses the
// document at the src, and what resolve throws comes out of define().
// Content that is not JSON is a space-normalized string (SCXML B.2.2).
async function dataSrc() {
  const system = createSystem();
  system.registerDatamodel('ecmascript', ecmascript);
  const chart = (src) => `<scxml ${NS} name="sourced" datamodel="ecmascript">
  <datamodel>
    <data id="list" src="${src}"/>
    <data id="text" src="text.txt"/>
    <data id="inline">
  this  is
  a string
</data>
  </datamodel>
  <state id="a"/>
</scxml>`;
  const files = { 'list.json': '[1, 2, 3]', 'text.txt': new TextEncoder().encode('\n spaced   out \n') };
  const requested = [];
  const definition = system.define(chart('list.json'), {
    format: 'scxml',
    resolve: (src) => { requested.push(src); return files[src]; },
  });
  assert.deepEqual(requested, ['list.json', 'text.txt'], 'each src is fetched once, when the document is defined');
  const actor = system.spawn(definition);
  await system.flush();
  assert.deepEqual(actor.inspect().data.list, [1, 2, 3], 'JSON content is a value');
  assert.equal(actor.inspect().data.text, 'spaced out', 'other content is space-normalized');
  assert.equal(actor.inspect().data.inline, 'this is a string');

  assertRefused(() => system.define(chart('missing.json'), { format: 'scxml', resolve: (src) => files[src] }),
                'invalid', (error) => {
                  assert.equal(error.detail.stage, 'decode');
                  assert.ok(error.detail.line > 0, 'the refusal says where the src is');
                });
  assertRefused(() => system.define(chart('list.json'), { format: 'scxml' }), 'invalid',
                (error) => assert.equal(error.detail.stage, 'decode'));
  assert.throws(() => system.define(chart('list.json'), {
    format: 'scxml',
    resolve: () => { throw new Error('no disk'); },
  }), /no disk/);
  assert.throws(() => system.define(chart('list.json'), { format: 'scxml', resolve: () => 42 }), TypeError);
  assertRefused(() => system.define(chart('list.json'), { format: 'scxml', resolve: 'list.json' }), 'invalid');
  system.close();
}

// What a document is called (core ADR 0085): define()'s `name` is the source
// its spans name. A child fetched by src or srcexpr is named by that src;
// a child inline in <content> has lines of its own, so it has no name.
async function names() {
  const system = createSystem();
  system.registerDatamodel('ecmascript', ecmascript);
  const text = `<scxml ${NS} name="named">
  <state id="a">
    <transition event="go" target="b"/>
  </state>
  <state id="b"/>
</scxml>`;
  const state = (definition, name) => core.definition_find_state(nativeOf(system), definition.id, name);
  const named = system.define(text, { format: 'scxml', name: 'charts/named.scxml' });
  assert.deepEqual([named.sourceOf('state', state(named, 'b')).source, named.sourceOf('state', state(named, 'b')).line],
                   ['charts/named.scxml', 5]);
  const unnamed = system.define(text.replace('"named"', '"unnamed"'), { format: 'scxml' });
  assert.equal(unnamed.sourceOf('state', state(unnamed, 'a')).source, '');
  for (const name of [3, null, { path: 'x' }]) {
    assertRefused(() => system.define(text, { format: 'scxml', name }), 'invalid',
                  (error) => assert.match(error.message, /name must be a string/));
  }

  const child = (family) => `<scxml ${NS} name="${family}"><state id="c"/></scxml>`;
  const files = { 'file:child.scxml': child('fetched'), 'file:late.scxml': child('late') };
  const parent = system.define(`<scxml ${NS} name="parent" datamodel="ecmascript">
  <state id="p">
    <invoke type="scxml"><content>${child('inline')}</content></invoke>
    <invoke type="scxml" src="file:child.scxml"/>
    <invoke type="scxml" srcexpr="'file:' + 'late.scxml'"/>
  </state>
</scxml>`, { format: 'scxml', name: 'parent.scxml', resolve: (src) => files[src] });
  // Where a child's state `c` was written, as core says it.
  const sourceOfFamily = (family) => {
    const found = [...system.definitions()].find((definition) => definition.identity.family === family);
    assert.ok(found !== undefined, `${family} is defined`);
    const native = nativeOf(system);
    return core.definition_span(native, found.id, 'state', core.definition_find_state(native, found.id, 'c'));
  };
  assert.equal(parent.sourceOf('state', state(parent, 'p')).source, 'parent.scxml');
  assert.equal(sourceOfFamily('inline').source ?? '', '', 'an inline child is not named after its parent');
  assert.equal(sourceOfFamily('inline').span.line, 1, 'its lines count from the start of its content');
  assert.equal(sourceOfFamily('fetched').source, 'file:child.scxml');
  system.spawn(parent);
  await system.flush();
  assert.equal(sourceOfFamily('late').source, 'file:late.scxml', 'a srcexpr child is named by the src it evaluated to');
  system.close();
}

(async () => {
  await roles();
  await dataSrc();
  await sameAsBuilder();
  await refusals();
  await builtinNames();
  await reentrancy();
  await outOfMemory();
  await names();
  console.log('import.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
