// The example's test: a Python system (tinyactors-cpython) and this Node
// system in two processes, over a TCP connection on a port the Python
// system picks, the Python process running in a temporary directory. Run
// by `mise run remote-python --test` (from `mise run test`) under node and
// bun; each runtime runs it on both of the Node host's datamodels.
// PYTHON names the interpreter and PYTHONPATH the tinyactors-cpython build.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address, encode } from '@tinyactors/node';
import { run, test } from '../../test/harness.mjs';
import { converse } from './run.mjs';

const ROUNDS = 4;
const DATAMODELS = ['native', 'quickjs'];

/** What the value table carries, nested; quickjs drops a property whose
 * value is undefined in what a chart sends, as JSON does (on one host as
 * across two), so only the native datamodel gets one. */
const VALUE = (datamodel) => ({
  int: 42, negative: -7, safe: 2 ** 53 - 1, big: 2n ** 60n, max: 2n ** 64n - 1n, float: 0.25,
  text: 'größe ✓ 🎉', yes: true, no: false, none: null,
  ...(datamodel === 'native' ? { nothing: undefined } : {}),
  bytes: new Uint8Array([0, 1, 254, 255]), list: [1, [2, [3, { deep: ['x'] }]]], empty: {}, emptyList: [],
});

function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: ${String(actual)}, expected ${String(expected)}`);
}

const conversations = new Map();
/** One conversation per datamodel, shared by its cases. */
function conversation(datamodel) {
  if (!conversations.has(datamodel)) {
    const cwd = mkdtempSync(join(tmpdir(), 'remote-python-'));
    conversations.set(datamodel, converse({ rounds: ROUNDS, value: VALUE(datamodel), datamodel, cwd })
      .finally(() => rmSync(cwd, { recursive: true, force: true })));
  }
  return conversations.get(datamodel);
}

const labelled = (logs, label) => logs.filter((entry) => entry.label === label).map((entry) => entry.text);

for (const datamodel of DATAMODELS) {
  test(`${datamodel}: ping-pong for ${ROUNDS} rounds, each side replying to _event.origin with nested data`, async () => {
    const { node, python, ping } = await conversation(datamodel);
    const pinger = Address.fromSession('node', ping).text;
    equal(labelled(python, 'ping').join('\n'),
      Array.from({ length: ROUNDS }, (_, n) => `ping ${n} from ${pinger}`).join('\n'), 'the pings Python got');
    const pongs = [...labelled(node, 'pong'), ...labelled(node, 'done')];
    equal(pongs.length, ROUNDS, 'the pongs Node got');
    for (const [round, text] of pongs.entries()) {
      const [json, origin] = text.split(' from ');
      const pong = new Address(origin);
      equal(pong.system, 'py', `round ${round}: the pong's origin system`);
      equal(pong.session, 1n, `round ${round}: the pong's origin session`);
      const data = JSON.parse(json);
      equal(data.count, round + 1, `round ${round}: the count`);
      equal(data.served, round + 1, `round ${round}: what Python served`);
      equal(data.trail.join(), Array.from({ length: round + 1 }, () => 'node,py').join(), `round ${round}: the trail`);
      // the numbers grow by each computed sum: 1 2 3, then 6, 12, 24, ...
      const numbers = [1, 2, 3, ...Array.from({ length: round }, (_, n) => 6 * 2 ** n)];
      equal(data.numbers.join(), numbers.join(), `round ${round}: the numbers`);
      equal(data.sum, numbers.reduce((a, b) => a + b), `round ${round}: the sum Python computed`);
      equal(JSON.stringify(data.echo),
        JSON.stringify({ from: 'node', tags: ['größe', '✓'], ok: true, none: null, ratio: 0.5 }), `round ${round}: the echo`);
    }
    equal(labelled(node, 'error').join(), '', 'no error.execution');
  });

  test(`${datamodel}: a send to an actor the other system lacks fails, each way, through host.fail`, async () => {
    const { node, python } = await conversation(datamodel);
    equal(labelled(node, 'failed')[0], 'error.communication node-probe', 'Node\'s probe of py/@nobody');
    equal(labelled(python, 'failed').join(), 'error.communication py-probe', 'Python\'s probe of node/@nobody');
    equal(labelled(node, 'probe').join(), 'python reports error.communication for py-probe', 'Python told the pinger');
  });

  test(`${datamodel}: a value crosses both bindings and comes back the same`, async () => {
    const { echoed } = await conversation(datamodel);
    const sent = encode(VALUE(datamodel));
    const back = encode(echoed);
    equal(Buffer.from(back).toString('hex'), Buffer.from(sent).toString('hex'), 'the value\'s CBOR, there and back');
    equal(typeof echoed.big, 'bigint', 'an integer past 2^53');
    // the native datamodel's values are its context's: a Uint8Array of another realm
    equal(Object.prototype.toString.call(echoed.bytes), '[object Uint8Array]', 'bytes');
  });

  test(`${datamodel}: once the Python process is gone, a send to it gets error.communication`, async () => {
    const { node, exit } = await conversation(datamodel);
    equal(exit.signal, 'SIGKILL', 'the Python process was killed');
    equal(labelled(node, 'failed').at(-1), 'error.communication after-exit', 'the send after the exit');
    equal(labelled(node, 'failed').length, 2, 'nothing else failed');
  });
}

await run();
