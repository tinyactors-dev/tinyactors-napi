# I/O processors

An actor cannot reach the network, a file or a database itself: the host
does no I/O. When a chart needs something from outside, it sends an event
to an **I/O processor**. Your handler for that processor does the work
and, if there is an answer, sends it back as an event. The chart
stays a description of what happens; your code decides how.

## Declaring a processor

The config lists the processors the host's charts may send to, each a
`type` (any URI you choose) and an optional `location`. The options give
the handler of each type:

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
const host = new Host({ systemID: 'shop', ioProcessors: [{ type: 'urn:example:prices' }] }, {
  ioProcessors: {
    'urn:example:prices': (host, send) => {
      console.log(`${send.type}: ${send.event} ${send.target} for session ${send.session}`);
      send.answer('price', { amount: prices[send.target], currency: send.data.currency });
    },
  },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('quote'));
await host.idle();
host.close();
```

```output
urn:example:prices: lookup tea for session 1
tea costs 4 EUR (answer to ask-1)
```

A chart that sends to a type the config does not list gets
`error.execution`. A handler for a type the config does not list is a
`TypeError` at `new Host`. A listed type with no handler fails each send
to it, so the sender gets `error.communication`.

## The send

The handler's second argument describes one `<send>`:

| Field | What it holds |
|---|---|
| `session` | the sender's session, a `bigint` |
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

const host = new Host({ systemID: 'demo', ioProcessors: [{ type: 'urn:example:mail' }] }, {
  ioProcessors: {
    'urn:example:mail': async (host, send) => {
      try {
        const ms = await deliver(send.target, send.data); // send is still readable here
        send.answer('delivered', { ms });
      } catch {
        send.fail();
      }
    },
  },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();

host.spawn(host.chart('mailer'));
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
request your program sent with `host.send`, and holds a promise for, is
lost when an event before it ends the actor: no handler is called, and
`host.send` had already returned. Let the chart tell you first: its
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
const host = new Host({ systemID: 'web', ioProcessors: [{ type: 'urn:example:http' }] }, {
  ioProcessors: {
    'urn:example:http': (host, send) => {
      const waiting = pending.get(String(send.session)) ?? [];
      if (send.event === 'response') waiting.shift()?.(send.data);
      if (send.event === 'closed') {
        for (const resolve of waiting.splice(0)) resolve('401 logged out');
        pending.delete(String(send.session));
      }
    },
  },
});
host.addImage(compiled.image);
compiled.close();

/** Sends `path` to the session's actor; resolves with its answer. */
const request = (session, path) => new Promise((resolve) => {
  const key = String(session);
  pending.set(key, [...(pending.get(key) ?? []), resolve]);
  host.send(session, 'request', path);
});

const session = host.spawn(host.chart('login'));
const first = request(session, '/home');
host.send(session, 'logout');
const second = request(session, '/account'); // queued behind the logout: dropped
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
The error itself is reported after the turn: it rejects a waiting
`host.idle()`, or else is thrown as an uncaught exception, and a promise
that rejects stays an unhandled rejection. An error after the answer
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
const host = new Host({ systemID: 'demo', ioProcessors: [{ type: 'urn:example:flaky' }] }, {
  ioProcessors: { 'urn:example:flaky': () => { throw new Error('connection refused'); } },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();

host.spawn(host.chart('c'));
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

A handler may call the host: `host.send` an event to any actor,
`host.spawn` one, `host.terminate` one. The input applies at once, and
the actors it concerns run in the same or a later turn. It may not take
the host's effects itself, so there is nothing to drain or acknowledge:
when the handler returns, the host goes on.
