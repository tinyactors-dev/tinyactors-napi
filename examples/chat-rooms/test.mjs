// The chat service end to end, on both datamodels: messages reach a room's
// members, a hibernated workspace wakes for a request, each of the three
// ways a send to an actor that is not there is handled, a missed
// heartbeat, a socket that vanished, a restart from the database; then
// main.mjs's evening, small, on the real clock. Sockets are recorders
// (chat.mjs's Socket). Run by `mise run examples` (`node test.mjs`,
// `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryStore, SimulatedClock } from '@tinyactors/node';
import { Chat, Socket } from './chat.mjs';
import { run } from './main.mjs';
import { FileStore } from './store.mjs';

/** A client's frame. */
const frame = (event, data) => JSON.stringify([event, data]);

/** A chat on a simulated clock with a workspace `acme` owned by ada, and a
 * connection with its socket for each of `users`. */
function setup(datamodel, users, options = {}) {
  const clock = new SimulatedClock();
  const chat = new Chat({ clock, datamodel, ...options });
  chat.createWorkspace('acme', ['ada']);
  const people = Object.fromEntries(users.map((user) => {
    const socket = new Socket();
    return [user, { socket, connection: chat.connect(user, 'acme', socket) }];
  }));
  return { chat, clock, people };
}

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: an owner makes a room, members join and hear each other`, async () => {
    const { chat, people: { ada, bob } } = setup(datamodel, ['ada', 'bob']);
    chat.received(ada.connection, frame('create', { name: 'general' }));
    await chat.host.idle();
    assert.deepEqual(ada.socket.frames.at(-1), ['room.created', { room: 'general' }]);

    chat.received(bob.connection, frame('create', { name: 'random' }));
    chat.received(ada.connection, frame('create', { name: 'Bad Name' }));
    for (const { connection } of [ada, bob]) chat.received(connection, frame('join', { room: 'general' }));
    await chat.host.idle();
    assert.deepEqual(bob.socket.of('room.refused'), [{ name: 'random', reason: 'not an owner' }]);
    assert.deepEqual(ada.socket.of('room.refused'), [{ name: 'Bad Name', reason: 'invalid name' }]);

    chat.received(bob.connection, frame('post', { room: 'general', text: 'hi' }));
    await chat.host.idle();
    const expected = ['room.message', { room: 'general', user: 'bob', text: 'hi' }];
    assert.deepEqual(ada.socket.frames.at(-1), expected);
    assert.deepEqual(bob.socket.frames.at(-1), expected);
    assert.deepEqual(chat.database.messages, [{ workspace: 'acme', room: 'general', user: 'bob', text: 'hi' }]);
    assert.deepEqual(await chat.rooms('acme'), ['general']);
    chat.close();
  });

  test(`${datamodel}: the actor hibernates: a hibernated workspace and room wake for a send to their names`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-rooms-test-'));
    try {
      const store = new FileStore(dir);
      const { chat, people: { ada } } = setup(datamodel, ['ada'], { store, resident: 1 });
      await chat.host.idle();
      const workspace = chat.host.actor('workspace.acme');
      assert.ok(readdirSync(dir).includes(`${workspace.id}.blob`), 'the workspace is in the store');

      chat.received(ada.connection, frame('create', { name: 'general' }));
      await chat.host.idle();
      assert.deepEqual(ada.socket.of('room.created'), [{ room: 'general' }]);
      chat.received(ada.connection, frame('join', { room: 'general' }));
      chat.received(ada.connection, frame('post', { room: 'general', text: 'anyone?' }));
      await chat.host.idle();
      assert.deepEqual(ada.socket.of('room.message'), [{ room: 'general', user: 'ada', text: 'anyone?' }]);
      const { host } = await chat.host.hostStats();
      assert.equal(host.actors - host.hibernated, 1, 'one actor in memory at rest');
      assert.ok(store.counts.loaded >= 2, 'the workspace and the room were loaded from their files');
      chat.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${datamodel}: the sender handles error.communication: a join of a room that does not exist`, async () => {
    const { chat, people: { bob } } = setup(datamodel, ['bob']);
    chat.received(bob.connection, frame('join', { room: 'nowhere' }));
    await chat.host.idle();
    assert.deepEqual(bob.socket.frames, [['error', { reason: 'no such room' }]]);
    chat.close();
  });

  test(`${datamodel}: the application routes it: a direct message reaches the user's connections, or waits in the database`, async () => {
    const { chat, people: { ada, bob } } = setup(datamodel, ['ada', 'bob']);
    const second = new Socket();
    chat.connect('ada', 'acme', second); // ada on two devices
    chat.received(bob.connection, frame('dm', { to: 'ada', text: 'lunch?' }));
    chat.received(bob.connection, frame('dm', { to: 'cy', text: 'welcome' }));
    await chat.host.idle();
    assert.deepEqual(ada.socket.of('dm'), [{ from: 'bob', text: 'lunch?' }]);
    assert.deepEqual(second.of('dm'), [{ from: 'bob', text: 'lunch?' }]);
    assert.deepEqual(chat.database.unread.get('cy'), [{ from: 'bob', text: 'welcome' }]);
    chat.close();
  });

  test(`${datamodel}: a missed heartbeat closes the socket and leaves the room`, async () => {
    const { chat, clock, people: { ada } } = setup(datamodel, ['ada']);
    const ended = ada.connection.done; // taken while it lives
    chat.host.spawn('room', { name: 'room.acme.general', params: { workspace: 'acme', name: 'general' } });
    chat.received(ada.connection, frame('join', { room: 'general' }));
    await chat.host.idle();
    clock.increment(30_000);
    chat.received(ada.connection, frame('heartbeat', {}));
    await chat.host.idle();
    clock.increment(59_000);
    await chat.host.idle();
    assert.equal(ada.socket.closedWith, undefined, 'the heartbeat moved the deadline');
    clock.increment(1_000);
    await chat.host.idle();
    assert.deepEqual(ada.socket.closedWith, { code: 1000, reason: 'timeout' });
    assert.equal(await ended, undefined);
    const [event, data] = await chat.host.actor('room.acme.general').ask('kick', { user: 'nobody' });
    assert.equal(event, 'kicked');
    assert.deepEqual(data.members, []);
    chat.close();
  });

  test(`${datamodel}: a member whose socket vanished is dropped from the room`, async () => {
    const { chat, people: { ada, bob } } = setup(datamodel, ['ada', 'bob']);
    chat.host.spawn('room', { name: 'room.acme.general', params: { workspace: 'acme', name: 'general' } });
    for (const { connection } of [ada, bob]) chat.received(connection, frame('join', { room: 'general' }));
    await chat.host.idle();
    chat.gateway.detach(bob.connection.id); // gone without a goodbye
    chat.received(ada.connection, frame('post', { room: 'general', text: 'anyone?' }));
    await chat.host.idle();
    const [, data] = await chat.host.actor('room.acme.general').ask('kick', { user: 'nobody' });
    assert.deepEqual(data.members, ['ada']);
    assert.deepEqual(bob.socket.of('room.message'), []);
    chat.close();
  });

  test(`${datamodel}: after a restart the rooms come back from the database and announce themselves`, async () => {
    const store = new MemoryStore();
    const first = setup(datamodel, ['ada'], { store, resident: 2 });
    first.chat.received(first.people.ada.connection, frame('create', { name: 'general' }));
    first.chat.received(first.people.ada.connection, frame('create', { name: 'random' }));
    await first.chat.host.idle();
    first.chat.received(first.people.ada.connection, frame('join', { room: 'general' }));
    first.chat.received(first.people.ada.connection, frame('post', { room: 'general', text: 'before' }));
    await first.chat.host.idle();
    first.chat.close();

    // a new process: the same database, a new host, nothing in memory
    const chat = new Chat({ database: first.chat.database, clock: new SimulatedClock(), datamodel });
    chat.recover();
    await chat.host.idle();
    assert.deepEqual(await chat.rooms('acme'), ['general', 'random']);
    const socket = new Socket();
    chat.received(chat.connect('ada', 'acme', socket), frame('join', { room: 'general' }));
    await chat.host.idle();
    assert.deepEqual(socket.of('room.joined'), [{ room: 'general', history: [{ room: 'general', user: 'ada', text: 'before' }] }]);
    chat.close();
  });
}

test('the evening: a bounded resident set, every message to every member', async () => {
  const out = mkdtempSync(join(tmpdir(), 'chat-rooms-run-'));
  try {
    const result = await run({ workspaces: 3, users: 40, rooms: 5, posts: 300, resident: 30, out });
    assert.deepEqual(result.wrong, []);
    assert.ok(result.highest <= 30);
    assert.ok(result.store.loaded > 0, 'actors were woken from their files');
    assert.equal(result.misses, 1);
    assert.equal(result.unread, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
