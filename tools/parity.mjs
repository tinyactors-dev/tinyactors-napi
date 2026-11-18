// The parity check (docs/plan.xml, p5-parity): @tinyactors/node and
// @tinyactors/wasm present one API. Under each runtime given, the shape of
// each package (tools/shape.mjs, a process of its own: the addon by
// default, the wasm package under --conditions=tinyactors-wasm) is
// compared, property by property: every export's kind, name and length, a
// class's prototype chain, its prototype's and static members with their
// kinds, lengths and attributes, the objects the API hands out, and what a
// set of misuses throws (the error's class and core's status). Then each
// package's shape against index.d.ts (tools/declared.mjs): every declared
// export, member and parameter count is there at run time, and nothing
// public at run time is undeclared.
//
// A difference fails the check unless wasm/test/differences.mjs lists it
// with its reason; a listed difference that no longer occurs fails it
// too, so the list stays true.
//
// Usage: node tools/parity.mjs <tsc> name=<runtime path>...
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DECLARED, DIFFERENCES, matches } from '../wasm/test/differences.mjs';
import { declared, typescript } from './declared.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [tsc, ...runtimes] = process.argv.slice(2);
if (!tsc || runtimes.length === 0) throw new Error('usage: parity.mjs <tsc> name=<runtime path>...');

const PACKAGES = { node: [], wasm: ['--conditions=tinyactors-wasm'] };

