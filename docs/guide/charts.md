# Writing charts

A chart is an SCXML document whose data and expressions are JavaScript.
This guide covers what a chart can hold on this package's datamodel: the
variables and expressions, scripts, XML data, how several charts become
one image, a chart that starts another, and a system that starts its
actors itself. The README's [Concepts](../../README.md#concepts) come
first.

## Variables and expressions

A chart's variables are its `<data>` elements. Each `expr` is evaluated
once, when the actor starts, unless `spawn`'s `params` give the variable
another value ([README](../../README.md#starting-an-actor-with-data)).
Every expression in the chart (`cond`, `expr`, `<log expr>`, `<script>`)
sees the variables by name, plus these:

| Name | What it holds |
|---|---|
| `_event` | the event being handled: `name`, `data`, `type` (`'external'`, `'internal'` or `'platform'`), `sendid`, `origin`, `origintype`, `invokeid`, and `raw` when an I/O processor's answer gave one |
| `_sessionid` | the actor's session, as a string |
| `_name` | the actor's name, or its chart's name when it has none |
| `_ioprocessors` | the I/O processors, by type; `_ioprocessors.scxml.location` is the actor's address |
| `In(id)` | whether state `id` is active |

An expression is ordinary JavaScript: arrow functions, template strings,
`JSON.stringify`, methods of arrays and strings. It cannot assign to a
name the chart does not declare, nor to `_event` or the system variables:
that raises `error.execution`, as an expression that throws does.

```js
import { compileCharts, Host } from '@tinyactors/node';

const chart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="thermostat" initial="running">
  <datamodel>
    <data id="readings" expr="[]"/>
    <data id="target" expr="20"/>
  </datamodel>
  <parallel id="running">
    <state id="heater" initial="off">
      <state id="off">
        <onentry><log expr="'heater off'"/></onentry>
        <transition event="reading" cond="_event.data.celsius &lt; target" target="on"/>
      </state>
      <state id="on">
        <onentry><log expr="'heater on'"/></onentry>
        <transition event="reading" cond="_event.data.celsius &gt;= target" target="off"/>
      </state>
    </state>
    <state id="recorder">
      <transition event="reading">
        <assign location="readings" expr="[...readings, _event.data.celsius].slice(-3)"/>
        <log expr="_event.data.celsius + '°C, last ' + readings.join(' ') + ', heating: ' + In('on')"/>
      </transition>
      <transition event="typo"><assign location="tagret" expr="21"/></transition>
      <transition event="error.execution"><log expr="'that was an error.execution'"/></transition>
    </state>
  </parallel>
</scxml>`;

const compiled = compileCharts([{ name: 'thermostat.scxml', text: chart }]);
const host = new Host({ systemID: 'home' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();

const thermostat = host.spawn(host.chart('thermostat'));
for (const celsius of [18, 19, 21]) host.send(thermostat, 'reading', { celsius });
host.send(thermostat, 'typo');
await host.idle();
host.close();
```

```output
heater off
18°C, last 18, heating: false
heater on
19°C, last 18 19, heating: true
21°C, last 18 19 21, heating: false
heater off
that was an error.execution
```

XML needs `&lt;` for `<` and `&amp;` for `&` inside an attribute. The
`<parallel>` holds two regions, both active at once, and a `reading`
event is handled by both, in one step: the states a transition leaves
are exited first, then every transition's actions run, then the new
states are entered. So `In('on')` in the recorder is true only when the
heater stays on: at 18°C the heater is turning on, and the recorder logs
`heating: false` before the heater's `heater on`. The `typo` event assigns to
`tagret`, which the chart never declared.

## Scripts

`<script>` runs statements: in a transition, in `<onentry>`, or at the top
of the chart, once when an actor starts. A chart-level script is where a
chart's helper functions go, and how it declares them decides what each
actor costs.

**A script in a transition, `<onentry>` or `<onexit>` runs in a block**,
as a function body would: its top-level `let`, `const` and `class` are
its own at each run, so it runs again and again, and they declare nothing
for the chart. Its `var`s are the actor's, as a chart-level script's are.

**A script that declares nothing** (no top-level `var`, `function`,
`let`, `const` or `class` in a chart-level script, no `var` or `function`
in one in executable content) runs in a context the host shares between the
actors of every such chart. Hold a helper function in a `<data>` and
assign it:

```js
import { compileCharts, Host } from '@tinyactors/node';

const chart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="basket" initial="open">
  <datamodel>
    <data id="items" expr="[]"/>
    <data id="price"/>
  </datamodel>
  <script>
    price = (sku) => ({ tea: 4, cake: 7 })[sku] ?? 0;
  </script>
  <state id="open">
    <transition event="add"><script>items.push(_event.data.sku)</script></transition>
    <transition event="checkout" target="closed">
      <log expr="'total ' + items.map(price).reduce((a, b) => a + b, 0)"/>
    </transition>
  </state>
  <final id="closed"/>
</scxml>`;

const compiled = compileCharts([{ name: 'basket.scxml', text: chart }]);
const host = new Host({ systemID: 'shop' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();

const basket = host.spawn(host.chart('basket'));
for (const sku of ['tea', 'cake', 'tea']) host.send(basket, 'add', { sku });
host.send(basket, 'checkout');
await host.idle();
host.close();
```

```output
total 15
```

**A script that declares top-level names** (`function price(sku) {...}`)
gets a `vm` context for each actor, where the script runs as global code
and its functions close over its own variables, as they would in a file.
That costs about 143 KB an actor on Node.js and 60 KB on Bun, so keep it
for charts with few actors. Such a chart's actors can still be
hibernated, migrated and snapshotted when it declares with `var` and
`function`; one that declares with `let`, `const` or `class` keeps its
actors in memory, because a new context cannot be given those bindings
back.

A function held in a variable keeps its actor in memory too: hibernation
stores the variables as values, and a function is not one. So the
`basket` above cannot be hibernated, while a chart that declares its
helpers with `function` in a script can, at the cost of its context.

## Sending events

`<send>` is how an actor talks to anything: itself, another actor, an I/O
processor, a service. Its attributes, each with an `...expr` form that
computes it:

| Attribute | What it gives | Default |
|---|---|---|
| `event`, `eventexpr` | the event's name | required |
| `target`, `targetexpr` | where it goes: an address, `#_scxml_<session>`, `#_parent`, `#_<invokeid>`, `#_internal` | the actor itself, at the back of its queue |
| `type`, `typeexpr` | the I/O processor ([I/O processors](io-processors.md)) | SCXML's own, between actors |
| `id`, `idlocation` | the send's id, for `<cancel>` and the answer's `_event.sendid`; `idlocation` names a declared `<data>` that gets a generated id, unique in the actor's session only (every session's first is `send.1`) | none |
| `delay`, `delayexpr` | when: `500ms`, `1.5s`, `30s` | now |
| `namelist` | variables whose names and values become the data | none |

The data is `<param name expr>`s and `namelist` (an object), or one
`<content expr>` (any value). `#_internal` puts the event in the actor's
internal queue, which runs before anything waiting outside, as `<raise>`
does.

```js
import { compileCharts, Host } from '@tinyactors/node';

const sender = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="sender" initial="s">
  <datamodel>
    <data id="qty" expr="2"/>
    <data id="sku" expr="'tea'"/>
    <data id="lastid"/>
    <data id="peer" expr="'#_scxml_2'"/>
  </datamodel>
  <state id="s">
    <onentry>
      <send event="self.order" namelist="qty sku" idlocation="lastid"/>
      <send event="self.note" target="#_internal"/>
      <send eventexpr="'hello.' + sku" targetexpr="peer"/>
      <log expr="'the order went out as ' + lastid"/>
    </onentry>
    <transition event="self.*"><log expr="_event.name + ' (' + _event.type + ') ' + JSON.stringify(_event.data)"/></transition>
  </state>
</scxml>`;
const receiver = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="receiver" initial="s">
  <state id="s"><transition event="hello"><log expr="'receiver got ' + _event.name"/></transition></state>
</scxml>`;

const compiled = compileCharts([{ name: 'sender.scxml', text: sender }, { name: 'receiver.scxml', text: receiver }]);
const host = new Host({ systemID: 'demo' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('sender'));
host.spawn(host.chart('receiver'));
await host.idle();
host.close();
```

```output
the order went out as send.1
receiver got hello.tea
self.note (internal) undefined
self.order (external) {"qty":2,"sku":"tea"}
```

`idlocation` must name a declared `<data>`, as every assignment must;
otherwise the `<send>` fails with `error.execution` and nothing is sent.

## XML data

A `<data>` whose content is XML holds a document, a small DOM of the
package's own (neither Node.js nor Bun has a `DOMParser`). Its nodes have
`nodeType`, `nodeName`, `nodeValue`, `attributes`, `childNodes`,
`firstChild`, `lastChild`, `parentNode` and `textContent`; a document
has `documentElement`; and every node has `getElementsByTagName(name)`
(an array, `'*'` for every element), `getAttribute(name)` and
`hasAttribute(name)`:

```js
import { compileCharts, Host } from '@tinyactors/node';

const chart = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="menu" initial="s">
  <datamodel>
    <data id="catalog">
      <prices xmlns=""><price sku="tea">4</price><price sku="cake">7</price></prices>
    </data>
  </datamodel>
  <state id="s">
    <onentry>
      <foreach array="catalog.getElementsByTagName('price')" item="node" index="i">
        <log expr="(i + 1) + '. ' + node.getAttribute('sku') + ' ' + node.textContent"/>
      </foreach>
    </onentry>
  </state>
</scxml>`;

const compiled = compileCharts([{ name: 'menu.scxml', text: chart }]);
const host = new Host({ systemID: 'shop' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('menu'));
await host.idle();
host.close();
```

```output
1. tea 4
2. cake 7
```

An actor whose variable holds a DOM stays in memory: hibernation and
snapshots refuse it. A DOM that leaves the chart for your program (the
`<content>` of a `<send>` to an I/O processor, a value `actorContext`
reads) reaches it as its XML text, a string: the text a document was read
from, or a node written out, on both datamodels.

## Several charts in one image

`compileCharts` takes a list of documents, each `{ name, text }`, and
compiles them into one image. Each chart is known by its `<scxml name>`;
`host.chart(name)` finds it. The `name` of a document is what error
messages and `src` attributes name.

A chart may read another document through `src`: `<invoke
src="child.scxml">`, `<script src>`, `<data src>`. A document in the list
answers a `src` with its name. For the others, give `compileCharts` a
**resolver**, a function `(base, source) => text` called during the
compile for each `src` it does not have (`base` is the document that
names it). It may read a file, a map or a database. To refuse, it throws
a `ResolveError`, which becomes a compile error at the line and column
you give:

```js
import { compileCharts, CompileError, ResolveError } from '@tinyactors/node';

const files = { 'child.scxml': '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" name="child"><final id="f"/></scxml>' };
const resolver = (base, source) => {
  if (!(source in files)) throw new ResolveError(`${base} asks for ${source}, which is not in the store`, { line: 1, column: 1 });
  return files[source];
};

const parent = (src) => `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" name="parent">
  <state id="s"><invoke src="${src}"/></state>
</scxml>`;

const compiled = compileCharts([{ name: 'parent.scxml', text: parent('child.scxml') }], resolver);
console.log('compiled', compiled.image.length > 0);
compiled.close();

try {
  compileCharts([{ name: 'parent.scxml', text: parent('missing.scxml') }], resolver);
} catch (error) {
  if (!(error instanceof CompileError)) throw error;
  console.log(error.message);
}
```

```output
compiled true
missing.scxml:1:1: error: parent.scxml asks for missing.scxml, which is not in the store
```

Any other error a resolver throws (a file that cannot be read) is thrown
from `compileCharts` as it is.

**The compile result.** `compileCharts` returns an object whose `image`
is a `Buffer`, yours from the first read, and whose `diagnostics` lists
the compiler's warnings. `close()` frees the compiler's memory at once (the
garbage collector does it otherwise); read `image` first. An image is
plain bytes: write it to a file and load it in another process with
`host.addImage(readFileSync(path))`. `addImage` copies it and returns the
image's **segment**, a number the host uses for that image.

**In one call.** `host.addCharts({ [name]: text }, { resolver })`
compiles the documents of an object, adds the image and closes the
compile result, and returns the segment: `compileCharts`, `addImage` and
`close()` as you would write them. The object's first key is the boot
chart (JavaScript keeps an object's keys in the order they were written,
except keys that are integers, which come first). A compile error throws
the same `CompileError`, with every diagnostic, and adds nothing.
`host.spawnChart(name, options)` spawns the current version of chart
`name`, as `host.spawn(host.chart(name), options)` does:

```js
import { Host } from '@tinyactors/node';

const host = new Host({ systemID: 'demo' }, { log: (host, entry) => console.log(entry.text) });
const segment = host.addCharts({
  'hello.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="hello">
    <datamodel><data id="who" expr="'world'"/></datamodel>
    <state id="s"><onentry><log expr="'hello, ' + who"/></onentry></state>
  </scxml>`,
});
console.log('segment', segment);
host.spawnChart('hello');
host.spawnChart('hello', { params: { who: 'Ada' } });
await host.idle();
host.close();
```

```output
segment 0
hello, world
hello, Ada
```

**Charts in a directory.** `directoryResolver(root)` is a resolver that
reads each `src` as a file under `root`, relative to the directory of
the document that names it: a document named `orders/order.scxml` that
asks for `payment.scxml` reads `<root>/orders/payment.scxml`. It refuses,
as a compile error, a path that leaves `root` (`..` past it, an absolute
path, or a symbolic link that points outside), a file that does not
exist, and a file that is not UTF-8; another error of the file system (a
directory, no permission) is thrown as it is:

```js
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompileError, directoryResolver, Host } from '@tinyactors/node';

const root = mkdtempSync(join(tmpdir(), 'charts-'));
mkdirSync(join(root, 'orders'));
writeFileSync(join(root, 'orders', 'payment.scxml'), `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
    datamodel="ecmascript" name="payment">
  <state id="s"><onentry><log expr="'paying'"/></onentry></state>
</scxml>`);
const order = (src) => `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="order">
  <state id="s"><invoke src="${src}"/></state>
</scxml>`;

const resolver = directoryResolver(root);
const host = new Host({ systemID: 'demo' }, { log: (host, entry) => console.log(entry.text) });
host.addCharts({ 'orders/order.scxml': order('payment.scxml') }, { resolver });
host.spawnChart('order');
await host.idle();

try {
  host.addCharts({ 'orders/order.scxml': order('../../etc/passwd') }, { resolver });
} catch (error) {
  if (!(error instanceof CompileError)) throw error;
  console.log(error.diagnostics[0].message);
}
host.close();
rmSync(root, { recursive: true });
```

```output
paying
../../etc/passwd (from orders/order.scxml) leaves the resolver's root
```

A document the resolver read is named by its `src` as written, so a
`src` inside it is read relative to that name's directory.

## A chart that starts another

`<invoke src="child.scxml">` starts an actor of another chart, a
**child**, when its state is entered, and stops it when the state is
left. Its `<param>`s set the child's variables, as `spawn`'s `params` do.
The child sends to its parent with `target="#_parent"`; its events reach
the parent with `_event.invokeid` set to the invoke's `id`. When the child
reaches a final state, the parent gets `done.invoke.<id>`, with the
child's `<donedata>` as its data.

```js
import { compileCharts, Host } from '@tinyactors/node';

const parent = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="parent" initial="waiting">
  <state id="waiting">
    <invoke id="worker" src="worker.scxml"><param name="n" expr="21"/></invoke>
    <transition event="progress"><log expr="'progress from ' + _event.invokeid + ': ' + _event.data.step"/></transition>
    <transition event="done.invoke.worker" target="done">
      <log expr="'the worker answered ' + _event.data.answer"/>
    </transition>
  </state>
  <final id="done"/>
</scxml>`;

const worker = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="worker" initial="working">
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="working">
    <onentry><send event="progress" target="#_parent"><param name="step" expr="'halfway'"/></send></onentry>
    <transition target="finished"/>
  </state>
  <final id="finished">
    <donedata><param name="answer" expr="n * 2"/></donedata>
  </final>
</scxml>`;

const compiled = compileCharts([{ name: 'parent.scxml', text: parent }, { name: 'worker.scxml', text: worker }]);
const host = new Host({ systemID: 'demo' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('parent'));
await host.idle();
host.close();
```

```output
progress from worker: halfway
the worker answered 42
```

A parent sends to its child with `target="#_worker"` (`#_` and the
invoke's id). `<invoke>` of a type other than SCXML is a service your
program runs: [Invoked services](services.md).

**The child exists from the end of the macrostep that entered its
state**, as SCXML starts invocations then. Until that point a send to
`#_worker` gets `error.communication`: from the state's own `<onentry>`,
and from anything else in the same macrostep, such as a `<raise>`d
event's transition, an eventless transition, or a history state that
re-enters several states at once. Send from a later event: the child's
first message to its parent (`ready` below) is the usual signal, and
what the child must know at its start goes in as a `<param>`, which is
evaluated when it starts.

```js
import { compileCharts, Host } from '@tinyactors/node';

const parent = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="parent" initial="running">
  <state id="running">
    <onentry>
      <send event="hello" target="#_kid"/>
      <raise event="soon"/>
    </onentry>
    <invoke id="kid" src="kid.scxml"/>
    <transition event="soon"><send event="hello" target="#_kid"/></transition>
    <transition event="error.communication"><log expr="'no child yet: error.communication'"/></transition>
    <transition event="ready"><send event="hello" target="#_kid"/></transition>
  </state>
</scxml>`;
const kid = `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="kid" initial="s">
  <state id="s">
    <onentry><send event="ready" target="#_parent"/></onentry>
    <transition event="hello"><log expr="'the child got hello'"/></transition>
  </state>
</scxml>`;

const compiled = compileCharts([{ name: 'parent.scxml', text: parent }, { name: 'kid.scxml', text: kid }]);
const host = new Host({ systemID: 'demo' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('parent'));
await host.idle();
host.close();
```

```output
no child yet: error.communication
no child yet: error.communication
the child got hello
```

## A system that starts its own actors

`compileSystem` compiles a **manifest**, a `<system>` document that lists
its charts (`<chart name src>`, read through the resolver) and the actors
to start (`<actor name chart>`). `host.boot(segment)` spawns those actors,
each with its name:

```js
import { compileSystem, Host } from '@tinyactors/node';

const files = {
  'counter.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="counter" initial="s">
    <datamodel><data id="n" expr="0"/></datamodel>
    <state id="s">
      <transition event="tick"><assign location="n" expr="n + 1"/><log expr="_name + ' ' + n"/></transition>
    </state>
  </scxml>`,
};
const manifest = `<system>
  <chart name="counter" src="counter.scxml"/>
  <actor name="left" chart="counter"/>
  <actor name="right" chart="counter"/>
</system>`;

const compiled = compileSystem({ name: 'system.xml', text: manifest }, (base, source) => files[source]);
const host = new Host({ systemID: 'demo' }, { log: (host, entry) => console.log(entry.text) });
const segment = host.addImage(compiled.image);
compiled.close();

host.boot(segment);
host.send(host.actorByName('left'), 'tick');
host.send(host.actorByName('right'), 'tick');
host.send(host.actorByName('left'), 'tick');
await host.idle();
host.close();
```

```output
left 1
right 1
left 2
```

Booting is for a system that should start the same actors every time it
starts: the manifest names them, and the program does not need to know
which. A program that spawns its own actors never needs `boot`. An image
from `compileCharts` has one boot actor too: an actor of its first chart,
named after its `<scxml name>`.
