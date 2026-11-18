// The conformance suite's adapter, conform.mjs, against @tinyactors/wasm in
// Chromium (docs/plan.xml, p5-datamodel): a bridge the runner starts as
// its command (`node wasm/test/conform.mjs`), which opens one page whose
// import map resolves `@tinyactors/node` to the wasm package and
// `node:buffer` and `node:process` to the page's own (wasm/test/conform/),
// imports conform.mjs there unchanged, and relays the driver's frames:
// its standard input to the page, the page's standard output and error
// back. It exits when its input ends and the page's adapter closed its
// host. Without Playwright it says so on standard error and exits 70;
// `--available` exits 0 when Playwright is there, 1 when not.
import process from 'node:process';
import { IMPORT_MAP, launch, napi, playwright, serve } from './serve.mjs';

const pw = playwright();
if (process.argv.includes('--available')) process.exit(pw === null ? 1 : 0);
if (pw === null) {
  process.stderr.write('conform (chromium): no Playwright installed\n');
  process.exit(70);
}
const map = {
  imports: {
    ...IMPORT_MAP.imports,
    'node:buffer': napi('wasm/test/conform/node-buffer.mjs'),
    'node:process': napi('wasm/test/conform/node-process.mjs'),
  },
};
const PAGE = napi('wasm/test/conform.html');
const html = `<!doctype html><meta charset="utf-8"><title>conform</title>
<script type="importmap">${JSON.stringify(map)}</script>
<script type="module">
import ${JSON.stringify(napi('wasm/test/conform/node-process.mjs'))};
import(${JSON.stringify(napi('conform.mjs'))}).then(() => globalThis.__tinyactors_ready(), (error) => {
  globalThis.__tinyactors_stderr('conform (chromium): the adapter did not load: ' + String(error?.stack ?? error) + '\\n');
  globalThis.__tinyactors_exit(70);
});
</script>`;
const server = await serve(new Map([[PAGE, html]]));
const browser = await launch(pw);
let exiting = false;
const finish = async (code) => {
  if (exiting) return;
  exiting = true;
  try {
    await browser.close();
  } finally {
    server.closeAllConnections();
    server.close();
    process.exitCode = code;
  }
};
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (error) => process.stderr.write(`conform (chromium): ${error?.stack ?? error}\n`));
let ready;
const loaded = new Promise((resolve) => {
  ready = resolve;
});
await page.exposeFunction('__tinyactors_ready', () => ready());
await page.exposeFunction('__tinyactors_stdout', (base64) => {
  process.stdout.write(Buffer.from(base64, 'base64'));
});
await page.exposeFunction('__tinyactors_stderr', (text) => {
  process.stderr.write(text);
});
await page.exposeFunction('__tinyactors_exit', (code) => finish(code));
await page.goto(`http://127.0.0.1:${server.address().port}${PAGE}`);
await loaded;
// the input, in order: each chunk given to the page after the one before it
let queue = Promise.resolve();
process.stdin.on('data', (chunk) => {
  const base64 = chunk.toString('base64');
  queue = queue.then(() => page.evaluate((b) => globalThis.__tinyactors_stdin(b), base64));
});
process.stdin.on('end', () => {
  queue = queue.then(async () => {
    await page.evaluate(() => globalThis.__tinyactors_stdin_end());
    // the adapter answers what it has, then closes its host: give it its turns
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await finish(0);
  }).catch(async (error) => {
    process.stderr.write(`conform (chromium): ${error?.stack ?? error}\n`);
    await finish(70);
  });
});
