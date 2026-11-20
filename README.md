# @tinyactors/node

Run statecharts as actors in Node.js and Bun.

Much of a program's logic is a lifecycle: an order is open, then paying,
then paid or timed out; a connection is dialing, up, or backing off. Written
as flags and callbacks, a lifecycle spreads over a codebase, and the states
it may be in are nowhere written down. A **statechart** writes them down:
the states, the events that move between them, and what happens on the
way. This package runs statecharts written in
[SCXML](https://www.w3.org/TR/scxml/), the W3C's XML language for them,
with JavaScript for their data and expressions.

Each running statechart is an **actor**: it has its own data and a queue
of events, and it talks to the world only by sending and receiving events.
A **host** runs many of them, from a handful to millions, on your
program's event loop. The host does no I/O of its own. When an actor sends
something out (a payment request, a log line, an email), your handler gets
it, does the I/O, and answers with an event. So the logic stays in the
charts, testable on a simulated clock, and the I/O stays in your code.

Use it when your program keeps many long-lived things that each have a
lifecycle (orders, sessions, devices, workflows), when you want timeouts
and retries written as states rather than timers, or when the same logic
must run in tests without the network.

This README describes the package as it is built from `main`. The last
version on npm, 0.2.0, is an earlier binding with another API.

## Install

```sh
npm install @tinyactors/node     # or: pnpm add, bun add
```

It runs on Node.js 22.3 or later and on Bun (tested on 1.4), on macOS
(arm64, x64) and Linux (x64, arm64; glibc or musl). Nothing compiles on
install: the addon is prebuilt, one per platform, in
`@tinyactors/node-darwin-arm64`, `-darwin-x64`, `-linux-x64` and
`-linux-arm64`, which the main package lists as optional dependencies, so
the package manager installs only the one that matches. A Linux addon
links no C library, so one file serves glibc and musl. The macOS addons
are cross-built from Linux and checked by their symbols; no Mac has run
them yet. An install that left out optional dependencies
(`--no-optional`, `--omit=optional`) fails at import, naming the package
it needs.

For a browser, or a platform with no addon (Windows), the same API is
`@tinyactors/wasm`, core compiled to WebAssembly: see
[In the browser](docs/guide/browser.md), which says what differs.

Development builds of `main` are published under the `next` dist-tag
(`npm install @tinyactors/node@next`), versioned
`<next minor>-dev.<date>.<n>.g<commit>`. Releases, their tarballs and
`SHA256SUMS` are on
[tinyactors-dev/tinyactors-napi](https://github.com/tinyactors-dev/tinyactors-napi/releases).

## A first program

An order collects items, then asks a payment service to charge the total,
and is paid when the service answers. Save this as `order.mjs` and run it
with `node order.mjs` or `bun order.mjs`:

```js
import { compileCharts, Host } from '@tinyactors/node';

// 1. The chart: the order's states and what moves between them.
const chart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="order" initial="open">
  <datamodel>
    <data id="total" expr="0"/>
  </datamodel>
  <state id="open">
    <transition event="add">
      <assign location="total" expr="total + _event.data.price"/>
    </transition>
    <transition event="checkout" target="paying"/>
  </state>
  <state id="paying">
    <onentry>
      <send type="urn:payments" event="charge" target="card">
        <param name="amount" expr="total"/>
      </send>
    </onentry>
    <transition event="charged" target="paid"/>
  </state>
  <final id="paid">
    <onentry><log label="order" expr="'paid ' + total"/></onentry>
  </final>
</scxml>`;

// 2. Compile it into an image the host can load.
const compiled = compileCharts([{ name: 'order.scxml', text: chart }]);

// 3. A host of the image, with a processor for what the chart sends to urn:payments.
const host = new Host(compiled, {
  system: 'shop',
  ioProcessors: {
    'urn:payments': {
      receive(send) {
        console.log(`charging ${send.data.amount} to ${send.target}`);
        send.answer('charged');
      },
    },
  },
  log: (entry) => console.log(`${entry.label}: ${entry.text}`),
});
compiled.close();

// 4. An actor of the chart, and three events for it.
const order = host.spawn('order');
order.send('add', { price: 4 });
order.send('add', { price: 7 });
order.send('checkout');

// 5. Let it run, then stop.
await host.idle();
host.close();
```

It prints:

```output
charging 11 to card
order: paid 11
```

What happened, step by step:

1. **The chart** has three states. In `open`, each `add` event adds its
   price to the variable `total`; `checkout` moves to `paying`. Entering
   `paying` sends a `charge` event to `urn:payments`, which is not
   another actor but something outside the host. The answer `charged`
   moves to `paid`, a final state, which logs the total.
2. **`compileCharts`** checks the chart and compiles it. A mistake in the
   XML, an unknown state id or a malformed attribute throws a
   `CompileError` here, before anything runs. JavaScript that does not
   parse is a warning in `compiled.diagnostics` (SCXML makes it an
   `error.execution` when it runs), and an error with
   `compileCharts(sources, { warningsAsErrors: true })`.
3. **`new Host(charts, options)`** makes a host and adds the compiled
   images to it, so the compile result can be closed at once. `system`
   names this system; `ioProcessors` are the I/O processors its charts
   may send to, each an object whose `receive(send)` gets each send to
   that type: its data, its target, and `answer()`, which sends an event
   back to the actor that sent it.
4. **`host.spawn('order')`** starts an actor of the chart named `order`
   and returns it, an `Actor`. `order.send` puts an event in its queue.
5. **`await host.idle()`** waits until the host has nothing left to do.
   The actor runs on the event loop on its own; `idle()` only watches.
   `host.close()` frees the host.

## Concepts

Read these in order the first time. Each builds on the one before.

### Charts

A chart is an SCXML document. Its parts, from the outside in:

- **`<scxml>`** names the chart (`name`), its first state (`initial`) and
  its language for data and expressions. Write `datamodel="ecmascript"`,
  JavaScript, on every chart. A chart without the attribute gets SCXML's
  null datamodel, which evaluates no expression and says nothing about it:
  its `<log>`s and `<data>` do nothing. Another value is refused when the
  image is added (`host.addImage` throws `TA_ERROR_INVALID`).
- **`<state id>`** is a state the actor can be in. States nest (a
  compound state has children, one of them active), and `<parallel>`
  holds regions that are all active at once. **`<final>`** ends the
  actor.
- **`<transition event cond target>`** leaves the state when an event
  whose name matches `event` arrives and the expression `cond` is true.
  Without `target` it runs its actions and stays.
- **Actions** run on a transition and in `<onentry>` and `<onexit>`:
  `<assign>`, `<script>`, `<log>`, `<send>`, `<raise>`, `<cancel>`,
  `<if>` and `<foreach>`.
- **`<datamodel>`** declares the actor's variables, one `<data id expr>`
  each. Every expression in the chart sees them as plain variables, and
  sees the event being handled as `_event` (`_event.name`, `_event.data`).

An event's name is matched by prefix, word by word: `event="error"` and
`event="error.*"` match `error.execution` and `error.communication`;
`event="a b"` matches either name; `event="*"` matches any event. An
event no transition matches is dropped.

The prefix rule also matches an answer whose name starts with the
request's: `event="join"` takes `join.refused` too. A chart that asks a
peer again on `join`, and a peer that answers with `join.refused`, then
answer each other for ever, and `await host.idle()` never resolves. Name
an answer so that it does not extend the request (`refused.join`), and
see [Inspecting a host](docs/guide/inspection.md#two-actors-that-never-rest)
for how such a loop shows in the host's counters.

[Writing charts](docs/guide/charts.md) covers the JavaScript a chart may
hold, `<script>`, XML data, several charts in one image (and
`compileDir`, which compiles a directory of them), and `<invoke>`.

### Starting an actor with data

`spawn`'s `params` set the new actor's variables: each key that names a
top-level `<data>` replaces that variable's initial value, keys that name
no `<data>` are left out, and the variables you do not name keep the
chart's `expr`.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'greeter.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="greeter" initial="ready">
  <datamodel>
    <data id="greeting" expr="'Hello'"/>
    <data id="who" expr="'world'"/>
  </datamodel>
  <state id="ready">
    <onentry><log expr="greeting + ', ' + who + '!'"/></onentry>
  </state>
</scxml>` }]);

