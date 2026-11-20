# Inventory sync

Two systems, each its own host: a **warehouse** that owns the stock and a
**storefront** whose customers fill carts. In the demo each runs in its
own process, and they talk over one TCP connection. A cart reserves
units at the warehouse when the customer adds a line. The checkout
confirms the reservations, and a cancel releases them. A reservation
nobody confirms expires. Each of those steps can go wrong:

- **Two carts race for the last unit.** Each SKU is one actor at the
  warehouse, and it takes requests one at a time. The first reserve gets
  the lamp, and the second is refused with `out of stock`. When the
  winner cancels, the lamp is free again.
- **A hold expires.** The warehouse gives a hold `holdFor` (15 minutes by
  default) and then takes the units back and tells the cart, which drops
  the line.
- **The expiry notice is lost.** The cart still thinks it holds the line,
  so its confirm is refused with `reservation expired`. The cart then
  releases every other line and fails the order.
- **The warehouse goes down in the middle of a checkout.** The cart has
  confirmed the tea, and the confirm of the cups finds no connection. The
  storefront's transport fails the send, so the cart gets
  `error.communication`, and it **compensates**: it releases every line,
  the confirmed tea too. While the warehouse is down, each release fails
  at once, and the cart tries again every `backoff`. The warehouse comes
  back from the snapshot it took when it went down. The releases then go
  through, and the cart tries the whole order again with new
  reservations. After `maxAttempts` the order fails. Either way, it fails
  only once everything it held is given back.
- **No answer comes.** Every request the cart waits on has a timeout
  (`replyTimeout`). A cart that stops waiting for a reservation releases
  it, in case the warehouse made it. A reservation answered after the cart
  stopped waiting finds no line, so the cart releases it too.
- **A message is delivered twice.** Every request names its reservation,
  and the warehouse answers a repeated reserve, confirm or release as it
  answered the first, without changing anything. A reservation that ended
  stays closed, so a reserve that comes after its release cannot hold the
  units again. The cart makes a new reservation id for each attempt and
  takes an answer only for the reservation a line waits on, so a duplicate
  answer or a late one changes nothing.
- **A SKU the warehouse does not have.** The warehouse's `host.send`
  refuses the message, and the warehouse tells the storefront over the
  wire (`message.fail`). The storefront's `host.fail` then gives the cart
  `error.communication`.

Whatever happens, the units of each SKU are always its stock plus its
holds plus its sales, and what is sold is what the placed orders hold. The
test checks the first in every case, and the demo checks both at the end.

## What is where

| File | What it holds |
|---|---|
| [`charts/sku.scxml`](charts/sku.scxml) | the warehouse's stock of one SKU: holds, sales, expiry, idempotent requests |
| [`charts/cart.scxml`](charts/cart.scxml) | a cart: its lines, the checkout, the compensation and the retries |
| [`warehouse.mjs`](warehouse.mjs) | the warehouse system: its host, the server it listens on, going down to a snapshot and coming back |
| [`storefront.mjs`](storefront.mjs) | the storefront system: its host, the connection, the customers' requests and notifications |
| [`link.mjs`](link.mjs) | what both share: the transport over one socket, the receiving side, and faults to inject |
| [`warehouse-main.mjs`](warehouse-main.mjs) | the warehouse as a process of its own, for the demo |
| [`main.mjs`](main.mjs) | the demo: the warehouse in a child process, the storefront here, on the real clock |
| [`test.mjs`](test.mjs) | each case with both systems in this process, on a `SimulatedClock`, on both datamodels; then the demo |

## The wire

