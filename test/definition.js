'use strict';

// Step 4: defining charts (ROADMAP step 4, ADRs 0001 and 0013).

const assert = require('node:assert/strict');
const { createSystem, statechart, TinyactorsError } = require('..');
const { core } = require('../lib/native');
const { nativeOf } = require('../lib/system');

function assertCode(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TinyactorsError, `expected TinyactorsError, got ${error}`);
    assert.equal(error.code, code, error.message);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return true;
  });
}

// Ported from the first addon's test/definition.js, in the generated shape.
function definitions() {
  const system = createSystem();
  const definition = system.define({
    identity: { family: { name: 'worker' }, revision: 'v1' },
    initial: { targets: ['idle'] },
    states: [
      { kind: 'atomic', id: 'idle', transitions: [{ kind: 'external', event: 'work', targets: ['finished'] }] },
      { kind: 'final', id: 'finished' },
    ],
  });

  assert.equal(definition.system, system);
  assert.equal(typeof definition.id, 'bigint');
  assert.deepEqual(definition.identity, { family: 'worker', revision: 'v1' });
  assert.equal(definition.retired, false);
  assert.equal(system.findDefinition({ family: 'worker', revision: 'v1' }).id, definition.id);
  definition.retire();
  // Core frees a retired definition that no actor uses; it still reads as retired.
  assert.equal(definition.retired, true);
  definition.retire();
  assert.equal(system.findDefinition({ family: 'worker', revision: 'v1' }), undefined);

  // A revision that is not UTF-8 reads back as bytes.
  const bytes = system.define({
    identity: { family: { name: 'bytes' }, revision: new Uint8Array([0xff, 0x00, 0x01]) },
    states: [{ kind: 'atomic', id: 'only' }],
  });
  assert.deepEqual([...bytes.identity.revision], [0xff, 0x00, 0x01]);
  bytes.retire();

  // The first addon refused a document name; core accepts and reports it.
  const named = system.define({
    name: 'named',
    identity: { family: { name: 'worker' }, revision: 'v2' },
    states: [{ kind: 'atomic', id: 'idle' }],
  });
  assert.equal(named.inspect().name, 'named');
  assert.equal(named.inspect().datamodel, 'javascript');

  system.close();
  assertCode(() => definition.retired, 'closed');
  assertCode(() => named.inspect(), 'closed');
  assertCode(() => system.define(statechart({ family: 'x', revision: 'v1' }).state('a')), 'closed');
}

