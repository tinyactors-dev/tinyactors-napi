// The game server: a host whose actors are the lobby, the players and the
// matches (charts/), and the I/O they ask for: the matchmaking service the
// lobby invokes, the spectator feed and the control processor that starts
// a match. The server is crash-safe: it checkpoints the host with
// host.snapshot() and journals every client input in between, and after a
// crash it restores the last checkpoint with Host.restore and replays the
// journal on top of it, or drops it, as its recovery policy says.
import { readFileSync } from 'node:fs';
import { Host, SimulatedClock, TinyactorsError } from '@tinyactors/node';

const chart = (name) => readFileSync(new URL(`./charts/${name}`, import.meta.url), 'utf8');
const CHARTS = { 'lobby.scxml': chart('lobby.scxml'), 'match.scxml': chart('match.scxml'), 'player.scxml': chart('player.scxml') };

/** The host's config: the same for `new Host` and for `Host.restore`, which
 * checks its systemID; the I/O processors are not in the snapshot. */
export const CONFIG = {
  systemID: 'game',
  ioProcessors: [{ type: 'urn:game:spectators' }, { type: 'urn:game:control' }],
};

/** An actor's address: inputs reach the players and the matches by name. */
const address = (name) => `tinyactors://game/@${name}`;

/** How many times a checkpoint is tried before its error is thrown. */
const CHECKPOINT_ATTEMPTS = 5;

/** The matchmaking service: pairs waiting players whose ratings are
 * within `window`, oldest first. What it holds is a cache of the lobby's
 * waiting list: a restarted one asks the lobby for it again. */
class Matchmaker {
  constructor(invocation, server) {
    this.invocation = invocation;
    this.server = server;
    this.window = invocation.data.window;
    /** [{ player, rating }], in the order they joined */
    this.queue = [];
  }

  receive(host, send) {
    const { event, data } = send;
    if (event === 'enqueue') this.queue.push({ player: data.player, rating: data.rating });
    else if (event === 'dequeue') this.queue = this.queue.filter((w) => w.player !== data.player);
    else if (event === 'resync') this.queue = data.waiting.map((w) => ({ player: w.player, rating: w.rating }));
    this.pair();
  }

  /** The oldest waiting player with the closest one in its window, until
   * no pair is left. */
  pair() {
    for (let i = 0; i < this.queue.length; i++) {
      let best = -1;
      for (let j = i + 1; j < this.queue.length; j++) {
        const gap = Math.abs(this.queue[i].rating - this.queue[j].rating);
        if (gap <= this.window && (best < 0 || gap < Math.abs(this.queue[i].rating - this.queue[best].rating))) best = j;
      }
      if (best < 0) continue;
      const players = [this.queue[i].player, this.queue[best].player];
      this.queue.splice(best, 1);
      this.queue.splice(i, 1);
      this.server.stats.pairings++;
      this.invocation.sendBack('paired', { players });
      i--;
    }
  }
}

export class GameServer {
  /**
   * @param {object} options
   * @param {import('./store.mjs').Store} options.store where checkpoints and the journal go
   * @param {(message: object) => void} [options.publish] the spectator feed
   * @param {SimulatedClock} [options.clock] the host's clock; the runtime's without one
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {'replay' | 'lose'} [options.recovery] what a recovery does with
   *   the inputs journaled after the last checkpoint
   * @param {{ turnMs?: number, maxTimeouts?: number, window?: number }} [options.rules]
   * @param {boolean} [options.checkpointOnResult] checkpoint at the end of every match
   */
  constructor({ store, publish = () => {}, clock, datamodel = 'native', recovery = 'replay', rules = {}, checkpointOnResult = true }) {
    this.store = store;
    this.publish = publish;
    this.clock = clock;
    this.datamodel = datamodel;
    this.recovery = recovery;
    this.rules = rules;
    this.checkpointOnResult = checkpointOnResult;
    /** the host's clock, in milliseconds: the journal's times, on the
     * clock the snapshots' times are on */
    this.now = () => this.host.now();
    /** the last input's journal number */
    this.seq = 0;
    /** `now()` at the last checkpoint: a journal entry's `at` counts from it */
    this.base = 0;
    this.ready = false;
    this.replaying = false;
    this.crashed = false;
    this.logs = [];
    this.stats = { checkpoints: 0, refusals: 0, recoveries: 0, replayed: 0, lost: 0, restarts: 0, pairings: 0 };
  }

