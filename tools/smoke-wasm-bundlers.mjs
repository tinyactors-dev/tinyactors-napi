// @tinyactors/wasm through the bundlers (mise/pack.rb): in a fresh project
// that installed the package from its tarball (its directory, the
// argument), installs esbuild and Vite at the versions below from npm,
// bundles a page that runs smoke-wasm-check.mjs (copied into the project)
// through both entries with each, serves each bundle to Chromium under the
// policy docs/guide/browser.md documents, and fails on any failure the
// checks report. esbuild does not follow new URL(..., import.meta.url), so
// tinyactors.wasm is copied beside its bundle, as the guide says; Vite
// places the module itself. Needs the npm registry.
//
//   node tools/smoke-wasm-bundlers.mjs <project>
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { launch, playwright } from '../wasm/test/serve.mjs';

const ESBUILD = '0.28.2';
const VITE = '8.3.4';
const project = normalize(process.argv[2] ?? '') + sep;
const POLICY = "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'";
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const npm = join(dirname(process.execPath), 'npm');

execFileSync(npm, ['install', '--no-audit', '--no-fund', '--silent', '--save-dev', `esbuild@${ESBUILD}`, `vite@${VITE}`],
  { cwd: project, stdio: 'inherit' });

// the page's module: both entries by their names, which each bundler resolves
const MAIN = `import { check } from './smoke-wasm-check.mjs';
check((entry) => (entry === '.' ? import('@tinyactors/wasm') : import('@tinyactors/wasm/init')))
  .then((failures) => { window.__out = failures; }, (error) => { window.__out = [String(error?.stack ?? error)]; });
`;
writeFileSync(join(project, 'main.mjs'), MAIN);
writeFileSync(join(project, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>smoke</title><script type="module" src="./main.mjs"></script>\n');

const bin = (name) => join(project, 'node_modules/.bin', name);
const builds = {
  esbuild: () => {
    const out = join(project, 'dist-esbuild');
    execFileSync(bin('esbuild'), ['main.mjs', '--bundle', '--format=esm', '--splitting', '--target=es2022',
      `--outdir=${out}`, '--log-level=warning'], { cwd: project, stdio: 'inherit' });
    copyFileSync(join(project, 'node_modules/@tinyactors/wasm/tinyactors.wasm'), join(out, 'tinyactors.wasm'));
    writeFileSync(join(out, 'index.html'),
      '<!doctype html><meta charset="utf-8"><title>smoke</title><script type="module" src="./main.js"></script>\n');
    return out;
  },
  vite: () => {
    const out = join(project, 'dist-vite');
    execFileSync(bin('vite'), ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { cwd: project, stdio: 'inherit' });
    return out;
  },
};

function serveDirectory(root) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    const headers = { 'content-security-policy': POLICY };
    if (path === '/favicon.ico') return response.writeHead(204, headers).end();
    const file = normalize(join(root, decodeURIComponent(path === '/' ? '/index.html' : path)));
    if (!file.startsWith(root + sep)) return response.writeHead(403, headers).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404, headers).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const pw = playwright();
if (pw === null) throw new Error('smoke-wasm-bundlers: no Playwright: the bundled pages need Chromium');
const browser = await launch(pw);
const failed = [];
try {
  for (const [name, build] of Object.entries(builds)) {
    const root = normalize(build());
    const server = await serveDirectory(root);
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const out = await page.waitForFunction(() => window.__out, null, { timeout: 60_000 }).then((h) => h.jsonValue(), () => null);
      const failures = out === null ? ['the page reported nothing in 60 s', ...errors] : out;
      if (failures.length) failed.push(`${name}: ${failures.join('; ')}`);
      else console.log(`smoke-wasm-bundlers: ${name} ${name === 'esbuild' ? ESBUILD : VITE}: ok, both entries in Chromium`);
      await page.close();
    } finally {
      server.close();
    }
  }
} finally {
  await browser.close();
}
if (failed.length) {
  for (const line of failed) console.error(`smoke-wasm-bundlers: ${line}`);
  process.exit(1);
}
