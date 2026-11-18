// The Node system "node" and the wire it shares with the Python system "py"
// (python_system.py): what run.mjs and test.mjs start.
//
// The wire (README.md, "The wire"): a TCP connection carrying frames of a
// 4-byte big-endian length and one CBOR item. Each item is a JSON-RPC 2.0
// notification without its "jsonrpc" member, the shape core's own messages
// have (tinyactors-core/docs/requests.md): {method, params}.
//   message.send  params: a send.message, as the transport got it, its two
//                 addresses written as their text
//   message.fail  params: {sender, sendid}: the receiver could not deliver
//                 the message whose origin and sendid these are
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { Address, compileCharts, decode, encode, Host } from '@tinyactors/node';

export const SYSTEM = 'node';
export const PEER = 'py';
const HERE = new URL('.', import.meta.url);
const MAX_FRAME = 16 * 1024 * 1024;

/** One notification, framed: its length, then its CBOR. */
export function frame(method, params) {
  const body = encode({ method, params });
  const bytes = new Uint8Array(4 + body.length);
  new DataView(bytes.buffer).setUint32(0, body.length);
  bytes.set(body, 4);
  return bytes;
}

/** Splits a byte stream into frames' bodies: push each chunk, get the
 * bodies it completes. */
export class Frames {
  #pending = new Uint8Array(0);

  push(chunk) {
    const joined = new Uint8Array(this.#pending.length + chunk.length);
    joined.set(this.#pending);
    joined.set(chunk, this.#pending.length);
    const bodies = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0);
      if (length > MAX_FRAME) throw new Error(`a frame of ${length} bytes`);
      if (joined.length - at - 4 < length) break;
      bodies.push(joined.subarray(at + 4, at + 4 + length));
      at += 4 + length;
    }
    this.#pending = joined.slice(at);
    return bodies;
  }
}


/** Lines a process writes, each a JSON object, with a way to wait for one. */
class Lines {
  records = [];
  #waiters = [];

  add(record) {
    Object.defineProperty(record, 'at', { value: performance.now() }); // when it arrived, for a timeline
    this.records.push(record);
    this.#waiters = this.#waiters.filter(({ test, resolve }) => !(test(record) && (resolve(record), true)));
  }

  /** The first record, already seen or to come, for which `test` holds. */
  next(test, { timeout = 10_000, what = 'a record' } = {}) {
    const seen = this.records.find(test);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; seen: ${JSON.stringify(this.records)}`)), timeout);
      this.#waiters.push({ test, resolve: (record) => { clearTimeout(timer); resolve(record); } });
    });
  }
}

/** Starts the Python system: `python` (default $PYTHON, else python3) runs
 * python_system.py with the environment given (PYTHONPATH naming the
 * tinyactors-cpython build), in the directory `cwd`. Resolves once it listens, with its port, its
 * log lines and the child process. */
export async function startPython({ python = process.env.PYTHON ?? 'python3', env = process.env, cwd } = {}) {
  const child = spawn(python, [new URL('python_system.py', HERE).pathname], {
    env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, cwd, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = new Lines();
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      lines.add(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const started = lines.next((record) => record.port !== undefined, { what: 'the Python system\'s port' });
  const { port } = await Promise.race([started, exited.then(({ code }) => {
    throw new Error(`the Python system exited (${code}) before it listened`);
  })]);
  return { child, port, lines, exited, logs: () => lines.records.filter((record) => record.label !== undefined) };
}

/** Starts the Node system and connects it to the Python system's `port`.
 * `app` is the handler of the chart's I/O processor urn:example:app;
 * `datamodel` the Host's. Resolves once connected, with the host, the
 * ping actor's session, its log lines and the socket. */
export async function startNode({ port, datamodel = 'native', app = () => {} }) {
  const lines = new Lines();
  let socket;
  const host = new Host({ systemID: SYSTEM, ioProcessors: [{ type: 'urn:example:app' }] }, {
    datamodel,
    log: (host, entry) => lines.add({ label: entry.label, text: entry.text }),
    ioProcessors: { 'urn:example:app': app },
    // Every send to another system: the message goes to the peer, or fails.
    transport: (host, send) => {
      if (socket === undefined || !socket.writable || send.target.system !== PEER) {
        send.fail(); // no connection to that system: the sender gets error.communication
        return;
      }
      const message = send.message;
      socket.write(frame('message.send', message), (error) => {
        if (error) host.fail(message.origin, message.sendid); // the write failed later
      });
    },
  });
  const compiled = compileCharts([{ name: 'ping.scxml', text: readFileSync(new URL('charts/ping.scxml', HERE), 'utf8') }]);
  try {
    host.addImage(compiled.image);
  } finally {
    compiled.close();
  }
  const ping = host.spawn(host.chart('ping'), { name: 'ping' });

  const receive = (notification) => {
    const params = notification?.params;
    if (params === null || typeof params !== 'object') return;
    if (notification.method === 'message.send') {
      try {
        host.send(params); // the message as the other side's transport gave it
      } catch {
        // no such actor here, or a message we cannot take: tell the sender
        socket.write(frame('message.fail', { sender: params.origin, sendid: params.sendid }));
      }
    } else if (notification.method === 'message.fail') {
      const sender = params.sender instanceof Address ? params.sender : new Address(String(params.sender));
      if (sender.system === SYSTEM) host.fail(sender, params.sendid ?? undefined); // only a send of ours
    }
  };

  socket = connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true); // small frames, often answered by a frame: no waiting for Nagle's algorithm
  const frames = new Frames();
  socket.on('data', (chunk) => {
    for (const body of frames.push(chunk)) receive(decode(body));
  });
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.on('error', () => {}); // a peer that went away: 'close' follows
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { host, ping, lines, socket, closed, logs: () => lines.records };
}
