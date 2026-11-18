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
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

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
  const host = new Host({ systemID: 'test', ioProcessors: [{ type: 'urn:example:payments' }] }, {
    clock,
    ioProcessors: { 'urn:example:payments': (host, send) => charges.push({ at: clock.now, target: send.target }) },
    log: (host, entry) => logs.push(entry.text),
  });
  host.addImage(compiled.image);
  compiled.close();
  return { host, clock, charges, logs };
}

/** The actor's state value, read with a typed method. */
const state = async (host, session) => (await host.actorState({ session })).value;

// It retries every 30 seconds and gives up after three attempts.
{
  const { host, clock, charges, logs } = setup();
  const payment = host.spawn(host.chart('payment'), { name: 'payment' });
  await host.idle();
  assert.deepEqual(charges, [{ at: 0, target: 'card' }]);
  assert.equal(await state(host, payment), 'charging');

  clock.increment(30_000);
  await host.idle();
  clock.increment(30_000);
  await host.idle();
  assert.deepEqual(charges.map((charge) => charge.at), [0, 30_000, 60_000]);

  clock.increment(30_000);
  await host.idle();
  assert.deepEqual(logs, ['gave up after 3']);
  assert.equal(host.actorByName('payment'), undefined, 'a final state ends the actor');
  host.close();
  console.log('ok: retries, then gives up');
}

// An answer before the timeout ends it, and no timer is left.
{
  const { host, clock, charges } = setup();
  const payment = host.spawn(host.chart('payment'), { name: 'payment' });
  await host.idle();
  host.send(payment, 'charged');
  await host.idle();
  assert.equal(host.actorByName('payment'), undefined);
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

The test answered by sending `charged` itself with `host.send`, which is
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
const host = new Host({ systemID: 'test' }, { clock, log: (host, entry) => console.log(entry.text, 'at', clock.now) });
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('ticker'));
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
const host = new Host({ systemID: 'test' }, { clock, log: (host, entry) => console.log(entry.text, 'at', clock.now) });
host.addImage(compiled.image);
compiled.close();
const actor = host.spawn(host.chart('hold'));
await host.idle();

host.send(actor, 'reserve');
console.log('nextDeadline right after the input:', host.nextDeadline);
clock.increment(59_000);          // the input runs now, at 59000: the hold is due at 119000
await host.idle();

host.send(actor, 'reserve');
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
does not return, and no call tells you when one actor ends. When a test runs on
the real clock, wait for the condition itself:

```js
import { compileCharts, Host } from '@tinyactors/node';

/** Turns the host until `condition()` holds, checking every 10 ms. */
async function until(host, condition, ms = 5000) {
  for (const end = Date.now() + ms; !condition(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await host.idle();
  }
}

const compiled = compileCharts([{ name: 'job.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="job" initial="working">
  <state id="working"><onentry><send event="finish" delay="50ms"/></onentry>
    <transition event="finish" target="done"/>
  </state>
  <final id="done"/>
</scxml>` }]);
const host = new Host({ systemID: 'test' });
host.addImage(compiled.image);
compiled.close();

host.spawn(host.chart('job'), { name: 'job' });
await host.idle();
console.log('after idle():', host.actorByName('job') === undefined ? 'ended' : 'still running');
await until(host, () => host.actorByName('job') === undefined);
console.log('after until():', 'ended');
host.close();
```

```output
after idle(): still running
after until(): ended
```

A chart can also say it is done: a `<send type="urn:test:done">` in its
final state's `<onentry>`, to an I/O processor the test serves, resolves
whatever promise the test waits on.

## Habits that help

- **Await `idle()` after each input** that should have an effect before
  the next assertion. A host runs on the event loop, so nothing has run
  right after `host.send` returns.
- **Read state with the typed methods** (`actorState`, `actorContext`)
  after an `idle()`: they read the host as it is when called
  ([Inspecting a host](inspection.md)).
- **Give actors names** to find them with `actorByName`, and to see that
  one ended: a final state ends the actor and frees its name.
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
  sees it.
