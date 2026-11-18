// The chat service's tricky cases, each on a SimulatedClock with a store in
// a temporary directory whose reads and writes the test can hold or fail,
// on both datamodels; then a load of hundreds of actors with the resident
// set checked through hostStats, and the demo of main.mjs on the real
// clock. Run by `mise run examples` (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimulatedClock, TinyactorsError } from '@tinyactors/node';
import { Chat, Connection } from './chat.mjs';
import { random, run } from './main.mjs';

/** A promise the test settles. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // a rejection before the store awaits it is not unhandled
  return { promise, resolve, reject };
}

/** A chat service on a simulated clock, its store in a new temporary
 * directory; `hooks` holds the store's hooks, which a test may set later. */
function setup(datamodel, { maxResident = 100, room, user } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chat-rooms-test-'));
  const clock = new SimulatedClock();
  const hooks = { beforeWrite: undefined, beforeRead: undefined };
  const chat = new Chat({
    dir, clock, datamodel, maxResident, room, user,
    storeHooks: { beforeWrite: (key) => hooks.beforeWrite?.(key), beforeRead: (key) => hooks.beforeRead?.(key) },
  });
  const close = () => {
    chat.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, clock, chat, hooks, close };
}

/** Sends every actor to the store, and waits for the writes. */
async function hibernateAll(chat) {
  await chat.settle();
  const keep = chat.maxResident;
  chat.maxResident = 0;
  chat.evict();
  chat.maxResident = keep;
  await chat.settle();
}

/** Lets the host run and the store's unheld reads and writes finish until
 * `condition()` holds, without waiting for what a test holds (settle()
 * would); then a few more turns, for what the condition's change sets off. */
async function until(chat, condition, what) {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await chat.host.idle();
  }
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await chat.host.idle();
  }
}

