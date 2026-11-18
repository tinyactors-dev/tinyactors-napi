# Turn game

A game server for noughts and crosses whose lobby, players and matches
are actors, that survives being killed: it checkpoints the whole host to
disk with `host.snapshot()`, journals what the clients send in between,
and after a crash restores the checkpoint with `Host.restore` and replays
the journal, or drops it, as its recovery policy says.

- **Players** (`player-<name>`) ask for a game with `queue`, which carries
  a ticket (the client's count of the games it asked for), so a request
  sent twice is one. Each keeps a rating and a record: wins, losses,
  draws.
- **The lobby** (`lobby`) invokes the matchmaking service for as long as
  it is open. The service pairs waiting players whose ratings are close;
  for each pair the lobby names a match, has the application start it,
  and tells both players.
- **A match** (`match-<n>`) runs the game. Each turn has a timer, a
  delayed send: a valid move ends the turn, the timer skips it, and a
  player whose turns run out twice in a row forfeits. A move names the
  turn it is for, so one sent again (a retry, a replay) is a duplicate
  that changes nothing.
- **The spectator feed** gets a numbered frame at the start of every turn
  and the result at the end. The clients (bots, in `main.mjs`) learn from
  it whose turn it is.

## What a crash does, and what comes back

The server checkpoints every second and at the end of every match. A
checkpoint is the host's snapshot and the number of the last journaled
input, written to a temporary file and renamed over the last one. Every
input a client sends is appended to the journal before it reaches the
host.

A crash loses the process: the host, the matchmaking service's queue, the
host's handlers. After it, a new server opens the directory and restores
the checkpoint:

- **The timers go on from where they were.** A turn with 6 s left at the
  checkpoint has 6 s left after the restore, on whatever clock the
  restored host reads. Time the process spent down is not counted, so a
  crash costs no player their turn. A real-clock snapshot needs one
  step for this: see "Surprises" below.
- **Running services are announced again.** The restored host's first
  turn calls the matchmaking handler with `invocation.restored` true. The
  application starts a new service, whose queue is empty, and sends the
  lobby `matchmaker.restarted`; the lobby, which holds the waiting list,
  gives it the waiting players again, in the order they joined. The
  chart is the record, and the service is a cache of it.
- **Every session, name and address is the same.** `host.actorByName`
  finds the lobby, the players and the matches under their old sessions,
  and inputs reach players and matches by address
  (`tinyactors://game/@match-3`), as the charts reach each other.
- **The inputs after the checkpoint** are the policy's choice (below).
- **The spectators are told again where each match is.** The lobby asks
  every running match to publish its current frame again, marked
  `resync`. A client whose move was lost in the crash sees that it is
  still its turn, and moves again. Each client also asks the server where
  its player is, and asks for its game again, under the same ticket, when
  the server does not have it.

The restored state is written as the next checkpoint at once, and the
journal emptied.

### Replay or lose: the trade-off

What the spectators saw cannot be taken back: the feed is outside the
server. The two policies differ in whether the server's history after the
recovery agrees with it.

- **`replay`** (the default): the journal's inputs are applied again on a
  host restored on a `SimulatedClock`, which is moved to each input's
  time, one deadline at a time, so each input meets the timers it met the
  first time: a move that came after its turn timed out comes after the
  timeout again. That host is snapshotted and restored once more on the
  real clock. The charts are deterministic and the matchmaking service is
  given the same queue, so the replay publishes what was published, frame
  for frame, and the feed drops those as duplicates. Nothing a player did
  is lost, and no result the spectators saw is undone. The cost: a journal
  write per input, before the input is applied (fsync it, with
  `new Store(dir, { sync: true })`, to survive the machine's crash too),
  and a recovery that takes as long as the replay.
  What the replay cannot know is the order in which the host judged a
  move and a timeout that came within a millisecond or so of each other:
  it replays them in the order of the server's clock readings, which are
  not the host's (see "Surprises"), and such a move may come out the
  other way. The feed then sees that match's frames rewound from there.
- **`lose`**: the journal is dropped, and the game goes on from the
  checkpoint. Recovery is instant and the server writes no journal it
  must trust, but every move and request after the checkpoint is gone:
  the clients must send them again (the resync frames and the players'
  records tell them what to send), the spectators see frames, and even
  results, rewound to another history, and a player who moved after the
  checkpoint may time out instead. Checkpointing at every match's end
  keeps a published result from being undone in most cases, not all: the
  result is published before its checkpoint is written.

`main.mjs --recovery lose` shows the second: the feed counts the frames
it saw rewound.

### A snapshot that is refused

`host.snapshot()` works only when the host is quiescent. It throws
`TA_ERROR_STATE` when it is called from a handler (the server checkpoints
from the spectator handler when a result comes), while a typed method's
reply is pending (an admin asking for a player's record), and while a
migration runs. The host goes on either way. `checkpoint()` catches that
status, waits for `host.idle()`, and tries again, up to five times;
concurrent calls share one checkpoint. The tests show both refusals; on
the runtime's clock, as in `main.mjs`, the checkpoint's typed method moves
it out of the handler first, so the demo rarely sees one.

## What is where

| File | What it holds |
|---|---|
| [`charts/lobby.scxml`](charts/lobby.scxml) | the lobby: the waiting list, the matchmaking invocation, the running matches |
| [`charts/match.scxml`](charts/match.scxml) | a match: turns, the turn timer, the rules, the frames and the result |
| [`charts/player.scxml`](charts/player.scxml) | a player: queueing by ticket, the rating and the record |
| [`game.mjs`](game.mjs) | the server: the host and its handlers, the matchmaking service, the clients' inputs and the journal, checkpoints, crash and recovery |
| [`store.mjs`](store.mjs) | the checkpoint file and the journal |
| [`feed.mjs`](feed.mjs) | the spectator feed: drops duplicates, records rewinds |
| [`server.mjs`](server.mjs) | the server as a child process, over its standard input and output |
| [`main.mjs`](main.mjs) | a tournament of bots against a server killed with SIGKILL and started again |
| [`test.mjs`](test.mjs) | each case on a `SimulatedClock` on both datamodels, and a small `main.mjs` |

## The tinyactors features it uses, and why

- **Snapshots** (`host.snapshot()`, `Host.restore`): the point of the
  example. A game server must come back from a crash with every match
  where it was, its timers included; a snapshot is the whole host at
  once, with no per-actor store to keep in step.
- **`invocation.restored`**: the matchmaking service is something the
  application runs, so it is not in the snapshot; the restored host asks
  for it again.
- **Delayed sends and `<cancel>`** for the turn timer: it lives in the
  host, so it is in the snapshot, and comes back with the time it had
  left.
- **An invoked service** (`urn:game:matchmaking`) for matchmaking: it
  runs for as long as the lobby is open, and talks to the lobby both ways
  (`receive`, `sendBack`).
- **I/O processors**: the spectator feed (`urn:game:spectators`), the
  matches' output to the world; and `urn:game:control`, through which the
  lobby has the application spawn a match.
- **Named actors and addresses** (`host.actorByName`, `host.send` to
  `tinyactors://game/@<name>`): clients and charts find players and
  matches by name, before and after a restore.
- **A `SimulatedClock`** for the replay, to move time to each journaled
  input, and in the tests.
- **Typed methods** (`actorContext`, `actorState`) for the
  players' records.
- **`host.now()`** for the journal's times: the host's clock, on which a
  snapshot's time is too.
- **Both datamodels**: the charts keep only plain values (no `Date`, no
  `let` in scripts), which a snapshot writes on either.

## Surprises

Every example's surprises, and what became of each, are in
[docs/surprises.md](../../docs/surprises.md), generated from the log.

Two, in docs/log.xml:

- `l-p4-examples-game-snapshot-time`: a snapshot held the time of the
  host's last turn. Fixed: it holds the time of the `snapshot()` call.
- `l-p4-examples-game-host-clock`: the host's clock could not be read.
  Fixed: `host.now()`, which the journal now uses.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/turn-game/main.mjs                    # or: bun examples/turn-game/main.mjs
node examples/turn-game/main.mjs --recovery lose --datamodel quickjs --players 12 --seconds 8 --crashes 5
```

Eight bots play for four seconds against a server killed three times:

```output
crash 1: restored in 19 ms; 7 inputs replayed, 0 lost; matchmaker restarted 2 times
crash 2: restored in 17 ms; 2 inputs replayed, 0 lost; matchmaker restarted 2 times
crash 3: restored in 19 ms; 4 inputs replayed, 0 lost; matchmaker restarted 2 times

37 matches in 4437 ms on the native datamodel, recovery replay: 25 won, 12 drawn, 0 forfeited
players: ada 3-2-5 (1079), bob 3-2-4 (1016), cy 2-3-4 (1037), dee 4-3-2 (1114), eve 3-4-2 (1081), fay 5-3-1 (1060), gus 3-5-1 (1029), hal 2-3-5 (1056)
feed: 354 messages, 10 duplicates dropped, 0 rewound (0 matches)
last server: 12 checkpoints, 0 snapshots refused and retried
every record on the server matches the last result the spectators saw of each match
checkpoint and journal: /tmp/turn-game-SbhgOk
```

The matchmaker restarts twice in a replay recovery: once on the host that
replays, once on the host restored from it. The check at the end: each
player's record on the server (games, wins, losses, draws) equals what
the results the spectators saw add up to.

## Test it

```sh
mise run examples turn-game      # under node and bun
node examples/turn-game/test.mjs
bun test ./examples/turn-game/test.mjs
```

Each case runs on both datamodels on a `SimulatedClock`; a crash there is
`server.crash()`, which drops the host without closing it. The cases: a
match to its end, with the checkpoint refused in the handler and retried;
a turn timer across a restore; the matchmaker restarted and given the
waiting players; sessions and addresses after a restore; replay and lose
with a move that came after a timeout; a snapshot refused with a reply
pending; moves and requests sent twice; a crash between a checkpoint and
the journal's truncation. The last case runs `main.mjs` with four bots
and two kills on the real clock. The whole file takes about four seconds.
