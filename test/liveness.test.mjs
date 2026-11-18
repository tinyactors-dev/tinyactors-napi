// What keeps the process alive (docs/plan.xml, p1-loop; AGENTS.md, "The
// loop"): a host keeps it alive only while a turn or a timer at a deadline
// is pending, so a process whose hosts have nothing to do exits, open or
// not, and an open host with a pending deadline keeps it alive until the
// deadline, or until close(). Each case runs a child process of this
// runtime.
import { spawnSync } from 'node:child_process';
import { run, test } from './harness.mjs';

const index = new URL('../index.mjs', import.meta.url).href;

// Runs `body` (the text of an async function's body, given the module as
// `m`) in a child; its exit status, output and whether it ran out of time.
function child(body) {
  const code = `import(${JSON.stringify(index)}).then(async (m) => { ${body} });`;
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, timedOut: result.error?.code === 'ETIMEDOUT' };
}

function exits(body, what) {
  const result = child(body);
  if (result.timedOut) throw new Error(`${what}: the process did not exit`);
  if (result.status !== 0) throw new Error(`${what}: exit status ${result.status}\n${result.output}`);
  return result.output;
}

test('a process with only an open host exits', () => {
  exits(`globalThis.host = new m.Host({ systemID: 't' }, { datamodel: process.env.TA_NAPI_DATAMODEL ?? 'native' });`, 'a host never turned');
});

test('a process exits after an idle turn, the host still open', () => {
  const output = exits(`
    globalThis.host = new m.Host({ systemID: 't' }, { datamodel: process.env.TA_NAPI_DATAMODEL ?? 'native' });
    await host.idle();
    console.log('idle', host.closed, host.nextDeadline);`, 'a host idle');
  if (!output.includes('idle false undefined')) throw new Error(`the child said: ${output}`);
});

test('a process exits with a simulated clock moved', () => {
  exits(`
    const clock = new m.SimulatedClock();
    globalThis.host = new m.Host({ systemID: 't' }, { datamodel: process.env.TA_NAPI_DATAMODEL ?? 'native', clock });
    clock.increment(3600 * 1000);
    await host.idle();`, 'a host on a simulated clock');
});

test('a process exits when a waiting idle() is rejected by close()', () => {
  const output = exits(`
    const host = new m.Host({ systemID: 't' }, { datamodel: process.env.TA_NAPI_DATAMODEL ?? 'native' });
    const waiting = host.idle();
    host.close();
    await waiting.catch((error) => console.log('rejected', error.status));`, 'a host closed while idle() waits');
  if (!output.includes('rejected TA_ERROR_STATE')) throw new Error(`the child said: ${output}`);
});

// A child whose actor ends `ms` after it starts (a delayed send to itself);
// it prints how long the process lived.
function delayed(ms, after) {
  return `
    const chart = '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="later" initial="s">'
      + '<state id="s"><onentry><send event="later" delay="${ms}ms"/></onentry><transition event="later" target="done"/></state>'
      + '<final id="done"/></scxml>';
    const started = Date.now();
    process.on('exit', () => console.log('lived', Date.now() - started));
    const compiled = m.compileCharts([{ name: 'later.scxml', text: chart }]);
    globalThis.host = new m.Host({ systemID: 't' }, { datamodel: process.env.TA_NAPI_DATAMODEL ?? 'native' });
    host.addImage(compiled.image);
    compiled.close();
    host.spawn(host.chart('later'), { name: 'later' });
    await host.idle();
    console.log('deadline', host.nextDeadline > 0);
    ${after}`;
}

const lived = (output) => Number(/lived (\d+)/.exec(output)?.[1]);

test('a pending deadline keeps the process alive until it comes', () => {
  const output = exits(delayed(400, ''), 'a host with a deadline');
  if (!output.includes('deadline true')) throw new Error(`the child said: ${output}`);
  if (!(lived(output) >= 350)) throw new Error(`the process exited before the deadline: ${output}`);
});

test('close() lets a process with a pending deadline exit', () => {
  const output = exits(delayed(5000, 'host.close();'), 'a host closed with a deadline pending');
  if (!output.includes('deadline true')) throw new Error(`the child said: ${output}`);
  if (!(lived(output) < 4000)) throw new Error(`the process waited for the deadline: ${output}`);
});

await run();