function shapeOf(program, package_) {
  const result = spawnSync(program, [...PACKAGES[package_], 'tools/shape.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(package_ === 'wasm' ? { TA_NAPI_PACKAGE: 'wasm' } : {}) },
  });
  if (result.status !== 0) throw new Error(`parity: tools/shape.mjs failed for ${package_} under ${program}:\n${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

/** Every leaf where `a` and `b` differ: [path, a's, b's]. */
function differences(a, b, path = '', out = []) {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push([path, a, b]);
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], path === '' ? key : `${path}.${key}`, out);
  return out;
}

// What index.d.ts declares an interface to be, at run time: the object
// tools/shape.mjs records for it.
const INTERFACES = {
  Compiled: 'Compiled', Diagnostic: 'Diagnostic', Send: 'Send', SendMessage: 'message', LogEntry: 'LogEntry', Migrated: 'Migrated',
  MigrationResult: 'MigrationResult', Invocation: 'Invocation', ChartRef: 'ChartRef', HTTPRequest: 'HTTPRequest',
};
// What every Error has, which index.d.ts inherits from the language's lib,
// and what JavaScriptCore (bun) puts on each error it makes.
const ERROR = ['name', 'message', 'stack', 'cause', 'toString', 'line', 'column', 'sourceURL', 'originalLine', 'originalColumn'];

/** Where `shape` (one package's) and index.d.ts disagree: [path, problem]. */
function againstDeclarations(types, shape) {
  const out = [];
  const declaredMembers = (name, seen = new Set()) => {
    if (seen.has(name)) return {};
    seen.add(name);
    const entry = types.classes[name] ?? types.interfaces[name];
    if (entry === undefined) return {};
    return Object.assign({}, ...entry.extends.map((parent) => declaredMembers(parent, seen)), entry.members);
  };
  const check = (path, runtime, members, inherits = []) => {
    for (const [name, member] of Object.entries(members)) {
      const found = runtime[name];
      if (found === undefined) {
        if (!member.optional) out.push([`${path}.${name}`, 'declared, missing at run time']);
        continue;
      }
      if (member.kind === 'method' && found.kind !== 'method') out.push([`${path}.${name}`, `declared a method, is ${found.kind}`]);
      if (member.kind === 'property' && found.kind === 'method') out.push([`${path}.${name}`, 'declared a property, is a method']);
      if (member.kind === 'method' && found.kind === 'method' && member.length !== found.length)
        out.push([`${path}.${name}`, `declares ${member.length} parameters, has length ${found.length}`]);
    }
    for (const [name, found] of Object.entries(runtime)) {
      if (name in members || inherits.includes(name)) continue;
      if (name.startsWith('[tinyactors.')) continue; // a private symbol, which nobody is given
      out.push([`${path}.${name}`, `${found.kind} at run time, undeclared`]);
    }
  };
  for (const [name, length] of Object.entries(types.functions)) {
    const found = shape.exports[name];
    if (found === undefined) out.push([`exports.${name}`, 'declared, not exported']);
    else if (found.kind !== 'function') out.push([`exports.${name}`, `declared a function, is ${found.kind}`]);
    else if (found.length !== length) out.push([`exports.${name}`, `declares ${length} parameters, has length ${found.length}`]);
  }
  for (const [name, entry] of Object.entries(types.classes)) {
    const found = shape.exports[name];
    if (found === undefined || found.kind !== 'class') {
      out.push([`exports.${name}`, `declared a class, is ${found?.kind ?? 'not exported'}`]);
      continue;
    }
    if (found.length !== entry.length) out.push([`exports.${name}`, `its constructor declares ${entry.length} parameters, has length ${found.length}`]);
    const errorLike = found.extends.includes('Error');
    check(`exports.${name}.static`, found.static, entry.static, ['arguments', 'caller']);
    // a class's members are on its prototype or on its instances
    const instance = shape.objects[name];
    const runtime = { ...found.prototype, ...(instance?.own ?? {}) };
    const parents = entry.extends.flatMap((parent) => Object.keys(declaredMembers(parent)));
    // an inherited member is the parent's to have: only this class's own are required here
    check(`exports.${name}`, runtime, entry.members, [...parents, ...(errorLike ? ERROR : [])]);
  }
  for (const [name, object] of Object.entries(INTERFACES)) {
    const entry = types.interfaces[name];
    const found = shape.objects[object];
    if (entry === undefined) {
      out.push([`objects.${object}`, `index.d.ts declares no interface ${name}`]);
      continue;
    }
    if (found === undefined || typeof found !== 'object') {
      out.push([`objects.${object}`, 'tools/shape.mjs did not see one']);
      continue;
    }
    check(`objects.${object}`, { ...(found.prototype ?? {}), ...found.own }, declaredMembers(name), ['[Symbol.dispose]'].filter((key) => key in declaredMembers(name)));
  }
  return out;
}

const types = declared(typescript(tsc), `${ROOT}index.d.ts`);
const found = [];
for (const entry of runtimes) {
  const [runtime, program] = entry.split('=');
  const node = shapeOf(program, 'node');
  const wasm = shapeOf(program, 'wasm');
  for (const [path, a, b] of differences(node, wasm)) found.push({ kind: 'between', runtime, path, text: `@tinyactors/node ${JSON.stringify(a)}, @tinyactors/wasm ${JSON.stringify(b)}` });
  for (const [package_, shape] of [['node', node], ['wasm', wasm]])
    for (const [path, problem] of againstDeclarations(types, shape)) found.push({ kind: 'declared', runtime, package: package_, path, text: problem });
}

let failures = 0;
const used = new Set();
for (const difference of found) {
  const list = difference.kind === 'between' ? DIFFERENCES : DECLARED;
  const listed = list.find((entry) => matches(entry, difference));
  const where = difference.kind === 'between' ? difference.runtime : `${difference.runtime} @tinyactors/${difference.package}`;
  if (listed === undefined) {
    failures++;
    console.log(`FAIL ${where}: ${difference.path}: ${difference.text}`);
  } else used.add(listed);
}
for (const entry of [...DIFFERENCES, ...DECLARED]) {
  if (used.has(entry)) continue;
  failures++;
  console.log(`FAIL wasm/test/differences.mjs lists a difference that does not occur: ${entry.path} (${entry.reason})`);
}
const listed = found.length - (failures - [...DIFFERENCES, ...DECLARED].filter((entry) => !used.has(entry)).length);
console.log(`parity: ${runtimes.map((entry) => entry.split('=')[0]).join(' and ')}: ${found.length} differences, ${listed} listed with their reasons in wasm/test/differences.mjs (${used.size} entries)${failures ? `, ${failures} failing` : ''}`);
if (failures) process.exit(1);