// The builder emits the generated shape, which round-trips through export.
function builder() {
  const system = createSystem();
  const chart = statechart({ family: 'player', revision: 'player/v1', name: 'player' })
    .initial('idle')
    .state('idle', (idle) => {
      idle.on('serve', (t) => t.target('rallying').raise('served'));
      idle.on('flip', (t) => t.when("In('idle')").target('rallying').internal());
    })
    .state('rallying', (rallying) => {
      rallying.initial('hit');
      rallying.entry((a) => a.log('rally').send('ball', (s) => s.id('ball').to('#_actor_player/pong').after('1s')));
      rallying.entry((a) => a.choose("In('hit')", (then) => then.raise('yes'), (otherwise) => otherwise.raise('no')));
      rallying.exit((a) => a.cancel('ball'));
      rallying.state('hit');
      rallying.history('last', 'deep', (h) => h.always((t) => t.target('hit')));
      rallying.on('done', (t) => t.target('over'));
    })
    .parallel('both', (both) => {
      both.state('left');
      both.state('right', (right) => right.invoke((i) => i.id('child').type('scxml').source('child.scxml')
        .autoforward().finalize((a) => a.raise('finalized'))));
    })
    .final('over');

  const definition = system.define(chart);
  assertCode(() => chart.state('late'), 'invalid', /already built/);

  const exported = core.definition_export(nativeOf(system), definition.id);
  const rallying = exported.states[1];
  assert.equal(rallying.kind, 'compound');
  assert.deepEqual(rallying.initial.targets, ['hit']);
  assert.equal(rallying.onentry.length, 2, 'each entry() is its own block');
  assert.deepEqual(rallying.onentry[0].actions[1].send.delay, { kind: 'literal', literal: '1s' });
  assert.equal(rallying.states[1].kind, 'history_deep');
  assert.equal(exported.states[0].transitions[1].kind, 'internal');
  assert.equal(exported.states[0].transitions[1].condition, "In('idle')");
  assert.equal(exported.states[2].kind, 'parallel');
  assert.equal(exported.states[2].states[1].invokes[0].autoforward, true);
  assert.equal(exported.states[3].kind, 'final');

  // Export compiles to the same chart: a plain spec in the generated shape.
  const again = system.define({ ...exported, identity: { family: { name: 'player' }, revision: 'player/v1b' } });
  assert.equal(again.inspect().stateCount, definition.inspect().stateCount);

  // Every chart compiles against the JavaScript data model (step 11); only a
  // spec that says so gets the null data model.
  const fresh = (revision) => statechart({ family: 'later', revision });
  assert.equal(definition.inspect().datamodel, 'javascript');
  assert.equal(system.define({ ...fresh('v0').state('a').build(), datamodel: 'null' }).inspect().datamodel, 'null');
  assert.equal(system.define(fresh('v1').data('count', 0).state('a')).inspect().datamodel, 'javascript');
  assert.equal(system.define(fresh('v2').state('a', (s) => s.on('e', (t) => t.when(() => true)))).inspect().datamodel,
    'javascript');
  assertCode(() => fresh('v3').state('a', (s) => s.entry((a) => a.assignAt({}, 1))), 'invalid', /get and set/);
  assertCode(() => fresh('v4').state('a', (s) => s.entry((a) => a.script('text'))), 'invalid');
  system.close();
}

// Malformed specs fail with the codec's path; refused charts name the fault.
function refusals() {
  const system = createSystem();
  assertCode(() => system.define({ identity: { family: { name: 'bad' }, revision: 'v1' }, states: [{ kind: 'atomic', id: 7 }] }),
    'invalid', /spec\.states\[0\]\.id: expected a string/);
  assertCode(() => system.define('nope'), 'invalid');
  assertCode(() => statechart({ family: 'x', revision: 1 }), 'invalid');

  // Source text is only In(state) or a data name: anything else is refused
  // when the chart is defined, naming the expression and its path. The null
  // data model, which a spec opts into, accepts only In(state).
  const expression = statechart({ family: 'expr', revision: 'v1' })
    .state('a', (a) => a.on('e', (t) => t.when('x > 1').target('a')))
    .build();
  assertCode(() => system.define(expression), 'invalid',
    /condition: the JavaScript data model takes functions; source text is only In\(state\) or a data name "x > 1"/);
  assert.throws(() => system.define({ ...expression, datamodel: 'null' }), (error) => {
    assert.ok(error instanceof TinyactorsError);
    assert.equal(error.code, 'invalid');
    assert.equal(error.detail.code, 'expression_rejected');
    assert.equal(error.detail.path, 'states[0].transitions[0].condition');
    assert.equal(error.detail.error.subject, 'x > 1');
    assert.match(error.message, /chart refused: .*condition: the null data model has only the In\(state\) predicate "x > 1"/);
    return true;
  });

  // An unknown target names the state it could not find.
  const target = statechart({ family: 'target', revision: 'v1' }).state('a', (a) => a.on('e', (t) => t.target('nope')));
  assert.throws(() => system.define(target), (error) => {
    assert.equal(error.detail.code, 'unknown_state');
    assert.equal(error.detail.path, 'states[0].transitions[0].targets[0]');
    return true;
  });

  // In() used as a value compiles; running it faults as error.execution,
  // which step 5 checks once actors run.
  const asValue = statechart({ family: 'value', revision: 'v1' }).state('a', (a) => a.entry((b) => b.log('in', "In('a')")));
  assert.equal(system.define(asValue).inspect().stateCount, 1);
  system.close();
}

