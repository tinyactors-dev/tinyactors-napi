// What the Chromium tests share (browser.test.mjs, chromium.mjs): the
// pre-installed Playwright, and a server of the repository's files over
// HTTP on a port of its own (port 0), as a page or a Worker fetches them.
//
// It serves tinyactors-napi/ and the suite's protocol vectors only. A page
// resolves `@tinyactors/node` and the `node:` built-ins the shared tests
// import through the import map of the page it makes (testPage); a Worker
// has no import map, so lib/convenience.mjs is served with its `#direct`
// (package.json's subpath import, which a browser does not read) written
// as the path of the wasm package's direct layer, as the staged
// @tinyactors/wasm will hold it (p5-pack).
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url));
const SERVED = ['tinyactors-napi', 'tinyactors-test/suites/protocol'].map((dir) => join(REPOSITORY, dir) + sep);
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.txt': 'text/plain' };

// The URL path of a file of tinyactors-napi/.
export const napi = (path) => `/tinyactors-napi/${path}`;

const STUBS = ['fs', 'path', 'url', 'os', 'child_process', 'worker_threads'];

/** The import map of a page that runs the shared tests against @tinyactors/wasm. */
export const IMPORT_MAP = {
  imports: {
    '@tinyactors/node': napi('wasm/index.mjs'),
    '#direct': napi('wasm/lib/direct.mjs'),
    ...Object.fromEntries(STUBS.map((name) => [`node:${name}`, napi(`wasm/test/browser/node-${name}.mjs`)])),
  },
};

/** The page that runs test file `file` (test/<file>): its globals first
 * (test/runtime.mjs reads __tinyactors_test), then the file. */
export function testPage(file, { datamodel = 'native', runExcluded = false } = {}) {
  return `<!doctype html><meta charset="utf-8"><title>${file}</title>
<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
<script type="module">
import { install } from '${napi('wasm/test/browser/process.mjs')}';
install();
globalThis.__tinyactors_test = {
  datamodel: ${JSON.stringify(datamodel)}, file: ${JSON.stringify(file)}, runExcluded: ${JSON.stringify(runExcluded)},
  done(failed) { globalThis.__tinyactors_done(failed); },
};
import(${JSON.stringify(napi(`test/${file}`))}).catch((error) => {
  console.log('FAIL the file did not load: ' + String(error?.stack ?? error));
  globalThis.__tinyactors_done(1);
});
</script>`;
}

/** Playwright, from this directory or npm's global modules; null when none. */
export function playwright() {
  const require = createRequire(import.meta.url);
  const paths = [REPOSITORY];
  try {
    paths.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch {
    // no npm on PATH
  }
  try {
    return require(require.resolve('playwright', { paths }));
  } catch {
    return null;
  }
}

/** Chromium, the pre-installed one (PLAYWRIGHT_CHROMIUM) or Playwright's,
 * with gc() exposed for the tests that collect. */
export function launch(pw) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  return pw.chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--js-flags=--expose-gc'] });
}

/** The server, listening on 127.0.0.1 and a port of its own; `pages` maps
 * a path to the HTML it answers (or to {headers, body}). */
export function serve(pages = new Map()) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x');
    const page = pages.get(url.pathname);
    if (page !== undefined && typeof page === 'object') { // {headers, body}: a page under a policy
      return response.writeHead(200, { 'content-type': 'text/html', ...page.headers }).end(page.body);
    }
    if (page !== undefined) return response.writeHead(200, { 'content-type': 'text/html' }).end(typeof page === 'function' ? page(url) : page);
    const path = normalize(join(REPOSITORY, decodeURIComponent(url.pathname)));
    if (!SERVED.some((dir) => path.startsWith(dir))) return response.writeHead(403).end();
    let body;
    try {
      body = await readFile(path);
    } catch {
      return response.writeHead(404).end();
    }
    if (path === join(REPOSITORY, 'tinyactors-napi/lib/convenience.mjs')) {
      body = body.toString('utf8').replace(/from '#direct'/g, `from '${napi('wasm/lib/direct.mjs')}'`);
    }
    // any origin may read them: a sandboxed page's is opaque
    return response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' })
      .end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