const host = new Host(compiled, { system: 'demo', log: (entry) => console.log(entry.text) });
compiled.close();

host.spawn('greeter');
host.spawn('greeter', { params: { who: 'Ada' } });
host.spawn('greeter', { params: { greeting: 'Hi', who: 'Bob', mood: 'ignored' } });
await host.idle();
host.close();
```

```output
Hello, world!
Hello, Ada!
Hi, Bob!
```

### The host and its event loop

A host holds actors and runs them on your program's event loop. There is
no `run()` to call. An input (`spawn`, `send`, `terminate`) is taken at
once (the event is in the actor's queue when `send` returns, or the call
throws), but nothing runs yet: it schedules a turn with `setImmediate`,
and in its turns the host runs
every actor that has an event, calls your handlers with what the actors
sent out, and runs again until nothing is left. A turn does a bounded
amount of work and then yields, so a busy host never starves your I/O.

`await host.idle()` resolves at the next turn that finds nothing to do
while no promise one of your handlers returned is pending (a promise a
handler starts and does not return is not waited for). It is for tests, scripts and an orderly shutdown; a server never needs to
call it. A handler may call the host (send an event, spawn an actor): the
input applies at once, and the actors run in the same or a later turn.

A host also keeps time. A delayed `<send>` or a timeout is a deadline,
and an idle host arms one `setTimeout` for its next one. That timer keeps
the process alive while the host is open, as any `setTimeout` does, and
it is the only thing the host keeps the process alive with: an open host
with no deadline lets the process exit, even with actors that wait for an
answer (below, "Before you use it"). `host.close()` clears the timer,
frees the host, and drops every handler that was still waiting.

### Actors, sessions and addresses

`spawn` returns an **`Actor`**: the host it lives in and its **session**,
`actor.id`, a `bigint` unique in its host. The actor takes inputs itself
(`actor.send(event, data)`, `actor.terminate()`), answers the typed
methods as promises (`await actor.state()`, `actor.context()`,
`actor.get()`), and `actor.done` settles with its donedata when it ends.
`host.actor(which)` gives the `Actor` of a session (a `bigint`, or a
number that is a safe integer, since that is what a database or JSON
gives back), of a name or of an address, and throws `StaleError` for one
that is not live; two `Actor`s of one session are `equals`, not `===`.
The host's own inputs take an `Actor` or a session alike:
`host.send(actor, event, data)`, `host.terminate(actor.id)`.

The views a handler gets hold the session as a `bigint` (`send.session`,
with `send.sender` its `Actor`; `console.log` prints `1n`, and
`JSON.stringify` refuses one: convert with `String()` or `Number()`
yourself), while the results of the typed methods
([Inspecting a host](docs/guide/inspection.md)) hold them as numbers. So
compare with `Number(actor.id) === listed`, never `===` across the two,
and `await host.actors()` gives the `Actor`s themselves.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'idle.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
    datamodel="ecmascript" name="idle"><state id="s"/></scxml>` }]);
