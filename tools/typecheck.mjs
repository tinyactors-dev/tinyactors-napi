// The types checked against the documentation (docs/plan.xml, p3-shapes):
// every example of README.md and docs/guide/*.md (tools/examples.mjs) is
// written into a directory inside the package, with test/types/*.ts (the
// types' own cases, `@ts-expect-error` where a mistake must be caught),
// and compiled by tsc against index.d.ts, as an application importing
// '@tinyactors/node' sees it: the examples as JavaScript checked by tsc, test/types
// `strict`, the package
// resolved by its own name through package.json's `exports`. An example
// that misuses the API, or a type that no longer fits what the examples
// do, fails `mise run lint`.
//
// The same cases again as an application of @tinyactors/wasm, their
// imports of '@tinyactors/node' written as '@tinyactors/wasm': the wasm
// package's types are index.d.ts too, with wasm/init.d.ts for its init
// entry (tsconfig `paths`, as the staged package's `types` give them). The
// documentation's blocks that import @tinyactors/wasm are checked so.
//
// Usage: node tools/typecheck.mjs <tsc>, the pinned tsc (mise.toml's
// npm:typescript). The examples' Node.js built-ins are typed `any`
// (test/types/node.d.ts): the package has no @types/node, and the check is
// of this package's types.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { examples, fileName } from './examples.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tsc = process.argv[2];
if (!tsc) throw new Error('usage: typecheck.mjs <tsc>');

const directory = join(ROOT, 'build', 'typecheck');
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const found = examples(ROOT);
for (const example of found) writeFileSync(join(directory, fileName(example)), example.program);
cpSync(join(ROOT, 'test', 'types'), join(directory, 'types'), { recursive: true });
// test/types as an application of @tinyactors/wasm
mkdirSync(join(directory, 'types-wasm'));
for (const name of readdirSync(join(ROOT, 'test', 'types')).filter((each) => each.endsWith('.ts') && !each.endsWith('.d.ts'))) {
  const text = readFileSync(join(ROOT, 'test', 'types', name), 'utf8').replace(/'@tinyactors\/node'/g, "'@tinyactors/wasm'");
  writeFileSync(join(directory, 'types-wasm', name), text);
}
const typesConfig = JSON.parse(readFileSync(join(ROOT, 'test', 'types', 'tsconfig.types.json'), 'utf8'));
typesConfig.compilerOptions.paths = { '@tinyactors/wasm': ['../../../index.d.ts'], '@tinyactors/wasm/init': ['../../../wasm/init.d.ts'] };
writeFileSync(join(directory, 'types-wasm', 'tsconfig.wasm.json'), JSON.stringify(typesConfig, null, 2));
// test/types again with ES2022's lib and the DOM's, without esnext's
// disposable lib: index.d.ts declares Symbol.dispose, Symbol.asyncDispose,
// Disposable and AsyncDisposable itself, so a project need not add it
const es2022Config = JSON.parse(readFileSync(join(ROOT, 'test', 'types', 'tsconfig.types.json'), 'utf8'));
es2022Config.compilerOptions.lib = ['es2022', 'dom'];
writeFileSync(join(directory, 'types', 'tsconfig.es2022.json'), JSON.stringify(es2022Config, null, 2));
// The examples as an application in JavaScript checks them (checked,
// not strict: a JavaScript file has no annotations to satisfy it), and
// test/types as one in TypeScript (strict), each a project of its own:
// test/types/tsconfig.<project>.json, copied in with the cases.
for (const project of ['examples', 'types', 'wasm', 'es2022']) {
  const config = join(directory, project === 'wasm' ? 'types-wasm' : 'types', `tsconfig.${project}.json`);
  const result = spawnSync(tsc, ['-p', config, '--pretty', 'false'], { cwd: directory, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    console.error(`typecheck: tsc found errors in the ${project} (${directory})`);
    process.exit(1);
  }
}
console.log(`typecheck: ${found.length} examples and test/types compile against index.d.ts, test/types as @tinyactors/node's and as @tinyactors/wasm's, and with lib es2022 (no esnext.disposable)`);
