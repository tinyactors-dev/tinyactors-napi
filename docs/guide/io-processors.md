# I/O processors

An actor cannot reach the network, a file or a database itself: the host
does no I/O. When a chart needs something from outside, it sends an event
to an **I/O processor**. Your processor does the work
and, if there is an answer, sends it back as an event. The chart
stays a description of what happens; your code decides how.

## Declaring a processor

The host's `ioProcessors` option names the processors its charts may send
to, each under its type (any URI you choose): an object whose
`receive(send)` the host calls for each send to that type, and an
optional `location`, the address the chart reads in
`_ioprocessors[type].location`. A class instance serves as well as a
literal; `receive` is called as its method, so `this` is the processor:

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'quote.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="quote" initial="asking">
  <state id="asking">
    <onentry>
      <send type="urn:example:prices" event="lookup" target="tea" id="ask-1">
        <param name="currency" expr="'EUR'"/>
      </send>
    </onentry>
    <transition event="price" target="known">
      <log expr="'tea costs ' + _event.data.amount + ' ' + _event.data.currency + ' (answer to ' + _event.sendid + ')'"/>
    </transition>
  </state>
  <final id="known"/>
</scxml>` }]);

const prices = { tea: 4 };
const host = new Host(compiled, {
  system: 'shop',
  ioProcessors: {
    'urn:example:prices': {
      receive(send) {
        console.log(`${send.type}: ${send.event} ${send.target} for session ${send.session}`);
        send.answer('price', { amount: prices[send.target], currency: send.data.currency });
      },
    },
  },
  log: (entry) => console.log(entry.text),
});
compiled.close();
host.spawn('quote');
await host.idle();
host.close();
```

```output
urn:example:prices: lookup tea for session 1
tea costs 4 EUR (answer to ask-1)
```

A chart that sends to a type no processor serves gets `error.execution`.
A processor that is not an object with a `receive` method (a plain
function) is a `TypeError` at `new Host`, naming its type.

## The send

`receive`'s argument describes one `<send>`:

| Field | What it holds |
|---|---|
| `host` | the host the send came from |
| `session` | the sender's session, a `bigint` |
| `sender` | the sender, an `Actor` |
| `event` | the event's name (`<send event>`) |
| `target` | `<send target>` as a string, `undefined` when it has none |
| `sendid` | `<send id>`, or the id the host generated; `undefined` when it has none. A generated id is unique in the sender's session only (each session's first is `send.1`), so key what you keep by both: `` `${send.session}:${send.sendid}` `` |
| `data` | the `<param>`s as an object, or the `<content>`'s value |
| `type` | the processor's type |
| `origin` | the sender's address, an `Address` |
| `traceparent` | the sending step's trace as W3C text, `undefined` when untraced ([Telemetry](telemetry.md)) |
| `message` | the outgoing half, for a transport ([Other systems](other-systems.md)) |

Then two methods, of which a handler calls at most one:

- **`send.answer(event, data, options)`** sends `event` back to the
  sender, with this send's `sendid` as its `_event.sendid`. The options
  are `traceparent` (the answer continues the send's trace unless you give
  another, or `null` for a new one), `origin` (the answer's
  `_event.origin`) and `raw` (the message as you read it, for a chart
  that wants it).
- **`send.fail()`** gives the sender `error.communication` with this
  send's `sendid`, for a request that could not be done.

`origin`, `message`, and the answer's options `origin` and `raw` are
the [wire format](../../README.md#wire-format)'s, for a processor that
carries sends out of the process or speaks SCXML's BasicHTTP ([Other
systems](other-systems.md)); a processor that only answers its charts
needs none of them.

A second answer, or an answer after `fail()`, throws `TA_ERROR_STATE`. A
handler may also answer nothing: the send was a notification, or the chart
waits for a timeout of its own.

The send is a view of the host's memory, read on first access, and it is
valid while the handler runs. Reading it after the handler returned
throws `TA_ERROR_STALE`, so copy what you keep for later.

## Answering later

A handler that returns a promise (an `async` function, or any function
that returns a thenable) has its send filled with every field before the
host moves on. Its `answer()` and `fail()` then work whenever the promise
gets there, as long as the host is open. Until then the actor goes on with
its other events; the answer arrives as an event like any other.

