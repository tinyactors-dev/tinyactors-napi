# Migration

Charts change. A long-lived actor (an order that waits a week for its
delivery) is still running when you deploy the chart's next version, and
stopping it would lose its state. A migration moves running actors to the
new version instead, each at a moment when it is at rest, while the host
goes on working.

## Versions and segments

Each `addImage` makes a new **segment** of the host. When an image holds a
chart whose `name` is already in the host, that chart has a new version:
`host.chart(name)` returns the newest, so the actors spawned from then on
are of the new version, and the running ones stay on theirs.

`host.migrate()` moves the running actors to the newest version of their
chart, during the next turns. A moved actor keeps its session, its active
states (matched by id; [below](#states-the-new-version-enters) for those
that changed), its queue and its delayed sends with their data.
Its variables do not carry over by themselves, since the new version may
name them differently: the actor first gets the event
`error.platform.upgrade`, whose data holds the old version's variables,
and the new version takes what it keeps from there.

```js
import { compileCharts, Host } from '@tinyactors/node';

const image = (name, text) => {
  const compiled = compileCharts([{ name, text }]);
  const bytes = compiled.image;
  compiled.close();
  return bytes;
};

const v1 = image('counter-v1.scxml', `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="counter" initial="counting">
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="counting">
    <transition event="add"><assign location="n" expr="n + 1"/><log expr="'v1 counts ' + n"/></transition>
  </state>
</scxml>`);

// Version 2 renames n to count and counts by ten.
const v2 = image('counter-v2.scxml', `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="counter" initial="counting">
  <datamodel><data id="count" expr="0"/></datamodel>
  <state id="counting">
    <transition event="error.platform.upgrade">
      <assign location="count" expr="_event.data.n"/>
      <log expr="'upgraded, the old variables were ' + JSON.stringify(_event.data)"/>
    </transition>
    <transition event="add"><assign location="count" expr="count + 10"/><log expr="'v2 counts ' + count"/></transition>
  </state>
</scxml>`);

const host = new Host({ systemID: 'demo' }, {
  log: (host, entry) => console.log(entry.text),
  migrated: (host, moved) => console.log(`session ${moved.session} moved to segment ${moved.segment}`),
  migrationDone: (host, result) => console.log(`migration ${result.migration}: ${result.migrated} moved, ${result.failed.length} failed`),
});

host.addImage(v1);
const counter = host.spawn(host.chart('counter'));
host.send(counter, 'add');
host.send(counter, 'add');
await host.idle();

host.addImage(v2);                 // the deploy
const id = host.migrate({ chart: 'counter' });
console.log(`started migration ${id}`);
await host.idle();

host.send(counter, 'add');
await host.idle();
host.close();
```

```output
v1 counts 1
v1 counts 2
started migration 1
session 1 moved to segment 1
migration 1: 1 moved, 0 failed
upgraded, the old variables were {"n":2}
v2 counts 12
```

Once no actor runs on an old segment, the host retires it and frees its
memory; `host.hostStats` counts the retired segments
([Inspecting a host](inspection.md)).

## States the new version enters

A migration puts the actor in the new version's states without running
any of their `<onentry>`, as it takes it out of the old ones without
their `<onexit>`: it is not a transition. The states are matched by id,
and the configuration is completed to a legal one:

- a state that is compound in the new version, and had no children in
  the old, is entered at its `initial` child (or its first);
- a state the new version does not have at all is replaced by its
  parent's initial state (the chart's `initial` at the top);
- a `<parallel>` gets all its regions, and an `<invoke>` of a state the
  migration enters is started.

So what an `<onentry>` would have done (arm a timer, tell your program)
is the `error.platform.upgrade` transition's job, with `In()` to see
where the actor landed:

```js
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

const image = (name, text) => {
  const compiled = compileCharts([{ name, text }]);
  const bytes = compiled.image;
  compiled.close();
  return bytes;
};

const v1 = image('sub-v1.scxml', `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="subscription" initial="active">
  <state id="active"><transition event="miss" target="pastDue"/><transition event="pause" target="paused"/></state>
  <state id="pastDue"/>
  <state id="paused"/>