The connection uses [remote-python](../remote-python/README.md#the-wire)'s
wire, and `link.mjs` imports that example's framing: a 4-byte big-endian
length, then one CBOR item, written by `encode` and read by `decode`. Each
item is `{method, params}`:

| `method` | `params` | The receiver |
|---|---|---|
| `message.send` | the transport's `send.message` as it is, `encode` writing its `target` and `origin` as tag 32 | `host.send(params)`, unchanged; if it throws, answers `message.fail` |
| `message.fail` | `{sender, sendid}`: the `origin` and `sendid` of a message it could not deliver | `host.fail(sender, sendid)`, when `sender` is an address of its own system |

The warehouse listens, and the storefront connects. Each side's transport
writes the sends for the other system on the same connection, so the
warehouse's answers to `_event.origin` (a cart's address,
`tinyactors://storefront/#_scxml_3`) go back on it. A side with no
connection fails each send at once, which is how a cart learns that the
warehouse is down. The sockets set `setNoDelay(true)`: every frame is
small and is waited on, and with Nagle's algorithm a frame that answers a
frame waits for the delayed acknowledgement.

## The tinyactors features it uses, and why

- **Two systems and a transport** (`system`, `transport`, `send.message`,
  `host.send(message)`, `host.fail`): the warehouse and the storefront are
  separate applications, and an actor of one addresses an actor of the
  other as `tinyactors://warehouse/@sku-tea`. The host decides which
  sends leave the system. The wire, the connection and what to do when it
  is gone are the application's.
- **`Address`** for the transport's `target` and `origin`: `target.system`
  picks the connection, and `encode` writes it as tag 32, which `decode`
  reads back as an `Address`.
- **Named actors** (`host.spawn('sku', { name: 'sku-tea' })`,
  `host.actor(name)`): a SKU's address is its name, and the storefront
  finds a cart by the customer's cart id.
- **`error.communication`** from `send.fail()` (no connection) and from
  `host.fail()` (the other side refused the message), which the cart's
  chart turns into its compensation.
- **Delayed sends and `<cancel>`**: the expiry of a hold
  (`<send delayexpr="holdFor" idlocation>`, cancelled by a confirm or a
  release), the cart's timeouts, its backoff between releases, and its
  pause before a retry.
- **`idlocation` and `_event.sendid`**: a cart keeps the id of each
  reserve it sends, so an `error.communication` names the line that
  failed.
- **Eventless transitions** end a checkout when its last line is
  confirmed, and end a compensation when its last line is released.
- **Snapshots** (`host.snapshot()`, `Host.restore`): the warehouse goes
  down for maintenance with holds and timers pending, and comes back with
  them. The restored host's clock goes on from the snapshot's time, so a
  hold does not age while the warehouse is down. A warehouse that crashed
  without a snapshot would need its own database, which is out of scope
  here: a snapshot is not a backup ([snapshots](../../docs/guide/snapshots.md)).
- **I/O processors** (`urn:shop:customer`, `urn:warehouse:stock`): each
  step the customer sees, and each change of stock, reaches the
  application.
- **Typed methods** (`actorList`, `actorContext`): the
  warehouse reads its inventory from the SKU actors' variables.
- **A `SimulatedClock` shared by two hosts** in the test: a 15-minute hold
  and the retries take no time, and the test steps to the next deadline of
  either host.
- **Both datamodels**: the test runs every case on the native datamodel
  and on quickjs.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/inventory-sync/main.mjs        # or: bun examples/inventory-sync/main.mjs
node examples/inventory-sync/main.mjs --out /tmp/inventory --quiet
```

The demo starts `warehouse-main.mjs` as a child process. It prints each
change of stock the warehouse reports and each notification a cart sends.
Midway it kills the warehouse with `SIGTERM`, starts it again from its
snapshot (in `--out`, or in a new temporary directory), and ends with the
inventory and its reconciliation. It takes about three seconds.

## Test it

```sh
mise run examples inventory-sync     # under node and bun
node --test examples/inventory-sync/test.mjs
bun test ./examples/inventory-sync/test.mjs
```

Each case makes a warehouse and a storefront in one process, connected
over a TCP connection on a port the system picks. They share one
`SimulatedClock`. The faults are injected where a frame is written: a
frame dropped, written twice, or the connection lost instead. Before each
check, the test waits until both hosts are idle and every frame written
has been read on the other side. The last case runs the demo in two
processes. All of it takes about four seconds.
