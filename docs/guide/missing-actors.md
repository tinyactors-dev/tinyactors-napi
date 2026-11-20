# When the actor is not there

A send names an actor that may not be in memory, or may not exist at
all. What the host does depends on which:

- **The actor is hibernated:** the host keeps the event in its queue
  and wakes it (with a `store`, it loads the blob itself), and the event
  runs as if the actor had never left. A send to a name finds a
  hibernated actor as it finds a resident one.
- **No actor has that name or session** (it was never spawned, or it
  ended): the sender gets `error.communication` at once, in the same run,
  with the send's `sendid`. An `actor.send` or `host.send` from your
  program throws `StaleError` instead.
- **The address is another system's:** the send goes to your
  `transport` ([Other systems](other-systems.md)), and whether it arrives
  is your transport's to say.

What to do about the second case is application logic, chosen per kind
of actor: the package offers no fallback, no queue of undelivered events
and no spawn on a miss. There are three ways, and an application usually
uses all three, each for its own kind of actor.

## The actor never ends, and hibernates

For an actor that stands for something long-lived (a workspace, a room,
an account), make it never end: give it no top-level `<final>`. It is
then always there to send to, by its name, and a host with a `store` and
a `resident` bound keeps it in memory only while it works. An idle actor
costs its blob in your store, nothing in memory
([Hibernation](hibernation.md)).

