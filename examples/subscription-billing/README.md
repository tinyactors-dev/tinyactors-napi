# Subscription billing

A billing service whose subscriptions and free trials are actors, and a
new release of their charts rolled out to the running population while
renewals, payments and customers' changes go on.

- **A subscription** renews every cycle: its renewal timer (a delayed
  send) moves it to `charging`, which invokes the payment service for the
  plan's price. A paid renewal arms the next one. A declined payment
  counts a failure and waits in `pastDue` for its dunning timer to charge
  again, or for the customer to update their card; after `maxRetries`
  failures in a row it is cancelled. A plan change applies to the next
  renewal, and a coupon halves the next few.
- **A trial** converts into a subscription when its timer falls due,
  unless the customer cancels first.
- **Most actors are hibernated** in a blob store between their events,
  and a renewal, a retry or a customer's event wakes them.

Release 2 changes both charts:

| | release 1 | release 2 |
|---|---|---|
| a failed payment | `pastDue`: wait for the retry | `pastDue.grace` for `graceMs` after the first failure, the service still on; then `pastDue.suspended` |
| pausing | none | `paused`: no renewals until `resume` |
| the failure count | `failures` | renamed `dunningAttempts` |
| the coupon's stamp | `couponAppliedAt`, a `Date` | `couponAppliedMs`, a number |
| trials | | `extend` moves a trial's end |

What makes the migration interesting:

- **A pending renewal or retry crosses the migration.** A subscription
  renewed by release 1 on day 30 is renewed by release 2 on day 60, on
  time; one in dunning gets its retry when release 1 scheduled it.
- **A renamed variable and a new state.** The variables both releases
  declare keep their values; the upgrade event carries release 1's, and
  release 2's `error.platform.upgrade` transition takes `failures` into
  `dunningAttempts`. A subscription that was past due lands in
  `pastDue.grace`, entered without its `onentry` (a migration runs none),
  so the upgrade transition starts the grace timer itself.
- **Actors that cannot move.** On the native datamodel a `Date` cannot be
  written out, so a release 1 subscription holding a coupon's stamp can be
  neither hibernated nor migrated: it stays on release 1, counted as
  failed, and keeps billing there. Its last discounted renewal clears the
  stamp, and a later migration moves it. QuickJS writes a `Date` out, so
  there it moves at once. Once release 2 is deployed, the application
  holds a new coupon for a subscription still on release 1 and sends it
  when the migration moves it, so no new stamp keeps it back.
- **A payment in flight.** An actor running an invocation moves only when
  it ends. A bank that answers in three days holds its subscription past
  the migration's timeout: the result lists it as pending, and a second
  migration moves it once the charge has answered.
- **Hibernated actors.** With `wake: true` the migration asks the wake
  handler for each; the application queues those requests and wakes a
  batch a round, so the resident set stays bounded. An event for an actor
  in that queue wakes it at once, and the migration takes it too. Without
  `wake`, the hibernated actors hold the migration until its timeout.
- **One chart, one session.** A migration can name a chart (the
  subscriptions move, the trials stay on release 1) or one session (a
  canary, or a straggler).

## How an operator rolls it out

`rollout.mjs` is this procedure as a program, and `main.mjs` runs it on
day 45 of four months of business:

1. **Deploy** release 2 (`host.addCharts`, which returns its segment).
   From then on every new subscription and trial is release 2's; running
   ones stay on release 1. Nothing else changes yet, so this is safe to do
   at any time.
2. **Move one canary** (`host.migrate({ session, wake: true })`) and read
   what it says: the `migrated` handler names it and its new segment,
   `migrationDone` gives `{ migrated, failed, pending }`, and `actorGet`
   gives the segment it runs on. Look at its variables (`actorContext`)
   and its state. If it did not move, stop: the rollout does so.
3. **Move each chart** (`host.migrate({ chart, wake: true, timeout })`),
   one at a time, subscriptions first. While it runs, each round wakes a
   batch of the hibernated actors it asked for, lets the business go on
   for ten minutes of the host's clock, and hibernates back down to the
   resident bound. Size the batch so that the rounds before the timeout
   reach the whole population; the timeout keeps an actor that cannot be
   reached (a payment in flight) from holding the migration open.
4. **Find who is left** on release 1. `migrationDone` counts the actors
   that failed but does not name them, so `leftBehind` asks the host about
   every live actor (`actorList`, then `actorGet` for its segment).
5. **Come back for them** with a migration per session (`retry`): their
   payments have answered by then, and their coupons have run out. Repeat
   until nothing is left.
6. **Check that release 1 is gone:** `hostStats` counts the retired
   segments, and release 1's retires once no actor runs on it.

A migration of a chart the host does not have moves nothing and reports
success, as if the rollout had finished, so step 3 checks each chart's
name with `host.chart` first.

## What is where

