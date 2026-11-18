// An evening on the chat service, on the real clock: thousands of users in
// hundreds of rooms, most of them hibernated in a file store at any moment.
// Users connect and drop off, members of a room post to it, and a sweep
// every few milliseconds sends the cold actors to the store; each message
// for a hibernated room or member wakes it. At the end every room's
// history and every user's messages are checked against what was sent, and
// the resident set against its bound.
//
//   node examples/chat-rooms/main.mjs [--users N] [--rooms R] [--posts P]
//                                     [--resident M] [--seed S] [--out DIR]
//
// The blobs go to DIR (default: a new temporary directory), one file per
// hibernated actor.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Chat, Connection } from './chat.mjs';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the evening and answers what happened and what is wrong. */
export async function run({ users = 3000, rooms = 300, posts = 1000, resident = 500, roomsPerUser = 2, seed = 1, out, datamodel } = {}) {
  const next = random(seed);
  const pick = (n) => Math.floor(next() * n);
  const dir = out ?? mkdtempSync(join(tmpdir(), 'chat-rooms-'));
  const chat = new Chat({ dir, maxResident: resident, actors: users + rooms, datamodel, user: { digestDelayMs: 200 } });
  const wrong = [];
  let peak = 0;
  let peakAfterEviction = 0;

  // The server's policy: an eviction every 20 ms, whatever is running. An actor
  // in a step or with events waiting is skipped, so while traffic flows the
  // resident set can be above its bound for a moment; at rest, after an
  // eviction, it is at most `resident` (checked after every batch below).
  const sweeper = setInterval(() => {
    chat.evict();
    chat.counters().then(({ resident: now }) => { peak = Math.max(peak, now); }, () => {});
  }, 20);
  const evictAndCheck = async () => {
    await chat.settle();
    chat.evict();
    const { resident: now } = await chat.counters();
    peakAfterEviction = Math.max(peakAfterEviction, now);
    if (now > resident) wrong.push(`${now} actors resident after an eviction at rest, more than ${resident}`);
  };

  const started = performance.now();
  const roomNames = Array.from({ length: rooms }, (_, i) => `r${i}`);
  const userNames = Array.from({ length: users }, (_, i) => `u${i}`);
  for (const name of roomNames) chat.createRoom(name);
  const membership = new Map(userNames.map((name) => [name, new Set()]));
  for (const [n, name] of userNames.entries()) {
    chat.register(name);
    while (membership.get(name).size < Math.min(roomsPerUser, rooms)) membership.get(name).add(roomNames[pick(rooms)]);
    for (const room of membership.get(name)) chat.join(name, room);
    if (n % 200 === 199) await evictAndCheck();
  }
  const members = new Map(roomNames.map((room) => [room, userNames.filter((name) => membership.get(name).has(room))]));
  await chat.settle();

  // a third of the users are online from the start; others come and go
  const connections = new Map(userNames.map((name) => [name, new Connection()]));
  const online = new Set(userNames.filter(() => next() < 1 / 3));
  for (const name of online) chat.connect(name, connections.get(name));

  const sent = new Map(roomNames.map((room) => [room, []]));
  const active = roomNames.filter((room) => members.get(room).length > 0);
  for (let n = 0; n < posts; n++) {
    const room = active[pick(active.length)];
    const author = members.get(room)[pick(members.get(room).length)];
    const text = `${author} says ${n}`;
    sent.get(room).push(text);
    chat.say(author, room, text);
    if (next() < 0.02) {
      const name = userNames[pick(users)];
      if (online.has(name)) chat.disconnect(name);
      else chat.connect(name, connections.get(name));
      if (!online.delete(name)) online.add(name);
    }
    if (n % 100 === 99) await evictAndCheck();
    else if (n % 20 === 19) await sleep(1); // let the turns, the reads and the sweeps run
  }
  await evictAndCheck();
  const traffic = performance.now() - started;
  await sleep(250); // the digests of the users who are away fall due
  await chat.settle();
  clearInterval(sweeper);
  await chat.settle();

  // check every room and every user against what was sent
  // A room orders its messages as they arrive: two authors' posts may
  // cross, each author's stay in order. So a history holds the room's last
  // entries, numbered without a gap up to its seq, each message one that
  // was sent to the room, each author's in the order they were sent.
  for (const room of roomNames) {
    const got = await chat.history(room);
    const messages = got.history.filter((entry) => entry.kind === 'message');
    if (got.seq !== members.get(room).length + sent.get(room).length) wrong.push(`${room}: seq ${got.seq}`);
    if (got.history.some((entry, i) => entry.seq !== got.seq - got.history.length + 1 + i)) wrong.push(`${room}: a gap in the history`);
    const order = new Map(sent.get(room).map((text, i) => [text, i]));
    const last = new Map();
    for (const { user, text } of messages) {
      if (!order.has(text)) wrong.push(`${room}: '${text}' was never sent there`);
      if ((last.get(user) ?? -1) > order.get(text)) wrong.push(`${room}: ${user}'s messages out of order`);
      last.set(user, order.get(text));
    }
    if ([...got.members].sort().join() !== [...members.get(room)].sort().join()) wrong.push(`${room}: members differ`);
  }
  for (const name of userNames) if (!online.has(name)) chat.connect(name, connections.get(name));
  await chat.settle();
  for (const name of userNames) {
    const connection = connections.get(name);
    const received = connection.of('message').length + connection.of('backlog').reduce((sum, frame) => sum + frame.unread, 0);
    const expected = [...membership.get(name)].reduce((sum, room) => sum + sent.get(room).length, 0);
    if (received !== expected) wrong.push(`${name}: received ${received} messages, sent to their rooms ${expected}`);
  }
  await chat.store.flush();
  const files = readdirSync(dir).filter((file) => file.endsWith('.blob')).length;
  const counters = await chat.counters();
  chat.close();
  return { wrong, counts: chat.counts, store: { writes: chat.store.written.length, reads: chat.store.read.length, files }, mail: chat.mail.length, peak, peakAfterEviction, counters, traffic, dir };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      users: { type: 'string', default: '3000' }, rooms: { type: 'string', default: '300' }, posts: { type: 'string', default: '1000' },
      resident: { type: 'string', default: '500' }, seed: { type: 'string', default: '1' }, out: { type: 'string' },
    },
  });
  const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, key === 'out' ? value : Number(value)]));
  const result = await run(options);
  const { counts, store } = result;
  console.log(`${options.users} users in ${options.rooms} rooms, ${options.posts} posts in ${Math.round(result.traffic)} ms`);
  console.log(`resident: at most ${options.resident} after each eviction (highest ${result.peakAfterEviction}), ` +
    `highest sampled by the 20 ms eviction ${result.peak}; ${result.counters.hibernated} of ${result.counters.actors} hibernated at the end`);
  console.log(`${counts.hibernated} hibernations, ${counts.woken} wakes (${store.reads} from a file, the rest from a blob ` +
    `still on its way to the disk), ${counts.notAtRest} skipped (not at rest)`);
  console.log(`store: ${store.writes} files written, ${store.files} in ${result.dir}; ${result.mail} digest emails`);
  console.log(result.wrong.length === 0 ? 'every room and every user has exactly what was sent' : result.wrong.slice(0, 20).join('\n'));
  process.exitCode = result.wrong.length === 0 ? 0 : 1;
}