</scxml>`);

// Version 2: pastDue starts a grace period, and paused is gone.
const v2 = image('sub-v2.scxml', `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="subscription" initial="active">
  <state id="active">
    <transition event="error.platform.upgrade"><log expr="_sessionid + ' upgraded into active'"/></transition>
  </state>
  <state id="pastDue" initial="grace">
    <transition event="error.platform.upgrade" cond="In('grace')">
      <log expr="_sessionid + ' upgraded into grace: arming its timer'"/>
      <send event="graceOver" delay="7s"/>
    </transition>
    <state id="grace">
      <onentry><log expr="'grace onentry'"/><send event="graceOver" delay="7s"/></onentry>
    </state>
  </state>
</scxml>`);

const host = new Host({ systemID: 'demo' }, { clock: new SimulatedClock(), log: (host, entry) => console.log(entry.text) });
host.addImage(v1);
const late = host.spawn(host.chart('subscription'));
const paused = host.spawn(host.chart('subscription'));
host.send(late, 'miss');
host.send(paused, 'pause');
await host.idle();

host.addImage(v2);
host.migrate();
await host.idle();
for (const session of [late, paused]) console.log(session, JSON.stringify((await host.actorState({ session })).value));
console.log('next deadline', host.nextDeadline);
host.close();
```

```output
1 upgraded into grace: arming its timer
2 upgraded into active
1n {"pastDue":"grace"}
2n "active"
next deadline 7000
```

`grace onentry` is never logged: without the upgrade transition's
`<send>`, actor 1 would wait in `grace` for ever.

## The calls

- **`host.migrate({ chart, session, wake, timeout })`** starts a
  migration and returns its id, a number. With no options it moves the
  actors of every chart; `chart` names one chart, `session` one actor.
  `wake: true` asks for the hibernated actors (below). `timeout` is in
  milliseconds of the host's clock, rounded up to its next tick; 0 or none
  means none. A `chart` the host does not have throws `TA_ERROR_INVALID`
  and a `session` that ended `TA_ERROR_STALE`: a migration that could
  move nothing is refused rather than reported done.
- **`migrationDone: (host, result) => ...`**, in the host's options, gets
  the end of each migration: `{ migration, migrated, failed, pending }`,
  `failed` the actors it could not move, each `{ session, reason }`
  (`reason` core's status, below), and `pending` the sessions
  (`bigint`s) its timeout left behind. It is a
  handler of the host, so a migration started by a host that was later
  [restored](snapshots.md) reports to the restored host's handler.
- **`migrated: (host, moved) => ...`** gets each actor moved, a view of
  `session`, `segment`, `chart` (its name) and `migration`, valid while
  the handler runs.

## When a migration ends

A migration ends when every actor it looks at has moved, or at its
`timeout`. An actor that is running an invocation (an invoked chart or
a service) moves once the invocation ends: a migration with a `timeout`
waits for that until the timeout, and one without fails the actor at
once with `'TA_ERROR_STATE'`, since an invocation may never end. A hibernated actor moves once it is woken: with `wake:
true` the migration asks for it through your `wake` handler, with the
migration's id as the third argument, and asks again if it finds the
actor hibernated after a wake. Without `wake`, a hibernated actor that
nobody wakes holds the migration until its timeout, or forever without
one, and `migrationDone` is never called: give such a migration a
`timeout`. A migration still running when the host is closed never
reaches `migrationDone`.

## Actors that do not move

An actor that cannot be written out stays on its version and is in
the result's `failed`, with its session and the reason,
`'TA_ERROR_UNSUPPORTED'` for a state that cannot be written out (`host.hibernate`
of the actor names the variable). On the native datamodel that is one whose variables hold a value
outside the value table (a function, a `Map`, a `Date`, ...), or whose
chart's scripts declare with `let`, `const` or `class`, the same actors
[hibernation](hibernation.md) refuses.

On the native datamodel the upgrade event's data holds exactly the old
version's variables. A chart whose scripts declare top-level names gets
its new version's declarations (its scripts are instantiated, not run),
and the old names the new version does not declare are gone.

## Most actors hibernated: wake a batch at a time

A migration with `wake: true` asks for every hibernated actor early. Wake
them all at once and they are all in memory at once. Instead, queue the
migration's requests and wake a batch per round: the migration takes each
woken actor in its next runs. An event's request (`migration` is
`undefined`) still wakes its actor at once, and the migration takes that
one too. Put actors back to sleep once they have moved; one put back
before it moved is asked for again, which costs work but does not stall
the migration.