const host = new Host(compiled, { system: 'demo' });
compiled.close();
const actor = host.spawn('idle', { name: 'first' });
const { sessions } = await host.actorList();
console.log(typeof actor.id, typeof sessions[0]);
console.log(sessions.includes(Number(actor.id)), host.actor(sessions[0]).equals(actor));
const byKey = new Map([[String(actor.id), 'kept under its text']]);
console.log(byKey.get(String(sessions[0])), host.actor('first').equals(actor));
console.log((await host.actors()).length, (await actor.state()).value);
host.close();
```

```output
bigint number
true true
kept under its text true
1 s
```

`sessions.includes(actor.id)` would be `false` (TypeScript refuses it),
and a `Map` keyed by the `bigint` misses the number: key it by
`String(actor.id)`, which is the same for both kinds.

An actor may also have a **name**, given at spawn, and
`host.actor(name)` finds it. An actor that reaches a `<final>`
state, or is terminated, ends: its session is refused from then on with
`TA_ERROR_STALE`, and its name finds nothing. The events still in its
queue when it ends are dropped, as SCXML ends a session at its top-level
`<final>`: an `actor.send` that returned before the end is never handled,
and nothing tells the application. A chart whose events stand for
requests your program holds (an HTTP response, a promise) tells your
program from its `<final>` first:
[I/O processors](docs/guide/io-processors.md#when-the-sender-ends) has the
pattern. `actor.done`, and the host's `onDone(actor, donedata)`, tell your
program when an actor started with `spawn` ends.

Actors find each other by **address**. Every system has its name, the
host's `system` option, and an actor's address is `tinyactors://<system>/#_scxml_<session>`, or
`tinyactors://<system>/@<name>` for a named one. A chart sends to
another actor with `<send target="tinyactors://shop/@pong" event="ping"/>`,
and the receiver answers to `_event.origin`. `actor.address` is an
actor's address, and `host.actor` takes one:

