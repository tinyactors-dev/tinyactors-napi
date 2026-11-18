# In the browser: @tinyactors/wasm

`@tinyactors/wasm` is the same API as `@tinyactors/node`, built for the
web: core compiled to WebAssembly, with the package's JavaScript around
it. It runs in a page, in a Worker, and in Node.js and Bun too, where it
is the way on a platform with no addon (Windows). Everything in the other
guides holds for it, with the same names, shapes and errors; this guide
is what differs, and what a browser asks of you.

```js
import { compileCharts, Host } from '@tinyactors/wasm';

const compiled = compileCharts([{ name: 'hello.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="hello" initial="s">
  <state id="s"><onentry><log expr="'hello from ' + _ioprocessors.scxml.location"/></onentry></state>
</scxml>` }]);
const host = new Host({ systemID: 'web' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('hello'));
await host.idle();
host.close();
```

```output
hello from tinyactors://web/#_scxml_1
```

## Contents

- [Loading: top-level await, or init()](#loading-top-level-await-or-init)
- [What a page needs: the floor and the CSP](#what-a-page-needs-the-floor-and-the-csp)
- [Bytes are Uint8Arrays](#bytes-are-uint8arrays)
- [The quickjs sandbox](#the-quickjs-sandbox)
- [Where charts run: declare your variables](#where-charts-run-declare-your-variables)
- [A dedicated Worker](#a-dedicated-worker)
- [The store: IndexedDB](#the-store-indexeddb)
- [Liveness: a page is not a process](#liveness-a-page-is-not-a-process)
- [Memory](#memory)
- [One store, two packages](#one-store-two-packages)

## Loading: top-level await, or init()

`import { Host } from '@tinyactors/wasm'` is the line you write in
Node.js: the package's entry loads its module, `tinyactors.wasm` beside
its files, with top-level `await` (`fetch` and
`WebAssembly.compileStreaming` in a browser, the file in Node.js and
Bun), so every name works once the import settles.

Two places cannot take that. A Service Worker refuses a module graph with
top-level `await`, and some bundlers neither handle it nor place
`tinyactors.wasm` beside the bundle (esbuild does not follow
`new URL(..., import.meta.url)`). For them, **`@tinyactors/wasm/init`**
exports the same names and **`init(source?)`**, which loads the module
once; `source` is where it is (a URL, a `Response`, the bytes or a
compiled `WebAssembly.Module`), the package's own file when you pass
none. Until it settles, every call throws `TA_ERROR_STATE`:

```js
import { Host, init } from '@tinyactors/wasm/init';

try {
  new Host({ systemID: 'early' });
} catch (error) {
  console.log('before init:', error.status);
}
await init(); // or init(new URL('/assets/tinyactors.wasm', location.href)), wherever your build put it
const host = new Host({ systemID: 'ready' });
console.log('after init: closed', host.closed);
host.close();
```

```output
before init: TA_ERROR_STATE
after init: closed false
```

The package targets ES2022 and serves the module as
`@tinyactors/wasm/tinyactors.wasm`, so a bundler or a CDN can place it.

## What a page needs: the floor and the CSP

**The browser floor** follows from what the module and the package use:
WebAssembly's `extended-const`, `multivalue`, `bulk-memory` and
`nontrapping-fptoint`, top-level `await` and
`String.prototype.isWellFormed`. By the engines' release notes that is
Chrome and Edge 114, Firefox 119 and Safari 16.4. Only Chromium (141) is
tested.

**The Content Security Policy.** The module needs `'wasm-unsafe-eval'` in
`script-src`. The native datamodel evaluates your charts' expressions and
scripts as JavaScript, so it needs `'unsafe-eval'` as well:

```text
Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'
```

Without `'unsafe-eval'`, under a `sandbox` policy without
`allow-same-origin`, or with Trusted Types enforced
(`require-trusted-types-for 'script'`, which guards string evaluation even
with `'unsafe-eval'`), `new Host(...)` throws `TinyactorsError` with
`TA_ERROR_UNSUPPORTED`, its message naming the directive, and
`compileCharts` skips its check of the charts' JavaScript syntax (it
parses with the same constructor). The quickjs sandbox is the datamodel
for such a page ([The quickjs sandbox](#the-quickjs-sandbox)).

## Bytes are Uint8Arrays

What a host hands out as bytes (`compiled.image`, `host.hibernate()`,
`host.snapshot()`, `host.metrics()`, telemetry, `encode()`) is a
`Uint8Array`. `@tinyactors/node` gives `Buffer`s, a subclass of
`Uint8Array`, so code written against `Uint8Array` runs on both: use
`TextDecoder` for text, not `buf.toString()`, and compare or copy with the
typed array's own methods:

```js
import { decode, encode } from '@tinyactors/wasm';

const bytes = encode({ sku: 'tea', qty: 2 });
console.log(bytes instanceof Uint8Array, bytes.length, 'bytes');
const copy = bytes.slice(); // a Uint8Array again, on both packages
console.log(decode(copy).sku, btoa(String.fromCharCode(...copy))); // base64, in a page as in Node.js
```

```output
true 14 bytes
tea omNza3VjdGVhY3F0eQI=
```

`index.d.ts`, which both packages share, says `Uint8Array` everywhere.

## The quickjs sandbox

`datamodel: 'quickjs'` works as it does in `@tinyactors/node`: the charts
run on quickjs-ng, inside the package's module, with the same limits,
realms, hibernation, migration and snapshots
([the quickjs sandbox](quickjs.md)). It evaluates no chart text with
your engine, so it needs only `'wasm-unsafe-eval'`: it is the datamodel
for a page whose policy forbids `'unsafe-eval'`, and for charts you do
not trust.

```js
import { Host } from '@tinyactors/wasm';

const host = new Host({ systemID: 'rules' }, { datamodel: 'quickjs', quickjs: { maxOps: 10000 } });
console.log(host.quickjsHeapBytes > 0);
host.close();
```

```output
true
```

quickjs is in the one module every page downloads: 378 KiB with brotli
instead of 137 KiB without it (`mise run pack:wasm` reports the sizes).
Its engine's stack is the module's: at most 256 KiB, whatever
`quickjs.stackLimit` asks, so a recursion deeper than that is its
evaluation's `error.execution` (`RangeError: Maximum call stack size
exceeded`), as a deeper one is in `@tinyactors/node`. Its `Date` reads
the real clock, as in `@tinyactors/node`, whatever clock the host runs
on.

## Where charts run: declare your variables

Chart code is trusted code here too: it runs in your engine, not in a
sandbox. Its realm is the host's own, made at its first chart:

| Where | A host's charts run in |
|---|---|
| a page | a hidden iframe of the page's origin, one per host, removed at `close()` |
| a Worker | the worker's own global (a Worker has no `document`) |
| Node.js, Bun | a `node:vm` context, as in `@tinyactors/node` |

A chart whose scripts declare nothing has a scope object per session in
that realm, as in `@tinyactors/node`. A chart whose scripts declare
(`var`, `function`, `let`, `const`, `class`) gets one function per chart,
which each session calls: its declarations are the session's own and its
functions close over them, for a few hundred bytes a session where
`@tinyactors/node` makes a `vm` context of 60 to 143 KB. Two things differ
from `@tinyactors/node`, and both are found, never silent:

- **An assignment to a name nobody declared**, in a chart-level
  `<script>` (`visits = 0` with no `var`), puts the name on the host's
  realm, shared by every session and chart of the host, where
  `@tinyactors/node` gives it to the session. The host then refuses to
  hibernate or snapshot the sessions of declaring charts, naming the
  variable, rather than lose it. Declare every variable: a `<data>`, or
  `var` in a chart-level script.
- **A function declared inside a block** of a transition's script (`if
  (x) { function f() {} }`) is a variable of the session only once that
  script ran, and hibernation does not keep it. Declare functions at the
  top of a chart-level script.

```js
import { compileCharts, Host } from '@tinyactors/wasm';

const chart = (name, script) => `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="${name}" initial="s">
  <script>${script}</script>
  <state id="s"><transition event="visit"><script>visit()</script><log expr="'${name}: ' + visits"/></transition></state>
</scxml>`;
const compiled = compileCharts([
  { name: 'declared.scxml', text: chart('declared', 'var visits = 0; function visit() { visits += 1; }') },
  { name: 'undeclared.scxml', text: chart('undeclared', 'visits = 0; function visit() { visits += 1; }') },
]);
const host = new Host({ systemID: 'web' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();

const declared = host.spawn(host.chart('declared'));
host.send(declared, 'visit');
await host.idle();
host.wake(declared, host.hibernate(declared)); // out of memory and back, its visits with it
host.send(declared, 'visit');
await host.idle();

const undeclared = host.spawn(host.chart('undeclared'));
host.send(undeclared, 'visit');
await host.idle();
try {
  host.hibernate(undeclared);
} catch (error) {
  console.log('stays resident:', error.status, /'visits'.*declare it/.test(error.message));
}
host.close();
```

```output
declared: 1
declared: 2
undeclared: 1
stays resident: TA_ERROR_UNSUPPORTED true
```

The rest of [Writing charts](charts.md#scripts) holds as it is: a chart
whose chart-level scripts declare with `let`, `const` or `class` keeps its
sessions resident, and a chart-level script that starts with
`'use strict'`, or a strict transition script that declares a `var`, is
refused when the image is added (one function cannot keep it). A
chart-level script that throws ends that session's chart-level scripts:
its `error.execution` says the later ones did not run.

## A dedicated Worker

On a page the charts share the page's thread: a long macrostep is a
frame the page does not draw. Give tinyactors a Worker of its own and the
page stays responsive, and the charts' realm (the worker's global) holds
nothing of the page's own code. The page and the worker talk with
`postMessage`, and only values cross, as between any two systems:

```js browser
const worker = new Worker(new URL('./counters-worker.mjs', import.meta.url), { type: 'module' });
// the worker says when it listens: a message sent before its module ran (it loads
// the package with top-level await) has no listener and is lost
await new Promise((resolve) => { worker.onmessage = resolve; });
const ask = (message) => new Promise((resolve) => {
  worker.onmessage = (event) => resolve(event.data);
  worker.postMessage(message);
});
console.log(await ask({ op: 'spawn', name: 'ada' }));
console.log(await ask({ op: 'visit', name: 'ada' }));
console.log(await ask({ op: 'visit', name: 'ada' }));
worker.terminate();
```

```output
spawned ada
ada: 1
ada: 2
```

The worker's script, `counters-worker.mjs` beside the page's:

```js browser
// file: counters-worker.mjs
import { compileCharts, Host } from '@tinyactors/wasm';

const compiled = compileCharts([{ name: 'counter.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="counter" initial="s">
  <datamodel><data id="visits" expr="0"/></datamodel>
  <state id="s">
    <transition event="visit">
      <assign location="visits" expr="visits + 1"/>
      <send event="counted" target="#_page" type="urn:page"><param name="visits" expr="visits"/></send>
    </transition>
  </state>
</scxml>` }]);
let answer = null; // the page's pending question
const host = new Host({ systemID: 'worker', ioProcessors: [{ type: 'urn:page' }] }, {
  ioProcessors: { 'urn:page': (host, send) => answer?.(`${host.actorByName('ada') === send.session ? 'ada' : '?'}: ${send.data.visits}`) },
});
host.addImage(compiled.image);
compiled.close();

self.onmessage = async ({ data }) => {
  const reply = new Promise((resolve) => { answer = resolve; });
  if (data.op === 'spawn') {
    host.spawn(host.chart('counter'), { name: data.name });
    answer(`spawned ${data.name}`);
  } else host.send(host.actorByName(data.name), 'visit');
  await host.idle();
  postMessage(await reply);
};
postMessage('ready');
```

A module Worker has no import map: a bundler resolves
`@tinyactors/wasm` in its script as it does in the page's, or the script
imports the package's `index.mjs` by its URL.

## The store: IndexedDB

The host does no I/O, in a browser as on a server: where hibernated
actors and snapshots live is yours. Node.js programs use a database or
files ([Hibernation](hibernation.md) uses SQLite); a page has IndexedDB,
which stores a `Uint8Array` as it is. Here a counter is hibernated into
it, and woken from it when an event comes:

```js browser
import { compileCharts, Host } from '@tinyactors/wasm';

// IndexedDB, as promises: one object store of blobs, the session as the key
const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const opening = indexedDB.open('tinyactors-blobs', 1);
opening.onupgradeneeded = () => opening.result.createObjectStore('blobs');
const db = await done(opening);
const blobs = (mode) => db.transaction('blobs', mode).objectStore('blobs');
const store = {
  put: (session, blob) => done(blobs('readwrite').put(blob, String(session))),
  take: async (session) => {
    const blob = await done(blobs('readonly').get(String(session)));
    await done(blobs('readwrite').delete(String(session)));
    return blob;
  },
};

const compiled = compileCharts([{ name: 'counter.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="counter" initial="s">
  <datamodel><data id="count" expr="0"/></datamodel>
  <state id="s">
    <transition event="inc"><assign location="count" expr="count + 1"/></transition>
    <transition event="report"><log expr="'count ' + count"/></transition>
  </state>
</scxml>` }]);
const host = new Host({ systemID: 'web' }, {
  log: (host, entry) => console.log(entry.text),
  wake: async (host, session) => host.wake(session, await store.take(session)), // idle() waits for it
});
host.addImage(compiled.image);
compiled.close();

const counter = host.spawn(host.chart('counter'));
host.send(counter, 'inc');
await host.idle();
host.sweep(100, 100); // a first sweep marks; the actor has not run since
for (const session of host.sweep(100, 100)) await store.put(session, host.hibernate(session));
console.log('stored:', await done(blobs('readonly').count()));

host.send(counter, 'inc'); // it is woken from the store first
host.send(counter, 'report');
await host.idle();
host.close();
db.close();
await done(indexedDB.deleteDatabase('tinyactors-blobs'));
```

```output
stored: 1
count 2
```

## Liveness: a page is not a process

In Node.js an open host with a pending deadline keeps the process alive.
A page has no such process: its hosts run while the page does. Two things
follow.

- **Timers are late in a hidden tab.** A host runs its turns as
  `MessageChannel` messages and arms one `setTimeout` at its next
  deadline. A browser throttles the timers of a hidden tab (Chromium to
  about once a second, and to once a minute after a few minutes hidden),
  so a delayed `<send>` or a timeout comes late there; it is never lost,
  and runs when the timer fires. A dedicated Worker is throttled less, but
  is not exempt.
- **A page that goes away takes its actors with it.** A tab can be
  closed, discarded or frozen without notice. Keep what must survive in
  your store: hibernate actors as they go cold, or snapshot the host when
  the page is hidden (`visibilitychange`, the last event a page is sure to
  get), and restore it when the page loads again:

```js browser
import { compileCharts, Host, SimulatedClock } from '@tinyactors/wasm';

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const opening = indexedDB.open('tinyactors-host', 1);
opening.onupgradeneeded = () => opening.result.createObjectStore('hosts');
const db = await done(opening);
const hosts = (mode) => db.transaction('hosts', mode).objectStore('hosts');

const config = { systemID: 'web' };
const options = () => ({ clock: new SimulatedClock(), log: (host, entry) => console.log(entry.text) });
const compiled = compileCharts([{ name: 'cart.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="cart" initial="open">
  <datamodel><data id="items" expr="[]"/></datamodel>
  <state id="open">
    <transition event="add"><script>items.push(_event.data)</script></transition>
    <transition event="show"><log expr="'cart: ' + items.join(', ')"/></transition>
  </state>
</scxml>` }]);

// at load: the host as the page left it, else a new one
async function load() {
  const saved = await done(hosts('readonly').get('host'));
  if (saved !== undefined) return Host.restore(saved, config, options());
  const host = new Host(config, options());
  host.addImage(compiled.image);
  host.spawn(host.chart('cart'), { name: 'cart' });
  return host;
}
// when the page is hidden: a snapshot needs a quiescent host, so after idle()
async function save(host) {
  await host.idle();
  await done(hosts('readwrite').put(host.snapshot(), 'host'));
}

const host = await load();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') save(host);
});
host.send(host.actorByName('cart'), 'add', 'tea');
await save(host); // what the event would do, here at once
host.close();

const again = await load(); // the page loaded again
again.send(again.actorByName('cart'), 'add', 'cake');
again.send(again.actorByName('cart'), 'show');
await again.idle();
again.close();
compiled.close();
db.close();
await done(indexedDB.deleteDatabase('tinyactors-host'));
```

```output
cart: tea, cake
```

[Snapshots](snapshots.md) says what a snapshot holds and what it does
not (the services your program runs, which a restore announces again).

## Memory

- **WebAssembly memory never shrinks.** The host's memory is the module's
  linear memory, which grows and is never given back: a page keeps its
  peak. Hibernating actors makes room for others in it, not a smaller
  page. A snapshot is packed in that memory before it is copied out, so a
  100 MB snapshot leaves the memory 100 MB larger.
- **4 GiB at most.** wasm32 addresses 4 GiB, and a region that grows is
  copied before the old one is freed, so one host holds about two million
  resident actors at most, where `@tinyactors/node` goes on.
- What the package hands out (bytes, values, views) is never a view of
  that memory: it stays valid when the memory grows.

[Capacity and memory](capacity.md) has what an actor costs.

## One store, two packages

A Node.js server on `@tinyactors/node` and a browser client on
`@tinyactors/wasm` can share a database, but not the bytes a host packs:

- **A snapshot does not cross.** It is the host's memory as the build that
  made it lays it out, and the addon is a 64-bit build where the module
  is a 32-bit one. Each package labels its snapshots with its own name and
  refuses the other's with `TA_ERROR_INVALID`, the message naming the
  package that made it.
- **A hibernation blob belongs to its host.** It wakes in the host that
  hibernated it, or in one restored from that host's snapshot, which the
  other package cannot restore; another host's blob throws
  `TA_ERROR_INVALID`. Keep the server's blobs and the client's apart in
  the store, by host.
- **Values cross.** `encode` and `decode` are one format in both packages
  ([Other systems](other-systems.md)): move work between the server and
  the client as events and their data, from one system to another.
