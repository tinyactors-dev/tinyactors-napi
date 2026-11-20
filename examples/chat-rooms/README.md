# Chat rooms

A chat service whose workspaces, rooms and connections are actors:
thousands of them, of which only a bound are in memory at any moment.
The rest are hibernated, one file each in a store on disk, and an event
for one of them brings it back.

- **A workspace** is a collection actor: it decides which rooms exist. A
  connection asks it for a room; it checks that the asker is an owner and
  that the name is valid and free, and asks the `Spawner` for the room.
  It never ends.
- **A room** keeps its members and its history. When it starts it saves
  itself to the database and announces itself to its workspace, so the
  workspace learns of every room the same way, whether it made the room
  or the application brought it back after a restart. A post from a
  member goes into the history, into the database, and to every member's
  socket in one send to the gateway. It never ends.
- **A connection** is one open socket. It turns the client's frames into
  sends to the right actor, and what actors send back into frames for
  the client; it closes the socket when the client misses its heartbeat,
  and leaves its rooms when it ends.
- **The resident set is bounded.** The host keeps at most `resident`
  actors in memory and hibernates the rest into a `FileStore`, one file
  per actor; a post to a hibernated room, or a request to a hibernated
  workspace, wakes it. A room's broadcast reaches its members' sockets
  through the gateway without waking their connections.

The logic is in the charts. The application gives the host one I/O
processor per external system, each an object whose `receive(send)`
switches on `send.event`: `chat:gateway` (the sockets), `chat:db` (the
database, here tables in memory standing in for PostgreSQL) and
`chat:inbox` (direct messages); and the package's `Spawner` under the
type `spawn`. The charts' helpers are in a `.js` file beside each chart
(`<script src="room.js"/>`), functions that take the variables they read
as arguments.

## A send to an actor that is not there

The chat uses each of the three ways of
[When the actor is not there](../../docs/guide/missing-actors.md):

- **The actor never ends and hibernates.** Workspaces and rooms never
  reach a final state. A connection sends to them by name
  (`tinyactors://chat/@workspace.acme`, `@room.acme.general`), and a
  hibernated one is woken by the host for the event: the test "the actor
  hibernates" keeps one actor in memory and sends to a workspace and a
  room that are both in their files.
- **The application routes it through an I/O processor.** A user is not
  an actor: a direct message goes to `chat:inbox`, which looks up the
  user's connection actors and forwards the message to each, or keeps it
  in the database when the user has none (`processors.mjs`, `Inbox`). And
  a room is made by its workspace, the collection actor, through the
  `Spawner` (`charts/workspace.scxml`).
- **The sender handles `error.communication`.** A join of a room that
  does not exist fails at once, and the connection turns the error into
  an error frame for the client (`charts/connection.scxml`, the
  transition on `error.communication` with the sendid `join`).

Names follow one convention: the kind and the ids joined by `.`, each id
of lowercase letters, digits and `-` (`workspace.js` checks a room's
name). Those characters need no percent-encoding, so an address is the
name after `@` wherever a chart or the application writes it.

## What is where

| File | What it holds |
|---|---|
| [`charts/workspace.scxml`](charts/workspace.scxml), [`workspace.js`](charts/workspace.js) | a workspace: who may make rooms, the spawn, the rooms that announced themselves |
| [`charts/room.scxml`](charts/room.scxml), [`room.js`](charts/room.js) | a room: saving and announcing itself, members, posts, the broadcast, an admin's kick |
| [`charts/connection.scxml`](charts/connection.scxml), [`connection.js`](charts/connection.js) | a connection: the client's frames, the heartbeat, joins and their misses, direct messages; the naming convention |
| [`processors.mjs`](processors.mjs) | the I/O processors: `Gateway` (`chat:gateway`), `Database` (`chat:db`), `Inbox` (`chat:inbox`) |
| [`store.mjs`](store.mjs) | `FileStore`, the host's store: one file per hibernated actor, a session's operations one after another |
| [`chat.mjs`](chat.mjs) | the application: the charts compiled once, the host with its processors and store, a restart from the database, sockets to connections |
| [`main.mjs`](main.mjs) | an evening of traffic on the real clock, checked at the end |
| [`test.mjs`](test.mjs) | each behaviour end to end on a `SimulatedClock`, on both datamodels, and a small evening |

## The tinyactors features it uses, and why

- **`compileDir`**: the charts and their `.js` helpers are compiled once
  per process, and any number of hosts add the result.
- **I/O processors as objects**, one per external system; `Database`'s
  `receive` is `async`, as a database client's is.
- **`Spawner`**: the workspace makes a room with `<send type="spawn">`
  and matches the answer, `spawned`, by the send's `sendid`
  (`idlocation`). A name has one owner: the workspace is the only actor
  that spawns its rooms' names, and it keeps the spawns in flight in
  `creating`, so it never asks twice for a name.
- **`store` and `resident`**: the host hibernates the actors past the
  bound after each turn and wakes one when an event comes for it;
  `FileStore`'s methods return promises, which the host follows.
- **Named actors and addresses**: rooms and workspaces are found by
  name, so neither the application nor a chart keeps a table of
  sessions; `host.actor(name)` finds one for the application.
- **`actor.ask`**: the application asks a workspace for its rooms
  (`rooms.list`), and an admin asks a room to kick a user (`kick`); the
  chart answers to `_event.origin`.
- **Keying a table by the sender**: a room keys its members by the
  fragment of `_event.origin` (`sender` in `room.js`), so one connection
  is one member whichever form the origin has
  ([Keying a table by the sender](../../docs/guide/missing-actors.md#keying-a-table-by-the-sender)).
- **`onDone`**: a connection that ended (a missed heartbeat, a closed
  socket) leaves the gateway.
- **A delayed send and `<cancel>`**: the heartbeat, a deadline that
  stays in the host while the connection is hibernated.
- **`<foreach>`**: a connection leaves each of its rooms when it ends.
- **A `SimulatedClock`** in the test, so a minute of heartbeat takes no
  time; **both datamodels**: the test runs every case on the native
  datamodel and on quickjs.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/chat-rooms/main.mjs              # or: bun examples/chat-rooms/main.mjs
node examples/chat-rooms/main.mjs --workspaces 20 --users 500 --rooms 20 --posts 20000 --resident 500 --out /tmp/chat
```

It prints what happened and the check:

```output
1000 users in 50 rooms, 2000 posts in 1202 ms
resident: at most 150, highest at rest 150; 910 of 1060 actors hibernated at the end
store: 2870 saves, 1960 loads, 1960 deletes; 910 files in /tmp/chat-rooms-9jBkDx
4 joins of a missing room answered with an error frame; 4 direct messages kept for a user offline
every member got every message of its rooms, in order
```

## Test it

```sh
mise run examples chat-rooms     # under node and bun
node examples/chat-rooms/test.mjs
bun test ./examples/chat-rooms/test.mjs
```

The sockets are recorders (`chat.mjs`'s `Socket`), and the clock a
`SimulatedClock`, so a missed heartbeat takes no time. It all takes
under a second.
