// Where @tinyactors/node finds no addon (lib/direct.mjs): an install with
// no build/ and no platform package names the missing package and points
// to @tinyactors/wasm; a platform package of another version asks for a
// reinstall. Each case copies lib/direct.mjs and package.json into a
// temporary node_modules, as an installed package lays them out, and
// imports the copy, which finds neither the repository's build nor its
// node_modules.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { equal } from './charts.mjs';
import { run, test } from './harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM = `@tinyactors/node-${process.platform}-${process.arch}`;
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** What importing an installed copy of lib/direct.mjs throws, with a
 * platform package of `platformVersion` beside it (none: undefined). */
async function loading(platformVersion) {
  const directory = mkdtempSync(join(tmpdir(), 'tinyactors-addon-'));
  try {
    const home = join(directory, 'node_modules/@tinyactors/node');
    mkdirSync(join(home, 'lib'), { recursive: true });
    cpSync(join(ROOT, 'lib/direct.mjs'), join(home, 'lib/direct.mjs'));
    cpSync(join(ROOT, 'package.json'), join(home, 'package.json'));
    if (platformVersion !== undefined) {
      const platform = join(directory, 'node_modules', PLATFORM);
      mkdirSync(platform, { recursive: true });
      writeFileSync(join(platform, 'package.json'), JSON.stringify({ name: PLATFORM, version: platformVersion, main: 'tinyactors.node' }));
    }
    try {
      await import(pathToFileURL(join(home, 'lib/direct.mjs')).href);
    } catch (error) {
      return error;
    }
    throw new Error('the copy loaded an addon');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('no addon: the message names the platform package, the build and @tinyactors/wasm', async () => {
  const error = await loading(undefined);
  equal(error instanceof Error, true, 'an Error');
  for (const part of [`no addon for ${process.platform}-${process.arch}`, `${PLATFORM} is not installed`, 'mise run build',
    '@tinyactors/wasm runs the same API on any platform']) {
    if (!error.message.includes(part)) throw new Error(`the message lacks "${part}": ${error.message}`);
  }
  equal(error.cause?.code, 'MODULE_NOT_FOUND', 'the cause is the failed resolution');
});

test('a platform package of another version: reinstall', async () => {
  const error = await loading('0.0.0-other');
  equal(error.message, `@tinyactors/node: ${PLATFORM} is 0.0.0-other, not ${version}: reinstall @tinyactors/node`, 'the message');
});

await run();
