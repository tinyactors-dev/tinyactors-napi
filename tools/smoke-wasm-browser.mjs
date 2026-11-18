// @tinyactors/wasm's smoke test in Chromium (mise/pack.rb): serves a fresh
// project that installed the package from its tarball (its directory, the
// argument) over HTTP, every response under the Content-Security-Policy
// docs/guide/browser.md documents, and runs smoke-wasm-check.mjs (copied
// into the project) through both entries without a bundler: in a page that
// imports the package by its name through an import map (whose inline
// script the policy allows by its hash), and in a module Worker, which has
// no import map and imports the entries by their paths. Chromium is the
// pre-installed Playwright's (PLAYWRIGHT_CHROMIUM); without Playwright it
// fails, since the release needs the browser checked.
//
//   node tools/smoke-wasm-browser.mjs <project>
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { launch, playwright } from '../wasm/test/serve.mjs';

const project = normalize(process.argv[2] ?? '') + sep;
const PACKAGE = '/node_modules/@tinyactors/wasm';
const IMPORT_MAP = JSON.stringify({ imports: { '@tinyactors/wasm': `${PACKAGE}/index.mjs`, '@tinyactors/wasm/init': `${PACKAGE}/init.mjs` } });
const hash = createHash('sha256').update(IMPORT_MAP).digest('base64');
// the guide's policy, and the import map's hash
const POLICY = `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'sha256-${hash}'`;
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };

const report = (where) => `.then((failures) => report(failures), (error) => report([String(error?.stack ?? error)]));
function report(failures) { ${where} }`;
const GENERATED = {
  '/page.html': `<!doctype html><meta charset="utf-8"><title>smoke</title>
<script type="importmap">${IMPORT_MAP}</script>
<script type="module" src="/page.mjs"></script>`,
  '/page.mjs': `import { check } from './smoke-wasm-check.mjs';
check((entry) => import(entry === '.' ? '@tinyactors/wasm' : '@tinyactors/wasm/init'))${report('window.__out = failures;')}`,
  '/worker.html': '<!doctype html><meta charset="utf-8"><title>smoke</title><script type="module" src="/worker-page.mjs"></script>',
  '/worker-page.mjs': `const worker = new Worker('/worker.mjs', { type: 'module' });
worker.onmessage = (event) => { window.__out = event.data; };
worker.onerror = (event) => { window.__out = ['the Worker failed: ' + event.message]; };`,
  '/worker.mjs': `import { check } from './smoke-wasm-check.mjs';
check((entry) => import(entry === '.' ? '.${PACKAGE}/index.mjs' : '.${PACKAGE}/init.mjs'))${report('postMessage(failures);')}`,
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  const headers = { 'content-security-policy': POLICY };
  if (path === '/favicon.ico') return response.writeHead(204, headers).end(); // a page asks for one
  let body = GENERATED[path];
  if (body === undefined) {
    const file = normalize(join(project, decodeURIComponent(path)));
    if (!file.startsWith(project)) return response.writeHead(403, headers).end();
    try {
      body = await readFile(file);
    } catch {
      return response.writeHead(404, headers).end();
    }
  }
  response.writeHead(200, { ...headers, 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const pw = playwright();
if (pw === null) {
  console.error('smoke: chromium: no Playwright installed');
  process.exit(1);
}
const browser = await launch(pw);
let failed = false;
try {
  for (const [where, path] of [['a page', '/page.html'], ['a module Worker', '/worker.html']]) {
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}${path}`);
    await page.waitForFunction(() => window.__out !== undefined, null, { timeout: 60000 });
    const failures = [...(await page.evaluate(() => window.__out)), ...errors];
    for (const failure of failures) console.error(`smoke: chromium ${browser.version()}, ${where}: ${failure}`);
    if (failures.length > 0) failed = true;
    else console.log(`smoke: ok: chromium ${browser.version()}, ${where}, both entries, under ${POLICY.replace(/ 'sha256-.*'/, '')}`);
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
