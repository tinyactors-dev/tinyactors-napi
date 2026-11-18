# Other systems

A host is one **system**, named by its `systemID`. An actor of one system
can send to an actor of another (another host, in this process or on
another machine) by its address, `tinyactors://<systemID>/...`. The host
decides whether an address is its own. A send to another system goes to
your **transport**, a handler that carries it there; the other side
gives it to its host with `host.send`. The transport and the wire are
yours: a socket, a queue, HTTP, a worker's `postMessage`.

## Two systems

Each send to another system reaches the `transport` handler as a `Send`.
Its `target` and `origin` are `Address`es, and its `message` is the
outgoing half, an object of `target`, `event`, `data`, `sendid`,
`origin` and `traceparent` (`null` for a field the send lacks), which
the receiving side passes to `host.send(message)` as it is, in this
process or in another binding's: a Python host takes it too. On a wire,
`encode` writes the message as it is, its addresses as CBOR's tag 32 (as
a Python host's `encode` does), and `decode` reads them back as
`Address`es. (`JSON.stringify` writes an `Address` as its text, so a
message goes through JSON as it is: see "Addresses" below.)

```js
import { Address, compileCharts, decode, encode, Host } from '@tinyactors/node';

const shopChart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="checkout" initial="paying">
  <state id="paying">
    <onentry>
      <send event="charge" target="tinyactors://bank/@teller"><param name="amount" expr="12"/></send>
    </onentry>
    <transition event="approved" target="done"><log expr="'approved by ' + _event.origin"/></transition>
  </state>
  <final id="done"/>
</scxml>`;
const bankChart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="teller" initial="open">
  <state id="open">
    <transition event="charge">
      <log expr="'charging ' + _event.data.amount + ' for ' + _event.origin"/>
      <send event="approved" targetexpr="_event.origin"/>
    </transition>
  </state>
</scxml>`;

const image = (name, text) => {
  const compiled = compileCharts([{ name, text }]);
  const bytes = compiled.image;
  compiled.close();
  return bytes;
};

// The wire: bytes in a queue, delivered on a later turn of the event loop.
const hosts = {};
const wire = (message) => {
  const bytes = encode(message);
  setTimeout(() => {
    const received = decode(bytes);
    hosts[received.target.system].send(received);
  });
};

const log = (host, entry) => console.log(entry.text);
hosts.shop = new Host({ systemID: 'shop' }, { log, transport: (host, send) => wire(send.message) });
hosts.bank = new Host({ systemID: 'bank' }, { log, transport: (host, send) => wire(send.message) });
hosts.shop.addImage(image('checkout.scxml', shopChart));
hosts.bank.addImage(image('teller.scxml', bankChart));

hosts.bank.spawn(hosts.bank.chart('teller'), { name: 'teller' });
hosts.shop.spawn(hosts.shop.chart('checkout'));
await new Promise((resolve) => setTimeout(resolve, 50));
await Promise.all([hosts.shop.idle(), hosts.bank.idle()]);
hosts.shop.close();
hosts.bank.close();
```

```output
charging 12 for tinyactors://shop/#_scxml_1
approved by tinyactors://bank/#_scxml_1
```

The receiver answers to `_event.origin`, which is the sender's full
address, so the answer goes back through the bank's transport.

**A send that cannot be delivered** is the transport's to report. While
the handler runs, `send.fail()` does it. Later, on the sending host,
`host.fail(sender, sendid)` does, where `sender` is the message's
`origin` (the actor that sent it, not its target): the sender gets
`error.communication` with that `sendid`.
Delivery that worked needs no answer. Without a `transport` handler, each
send to another system is failed.

**An input's target may be an address.** `host.send` takes a session, an
address string or an `Address`; a local address (`tinyactors://shop/@teller`
on the host named `shop`) is resolved by the host to its actor. A message's
`origin` is the sender's address as the other side gave it, and becomes
the event's `_event.origin`.

## Over a socket