```js
import { compileCharts, Host, TinyactorsError } from '@tinyactors/node';

const image = (version) => {
  const compiled = compileCharts([{ name: `v${version}.scxml`, text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="counter" initial="s">
  <datamodel><data id="version" expr="${version}"/></datamodel>
  <state id="s"><transition event="error.platform.upgrade"/></state>
</scxml>` }]);
  const bytes = compiled.image;
  compiled.close();
  return bytes;
};

const store = new Map();
const asked = [];
/** @type {import('@tinyactors/node').MigrationResult | undefined} */
let done;
let mostResident = 0;

const host = new Host({ systemID: 'demo' }, {
  wake: (host, session, migration) => {
    if (migration !== undefined) asked.push(session);  // the migration's: a batch at a time
    else host.wake(session, store.get(session));       // an event's: now
  },
  migrationDone: (host, result) => (done = result),
});

function evict() {
  for (const session of host.sweep(1 << 20, 1 << 20)) {
    try {
      store.set(session, host.hibernate(session));
    } catch (error) {
      if (!(error instanceof TinyactorsError)) throw error;
    }
  }
}

host.addImage(image(1));
for (let i = 0; i < 100; i++) host.spawn(host.chart('counter'));
await host.idle();
evict();
evict();
console.log(`${store.size} hibernated`);

host.addImage(image(2));
host.migrate({ wake: true });
while (done === undefined) {
  for (const session of asked.splice(0, 10)) host.wake(session, store.get(session));
  await host.idle();
  const stats = await host.hostStats();
  mostResident = Math.max(mostResident, stats.host.actors - stats.host.hibernated);
  evict();
  evict();
}
console.log(`${done.migrated} moved, ${done.failed.length} failed, at most ${mostResident} in memory at once`);
host.close();
```

```output
100 hibernated
100 moved, 0 failed, at most 10 in memory at once
```

## At scale

`tools/migration.mjs` (`mise run migration` in the repository) is this
pattern at scale: two million actors, at most 1000 resident, the rest in
SQLite.

One run of it (2026-10-16, x86_64 Linux 6.18, Intel Xeon @ 2.10GHz, 4
CPUs, 16 GiB; node 22.23.3, bun 1.4.1): two million actors of version 1
of a counter, at most 1000 resident, 200,000 events before the migration
and 200,000 more during it, every actor moved to version 2 with `wake:
true` (2,218,265 wakes from the store in each run). The migration ended
with every actor migrated, none failed and none left; all 25,000 sampled
actors had their count and version 2; version 1's segment was retired;
and after every eviction at most 1000 actors were resident (plus two
batches while the migration moved them).

| runtime, datamodel | populate (2,000,000 and 200,000 events) | migrate (2,000,000 moved, 200,000 events) | peak resident | core's region, both versions / after | SQLite file |
|---|---|---|---|---|---|
| node, native | 54.5 s | 154.2 s (12,970 a second) | 656 MB (328 B per actor) | 231 MB / 115 MB (58 B per actor) | 576 MB |
| node, quickjs | 42.0 s | 108.7 s (18,390 a second) | 657 MB (329 B per actor) | 231 MB / 115 MB (58 B per actor) | 756 MB |
| bun, native | 50.5 s | 131.2 s (15,240 a second) | 680 MB (340 B per actor) | 231 MB / 115 MB (58 B per actor) | 576 MB |
| bun, quickjs | 41.0 s | 109.5 s (18,270 a second) | 605 MB (303 B per actor) | 231 MB / 115 MB (58 B per actor) | 756 MB |