  /** A server on `options.store`: restored from its checkpoint when it has
   * one, else new. Resolves once it takes inputs. */
  static async open(options) {
    const server = new GameServer(options);
    const saved = server.store.readCheckpoint();
    if (saved === undefined) await server.#create();
    else await server.#recover(saved);
    server.ready = true;
    return server;
  }

  // ---- the host and its handlers ------------------------------------------

  #options(clock) {
    return {
      clock,
      datamodel: this.datamodel,
      ioProcessors: {
        'urn:game:spectators': (host, send) => this.#spectate(host, send),
        'urn:game:control': (host, send) => this.#control(host, send),
      },
      services: {
        'urn:game:matchmaking': (host, invocation) => this.#matchmaking(host, invocation),
      },
      log: (host, entry) => {
        if (host === this.host) this.logs.push(`${entry.label}: ${entry.text}`);
      },
    };
  }

  async #create() {
    this.host = new Host(CONFIG, this.#options(this.clock));
    this.host.addCharts(CHARTS);
    this.host.spawnChart('lobby', { name: 'lobby', params: this.rules });
    await this.host.idle();
    this.store.truncateJournal();
    await this.checkpoint();
  }

  /** A handler of a host this server no longer runs (one dropped by a
   * crash, or the replay's) does nothing. */
  #mine(host) {
    return host === this.host && !this.crashed;
  }

  #spectate(host, send) {
    if (!this.#mine(host)) return;
    const message = { event: send.event, ...send.data };
    this.publish(message);
    // A match's end is a moment worth a checkpoint. From this handler the
    // host is not quiescent, so the first attempt is refused with
    // TA_ERROR_STATE, and checkpoint() tries again after the turn.
    if (message.event === 'result' && this.checkpointOnResult && !this.replaying) {
      this.checkpoint().catch((error) => { this.checkpointError = error; });
    }
  }

  #control(host, send) {
    if (!this.#mine(host)) return;
    if (send.event !== 'match.create') return send.fail();
    const { match, players, turnMs, maxTimeouts } = send.data;
    host.spawnChart('match', { name: match, params: { match, players: [...players], turnMs, maxTimeouts } });
  }

  #matchmaking(host, invocation) {
    const service = new Matchmaker(invocation, this);
    // A restored host announces the invocation that was running at the
    // snapshot. Its queue was in the process that crashed: the lobby holds
    // the waiting list, so ask for it.
    if (invocation.restored) {
      this.stats.restarts++;
      invocation.sendBack('matchmaker.restarted');
    }
    return service;
  }

  // ---- the clients' inputs ------------------------------------------------

  /** A new player, `player-<name>`. Answers its session. */
  register(name, rating = 1000) {
    return this.#input({ op: 'register', name, rating });
  }

  /** Player `name` asks for a game; `ticket` counts the games it asked for,
   * so the same request sent twice is one. */
  queue(name, ticket) {
    return this.#input({ op: 'queue', name, ticket });
  }

  /** Player `name` stops waiting for a game. */
  leave(name) {
    return this.#input({ op: 'leave', name });
  }

  /** Player `player` plays `cell` (0 to 8) on `turn` of `match`. Answers
   * false when the match is over. */
  move(match, player, turn, cell) {
    return this.#input({ op: 'move', match, player, turn, cell });
  }

  /** Journals the input, then applies it: an input the host took is in
   * the journal, so a recovery can replay it. */
  #input(entry) {
    if (!this.ready || this.crashed) throw new Error('the server is not running');
    const journaled = { seq: this.seq + 1, at: this.now() - this.base, ...entry };
    this.store.append(journaled);
    this.seq = journaled.seq;
    return this.#apply(this.host, journaled);
  }

  #apply(host, entry) {
    try {
      switch (entry.op) {
        case 'register':
          return host.actorByName(`player-${entry.name}`)
            ?? host.spawnChart('player', { name: `player-${entry.name}`, params: { name: entry.name, rating: entry.rating } });
        case 'queue':
          host.send(address(`player-${entry.name}`), 'queue', { ticket: entry.ticket });
          return true;
        case 'leave':
          host.send(address(`player-${entry.name}`), 'leave');
          return true;
        case 'move':
          host.send(address(entry.match), 'move', { player: entry.player, turn: entry.turn, cell: entry.cell });
          return true;
        default:
          throw new Error(`unknown input ${entry.op}`);
      }
    } catch (error) {
      // the actor ended (a match that is over), or never was
      if (error instanceof TinyactorsError && (error.status === 'TA_ERROR_STALE' || error.status === 'TA_ERROR_INVALID')) return false;
      throw error;
    }
  }

  // ---- checkpoints, crashes and recovery ----------------------------------

  /** Writes a checkpoint: the host's snapshot and the journal's number it
   * holds everything up to; then empties the journal. A snapshot is taken
   * only when the host is quiescent: refused with TA_ERROR_STATE (from a
   * handler, with a typed method's reply pending), it is tried again once
   * the host is idle. Concurrent calls share one checkpoint. */
  checkpoint() {
    if (this.inflight) return this.inflight;
    this.inflight = this.#checkpoint(this.host).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  async #checkpoint(host) {
    const { snapshot, at } = await this.#snapshot(host);
    if (host !== this.host || this.crashed) return 0;
    this.store.writeCheckpoint({ seq: this.seq, datamodel: this.datamodel, snapshot });
    this.store.truncateJournal();
    this.base = at;
    this.stats.checkpoints++;
    return snapshot.length;
  }

  async #snapshot(host) {
    for (let attempt = 1; ; attempt++) {
      try {
        // the snapshot holds the host's time at the call, which this
        // reading of the host's clock just before it is, to the microsecond
        const at = host.now();
        return { snapshot: host.snapshot(), at };
      } catch (error) {
        if (!(error instanceof TinyactorsError) || error.status !== 'TA_ERROR_STATE' || attempt === CHECKPOINT_ATTEMPTS) throw error;
        this.stats.refusals++;
        await host.idle();
      }
    }
  }

  /** The process dies: the host is dropped, not closed, and whatever was
   * not in the store is gone. Its handlers do nothing from now on. */
  crash() {
    this.crashed = true;
    this.ready = false;
    this.host = undefined;
  }

  /** Restores the last checkpoint. With the `replay` policy, the journal's
   * inputs are applied again first, on a host restored on a simulated
   * clock that is moved to each input's time, so each meets the timers it
   * met before; then that host is snapshotted and restored on the
   * server's own clock. With `lose`, the journal is dropped. Either way
   * the lobby asks each running match to publish its current frame again,
   * and the result is the new checkpoint. */
  async #recover(saved) {
    if (saved.datamodel !== this.datamodel) throw new Error(`the checkpoint is of the ${saved.datamodel} datamodel`);
    this.seq = saved.seq;
    let snapshot = saved.snapshot;
    const entries = this.store.journal(saved.seq);
    if (entries.length > 0 && this.recovery === 'replay') {
      snapshot = await this.#replay(snapshot, entries);
    } else {
      this.stats.lost += entries.length;
      if (entries.length > 0) this.seq = entries.at(-1).seq;
    }
    this.host = Host.restore(snapshot, CONFIG, this.#options(this.clock));
    await this.host.idle(); // the matchmaker announced, restarted and given the waiting players
    this.host.send(this.host.actorByName('lobby'), 'sync');
    await this.host.idle();
    await this.checkpoint();
    this.stats.recoveries++;
  }

  async #replay(snapshot, entries) {
    const clock = new SimulatedClock(); // reads the snapshot's time
    this.replaying = true;
    const host = this.host = Host.restore(snapshot, CONFIG, this.#options(clock));
    try {
      await host.idle();
      for (const entry of entries) {
        // Every deadline due by the input's time first, one at a time: the
        // times are the host's clock's, read as each input came.
        while (host.nextDeadline !== undefined && clock.now + host.nextDeadline <= entry.at) {
          clock.increment(Math.max(host.nextDeadline, 0));
          await host.idle();
        }
        if (clock.now < entry.at) clock.increment(entry.at - clock.now);
        this.#apply(host, entry);
        this.seq = entry.seq;
        this.stats.replayed++;
        await host.idle();
      }
      return (await this.#snapshot(host)).snapshot;
    } finally {
      this.replaying = false;
      this.host = undefined;
      host.close();
    }
  }

  // ---- reading the game ---------------------------------------------------

  /** A player's record: its variables and its state. */
  async player(name) {
    const session = this.host.actorByName(`player-${name}`);
    if (session === undefined) return undefined;
    const [{ variables }, { value }] = await Promise.all([
      this.host.actorContext({ session }), this.host.actorState({ session }),
    ]);
    return { session, state: value, ...variables };
  }

  /** The lobby's variables. */
  async lobby() {
    const { variables } = await this.host.actorContext({ session: this.host.actorByName('lobby') });
    return variables;
  }

  /** A match's variables, or undefined once it is over. */
  async match(name) {
    const session = this.host.actorByName(name);
    if (session === undefined) return undefined;
    const { variables } = await this.host.actorContext({ session });
    return { session, ...variables };
  }

  close() {
    this.ready = false;
    this.host?.close();
  }
}