| File | What it holds |
|---|---|
| [`charts/subscription-v1.scxml`](charts/subscription-v1.scxml), [`charts/subscription-v2.scxml`](charts/subscription-v2.scxml) | a subscription, release 1 and release 2 |
| [`charts/trial-v1.scxml`](charts/trial-v1.scxml), [`charts/trial-v2.scxml`](charts/trial-v2.scxml) | a free trial, release 1 and release 2 |
| [`billing.mjs`](billing.mjs) | the application: the host, the payment service, the notifications, hibernation, deploys and migrations, the inventory of who runs which release |
| [`rollout.mjs`](rollout.mjs) | the operator's procedure: deploy, canary, each chart, who is left, the second pass |
| [`world.mjs`](world.mjs) | a payment gateway whose answers take time on the simulated clock, and the blob store |
| [`main.mjs`](main.mjs) | four months of business with the rollout on day 45, checked at the end |
| [`test.mjs`](test.mjs) | each case on a `SimulatedClock` on both datamodels, and a small `main.mjs` |

## The tinyactors features it uses, and why

- **Versions and migration** (`host.addCharts` per release,
  `host.migrate` with `chart`, `session`, `wake` and `timeout`): the
  point of the example. A subscription lives for years and its chart
  changes; stopping it would lose its billing history and its timers.
- **`migrated` and `migrationDone`**, handlers of the host: the first
  names each actor moved, the second ends each migration with its counts
  and the sessions its timeout left. The application keeps a record per
  migration id and resolves a promise from `migrationDone`; from
  `migrated` it also sends a coupon it held back for that actor.
- **`error.platform.upgrade`**: release 2 takes the renamed variable and
  starts what a migration does not run (the grace timer).
- **Delayed sends** (`<send id="renewal" delayexpr>`, `<cancel>`): the
  renewal, dunning, grace and trial timers stay in the host across
  hibernation and migration.
- **Invoked services** (`urn:billing:payments`): one invocation per
  charge, answered with `done` or `sendBack` from the gateway's promise;
  an invocation in flight holds its actor's migration.
- **Hibernation** (`host.sweep`, `host.hibernate`, the `wake` handler,
  `host.wake`): most subscriptions spend their month waiting. The wake
  handler tells an event's request (now) from a migration's (queued).
- **Typed methods** for the operator: `actorGet` (which segment, so which
  release), `actorList` (the inventory), `actorContext` and `actorState`
  in the tests, `hostStats` for the resident set and retired segments.
- **Named actors** (`sub-<customer>`, `trial-<customer>`,
  `host.actorByName`) and **spawn params** for each subscription's plan
  and timings; a trial's `trial.converted` spawns its subscription from
  the I/O processor's handler, on the newest release.
- **An I/O processor** (`urn:billing:notify`) for the customer
  notifications.
- **A `SimulatedClock`** everywhere: four months take under a second.
- **Both datamodels**, which differ here: the native one refuses a `Date`
  in a variable, QuickJS keeps it.

The requests pool, which every running charge holds a place of, grows
when the invocations fill it.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/subscription-billing/main.mjs                 # or: bun examples/subscription-billing/main.mjs
node examples/subscription-billing/main.mjs --customers 2000 --trials 400 --resident 300 --datamodel quickjs
```

It prints the rollout as it goes, then what happened and the checks:

```output
day 45: 234 actors, 40 in memory, 194 hibernated
day 45: deployed release 2 as segment 1: new actors are of it from now on
day 45: canary sub-c0111: 1 moved, 0 failed, on release 2
day 45: subscription: migration 2 moved 193, 16 failed, 2 still pending at its timeout
day 45: trial: migration 3 moved 22, 0 failed, 0 still pending at its timeout
day 45: subscription: 17 actors still on an older release
day 45: trial: 0 actors still on an older release
day 120: pass 1: retried the 15 still on release 1 (17 after the rollout): 15 moved, 0 failed

121 days in 379 ms on the native datamodel
rollout: canary sub-c0111 on release 2; subscription 193 moved, 16 failed, 2 pending; trial 22 moved, 0 failed, 0 pending
231 migrated events in all, 209 upgrades seen by the charts; 8 paused on release 2
595 invoices paid (468 by release 2), 84 failed payments, 16 suspensions after a grace period, 27 cancelled, 40 trials converted
memory: 40 of 234 in memory before the rollout, 40 of 213 at the end; 1460 hibernations, 1093 wakes for events, 194 for migrations; 173 blobs stored
segments: 1 live, 1 retired
every charge invoiced once, every invoice numbered in order, nothing left on release 1
```

The 16 that failed hold release 1's coupon stamp; on quickjs none fail.
The checks: every customer was charged exactly what their invoices say,
each customer's invoices are numbered 1, 2, 3, ... across both releases
(no renewal lost or doubled by the migration), the `migrated` events
match the results' counts, no actor is left on release 1, and release 1's
segment is retired.

## Test it

```sh
mise run examples subscription-billing     # under node and bun
node examples/subscription-billing/test.mjs
bun test ./examples/subscription-billing/test.mjs
```

Each case runs on both datamodels on a `SimulatedClock`, with a gateway
the test can hold so a charge stays in flight. A test waits with
`billing.settle()`, which turns until the gateway's due answers have
reached the host, since `host.idle()` does not wait for the payment
service's promises. The last case runs `main.mjs` with 60 customers. All
of it takes under a second.