```js
import { compileCharts, Host, MemoryStore } from '@tinyactors/node';

const compiled = compileCharts([
  { name: 'room.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="room" initial="open">
    <datamodel><data id="said" expr="0"/></datamodel>
    <state id="open">
      <transition event="post">
        <assign location="said" expr="said + 1"/>
        <log expr="'the room has had ' + said + ' messages'"/>
      </transition>
    </state>
  </scxml>` },
  { name: 'member.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="member" initial="s">
    <state id="s">
      <transition event="say"><send event="post" target="tinyactors://chat/@room.acme.general"/></transition>
    </state>
  </scxml>` },
]);
const store = new MemoryStore();
const host = new Host(compiled, { system: 'chat', store, resident: 1, log: (entry) => console.log(entry.text) });
compiled.close();

const room = host.spawn('room', { name: 'room.acme.general' });
const member = host.spawn('member');
await host.idle();
console.log('the room is in the store:', store.blobs.has(room.id));
member.send('say');
member.send('say');
await host.idle();
console.log('the room is in the store:', store.blobs.has(room.id));
host.close();
```

```output
the room is in the store: true
the room has had 1 messages
the room has had 2 messages
the room is in the store: true
```

The member never learns that the room was hibernated: the host loaded it
for the first `post`, and hibernated it again once the turn was done.
Use this way when the set of actors is known (made by your program or by
a collection actor, below) and each is worth keeping until it is deleted
on purpose.

## The application routes it

For an actor made on demand, or for something that is not an actor at
all (a user who may be offline), send to an **I/O processor** instead of
to the actor. Your processor looks the actor up with `send.host.actor`,
makes it when it is missing, and forwards the event, with the sender's
address as its `origin` so the actor can answer the sender directly:

```js
import { compileCharts, Host, StaleError } from '@tinyactors/node';

const compiled = compileCharts([
  { name: 'cart.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="cart" initial="open">
    <datamodel><data id="items" expr="[]"/></datamodel>
    <state id="open">
      <transition event="add">
        <assign location="items" expr="[...items, _event.data.sku]"/>
        <send event="added" targetexpr="_event.origin"><content expr="items.length"/></send>
      </transition>
    </state>
  </scxml>` },
  { name: 'shopper.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="shopper" initial="s">
    <state id="s">
      <transition event="buy">
        <send type="carts" event="add" targetexpr="'cart.' + _event.data.customer"><content expr="_event.data"/></send>
      </transition>
      <transition event="added"><log expr="'the cart holds ' + _event.data"/></transition>
    </state>
  </scxml>` },
]);

/** The carts processor: the cart named by the send's target, made when it is not there. */
const carts = {
  receive(send) {
    let cart;
    try {
      cart = send.host.actor(send.target);
    } catch (error) {
      if (!(error instanceof StaleError)) throw error;
      cart = send.host.spawn('cart', { name: send.target });
      console.log(`made ${send.target}`);
    }
    cart.send(send.event, send.data, { origin: send.sender.address });
  },
};
const host = new Host(compiled, { system: 'shop', ioProcessors: { carts }, log: (entry) => console.log(entry.text) });
compiled.close();

const shopper = host.spawn('shopper');
shopper.send('buy', { customer: 'ada', sku: 'tea' });
shopper.send('buy', { customer: 'ada', sku: 'cake' });
await host.idle();
host.close();
```

```output
made cart.ada
the cart holds 1
the cart holds 2
```

The lookup, the spawn and the forward are your program's, so the policy
is too: refuse instead of spawning, read the actor's starting state from
your database, or queue the event while something else makes the actor.
When which actors may exist is itself a decision with rules (only an
owner makes a room, two rooms may not share a name), keep the decision
in a chart: a **collection actor** that never ends receives the
requests, checks them, and makes the actors with the package's
`Spawner` ([I/O processors](io-processors.md#spawning-from-a-chart)).
The processor then only forwards to the collection.

The same way serves what is not an actor: a processor for direct
messages looks up the user's open connections and forwards to each, or
stores the message when there are none.

## The sender handles error.communication

For an actor that ends (a connection, a job, an order), a send after its
end is a fact the sender should see. The sender gets `error.communication`
with the send's `sendid` at once, and a transition on it decides: tell
the user, retry elsewhere, or give up.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'client.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
    datamodel="ecmascript" name="client" initial="s">
  <state id="s">
    <transition event="join">
      <send id="join" event="join" targetexpr="'tinyactors://chat/@room.acme.' + _event.data"/>
    </transition>
    <transition event="error.communication" cond="_event.sendid === 'join'">
      <log expr="'no such room'"/>
    </transition>
  </state>
</scxml>` }]);
const host = new Host(compiled, { system: 'chat', log: (entry) => console.log(entry.text) });
compiled.close();

const client = host.spawn('client');
client.send('join', 'nowhere');
await host.idle();
host.close();
```

```output
no such room
```

A send to a session that ended, or to a name no actor has, fails this
way. A send to another system's address does not fail here: it reaches
your transport, which fails it (`send.fail()`, or `host.fail` from the
other side) when it learns the actor is not there.

## Which way, for which actor

| The actor | The way | In the chat example |
|---|---|---|
| long-lived, a known set (a workspace, a room, an account) | it never ends and hibernates | workspaces and rooms |
| made on demand, or not an actor at all (a cart, a user who may be offline) | your I/O processor routes it | direct messages (`chat:inbox`), rooms made by their workspace |
| short-lived, ends on its own (a connection, a job) | the sender handles `error.communication` | a join of a room that does not exist |

The chat example (`examples/chat-rooms/` in the repository) uses all
three, and its README says where.

## Names that need no encoding

A name is written into addresses: `tinyactors://chat/@<name>` in a
chart's `target`, in a processor's lookup, in your logs. An address's
name is made of the characters RFC 3986 calls unreserved, `A`-`Z`,
`a`-`z`, `0`-`9`, `-`, `.`, `_` and `~`, and any other byte is
percent-encoded (core's address grammar: `is_unreserved` and the name's
check in `src/base/address.c` of tinyactors-core). `Address.fromName`
encodes for you, but a name like `room/general` is then
`room%2Fgeneral` in every address, and a chart that writes it as it
reads is not sending to an address at all:

```js
import { Address, compileCharts, Host } from '@tinyactors/node';

console.log(Address.fromName('chat', 'room/general').text);
console.log(Address.fromName('chat', 'room.acme.general').text);

const compiled = compileCharts([
  { name: 'room.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="room"><state id="s"/></scxml>` },
  { name: 'poster.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="poster" initial="s">
    <state id="s">
      <onentry><send id="raw" event="post" target="tinyactors://chat/@room/general"/></onentry>
      <transition event="error.communication"><log expr="'error.communication for ' + _event.sendid"/></transition>
    </state>
  </scxml>` },
]);
const host = new Host(compiled, { system: 'chat', log: (entry) => console.log(entry.text) });
compiled.close();
host.spawn('room', { name: 'room/general' });
host.spawn('poster');
await host.idle();
console.log(host.actor('room/general').address.text);
host.close();
```

```output
tinyactors://chat/@room%2Fgeneral
tinyactors://chat/@room.acme.general
error.communication for raw
tinyactors://chat/#_scxml_1
```

So choose a convention that needs no encoding: the kind of actor and its
ids joined by `.`, each id of lowercase letters, digits and `-`
(`room.acme.general`, `workspace.acme`, `cart.ada`), and check an id
that comes from a user before it becomes part of a name. The system's
own id is stricter still: lowercase letters, digits, `-` and `.`.

Two more reasons for names with parts. An actor spawned with no name is
found by its chart's name (core's `src/system/system.c` indexes an
unnamed spawn under its chart's name), and an invoked child by its
invoke id (`src/system/route.c`): a name `room` would find any unnamed
actor of the chart `room`, and a name `cart` the child of an `<invoke
id="cart">`. `room.acme.general` equals neither a chart's name nor an
invoke id. A name has one owner, the collection actor that spawns it:
[Spawning from a chart](io-processors.md#spawning-from-a-chart).

## Keying a table by the sender

An actor that keeps a table of the actors that send to it (a room's
members, a workspace's pending requests) keys it by `_event.origin`, the
sender's address. Core writes one sender's origin in two forms:

- `#_scxml_2`, the address's fragment alone, when the send stayed in the
  sender's segment of the host: a send to a session's address
  (`#_scxml_<n>`, or the full address of a session of the same system),
  to `#_parent`, to an invoked child, and a delayed send among them;
- `tinyactors://chat/#_scxml_2`, the full address, when the host routed
  the send: a send to a name (`@room.acme.general`), to a session in
  another segment, or from another system (whatever origin its
  transport passes, which is the full address when it passes the
  sender's `origin` on).

Both name the same sender, so **key a table by the origin's fragment**,
from `#` on. A chart-level `<script>` holds the helper, and the
expressions call it with the origin:

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([
  { name: 'room.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="room" initial="open">
    <script>
      /** The sender's key: its address from the "#" on, whichever form the origin has. */
      function sender(origin) { return origin.slice(origin.indexOf('#')); }
    </script>
    <datamodel><data id="members" expr="({})"/></datamodel>
    <state id="open">
      <transition event="join">
        <assign location="members" expr="({ ...members, [sender(_event.origin)]: _event.data })"/>
        <log expr="_event.origin + ' is ' + sender(_event.origin) + ': ' + Object.keys(members).length + ' member'"/>
      </transition>
    </state>
  </scxml>` },
  { name: 'member.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="member" initial="s">
    <state id="s">
      <transition event="join"><send event="join" targetexpr="_event.data"><content expr="'ada'"/></send></transition>
    </state>
  </scxml>` },
]);
const host = new Host(compiled, { system: 'chat', log: (entry) => console.log(entry.text) });
compiled.close();

const room = host.spawn('room', { name: 'room.acme.general' });
const member = host.spawn('member');
member.send('join', room.address.text);                   // by its session
await host.idle();
member.send('join', 'tinyactors://chat/@room.acme.general'); // by its name
await host.idle();
host.close();
```

```output
#_scxml_2 is #_scxml_2: 1 member
tinyactors://chat/#_scxml_2 is #_scxml_2: 1 member
```

The fragment is a key, and a target too: `<send targetexpr="key">`
reaches the sender from any segment of the host.

**Where the system matters, key by the full address.** A table that
holds senders of other systems as well (a directory that answers
several hosts) must keep the system, and an origin from another system
always names it. There, complete a fragment with the actor's own
system, which its own address, `_ioprocessors.scxml.location`, holds:

```xml
<script>
  /** The sender's full address; `self` is _ioprocessors.scxml.location. */
  function senderAddress(origin, self) {
    return origin.startsWith('#_scxml_') ? self.slice(0, self.indexOf('#')) + origin : origin;
  }
</script>
<assign location="members" expr="({ ...members, [senderAddress(_event.origin, _ioprocessors.scxml.location)]: _event.data })"/>
```

An event from a service your program runs (`invocation.sendBack`) has
the origin `#_<invokeid>`, which names that invocation in this actor
only: either helper leaves it as it is.
