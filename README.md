# tinyactors for Node.js

xstate-style machines and actors running on the tinyactors SCXML runtime.
The addon is written against the **Node-API C API** (`node_api.h`, no C++
wrapper) and links the tinyactors static libraries. The JavaScript API lives
in `bindings/shared/core.mjs` and is shared with the
[web binding](../web) (same `index.d.ts`), so the same code runs in Node.js and
in browsers. Node.js ≥ 22.12 (`require()` of the ES-module core).

## Install

```sh
npm install @tinyactors/node     # or: pnpm add, bun add
```

The package carries no compiler step: each supported platform has a
prebuilt addon in its own package (`@tinyactors/node-darwin-arm64`,
`-darwin-x64`, `-linux-x64`, `-linux-arm64`), an optional dependency that
npm, pnpm and Bun install only where it matches. The Linux addon serves
glibc and musl alike. Development builds are under the `next` dist-tag
(`npm install @tinyactors/node@next`).

In this repository, `mise run node:build` (in `tinyactors-core`) builds the
addon into `bindings/node/build/tinyactors.node`, which `index.js` loads
before any installed platform package. Packaging and releasing are in
[distribution](../../docs/distribution.md).

```js
const { createMachine, createActor, assign } = require('@tinyactors/node');

const toggle = createMachine({
  id: 'toggle',
  initial: 'inactive',
  context: { count: 0 },
  states: {
    inactive: { on: { TOGGLE: { target: 'active', actions: assign({ count: ({ context }) => context.count + 1 }) } } },
    active: { on: { TOGGLE: 'inactive' }, after: { 1000: 'inactive' } },
  },
});

const actor = createActor(toggle).start();
actor.subscribe((s) => console.log(s.value, s.context));
actor.send({ type: 'TOGGLE' });
```

## How it works

- `createMachine(config)` compiles the config to SCXML that reads like
  hand-written SCXML (`machine.toSCXML()`): named guards and actions appear by
  name (`cond="isAdult"`, `<script>track({"tag":"t"})</script>`), inline
  functions by their source, literals as JSON, `stateIn` as `In('a.b')`,
  combinators as `and(isAdult, not(above({"min":30})))`, assigns as
  `<assign location="count" expr="..."/>`, raises as `<raise event="X"/>`.
- The context is SCXML data: one `<data id="prop">` per property, for object
  literals and for factories `({ input }) => ({ a: input.a, b: [] })` alike
  (each `<data>` shows its property's source; the factory still runs once per
  actor). `assign()` becomes one `<assign location="prop">` per property; the
  computed properties are evaluated together against the previous context
  (xstate semantics), constants follow. Sequential steps read best as
  sequential assigns: `[assign({ pos: ... }), assign({ status: ({ context })
  => status(context.pos) })]`. Only a function the compiler cannot split (a
  block body, spreads, computed keys) falls back to a single
  `<data id="context">` / `<assign location="context">`.
- Each machine keeps a registry from that text to the JavaScript function
  implementing it. When a chart is attached to a native system, the datamodel
  resolves every expression of the chart once and stores the functions in a
  table indexed by the image's expression ids — evaluation is an indexed
  call, and the index never appears in the chart. Two different functions
  with the same source text are told apart by a trailing comment
  (`... /* 2 */`).
- **One native system per `System`, not per actor.** Actors started with
  `createActor()` live in the process-wide default system (or the one given
  as `createActor(machine, { system: createSystem() })`). The machines known
  when the system starts are linked into one image; a machine defined later
  is linked into an additional *segment* (as is each reloaded version). All
  segments share one base URI, `tinyactors://<system id>/`, and each creates
  sessions from its own range; a send to a session in another segment goes
  through the runtime's remote I/O processor (`TA_IO_PROCESSOR_SCXML_SHARED`), so
  `sendTo(actor, ...)` and
  `sendTo(({ system }) => system.get('id'), ...)` work across them. The
  native region grows by relocation (thousands of actors per system).
