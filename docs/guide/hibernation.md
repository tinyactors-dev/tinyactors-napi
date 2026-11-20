# Hibernation

Most actors spend most of their time waiting: an order waits for a
payment, a session for its user, a device for its next reading. Kept in
memory, a million waiting actors cost a million actors' memory.
Hibernation takes the cold ones out: each becomes a **blob**, a `Buffer`
you keep in your store, and the host asks for it back when the actor has
work. The host does no I/O, so where the blobs live (a database, files, a
cache) is your choice and your code.

Give the host a **store** and a **resident** bound, and it does the rest:

- **`store: { save, load, delete }`** is where the blobs go, keyed by the
  actor's session (a `bigint`): `save(session, blob)`, `load(session)`
  returning the blob, `delete(session)`. Each may return a promise
  instead (a database client's), which the host follows. The package has
  two: `MemoryStore` (a `Map`, for tests) and `SQLiteStore(path)`, a
  table in a file through the runtime's own SQLite (`node:sqlite` under
  Node.js, `bun:sqlite` under Bun).
- **`resident: n`** is the most actors the host keeps in memory. After
  each turn the host hibernates the actors past it that ran least
  recently (a CLOCK sweep: an actor that ran since the previous sweep is
  passed over once) and saves their blobs.
- When an event comes for a hibernated actor, or one of its delayed
  sends falls due, the host loads its blob, wakes it and deletes the
  blob; the actor's events have waited in its queue, and run at the next
  turn. An actor terminated while hibernated is woken the same way to
  end, so its blob goes too.

```js
import { compileCharts, Host, MemoryStore } from '@tinyactors/node';

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

const store = new MemoryStore();
const host = new Host(compiled, {
  system: 'demo',
  store,
  resident: 1,
  log: (entry) => console.log(entry.text),
});
compiled.close();

const counters = [1, 2, 3].map(() => host.spawn('counter'));
await host.idle();
console.log(`${store.blobs.size} in the store`);

counters[1].send('add', 5);
counters[1].send('add', 5); // one load for both
await host.idle();
console.log(`${store.blobs.size} in the store, ${[...store.blobs.keys()].includes(counters[1].id) ? 'with' : 'without'} counter 2`);
host.close();
```

```output
2 in the store
counter 2 is at 5
counter 2 is at 10
2 in the store, without counter 2
```

A save that throws, or whose promise rejects, wakes the actor back from
its blob, so no state is lost; the actor stays resident past the bound
until a later turn, and the error is reported as a handler's
([README](../../README.md#errors)). A load that has no blob is reported
the same way, and the actor stays hibernated. A store's methods are
called between the host's runs, never inside one, and a pending save is
waited for before its session is loaded.

## A policy of your own

`store` and `resident` are the application's API. The calls below are
for operating a host whose eviction is not "least recently run past a
bound": by a schedule, by memory pressure, by what your program knows of
its actors.

**Without `resident`,** the host hibernates nothing itself, and loads
from the store as above: your program chooses when, with three calls.

- **`host.sweep(maxScan, limit)`** returns at most `limit` sessions that
  have not run since the previous sweep and can be hibernated now,
  looking at no more than `maxScan` actors. Calling it regularly is what
  makes "not run since the previous sweep" mean cold: the first sweep
  after an actor ran skips it.
- **`host.hibernate(actor)`** takes the actor out of memory and returns
  its blob, for you to save in the store.
- **`host.wake(actor, blob)`** puts it back, which the host does itself
  when it has a store. Without a store, a hibernated actor stays
  hibernated, and its events wait, until you call it.

```js
import { compileCharts, Host, MemoryStore, TinyactorsError } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'counter.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="counter" initial="counting">
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="counting">
    <transition event="add"><assign location="n" expr="n + _event.data"/></transition>
    <transition event="show"><log expr="'counter ' + _sessionid + ' is at ' + n"/></transition>
  </state>
</scxml>` }]);
const store = new MemoryStore();
const host = new Host(compiled, { system: 'demo', store, log: (entry) => console.log(entry.text) });
compiled.close();

function evict() {
  for (const session of host.sweep(1 << 20, 1024)) {
    try {
      store.save(session, host.hibernate(session));
    } catch (error) {
      if (!(error instanceof TinyactorsError)) throw error; // not at rest: it stays
    }
  }
}

const counter = host.spawn('counter');
counter.send('add', 2);
await host.idle();
evict(); // it ran since the last sweep: it stays
evict(); // it did not: it goes
console.log(`${store.blobs.size} in the store`);
counter.send('show');
await host.idle();
host.close();
```

```output
1 in the store
counter 1 is at 2
```

In a server, run such a sweep on a timer, or after a burst of work, and
size `limit` so that one sweep does not hold the event loop for long.

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
A script's top-level `var`s are variables of the actor and come back
from the blob; a chart-level script's functions are the chart's helpers
and come back with the chart, not the blob. On quickjs the engine writes its
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
  - it is not resident: already hibernated, including one whose blob the
    host is loading from the store.
- **`TA_ERROR_STALE`:** the session ended, or never was.
- **`TA_ERROR_UNSUPPORTED`:** a variable holds what its datamodel cannot
  store. The message names the variable.

The first three cases of `TA_ERROR_STATE` pass (try again after a turn);
the last does not, and the status cannot tell them apart. An eviction
loop of your own therefore hibernates only what `sweep` returns, which is
resident, as the one above does. The host's own (`resident`) leaves
every such actor where it is and takes another.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'c.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="c" initial="s">
  <datamodel><data id="seen" expr="new Map()"/></datamodel>
  <state id="s"/>
</scxml>` }]);
const host = new Host(compiled, { system: 'demo' });
compiled.close();

const actor = host.spawn('c');
await host.idle();
try {
  host.hibernate(actor);
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

## At scale

How many actors a host holds and how much memory it needs is in
[Capacity and memory](capacity.md): a hibernated actor still counts
toward `system.maxActors`.

`tools/stress.mjs` (`mise run stress` in the repository) is the pattern
of this guide at scale: two million actors, `resident: 1000`, the rest in
a store over SQLite (`node:sqlite` under Node.js, `bun:sqlite` under
Bun).

One run of it (2026-10-16, x86_64 Linux 6.18, Intel Xeon @ 2.10GHz, 4
CPUs, 16 GiB; node 22.23.3, bun 1.4.1; the tool then ran an eviction
loop of its own, which `resident` does now in the same way): two million actors of a counter
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
