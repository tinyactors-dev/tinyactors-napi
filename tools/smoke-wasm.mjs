// @tinyactors/wasm's smoke test under node and bun (mise/pack.rb): run in a
// fresh project that installed the package from its tarball, never from the
// repository. It imports both entries by the package's name, runs the
// checks of smoke-wasm-check.mjs (copied beside it), checks that the
// package's files and its module came from node_modules, and prints one
// line. Exits with status 1 when a check fails.
//
//   node smoke-wasm.mjs        bun smoke-wasm.mjs
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { check } from './smoke-wasm-check.mjs';

const failures = await check((entry) => import(entry === '.' ? '@tinyactors/wasm' : '@tinyactors/wasm/init'));
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('@tinyactors/wasm/package.json'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!root.includes(`${sep}node_modules${sep}`)) failures.push(`@tinyactors/wasm resolved to ${root}, not node_modules`);
if (!existsSync(join(root, 'tinyactors.wasm'))) failures.push(`${root} has no tinyactors.wasm`);
const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const where = `@tinyactors/wasm ${version}, ${runtime}`;
for (const failure of failures) console.error(`smoke: ${where}: ${failure}`);
if (failures.length > 0) process.exit(1);
console.log(`smoke: ok: ${where}, both entries`);