- Context, events and payloads are napi references owned by the system's
  datamodel host; they live as long as the system (payloads are refcounted
  and recycled).
- Events are processed synchronously on `send()`; long-running work yields
  cooperatively (`setImmediate`) so even a runaway eventless loop cannot block
  the event loop or starve other actors. Delayed events use the host clock via
  `setTimeout`. Calls made from inside actions (e.g. `actor.send()`) are
  queued until the current run returns. A system runs on the JavaScript
  thread; for more cores, run systems in worker threads and link them —
  [docs/concurrency.md](../../docs/concurrency.md) explains what runs when.

## Hibernation

Idle actors can be unloaded and brought back on demand. The system never does
I/O itself: you hand it a store.

```js
const system = createSystem({
  hibernation: {
    store: { get: (k) => db.get(k), set: (k, blob) => db.put(k, blob), delete: (k) => db.del(k) }, // may be async
    sweepMs: 30_000, // unload actors idle for a whole sweep period (0 = only system.hibernate())
  },
});
system.hibernate(actor); // or system.hibernate() for every idle actor
actor.hibernated;        // true; getSnapshot() is answered from cache
actor.send({ type: 'X' }); // the event waits, the blob is loaded, the actor carries on
```

Context, events and input travel through a tagged-JSON codec (`encodeValue` /
`decodeValue`). It keeps `undefined`, `Date`, `Map`, `Set`, `BigInt`, shared
references and cycles, and encodes actors as their addresses. Actors whose
context holds functions stay resident (the sweep skips them;
`system.hibernate(actor)` throws, naming what cannot be stored). Pending
delayed events wake the actor when they fire. `createMemoryStore()` is a
store in memory.

### Moving an actor to another system

