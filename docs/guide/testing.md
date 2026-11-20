# Testing your charts

A chart's logic can be tested without its I/O and without waiting for its
timeouts. Three things make that work:

- **I/O processors are your handlers**, so a test gives the host handlers
  that record what the chart sent and answer as the test decides: now,
  later, with an error, or never.
- **A `SimulatedClock`** moves only when the test moves it, so a timeout
  of an hour takes no time.
- **`await host.idle()`** returns when the host has nothing left to do,
  so the test then looks at a settled host.

## A test

The chart below asks a payment service to charge a card, retries twice
when no answer comes within 30 seconds, and gives up after the third
attempt. The test checks each step: the sends the chart made, its state
between them, and the end.

```js
import assert from 'node:assert/strict';
import { compileCharts, Host, SimulatedClock, StaleError } from '@tinyactors/node';

const chart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="payment" initial="charging">
  <datamodel><data id="attempts" expr="0"/></datamodel>
  <state id="charging">
    <onentry>
      <assign location="attempts" expr="attempts + 1"/>
      <send type="urn:example:payments" event="charge" target="card"/>
      <send event="timeout" delay="30s" id="timer"/>
    </onentry>
    <transition event="charged" target="paid"><cancel sendid="timer"/></transition>
    <transition event="timeout" cond="attempts &lt; 3" target="charging"/>
    <transition event="timeout" target="failed"/>
  </state>
  <final id="paid"/>
  <final id="failed"><onentry><log label="payment" expr="'gave up after ' + attempts"/></onentry></final>
</scxml>`;

/** A host running the chart on a simulated clock, recording its charges. */
function setup() {
  const compiled = compileCharts([{ name: 'payment.scxml', text: chart }]);
  const clock = new SimulatedClock();
  const charges = [];
  const logs = [];
  const host = new Host(compiled, {
    system: 'test',
    clock,
    ioProcessors: { 'urn:example:payments': { receive: (send) => charges.push({ at: clock.now, target: send.target }) } },
    log: (entry) => logs.push(entry.text),
  });
  compiled.close();
  return { host, clock, charges, logs };
}

/** The actor's state value, read with a typed method. */
const state = async (actor) => (await actor.state()).value;

// It retries every 30 seconds and gives up after three attempts.
{
  const { host, clock, charges, logs } = setup();
  const payment = host.spawn('payment', { name: 'payment' });
  await host.idle();
  assert.deepEqual(charges, [{ at: 0, target: 'card' }]);
  assert.equal(await state(payment), 'charging');

  clock.increment(30_000);
  await host.idle();
  clock.increment(30_000);
  await host.idle();
  assert.deepEqual(charges.map((charge) => charge.at), [0, 30_000, 60_000]);

  clock.increment(30_000);
  await host.idle();
  assert.deepEqual(logs, ['gave up after 3']);
  assert.throws(() => host.actor('payment'), StaleError, 'a final state ends the actor');
  host.close();
  console.log('ok: retries, then gives up');
}

// An answer before the timeout ends it, and no timer is left.
{
  const { host, clock, charges } = setup();
  const payment = host.spawn('payment', { name: 'payment' });
  await host.idle();
  payment.send('charged');
  await host.idle();
  assert.throws(() => host.actor('payment'), StaleError);
  assert.equal(host.nextDeadline, undefined, 'the timer was cancelled');
  clock.increment(60_000);
  await host.idle();
  assert.equal(charges.length, 1);
  host.close();
  console.log('ok: an answer ends it');
}
```

```output
ok: retries, then gives up
ok: an answer ends it
```

The test answered by sending `charged` itself with `payment.send`, which is
what the I/O processor's `send.answer('charged')` would do, without the
`sendid`. A test may equally answer from the handler.

## Stepping the clock

`clock.increment(ms)` moves the clock once. What is due by then runs once,
at the new time, and a delay it starts counts from the new time. So a
chart that ticks every second ticks once for an `increment(3500)`, and
its next tick is due a second later. To see every tick, step to each
deadline; `host.nextDeadline` says how far the next one is:

```js
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'ticker.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="ticker" initial="ticking">
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="ticking">
    <onentry><send event="tick" delay="1s"/></onentry>
    <transition event="tick" target="ticking"><assign location="n" expr="n + 1"/><log expr="'tick ' + n"/></transition>
  </state>
</scxml>` }]);
const clock = new SimulatedClock();
const host = new Host(compiled, { system: 'test', clock, log: (entry) => console.log(entry.text, 'at', clock.now) });
compiled.close();
host.spawn('ticker');
await host.idle();

clock.increment(3500);             // one jump: one tick
await host.idle();
while (clock.now < 6500) {         // step deadline by deadline
  clock.increment(host.nextDeadline);
  await host.idle();
}
host.close();
```

```output
tick 1 at 3500
tick 2 at 4500
tick 3 at 5500
tick 4 at 6500
```

