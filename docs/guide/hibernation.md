# Hibernation

Most actors spend most of their time waiting: an order waits for a
payment, a session for its user, a device for its next reading. Kept in
memory, a million waiting actors cost a million actors' memory.
Hibernation takes the cold ones out: each becomes a **blob**, a `Buffer`
you keep in your store, and the host asks for it back when the actor has
work. The host does no I/O, so where the blobs live (a database, files, a
cache) is your choice and your code.

Three calls and one handler do it:

- **`host.sweep(maxScan, limit)`** returns at most `limit` sessions that
  have not run since the previous sweep and can be hibernated now,
  looking at no more than `maxScan` actors. Calling it regularly is what
  makes "not run since the previous sweep" mean cold: the first sweep
  after an actor ran skips it.
- **`host.hibernate(session)`** takes the actor out of memory and returns
  its blob, for you to store.
- **`wake: (host, session, migration) => ...`**, a handler in the host's
  options, is called when a hibernated actor has work: an event came for
  it, or one of its delayed sends fell due (`migration` is `undefined`
  then; a [migration](migration.md) may ask too). Load the blob and call
- **`host.wake(session, blob)`**, then or later. Its events have waited
  in its queue, and run at the next turn.

```js
import { compileCharts, Host, TinyactorsError } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'counter.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="counter" initial="counting">
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="counting">
    <transition event="add">
      <assign location="n" expr="n + _event.data"/>
      <log expr="'counter ' + _sessionid + ' is at ' + n"/>
    </transition>
  </state>
</scxml>` }]);

const store = new Map(); // your database: session -> blob

const host = new Host({ systemID: 'demo' }, {
  wake: (host, session) => {
    console.log(`waking ${session}`);
    host.wake(session, store.get(session));
    store.delete(session);
  },
  log: (host, entry) => console.log(entry.text),
});
host.addImage(compiled.image);
compiled.close();

function evict(host) {
  for (const session of host.sweep(1 << 20, 1024)) {
    try {
      store.set(session, host.hibernate(session));
    } catch (error) {
      if (!(error instanceof TinyactorsError)) throw error; // not at rest: it stays
    }
  }
}

const counters = [1, 2, 3].map(() => host.spawn(host.chart('counter')));
await host.idle();
evict(host);              // every counter ran at its start: none is cold yet
evict(host);              // none ran since the last sweep: all three go
console.log(`${store.size} in the store`);