`system.export(actor)` takes an actor out of its system as bytes — states,
context or variables, delayed events with their data, the actors it invoked,
and what it runs. `system.adopt(bytes)` takes it in anywhere: another system
in this process, another process, Node or web. It keeps its session (its
address under the new system's id), and its delayed events keep the time
they had left.

```js
const bytes = here.export(actor);   // it stops here (no done event)
// ... another process ...
const actor = there.adopt(bytes);   // machines are found as for restore
```

## Hot reload and live migration

```js
system.reload(counterV2); // CGI style: returns 2; new actors run it, running ones keep theirs
const { done } = system.migrate(); // move running actors (a job in time slices)
const { migrated, failed, pending } = await done; // pending: left behind (timeout)
system.migrate(counter, { wake: false, timeoutMs: 5000 }); // options
// in counterV2: on: { 'error.platform.upgrade': { actions: assign({ total: ({ event }) => event.data.count }) } }
```

`reload(machine)` makes `machine` the current version of the machines with its
id (compiled right away, so errors throw there). A version whose actors are
all gone is freed. Addresses stay valid: all actors of a system share one base
URI and sessions are found wherever they live. `migrate(target?)` moves actors
of older versions (one actor, a machine's actors, or all) at a stable point:
states are matched by id, the context is kept (properties the new machine does
not declare are dropped, new ones initialized), timers keep running, and the
actor receives `{ type: 'error.platform.upgrade', data: previousContext }`.
Migration is a job advanced in time slices of a few ms, walking the actors
lazily, so the event loop stays responsive with any number of actors (100,000
actors: the call takes ~5 ms, each slice ~5 ms). Busy actors move at their next
stable point. Hibernated actors are loaded from the store first (`wake`, on by
default when the system has a hibernation store), or move once they wake.
`timeoutMs` ends the job and reports who was left behind. `done` resolves once
the moved actors have processed their upgrade event. There is deliberately no
"force": an actor mid-macrostep or with a pending request cannot move without
changing SCXML semantics, and an actor with running invocations waits until
they finish (its invoked sessions run charts of its old version, which are not
translated). Sends to an address
nobody has raise `error.communication` in the sender.

## SCXML documents

`fromSCXML(xml, { documents })` runs a W3C SCXML document as actor logic, in
the same system as your machines (they message each other directly). The
`ecmascript` datamodel (SCXML Appendix B.2) runs in JavaScript with the same
semantics as the C datamodel; `null` works too. The W3C IRP suite passes
through this binding (158/158 mandatory; `mise run w3c:js`).

```js
const { fromSCXML, createActor } = require('@tinyactors/node');

const counter = fromSCXML(`
  <scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="idle">
    <datamodel><data id="count" expr="0"/></datamodel>
    <state id="idle">
      <transition event="inc"><assign location="count" expr="count + (_event.data.by || 1)"/></transition>
      <transition event="done" target="end"/>
    </state>
    <final id="end"><donedata><param name="total" expr="count"/></donedata></final>
  </scxml>`);

const a = createActor(counter, { input: { count: 10 } }).start(); // input overrides <data>
a.send({ type: 'inc', by: 2 });          // _event.name = 'inc', _event.data = { by: 2 }
a.getSnapshot().context;                 // { count: 12 } — the datamodel's variables
```

- Events: `type` becomes `_event.name`; `data` (or, without it, the event's
  other properties) becomes `_event.data`.
- The snapshot's `value` is the active states (by id) as a nested state value;
  `context` the datamodel variables; `output` the `<donedata>`.
- `documents` maps names to further documents: `<invoke src="child.scxml">`
  children and anything a `src="..."` names (`<data src>`).
- Expressions are compiled with `new Function` (a browser CSP must allow
  `'unsafe-eval'` for SCXML documents; machines do not need it).
- `<script>`s that declare top-level names (`var`, `let`, `const`,
  `function`, `class` — as the JS engine sees them: names in blocks or nested
  functions do not count) make those names the session's, as in the C
  datamodel. Such actors hibernate, snapshot, export and migrate: variables
  and `let`/`const` bindings keep their values (`const` stays constant),
  top-level function declarations are re-created. Anything else that cannot
  be stored is refused naming the variable and line, e.g. `variable 'helper'
  cannot be stored: it holds a function (line 12); only top-level function
  declarations are stored ...`.

## System images

A `<system>` manifest names charts and the actors to start; compiled, it is
one immutable image you can ship as bytes (also produced by the C `tac`
compiler) and boot anywhere — Node, a browser, a C host.

```js
const { compileSystem, loadImage, createSystem } = require('@tinyactors/node');

const image = compileSystem(`
  <system>
    <chart name="pinger" src="ping.scxml"/>
    <actor name="server" chart="pinger"/>
  </system>`, { files: { 'ping.scxml': pingXML } });

fs.writeFileSync('app.tai', image.bytes);
const { server } = createSystem().boot(loadImage(fs.readFileSync('app.tai')));
createActor(image.chart('pinger')).start(); // more actors of an image's chart
```

## Snapshots and deterministic time

`system.snapshot()` returns the whole system as bytes: every actor's
configuration, context or datamodel variables, queued events and pending
timers, plus what it runs (the SCXML of each machine, documents, images).
`createSystem({ restore: bytes })` brings it back — same system id, so
addresses stay valid; find actors with `system.get(systemID)`. Machines are
matched by id and the SCXML they compile to (ones defined in the process are
found automatically; pass more in `machines`). Contexts must be encodable (no
functions); hibernated actors stay in the hibernation store, so restore with
the same store.

```js
const bytes = system.snapshot();           // e.g. on shutdown
// ... a new process ...
const system = createSystem({ restore: bytes, hibernation: { store } });
system.get('lobby').send({ type: 'PING' });
```

`createSystem({ clock })` makes the system run on your clock instead of wall
time: it arms no timers itself; advance the clock and call
`system.flush()`, which runs everything that is due until the system is
idle — for deterministic tests, simulations and replays.

```js
let now = 0;
const system = createSystem({ clock: () => now });
createActor(machineWithAfter1000, { system }).start();
now += 1000;
system.flush();  // the `after: 1000` transition has been taken
```

## Links: actors across systems

`createLink(system, { url })` connects to another system (`serveLinks` on the
other side). The link is itself an actor: its snapshot value is the
connection status (`connecting`, `open`, `reconnecting`, `closed`); its context
holds `rtt`, `attempts`, `queued` and `peer`. Subscribe to it to show the status.

```js
// server
const system = createSystem({ id: 'chess' });
createActor(lobby, { system, systemID: 'lobby' }).start();
// browsers are untrusted peers: they may send only what is exported
serveLinks(system, { server: httpServer, path: '/link', exports: { lobby: 'JOIN LEAVE' } }); // or { port }, { tcp }, or { accept }

// client (Node or the web binding); name: the server's system id
const link = createLink(createSystem(), { url: 'ws://localhost:8080/link', name: 'chess' });
createActor(player, { input: { lobby: link.get('lobby') } }); // an ActorRef to the remote lobby
// in the player: sendTo(({ context }) => context.lobby, ({ self }) => ({ type: 'JOIN', player: self }))
// in the lobby:  sendTo(({ event }) => event.player, { type: 'WELCOME' })    — the reply crosses back
```

Every actor has an `address` (`tinyactors://<system id>/#_scxml_<session>`)
and `self` in action arguments. An actor reference sent in an event arrives as
an `ActorRef` (with `send()`) that works as a `sendTo` target. `system.ref(address)`
creates one. `system.stop()` stops all actors, closes the system's links and
frees its native memory.

Routing is done by the native router (`ta_host`, docs/protocol.md), not in
JS: every link connection is one router *peer*, and the binding only moves
frames (link protocol v1: `hello`, `ev`, `err`, `ping`/`pong`). What that
gives you:

- **Policy.** A served peer is untrusted unless `trusted: true` or
  `trust(hello)` says so: it may send only to the `exports` (`['lobby']`,
  `{ lobby: 'JOIN LEAVE' }`, `'*'` for every name and session). Everything
  else, and every forged `origin`, is refused.
- **No silent drops.** A refused or undeliverable send — unknown name, ended
  session, no route, denied, queue full, expired — raises
  `error.communication` (with the `sendid`) in the sending actor, across any
  number of hops.
- **Queues and resumption.** While a link is down the router queues for it
  (`maxQueue`, default 1000; `queueTTLMs` to expire them; `maxQueue: 0` to fail
  fast). On the server, a peer that reconnects with the same system id within
  `resumeMs` (default 30 s, on the system's clock: with a `clock` option,
  simulated time) gets what was queued for it, in order.
- **Relaying.** With `announce: true` a system tells its peers which other
  systems it reaches, and forwards their envelopes (for trusted peers): a
  browser can reach a backend behind its server.
- **Values.** Between two JS systems values keep their types (`js` profile:
  `Date`, `Map`, `Set`, `BigInt`, cycles, actor refs). With a peer in another
  language they travel as neutral values (JSON plus `{"$ref"}` and
  `{"$bytes"}`; `encodeWire` / `decodeWire`); `profile: 'neutral'` forces that.
- **Status.** `link.status()` and `server.status(systemID)` report the route:
  state, queued, lag, rtt, sent/received/errors/duplicates.
- `system.deliver(envelope)` hands an envelope to the router from host code
  (any transport you write yourself starts there).

### Byte streams: TCP, stdio, serial

On byte streams the link protocol travels in length-prefixed frames (a 4-byte
big-endian length, then UTF-8 JSON; docs/protocol.md, "Framing"):

```js
// TCP
const served = serveLinks(server, { tcp: { port: 7000 }, exports: ['echo'] });   // served.port
const link = createLink(client, { tcp: { host: 'db-1', port: 7000 }, name: 'srv' });

// any duplex stream: `transport` and `accept` take byte streams as well as WebSocket-like objects
const child = spawn('node', ['worker.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
serveLinks(system, { trusted: true, accept: (on) => on({ readable: child.stdout, writable: child.stdin }) });
// in worker.js (stdout carries the link: log with createSystem({ logger }) to stderr)
createLink(system, { name: 'parent', transport: () => ({ readable: process.stdin, writable: process.stdout }) });
```

A byte stream is a Node-style duplex (a `net.Socket`) or a `{ readable,
writable }` pair. `maxFrame` (default 1 MiB, both functions) is the largest
frame this side accepts and is announced in its hello. Frames above it are
skipped unread. An envelope that does not fit the other side's `maxFrame` is
not sent: its sender gets `error.communication`. `encodeFrame(text)` and
`new FrameDecoder({ maxFrame }).push(chunk)` (frames out; a refused one as
`{ reason: 'malformed', length }`) frame streams of your own. C hosts use
`ta_frame_header` / `ta_frame_read` (`include/tinyactors/frame.h`).

### Store links: actors in PostgreSQL

`createStoreLink(system, { query, listen })` connects the system to a
database of actors (the PostgreSQL extension, bindings/postgres) through any
PostgreSQL client. The database becomes a peer: actors here and there send to
each other by address, replies included, and the database can reach the
browsers on your links (the link tells it which ones).

```js
const pool = new pg.Pool();
const client = await pool.connect();             // a connection for LISTEN
const store = createStoreLink(system, {
  query: (sql, params) => pool.query(sql, params).then((r) => r.rows),
  listen: async (channel, fn) => { client.on('notification', (n) => n.channel === channel && fn(n.payload));
                                   await client.query(`LISTEN ${channel}`); return () => client.query(`UNLISTEN ${channel}`); },
});
await store.ready;                               // store.id: the database's system id
sendTo(system.ref(`tinyactors://${store.id}/@ledger`), { type: 'add', amount: 5 });
```

Envelopes go in with `tinyactors.deliver` (in order, retried until taken;
the database drops repeats), come out of the outbox with `claim_for` on
NOTIFY (and every `pollMs`), and errors travel both ways as
`error.communication`. Values travel as neutral values. `store.flush()`
waits until everything was handed over; `store.status()` is the route's
status.

## Supported (xstate v5 subset)

`createMachine`, `setup({ actions, guards, delays, actors })`, `createActor`
(`start`, `stop`, `send`, `getSnapshot`, `subscribe`, `address`, `hibernated`,
options `input`, `systemID`, `system`, `logger`),
`createSystem({ id, hibernation, clock, logger, restore, machines })`,
`system.get()`, `system.ref()`, `system.sendMany()`, `system.hibernate()`,
`system.reload()`, `system.migrate()`, `system.snapshot()`, `system.boot()`,
`system.export()`, `system.adopt()`,
`system.flush()`, `system.stop()`, `fromSCXML`, `compileSystem`, `loadImage`,
`machine.provide()`, `createLink`, `serveLinks`, `encodeFrame`, `FrameDecoder`, `createMemoryStore`;
states (`initial`, nested, `parallel`, `final` with `output`, `history`),
`on` (including `'*'`), `always`, `after`, `entry`/`exit`, `invoke` of child
machines (`input`, `onDone`), `tags`; actions: functions, named actions with
`params`, `assign`, `raise` (optionally delayed), `sendTo`, `sendParent`,
`log`, `cancel`; guards: functions, named guards with `params`, `and`, `or`,
`not`, `stateIn`. Snapshots: `value`, `context`, `status`, `output`,
`error`, `matches()`, `hasTag()`.

Not supported: promise/callback/observable actors, `spawn`, `emit`,
`enqueueActions`, `onError`, `can()`, inspection API.

Semantics follow SCXML where they differ from xstate: an exception in user
code raises `error.execution` (the actor keeps running; see
`snapshot.error`), and external events wait while a macrostep is still
running.

## Build & test

```sh
mise run node:test     # npm ci, build the addon, node --test, bun test, tsc
```
