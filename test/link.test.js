'use strict';
// Links over a real WebSocket: a "browser" system reaches a "server" system's
// actors transparently, replies come back through self references, and the
// link's own actor reports connecting / open / reconnecting / closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachine, createActor, createSystem, createLink, serveLinks, assign, sendTo } = require('./binding');

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const lobby = createMachine({
  id: 'lobby',
  initial: 'open',
  context: { players: [] },
  states: {
    open: {
      on: {
        JOIN: {
          actions: [
            assign({ players: ({ context, event }) => [...context.players, event.name] }),
            sendTo(
              ({ event }) => event.player,
              ({ context, event }) => ({ type: 'WELCOME', seat: context.players.length, name: event.name, at: new Date(0) }),
            ),
          ],
        },
      },
    },
  },
});

const player = createMachine({
  id: 'player',
  initial: 'idle',
  context: ({ input }) => ({ lobby: input.lobby, seat: null, welcomed: 0, at: null }),
  on: {
    WELCOME: { actions: assign(({ context, event }) => ({ seat: event.seat, welcomed: context.welcomed + 1, at: event.at })) },
  },
  states: {
    idle: {
      on: {
        GO: {
          actions: sendTo(({ context }) => context.lobby, ({ self, event }) => ({ type: 'JOIN', name: event.name, player: self })),
        },
      },
    },
  },
});

test('links: transparent sends across systems, replies via self, observable status', async () => {
  const server = createSystem({ id: 'server' });
  createActor(lobby, { system: server, systemID: 'lobby' }).start();
  let served = serveLinks(server, { port: 0, exports: ['lobby'] });
  await until(() => served.port);
  const port = served.port;

  const browser = createSystem({ id: 'browser' });
  const link = createLink(browser, { url: `ws://127.0.0.1:${port}/link`, name: 'server', pingMs: 20 });
  const statuses = [];
  link.subscribe((s) => statuses.at(-1) !== s.value && statuses.push(s.value));
  assert.equal(link.getSnapshot().value, 'connecting');

  const p = createActor(player, { system: browser, input: { lobby: link.get('lobby') } }).start();
  p.send({ type: 'GO', name: 'ada' }); // queued until the link opens
  await until(() => p.getSnapshot().context.seat === 1);
  assert.ok(p.getSnapshot().context.at instanceof Date, 'values keep their types across the link');
  assert.deepEqual(statuses.slice(0, 2), ['connecting', 'open']);
  assert.equal(link.getSnapshot().context.peer, 'server');
  await until(() => link.getSnapshot().context.rtt !== null);
  assert.deepEqual(served.connections(), ['browser']);

  // the server goes away: the link reconnects by itself, queued events are flushed
  await served.close();
  await until(() => link.getSnapshot().value === 'reconnecting');
  p.send({ type: 'GO', name: 'grace' });
  await until(() => link.getSnapshot().context.queued === 1);
  served = serveLinks(server, { port, exports: ['lobby'] });
  await until(() => p.getSnapshot().context.seat === 2, 5000);
  assert.equal(link.getSnapshot().value, 'open');
  assert.equal(link.getSnapshot().context.queued, 0);
  assert.deepEqual(statuses, ['connecting', 'open', 'reconnecting', 'connecting', 'open']);

  // host code can address remote actors too
  const welcome = createActor(player, { system: browser, input: { lobby: link.get('lobby') } }).start();
  link.get('lobby').send({ type: 'JOIN', name: 'host', player: welcome });
  await until(() => welcome.getSnapshot().context.seat === 3);

  link.close();
  await until(() => link.getSnapshot().value === 'closed');
  assert.equal(link.getSnapshot().status, 'done');
  await served.close();
});
