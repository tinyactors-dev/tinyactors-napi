// The game server's tricky cases on a SimulatedClock, each on both
// datamodels: a crash is the server dropping its host without closing it,
// and the recovery a new GameServer on the same directory; then the demo
// of main.mjs, with the server in a child process killed with SIGKILL.
// Run by `mise run examples` (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimulatedClock } from '@tinyactors/node';
import { SpectatorFeed } from './feed.mjs';
import { GameServer } from './game.mjs';
import { run } from './main.mjs';
import { Store } from './store.mjs';

const RULES = { turnMs: 10_000, maxTimeouts: 2 };
const plain = (value) => JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? Number(v) : v)));

/** A server on a fresh directory and a simulated clock; `restart()` crashes
 * it and opens a new one on the same directory, with a new clock (which
 * reads 0: the restored host's clock goes on from the snapshot's time). */
async function setup(datamodel, { recovery = 'replay', checkpointOnResult = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-game-test-'));
  const feed = new SpectatorFeed();
  const world = { dir, feed, clock: undefined, server: undefined };
  const open = async () => {
    world.clock = new SimulatedClock();
    world.server = await GameServer.open({
      store: new Store(dir), publish: (message) => feed.publish(message), clock: world.clock,
      datamodel, recovery, rules: RULES, checkpointOnResult,
    });
    return world.server;
  };
  world.restart = async () => {
    world.server.crash();
    return open();
  };
  world.close = () => {
    world.server?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  await open();
  return world;
}

/** Moves the clock `ms` forward, one deadline at a time. */
async function advance(world, ms) {
  const { clock, server } = world;
  const end = clock.now + ms;
  while (server.host.nextDeadline !== undefined && clock.now + server.host.nextDeadline <= end) {
    clock.increment(server.host.nextDeadline);
    await server.host.idle();
  }
  if (clock.now < end) clock.increment(end - clock.now);
  await server.host.idle();
}

/** ada and bob registered and queued: match-1, ada to move. */
async function startMatch(world) {
  const { server } = world;
  server.register('ada', 1000);
  server.register('bob', 1010);
  server.queue('ada', 1);
  server.queue('bob', 1);
  await server.host.idle();
}

/** The first rewound message of each match. */
function firstRewinds(feed) {
  const first = new Map();
  for (const rewind of feed.rewinds) if (!first.has(rewind.before.match)) first.set(rewind.before.match, rewind);
  return [...first.values()];
}

/** A frame whose turn ended by a timeout in one history and by a move in
 * the other. */
const raced = ({ before, after }) => before.event === 'frame' && after.event === 'frame'
  && (before.lastMove?.cell === null) !== (after.lastMove?.cell === null);

const frames = (feed, match = 'match-1') => feed.messages.filter((m) => m.event === 'frame' && m.match === match);

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: a match is played to a win; the checkpoint at its end is refused in the handler and tried again`, async () => {
    const world = await setup(datamodel);
    const { server, feed } = world;
    try {
      await startMatch(world);
      const before = server.stats.checkpoints;
      for (const [player, turn, cell] of [['ada', 1, 0], ['bob', 2, 3], ['ada', 3, 1], ['bob', 4, 4], ['ada', 5, 2]]) {
        assert.equal(server.move('match-1', player, turn, cell), true);
        await server.host.idle();
      }
      await server.host.idle();
      assert.deepEqual(frames(feed).map((f) => [f.frame, f.turn, f.toMove]),
        [[1, 1, 'ada'], [2, 2, 'bob'], [3, 3, 'ada'], [4, 4, 'bob'], [5, 5, 'ada']]);
      const result = feed.messages.at(-1);
      assert.deepEqual(plain(result), { event: 'result', match: 'match-1', players: ['ada', 'bob'], winner: 'ada', outcome: 'win', turns: 5, board: ['X', 'X', 'X', 'O', 'O', '', '', '', ''] });
      assert.equal(server.stats.refusals, 1, 'snapshot() from the spectator handler: TA_ERROR_STATE');
      assert.equal(server.stats.checkpoints, before + 1, 'then taken after the turn');
      assert.deepEqual(world.server.store.journal(0), [], 'the checkpoint emptied the journal');
      const ada = await server.player('ada');
      assert.deepEqual([ada.state, ada.games, ada.wins, ada.rating], ['idle', 1, 1, 1016]);
      const bob = await server.player('bob');
      assert.deepEqual([bob.state, bob.games, bob.losses, bob.rating], ['idle', 1, 1, 994]);
      assert.equal(server.move('match-1', 'bob', 6, 8), false, 'the match is over: its address names nobody');
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: a turn timer goes on after a restore from where it was at the checkpoint`, async () => {
    const world = await setup(datamodel);
    try {
      await startMatch(world);
      await advance(world, 4000);
      await world.server.checkpoint();
      await advance(world, 3000); // nothing journaled after the checkpoint: the 3 s are lost with the process
      const server = await world.restart();
      assert.equal(server.host.nextDeadline, 6000, 'ada had 6 s left at the checkpoint');
      await advance(world, 5999);
      assert.equal(frames(world.feed).at(-1).turn, 1);
      await advance(world, 1);
      assert.deepEqual(plain(frames(world.feed).at(-1).lastMove), { player: 'ada', cell: null, turn: 1 }, 'the turn timed out and was skipped');
      await advance(world, 20_000); // bob's turn, then ada's second in a row
      const result = world.feed.messages.at(-1);
      assert.deepEqual([result.event, result.winner, result.outcome], ['result', 'bob', 'forfeit']);
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: the matchmaking service is announced again as restored, restarted, and given the waiting players`, async () => {
    const world = await setup(datamodel);
    try {
      world.server.register('ada', 1000);
      world.server.queue('ada', 1);
      await world.server.host.idle();
      await world.server.checkpoint();
      const server = await world.restart();
      assert.equal(server.stats.restarts, 1, 'one invocation.restored');
      const lobby = await server.lobby();
      assert.equal(lobby.restarts, 1);
      assert.deepEqual(plain(lobby.waiting), [{ player: 'ada', rating: 1000 }]);
      // the restarted service knows ada, so a newcomer is paired with her
      server.register('bob', 1050);
      server.queue('bob', 1);
      await server.host.idle();
      assert.deepEqual(plain(frames(world.feed).at(-1).players), ['ada', 'bob']);
      assert.equal(server.stats.pairings, 1);
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: named actors and addresses resolve after a restore`, async () => {
    const world = await setup(datamodel);
    try {
      await startMatch(world);
      const names = ['lobby', 'player-ada', 'player-bob', 'match-1'];
      const sessions = names.map((name) => world.server.host.actor(name).id);
      await world.server.checkpoint();
      const server = await world.restart();
      assert.deepEqual(names.map((name) => server.host.actor(name).id), sessions, 'the same sessions');
      assert.equal(server.move('match-1', 'ada', 1, 4), true, 'a move by address');
      await server.host.idle();
      assert.equal(frames(world.feed).at(-1).turn, 2);
      assert.equal((await server.player('ada')).state, 'playing', 'the lobby told the players by address');
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: replay: the inputs after the checkpoint are applied again, each after the timers it came after`, async () => {
    const world = await setup(datamodel);
    try {
      await startMatch(world);
      await world.server.checkpoint();
      await advance(world, 10_000); // ada's turn times out
      await advance(world, 2000);
      world.server.move('match-1', 'bob', 2, 4); // journaled at 12 s, after the timeout
      await world.server.host.idle();
      await advance(world, 1000);
      const published = world.feed.messages.length;
      const server = await world.restart();
      assert.equal(server.stats.replayed, 1);
      const match = await server.match('match-1');
      assert.deepEqual([match.turn, match.board[4], plain(match.timeouts)], [3, 'O', [1, 0]]);
      assert.deepEqual(world.feed.rewinds, [], 'the replay published what was published, word for word');
      assert.equal(world.feed.duplicates, 2, 'frames 2 and 3 again, dropped');
      assert.equal(world.feed.messages.length, published + 1, 'only the resync frame passes');
      assert.equal(world.feed.messages.at(-1).resync, true);
      assert.equal(server.host.nextDeadline, 10_000, 'turn 3 began with the last input: the second before the crash is not counted');
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: lose: the inputs after the checkpoint are dropped, and the spectators see history rewound`, async () => {
    const world = await setup(datamodel, { recovery: 'lose' });
    try {
      await startMatch(world);
      await world.server.checkpoint();
      await advance(world, 10_000);
      await advance(world, 2000);
      world.server.move('match-1', 'bob', 2, 4);
      await world.server.host.idle();
      const server = await world.restart();
      assert.equal(server.stats.lost, 1);
      const match = await server.match('match-1');
      assert.deepEqual([match.turn, match.board[4]], [1, ''], 'back at the checkpoint');
      assert.equal(world.feed.messages.at(-1).resync, true);
      assert.equal(world.feed.messages.at(-1).frame, 1);
      await advance(world, 10_000); // the timeout again: the same frame 2, a duplicate
      assert.equal(world.feed.duplicates, 1);
      server.move('match-1', 'bob', 2, 0); // bob plays another cell this time
      await server.host.idle();
      assert.deepEqual(world.feed.rewinds.map((r) => [r.key, r.before.board[4], r.after.board[0]]), [['match-1#3', 'O', 'O']]);
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: a snapshot refused with a typed method's reply pending is tried again once the host is idle`, async () => {
    const world = await setup(datamodel);
    const { server } = world;
    try {
      await startMatch(world);
      const before = server.stats.checkpoints;
      const pending = server.host.actor('match-1').state();
      assert.ok(await server.checkpoint() > 0);
      assert.equal(server.stats.refusals, 1);
      assert.equal(server.stats.checkpoints, before + 1);
      assert.deepEqual(plain((await pending).value), { playing: 'turn' });
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: inputs are idempotent: a move or a queue request sent twice counts once`, async () => {
    const world = await setup(datamodel);
    const { server } = world;
    try {
      await startMatch(world);
      server.move('match-1', 'ada', 1, 4);
      server.move('match-1', 'ada', 1, 4);
      server.queue('ada', 1);
      await server.host.idle();
      assert.deepEqual(server.logs, ['duplicate: match-1 turn 1 from ada']);
      assert.equal(frames(world.feed).length, 2);
      assert.equal((await server.player('ada')).requeue, false, 'ticket 1 is the game she plays');
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: a crash between the checkpoint and the journal's truncation replays nothing twice`, async () => {
    const world = await setup(datamodel);
    try {
      await startMatch(world);
      world.server.move('match-1', 'ada', 1, 4);
      await world.server.host.idle();
      const journal = world.server.store.journal(0);
      await world.server.checkpoint();
      for (const entry of journal) world.server.store.append(entry); // as if the truncation never happened
      const server = await world.restart();
      assert.equal(server.stats.replayed, 0);
      assert.deepEqual(server.logs, [], 'no move replayed as a duplicate');
      assert.equal((await server.match('match-1')).turn, 2);
    } finally {
      world.close();
    }
  });

  test(`${datamodel}: main.mjs: a tournament whose server is killed twice keeps every record`, async () => {
    const result = await run({ players: 4, seconds: 1.5, crashes: 2, turnMs: 120, checkpointMs: 400, datamodel });
    try {
      assert.equal(result.crashed, 2);
      assert.deepEqual(result.wrong, []);
      assert.deepEqual(result.stuck, []);
      assert.deepEqual(result.errors, []);
      // A replay applies each input at the time it was journaled; a move
      // that came within a few milliseconds of its turn's timeout (a loaded
      // machine) may be judged the other way, and then that match's frames
      // from there on are rewound. Nothing else may differ.
      assert.deepEqual(firstRewinds(result.feed).filter((r) => !raced(r)), []);
      assert.ok(result.feed.results().size >= 4, `${result.feed.results().size} matches`);
    } finally {
      rmSync(result.dir, { recursive: true, force: true });
    }
  });
}
