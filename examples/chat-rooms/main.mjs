// An evening on the chat service, on the real clock: users of a few
// workspaces open sockets, the owners make rooms, everyone joins some and
// posts, and a direct message or two goes to a user who is not online.
// The host keeps at most `resident` actors in memory and hibernates the
// rest into a FileStore, one file per actor; a post to a hibernated room
// wakes it, and its broadcast reaches the members' sockets without waking
// their connections. At the end every socket is checked against the
// database: each member got every message of each of its rooms, in the
// room's order.
//
//   node examples/chat-rooms/main.mjs [--workspaces W] [--users U] [--rooms R]
//                                     [--posts P] [--resident M] [--seed S] [--out DIR]
//
// U users and R rooms per workspace; the blobs go to DIR (default: a new
// temporary directory).
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Chat, Socket } from './chat.mjs';
import { FileStore } from './store.mjs';

/** A small seeded generator (mulberry32), so a run can be repeated. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs the evening; answers what happened and what is wrong. */
export async function run({ workspaces = 5, users = 200, rooms = 10, posts = 2000, resident = 150, roomsPerUser = 3, seed = 1, out, datamodel } = {}) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const dir = out ?? mkdtempSync(join(tmpdir(), 'chat-rooms-'));
  const store = new FileStore(dir);
  const chat = new Chat({ store, resident, datamodel });
  const wrong = [];
  const started = performance.now();
  let highest = 0;
  const check = async () => {
    await chat.host.idle();
    const { host } = await chat.host.hostStats();
    const now = host.actors - host.hibernated;
    highest = Math.max(highest, now);
    if (now > resident) wrong.push(`${now} actors in memory at rest, more than ${resident}`);
  };

  // the workspaces, each with an owner who makes its rooms
  const people = []; // {user, workspace, socket, connection, rooms}
  for (let w = 0; w < workspaces; w++) {
    const workspace = `team-${w}`;
    const owner = `${workspace}-owner`;
    chat.createWorkspace(workspace, [owner]);
    const socket = new Socket();
    const connection = chat.connect(owner, workspace, socket);
    for (let r = 0; r < rooms; r++) chat.received(connection, JSON.stringify(['create', { name: `room-${r}` }]));
    for (let u = 0; u < users; u++) {
      const user = `${workspace}-user-${u}`;
      people.push({ user, workspace, socket: new Socket(), rooms: new Set() });
    }
    await check();
    if (socket.of('room.created').length !== rooms) wrong.push(`${workspace}: ${socket.of('room.created').length} rooms made, not ${rooms}`);
  }

  // everyone connects and joins some rooms of their workspace
  for (const [n, person] of people.entries()) {
    person.connection = chat.connect(person.user, person.workspace, person.socket);
    while (person.rooms.size < Math.min(roomsPerUser, rooms)) person.rooms.add(`room-${Math.floor(next() * rooms)}`);
    for (const room of person.rooms) chat.received(person.connection, JSON.stringify(['join', { room }]));
    if (n % 100 === 99) await check();
  }
  await check();

  // the posts, and a few things that go wrong on the way
  for (let n = 0; n < posts; n++) {
    const author = pick(people);
    chat.received(author.connection, JSON.stringify(['post', { room: pick([...author.rooms]), text: `${author.user} says ${n}` }]));
    if (n % 500 === 0) {
      chat.received(author.connection, JSON.stringify(['join', { room: 'no-such-room' }]));
      chat.received(author.connection, JSON.stringify(['dm', { to: 'someone-offline', text: `${n}` }]));
    }
    if (n % 100 === 99) await check();
  }
  await check();
  const traffic = performance.now() - started;

  // every member got every message of its rooms, in the room's order
  const sent = new Map(); // `${workspace}.${room}` -> its texts, as the database has them
  for (const { workspace, room, text } of chat.database.messages) {
    const key = `${workspace}.${room}`;
    if (!sent.has(key)) sent.set(key, []);
    sent.get(key).push(text);
  }
  if (chat.database.messages.length !== posts) wrong.push(`${chat.database.messages.length} messages in the database, not ${posts}`);
  for (const person of people) {
    for (const room of person.rooms) {
      const got = person.socket.of('room.message').filter((m) => m.room === room).map((m) => m.text);
      const expected = sent.get(`${person.workspace}.${room}`) ?? [];
      if (got.join('\n') !== expected.join('\n')) wrong.push(`${person.user} in ${room}: ${got.length} messages, ${expected.length} sent`);
    }
  }
  for (let w = 0; w < workspaces; w++) {
    const names = await chat.rooms(`team-${w}`);
    if (names.length !== rooms) wrong.push(`team-${w} lists ${names.length} rooms, not ${rooms}`);
  }
  const misses = people.reduce((sum, person) => sum + person.socket.of('error').length, 0);
  const unread = chat.database.unread.get('someone-offline')?.length ?? 0;
  const { host } = await chat.host.hostStats();
  await chat.host.idle();
  chat.close();
  const files = readdirSync(dir).filter((file) => file.endsWith('.blob')).length;
  return { wrong, traffic, highest, misses, unread, store: store.counts, files, actors: host.actors, hibernated: host.hibernated, dir };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      workspaces: { type: 'string', default: '5' }, users: { type: 'string', default: '200' }, rooms: { type: 'string', default: '10' },
      posts: { type: 'string', default: '2000' }, resident: { type: 'string', default: '150' }, seed: { type: 'string', default: '1' },
      out: { type: 'string' },
    },
  });
  const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === 'out' ? value : Number(value)]));
  const result = await run(options);
  console.log(`${options.workspaces * options.users} users in ${options.workspaces * options.rooms} rooms, ${options.posts} posts in ${Math.round(result.traffic)} ms`);
  console.log(`resident: at most ${options.resident}, highest at rest ${result.highest}; ${result.hibernated} of ${result.actors} actors hibernated at the end`);
  console.log(`store: ${result.store.saved} saves, ${result.store.loaded} loads, ${result.store.deleted} deletes; ${result.files} files in ${result.dir}`);
  console.log(`${result.misses} joins of a missing room answered with an error frame; ${result.unread} direct messages kept for a user offline`);
  console.log(result.wrong.length === 0 ? 'every member got every message of its rooms, in order' : result.wrong.slice(0, 20).join('\n'));
  process.exitCode = result.wrong.length === 0 ? 0 : 1;
}
