// Runs the conversation between the two systems and prints it:
//
//   mise run remote-python            (in tinyactors-napi: builds both bindings first)
//
// or, with both bindings built, PYTHON naming a Python 3.13 and PYTHONPATH
// tinyactors-cpython/build/abi3:  node examples/remote-python/run.mjs [rounds]
//
// It starts the Python system, connects the Node system to it, plays
// `rounds` rounds of ping-pong (default 3), echoes a value through the
// Python system and back, then stops the Python process and has the Node
// chart send once more, which fails with error.communication.
import { startNode, startPython } from './remote.mjs';

/** The whole conversation; `value` is relayed through the Python system and
 * back to the Node system's I/O processor. Resolves with what each side
 * logged and the value as it came back. */
export async function converse({ rounds = 3, value = { hello: 'world' }, datamodel = 'native', env = process.env, cwd } = {}) {
  const python = await startPython({ env, cwd });
  let node;
  try {
    let echoed;
    const echoedValue = new Promise((resolve) => { echoed = resolve; });
    node = await startNode({ port: python.port, datamodel, app: (host, send) => echoed(send.data) });
    const { host, ping, lines } = node;

    host.send(ping, 'start', { rounds });
    await lines.next((r) => r.label === 'done', { what: 'the last pong' });
    await lines.next((r) => r.label === 'failed' && r.text.endsWith('node-probe'), { what: 'the Node probe\'s failure' });
    await lines.next((r) => r.label === 'probe', { what: 'the Python probe\'s report' });

    host.send(ping, 'relay', value);
    const back = await echoedValue;

    python.child.kill('SIGKILL'); // the peer goes down
    const exit = await python.exited;
    await node.closed;
    host.send(ping, 'again');
    await lines.next((r) => r.label === 'failed' && r.text.endsWith('after-exit'), { what: 'the send after the exit to fail' });
    await host.idle();
    return { node: node.logs(), python: python.logs(), echoed: back, exit, ping };
  } finally {
    node?.host.close();
    node?.socket.destroy();
    python.child.kill('SIGKILL');
  }
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const rounds = Number(process.argv[2] ?? 3);
  const { node, python, echoed, exit } = await converse({ rounds, value: { nested: { list: [1, 'two', { three: 3.5 }] }, ok: true, none: null } });
  const timeline = [...python.map((r) => ({ ...r, at: r.at, who: 'py  ' })), ...node.map((r) => ({ ...r, at: r.at, who: 'node' }))];
  for (const { who, label, text } of timeline.sort((a, b) => a.at - b.at)) console.log(`${who} ${label}: ${text}`);
  console.log(`node echoed through py: ${JSON.stringify(echoed)}`);
  console.log(`py   killed (${exit.signal ?? exit.code}); the ping after it failed as above`);
}
