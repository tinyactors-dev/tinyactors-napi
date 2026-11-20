# Order fulfillment

A shop whose orders are actors. Each order is paid through a payment
gateway, shipped from a warehouse, and delivered, cancelled or failed, and
each of those steps can go wrong in the ways real ones do:

- **A payment that does not answer.** Each attempt has a timeout. A
  timed-out attempt, or one the gateway answers with an error, is retried
  after an exponential backoff (1 s, then 2 s). After three attempts the
  order fails.
- **A payment whose answer is lost.** The gateway charged, but the answer
  never came back. Every attempt charges under one idempotency key, the
  order's id, so the retry finds the charge that was made instead of making
  a second one. An answer that comes after its attempt timed out goes
  nowhere.
- **A decline** fails the order at once, with no retry.
- **A cancel during the payment.** The attempt is cancelled with its
  timeout, and the order refunds: a charge may be in flight. A capture that
  arrives after the refund is voided by the gateway.
- **A cancel during the shipment** is a request to the warehouse. While the
  parcel is still on the shelf, the warehouse releases the stock, and the
  order refunds the charge. The warehouse may have handed the parcel to the
  carrier first: then the cancel is refused, the customer is told why, and
  the order ships. A cancel after that is refused too, and one after the
  order ended finds no order.
- **Out of stock after the payment.** The order refunds the charge, which
  is compensation: the payment succeeded, the step after it failed.
- **A refund that fails** is retried every 5 s until the gateway confirms.

Whatever happens, a delivered order is charged its total exactly once, and
every other order is charged nothing. `main.mjs` checks that against the
gateway's ledger at the end of a run.

## What is where

| File | What it holds |
|---|---|
| [`charts/order.scxml`](charts/order.scxml) | the order: every state, timeout, retry and compensation |
| [`shop.mjs`](shop.mjs) | the application: the host, the services and I/O processors the chart uses, placing and cancelling orders |
| [`world.mjs`](world.mjs) | stand-ins for a payment provider and a warehouse system, so the example needs no network |
| [`main.mjs`](main.mjs) | a day at the shop on the real clock, with a flaky gateway and customers who cancel at random |
| [`test.mjs`](test.mjs) | each tricky case on a `SimulatedClock`, on both datamodels |

## The tinyactors features it uses, and why

- **Invoked services** (`<invoke type="urn:shop:payment">`, `services:` in
  the host's options): a payment attempt and a shipment last longer than
  one send, and the chart must be able to abandon one. A payment attempt is
  one invocation: leaving the `charging` state, by a timeout or a cancel,
  cancels it, and the service's `stop()` makes a late answer go nowhere.
  `invocation.done(data)` ends an attempt with the charge
  (`done.invoke.charge`), and `invocation.sendBack` reports a decline or
  an error. The shipment is one invocation from the pick to the delivery,
  which the chart talks to with `<send target="#_ship">`: the service's
  `receive()` gets the cancel request.
- **Delayed sends and `<cancel>`** for the payment timeout, the backoff and
  the refund retries. A timeout is a `<send delayexpr>` in the state's
  `<onentry>`, and the `<cancel>` in its `<onexit>` takes it back whichever
  way the state is left. The delays come from the order's variables, so
  `main.mjs` runs on 150 ms timeouts and the test on the chart's 10 s ones.
- **I/O processors** (`urn:shop:refunds`, `urn:shop:notify`): a refund is
  one request with one answer, so an I/O processor fits it. Its handler is
  `async`, so its `send` stays readable after the `await`. It catches the
  gateway's failure and calls `send.fail()`, so the chart gets
  `error.communication` and retries. The notifications to the customer are
  sends with no answer.
- **Named actors** (`host.spawn('order', { name: id })`,
  `host.actor(id)`): the shop finds an order by its id to cancel it, and
  an order that reached a final state is gone, so a late cancel finds
  nothing.
- **Spawn params** set the order, its items and its timings.
- **A `SimulatedClock`** in the test: three 10 s timeouts and two backoffs
  take no time, and the test steps from deadline to deadline with
  `host.nextDeadline`.
- **The typed method `actorState`** in the test, to check the state an
  order is in between steps.
- **Both datamodels:** the test runs every case on the native datamodel and
  on quickjs.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/order-fulfillment/main.mjs              # or: bun examples/order-fulfillment/main.mjs
node examples/order-fulfillment/main.mjs --orders 100 --seed 7 --out /tmp/shop
```

It prints one line per order: its total, what the gateway kept, how it
ended and why. Then it prints a summary and the ledger's reconciliation. It
writes the customers' notifications to `outbox.jsonl` in `--out`, or in a
new temporary directory.

## Test it

```sh
mise run examples order-fulfillment     # under node and bun
node examples/order-fulfillment/test.mjs
bun test ./examples/order-fulfillment/test.mjs
```

The test drives the gateway and the warehouse one call at a time: a call
waits until the test answers it, so the test decides what comes first. The
cases run on a `SimulatedClock`, and the last case runs `main.mjs`'s day on
the real clock. All of it takes about a second.
