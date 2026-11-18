# Invoked services

An I/O processor answers one send at a time. Some things a chart works
with live longer than one send: a connection, a subprocess, a long
computation, a subscription. SCXML has `<invoke>` for them: entering a
state starts the service, the chart and the service exchange events while
the state is active, and leaving the state stops it. When the invoked
thing is another chart, the host runs it as a child actor
([Writing charts](charts.md#a-chart-that-starts-another)). When it is
something your program runs, it is a **service**, and this guide is about
those.

## A service

Register a handler per `<invoke type>` in the host's options:
`services: { [type]: handler }`. When an invocation starts, the handler
gets the host and an **invocation**, and returns the **service**, any
object. The host keeps the service until the invocation ends and calls
its methods:

- `receive(host, send)` gets each `<send target="#_<invokeid>">` of the
  invoker (and each event it forwards, with `autoforward="true"`);
- `stop(host)` is called when the invoker leaves the state, which cancels
  the invocation.

Both are optional. The invocation is how the service talks back:
`invocation.sendBack(event, data)` sends the invoker an event (its
`_event.invokeid` is the invoke's id), and `invocation.done(data)` ends
the service, giving the invoker `done.invoke.<invokeid>` with `data`.

```js
import { compileCharts, Host } from '@tinyactors/node';

const chart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="player" initial="playing">
  <state id="playing">
    <invoke id="counter" type="urn:example:counter" src="counter://local">
      <param name="start" expr="10"/>
    </invoke>
    <transition event="go"><send target="#_counter" event="ping"/></transition>
    <transition event="finish"><send target="#_counter" event="finish"/></transition>
    <transition event="pong"><log expr="'pong ' + _event.data.n + ' from ' + _event.invokeid"/></transition>
    <transition event="done.invoke.counter" target="finished">
      <log expr="'done, total ' + _event.data.total"/>
    </transition>
  </state>
  <final id="finished"/>
</scxml>`;

class Counter {
  constructor(invocation) {
    this.invocation = invocation;
    this.count = invocation.data.start;
    console.log(`started ${invocation.type} ${invocation.src} for session ${invocation.session}`);
  }
  receive(host, send) {
    this.count++;
    if (send.event === 'finish') this.invocation.done({ total: this.count });
    else this.invocation.sendBack('pong', { n: this.count });
  }
  stop(host) {
    console.log('stopped');
  }
}

const compiled = compileCharts([{ name: 'player.scxml', text: chart }]);
const host = new Host({ systemID: 'demo' }, {
  services: { 'urn:example:counter': (host, invocation) => new Counter(invocation) },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();

const player = host.spawn(host.chart('player'));
host.send(player, 'go');
host.send(player, 'go');
host.send(player, 'finish');
await host.idle();
host.close();
```

```output
started urn:example:counter counter://local for session 1
pong 11 from counter
pong 12 from counter
done, total 13
```

A service that ended with `done` is not stopped: `stop` runs only for a
cancel.

An invocation starts at the end of the macrostep that entered its state,
as a child chart does ([Writing charts](charts.md#a-chart-that-starts-another)).
So a `<send target="#_counter">` in that state's own `<onentry>`, or in
anything else that macrostep runs (a raised event's transition, an
eventless one), comes before the service exists, and the chart gets
`error.communication` for it; send from a later event, as `go` does here.

**The invocation** holds `session` (the invoker, a `bigint`), `invokeid`,
`type`, `src`, `data` (the `<param>`s as an object, or the `<content>`),
`traceparent`, and two flags: `running`, false once it ended, and
`restored` ([Snapshots](snapshots.md)). It is a record, so you may keep it
and call `sendBack` from a timer or a promise while the service runs.
`sendBack` and `done` take `{ traceparent }` as a third argument (a
second for `done`); without it they continue the invoke's trace, and
`null` starts a new one. After `done`, a cancel or `host.close()`, both
throw a `TinyactorsError` with `TA_ERROR_STALE`.

**The send `receive` gets** is a view, as an I/O processor's is: read it
during the call. A `receive` that returns a promise has its send filled
before the host moves on, so it may read it after an `await`.

## A service that starts asynchronously

Starting a service often means waiting: a connection to open, a process to
spawn. **The handler may return a promise of the service** (an `async`
handler). Until it settles, the invocation is starting: the sends to it
wait, and reach `receive` in order once the promise resolves. The
invocation may `sendBack` meanwhile.

```js
import { compileCharts, Host } from '@tinyactors/node';

// A stand-in for a client library: a connection that opens after 20 ms.
const connect = (url) => new Promise((resolve) => setTimeout(() => resolve({
  ask: async (question) => `${url} says yes to ${question}`,
}), 20));

const chart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="client" initial="connected">
  <state id="connected">
    <invoke id="db" type="urn:example:db" src="db://primary"/>
    <transition event="query"><send target="#_db" event="query"><content expr="_event.data"/></send></transition>
    <transition event="status"><log expr="'status ' + _event.data"/></transition>
    <transition event="answer"><log expr="_event.data"/></transition>
  </state>
</scxml>`;

const compiled = compileCharts([{ name: 'client.scxml', text: chart }]);
const host = new Host({ systemID: 'demo' }, {
  services: {
    'urn:example:db': async (host, invocation) => {
      invocation.sendBack('status', 'connecting');
      const connection = await connect(invocation.src);
      return {
        async receive(host, send) {
          invocation.sendBack('answer', await connection.ask(send.data));
        },
      };
    },
  },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();

const client = host.spawn(host.chart('client'));
host.send(client, 'query', 'first');  // both reach the service once it is connected
host.send(client, 'query', 'second');
await new Promise((resolve) => setTimeout(resolve, 100));
await host.idle();
host.close();
```

```output
status connecting
db://primary says yes to first
db://primary says yes to second
```

A cancel that comes before the promise settles stops the service as soon
as it resolves, and the sends that waited are dropped, since the invoker
has left and nothing could answer them. A rejection is a failed start:
the invoker gets `error.communication`, once and once more for each send
that waited, and the rejection stays unhandled, as any handler's promise's
does (see "A handler's error ends the process by default" in the
[README](../../README.md#before-you-use-it)). After `host.close()` a
promise that settles is ignored.

**Or return the service at once** and let its own methods await its
start, when the service should take sends before it is ready, or decide
itself what a send does while it connects:

```js
import { compileCharts, Host } from '@tinyactors/node';

const connect = (url) => new Promise((resolve) => setTimeout(() => resolve({
  ask: async (question) => `${url} answers ${question}`,
}), 20));

class Connection {
  constructor(invocation) {
    this.invocation = invocation;
    this.ready = connect(invocation.src); // a promise, started now
    this.ready.catch(() => {});           // its failure is answered in receive
  }
  async receive(host, send) {             // send was filled before the host moved on
    const connection = await this.ready;
    this.invocation.sendBack('answer', await connection.ask(send.data));
  }
}

const compiled = compileCharts([{ name: 'client.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="client" initial="s">
  <state id="s">
    <invoke id="db" type="urn:example:db" src="db://replica"/>
    <transition event="query"><send target="#_db" event="query"><content expr="_event.data"/></send></transition>
    <transition event="answer"><log expr="_event.data"/></transition>
  </state>
</scxml>` }]);
const host = new Host({ systemID: 'demo' }, {
  services: { 'urn:example:db': (host, invocation) => new Connection(invocation) },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();

host.send(host.spawn(host.chart('client')), 'query', 'ping');
await new Promise((resolve) => setTimeout(resolve, 100));
await host.idle();
host.close();
```

```output
db://replica answers ping
```

`await host.idle()` waits for the host and for the promises your
handlers return (a service handler's, a `receive`'s), not for one a
service starts on its own: these examples open the connection in the
background, so they wait on a timer first. A handler that returns a
promise of the service is waited for.

## Failures

A failure of any kind gives the invoker `error.communication`: no handler
for the type, a handler that throws or whose promise rejects, a `receive`
that throws or whose promise rejects (the service crashed, and is dropped
without `stop`), or no handler for a restored invocation. Each later send
to that invocation gets one too, until the invoker leaves the state. The
invoker gets none when it cancelled the invocation in the same step that
started it. A handler's error is reported after the turn, as any
handler's. A type with no handler throws nothing: the chart chose the
type, and a chart (an untrusted one on quickjs, say) must not be able to
end your process by naming one you do not serve.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'c.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="c" initial="s">
  <state id="s">
    <invoke id="mail" type="urn:example:mail" src="smtp://localhost"/>
    <transition event="error.communication"><log expr="'the mail service failed'"/></transition>
  </state>
</scxml>` }]);
const host = new Host({ systemID: 'demo' }, {
  services: { 'urn:example:mail': () => { throw new Error('no SMTP server'); } },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();

host.spawn(host.chart('c'));
try {
  await host.idle();
} catch (error) {
  console.log('idle() rejected:', error.message);
}
await host.idle();
host.close();
```

```output
idle() rejected: no SMTP server
the mail service failed
```

`host.close()` drops the running services without calling `stop`. The
host keeps them on its own object, so a host you drop without closing,
whose services refer back to it, is still collected.

An invocation uses one of the host's requests; `system.maxRequests` is
where the pool starts, and a segment grows it when it runs out
([Capacity and memory](capacity.md)).

## At scale

`tools/services.mjs` (`mise run services` in the repository) runs a
population of actors that each invoke a counter service. It sends pings
and pongs to actors drawn at random. Then a third finish with done data,
a third leave the invoking state (the service is stopped), and the rest
keep theirs. It checks that every pong is counted once, every done datum
is right, every cancelled service was stopped once and no other, and the
ended services are collected.

One run of it (2026-10-16, x86_64 Linux 6.18, Intel Xeon @ 2.10GHz, 4
CPUs, 16 GiB; node 22.23.3, bun 1.4.1). 200,000 actors, each with a
counter service, made 1,000,000 round trips (actor, service, actor); then
a third finished with done data and a third were cancelled. In every run
every pong and done datum was right, every cancelled service was stopped
exactly once and no other, and the host held only the 66,666 services
still running.

| runtime, datamodel | start 200,000 invocations | 1,000,000 round trips | end (done, cancel) | peak resident | core's region |
|---|---|---|---|---|---|
| node, native | 5.0 s (40,000 a second) | 27.2 s (37,000 a second) | 2.1 s | 575 MB (2875 B per actor and service) | 50.3 MB (251 B per actor) |
| node, quickjs | 4.0 s (50,000 a second) | 22.4 s (45,000 a second) | 2.3 s | 698 MB (3491 B per actor and service) | 61.8 MB (309 B per actor) |
| bun, native | 3.9 s (52,000 a second) | 20.7 s (48,000 a second) | 1.9 s | 843 MB (4214 B per actor and service) | 50.3 MB (251 B per actor) |
| bun, quickjs | 3.1 s (64,000 a second) | 19.0 s (53,000 a second) | 1.6 s | 766 MB (3830 B per actor and service) | 61.8 MB (309 B per actor) |

A round trip costs about what it costs with 10,000 actors: a run's work
does not grow with the number of running invocations.