// Nothing about a definition lives in the addon: the facade holds a system
// and an ID, and every fact comes from core.
function nothingStored() {
  const system = createSystem();
  const definition = system.define(statechart({ family: 'facts', revision: 'v1' }).state('a'));
  assert.deepEqual(Object.keys(definition).sort(), ['id', 'system']);
  const view = core.definition_inspect(nativeOf(system), definition.id);
  const inspection = definition.inspect();
  assert.equal(inspection.stateCount, view.state_count);
  assert.equal(inspection.definitionBytes, view.definition_bytes);
  assert.equal(inspection.binding, 'early');
  assert.equal(inspection.retired, false);
  // The addon charges no native memory of its own to definitions.
  const { memory } = system.stats();
  for (const name of ['envelopes', 'scheduling', 'values', 'directory']) {
    assert.equal(memory[name].bytesInUse, 0, `${name} holds nothing for a definition`);
  }
  system.close();
}

// Where each element was written (core ADR 0085): the builder records the
// file, line and column of every call that writes a state, transition,
// initial transition or action, core keeps them per definition, and
// sourceOf() reads them back by core's IDs.
function sourceSpans() {
  const system = createSystem();
  // The line of this statement; the chart's calls are written below it, one
  // per statement, because engines place a call inside a chain differently.
  const line = Number(new Error().stack.split('\n')[1].match(/:(\d+):\d+\)?$/)[1]);
  const chart = statechart({ family: 'spans', revision: 'v1' });
  chart.state('idle', (idle) => {
    idle.on('go', (go) => {
      go.raise('started');
      go.target('busy');
    });
  });
  chart.state('busy', (busy) => {
    busy.initial('inner', (actions) => {
      actions.log('entering');
    });
    busy.state('inner');
  });
  chart.script(() => {});
  const spec = chart.build();
  assert.deepEqual(spec.sources, [{ name: __filename }]);
  const definition = system.define(spec);
  const idle = definition.sourceOf('state', 0);
  assert.equal(idle.source, __filename);
  assert.equal(idle.line, line + 2);
  // `chart.state(`: V8 points at the method's name, JavaScriptCore at the dot.
  assert.ok([8, 9].includes(idle.column), `column ${idle.column}`);
  assert.equal(definition.sourceOf('state', 1).line, line + 8);
  assert.equal(definition.sourceOf('state', 2).line, line + 12);
  // The <transition>, then busy's initial transition; the document's is SCXML's default.
  assert.equal(definition.sourceOf('transition', 0).line, line + 3);
  assert.equal(definition.sourceOf('transition', 1).line, line + 9);
  assert.equal(definition.sourceOf('transition', 2), undefined);
  const lines = [0, 1, 2].map((id) => definition.sourceOf('action', id)?.line).sort();
  assert.deepEqual(lines, [line + 4, line + 10, line + 14].sort(), 'raise, log and the root script');
  // A function is a host expression; the builder gives expressions no span of their own.
  assert.equal(definition.sourceOf('expression', 0), undefined);
  assert.equal(definition.sourceOf('state', 9), undefined);
  // A spec without spans compiles as before and keeps none.
  const plain = system.define({ identity: { family: { name: 'plain' }, revision: 'v1' }, states: [{ kind: 'atomic', id: 'a' }] });
  assert.equal(plain.sourceOf('state', 0), undefined);
  // A span that gives only a line: no column, and no end column, rather
  // than a column 0 that SourcePlace's count from 1 does not have.
  const lined = system.define({
    identity: { family: { name: 'lined' }, revision: 'v1' },
    sources: [{ name: 'chart.txt' }],
    spans: [{ source: 0, line: 3 }, { source: 0, line: 5, column: 7, end_line: 6 }],
    states: [{ kind: 'atomic', id: 'a', span: 1 }, { kind: 'atomic', id: 'b', span: 2 }],
  });
  assert.deepEqual(lined.sourceOf('state', 0), { source: 'chart.txt', line: 3 });
  assert.deepEqual(lined.sourceOf('state', 1), { source: 'chart.txt', line: 5, column: 7, endLine: 6 });
  system.close();
}

definitions();
builder();
refusals();
nothingStored();
sourceSpans();
