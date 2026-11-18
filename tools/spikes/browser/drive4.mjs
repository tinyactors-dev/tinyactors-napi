// chartgen.mjs in Chromium: semantics in an iframe's realm, and the bytes a session costs.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim() + '/')('playwright');
const dir = new URL('.', import.meta.url).pathname;
const server = createServer(async (q, s) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/') return s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><body>');
  try { s.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(dir + p.slice(1))); } catch { s.writeHead(404).end(); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch(); const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const cdp = await page.context().newCDPSession(page);
const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
const semantics = await page.evaluate(async () => { const m = await import('/chartgen.mjs'); const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f); window.realm = f.contentWindow; window.m = m; m.makeSessions(realm, 10); return m.chartgen(realm); });
const h0 = await heap(); await page.evaluate(() => m.makeSessions(realm, 10000)); const h1 = await heap();
console.log('chromium', JSON.stringify({ ...semantics, sessionHeapBytes: Math.round((h1 - h0) / 10000) }));
await browser.close(); server.close();
