'use strict';
// Links v1 on the native router (docs/protocol.md): policy (default deny),
// resumption of ephemeral peers, queue TTL -> error.communication, and
// relaying browser -> server -> another system and back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, createActor, createSystem, createLink, serveLinks, assign, sendTo } = require('./binding');

const until = async (cond, ms = 4000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/* answers PING {from} with PONG {n} to whoever asked */
const echo = createMachine({
  id: 'echo',
  context: { n: 0 },
  on: {
    PING: {
      actions: [assign({ n: ({ context }) => context.n + 1 }), sendTo(({ event }) => event.from, ({ context, event }) => ({ type: 'PONG', n: context.n, tag: event.tag }))],
    },
  },
});

/* sends PING to `to`; counts PONGs and error.communication */
const caller = createMachine({
  id: 'caller',
  context: { pongs: [], errors: 0 },
  on: {
    CALL: { actions: sendTo(({ event }) => event.to, ({ self, event }) => ({ type: 'PING', from: self, tag: event.tag })) },
    PONG: { actions: assign({ pongs: ({ context, event }) => [...context.pongs, event.tag] }) },
    'error.communication': { actions: assign({ errors: ({ context }) => context.errors + 1 }) },
  },
});

/* a server-side actor that remembers a subscriber and notifies it on NOTIFY */
const notifier = createMachine({
  id: 'notifier',
  context: { sub: null, errors: 0 },
  on: {
    SUBSCRIBE: { actions: assign({ sub: ({ event }) => event.from }) },
    NOTIFY: { actions: sendTo(({ context }) => context.sub, ({ event }) => ({ type: 'PONG', tag: event.tag })) },
    'error.communication': { actions: assign({ errors: ({ context }) => context.errors + 1 }) },
  },
});

test('links: untrusted peers reach only what is exported; refusals raise error.communication', async () => {
  const server = createSystem({ id: 'srv1' });
  createActor(echo, { system: server, systemID: 'echo' }).start();
  createActor(echo, { system: server, systemID: 'private' }).start();
  const served = serveLinks(server, { port: 0, exports: { echo: 'PING' } });
  await until(() => served.port);
  const client = createSystem({ id: 'cli1' });
  const link = createLink(client, { url: `ws://127.0.0.1:${served.port}/link`, name: 'srv1', pingMs: 0 });
  const c = createActor(caller, { system: client }).start();
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'ok' });
  c.send({ type: 'CALL', to: link.get('private'), tag: 'no' });
  c.send({ type: 'CALL', to: link.get('nobody'), tag: 'gone' });
  await until(() => c.getSnapshot().context.pongs.length === 1 && c.getSnapshot().context.errors === 2);
  assert.deepEqual(c.getSnapshot().context.pongs, ['ok']);
  assert.equal(served.status('cli1').state, 'open');
  assert.ok(served.status('cli1').errors >= 2, 'refusals are counted on the route');
  link.close();
  client.stop();
  await served.close();
  server.stop();
});

test('links: an ephemeral peer that reconnects with the same id resumes (queued envelopes delivered)', async () => {
  const server = createSystem({ id: 'srv2' });
  const note = createActor(notifier, { system: server, systemID: 'notifier' }).start();
  const served = serveLinks(server, { port: 0, exports: ['notifier'], resumeMs: 5000 });
  await until(() => served.port);
  const sockets = [];
  const client = createSystem({ id: 'tab' });
  const link = createLink(client, {
    name: 'srv2',
    pingMs: 0,
    transport: () => {
      const ws = new WebSocket(`ws://127.0.0.1:${served.port}/link`);
      sockets.push(ws);
      return ws;
    },
  });
  const c = createActor(caller, { system: client }).start();
  link.get('notifier').send({ type: 'SUBSCRIBE', from: c });
  await until(() => note.getSnapshot().context.sub !== null);
  note.send({ type: 'NOTIFY', tag: 'before' });
  await until(() => c.getSnapshot().context.pongs.length === 1);

  // the tab drops; the server queues for it
  sockets.at(-1).close();
  await until(() => served.connections().length === 0);
  note.send({ type: 'NOTIFY', tag: 'while-away-1' });
  note.send({ type: 'NOTIFY', tag: 'while-away-2' });
  await until(() => served.status('tab').queued === 2);
  assert.equal(served.status('tab').state, 'reconnecting');

  // the link reconnects by itself with the same system id: resumed, in order
  await until(() => c.getSnapshot().context.pongs.length === 3, 5000);
  assert.deepEqual(c.getSnapshot().context.pongs, ['before', 'while-away-1', 'while-away-2']);
  assert.equal(served.status('tab').queued, 0);
  assert.equal(sockets.length, 2);
  link.close();
  client.stop();
  await served.close();
  server.stop();
});

