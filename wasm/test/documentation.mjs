// The user documentation in Chromium against @tinyactors/wasm (docs/plan.xml,
// p5-parity): every ```js block of README.md and docs/guide/*.md that
// needs no Node.js built-in (test/docs.test.mjs runs them all in node and
// bun), each a module of its own in a page of its own, its console.log
// lines formatted as node's (wasm/test/browser/console.mjs) and compared
// with the block's ```output; then the example applications' tests
// (examples/<name>/test.mjs) whose application runs in a page, with
// node:test and node:assert/strict given by small shims of the page's
// (wasm/test/browser/node-test.mjs, node-assert.mjs), node:fs's
// readFileSync of a file beside the example (its charts, given to the
// page before it loads), and the
// setImmediate its own code calls, installed after the package loaded so
// the package itself sees a plain page. What stays in node and bun is
// listed with its reason in wasm/test/documented.mjs; this program prints
// each such block and case, and fails on an unlisted block that needs
// Node.js, on a listed one that does not, and on a listed case a test does
// not have.
//
// Usage: node wasm/test/documentation.mjs [--blocks|--applications]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { examples as readExamples, fileName } from '../../tools/examples.mjs';
import { APPLICATIONS, BLOCKS, CASES, needs } from './documented.mjs';
import { launch, napi, playwright, serve } from './serve.mjs';

const ROOT = new URL('../../', import.meta.url);
const args = process.argv.slice(2);
const doBlocks = !args.includes('--applications');
const doApplications = !args.includes('--blocks');
const LIMIT = 60_000; // ms a page may take
const QUIET = 300; // ms without a line after a block's module settled: it is done

const pw = playwright();
if (pw === null) {
  console.log('documentation: skip: no Playwright installed');
  process.exit(0);
}

const PACKAGE = {
  '@tinyactors/node': napi('wasm/index.mjs'),
  '@tinyactors/wasm': napi('wasm/index.mjs'),
  '@tinyactors/wasm/init': napi('wasm/init.mjs'),
  '#direct': napi('wasm/lib/direct.mjs'),
};
const browserShim = (name) => napi(`wasm/test/browser/${name}.mjs`);
const NODE = {
  'node:test': browserShim('node-test'),
  'node:assert': browserShim('node-assert'),
  'node:assert/strict': browserShim('node-assert'),
  'node:fs': browserShim('example-fs'),
  'node:url': browserShim('example-url'),
  'node:util': browserShim('node-util'),
  'node:perf_hooks': browserShim('node-perf_hooks'),
  ...Object.fromEntries(['path', 'os', 'child_process', 'worker_threads'].map((name) => [`node:${name}`, browserShim(`node-${name}`)])),
};
const importMap = (imports) => `<script type="importmap">${JSON.stringify({ imports })}</script>`;

function blockPage(module) {
  return `<!doctype html><meta charset="utf-8"><title>block</title>${importMap(PACKAGE)}
<script type="module">
import { capture } from ${JSON.stringify(browserShim('console'))};
capture((line) => globalThis.__tinyactors_line(line));
addEventListener('unhandledrejection', (event) => globalThis.__tinyactors_error('an unhandled rejection: ' + String(event.reason?.stack ?? event.reason)));
addEventListener('error', (event) => globalThis.__tinyactors_error('an uncaught error: ' + String(event.error?.stack ?? event.message)));
import(${JSON.stringify(module)}).then(() => globalThis.__tinyactors_settled(), (error) => {
  globalThis.__tinyactors_error(String(error?.stack ?? error));
  globalThis.__tinyactors_settled();
});
</script>`;
}

