// A tournament on the real clock, with the game server in a child process
// (server.mjs) that is killed with SIGKILL in the middle of play and
// started again from its checkpoint and journal. Bots play noughts and
// crosses: each learns whose turn it is from the spectator feed, answers
// after a few milliseconds, and now and then lets its turn time out. When
// the time is up the bots stop queueing, every match ends, and the
// players' records on the server are checked against the results the
// spectators saw.
//
//   node examples/turn-game/main.mjs [--players N] [--seconds S] [--crashes C]
//        [--recovery replay|lose] [--datamodel native|quickjs] [--turn-ms MS] [--checkpoint-ms MS]
//        [--seed S] [--dir DIR]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { SpectatorFeed } from './feed.mjs';

/** A small seeded generator (mulberry32), so a run's bots can be repeated. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const debug = process.env.TURN_GAME_DEBUG ? (...args) => console.error('[main]', ...args) : () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const NAMES = ['ada', 'bob', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jo', 'kim', 'lou'];

/** A cell that completes a line of `mark`, if there is one. */
function completing(board, mark) {
  for (const line of LINES) {
    const marks = line.filter((cell) => board[cell] === mark).length;
    const empty = line.filter((cell) => board[cell] === '');
    if (marks === 2 && empty.length === 1) return empty[0];
  }
  return undefined;
}

/** The game server's process: inputs go to it a line each, and wait in
 * `outbox` while it is down. */
class ServerProcess {
  constructor({ dir, datamodel, recovery, turnMs, checkpointMs, onMessage }) {
    this.args = [new URL('./server.mjs', import.meta.url).pathname, '--dir', dir, '--datamodel', datamodel,
      '--recovery', recovery, '--turn-ms', String(turnMs), '--checkpoint-ms', String(checkpointMs)];
    this.onMessage = onMessage;
    this.outbox = [];
    this.child = undefined;
    this.up = false;
  }

  /** Starts the process; resolves with its `ready` message. */
  start() {
    const child = this.child = spawn(process.execPath, this.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.exited = new Promise((resolve) => child.once('exit', resolve));
    return new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => { if (!this.up) reject(new Error(`the server exited (${code ?? signal}) before it was ready`)); });
      createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line);
        if (message.type === 'ready') {
          this.up = true;
          for (const input of this.outbox.splice(0)) this.send(input);
          resolve(message);
        }
        this.onMessage(message);
      });
    });
  }

  send(input) {
    if (!this.up) this.outbox.push(input);
    else this.child.stdin.write(`${JSON.stringify(input)}\n`);
  }

  /** SIGKILL: no handler runs, nothing is flushed or closed. */
  async kill() {
    this.up = false;
    this.child.kill('SIGKILL');
    await this.exited;
  }
}

/** Plays a tournament and answers what happened, with `wrong` listing
 * every player whose record on the server differs from the results the
 * spectators saw. */