test('links: resumption follows the system clock (a simulated clock forgets the peer, no wall time passes)', async () => {
  let now = 0;
  const server = createSystem({ id: 'srv3', clock: () => now });
  const note = createActor(notifier, { system: server, systemID: 'notifier' }).start();
  const served = serveLinks(server, { port: 0, exports: ['notifier'], resumeMs: 100 });
  await until(() => served.port);
  const sockets = [];
  const client = createSystem({ id: 'tab3' });
  const link = createLink(client, {
    name: 'srv3',
    pingMs: 0,
    transport: () => {
      const ws = new WebSocket(`ws://127.0.0.1:${served.port}/link`);
      sockets.push(ws);
      return ws;
    },
  });
  const c = createActor(caller, { system: client }).start();
  link.get('notifier').send({ type: 'SUBSCRIBE', from: c });
  await until(() => note.getSnapshot().context.sub !== null);
  note.send({ type: 'NOTIFY', tag: 'before' });
  await until(() => c.getSnapshot().context.pongs.length === 1);

  // the tab drops; the server queues for it
  sockets.at(-1).close();
  await until(() => served.connections().length === 0);
  note.send({ type: 'NOTIFY', tag: 'while-away' });
  await until(() => served.status('tab3').queued === 1);

  // simulated time inside the resumption window: the peer is kept
  now += 50;
  server.flush();
  assert.equal(served.status('tab3').state, 'reconnecting');
  assert.equal(note.getSnapshot().context.errors, 0);

  // past the window on the system's clock (no wall time has passed): forgotten
  now += 100;
  server.flush();
  assert.equal(served.status('tab3'), null); // forgotten at once, not on a wall timer
  assert.equal(note.getSnapshot().context.errors, 1); // the queued envelope failed

  // a reconnect with the same id starts a fresh peer, nothing was resumed
  await until(() => served.connections().length === 1, 5000);
  assert.equal(served.status('tab3').state, 'open');
  assert.equal(served.status('tab3').received, 0);
  link.get('notifier').send({ type: 'SUBSCRIBE', from: c });
  note.send({ type: 'NOTIFY', tag: 'after' });
  await until(() => c.getSnapshot().context.pongs.length === 2);
  link.close();
  client.stop();
  await served.close();
  server.stop();
});

test('links: envelopes queued past the route TTL expire as error.communication', async () => {
  const client = createSystem({ id: 'lonely' });
  // nobody listens on this port: the link stays down, the router queues
  const link = createLink(client, { url: 'ws://127.0.0.1:9/link', name: 'nowhere', pingMs: 0, queueTTLMs: 80 });
  const c = createActor(caller, { system: client }).start();
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'x' });
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'y' });
  await until(() => link.getSnapshot().context.queued === 2);
  await until(() => c.getSnapshot().context.errors === 2, 3000);
  assert.equal(link.status().queued, 0);
  assert.equal(link.status().errors, 2);
  // fail fast: maxQueue 0 refuses at once
  const fast = createLink(client, { url: 'ws://127.0.0.1:9/link', name: 'nowhere2', pingMs: 0, maxQueue: 0 });
  c.send({ type: 'CALL', to: fast.get('echo'), tag: 'z' });
  await until(() => c.getSnapshot().context.errors === 3);
  link.close();
  fast.close();
  client.stop();
});