function applicationPage(name) {
  return `<!doctype html><meta charset="utf-8"><title>${name}</title>${importMap({ ...PACKAGE, ...NODE })}
<script type="module">
import { install } from ${JSON.stringify(browserShim('process'))};
install();
globalThis.process.argv = [];
await import('@tinyactors/node'); // the package first: it picks its scheduler on a plain page
// what the example's own code calls of node's globals
const channel = new MessageChannel();
const pending = [];
channel.port1.onmessage = () => { const entry = pending.shift(); if (entry && !entry.cancelled) entry.fn(...entry.args); };
globalThis.setImmediate = (fn, ...args) => { const entry = { fn, args, cancelled: false }; pending.push(entry); channel.port2.postMessage(null); return entry; };
globalThis.clearImmediate = (entry) => { if (entry) entry.cancelled = true; };
try {
  const { run } = await import('node:test');
  await import(${JSON.stringify(napi(`examples/${name}/test.mjs`))});
  globalThis.__tinyactors_done(await run(globalThis.__tinyactors_example));
} catch (error) {
  console.log('FAIL the test did not load: ' + String(error?.stack ?? error));
  globalThis.__tinyactors_done({ failures: 1, names: [] });
}
</script>`;
}

const examples = readExamples(ROOT.pathname);
const applications = readdirSync(new URL('examples/', ROOT)).filter((name) => existsSync(new URL(`examples/${name}/test.mjs`, ROOT))).sort();
const pages = new Map();
// a module another block loads (a Worker's script) by its name, its
// package's imports written as their paths: a Worker has no import map
const absolute = (program) => program.replace(/'(@tinyactors\/(?:node|wasm(?:\/init)?))'/g, (match, name) => JSON.stringify(PACKAGE[name]).replace(/"/g, "'"));
examples.forEach((example) => {
  if (example.file !== undefined) {
    pages.set(napi(`documentation/${example.file}`), { headers: { 'content-type': 'text/javascript' }, body: absolute(example.program) });
    return;
  }
  const file = fileName(example);
  pages.set(napi(`documentation/${file}`), { headers: { 'content-type': 'text/javascript' }, body: example.program });
  pages.set(napi(`documentation/${file}.html`), blockPage(napi(`documentation/${file}`)));
});
for (const name of applications) pages.set(napi(`examples/${name}/test.html`), applicationPage(name));
const server = await serve(pages);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await launch(pw);
let failures = 0;
const counts = { blocks: 0, blocksSkipped: 0, cases: 0, casesSkipped: 0, applications: 0, applicationsSkipped: 0 };
const fail = (text) => {
  failures++;
  console.log(`FAIL ${text}`);
};

/** A page of its own: `expose` gives the page its functions and answers
 * {outcome}, a promise of what the page reports; 'timeout' when it does
 * not within LIMIT. */
async function inPage(path, expose) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => fail(`${path}: ${String(error?.stack ?? error)}`));
  page.on('worker', (worker) => worker.on('console', (message) => console.log(`  worker: ${message.text()}`)));
  const { outcome } = await expose(page);
  await page.goto(`${origin}${path}`);
  let timer;
  const result = await Promise.race([outcome, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), LIMIT); })]);
  clearTimeout(timer);
  await context.close();
  return result;
}

async function runBlock(example) {
  const key = `${example.document}:${example.line}`;
  if (example.file !== undefined) return; // served, run by the block that loads it
  const used = needs(example.program);
  const listed = BLOCKS[key];
  if (used.length > 0 && listed === undefined) return fail(`${key} uses ${used.join(', ')}: run it in a page, or list it with its reason in wasm/test/documented.mjs`);
  if (listed !== undefined && used.length === 0) return fail(`${key} is listed in wasm/test/documented.mjs (${listed}) but uses no Node.js built-in`);
  if (listed !== undefined) {
    counts.blocksSkipped++;
    return console.log(`skip ${key} (${listed})`);
  }
  counts.blocks++;
  const lines = [];
  const errors = [];
  let last = Date.now();
  const result = await inPage(napi(`documentation/${fileName(example)}.html`), async (page) => {
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    await page.exposeFunction('__tinyactors_line', (line) => { lines.push(line); last = Date.now(); });
    await page.exposeFunction('__tinyactors_error', (text) => errors.push(text));
    await page.exposeFunction('__tinyactors_settled', () => settle());
    // done once the module settled and nothing printed for QUIET ms
    return {
      outcome: settled.then(async () => {
        while (Date.now() - last < QUIET) await new Promise((resolve) => setTimeout(resolve, QUIET));
      }),
    };
  });
  const printed = lines.join('\n');
  if (result === 'timeout') return fail(`${key} did not finish within ${LIMIT / 1000} s:\n${printed}`);
  if (errors.length > 0) return fail(`${key}: ${errors.join('\n')}\n${printed}`);
  if (example.output !== undefined && printed.trimEnd() !== example.output.trimEnd())
    return fail(`${key} printed:\n${printed}\nexpected:\n${example.output}`);
  console.log(`ok   ${key}`);
}

