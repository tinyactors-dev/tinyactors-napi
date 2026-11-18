# Snapshots

`host.snapshot()` copies the whole host into one `Buffer`: every
segment's memory (actors, queues, timers, the hibernated actors'
records), the datamodel's sessions and values, the images, the system id
and the host's time, read when you call it. `Host.restore(snapshot, config, options)` makes a
new host running it, in this process or another.

Uses: rehearse a deploy on a copy (add the new image, migrate, run the
clock ahead, look); capture a host when something goes wrong and step
through it; start every test from one prepared world; or take a host out
of the process for a while.

```js
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'reminder.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="reminder" initial="waiting">
  <datamodel><data id="note" expr="''"/></datamodel>
  <state id="waiting">
    <transition event="set">
      <assign location="note" expr="_event.data"/>
      <send event="ring" delay="3600s"/>
    </transition>
    <transition event="ring" target="done"/>
  </state>
  <final id="done"><onentry><log expr="'reminder: ' + note"/></onentry></final>
</scxml>` }]);

const config = { systemID: 'demo' };
const log = (host, entry) => console.log(entry.text);

const clock = new SimulatedClock();
const host = new Host(config, { clock, log });
host.addImage(compiled.image);
compiled.close();

const reminder = host.spawn(host.chart('reminder'), { name: 'plants' });
host.send(reminder, 'set', 'water the plants');
await host.idle();
clock.increment(30 * 60_000);      // half an hour passes
await host.idle();

const snapshot = host.snapshot();  // bytes: write them to a file, send them elsewhere
host.close();

const later = new SimulatedClock(); // a clock that reads 0
const copy = Host.restore(snapshot, config, { clock: later, log });
console.log('same session:', copy.actorByName('plants') === reminder);
await copy.idle();
console.log('due in', copy.nextDeadline / 60_000, 'minutes');
later.increment(30 * 60_000);
await copy.idle();
copy.close();
```

```output
same session: true
due in 30 minutes
reminder: water the plants
```

Every session id stays the same, and the host's clock goes on from the
snapshot's time, whatever clock reads it: a new `SimulatedClock`, as
here, or the runtime's clock in another process or on another machine.
The snapshot's time is the time of the `snapshot()` call, so a timer
with 6 seconds left then has 6 seconds left after the restore, however
long the host was idle before. `host.now()` reads that clock: a journal of
the inputs that came after a snapshot records it with each, and a replay
on a restored host on a `SimulatedClock` moves the clock to each reading
(`clock.increment(entry.at - host.now())`) before it gives the input.

## Restoring

Pass `Host.restore` the config the snapshot was taken with (its
`systemID` is checked, and the I/O processors and the tick rate are not
in the snapshot), the snapshot's `datamodel` (`'quickjs'` for a quickjs
host), and the handlers `new Host` takes. The host's handlers are not in
the snapshot either: give the restored host its own.

- **A snapshot is valid only for the same build of the package.** It
  holds raw memory, with a version of its layout: a snapshot of a build
  whose layout differs is refused by `Host.restore` with
  `TA_ERROR_INVALID`, and you take a new one with the new build. It is
  not a backup: durability is your database's
  job, and [hibernation](hibernation.md) is how a running process keeps
  actors out of memory. A snapshot is a copy of the whole application,
  every chart version at once.
- **Invoked services are started again.** The services you run are not
  in the snapshot. The restored host's first turn announces each
  invocation that was running to the `services` handler you pass to
  `Host.restore`, with `invocation.restored` true and the same
  `invokeid`, `src` and params. Pass your real handlers to go on, or
  stand-ins for a copy that must not reach the real services. A type with
  no handler gives its invokers `error.communication`, and nothing is
  thrown.
- **Hibernated actors stay in your store.** The snapshot holds their
  records, not their blobs, and the restored host asks for them through
  `wake` as before. A copy that hibernates actors needs its own copy of
  the store, since it writes blobs too.
- **Values are written through the value table**, so two variables of
  one actor that shared one object no longer share it after a restore.

## When a snapshot is refused

The host must be quiescent. `snapshot()` throws a `TinyactorsError` with
`TA_ERROR_STATE` when it is called from a handler, while an effect or a
typed method's reply has not been handled yet (`await host.idle()`
first), and while a migration runs. It throws `TA_ERROR_UNSUPPORTED` when
an actor holds what hibernation cannot store (on the native datamodel a
function, a `Map`, a `Date`, ..., or an actor of a chart whose scripts
declare with `let`, `const` or `class`); the message names the variable.
The host goes on either way.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'c.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="c" initial="s">
  <state id="s"><onentry><log expr="'hello'"/></onentry></state>
</scxml>` }]);
const host = new Host({ systemID: 'demo' }, {
  log: (host, entry) => {
    try {
      host.snapshot();
    } catch (error) {
      console.log('from a handler:', error.status);
    }
  },
});
host.addImage(compiled.image);
compiled.close();