**An input runs at the next turn's time.** `host.send` puts the event in
the queue at once, but the actor handles it in the host's next turn, at
the clock's time then, and `host.nextDeadline` still reads the last idle
turn's. So an input followed by an `increment` in the same tick is
handled after the clock moved, and a delay it starts counts from the new
time. Await `idle()` between the two when the input belongs before the
step:

```js
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'hold.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="hold" initial="s">
  <state id="s">
    <transition event="reserve"><log expr="'reserved'"/><send event="expire" delay="60s"/></transition>
    <transition event="expire"><log expr="'expired'"/></transition>
  </state>
</scxml>` }]);
const clock = new SimulatedClock();
const host = new Host(compiled, { system: 'test', clock, log: (entry) => console.log(entry.text, 'at', clock.now) });
compiled.close();
const actor = host.spawn('hold');
await host.idle();

actor.send('reserve');
console.log('nextDeadline right after the input:', host.nextDeadline);
clock.increment(59_000);          // the input runs now, at 59000: the hold is due at 119000
await host.idle();

actor.send('reserve');
await host.idle();                // the input runs at 59000, before the step
clock.increment(60_000);
await host.idle();
host.close();
```

```output
nextDeadline right after the input: undefined
reserved at 59000
reserved at 59000
expired at 119000
expired at 119000
```

Both holds came due at 119000, though the first was given at 0.

## Waiting for something to happen

`await host.idle()` waits until the host has nothing to do now and no
promise your handlers returned is pending. It does not wait for a
deadline on the runtime's clock, nor for a promise a handler starts and
does not return. When a test runs on the real clock, wait for what it
asserts: `await actor.done` settles when the actor reaches a top-level
final state, with its `<donedata>`, and `await actor.ask(event, data)`
sends an event and settles with the chart's reply.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'job.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="job" initial="working">
  <datamodel><data id="progress" expr="0"/></datamodel>
  <state id="working"><onentry><send event="finish" delay="50ms"/></onentry>
    <transition event="how"><send event="progress" targetexpr="_event.origin"><content expr="progress"/></send></transition>
    <transition event="finish" target="done"/>
  </state>
  <final id="done"><donedata><content expr="'all done'"/></donedata></final>
</scxml>` }]);
const host = new Host(compiled, { system: 'test' });
compiled.close();

const job = host.spawn('job');
const [event, data] = await job.ask('how');
console.log('asked:', event, data);
await host.idle();
console.log('after idle():', (await host.actors()).length === 0 ? 'ended' : 'still running');
console.log('done:', await job.done);
host.close();
```

```output
asked: progress 0
after idle(): still running
done: all done
```

`ask` gives the event an origin the host answers itself: the chart
replies with `<send targetexpr="_event.origin">`, as it would to another
actor, and the promise settles with the reply's event name and data.
`ask(event, data, { signal })` takes an `AbortSignal`; an aborted ask
rejects with the signal's reason, and its reply, should one come, is
dropped. A host closed while an ask waits leaves it pending for ever, as
it does a typed method's promise.

For any other condition, turn the host until it holds:

```js
import { compileCharts, Host } from '@tinyactors/node';

/** Turns the host until `condition()` holds, checking every 10 ms. */
async function until(host, condition, ms = 5000) {
  for (const end = Date.now() + ms; !(await condition()); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host.idle();
  }
}

const compiled = compileCharts([{ name: 'lamp.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="lamp" initial="warming">
  <state id="warming"><onentry><send event="warm" delay="50ms"/></onentry>
    <transition event="warm" target="lit"/>
  </state>
  <state id="lit"/>
</scxml>` }]);
const host = new Host(compiled, { system: 'test' });
compiled.close();

const lamp = host.spawn('lamp');
await until(host, async () => (await lamp.state()).value === 'lit');
console.log('lit');
host.close();
```

```output
lit
```

## Habits that help

- **Await `idle()` after each input** that should have an effect before
  the next assertion. A host runs on the event loop, so nothing has run
  right after `actor.send` returns.
- **Read state with the typed methods** (`actor.state()`,
  `actor.context()`) after an `idle()`: they read the host as it is when called
  ([Inspecting a host](inspection.md)).
- **Give actors names** to find them with `host.actor(name)`, and to see
  that one ended: a final state ends the actor and frees its name, so
  `host.actor(name)` throws `StaleError`.
- **Close every host**, in a `finally` or the test framework's teardown.
  A host on a `SimulatedClock` arms no timer, so a forgotten one does not
  keep the test process alive, but it holds its memory until collected.
- **Test against both datamodels** if the charts will run on quickjs in
  production: give the host `datamodel: 'quickjs'` in a second run
  ([The quickjs sandbox](quickjs.md)).
- **Start from a prepared world** with a [snapshot](snapshots.md): set a
  host up once, take `host.snapshot()`, and `Host.restore` it at the
  start of each test.
- **Make an unhandled error fail the test.** A handler that throws is
  reported by the next `await host.idle()`, which rejects
  ([README](../../README.md#errors)), so a test that awaits `idle()`
  sees it. A host given `onHandlerError` reports there instead: collect
  the errors and assert there are none.