```js
import { compileCharts, Host } from '@tinyactors/node';

const pong = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="pong" initial="waiting">
  <state id="waiting">
    <transition event="ping">
      <log expr="'pong got ' + _event.name"/>
      <send event="pong" targetexpr="_event.origin"/>
    </transition>
  </state>
</scxml>`;
const ping = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="ping" initial="asking">
  <state id="asking">
    <onentry><send event="ping" target="tinyactors://demo/@pong"/></onentry>
    <transition event="pong" target="done"><log expr="'ping got ' + _event.name"/></transition>
  </state>
  <final id="done"/>
</scxml>`;

const compiled = compileCharts([{ name: 'ping.scxml', text: ping }, { name: 'pong.scxml', text: pong }]);
const host = new Host(compiled, { system: 'demo', log: (entry) => console.log(entry.text) });
compiled.close();

const pongActor = host.spawn('pong', { name: 'pong' });
const pingActor = host.spawn('ping');
await host.idle();

console.log(pongActor.address.text);
console.log(host.actor('pong').equals(pongActor), host.actor('tinyactors://demo/@pong').id);
pongActor.terminate();
await host.idle();
try {
  host.actor('pong');
} catch (error) {
  console.log(error.constructor.name, pingActor.id);
}
host.close();
```

```output
pong got ping
ping got pong
tinyactors://demo/#_scxml_1
true 1n
StaleError 2n
```

A send to an actor that is not there fails: the chart gets
`error.communication`, your program a `StaleError`. What to do instead
(keep the actor and let it hibernate, route the send through your code,
or handle the failure) is your application's choice, per kind of actor:
[When the actor is not there](docs/guide/missing-actors.md) shows all
three, and how to choose names that an address holds as they are.

### Effects and handlers

What an actor does toward the outside is an **effect**, and each kind has
a handler you give the host in its options:

| The chart does | Your handler | Guide |
|---|---|---|
| `<send type="urn:x">` to an I/O processor | `ioProcessors: { 'urn:x': { receive(send) { ... } } }` | [I/O processors](docs/guide/io-processors.md) |
| `<send>` to an actor of another system | `transport: (send) => ...` | [Other systems](docs/guide/other-systems.md) |
| `<invoke type="urn:y">` of a service you run | `services: { 'urn:y': (invocation) => service }` | [Invoked services](docs/guide/services.md) |
| `<log>` | `log: (entry) => ...` | this README |
| spans, logs and metrics as OpenTelemetry (OTLP) | `telemetry: (signal, data) => ...` | [Telemetry](docs/guide/telemetry.md) |
| reaches a top-level `<final>` | `onDone: (actor, donedata) => ...`, or `await actor.done` | this README |
| more actors than `resident` in memory | `store: { save, load, delete }` | [Hibernation](docs/guide/hibernation.md) |

A send to a type no I/O processor serves raises `error.execution` in the
chart. `<log>` lines without a `log` handler are dropped. Each view a
handler gets has its `host` (`send.host`, `entry.host`), so a handler
needs no closure over the host it serves.