host.spawn(host.chart('c'));
await host.idle();
console.log('after idle():', host.snapshot().length > 0);
host.close();
```

```output
from a handler: TA_ERROR_STATE
after idle(): true
```

## At scale

`tools/snapshot.mjs` (`mise run snapshot` in the repository) rehearses a
deploy on a copy. The live host has two million actors, at most 1000
resident and the rest in SQLite. Each resident actor has a delayed send
pending, and half of them are paying through an invoked payment service
that has not answered. The tool writes the host's snapshot to a file and
copies the store. It restores the copy with its own store and clock and
a stand-in payment service, which gets every payment in flight again
(`restored`, with its amount) and declines it; the copy's own snapshot
must be the same bytes. Then it migrates the copy to a new version while
events come and runs its clock past the delayed sends, while the live
host goes on with events of its own and its payments still in flight. The
copy never reaches the real service.

One run of it (2026-10-16, x86_64 Linux 6.18, Intel Xeon @ 2.10GHz, 4
CPUs, 16 GiB; node 22.23.3, bun 1.4.1), with two million actors, at most
1000 resident, 200,000 events before the snapshot and 200,000 more on
each host after it; then 100,000 actors all resident, so the datamodel's
own state is most of the snapshot. Every run passed its checks: the
copy's snapshot was the same bytes, and the copy migrated every actor to
version 2 (2,018,400 wakes from its store at two million). All 25,000
sampled actors had their counts, delayed sends and versions on both
hosts, the live store held only the live host's blobs, and after every
eviction at most R actors were resident.

| runtime, datamodel | actors, resident | snapshot | taken | restored | migrate on the copy | peak resident (both hosts) |
|---|---|---|---|---|---|---|
| node, native | 2,000,000, 1000 | 116.2 MB (58 B per actor) | 0.11 s | 0.55 s | 172.4 s | 934 MB |
| node, quickjs | 2,000,000, 1000 | 116.1 MB (58 B per actor) | 0.09 s | 0.09 s | 125.7 s | 851 MB |
| bun, native | 2,000,000, 1000 | 116.2 MB (58 B per actor) | 0.10 s | 0.08 s | 144.9 s | 1018 MB |
| bun, quickjs | 2,000,000, 1000 | 116.1 MB (58 B per actor) | 0.09 s | 0.07 s | 111.8 s | 937 MB |
| node, native | 100,000, 100,000 | 65.9 MB (659 B per actor) | 0.76 s | 3.42 s | 5.0 s | 817 MB |
| node, quickjs | 100,000, 100,000 | 60.9 MB (609 B per actor) | 0.90 s | 0.74 s | 3.6 s | 638 MB |
| bun, native | 100,000, 100,000 | 65.9 MB (659 B per actor) | 0.62 s | 1.13 s | 4.6 s | 1106 MB |
| bun, quickjs | 100,000, 100,000 | 60.9 MB (609 B per actor) | 0.86 s | 0.61 s | 3.3 s | 742 MB |

Core's region is 58 B an actor with most of them hibernated and 469 B
all resident; the native datamodel's rows take about 50 B an actor more
than quickjs's state in a snapshot of resident actors.