test('links: relaying browser -> server -> another system, replies come back the same way', async () => {
  // "backend": an echo service that trusts its server-side peer
  const backend = createSystem({ id: 'backend' });
  createActor(echo, { system: backend, systemID: 'echo' }).start();
  const bserved = serveLinks(backend, { port: 0, trusted: true });
  await until(() => bserved.port);

  // "edge": serves browsers and links to the backend, announcing each to the other
  const edge = createSystem({ id: 'edge' });
  const up = createLink(edge, { url: `ws://127.0.0.1:${bserved.port}/link`, name: 'backend', pingMs: 0, announce: true });
  const eserved = serveLinks(edge, { port: 0, trusted: true, announce: true });
  await until(() => eserved.port && up.getSnapshot().value === 'open');

  // the browser only knows its edge; the edge announces "backend"
  const browser = createSystem({ id: 'browser' });
  const link = createLink(browser, { url: `ws://127.0.0.1:${eserved.port}/link`, name: 'edge', pingMs: 0 });
  await until(() => link.getSnapshot().value === 'open');
  const c = createActor(caller, { system: browser }).start();
  // the backend learns (re-announced hello) that the edge reaches the browser
  await until(() => bserved.connections().length === 1);
  c.send({ type: 'CALL', to: browser.ref('tinyactors://backend/@echo'), tag: 'relayed' });
  await until(() => c.getSnapshot().context.pongs.length === 1);
  assert.deepEqual(c.getSnapshot().context.pongs, ['relayed']);
  assert.equal(c.getSnapshot().context.errors, 0);

  // an unknown name at the far end comes back as error.communication across two hops
  c.send({ type: 'CALL', to: browser.ref('tinyactors://backend/@nobody'), tag: 'lost' });
  await until(() => c.getSnapshot().context.errors === 1);

  link.close();
  up.close();
  browser.stop();
  await eserved.close();
  edge.stop();
  await bserved.close();
  backend.stop();
});

test('system.deliver: host code hands envelopes to the router (local, or out through a link)', async () => {
  const system = createSystem({ id: 'host-code' });
  createActor(echo, { system, systemID: 'echo' }).start();
  const c = createActor(caller, { system }).start();
  assert.equal(system.deliver({ target: 'tinyactors://host-code/@echo', name: 'PING', data: { type: 'PING', from: c, tag: 'h' } }), 'delivered');
  await until(() => c.getSnapshot().context.pongs.length === 1);
  assert.equal(system.deliver({ target: 'tinyactors://host-code/@nobody', name: 'PING' }), 'refused');
  assert.equal(system.deliver({ target: 'tinyactors://elsewhere/@x', name: 'PING' }), 'refused'); // no route
  system.stop();
});

test('system ids: explicit configuration, validated, the prefix of every address, what peers know us by', async () => {
  for (const bad of ['Orders', 'a_b', '-a', 'a..b']) assert.throws(() => createSystem({ id: bad }), TypeError, bad);
  const server = createSystem({ id: 'srv-ids' });
  createActor(echo, { system: server, systemID: 'echo' }).start();
  const served = serveLinks(server, { port: 0, exports: { echo: 'PING' } });
  await until(() => served.port);
  const client = createSystem({ id: 'orders-eu.example' });
  const c = createActor(caller, { system: client }).start();
  assert.match(c.address, /^tinyactors:\/\/orders-eu\.example\/#_scxml_[1-9][0-9]*$/);
  const link = createLink(client, { url: `ws://127.0.0.1:${served.port}/link`, name: 'srv-ids', pingMs: 0 });
  c.send({ type: 'CALL', to: link.get('echo'), tag: 'id' });
  await until(() => c.getSnapshot().context.pongs.length === 1);
  assert.equal(served.status('orders-eu.example').state, 'open');
  assert.equal(link.get('echo').address, 'tinyactors://srv-ids/@echo');
  link.close();
  client.stop();
  await served.close();
  server.stop();
});