**A handler's argument is a view, valid while the handler runs.** The
`send` an I/O processor gets reads each field from the host's memory when
you first read it. After the handler returns, the host moves on and the
view is stale: reading it then throws `TA_ERROR_STALE`. Copy out what you
keep (`const { data } = send`). A handler that returns a promise (an
`async` function) is the exception: the host fills its view with every
field before moving on, so it may `await` and answer later.

### Values

What crosses between your program and a chart (event data, spawn params,
results) is a value of one table: `undefined`, `null`, booleans, numbers,
`bigint`s up to 64 bits, strings, `Uint8Array`s, arrays and plain
objects. A function, a `Map`, a `Date` or a class's instance is refused
with `TA_ERROR_UNSUPPORTED`, and a value is copied when it crosses, so a
chart never holds your object, and what a chart hands you (`send.data`,
`invocation.data`) is made with your realm's constructors: its arrays are
`instanceof Array`, and `assert.deepStrictEqual` compares it with a
literal. `undefined` and `null` stay apart; a
whole number past 2^53 comes back as a `bigint`.
[docs/values.md](docs/values.md) has every row of the table and every
refusal, and "Wire format" (below) the table as bytes.

### Time and the SimulatedClock

Time in this API is milliseconds, with two exceptions that the host's
config and the trace methods inherit from core: `telemetry.flushInterval`
counts the host's clock ticks, and `traceWatch` takes `seconds`. In a
chart, `<send event="timeout" delay="30s"/>` sends an event to the actor
itself 30 seconds later, and `<cancel sendid>` takes it back. A delay is
written in seconds or milliseconds (`30s`, `1.5s`, `500ms`), and any
other form (`10`, `1m`) is a compile error. `delayexpr` computes one, and
must give such a string: `delayexpr="timeoutMs + 'ms'"`, not
`delayexpr="timeoutMs"`. A number, or a string without its unit, raises
`error.execution` with no `_event.data` (the delay is the host's check,
not code that threw, so there is no reason to give), and nothing is sent.
By default the host reads the runtime's
clock. A test gives it a `SimulatedClock` instead, which moves only when
you move it, so a test of a 30-second timeout takes no time:

```js
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'door.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="door" initial="open">
  <state id="open">
    <onentry><send event="close" delay="30s"/></onentry>
    <transition event="close" target="closed"/>
  </state>
  <final id="closed"><onentry><log expr="'closed'"/></onentry></final>
</scxml>` }]);

const clock = new SimulatedClock();
const host = new Host(compiled, { system: 'demo', clock, log: (entry) => console.log(entry.text, 'at', clock.now) });
compiled.close();

