# Inspecting a host

This guide is part of operating a host (the README's [Operating a
host](../../README.md#operating-a-host)): `actor.state()`, `actor.context()`
and `actor.get()` are the application's, the methods on `host` an
operator's.

A running host answers questions about itself: which state an actor is
in, what its variables hold, which actors exist, what the host has done
so far. These are the **typed methods**, one per question. Each reads
the host as it is when you call it and answers in a later turn, so each
returns a promise: `await host.actorState({ session })`, or for one
actor `await actor.state()`, `actor.context()` and `actor.get()`.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'order.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="order" initial="open">
  <datamodel>
    <data id="items" expr="[]"/>
  </datamodel>
  <state id="open" initial="browsing">
    <state id="browsing">
      <transition event="add"><script>items.push(_event.data)</script></transition>
    </state>
  </state>
</scxml>` }]);
const host = new Host(compiled, { system: 'shop' });
compiled.close();

const order = host.spawn('order', { name: 'first' });
order.send('add', 'tea');
await host.idle(); // the actor has started and handled 'add'

const { value } = await host.actorState({ session: order });
console.log('state:', JSON.stringify(value));
const { variables } = await order.context();
console.log('variables:', JSON.stringify(variables));
const actor = await order.get();
console.log('actor:', actor.chart, 'mailbox', actor.mailbox);
host.close();
```

```output
state: {"open":"browsing"}
variables: {"items":["tea"]}
actor: order mailbox 0
```

Asked before the `await host.idle()`, the same methods would have found
an actor that had not started yet: no active state, and every variable
`undefined`, the spawn's `params` included. An actor's `<data>` are
given their values, from `expr` or from `params`, when it first runs, in
the host's next turn after the spawn. A variable that holds `undefined`
reads `undefined` and one that holds `null` reads `null`, on both
datamodels. An actor's state reads as nested objects, one key per
compound state: `{"open": "browsing"}` is the state `browsing` inside
`open`, and a parallel state is `{"p": {"r1": ..., "r2": ...}}`, one
key per region.

## The methods

| Method | Params | Result |
|---|---|---|
| `actorState` | `{ session }` | `{ value, history }`: the active states, as above, and where each history state would return ([below](#delayed-sends-and-history)) |
| `actorContext` | `{ session }` | `{ variables }`: each `<data>` and its value |
| `actorGet` | `{ session }` | `{ session, segment, chart, parent, mailbox, invocations, timers, timersPending }`: `timers` its pending delayed sends ([below](#delayed-sends-and-history)) |
| `actorList` | `{ cursor, limit }`, both optional | `{ sessions, cursor }`: a page of sessions; `cursor` is `null` after the last page |
| `hostStats` | none | `{ host, pools, charts }`: counters ([below](#the-hosts-counters)) |
| `hostConfig` | none | the config the host runs with, every default filled in |
| `traceConfigure`, `traceWatch`, `traceUnwatch`, `traceEnd`, `traceSpansDecode` | | [Telemetry](telemetry.md) |

A method without params is called with none: `await
host.hostStats()`. A `session` param takes an `Actor` too. The host
checks the params: one the method does not take, of the wrong type or
out of range is an error, as is a session that names no actor (it ended,
or never was). **Sessions in a result are numbers**, while `actor.id`
and the views give `bigint`s, so `result.sessions.includes(actor.id)` is
false and a `Map` keyed by one misses the other: compare with
`Number(actor.id) === listed`, or key by `String(actor.id)`
([README](../../README.md#actors-sessions-and-addresses)). The inputs take
either back as it is (`host.send(result.sessions[0], ...)`), and
`host.actor(result.sessions[0])` gives its `Actor`; `await
host.actors({ chart })` lists the live actors as `Actor`s, every page
read.

Each method's params and result are typed in the package's `index.d.ts`
(`SessionParams`, `ActorStateResult`, `ActorListResult`,
`HostStatsResult`, `EffectiveHostConfig`, ...), for the promise forms and
the handlers' `result` alike, and so is the host's config (`HostConfig`).
An editor completes `stats.pools[0].actors.highWater`, and TypeScript, or
`tsc` checking JavaScript, refuses a field a result does not have or
a param a method does not take. Every example of these guides is checked
that way against the package's types, the one below included.

`actorContext` and `actorState` are refused for a hibernated
actor (`reason` `'state'`): wake it first ([Hibernation](hibernation.md)).

## Delayed sends and history

What an operator asks first about a waiting actor is when it will act
next and where it will go back to. `actorGet` answers the first:
`timers` lists the actor's pending delayed sends (each `<send delay>`
not yet due and not cancelled), earliest first, each `{ sendid, event,
due }`, with `due` in milliseconds on the clock `host.now()` reads. The
list holds at most 32; `timersPending` is how many there are, so a
longer `timersPending` says the list was cut. A send without an `id` has
a `sendid` of `null`. `actorState` answers the second: `history`
holds, for each history state the actor has recorded, its parent state as
it would be entered again, in the shape of `value`. A history state
records when its parent is exited, so before the first exit it is absent
and `history` is `{}`.

```js
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'review.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="review" initial="reviewing">
  <state id="reviewing" initial="draft">
    <onentry><send id="sla" event="breach" delay="7200s"/></onentry>
    <history id="back" type="deep"><transition target="draft"/></history>
    <state id="draft"><transition event="submit" target="legal"/></state>
    <state id="legal"/>
    <transition event="hold" target="held"/>
  </state>
  <state id="held"><transition event="release" target="back"/></state>
</scxml>` }]);
const clock = new SimulatedClock();
const host = new Host(compiled, { system: 'docs', clock });
compiled.close();

const doc = host.spawn('review');
doc.send('submit');
doc.send('hold');
await host.idle();
clock.increment(60_000); // a minute later

const { timers, timersPending } = await host.actorGet({ session: doc });
for (const { sendid, event, due } of timers) console.log(sendid, event, 'in', (due - host.now()) / 1000, 's');
console.log('pending:', timersPending);
const { value, history } = await host.actorState({ session: doc });
console.log('state:', JSON.stringify(value), 'history:', JSON.stringify(history));
host.close();
```

```output
sla breach in 7140 s
pending: 1
state: "held" history: {"back":{"reviewing":"legal"}}
```

A deep history (`type="deep"`) returns to the atomic states it recorded,
so its value goes down to them; a shallow one returns to the child of
its parent it recorded, which enters its own initial state, and its
value names that child alone. Neither costs anything per event: the
host reads them only when asked.

A page at a time, `actorList` lists every actor:

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'idle.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="idle"><state id="waiting"/></scxml>` }]);
const host = new Host(compiled, { system: 'shop' });
compiled.close();
for (let i = 0; i < 5; i++) host.spawn('idle');

const sessions = [];
let cursor = 0;
do {
  const page = await host.actorList({ cursor, limit: 2 });
  sessions.push(...page.sessions);
  cursor = page.cursor;
} while (cursor !== null);
console.log('sessions:', sessions.join(' '));
host.close();
```

```output
sessions: 1 2 3 4 5
```

## Errors

An error rejects the promise with a `TinyactorsError` with `code`
(JSON-RPC's number), `reason` (a word such as `stale`, `type`,
`unknown`) and `path` (the param it is about), and a message for people.
A call the host refuses at once (a closed host) rejects too.

```js
import { Host } from '@tinyactors/node';

const host = new Host([], { system: 'shop' });
try {
  await host.actorState({ session: 99 });
} catch (error) {
  console.log(error.reason, error.path, error.code);
}
// @ts-expect-error: a param actorGet does not take, which the types refuse too
await host.actorGet({ name: 'first' }).catch((error) => console.log(error.reason, error.path));
host.close();
```

```output
stale params.session -32001
unknown params.name
```

The rejection is yours to handle: `host.idle()` does not see it, and one
you do not catch is an unhandled rejection, which ends a Node.js or Bun
process by default. `host.close()` drops the methods still waiting:
their promises never settle.

## With handlers

Each method also takes handlers instead of returning a promise:
`host.actorState(params, onResult, onError)`, and so on. Given handlers
it returns nothing; `onResult(result)` is called in a
later turn, or `onError(error)` with the same `TinyactorsError`.
The promise is made only when no handler is given, so a caller that
passes handlers pays for no promise. A method without params takes `undefined`:
`host.hostStats(undefined, onResult)`.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'idle.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="idle"><state id="waiting"/></scxml>` }]);
const host = new Host(compiled, { system: 'shop' });
compiled.close();
const session = host.spawn('idle');
await host.idle();

