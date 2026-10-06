'use strict';
// Links over byte streams (docs/protocol.md, "Framing"): the frame codec, TCP,
// and a child process's stdio.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMachine, createActor, createSystem, createLink, serveLinks, assign, sendTo, encodeFrame, FrameDecoder } = require('./binding');

const until = async (cond, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const concat = (parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
/* feed `bytes` to a decoder in pieces cut at `cuts`; all frames out */
const feed = (decoder, bytes, cuts) => {
  const out = [];
  let at = 0;
  for (const c of [...cuts, bytes.length]) {
    out.push(...decoder.push(bytes.subarray(at, c)));
    at = c;
  }
  return out;
};

test('frames: a 4-byte big-endian length, then the UTF-8 text', () => {
  assert.deepEqual([...encodeFrame('{"a":"é"}')], [0, 0, 0, 10, ...Buffer.from('{"a":"é"}')]);
  assert.deepEqual([...encodeFrame('')], [0, 0, 0, 0]);
  const big = 'x'.repeat(70000);
  assert.deepEqual([...encodeFrame(big).subarray(0, 4)], [0, 1, 0x11, 0x70]);
});

test('frames: partial reads and several frames in one chunk decode to the same frames', () => {
  const texts = ['{"t":"hello","v":1}', '', '{"t":"ev","name":"ünïcödé ✓ 😀"}', 'x'.repeat(5000)];
  const bytes = concat(texts.map(encodeFrame));
  // all frames in one chunk
  assert.deepEqual(new FrameDecoder().push(bytes), texts);
  // one byte at a time: the length prefix and multibyte characters split everywhere
  assert.deepEqual(feed(new FrameDecoder(), bytes, [...Array(bytes.length).keys()].slice(1)), texts);
  // split inside a prefix, inside a body, and with a frame and a half per chunk
  assert.deepEqual(feed(new FrameDecoder(), bytes, [2, 3, 30, 31, 47, 60, 4000]), texts);
  // nothing complete yet: nothing out, the rest completes it
  const d = new FrameDecoder();
  assert.deepEqual(d.push(bytes.subarray(0, 10)), []);
  assert.deepEqual(d.push(bytes.subarray(10)), texts);
});

test('frames: a frame above max_frame is refused as malformed and skipped, the stream stays in step', () => {
  const bytes = concat([encodeFrame('ok'), encodeFrame('y'.repeat(100)), encodeFrame('after'), encodeFrame('z'.repeat(9))]);
  const want = (out) => {
    assert.equal(out.length, 4);
    assert.equal(out[0], 'ok');
    assert.deepEqual({ reason: out[1].reason, length: out[1].length }, { reason: 'malformed', length: 100 });
    assert.match(out[1].detail, /max_frame/);
    assert.equal(out[2], 'after');
    assert.equal(out[3].reason, 'malformed'); // 9 bytes > 8
  };
  want(new FrameDecoder({ maxFrame: 8 }).push(bytes));
  want(feed(new FrameDecoder({ maxFrame: 8 }), bytes, [3, 7, 9, 50, 108, 110]));
  // the default limit is 1 MiB: refused from the prefix alone, nothing buffered
  const d = new FrameDecoder();
  assert.equal(d.maxFrame, 1 << 20);
  const [r] = d.push(Uint8Array.of(0, 0x10, 0, 1));
  assert.deepEqual({ reason: r.reason, length: r.length }, { reason: 'malformed', length: (1 << 20) + 1 });
  // a frame that is not UTF-8 is malformed too
  const [bad, good] = new FrameDecoder().push(concat([Uint8Array.of(0, 0, 0, 2, 0xc3, 0x28), encodeFrame('{}')]));
  assert.equal(bad.reason, 'malformed');
  assert.equal(good, '{}');
});

/* answers PING {from, tag} with PONG {tag} */
const echo = createMachine({
  id: 'echo',
  on: { PING: { actions: sendTo(({ event }) => event.from, ({ event }) => ({ type: 'PONG', tag: event.tag })) } },
});
/* CALL {to, tag, pad?} sends PING; counts PONGs and error.communication */
const caller = createMachine({
  id: 'caller',
  context: { pongs: [], errors: [] },
  on: {
    CALL: { actions: sendTo(({ event }) => event.to, ({ self, event }) => ({ type: 'PING', from: self, tag: event.tag, pad: event.pad })) },
    PONG: { actions: assign({ pongs: ({ context, event }) => [...context.pongs, event.tag] }) },
    'error.communication': { actions: assign({ errors: ({ context, event }) => [...context.errors, event.sendid || 'error'] }) },
  },
});

test('links over TCP: length-prefixed frames both ways; envelopes above the peer max_frame fail as malformed', async () => {
  const server = createSystem({ id: 'srv-tcp' });
  createActor(echo, { system: server, systemID: 'echo' }).start();
  const served = serveLinks(server, { tcp: { port: 0, host: '127.0.0.1' }, exports: { echo: 'PING' }, maxFrame: 512 });
  await until(() => served.port);
  const client = createSystem({ id: 'cli-tcp' });
  const link = createLink(client, { tcp: { port: served.port }, name: 'srv-tcp', pingMs: 20 });
  const c = createActor(caller, { system: client }).start();
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'a' });
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'b' });
  await until(() => c.getSnapshot().context.pongs.length === 2);
  assert.deepEqual(c.getSnapshot().context.pongs, ['a', 'b']);
  assert.equal(served.status('cli-tcp').state, 'open');
  await until(() => link.getSnapshot().context.rtt !== null); // ping/pong over frames

  // the server announced max_frame 512: a bigger envelope never leaves, its sender learns why
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'big', pad: 'p'.repeat(600) });
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'c' });
  await until(() => c.getSnapshot().context.errors.length === 1 && c.getSnapshot().context.pongs.length === 3);
  assert.deepEqual(c.getSnapshot().context.pongs, ['a', 'b', 'c']);
  assert.equal(served.status('cli-tcp').received, 3, 'the big one never reached the server');

  // a raw peer: an oversize frame is skipped unread, the hello after it answered
  const raw = net.connect({ port: served.port, host: '127.0.0.1' });
  const got = [];
  const d = new FrameDecoder();
  raw.on('data', (b) => got.push(...d.push(b)));
  const junk = new Uint8Array(4 + 2000);
  new DataView(junk.buffer).setUint32(0, 2000);
  raw.write(junk.subarray(0, 1000));
  raw.write(concat([junk.subarray(1000), encodeFrame(JSON.stringify({ t: 'hello', v: 1, id: 'raw', reach: [] }))]));
  await until(() => got.length === 1);
  assert.deepEqual(JSON.parse(got[0]), { t: 'hello', v: 1, id: 'srv-tcp', reach: [], caps: { profile: 'js', ordered: true, acks: false, max_frame: 512 } });
  raw.destroy();

  link.close();
  client.stop();
  await served.close();
  server.stop();
});