host.spawn('door');
await host.idle();
console.log('next deadline in', host.nextDeadline, 'ms');
clock.increment(29_999);
await host.idle();
clock.increment(1);
await host.idle();
host.close();
```

```output
next deadline in 30000 ms
closed at 30000
```

`host.now()` reads the host's clock in milliseconds (the simulated
clock's time, or the runtime's), the clock its deadlines and snapshots
use. `clock.increment(ms)` moves the clock and schedules a turn on every host
made with it; `await host.idle()` then sees what ran. One increment past
several deadlines does not replay each of them: what is due runs once, at
the new time, and a delay it starts counts from there. Step the clock one
deadline at a time to see each. An input runs at the host's next turn, so
one given just before an `increment` is handled at the new time: `await
host.idle()` between them when it should run first. A host on a
`SimulatedClock` arms no timer.

On the runtime's clock a delay counts from the step that armed it, which
runs a little after its timer fired (the timer's and the turn's latency).
So a chart that re-arms `<send event="tick" delay="20ms"/>` at each tick
falls behind by that latency every tick: 24 ms after 40 ticks alone, 136
ms beside a CPU-bound job, in the repository's job-scheduler example. A
chart cannot read the host's clock, so a job that must keep its cadence
is given its schedule as absolute times by your program, and asks your
program for the time (an I/O processor) before it arms each delay. [Testing your charts](docs/guide/testing.md)
has more.

### Errors

Errors surface in four places:

- **At compile time,** `compileCharts` throws a `CompileError` whose
  message is the first error as `file:line:column: error: message`, and
  whose `diagnostics` holds them all.
- **At a call,** the host throws a `TinyactorsError` for what it refuses
  at once, as the subclass of its status: `StaleError` for a session that
  ended or never was, `StateError` for a call the host cannot make now (a
  closed host), `InvalidError` for an argument it refuses (a chart it does
  not have, a config it does not take), `UnsupportedError` for a value it
  does not take. Catch the class you handle; `error.status` is core's name
  for the status (`'TA_ERROR_STALE'`, ...), and the message is for people.
  A typed method's error is the subclass of its code too. A refused config
  also has `error.path`, the key it is about (`system.maxActors`), and
  `error.reason`. Arguments of the
  wrong JavaScript type throw a `TypeError`.
- **In a chart,** an expression that throws, or an `<assign>` to a
  variable the chart does not declare, raises the event `error.execution`
  for that actor, and a send that cannot be delivered raises
  `error.communication`. These are events, not exceptions. A failed action
  also stops the rest of its block: the actions after it in the same
  `<onentry>`, `<onexit>` or transition do not run. The actor goes on,
  and a transition on `error` handles both; without one the error event
  is dropped like any event no transition matches. When the chart's code
  failed, `_event.data` says why: `{ reason, message }`, `reason`
  `'exception'` (code that threw; `message` is its text, as `String(e)`
  gives it, such as `'Error: boom'`), `'fuel'` (it ran past QuickJS's
  `maxOps`) or `'memory'` (past QuickJS's `memoryLimit`); a failure the
  host decides (an unknown `<send>` type) has no data. To learn which
  action failed, turn on [telemetry](docs/guide/telemetry.md), whose spans
  and log records mark the failed action.
- **In your handlers,** an error a handler throws is reported after its
  turn: to the host's `onHandlerError(error, effect)` when you give one
  (with the view the handler was given), else it rejects a waiting
  `host.idle()`, or, with none waiting, is thrown as an uncaught
  exception (below).

```js
import { compileCharts, CompileError, Host, TinyactorsError } from '@tinyactors/node';