host.actorState({ session }, (result) => console.log('state:', JSON.stringify(result.value)));
host.hostStats(undefined, (stats) => console.log('actors:', stats.host.actors));
host.actorGet({ session: 99 }, () => {}, (error) => console.log('error:', error.reason));
console.log('asked');
await host.idle();
host.close();
```

```output
asked
state: "waiting"
actors: 1
error: stale
```

The handlers ran after `asked`, in a later turn. Without an `onError`,
an error rejects a waiting `host.idle()`, or else is thrown as an
uncaught exception, as a handler's error is.

## The host's counters

`hostStats` answers three parts:

- `host`: `segments` (live), `actors` and `hibernated` (now),
  `runnable` (actors with work waiting), `migrations` (running),
  `regionBytes` (the memory of the live segments), `delivered` (events
  put in queues), `routed` (sends between the host's segments),
  `migrated` (actors moved), `retired` (segments freed after a
  migration), and `fuelClock` (the work the host has done, the clock its
  trace records are stamped with).
- `pools`: an array with one entry per live segment, in segment order.
  Each entry has its `segment` number and one object per pool, `actors`,
  `events`, `timers`, `workspaces`, `requests` and `slabBytes`, each
  `{ capacity, used, highWater }`: `stats.pools[0].actors.used`
  ([Capacity and memory](capacity.md)).
- `charts`: one entry per chart name, summed over its versions: `name`,
  `actors`, `hibernated`, `spawned`, `ended`, `turns`, `macrosteps`,
  `fuel`, `errorsExecution`, `errorsCommunication`, `errorsPlatform`,
  `faults`.

The words, as the counters use them:

- A **macrostep** is everything one event does to an actor: its
  transitions and those that follow on their own, until the actor waits
  for the next event. A **microstep** is one set of transitions taken
  together. Spans are named after both ([Telemetry](telemetry.md)).
- **Fuel** is the host's unit of work: an action, a transition, and a
  share of the JavaScript an expression runs. A **turn** is one time an
  actor is given the processor; it runs until it waits or has spent its
  fuel for the turn (`system.quantum`), so a busy actor cannot starve the
  others.
- A **workspace** is the room an actor needs while it runs; the host has
  a few and an actor waits for one.
- `errorsPlatform` counts `error.platform` events raised in the chart's
  actors; `faults` counts actors the host
  had to end because their run failed inside the host.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'job.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="job" initial="running">
  <state id="running">
    <transition event="finish" target="done"/>
    <transition event="break"><assign location="undeclared" expr="1"/></transition>
  </state>
  <final id="done"/>
</scxml>` }]);
const host = new Host(compiled, { system: 'shop' });
compiled.close();

