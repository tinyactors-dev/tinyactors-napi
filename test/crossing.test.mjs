// What crosses between @tinyactors/node and @tinyactors/wasm (docs/plan.xml,
// p5-parity; docs/guide/browser.md, "One store, two packages"): nothing a
// host packs. A snapshot is the host's memory as the build that made it
// lays it out (core's docs/durability.md: "valid for the same build of the
// library only"), and the addon is a 64-bit build where the wasm package
// is a wasm32 one, so each package labels its packs with its own name and
// refuses the other's, naming it. The other package's snapshot is made by
// test/crossing.mjs in a process of this runtime.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Host, SimulatedClock, TinyactorsError } from '@tinyactors/node';
import { CONFIG, ENGINE, equal, LABEL } from './charts.mjs';
import { run, test } from './harness.mjs';
import { wasm } from './runtime.mjs';

const OTHER = wasm ? '@tinyactors/node' : '@tinyactors/wasm';
const HELPER = fileURLToPath(new URL('crossing.mjs', import.meta.url));

/** A snapshot made by the other package, in a process of this runtime. */
function otherSnapshot() {
  const directory = mkdtempSync(join(tmpdir(), 'tinyactors-crossing-'));
  try {
    const file = join(directory, 'snapshot');
    // the condition picks the wasm package; without it the name is the addon's
    const flags = wasm ? [] : ['--conditions=tinyactors-wasm'];
    const env = { ...process.env, NODE_OPTIONS: '', BUN_OPTIONS: '', TA_NAPI_PACKAGE: wasm ? '' : 'wasm' };
    const made = spawnSync(process.execPath, [...flags, HELPER, file], { env, encoding: 'utf8', timeout: 60_000 });
    if (made.status !== 0) throw new Error(`test/crossing.mjs failed: ${made.stderr}${made.stdout}`);
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a snapshot of the other package is refused by its label, naming that package', () => {
  const snapshot = otherSnapshot();
  const label = new TextDecoder().decode(snapshot).includes(wasm ? 'tinyactors-napi' : 'tinyactors-wasm');
  equal(label, true, `the other package's pack holds its own label, not ${LABEL}`);
  let refused;
  try {
    Host.restore(snapshot, CONFIG, { ...ENGINE, clock: new SimulatedClock() }).close();
  } catch (error) {
    refused = error;
  }
  if (!(refused instanceof TinyactorsError)) throw new Error(`restored, or refused otherwise: ${refused}`);
  equal(refused.status, 'TA_ERROR_INVALID', 'the status');
  if (!refused.message.startsWith(`a snapshot of ${OTHER}:`) || !/hibernation blobs/.test(refused.message))
    throw new Error(`the message does not name the package: ${refused.message}`);
});

await run();
