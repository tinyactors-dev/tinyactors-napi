// The spikes of docs/browser.md, in Chromium through the Playwright installed
// globally: node drive.mjs (boundary costs, realm semantics and costs per
// session, scheduling, a Worker, CSP), node drive2.mjs (string costs, the
// generator session surviving a throw, a detached iframe), node drive3.mjs
// (script-src 'self'). node run.mjs and bun run.mjs: the boundary in node and
// bun beside a Node-API call; vmgen.mjs: a generator session in a node:vm
// context. Needs calls.wasm (calls.c says how).
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim() + '/');
const { chromium } = require('playwright');
const dir = new URL('.', import.meta.url).pathname;
const CSP = { '/strict.html': "script-src 'self' 'wasm-unsafe-eval'", '/loose.html': "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'" };
const server = createServer(async (q, s) => {
  const path = new URL(q.url, 'http://x').pathname;
  if (path.endsWith('.html')) {
    const headers = { 'content-type': 'text/html' }; if (CSP[path]) headers['content-security-policy'] = CSP[path];
    const script = path === '/index.html' ? '<script type="module" src="/page.mjs"></script>' : '<script type="module" src="/csp.mjs"></script>';
    return s.writeHead(200, headers).end(`<!doctype html><body>${script}</body>`);
  }
  try { const body = await readFile(dir + path.slice(1)); s.writeHead(200, { 'content-type': path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }).end(body); } catch { s.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const out = { chromium: browser.version() };
async function rendererRSS() {
  let total = 0;
  for (const pid of await readdir('/proc')) { if (!/^\d+$/.test(pid)) continue; try { const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); if (!cmd.includes('--type=renderer')) continue; const st = readFileSync(`/proc/${pid}/status`, 'utf8'); total += Number(/VmRSS:\s+(\d+)/.exec(st)[1]) * 1024; } catch {} }
  return total;
}
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e));
  await page.goto(base + '/index.html'); await page.waitForFunction(() => window.spike);
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
  out.boundary = await page.evaluate(() => spike.boundary());
  out.semantics = await page.evaluate(() => spike.semantics());
  out.evalCosts = await page.evaluate(() => spike.evalCosts());
  out.scheduling = await page.evaluate(() => spike.scheduling());
  out.worker = await page.evaluate(() => spike.worker());
  const per = async (label, call, n) => {
    const h0 = await heap(); const r0 = await rendererRSS();
    const ms = await page.evaluate(call, n);
    const h1 = await heap(); const r1 = await rendererRSS();
    out[label] = { n, 'JS heap bytes each': Math.round((h1 - h0) / n), 'renderer RSS bytes each': Math.round((r1 - r0) / n), 'ms each': +ms.toFixed(3) };
  };
  await page.evaluate(() => { spike.makeScopes(10); spike.makeGenerators(10); });
  await per('scope objects (a shared chart\'s session)', (n) => spike.makeScopes(n), 10000);
  await per('generator sessions (a declaring chart\'s session, one realm)', (n) => spike.makeGenerators(n), 10000);
  await per('iframe realms (a realm per declaring session)', (n) => spike.makeIframes(n), 200);
  for (const p of ['strict', 'loose']) {
    const pg = await browser.newPage(); await pg.goto(`${base}/${p}.html`); await pg.waitForFunction(() => window.cspResult);
    out[`CSP ${CSP['/' + p + '.html']}`] = await pg.evaluate(() => window.cspResult); await pg.close();
  }
} finally { await browser.close(); server.close(); }
console.log(JSON.stringify(out, null, 1));
