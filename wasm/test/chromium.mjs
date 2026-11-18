// The shared test files (test/*.test.mjs) against @tinyactors/wasm in
// Chromium (docs/plan.xml, p5-api; docs/browser.md, "One API"): each file
// in a page of its own, whose import map resolves `@tinyactors/node` to the
// wasm package and the `node:` built-ins to stubs (wasm/test/serve.mjs),
// with the cases wasm/test/exclusions.mjs lists for the browser skipped,
// once on each datamodel (native, quickjs), as the test task runs them in
// node and bun.
// Each line a page prints is printed here; a file that fails, or does not
// finish within its time, fails the run. `node wasm/test/chromium.mjs
// [file...]` runs the files named (test/<file>), all of them by default;
// `--datamodel=<name>` on that datamodel only; `--run-excluded` runs the
// excluded cases too and reports those that pass.
import { readdirSync } from 'node:fs';
import { fileExcluded } from './exclusions.mjs';
import { REPOSITORY, launch, napi, playwright, serve, testPage } from './serve.mjs';

const args = process.argv.slice(2);
const runExcluded = args.includes('--run-excluded');
const named = args.filter((arg) => !arg.startsWith('--'));
const chosen = args.find((arg) => arg.startsWith('--datamodel='))?.slice('--datamodel='.length);
const datamodels = chosen !== undefined ? [chosen] : ['native', 'quickjs'];
const files = named.length > 0 ? named : readdirSync(new URL('../../test/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort();
const LIMIT = 240_000; // ms a file may take

const pw = playwright();
if (pw === null) {
  console.log('chromium: skip: no Playwright installed');
  process.exit(0);
}

const pathOf = (file, datamodel) => napi(`test/${file}.${datamodel}.html`);
const pages = new Map(files.flatMap((file) => datamodels.map((datamodel) => [pathOf(file, datamodel), testPage(file, { datamodel, runExcluded })])));
const server = await serve(pages);
const browser = await launch(pw);
let failedFiles = 0;
const totals = { ok: 0, skip: 0, fail: 0, files: 0 };
try {
  for (const [datamodel, file] of datamodels.flatMap((datamodel) => files.map((file) => [datamodel, file]))) {
    const whole = fileExcluded(file, 'browser');
    if (whole !== undefined) {
      totals.files++;
      console.log(`chromium: skip ${file} (${whole})`);
      continue;
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    const started = Date.now();
    let failures = 0;
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    await page.exposeFunction('__tinyactors_done', (failed) => finish(failed)); // before the page loads
    page.on('console', (message) => {
      const text = message.text();
      if (/^(ok|skip|FAIL) /.test(text)) totals[text.startsWith('ok') ? 'ok' : text.startsWith('skip') ? 'skip' : 'fail']++;
      if (/^Failed to load resource/.test(text)) return; // a favicon
      console.log(text);
    });
    page.on('pageerror', (error) => console.log(`pageerror ${String(error?.stack ?? error)}`));
    console.log(`chromium: ${datamodel} ${file}`);
    await page.goto(`http://127.0.0.1:${server.address().port}${pathOf(file, datamodel)}`);
    let timer;
    const outcome = await Promise.race([done, new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), LIMIT);
    })]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      console.log(`FAIL ${file} did not finish within ${LIMIT / 1000} s`);
      failures = 1;
    } else failures = outcome;
    // a page whose run() resolves calls done once per run (a file's cases
    // may run once per datamodel); the first call says whether it failed
    if (failures) failedFiles++;
    console.log(`chromium: ${datamodel} ${file}: ${failures ? 'failed' : 'passed'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
console.log(`chromium: ${files.length} files on ${datamodels.join(' and ')} (${totals.files} runs excluded whole), ${totals.ok} cases passed, ${totals.skip} excluded, ${totals.fail} failed; repository ${REPOSITORY}`);
if (failedFiles) process.exit(1);
