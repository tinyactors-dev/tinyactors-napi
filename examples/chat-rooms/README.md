# Chat rooms

A chat service whose rooms and users are actors: thousands of them, of
which only a few hundred are in memory at any moment. The rest are
hibernated, one file each in a store on disk, and a message for one of
them brings it back.

- **A room** keeps its members and its history (the last 50 entries, each
  numbered). A user joins and leaves by asking the room, and only a member
  may post; a full room refuses a join, and a message that is empty or too
  long is refused. Each message gets the room's next number and goes to
  every member's actor.
- **A user** keeps the rooms they are in and, while they are away, an
  inbox of the messages that reached them. Online, a message is pushed to
  their connection; offline, it waits in the inbox, and a digest email goes
  out a minute after the first unread one if they have not come back.
  Connecting pushes the backlog and cancels the digest.
- **The resident set is bounded.** Whenever more than `maxResident` actors
  are in memory, an eviction sends the ones the host's sweep finds cold
  (they did not run since the last sweep) to the store, then the least
  recently used, until `maxResident` are left. A message, a read of a
  room's history or a due digest for a hibernated actor makes the host
  ask for it back.

What makes it interesting is what happens around the store:

- **A message for a room whose wake is in flight.** The room's file is
  being read when more posts arrive for it. The host asks for the actor
  once per hibernation; the posts wait in its queue and run, in the order
  they came, once the wake is done.
- **A wake while the blob is still on its way to the disk.** An actor is
  hibernated and, before its file is written, a message comes for it. The
  store keeps each blob in memory until its file is written and answers a
  wake from there, so no wake reads a file that is not written yet, and
  each session's writes are chained so an older blob never lands on a
  newer one.
- **A write that fails** (a full disk, an I/O error). The blob in hand is
  then the actor's only copy: the application wakes the actor back from it,
  so it stays in memory with nothing lost, and the next eviction tries
  again. If a wake took the blob from memory before the write failed, the
  actor is awake already and nothing needs doing.

`main.mjs` checks at the end that every room holds what was sent to it,
with no gap in its numbering and each author's messages in order, that
every user received every message of their rooms, and that after every
eviction at rest no more than `maxResident` actors were in memory.

## What is where

| File | What it holds |
|---|---|
| [`charts/room.scxml`](charts/room.scxml) | a room: membership, posting rules, numbering, history, the fan-out to members |
| [`charts/user.scxml`](charts/user.scxml) | a user: their rooms, online and offline, the inbox and the digest timer |
| [`chat.mjs`](chat.mjs) | the application: the host, its I/O processors and wake handler, the eviction |
| [`store.mjs`](store.mjs) | the file store: one file per hibernated session, written atomically, blobs kept in memory until written |
| [`main.mjs`](main.mjs) | an evening of traffic on the real clock, checked at the end |
| [`test.mjs`](test.mjs) | each tricky case on a `SimulatedClock` on both datamodels, a load of hundreds of actors, and the demo |

## The tinyactors features it uses, and why

- **Hibernation** (`host.sweep`, `host.hibernate`, the `wake` handler,
  `host.wake`): the service holds thousands of actors and keeps a few
  hundred in memory. A room or a user spends most of its time waiting,
  which is what hibernation is for; the host does no I/O, so the store is
  the application's, files here. The wake handler takes the blob from the
  store (from memory, or a file read that returns a promise) and calls
  `host.wake`. Every variable of both charts is a plain value and neither
  chart has a `<script>`, so every actor at rest can hibernate.
- **The sweep** finds the cold actors without the application tracking
  what ran: a member woken by a fan-out ran, so the next sweep skips it.
  The application still keeps its own list of resident sessions, least
  recently used first, to bring the count down to the bound when the sweep
  finds too few, and because `hibernate` gives the same error for an actor
  that is busy and one that is not in memory at all.
- **`hostStats`** answers `actors` and `hibernated`, the resident set
  the demo and the test check after every eviction.
- **Named actors and addresses** (`spawnChart(chart, { name })`,
  `host.actorByName`, `tinyactors://chat/@room-lobby`): a user's actor
  sends to a room by its address, the room answers to `_event.origin` and
  sends each message to `tinyactors://chat/@user-<name>`. An address finds
  a hibernated actor too: the event waits in its queue and the host asks
  for it.
- **`<foreach>`** over the members for the fan-out.
- **A delayed send that wakes an actor** (`<send id="digest"
  delayexpr>`, `<cancel>`): a user's digest timer stays in the host while
  the user is hibernated, and wakes them when it falls due.
- **I/O processors** (`urn:chat:client`, `urn:chat:mail`,
  `urn:chat:reply`): pushes to a connection, digest emails, and the
  answer to the application's read of a room, which the application turns
  into a promise.
- **Spawn params** give each room its name and limits, and each user
  their name and the digest delay.
- **A `SimulatedClock`** in the test, so the minute of a digest takes no
  time.
- **Both datamodels:** the test runs every case on the native datamodel
  and on quickjs.

The host is sized up front for the population (`maxActors`,
`maxTimers`); the pools of events, variables and strings grow when a
burst fills them.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/chat-rooms/main.mjs              # or: bun examples/chat-rooms/main.mjs
node examples/chat-rooms/main.mjs --users 10000 --rooms 1000 --posts 2000 --resident 1000 --out /tmp/chat
```

It prints what happened and the checks:

```output
3000 users in 300 rooms, 1000 posts in 9876 ms
resident: at most 500 after each eviction (highest 500), highest sampled by the 20 ms eviction 500; 845 of 3300 hibernated at the end
20608 hibernations, 19763 wakes (16965 from a file, the rest from a blob still on its way to the disk), 267 skipped (not at rest)
store: 20608 files written, 3300 in /tmp/chat-rooms-NkQc2o; 1994 digest emails
every room and every user has exactly what was sent
```

A message to a room of about twenty members wakes most of them, since
only one actor in six is in memory: the demo is a stress of the store,
not of the host.

## Test it

```sh
mise run examples chat-rooms     # under node and bun
node examples/chat-rooms/test.mjs
bun test ./examples/chat-rooms/test.mjs
```

The store takes hooks, so a test can hold a file read or a write until it
says so, or make a write fail; a test waits for the host and for the
store's reads and writes with `chat.settle()`, since `host.idle()` does
not wait for the wake handler's promise. A load of 220 actors with 30 in
memory checks the bound with `hostStats` after every eviction, and
the last case runs a small `main.mjs` evening on the real clock. All of it
takes about two seconds.
