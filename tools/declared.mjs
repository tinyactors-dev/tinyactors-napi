// What index.d.ts declares, read with the TypeScript compiler's API (the
// pinned tsc's own package, mise.toml's npm:typescript), in the shape
// tools/parity.mjs compares the packages with: each exported function's
// and class's parameters, each class's and interface's members (methods
// with their parameters, properties and accessors, static ones apart),
// and what each class or interface extends.
//
// A parameter count is the parameters before a rest parameter, the
// optional ones included, as JavaScript counts a function's `length` for
// parameters without a default; of several overloads, the largest.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';

/** The TypeScript compiler's module, beside the pinned `tsc`. */
export function typescript(tsc) {
  const require = createRequire(import.meta.url);
  return require(require.resolve('typescript', { paths: [dirname(realpathSync(tsc))] }));
}

function parameters(ts, node) {
  let count = 0;
  for (const parameter of node.parameters) {
    if (parameter.dotDotDotToken) break;
    if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue;
    count++;
  }
  return count;
}

function memberName(ts, name, source) {
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText(source)}]`;
  return name.text;
}

/** {functions: {name: length}, classes: {name: {length, extends, members, static}},
 * interfaces: {name: {extends, members}}}; a member is {kind, length?, optional}. */
export function declared(ts, path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const out = { functions: {}, classes: {}, interfaces: {} };
  const exported = (node) => node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const heritage = (node) => (node.heritageClauses ?? []).flatMap((clause) => clause.types.map((type) => type.expression.getText(source)));
  const add = (table, name, member) => {
    const known = Object.hasOwn(table, name) ? table[name] : undefined;
    if (known === undefined) table[name] = member;
    else if (member.length !== undefined) known.length = Math.max(known.length ?? 0, member.length);
  };
  const membersOf = (node, into, statics) => {
    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        into.constructs = true;
        into.length = Math.max(into.length ?? 0, parameters(ts, member));
        continue;
      }
      if (member.name === undefined) continue; // an index signature
      const name = memberName(ts, member.name, source);
      const isStatic = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      const table = isStatic && statics ? statics : into.members;
      const optional = member.questionToken !== undefined;
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) add(table, name, { kind: 'method', length: parameters(ts, member), optional });
      else if (ts.isGetAccessorDeclaration(member) || ts.isGetAccessor?.(member)) add(table, name, { kind: 'property', optional });
      else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) add(table, name, { kind: 'property', optional });
    }
  };
  for (const statement of source.statements) {
    if (!exported(statement)) continue;
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name.text;
      out.functions[name] = Math.max(out.functions[name] ?? 0, parameters(ts, statement));
    } else if (ts.isClassDeclaration(statement)) {
      const entry = { length: 0, extends: heritage(statement), members: Object.create(null), static: Object.create(null) };
      membersOf(statement, entry, entry.static);
      out.classes[statement.name.text] = entry;
    } else if (ts.isInterfaceDeclaration(statement)) {
      const entry = out.interfaces[statement.name.text] ?? { extends: heritage(statement), members: Object.create(null) };
      membersOf(statement, entry, null);
      out.interfaces[statement.name.text] = entry;
    }
  }
  // a class that declares no constructor has its parent's
  const length = (name) => {
    const entry = out.classes[name];
    if (entry === undefined) return 0;
    if (!entry.constructs && entry.extends.length > 0) entry.length = length(entry.extends[0]);
    entry.constructs = true;
    return entry.length;
  };
  for (const name of Object.keys(out.classes)) length(name);
  return out;
}
