'use strict';

// Step 3: the generated control plane (ROADMAP step 3, ADR 0013). The
// module is internal, so this suite reaches it through lib/native.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { TinyactorsError } = require('..');
const native = require('../lib/native');

const { core } = native;
const isBun = typeof Bun !== 'undefined';

function collectGarbage() {
  if (isBun) {
    Bun.gc(true);
    return;
  }
  require('node:v8').setFlagsFromString('--expose-gc');
  require('node:vm').runInNewContext('gc')();
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

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

// A chart with no data: off --flip--> on (final).
const chart = (revision = 'v1', extra = {}) => ({
  name: 'light',
  datamodel: 'null',
  binding: 'early',
  identity: { family: { name: 'light' }, revision },
  states: [
    { kind: 'atomic', id: 'off', transitions: [{ kind: 'external', event: 'flip', targets: ['on'] }] },
    { kind: 'final', id: 'on' },
  ],
  ...extra,
});

function categories() {
  // Bound functions are callable; plumbing-owned and skipped ones are absent.
  for (const name of ['system_time', 'actor_spawn', 'actor_inspect', 'actor_abandon', 'definition_compile_spec',
                    'system_register_definition']) {
    assert.equal(typeof core[name], 'function', `core.${name} is bound`);
  }
  for (const name of ['actor_deliver', 'actor_resume', 'system_set_time', 'system_dispatch_due', 'system_create',
    'system_visit_actors', 'event_name_intern', 'arena_init', 'address_intern', 'dm_host_event']) {
    assert.equal(core[name], undefined, `core.${name} is not bound`);
  }
  // Internal: index.js does not re-export the generated layer.
  assert.equal(require('..').core, undefined);
}

function boundCalls() {
  const system = new native.System();
  assert.equal(core.system_time(system), 0);
  assert.equal(typeof core.system_scxml_io_type(system), 'number');

  const atom = core.system_intern_atom(system, 'hello');
  assert.equal(core.system_atom_text(system, atom), 'hello');

  // Named targets cross as family and name text (ADR 0006).
  const target = core.scxml_target_parse(system, '#_actor_player/ping');
  assert.deepEqual(target, { kind: 'actor', actor: { kind: 'named', named: { family: { name: 'player' }, name: 'ping' } } });
  assert.equal(core.scxml_target_format(system, target), '#_actor_player/ping');
  assert.deepEqual(core.scxml_target_parse(system, '#_internal'), { kind: 'internal' });
  system.close();
}

function definitionsAndActors() {
  const system = new native.System();
  const compiled = core.definition_compile_spec(system, chart());
  assert.equal(compiled.error.code, 'none');
  const id = core.system_register_definition(system, compiled.out);
  assert.equal(typeof id, 'bigint', 'definition IDs cross as bigints (ADR 0002)');

  // Registration consumed the handle, so it cannot be destroyed again.
  assertCode(() => core.definition_destroy(compiled.out), 'invalid', /not released/);

  const inspection = core.definition_inspect(system, id);
  assert.equal(inspection.document_name, 'light');
  assert.equal(inspection.datamodel, 'null');
  assert.equal(inspection.state_count, 2);
  assert.equal(Buffer.from(inspection.identity.revision).toString(), 'v1');

  // The spec round-trips through export.
  const exported = core.definition_export(system, id);
  assert.equal(exported.states[0].transitions[0].event, 'flip');
  assert.deepEqual(exported.states[0].transitions[0].targets, ['on']);

  // Actors cross as (slot, generation) pairs of numbers (ADR 0002).
  const actor = core.actor_spawn(system, id);
  assert.deepEqual(Object.keys(actor).sort(), ['generation', 'slot']);
  const view = core.actor_inspect(system, actor.slot, actor.generation);
  assert.deepEqual(view.actor, actor);
  assert.equal(view.definition_id, id);
  assert.equal(typeof view.session_id, 'bigint');
  assert.deepEqual(view.delayed_sends, []);
  // Nothing schedules the actor until step 5, so it is not bootstrapped yet.
  assert.equal(view.residency, 'running');
  // Its bootstrap has completed no microstep, so there is nothing to keep (core ADR 0082).
  assertCode(() => core.actor_abandon(system, actor.slot, actor.generation), 'busy', /core\.actor_abandon: busy/);

  core.actor_destroy(system, actor.slot, actor.generation);
  assertCode(() => core.actor_inspect(system, actor.slot, actor.generation), 'not-found', /core\.actor_inspect: not-found/);
  system.close();
  assert.equal(native.environmentStats().leakedBytes, 0);
}

function errors() {
  const system = new native.System();
  // Malformed input names the path of the problem.
  assertCode(() => core.definition_compile_spec(system, { ...chart(), states: [{ kind: 'atomic', id: 7 }] }),
    'invalid', /spec\.states\[0\]\.id: expected a string/);
  assertCode(() => core.definition_compile_spec(system, { ...chart(), binding: 'eventually' }),
    'invalid', /spec\.binding: expected one of/);
  assertCode(() => core.system_time({}), 'invalid', /expected a native System/);
  assertCode(() => core.system_retire_definition(system), 'invalid', /definition: expected a value/);

  // A refused chart carries core's compile error as detail (ADR 0008).
  const refused = chart('v2', {
    states: [{ kind: 'atomic', id: 'off', transitions: [{ kind: 'external', event: 'flip', condition: 'x > 1' }] }],
  });
  assert.throws(() => core.definition_compile_spec(system, refused), (error) => {
    assert.equal(error.code, 'invalid');
    assert.equal(error.detail.error.code, 'expression_rejected');
    assert.equal(error.detail.error.subject, 'x > 1');
    assert.ok(error.detail.error.path.length > 0);
    return true;
  });

  // The generated layer compiles against the null data model, which takes
  // no binding and no function expressions (System.define() selects the
  // JavaScript data model, ADR 0011).
  const id = core.system_register_definition(system, core.definition_compile_spec(system, chart('v3')).out);
  assertCode(() => core.actor_spawn(system, id, undefined, { some: 'data' }), 'unsupported');
  assertCode(() => core.definition_compile_spec(system, chart('v4', { script: () => 1 })), 'unsupported');

  system.close();
  assertCode(() => core.system_time(system), 'closed');
  assertCode(() => core.actor_spawn(system, id), 'closed');
}

async function handles() {
  const before = native.environmentStats().leakedBytes;
  // Close reclaims definitions that were compiled but never registered.
  const kept = new native.System();
  const handle = core.definition_compile_spec(kept, chart()).out;
  kept.close();
  assertCode(() => core.definition_destroy(handle), 'closed');

  // A dropped handle's finalizer destroys what it holds.
  // Warm up first: compiling interns names, and interning is permanent in core.
  const system = new native.System();
  core.definition_destroy(core.definition_compile_spec(system, chart('dropped')).out);
  const baseline = system.stats().memory.core.bytesInUse;
  (() => {
    for (let index = 0; index < 50; index += 1) {
      core.definition_compile_spec(system, chart('dropped'));
    }
  })();
  assert.ok(system.stats().memory.core.bytesInUse > baseline);
  for (let attempt = 0; attempt < 20 && system.stats().memory.core.bytesInUse > baseline; attempt += 1) {
    collectGarbage();
    await nextTurn();
  }
  if (!isBun) {
    assert.equal(system.stats().memory.core.bytesInUse, baseline, 'Node finalizes dropped definitions');
  }
  // Explicit destruction is the normal path.
  const explicit = core.definition_compile_spec(system, chart('explicit')).out;
  core.definition_destroy(explicit);
  assertCode(() => core.definition_destroy(explicit), 'invalid', /not released/);
  system.close();
  assert.equal(native.environmentStats().leakedBytes, before);
}

function environmentTeardown() {
  // Handles still alive at exit are released by close in the cleanup hook.
  const script = `
    require(${JSON.stringify(path.join(__dirname, '../lib/errors'))});
    const native = require(${JSON.stringify(path.join(__dirname, '../lib/native'))});
    const system = new native.System();
    globalThis.kept = [system, native.core.definition_compile_spec(system, ${JSON.stringify(chart())}).out];
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `child exited with ${result.status}: ${result.stderr}`);
}

(async () => {
  categories();
  boundCalls();
  definitionsAndActors();
  errors();
  await handles();
  environmentTeardown();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