test('links over TCP: a dropped connection reconnects and resumes the same peer', async () => {
  const server = createSystem({ id: 'srv-tcp2' });
  const echoes = createActor(echo, { system: server, systemID: 'echo' }).start();
  const served = serveLinks(server, { tcp: { port: 0, host: '127.0.0.1' }, exports: ['echo'], resumeMs: 5000 });
  await until(() => served.port);
  const sockets = [];
  const client = createSystem({ id: 'cli-tcp2' });
  const link = createLink(client, {
    name: 'srv-tcp2',
    pingMs: 0,
    transport: () => {
      const s = net.connect({ port: served.port, host: '127.0.0.1' });
      sockets.push(s);
      return s;
    },
  });
  const c = createActor(caller, { system: client }).start();
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'before' });
  await until(() => c.getSnapshot().context.pongs.length === 1);
  sockets.at(-1).destroy();
  await until(() => link.getSnapshot().value === 'reconnecting');
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'while-away' }); // queued by the client's router
  await until(() => c.getSnapshot().context.pongs.length === 2, 5000);
  assert.deepEqual(c.getSnapshot().context.pongs, ['before', 'while-away']);
  assert.equal(sockets.length, 2);
  assert.equal(served.status('cli-tcp2').state, 'open');
  void echoes;
  link.close();
  client.stop();
  await served.close();
  server.stop();
});

test("links over a child process's stdio: two systems, envelopes both ways", async () => {
  const parent = createSystem({ id: 'parent' });
  createActor(echo, { system: parent, systemID: 'echo' }).start();
  const inbox = createActor(
    createMachine({ id: 'inbox', context: { got: [] }, on: { GOT: { actions: assign({ got: ({ context, event }) => [...context.got, event.tag] }) } } }),
    { system: parent, systemID: 'inbox' },
  ).start();
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/stdio-peer.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const served = serveLinks(parent, { trusted: true, accept: (on) => on({ readable: child.stdout, writable: child.stdin }) });

  // the child calls the parent's echo and reports the reply to the parent's inbox
  await until(() => inbox.getSnapshot().context.got.length === 1, 15000);
  assert.deepEqual(inbox.getSnapshot().context.got, ['from-kid']);
  assert.deepEqual(served.connections(), ['kid']);
  // the parent calls the child's echo
  const c = createActor(caller, { system: parent }).start();
  c.send({ type: 'CALL', to: parent.ref('tinyactors://kid/@echo'), tag: 'from-parent' });
  await until(() => c.getSnapshot().context.pongs.length === 1);
  assert.deepEqual(c.getSnapshot().context.pongs, ['from-parent']);
  assert.equal(served.status('kid').state, 'open');

  // closing the link ends the child's stdin: it exits
  await served.close();
  assert.equal(await exited, 0);
  parent.stop();
});