The sender may end while your promise is pending (a session that logged
out, an actor terminated). Then `answer()` and `fail()` deliver nothing
and return `false`; they return `true` when the sender gets the event.
Any other refusal still throws: an answer after another, a closed host
(`TA_ERROR_STATE`), data the value table cannot hold.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'mailer.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="mailer" initial="sending">
  <state id="sending">
    <onentry>
      <send type="urn:example:mail" event="deliver" target="ada@example.com"><content expr="'hello'"/></send>
      <send event="timeout" delay="5s"/>
    </onentry>
    <transition event="delivered" target="sent"><log expr="'delivered after ' + _event.data.ms + ' ms'"/></transition>
    <transition event="error.communication" target="failed"/>
    <transition event="timeout" target="failed"/>
  </state>
  <final id="sent"/>
  <final id="failed"><onentry><log expr="'not delivered'"/></onentry></final>
</scxml>` }]);

// A stand-in for an SMTP client.
const deliver = (to, body) => new Promise((resolve) => setTimeout(() => resolve(20), 20));

const host = new Host(compiled, {
  system: 'demo',
  ioProcessors: {
    'urn:example:mail': {
      async receive(send) {
        try {
          const ms = await deliver(send.target, send.data); // send is still readable here
          send.answer('delivered', { ms });
        } catch {
          send.fail();
        }
      },
    },
  },
  log: (entry) => console.log(entry.text),
});
compiled.close();

host.spawn('mailer');
await host.idle();
host.close();
```

```output
delivered after 20 ms
```

`await host.idle()` waits for the host and for the promise your handler
returned: it resolves once the answer ran. A promise the handler starts
and does not return is not waited for. The pending `timeout` keeps the
process alive until `host.close()`.

## When the sender ends

An actor that reaches a top-level `<final>` ends at once, and the events
still in its queue are dropped (SCXML ends the session there). So a
request your program sent with `actor.send`, and holds a promise for, is
lost when an event before it ends the actor: no handler is called, and
`actor.send` had already returned. Let the chart tell you first: its
`<final>`'s `<onentry>` sends to your I/O processor, and the handler
settles everything it still holds for that session.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'login.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="login" initial="in">
  <state id="in">
    <transition event="request"><send type="urn:example:http" event="response"><content expr="'200 ' + _event.data"/></send></transition>
    <transition event="logout" target="out"/>
  </state>
  <final id="out"><onentry><send type="urn:example:http" event="closed"/></onentry></final>
</scxml>` }]);

const pending = new Map(); // String(session) -> the resolvers of its requests, in order
const host = new Host(compiled, {
  system: 'web',
  ioProcessors: {
    'urn:example:http': {
      receive(send) {
        const waiting = pending.get(String(send.session)) ?? [];
        if (send.event === 'response') waiting.shift()?.(send.data);
        if (send.event === 'closed') {
          for (const resolve of waiting.splice(0)) resolve('401 logged out');
          pending.delete(String(send.session));
        }
      },
    },
  },
});
compiled.close();

/** Sends `path` to the actor; resolves with its answer. */
const request = (actor, path) => new Promise((resolve) => {
  const key = String(actor.id);
  pending.set(key, [...(pending.get(key) ?? []), resolve]);
  actor.send('request', path);
});

const login = host.spawn('login');
const first = request(login, '/home');
login.send('logout');
const second = request(login, '/account'); // queued behind the logout: dropped
console.log(await first);
console.log(await second);
host.close();
```

```output
200 /home
401 logged out
```

## When a handler fails

A handler that throws before it answered, or whose promise rejects before
it answered, has its send failed: the sender gets `error.communication`.
The error itself is reported after the turn: to the host's
`onHandlerError(error, effect)` when it has one (`effect` is the send),
else it rejects a waiting `host.idle()`, or else is thrown as an uncaught
exception; a promise that rejects, with no `onHandlerError`, stays an
unhandled rejection. An error after the answer
fails nothing, and the answer stands.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'c.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="c" initial="s">
  <state id="s">
    <onentry><send type="urn:example:flaky" event="go" id="g1"/></onentry>
    <transition event="error.communication"><log expr="'the chart got error.communication for ' + _event.sendid"/></transition>
  </state>
</scxml>` }]);
const host = new Host(compiled, {
  system: 'demo',
  ioProcessors: { 'urn:example:flaky': { receive() { throw new Error('connection refused'); } } },
  log: (entry) => console.log(entry.text),
});
compiled.close();

host.spawn('c');
await host.idle().catch((error) => console.log('idle() rejected:', error.message));
await host.idle();
host.close();
```

```output
the chart got error.communication for g1
idle() rejected: connection refused
```

The chart handled `error.communication` in the same turn; the error came
out of `idle()` at its end.

## Inputs from a handler

A handler may call the host, `send.host`: send an event to any actor
(`send.sender.send(...)`, `send.host.send(...)`), spawn one, terminate
one. The input applies at once, and
the actors it concerns run in the same or a later turn. It may not take
the host's effects itself, so there is nothing to drain or acknowledge:
when the handler returns, the host goes on.