try {
  compileCharts([{ name: 'bad.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" name="bad">
  <state id="s"><transition event="go" target="nowhere"/></state>
</scxml>` }]);
} catch (error) {
  if (!(error instanceof CompileError)) throw error;
  console.log(error.message);
}

const host = new Host([], { system: 'demo' });
try {
  host.spawn('missing');
} catch (error) {
  if (!(error instanceof TinyactorsError)) throw error;
  console.log(error.status, '-', error.message);
}
host.close();
```

```output
bad.scxml:2:17: error: unknown state id 'nowhere'
TA_ERROR_INVALID - the host has no chart of that name
```

## Before you use it

- **Chart code is trusted code.** On the native datamodel (the default)
  a chart's expressions and scripts run in `node:vm` contexts of your own
  engine, and a `vm` context is not a security boundary. Run charts you do
  not trust on quickjs, the sandbox: `new Host(charts, { system,
  datamodel: 'quickjs', quickjs: { maxOps, memoryLimit } })`
  ([the quickjs sandbox](docs/guide/quickjs.md)).
- **An open host with a pending deadline keeps the process alive, and
  only then** (a delayed `<send>`, a timeout, the telemetry flush): the host arms one
  timer at its next deadline, as `setTimeout` does, and `host.close()`
  clears it. Nothing else holds the event loop: an open host with no
  deadline lets the process exit, its actors still waiting, and so does an
  actor that waits for an answer from a handler whose promise has no I/O
  behind it. Give a chart that waits for an answer a timeout of its own,
  and keep the process alive with your server, socket or timer.
- **A handler's error ends the process by default.** An error thrown by
  a handler (an I/O processor's, the log handler, the result handler of
  a typed method, one of the host's queries in
  [Inspecting a host](docs/guide/inspection.md))
  goes to the host's `onHandlerError` when it has one, else rejects a
  waiting `host.idle()`; with none waiting it is thrown from the
  host's turn as an uncaught exception, and a handler's promise that
  rejects is an unhandled rejection, as is a typed method's promise
  (`await host.actorState(...)`) that rejects with no `catch`. Either
  ends a Node.js or Bun process unless the application handles
  `uncaughtException` and `unhandledRejection`. Only a turn's first error is reported; the others
  of that turn are lost.
- **`using host = new Host(...)` needs a runtime that parses `using`:**
  Bun 1.4 does, Node.js 22 does not. `Symbol.dispose` and
  `Symbol.asyncDispose` call `close()`, which works everywhere.
- **A script's top-level declarations are the session's or the
  chart's, never a context of their own.** On the native datamodel every
  session of a host is an object in the host's one `vm` context. A
  chart-level `<script>`'s `function`s are the chart's helpers, made once
  and seeing no session's variables by name (pass them what they read); a
  top-level `var` is a variable of the session; a top-level `let`,
  `const` or `class` is refused, the script's `error.execution`, and
  `compileCharts` warns of each at its script's line, naming the
  `<data id>` to declare instead
  ([Writing charts](docs/guide/charts.md#scripts)). So every session can
  be hibernated, migrated and snapshotted whatever its scripts declare.
- **The charts of a host share the builtins of its shared context.** On
  the native datamodel the charts run in one `vm` context per host, so a chart that changes a builtin (`Math.random = ...`,
  `Array.prototype.sum = ...`) changes it for the host's other charts
  there; its sessions' own variables stay apart. On quickjs the same holds,
  unless `quickjs: { realm: 'isolated' }` gives each session a context of
  its own ([the quickjs sandbox](docs/guide/quickjs.md#realms)).

## Operating a host

Everything above is the application's API: charts, a `Host` with its
processors, store and handlers, `Actor`s. A host also answers the people
who run it: how big it is, what it traces, which version of a chart its
actors run. These calls are for an operator's tools, a deploy script or
an admin endpoint; an application can do without them.

| Calls | What they do | Guide |
|---|---|---|
| `host.hostStats()`, `host.hostConfig()`, `host.actorList()`, `host.actorGet()`; the `config` option's sizes, `host.quickjsHeapBytes` | the host's counters, its effective config, its actors page by page; sizing a host up front | [Inspecting a host](docs/guide/inspection.md), [Capacity and memory](docs/guide/capacity.md) |
| the `telemetry` option, `host.metrics()`, `host.traceConfigure()`, `traceWatch()`, `traceUnwatch()`, `traceEnd()`, `traceSpansDecode()` | traces, logs and metrics as OpenTelemetry (OTLP), and what is traced | [Telemetry](docs/guide/telemetry.md) |
| `host.sweep()`, `host.hibernate()`, `host.wake()` | hibernation by a policy of your own, in place of `resident` | [Hibernation](docs/guide/hibernation.md#a-policy-of-your-own) |
| `host.addImage()`, `host.chart()`, `host.boot()`; `host.migrate()`, the `migrated` and `migrationDone` options | images and segments; moving running actors to a new version of their chart | [Migration](docs/guide/migration.md), [Writing charts](docs/guide/charts.md#a-system-that-starts-its-own-actors) |
| `host.snapshot()`, `Host.restore()` | the whole host as one blob, and a host restored from it | [Snapshots](docs/guide/snapshots.md) |

Each image the host is given makes a **segment**: the host's memory for
that image's actors, numbered from 0 in the order of `new Host`'s charts
(`host.addImage(image)` adds one later and returns its number). A host
runs many segments as one; you need the number for `boot` and see it in
the host's statistics. A new version of a chart is a new image, and
`host.chart(name)` is its current version. Adding the image is the
deploy: new actors start in the new version and running ones finish on
theirs ([Updating through
names](docs/guide/io-processors.md#updating-through-names)).

## Wire format

When values, events and addresses leave the process (into a database, a
socket, another system), they take the forms below. An application that
keeps to one host and its own store never handles them.

| Calls | What they do | Guide |
|---|---|---|
| `encode(value)`, `decode(bytes)` | a value as CBOR bytes, and back | [docs/values.md](docs/values.md) |
| `new Address(text)`, `Address.fromSession()`, `Address.fromName()`; `.system`, `.session`, `.name` | an address read into its parts, and made from them | [Other systems](docs/guide/other-systems.md#addresses) |
| the `transport` option, `send.message`, `host.send(message)`, `host.fail(target, sendid)`, `host.sendMany(messages)` | a send to another system, as a message your transport carries, and its delivery on the other side | [Other systems](docs/guide/other-systems.md) |
| `send.origin`, `send.answer(event, data, { origin, raw })`, `encodeHTTPPost()`, `parseHTTPRequest()` | SCXML's BasicHTTP: a reply location and the message as read, and the form posts its events travel as | [Other systems](docs/guide/other-systems.md#scxmls-basichttp) |
| `decodeTraces(bytes)` | the spans of a telemetry export, read without a host | [Telemetry](docs/guide/telemetry.md) |

`encode(value)` and `decode(bytes)` give the value table as CBOR bytes,
the form a value takes when you store or send it:

```js
import { encode, decode } from '@tinyactors/node';

const bytes = encode({ sku: 'tea', qty: 2, big: 2n ** 60n, gone: undefined });
const value = decode(bytes);
console.log(bytes.length, 'bytes');
console.log(value.sku, value.qty, value.big, 'gone' in value, value.gone);
```

```output
33 bytes
tea 2 1152921504606846976n true undefined
```

`encode` also writes an `Address` as CBOR's tag 32, and `decode` reads one back as an
`Address`: that is how a transport's message keeps its addresses
([Other systems](docs/guide/other-systems.md)).


## Guides

One per feature, each with complete examples that run as written. They
are in the package too, under `docs/guide/` in
`node_modules/@tinyactors/node`, so these links work after an install.

Writing an application:

- [Writing charts](docs/guide/charts.md): JavaScript in charts, scripts,
  XML data, several charts, `<invoke>` of a chart, systems and `boot`.
- [I/O processors](docs/guide/io-processors.md): your code as a chart's
  output: answering, failing, answering later, spawning from a chart.
- [When the actor is not there](docs/guide/missing-actors.md): a send to
  an actor that is hibernated, never was, or ended, the three ways to
  handle it, and names that need no encoding.
- [Invoked services](docs/guide/services.md): long-running things a chart
  starts and stops, such as a connection or a subprocess.
- [Hibernation](docs/guide/hibernation.md): millions of actors, most of
  them in your store, with `store` and `resident`.
- [Testing your charts](docs/guide/testing.md): a simulated clock,
  `idle()`, and asserting on an actor's state.
- [The quickjs sandbox](docs/guide/quickjs.md): charts you do not trust.
- [In the browser](docs/guide/browser.md): `@tinyactors/wasm`, the same
  API in a page or a Worker: loading, the CSP, IndexedDB as the store,
  liveness, memory, and what differs.

Operating a host:

- [Inspecting a host](docs/guide/inspection.md): an actor's state and
  variables, listing actors, the host's counters.
- [Capacity and memory](docs/guide/capacity.md): sizing a host, how it
  grows, and what an actor costs.
- [Telemetry](docs/guide/telemetry.md): traces, logs and metrics as
  OpenTelemetry, and trace context across your services.
- [Hibernation](docs/guide/hibernation.md#a-policy-of-your-own):
  sweeping, hibernating and waking by a policy of your own.
- [Migration](docs/guide/migration.md): moving running actors to a new
  version of their chart.
- [Snapshots](docs/guide/snapshots.md): the whole host as one blob, and a
  host restored from it.

Wire format:

- [Other systems](docs/guide/other-systems.md): actors of two hosts
  talking through your transport, addresses, and SCXML's BasicHTTP.
- [docs/values.md](docs/values.md): every value as it crosses, and as
  CBOR.

The example applications in the repository (`examples/`) put these
together; the chat (`examples/chat-rooms/`) is the one the application
API was designed against.

The reference is the doc comment of each export in
[index.d.ts](index.d.ts), which an editor shows on hover. In TypeScript
the types need the `es2022` lib and a `URL` (the `dom` lib or
@types/node); they declare `Symbol.dispose` and `Disposable` themselves,
so no `esnext` lib is needed.
