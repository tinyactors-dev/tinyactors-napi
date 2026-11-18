# A Python system and a Node system

Two hosts in two processes, each one **system**: `py`, a host of the
Python binding (`tinyactors-cpython`), and `node`, a host of this
package. Their actors address each other with `tinyactors://` addresses,
and each host's **transport** moves the sends for the other system over
one TCP connection.

Run it from `tinyactors-napi` with one command:

```sh
mise run remote-python
```

It builds both bindings from this repository (the Python one with its own
`mise run build`: about a minute the first time, under a second after),
then prints the conversation:

```output
py   ping: ping 0 from tinyactors://node/#_scxml_1
node failed: error.communication node-probe
node pong: {"count":1,"trail":["node","py"],"numbers":[1,2,3],"sum":6,...} from tinyactors://py/#_scxml_1
py   failed: error.communication py-probe
py   ping: ping 1 from tinyactors://node/#_scxml_1
node probe: python reports error.communication for py-probe
...
node done: {"count":3,"trail":["node","py","node","py","node","py"],"numbers":[1,2,3,6,12],"sum":24,...} from tinyactors://py/#_scxml_1
node failed: error.communication after-exit
```

`mise run remote-python --rounds 10` plays longer, and `mise run
remote-python --test` runs the test (`test.mjs`) under node and bun, on
both of the Node host's datamodels; `mise run test` runs it too.

## What happens

- `charts/ping.scxml` (Node, ECMAScript) sends `ping` with nested data to
  `tinyactors://py/@pong`. `charts/pong.scxml` (Python, the `"python"`
  datamodel) answers each one to `_event.origin` with a computed result:
  the count plus one, the trail with `"py"` added, the sum of the numbers.
  The pinger replies to the pong's `_event.origin` with the sum appended,
  for as many rounds as `start` asked.
- Each side probes an actor the other lacks (`py/@nobody`,
  `node/@nobody`). The receiving host's `host.send` refuses the message,
  the receiver reports it back over the wire, and the sender's host calls
  `host.fail`: the probing actor gets `error.communication` with its
  send's id. The Python actor tells the Node actor what it got.
- A value relayed through the Python system comes back the same: integers
  to 2^64 (as `bigint` past 2^53), floats, text, bytes, `null`, nested
  lists and maps (`test.mjs` compares their encodings byte for byte).
- Then the Python process is killed. The connection closes, and the Node
  actor's next ping finds no peer: the transport calls `send.fail()`, and
  the actor gets `error.communication`.

## The wire

A TCP connection on `127.0.0.1`, at a port the Python process picks and
writes as the first line of its standard output (`{"port": N}`; its
`<log>` lines follow, one JSON object each). On it, frames: a 4-byte
big-endian length, then one CBOR item (RFC 8949), the framing of the
suite's driver protocol (`tinyactors-test/docs/driver.md`). Each item is
a JSON-RPC 2.0 notification without its `"jsonrpc"` member, the shape
core's own messages have (`tinyactors-core/docs/requests.md`), written by
each side's `encode` and read by its `decode`:

| `method` | `params` | The receiver |
|---|---|---|
| `message.send` | a transport's `send.message`: `target`, `event`, `data`, `sendid`, `origin`, `traceparent` | `host.send(params)`, unchanged; if it throws, answers `message.fail` |
| `message.fail` | `{sender, sendid}`: the `origin` and `sendid` of a message it could not deliver | `host.fail(sender, sendid)`, when `sender` is an address of its own system |

The addresses cross as CBOR tag 32: both sides' `encode` write an
`Address` so and their `decode` read it back as one, and both hosts'
`host.send` take an `Address` or its text. A field a send lacks is
`null` in both bindings' `send.message`.

A failure is never a key of a message: only `message.fail`, from the
connection the send went out on, reaches `host.fail`, and only for a
sender of the receiving system. The rest of what a real transport needs
(reconnecting, acknowledgements, authentication, routing to more than one
peer) is left out; [the guide](../../docs/guide/other-systems.md) says what
the host does and does not do.

## Files

| File | |
|---|---|
| `python_system.py` | the Python system: a `tinyactors.Host` under `async with`, its transport and the server, standard library only |
| `remote.mjs` | the Node system (`startNode`), the wire's framing, and `startPython`, which starts the other process |
| `run.mjs` | the conversation (`converse`) and the demo that prints it |
| `test.mjs` | the test: the conversation on each datamodel, its cases checked |
| `charts/` | the two charts |

To run it without mise, build both bindings, then point `PYTHON` at a
Python 3.13 and `PYTHONPATH` at `tinyactors-cpython/build/abi3`:

```sh
PYTHON=python3.13 PYTHONPATH=../tinyactors-cpython/build/abi3 node examples/remote-python/run.mjs
```