/** The text files of examples/<name>/ by their URL paths, for its
 * readFileSync in the page (wasm/test/browser/example-fs.mjs). */
function filesOf(name) {
  const files = {};
  const walk = (relative) => {
    const url = new URL(`examples/${name}/${relative}`, ROOT);
    for (const entry of readdirSync(url)) {
      const path = `${relative}${entry}`;
      if (statSync(new URL(path, new URL(`examples/${name}/`, ROOT))).isDirectory()) walk(`${path}/`);
      else if (/\.(scxml|mjs|json|txt|xml|py)$/.test(entry)) files[napi(`examples/${name}/${path}`)] = readFileSync(new URL(path, new URL(`examples/${name}/`, ROOT)), 'utf8');
    }
  };
  walk('');
  return files;
}

async function runApplication(name) {
  if (APPLICATIONS[name] !== undefined) {
    counts.applicationsSkipped++;
    return console.log(`skip examples/${name} (${APPLICATIONS[name]})`);
  }
  if (CASES[name] === undefined) return fail(`examples/${name} is in neither APPLICATIONS nor CASES of wasm/test/documented.mjs`);
  counts.applications++;
  console.log(`documentation: examples/${name}/test.mjs`);
  const result = await inPage(napi(`examples/${name}/test.html`), async (page) => {
    await page.addInitScript(([example, files]) => {
      globalThis.__tinyactors_example = example;
      globalThis.__tinyactors_files = files;
    }, [{ excluded: CASES[name] }, filesOf(name)]);
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    page.on('console', (message) => {
      const text = message.text();
      if (/^Failed to load resource/.test(text)) return;
      if (/^ok /.test(text)) counts.cases++;
      if (/^skip /.test(text)) counts.casesSkipped++;
      if (/^FAIL /.test(text)) failures++;
      console.log(`  ${text}`);
    });
    await page.exposeFunction('__tinyactors_done', (outcome) => done(outcome));
    return { outcome: finished };
  });
  if (result === 'timeout') return fail(`examples/${name}/test.mjs did not finish within ${LIMIT / 1000} s`);
  for (const listed of Object.keys(CASES[name])) {
    if (!result.names.includes(listed)) fail(`wasm/test/documented.mjs names a case examples/${name}/test.mjs does not have: ${listed}`);
  }
}

try {
  if (doBlocks) for (const example of examples) await runBlock(example);
  if (doApplications) for (const name of applications) await runApplication(name);
  for (const key of Object.keys(BLOCKS)) {
    if (!examples.some((example) => `${example.document}:${example.line}` === key)) fail(`wasm/test/documented.mjs lists ${key}, which is no block`);
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
console.log(`documentation: Chromium: ${counts.blocks} blocks ran, ${counts.blocksSkipped} stay in node and bun; ` +
  `${counts.applications} applications' tests, ${counts.cases} cases passed, ${counts.casesSkipped} skipped, ` +
  `${counts.applicationsSkipped} applications stay in node and bun${failures ? `; ${failures} failed` : ''}`);
if (failures) process.exit(1);