Across processes, a transport writes each message as a frame on a
connection. Over TCP, call `socket.setNoDelay(true)` on both ends: the
frames are small, and an answer is often a frame too, so with Nagle's
algorithm on (Node.js's default) a second small write waits for the
peer's delayed acknowledgement, about 40 ms on Linux's loopback, before
it leaves. (Python's asyncio turns it off by itself.) Here each frame is
four bytes of length and the message's CBOR:

```js
import { connect, createServer } from 'node:net';
import { decode, encode, Host } from '@tinyactors/node';

/** Calls `receive` with each message the frames on `socket` hold. */
function frames(socket, receive) {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
      const length = buffered.readUInt32BE(0);
      receive(decode(buffered.subarray(4, 4 + length)));
      buffered = buffered.subarray(4 + length);
    }
  });
}
const frame = (message) => {
  const body = encode(message);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};

let toBank;
let toShop;
const log = (host, entry) => console.log(entry.text);
const shop = new Host({ systemID: 'shop' }, { log, transport: (host, send) => toBank.write(frame(send.message)) });
const bank = new Host({ systemID: 'bank' }, { log, transport: (host, send) => toShop.write(frame(send.message)) });
shop.addCharts({ 'checkout.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="checkout">
  <state id="paying">
    <onentry><send event="charge" target="tinyactors://bank/@teller"/></onentry>
    <transition event="approved" target="done"><log expr="'approved'"/></transition>
  </state>
  <final id="done"/>
</scxml>` });
bank.addCharts({ 'teller.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="teller">
  <state id="s"><transition event="charge"><log expr="'charging ' + _event.origin"/><send event="approved" targetexpr="_event.origin"/></transition></state>
</scxml>` });

// The bank listens on a port of the system's choosing; the shop connects.
const server = createServer((socket) => {
  socket.setNoDelay(true);
  toShop = socket;
  frames(socket, (message) => bank.send(message));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
toBank = connect(server.address().port, '127.0.0.1');
toBank.setNoDelay(true);
frames(toBank, (message) => shop.send(message));
await new Promise((resolve) => toBank.once('connect', resolve));
await new Promise((resolve) => setImmediate(resolve)); // the server's side of the connection

bank.spawnChart('teller', { name: 'teller' });
const order = shop.spawnChart('checkout', { name: 'order' });
while (shop.actorByName('order') !== undefined) await new Promise((resolve) => setTimeout(resolve, 5));
console.log('order', order, 'ended');
toBank.end();
server.close();
shop.close();
bank.close();
```

```output
charging tinyactors://shop/#_scxml_1
approved
order 1n ended
```

A frame that cannot be written, or a peer that is gone, is the transport's
to report: `send.fail()` while its handler runs, `host.fail(origin,
sendid)` after.

## Addresses

`new Address(text)` reads an address; its `system`, `session` (a
`bigint`) and `name` are its parts, `undefined` for a part the text
lacks. `Address.fromSession(system, session)` and `Address.fromName(system,
name)` make one, and `toString()` gives the text:

```js
import { Address } from '@tinyactors/node';

const bySession = Address.fromSession('shop', 42n);
const byName = Address.fromName('shop', 'front desk');
console.log(bySession.text, bySession.system, bySession.session);
console.log(byName.text, byName.name);
console.log(new Address('not an address').system);
```

```output
tinyactors://shop/#_scxml_42 shop 42n
tinyactors://shop/@front%20desk front desk
undefined
```

`JSON.stringify` writes an address as its text (`address.toJSON()`), and
`new Address(text)` reads it back, so a transport's `send.message` goes
through JSON and into the other side's `host.send` as it is:

```js
import { Address, Host } from '@tinyactors/node';

let wire;
const shop = new Host({ systemID: 'shop' }, { transport: (host, send) => { wire = JSON.stringify(send.message); } });
const bank = new Host({ systemID: 'bank' }, { log: (host, entry) => console.log(entry.text) });
shop.addCharts({ 'checkout.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="checkout">
  <state id="s"><onentry><send event="charge" target="tinyactors://bank/@teller"><param name="amount" expr="12"/></send></onentry></state>
</scxml>` });
bank.addCharts({ 'teller.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="teller">
  <state id="s"><transition event="charge"><log expr="'charge ' + _event.data.amount + ' from ' + _event.origin"/></transition></state>
</scxml>` });
bank.spawnChart('teller', { name: 'teller' });
shop.spawnChart('checkout');
await shop.idle();

const message = JSON.parse(wire); // its addresses are strings
console.log(typeof message.target, message.target);
bank.send(message);
await bank.idle();
console.log(new Address(message.origin).session);
shop.close();
bank.close();
```

```output
string tinyactors://bank/@teller
charge 12 from tinyactors://shop/#_scxml_1
1n
```

Inside event data an address is plain text: values have no address type.

## SCXML's BasicHTTP

SCXML defines an HTTP processor, BasicHTTP, whose events travel as form
posts. The package has its codec, for an I/O processor or a server of
your own: `encodeHTTPPost({ url, event, fields, body })` writes the
request a send makes, as bytes for a socket, and
`parseHTTPRequest(bytes)` reads an incoming request's event (its
`_scxmleventname` field, or `HTTP.<METHOD>`) and its form fields.

```js
import { encodeHTTPPost, parseHTTPRequest } from '@tinyactors/node';

const request = encodeHTTPPost({
  url: 'http://localhost:8080/scxml',
  event: 'order.placed',
  fields: [{ name: 'sku', value: 'tea' }, { name: 'qty', value: '2' }],
});
console.log(new TextDecoder().decode(request).split('\r\n')[0]);

const incoming = parseHTTPRequest(request);
console.log(incoming.method, incoming.target, incoming.event);
console.log(incoming.fields.map(({ name, value }) => `${name}=${value}`).join(' '));
```

```output
POST /scxml HTTP/1.1
POST /scxml order.placed
sku=tea qty=2
```

The host does no HTTP itself: sending the bytes and serving the port are
your program's.