const jobs = [1, 2, 3].map(() => host.spawn('job'));
jobs[0].send('finish');
jobs[1].send('break');
await host.idle();
const stats = await host.hostStats();
const [job] = stats.charts;
console.log(`${job.name}: ${job.spawned} spawned, ${job.ended} ended, ${job.actors} running, ${job.errorsExecution} execution error`);
console.log(`${stats.host.segments} segment, ${stats.pools[0].actors.used} actors in its pool`);
host.close();
```

```output
job: 3 spawned, 1 ended, 2 running, 1 execution error
1 segment, 2 actors in its pool
```

## Two actors that never rest

Actors that answer each other for ever keep the host busy: each turn
runs them, `await host.idle()` never resolves, and nothing is logged or
thrown, since every step is legal. The usual cause is SCXML's prefix
match ([README](../../README.md#charts)): a transition on `join` also
takes the answer `join.refused`, and asks again. The counters show it.
Between two readings while you gave no input, a loop's charts gain
`macrosteps` and `fuel` without end, `host.delivered` grows, and
`host.runnable` stays above zero; a host that is only slow drains its
queue instead.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([
  { name: 'user.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="user">
    <state id="s">
      <onentry><send event="join" target="tinyactors://chat/@room"/></onentry>
      <transition event="join"><send event="join" target="tinyactors://chat/@room"/></transition>
    </state>
  </scxml>` },
  { name: 'room.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="room">
    <state id="s"><transition event="join"><send event="join.refused" targetexpr="_event.origin"/></transition></state>
  </scxml>` },
]);
const host = new Host(compiled, { system: 'chat' });
compiled.close();
host.spawn('room', { name: 'room' });
const user = host.spawn('user');

/** The charts whose actors kept working for `ms` with no input given. */
async function busy(host, ms) {
  const before = await host.hostStats();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const after = await host.hostStats();
  if (after.host.runnable === 0) return [];
  return after.charts
    .filter((chart) => chart.macrosteps - (before.charts.find((c) => c.name === chart.name)?.macrosteps ?? 0) > 1000)
    .map((chart) => chart.name)
    .sort();
}

console.log('busy:', (await busy(host, 200)).join(', '));
user.terminate(); // in production: alert, and fix the chart
await host.idle();
console.log('idle again; busy:', (await busy(host, 50)).length);
host.close();
```

```output
busy: room, user
idle again; busy: 0
```

A watchdog that runs this on a timer, and alerts when a chart stays busy
over several readings, finds such a loop. The fix is in the chart: name
the answer so that it does not extend the request (`refused.join`), or
make the `join` transition's `cond` refuse what is not a request.