## Spawning from a chart

SCXML has no element that starts an actor which outlives its state
(`<invoke>` stops its child when the state is left). The package's
`Spawner` is an I/O processor that does it: give it to the host under a
type you choose, and a chart sends it `{ chart, name, params }`. The
host spawns an actor of `chart`, and the sender gets `spawned` with
`{ name, address }` and the send's `sendid`, the address being what it
sends to from then on; a chart the host does not have, or data that is
not such an object, gives the sender `error.communication` instead.
The new actor runs the chart's current version under the name.

The Spawner spawns; it does not look names up. A name has one owner:
the collection actor that decides which actors of a kind exist (a
workspace for its rooms,
[When the actor is not there](missing-actors.md#the-application-routes-it))
is the only one that spawns those names. It is one actor, so its
requests come one at a time, and it records what it asked for (the
chat-rooms example's workspace keeps a `creating` table keyed by the
spawn's `sendid` until `spawned` or `error.communication` answers it),
so it never asks twice for a name. Two actors spawning one name is a
design error in the application: the core's answer is defined (within
one version the oldest holder keeps the name, and a newer version's
holder wins; `ta_host_actor_by_name` in the core's
`include/tinyactors/host.h`) but it is not what the application meant.

```js
import { compileCharts, Host, Spawner } from '@tinyactors/node';

const compiled = compileCharts([
  { name: 'lobby.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="lobby" initial="s">
    <state id="s">
      <onentry>
        <send type="spawn" event="spawn">
          <param name="chart" expr="'room'"/>
          <param name="params" expr="({ topic: 'tea' })"/>
        </send>
      </onentry>
      <transition event="spawned"><send event="hello" targetexpr="_event.data.address"/></transition>
    </state>
  </scxml>` },
  { name: 'room.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="room" initial="s">
    <datamodel><data id="topic"/></datamodel>
    <state id="s"><transition event="hello"><log expr="'room about ' + topic + ' got hello'"/></transition></state>
  </scxml>` },
]);
const host = new Host(compiled, {
  system: 'demo',
  ioProcessors: { spawn: new Spawner() },
  log: (entry) => console.log(entry.text),
});
compiled.close();
host.spawn('lobby');
await host.idle();
console.log((await host.actors({ chart: 'room' })).length, 'room');
host.close();
```

```output
room about tea got hello
1 room
```

### Updating through names

A new version of a chart is a new image: compile it and give it to
`host.addImage`. Adding it is the deploy. New actors of the chart start
in the newest version, the running ones finish on theirs, and nothing
moves unless asked; the versions need not be compatible
([Migration](migration.md#versions-and-segments)). An actor found by
name updates the same way: its owner spawns the new version under the
existing name, and from then on the name (`@room.acme.general`,
`host.actor('room.acme.general')`) finds the new actor, since names are
looked up newest version first. The old actor keeps its session: what
holds its session address still reaches it, and it runs on its version
until it ends.

```js
import { compileCharts, Host, Spawner } from '@tinyactors/node';

const room = (version) => `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
    datamodel="ecmascript" name="room" initial="s">
  <state id="s"><transition event="hello"><log expr="_name + ' runs version ${version}'"/></transition></state>
</scxml>`;
const image = (documents) => {
  const compiled = compileCharts(documents);
  const bytes = compiled.image;
  compiled.close();
  return bytes;
};
const host = new Host(image([
  { name: 'lobby.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="lobby" initial="s">
    <state id="s">
      <transition event="open">
        <send type="spawn" event="spawn">
          <param name="chart" expr="'room'"/>
          <param name="name" expr="'room.acme.general'"/>
        </send>
      </transition>
      <transition event="spawned"><send event="hello" targetexpr="_event.data.address"/></transition>
    </state>
  </scxml>` },
  { name: 'room.scxml', text: room(1) },
]), { system: 'demo', ioProcessors: { spawn: new Spawner() }, log: (entry) => console.log(entry.text) });
const lobby = host.spawn('lobby');                    // the room's one owner
lobby.send('open');
await host.idle();
const old = host.actor('room.acme.general');
host.addImage(image([{ name: 'room.scxml', text: room(2) }]));   // the deploy
lobby.send('open');                                   // version 2 starts under the name
await host.idle();
old.send('hello');                                    // the old room, at its session address
await host.idle();
host.close();
```

```output
room.acme.general runs version 1
room.acme.general runs version 2
room.acme.general runs version 1
```

An actor that must not wait for its end to change (a long-lived one
that holds the state of a thing, like a workspace) is moved instead:
`host.migrate({ chart: 'workspace' })` moves the running actors to the
new version ([Migration](migration.md)).