host.send(counters[1], 'add', 5);
host.send(counters[1], 'add', 5); // one wake for both
await host.idle();
console.log(`${store.size} in the store`);
host.close();
```

```output
3 in the store
waking 2
counter 2 is at 5
counter 2 is at 10
2 in the store
```

In a server, run the sweep on a timer, or after a burst of work, and size
`limit` so that one sweep does not hold the event loop for long.

## What a blob holds

A blob is the actor's whole state: its active states, its variables, its
`_event`, its place in the host. Wake it in the host that
hibernated it, or in one [restored](snapshots.md) from that host's
snapshot. Another host's blob throws `TA_ERROR_INVALID`, even for a
session of the same number running the same chart: each host draws a
random identity when it is created, and every blob carries it. It lives in your store until the wake; the host keeps nothing
of it but which hibernation it was. A wake takes the session's latest blob
only: a blob of an earlier hibernation, which a store that fell behind
hands back (an overwrite that failed, a replica, a cache), throws
`TA_ERROR_STALE` and the actor stays hibernated, so no state is lost
without an error. On a host [restored](snapshots.md) from a snapshot, a
blob of a hibernation made after the snapshot was taken is accepted too,
so a store that keeps one blob per session goes on working there.

On the native datamodel the variables are written as values of the
value table ([README](../../README.md#values)): numbers, `bigint`s,
strings, `Uint8Array`s, arrays, plain objects, `true`, `false`, `null`
and `undefined`. A variable holding something else (a function, a `Map`,
a `Date`, a class's instance, an XML document) keeps the actor in memory.
A chart whose scripts declare top-level names gets a new context at the
wake: its `var`s come back from the blob and its `function` declarations
are made again from its scripts. One that declares with `let`, `const`
or `class` keeps its actors in memory. On quickjs the engine writes its
own values, so a `Date`, a `Map`, a `Set` or a typed array is stored too
([The quickjs sandbox](quickjs.md#what-differs-from-the-native-datamodel)).

What stays in the host: a hibernated actor keeps its slot and a small
record (about 60 bytes), and the data of its pending delayed sends and of
the events waiting in its queue stays too. A pending delayed send wakes
the actor when it falls due.

## When an actor cannot hibernate

`hibernate` throws a `TinyactorsError` and the actor stays where it is:

- **`TA_ERROR_STATE`:** not now. Every one of these gives the same
  status (only the message, which is for people, lists them):
  - it has events waiting in its queue (an input you gave since its last
    turn, an event another actor sent, a delayed send that fell due);
  - its step is not over: called, for example, from the handler of a
    send it made in this turn;
  - it runs an invoked child chart or a service;
  - it is not resident: already hibernated, including one whose wake the
    host has asked your `wake` handler for and that you have not given
    back yet.
- **`TA_ERROR_STALE`:** the session ended, or never was.
- **`TA_ERROR_UNSUPPORTED`:** a variable holds what its datamodel cannot
  store. The message names the variable.

The first three cases of `TA_ERROR_STATE` pass (try again after a turn);
the last does not, and the status cannot tell them apart. An eviction
loop therefore knows which actors are resident itself, as the one above
does: what `sweep` returns is resident, and a session whose blob is in
your store, or whose wake you were asked for, is not.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'c.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="c" initial="s">
  <datamodel><data id="seen" expr="new Map()"/></datamodel>
  <state id="s"/>
</scxml>` }]);
const host = new Host({ systemID: 'demo' });
host.addImage(compiled.image);
compiled.close();

const session = host.spawn(host.chart('c'));
await host.idle();
try {
  host.hibernate(session);
} catch (error) {
  console.log(error.status);
  console.log(error.message);
}
host.close();
```

```output
TA_ERROR_UNSUPPORTED
variable 'seen' cannot be stored: only plain objects, arrays and Uint8Arrays are values (docs/values.md)
```

Without a `wake` handler the host does not ask: a hibernated actor stays
hibernated, and its events wait, until you call `host.wake` yourself.

## At scale

How many actors a host holds and how much memory it needs is in
[Capacity and memory](capacity.md): a hibernated actor still counts
toward `system.maxActors`.

`tools/stress.mjs` (`mise run stress` in the repository) is the pattern
of this guide at scale: two million actors, at most 1000 resident, the
rest in SQLite (`node:sqlite` under Node.js, `bun:sqlite` under Bun).

One run of it (2026-10-16, x86_64 Linux 6.18, Intel Xeon @ 2.10GHz, 4
CPUs, 16 GiB; node 22.23.3, bun 1.4.1): two million actors of a counter
chart, at most 1000 resident, 200,000 events to actors drawn at random,
so nearly every event wakes one from the store and the sweep sends
another back (199,860 wakes in each run). Every sampled actor's count
matched the events it was sent, and after every eviction at most 1000
actors were resident.

| runtime, datamodel | populate (spawn and hibernate 2,000,000) | 200,000 events (woken, swept back) | peak resident | core's region | SQLite file |
|---|---|---|---|---|---|
| node, native | 26.1 s (76,700 a second) | 14.6 s (13,700 a second) | 253 MB (126 B per actor) | 115 MB (58 B per actor) | 378 MB |
| node, quickjs | 17.1 s (116,900 a second) | 11.9 s (16,900 a second) | 262 MB (131 B per actor) | 115 MB (58 B per actor) | 409 MB |
| bun, native | 19.5 s (102,600 a second) | 12.9 s (15,500 a second) | 236 MB (118 B per actor) | 115 MB (58 B per actor) | 378 MB |
| bun, quickjs | 14.0 s (143,000 a second) | 11.9 s (16,900 a second) | 221 MB (111 B per actor) | 115 MB (58 B per actor) | 409 MB |
