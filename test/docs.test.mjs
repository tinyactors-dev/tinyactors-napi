// The documentation's examples run as they are written (docs/plan.xml,
// p2-docs): every ```js block of README.md and docs/guide/*.md is a
// complete program, run in a process of its own by the runtime running
// this file (node or bun), from a directory inside the package so that
// `import ... from '@tinyactors/node'` resolves to this build. A block
// followed by an ```output block must print exactly that. A document
// that drifts from the API fails here. The blocks are read by
// tools/examples.mjs, which tools/typecheck.mjs shares.
//
// The examples name their own datamodel, so they run in the native pass
// of the test task only (TA_NAPI_DATAMODEL), once per runtime. A block
// marked ```js browser, or a module another block loads (`// file:`),
// runs in Chromium only (wasm/test/documentation.mjs). A block that
// imports @tinyactors/wasm runs against the wasm package: its imports
// written as the paths of the package's entries, under the export
// condition that maps `#direct` to its direct layer.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { documents, examples as readExamples, fileName } from '../tools/examples.mjs';
import { DATAMODEL } from './charts.mjs';
import { run, test } from './harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCUMENTS = documents(ROOT);
const everyExample = readExamples(ROOT);

/** The program of `example` as it is written to its file: @tinyactors/wasm's
 * entries by their paths in this directory (an installed package is found
 * by its name). */
function programOf(example) {
  if (!example.wasmPackage) return example.program;
  const entry = (name) => `'${pathToFileURL(join(ROOT, 'wasm', name)).href}'`;
  return example.program.replace(/'@tinyactors\/wasm\/init'/g, entry('init.mjs')).replace(/'@tinyactors\/wasm'/g, entry('index.mjs'));
}

/** Runs `file` with this runtime: its exit code, stdout and stderr. */
function execute(file, cwd, wasmPackage) {
  return new Promise((resolve) => {
    const flags = wasmPackage ? ['--conditions=tinyactors-wasm'] : [];
    const child = spawn(process.execPath, [...flags, file], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('the documents have examples', () => {
  if (everyExample.length < DOCUMENTS.length) throw new Error(`${everyExample.length} examples in ${DOCUMENTS.length} documents`);
  for (const document of DOCUMENTS)
    if (!everyExample.some((example) => example.document === document)) throw new Error(`${document} has no example`);
});

test('every export of index.d.ts, and every member of Host, has a doc comment', () => {
  const lines = readFileSync(join(ROOT, 'index.d.ts'), 'utf8').split('\n');
  const missing = [];
  let inHost = false;
  lines.forEach((line, i) => {
    if (/^export class Host\b/.test(line)) inHost = true;
    else if (inHost && line === '}') inHost = false;
    const declares = /^export /.test(line) || (inHost && /^ {2}[^ /*].*;$/.test(line));
    if (!declares) return;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    if (!lines[j]?.trim().endsWith('*/')) missing.push(`${i + 1}: ${line.trim()}`);
  });
  if (missing.length) throw new Error(`no doc comment:\n${missing.join('\n')}`);
});

if (DATAMODEL === 'native') {
  const examples = everyExample.filter((example) => !example.browser && example.file === undefined);
  const directory = mkdtempSync(join(ROOT, 'build', 'docs-'));
  // a few at a time: each is a runtime of its own
  const pending = examples.map(() => undefined);
  let next = 0;
  const start = () => {
    if (next === examples.length) return;
    const i = next++;
    const file = join(directory, fileName(examples[i]));
    writeFileSync(file, programOf(examples[i]));
    pending[i].resolve(execute(file, directory, examples[i].wasmPackage).finally(start));
  };
  for (let i = 0; i < examples.length; i++) {
    let resolve;
    const result = new Promise((r) => (resolve = r));
    pending[i] = { result, resolve };
  }
  for (let i = 0; i < 4; i++) start();

  examples.forEach((example, i) => {
    test(`${example.document}:${example.line} runs as written`, async () => {
      const { code, signal, stdout, stderr } = await pending[i].result;
      if (code !== 0) throw new Error(`exit ${code ?? signal}\n${stderr}${stdout}`);
      if (example.output !== undefined && stdout.trimEnd() !== example.output.trimEnd())
        throw new Error(`printed:\n${stdout}\nexpected:\n${example.output}\n${stderr}`);
    });
  });
  test('the examples\' directory is removed', () => rmSync(directory, { recursive: true, force: true }));
}

await run();