const texts = (history) => history.filter((entry) => entry.kind === 'message').map((entry) => `${entry.user}: ${entry.text}`);

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: membership and history survive hibernation`, async () => {
    const { dir, chat, close } = setup(datamodel);
    try {
      const lobby = chat.createRoom('lobby');
      chat.createRoom('den', { capacity: 1 });
      for (const name of ['ada', 'bob', 'cy']) chat.register(name);
      const ada = new Connection();
      chat.connect('ada', ada);
      chat.join('ada', 'lobby');
      chat.join('bob', 'lobby');
      chat.join('cy', 'den');
      await chat.settle();
      const bob = new Connection();
      chat.connect('bob', bob);
      chat.join('bob', 'den'); // the den is full
      await chat.settle();
      chat.disconnect('bob');
      await chat.settle();
      chat.say('ada', 'lobby', 'hello');
      chat.say('bob', 'lobby', 'hi ada');
      await chat.settle();
      const before = await chat.history('lobby');

      await hibernateAll(chat);
      const counters = await chat.counters();
      assert.deepEqual(counters, { actors: 5, hibernated: 5, resident: 0 });
      assert.equal(readdirSync(dir).filter((file) => file.endsWith('.blob')).length, 5, 'one file per actor');

      // the room answers from its blob: members, numbering and history as they were
      const after = await chat.history('lobby');
      assert.deepEqual(after, before);
      assert.deepEqual([...after.members].sort(), ['ada', 'bob']);
      assert.deepEqual(texts(after.history).sort(), ['ada: hello', 'bob: hi ada']);
      assert.equal(chat.wakes.get(lobby), 1);

      // the users' rooms came back too: bob is in the lobby, cy is not
      await hibernateAll(chat);
      chat.say('bob', 'lobby', 'still here');
      chat.say('cy', 'lobby', 'let me in');
      await chat.settle();
      assert.deepEqual(ada.of('message').map((m) => `${m.seq} ${m.user}: ${m.text}`),
        ['3 ada: hello', '4 bob: hi ada', '5 bob: still here']);
      assert.deepEqual(texts((await chat.history('lobby')).history), ['ada: hello', 'bob: hi ada', 'bob: still here']);
      const cy = new Connection();
      chat.connect('cy', cy);
      await chat.settle();
      assert.deepEqual((await chat.history('den')).members, ['cy']);

      // leaving after a wake: the room and the user both forget it
      await hibernateAll(chat);
      chat.connect('bob', bob);
      chat.leave('bob', 'lobby');
      await chat.settle();
      chat.say('bob', 'lobby', 'bye?');
      await chat.settle();
      assert.deepEqual(bob.of('error').map((frame) => frame.reason), ['the room is full', 'join lobby first']);
      assert.deepEqual((await chat.history('lobby')).members, ['ada']);
    } finally {
      close();
    }
  });

  test(`${datamodel}: a message for a room whose wake is in flight waits for it, in order`, async () => {
    const { chat, hooks, close } = setup(datamodel);
    try {
      const lobby = chat.createRoom('lobby');
      const [ada, bob] = ['ada', 'bob', 'cy'].map((name) => chat.register(name));
      for (const name of ['ada', 'bob', 'cy']) chat.join(name, 'lobby');
      const cy = new Connection();
      chat.connect('cy', cy);
      await hibernateAll(chat);

      // the room's file read is slow
      const read = deferred();
      hooks.beforeRead = (key) => (key === String(lobby) ? read.promise : undefined);
      chat.say('ada', 'lobby', 'one');
      await until(chat, () => chat.wakes.get(lobby) === 1, 'ada woke and posted');
      assert.equal(chat.wakes.get(lobby), 1, 'ada woke and posted: the host asked for the room');
      chat.say('bob', 'lobby', 'two');
      chat.say('ada', 'lobby', 'three');
      await until(chat, () => chat.resident.has(bob) && chat.resident.has(ada), 'bob woke');

      // the posts wait in the room's queue: no second wake, nothing ran
      assert.equal(chat.wakes.get(lobby), 1, 'one wake per hibernation');
      assert.deepEqual(cy.of('message'), []);
      assert.ok(!chat.resident.has(lobby));
      assert.deepEqual(chat.host.sweep(1 << 20, 100).filter((s) => s === lobby), [], 'the sweep does not offer it');
      assert.throws(() => chat.host.hibernate(lobby), (error) => error instanceof TinyactorsError && error.status === 'TA_ERROR_STATE');
      assert.equal((await chat.counters()).hibernated >= 1, true);

      read.resolve();
      await chat.settle();
      assert.equal(chat.wakes.get(lobby), 1);
      const got = cy.of('message');
      assert.deepEqual(got.map((m) => m.seq), [4, 5, 6], 'numbered as they arrived, without a gap');
      assert.deepEqual(got.map((m) => m.text).sort(), ['one', 'three', 'two']);
      assert.ok(got.findIndex((m) => m.text === 'one') < got.findIndex((m) => m.text === 'three'), "ada's posts keep their order");
      assert.deepEqual(texts((await chat.history('lobby')).history), got.map((m) => `${m.user}: ${m.text}`));
    } finally {
      close();
    }
  });

  test(`${datamodel}: a wake while the blob is still on its way to the disk takes it from memory`, async () => {
    const { chat, hooks, close } = setup(datamodel);
    try {
      const lobby = chat.createRoom('lobby');
      chat.register('ada');
      chat.join('ada', 'lobby');
      await chat.settle();

      const write = deferred();
      hooks.beforeWrite = (key) => (key === String(lobby) ? write.promise : undefined);
      chat.maxResident = 0;
      assert.equal(chat.evict(), 2);
      chat.maxResident = 100;
      chat.say('ada', 'lobby', 'quick');
      await until(chat, () => chat.resident.has(lobby), 'the room woke');
      assert.equal(chat.wakes.get(lobby), 1);
      assert.ok(chat.resident.has(lobby), 'woken from the blob in memory');
      assert.ok(!chat.store.read.includes(String(lobby)), 'no file was read: none is written yet');
      assert.deepEqual(texts((await chat.history('lobby')).history), ['ada: quick']);

      // the late write lands (its blob is stale now: the room is resident),
      // and the next hibernation writes and reads the room's current state
      write.resolve();
      await hibernateAll(chat);
      assert.deepEqual(chat.store.written.filter((key) => key === String(lobby)).length, 2);
      chat.say('ada', 'lobby', 'later');
      await chat.settle();
      assert.ok(chat.store.read.includes(String(lobby)));
      assert.deepEqual(texts((await chat.history('lobby')).history), ['ada: quick', 'ada: later']);
    } finally {
      close();
    }
  });

  test(`${datamodel}: a store write that fails puts the actor back in memory, nothing lost`, async () => {
    const { dir, chat, hooks, close } = setup(datamodel);
    try {
      const lobby = chat.createRoom('lobby');
      chat.register('ada');
      chat.join('ada', 'lobby');
      await chat.settle(); // ada may post once the room said joined
      chat.say('ada', 'lobby', 'before');
      await chat.settle();

      let failures = 1;
      hooks.beforeWrite = (key) => {
        if (key === String(lobby) && failures-- > 0) throw new Error('ENOSPC: no space left on device');
      };
      await hibernateAll(chat);
      assert.equal(chat.counts.writeFailures, 1);
      assert.equal(chat.counts.wokenFromMemory, 1);
      assert.deepEqual(await chat.counters(), { actors: 2, hibernated: 1, resident: 1 }, 'the room stayed; ada went');
      assert.ok(chat.resident.has(lobby));
      assert.ok(!existsSync(join(dir, `${lobby}.blob`)));
      assert.equal(chat.wakes.get(lobby), undefined, 'the host never asked: the room was put back');
      chat.say('ada', 'lobby', 'during');
      await chat.settle();

      // the next eviction writes it, and its blob has everything
      await hibernateAll(chat);
      assert.ok(existsSync(join(dir, `${lobby}.blob`)));
      assert.deepEqual((await chat.counters()).resident, 0);
      assert.deepEqual(texts((await chat.history('lobby')).history), ['ada: before', 'ada: during']);
    } finally {
      close();
    }
  });

  test(`${datamodel}: a write that fails after a wake took its blob changes nothing`, async () => {
    const { chat, hooks, close } = setup(datamodel);
    try {
      const lobby = chat.createRoom('lobby');
      chat.register('ada');
      chat.join('ada', 'lobby');
      await chat.settle();

      const write = deferred();
      hooks.beforeWrite = (key) => (key === String(lobby) ? write.promise : undefined);
      chat.maxResident = 0;
      chat.evict();
      chat.maxResident = 100;
      chat.say('ada', 'lobby', 'in time');
      await until(chat, () => chat.resident.has(lobby), 'the room woke');
      assert.ok(chat.resident.has(lobby));
      write.reject(new Error('EIO: i/o error'));
      await chat.settle();
      assert.equal(chat.counts.writeFailures, 0, 'the actor was awake already');
      assert.equal(chat.counts.wokenFromMemory, 0);
      assert.deepEqual(texts((await chat.history('lobby')).history), ['ada: in time']);
    } finally {
      close();
    }
  });

  test(`${datamodel}: a due digest wakes a hibernated user, and the inbox comes back on connect`, async () => {
    const { clock, chat, close } = setup(datamodel, { user: { digestDelayMs: 60_000 } });
    try {
      chat.createRoom('lobby');
      const bob = chat.register('bob');
      chat.register('ada');
      chat.join('ada', 'lobby');
      chat.join('bob', 'lobby');
      await chat.settle();
      chat.say('ada', 'lobby', 'are you there?');
      await hibernateAll(chat);
      assert.equal((await chat.counters()).resident, 0);
      assert.equal(chat.host.nextDeadline, 60_000, 'the digest is pending in the host');

      clock.increment(60_000);
      await chat.settle();
      assert.equal(chat.wakes.get(bob), 1, 'the timer woke bob');
      const mail = chat.mail.filter((m) => m.user === 'bob').map(({ user, unread, rooms }) => ({ user, unread, rooms }));
      assert.deepEqual(mail, [{ user: 'bob', unread: 1, rooms: ['lobby'] }]);

      await hibernateAll(chat);
      const connection = new Connection();
      chat.connect('bob', connection);
      await chat.settle();
      const [backlog] = connection.of('backlog');
      assert.equal(backlog.unread, 1);
      assert.deepEqual(backlog.messages.map((m) => m.text), ['are you there?']);
      assert.equal(chat.host.nextDeadline, undefined);
    } finally {
      close();
    }
  });
}

test('hundreds of actors: the resident set stays bounded, every message arrives', async () => {
  const MAX = 30;
  const { chat, close } = setup('native', { maxResident: MAX });
  try {
    const next = random(3);
    const rooms = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const users = Array.from({ length: 200 }, (_, i) => `u${i}`);
    for (const room of rooms) chat.createRoom(room);
    const membership = new Map();
    for (const [i, user] of users.entries()) {
      chat.register(user);
      membership.set(user, [rooms[i % 20], rooms[(i * 7 + 3) % 20]].filter((r, k, all) => all.indexOf(r) === k));
      for (const room of membership.get(user)) chat.join(user, room);
      if (i % 50 === 49) {
        await chat.settle();
        chat.evict();
      }
    }
    const connections = new Map(users.map((user) => [user, new Connection()]));
    for (const user of users.slice(0, 50)) chat.connect(user, connections.get(user));
    const posted = new Map(rooms.map((room) => [room, 0]));
    let highest = 0;
    for (let batch = 0; batch < 10; batch++) {
      for (let k = 0; k < 20; k++) {
        const user = users[Math.floor(next() * users.length)];
        const room = membership.get(user)[Math.floor(next() * membership.get(user).length)];
        chat.say(user, room, `${user} ${batch}.${k}`);
        posted.set(room, posted.get(room) + 1);
      }
      await chat.settle();
      highest = Math.max(highest, (await chat.counters()).resident);
      chat.evict();
      const { resident, hibernated, actors } = await chat.counters();
      assert.ok(resident <= MAX, `${resident} resident after an eviction, more than ${MAX}`);
      assert.equal(hibernated, actors - resident);
    }
    assert.ok(highest > MAX, 'the traffic woke more than the bound between evictions');
    assert.ok(chat.counts.woken > 200, `${chat.counts.woken} wakes`);

    for (const room of rooms) {
      const got = await chat.history(room);
      const members = users.filter((user) => membership.get(user).includes(room));
      assert.deepEqual([...got.members].sort(), members.sort());
      assert.equal(got.seq, members.length + posted.get(room));
      chat.evict();
    }
    for (const user of users.slice(50)) chat.connect(user, connections.get(user));
    await chat.settle();
    for (const user of users) {
      const connection = connections.get(user);
      const received = connection.of('message').length + connection.of('backlog').reduce((sum, frame) => sum + frame.unread, 0);
      assert.equal(received, membership.get(user).reduce((sum, room) => sum + posted.get(room), 0), user);
    }
  } finally {
    close();
  }
});

test('the demo: users come and go, rooms post, the sweep keeps the resident set bounded', async () => {
  const out = mkdtempSync(join(tmpdir(), 'chat-rooms-demo-'));
  try {
    const result = await run({ users: 300, rooms: 30, posts: 200, resident: 60, out });
    assert.deepEqual(result.wrong, []);
    assert.ok(result.peakAfterEviction <= 60);
    assert.ok(result.counts.woken > 100, `${result.counts.woken} wakes`);
    assert.ok(result.mail > 0, 'digests were sent');
    assert.equal(result.store.files, 330);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