export async function run({ players = 8, seconds = 3, crashes = 2, recovery = 'replay', datamodel = 'native', turnMs = 250, checkpointMs = 1000, seed = 1, dir } = {}) {
  const next = random(seed);
  dir ??= mkdtempSync(join(tmpdir(), 'turn-game-'));
  const feed = new SpectatorFeed();
  const replies = [];
  const errors = [];
  const readies = [];
  const server = new ServerProcess({
    dir, datamodel, recovery, turnMs, checkpointMs,
    onMessage: (message) => {
      if (message.type === 'feed') feed.publish(message.message);
      else if (message.type === 'report') replies.shift()?.(message);
      else if (message.type === 'error') errors.push(message.message);
      else if (message.type === 'ready') readies.push(message);
    },
  });

  let queueing = true;
  /** name -> { ticket: the last game it asked for, matched: the ticket its
   * last match answered, match: the one it plays, frames: match -> the
   * last frame it acted on, seen: the matches whose result it saw } */
  const bots = new Map(NAMES.slice(0, players).map((name) => [name, { name, ticket: 0, matched: 0, match: undefined, frames: new Map(), seen: new Set() }]));
  const ask = (bot) => {
    bot.ticket++;
    server.send({ op: 'queue', name: bot.name, ticket: bot.ticket });
  };
  const report = () => new Promise((resolve) => {
    replies.push(resolve);
    server.send({ op: 'report', players: [...bots.keys()] });
  });

  feed.subscribe((message) => {
    if (message.event === 'frame') {
      for (const name of message.players) {
        const bot = bots.get(name);
        if (bot.match !== message.match && !bot.seen.has(message.match)) {
          bot.match = message.match;
          bot.matched = bot.ticket;
        }
      }
      const bot = bots.get(message.toMove);
      if (!(message.frame > (bot.frames.get(message.match) ?? 0) || message.resync)) return;
      bot.frames.set(message.match, message.frame);
      const mark = (message.turn - 1) % 2 === 0 ? 'X' : 'O';
      const other = mark === 'X' ? 'O' : 'X';
      const empty = message.board.flatMap((cell, i) => (cell === '' ? [i] : []));
      const cell = completing(message.board, mark) ?? completing(message.board, other) ?? empty[Math.floor(next() * empty.length)];
      const skip = next() < 0.08; // the player is away: the turn times out
      const delay = 5 + next() * 50;
      if (!skip) setTimeout(() => server.send({ op: 'move', match: message.match, player: bot.name, turn: message.turn, cell }), delay);
    } else if (message.event === 'result') {
      for (const name of message.players) {
        const bot = bots.get(name);
        if (bot.match === message.match) bot.match = undefined;
        if (bot.seen.has(message.match)) continue; // published again (a rewind): counted once
        bot.seen.add(message.match);
        if (queueing) ask(bot);
      }
    }
  });

  const started = Date.now();
  await server.start();
  for (const bot of bots.values()) server.send({ op: 'register', name: bot.name, rating: 1000 + Math.round(next() * 100) });
  for (const bot of bots.values()) ask(bot);

  // the crashes, spread over the tournament
  let crashed = 0;
  const recoveries = [];
  for (let n = 1; n <= crashes; n++) {
    const at = (seconds * 1000 * n) / (crashes + 1) + (next() - 0.5) * 200;
    await sleep(Math.max(0, at - (Date.now() - started)));
    debug('kill', n);
    await server.kill();
    crashed++;
    const ready = await server.start();
    debug('ready', JSON.stringify(ready));
    recoveries.push(ready);
    // What a client believed may be wrong now: inputs written to the
    // killed process that it did not read are lost, and with the lose
    // policy so is everything after the checkpoint. Each bot asks the
    // server where its player is, and asks for its game again, under the
    // same ticket, when the server does not have it.
    const { players: records } = await report();
    for (const bot of bots.values()) {
      const record = records[bot.name];
      bot.match = record.state === 'playing' ? record.match : undefined;
      if (bot.match !== undefined) {
        bot.seen.delete(bot.match); // a result the spectators saw may come again, or another one
        bot.matched = record.ticket;
      }
      if (queueing && record.state === 'idle' && !record.requeue) {
        if (bot.ticket > record.ticket) server.send({ op: 'queue', name: bot.name, ticket: bot.ticket });
        else ask(bot);
      } else if (queueing && record.state === 'playing' && bot.ticket > record.ticket) {
        server.send({ op: 'queue', name: bot.name, ticket: bot.ticket });
      }
    }
  }
  await sleep(Math.max(0, seconds * 1000 - (Date.now() - started)));

  // time is up: no new games; wait for the matches to end, then let the
  // ones still waiting leave
  queueing = false;
  debug('time is up');
  const deadline = Date.now() + 40 * turnMs + 2000;
  while ([...bots.values()].some((bot) => bot.match !== undefined) && Date.now() < deadline) await sleep(turnMs / 2);
  for (const bot of bots.values()) server.send({ op: 'leave', name: bot.name });
  await sleep(50);

  debug('report; still in a match:', [...bots.values()].filter((bot) => bot.match !== undefined).map((bot) => `${bot.name}@${bot.match}`));
  const final = await report();
  debug('exit');
  server.send({ op: 'exit' });
  server.child.stdin.end();
  await server.exited;

  // each player's record against the last result the spectators saw of
  // each match
  const expected = new Map([...bots.keys()].map((name) => [name, { games: 0, wins: 0, losses: 0, draws: 0 }]));
  for (const result of feed.results().values()) {
    for (const name of result.players) {
      const record = expected.get(name);
      record.games++;
      if (result.winner === null) record.draws++;
      else if (result.winner === name) record.wins++;
      else record.losses++;
    }
  }
  const wrong = [];
  for (const [name, record] of expected) {
    const got = final.players[name];
    for (const key of ['games', 'wins', 'losses', 'draws']) {
      if (got[key] !== record[key]) wrong.push({ name, key, server: got[key], spectators: record[key] });
    }
  }
  return {
    ms: Date.now() - started, dir, feed, report: final, wrong, errors, crashed, recoveries,
    stuck: [...bots.values()].filter((bot) => bot.match !== undefined).map((bot) => bot.name),
  };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      players: { type: 'string', default: '8' },
      seconds: { type: 'string', default: '4' },
      crashes: { type: 'string', default: '3' },
      recovery: { type: 'string', default: 'replay' },
      datamodel: { type: 'string', default: 'native' },
      'turn-ms': { type: 'string', default: '250' },
      'checkpoint-ms': { type: 'string', default: '1000' },
      seed: { type: 'string', default: '1' },
      dir: { type: 'string' },
    },
  });
  const result = await run({
    players: Number(values.players), seconds: Number(values.seconds), crashes: Number(values.crashes),
    recovery: values.recovery, datamodel: values.datamodel, turnMs: Number(values['turn-ms']), checkpointMs: Number(values['checkpoint-ms']), seed: Number(values.seed), dir: values.dir,
  });
  const { feed, report, wrong, recoveries } = result;
  const results = [...feed.results().values()];
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  for (const [n, ready] of recoveries.entries()) {
    console.log(`crash ${n + 1}: restored in ${ready.ms} ms; ${ready.stats.replayed} inputs replayed, ${ready.stats.lost} lost; ` +
      `matchmaker restarted ${ready.stats.restarts} times`);
  }
  console.log(`\n${results.length} matches in ${result.ms} ms on the ${values.datamodel} datamodel, recovery ${values.recovery}: ` +
    `${count('win')} won, ${count('draw')} drawn, ${count('forfeit')} forfeited`);
  console.log(`players: ${Object.entries(report.players).map(([name, p]) => `${name} ${p.wins}-${p.losses}-${p.draws} (${p.rating})`).join(', ')}`);
  console.log(`feed: ${feed.messages.length} messages, ${feed.duplicates} duplicates dropped, ${feed.rewinds.length} rewound ` +
    `(${new Set(feed.rewinds.map((r) => r.before.match)).size} matches)`);
  console.log(`last server: ${report.stats.checkpoints} checkpoints, ${report.stats.refusals} snapshots refused and retried`);
  if (result.errors.length > 0) console.log(`errors: ${result.errors.join('; ')}`);
  const ok = wrong.length === 0 && result.stuck.length === 0 && result.errors.length === 0;
  if (ok) console.log('every record on the server matches the last result the spectators saw of each match');
  else if (values.recovery === 'lose' && result.stuck.length === 0 && result.errors.length === 0) {
    console.log(`the cost of losing inputs: ${wrong.length} counts differ from what the spectators saw: ${JSON.stringify(wrong)}`);
  } else console.log(`MISMATCH: ${JSON.stringify(wrong)}${result.stuck.length ? `; still playing: ${result.stuck}` : ''}${result.errors.join('; ')}`);
  console.log(`checkpoint and journal: ${result.dir}`);
  process.exitCode = ok || (values.recovery === 'lose' && result.stuck.length === 0 && result.errors.length === 0) ? 0 : 1;
}
