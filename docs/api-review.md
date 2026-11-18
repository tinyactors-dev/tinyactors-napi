# The API review of the direct layer (2026-10-16)

The review that closes phase p1 of [plan.xml](plan.xml) ("then the API
review side by side with Python"), done as the Python binding's was
([tinyactors-cpython/ROADMAP.md](../../tinyactors-cpython/ROADMAP.md),
"The API review (2026-10-15)"): how a JavaScript program and a JavaScript
chart read today, every item of the direct layer beside Python's, and
what the maintainer still has to decide. It serves the application
developer first, then the maintainers, who keep two bindings of one core
alike where their languages allow it.

## How this review was made

- Two programs written against the built addon (`mise run build`), run
  under node 22.23.3 and bun 1.4.1, both datamodels for the chart program.
  Their output is quoted below; node and bun printed the same lines.
- Small probes of the same calls on both bindings (the Python extension
  from `tinyactors-cpython/build/abi3`, not changed), for refusals, empty
  fields, errors and results.
- The table compares `docs/api-map.md` with
  `tinyactors-cpython/docs/api-map.md` row by row. A difference is
  **deliberate** when a decision of the plan or an entry of
  [log.xml](log.xml) made it, **same** when only the language's spelling
  differs (`undefined` for `None`, an options object for keywords,
  `bigint` for `int`, camelCase), and an **inconsistency** otherwise.
- Two inconsistencies were small and clearly wrong, and are fixed
  (`l-p1-review-compile-message`, `l-p1-review-declaring-script`); one is
  for the maintainer (`l-p1-review-result-ids`). The reasoned-analysis
  refutation by a fresh agent was not run: this step could not spawn one
  (`l-p1-review-refutation`).

## A JavaScript program

An order actor: compiled with a resolver (its `<invoke src>`), a host on a
simulated clock, two sessions, an I/O processor that answers one send and
leaves the other unanswered, a log handler, a typed method, and a delayed
send that fires when the clock moves.

```js
// An order actor: compiled with a resolver, an I/O processor that answers,
// a log handler, a typed method, and a delayed send on a simulated clock.
import { compileCharts, Host, SimulatedClock, ResolveError } from '@tinyactors/node';

const files = {
  'payment.scxml': `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
      datamodel="ecmascript" name="payment" initial="wait">
    <state id="wait"><transition event="charge" target="done"/></state>
    <final id="done"/>
  </scxml>`,
};

const order = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
    datamodel="ecmascript" name="order" initial="new">
  <datamodel><data id="total" expr="0"/></datamodel>
  <state id="new">
    <transition event="place" target="paying">
      <assign location="total" expr="_event.data.total"/>
    </transition>
  </state>
  <state id="paying">
    <onentry>
      <log label="order" expr="'charging ' + total"/>
      <send type="urn:payments" event="charge" target="card"><content expr="({ amount: total })"/></send>
      <send event="timeout" delay="30s" id="timer"/>
    </onentry>
    <transition event="charged" target="paid"><cancel sendid="timer"/></transition>
    <transition event="timeout" target="failed"/>
  </state>
  <state id="paid">
    <onentry><log label="order" expr="'paid by ' + _event.data.by"/></onentry>
    <invoke src="payment.scxml"/>
  </state>
  <final id="failed"><onentry><log label="order" expr="'timed out'"/></onentry></final>
</scxml>`;

const resolver = (base, source) => {
  if (!(source in files)) throw new ResolveError(`no file ${source}`, { line: 1, column: 1 });
  return files[source];
};

const compiled = compileCharts([{ name: 'order.scxml', text: order }], resolver);
const image = compiled.image;
compiled.close();

const clock = new SimulatedClock();
const host = new Host({ systemID: 'shop', ioProcessors: [{ type: 'urn:payments' }] }, {
  clock,
  log: (host, entry) => console.log(`[${entry.label}] ${entry.text}`),
  ioProcessors: {
    'urn:payments': (host, send) => {
      console.log(`payments: ${send.event} ${JSON.stringify(send.data)} to ${send.target}`);
      if (send.data.amount < 100) send.answer('charged', { by: 'card' });
      // else: no answer; the order's timer decides
    },
  },
});

host.addImage(image);
const first = host.spawn(host.chart('order'), { name: 'first' });
const second = host.spawn(host.chart('order'), { name: 'second' });
host.send(first, 'place', { total: 42 });
host.send(second, 'place', { total: 420 });
await host.idle();

host.actorState({ session: first }, (host, result) => console.log('first:', JSON.stringify(result)));
host.actorState({ session: second }, (host, result) => console.log('second:', JSON.stringify(result)),
  (host, error) => console.log('second: error', error.message));
await host.idle();

console.log('next deadline in', host.nextDeadline, 'ms');
clock.increment(30_000);
await host.idle();
console.log('second is', host.actorByName('second') ?? 'gone');
host.close();
```

Under node and bun alike:

```
[order] charging 42
payments: charge {"amount":42} to card
[order] charging 420
payments: charge {"amount":420} to card
[order] paid by card
first: {"value":"paid"}
second: {"value":"paying"}
next deadline in 30000 ms
[order] timed out
second is gone
```

How it reads, beside the same program in Python:

- **Close to Python, line for line.** `compileCharts`, `addImage`,
  `chart`, `spawn`, `send`, the handlers and the typed method are the same
  calls; `await host.idle()` takes the place of `run_until_idle()`, and
  the event loop runs the turns (d-drive). A reply needs a turn after the
  call, as in Python (its review kept that).
- **Options objects where Python has keywords:** `spawn(ref, {name})`,
  `send.answer(event, data, {traceparent})`, `new ResolveError(message,
  {line, column})`. JavaScript has no keyword arguments; the names are
  Python's in camelCase.
- **Typed methods take their params first**, `host.actorState({session},
  onResult, onError)`, where Python passes the handler first and the
  params as keywords (d-typed, the maintainer's). A method without params
  reads `host.hostStats(undefined, onResult)`; its promise form is the
  convenience layer's (d-promises).
- **Time is milliseconds**, `clock.increment(30_000)` and
  `host.nextDeadline` (30000), where Python's is seconds (d-time).
  `clock.increment` moves the clock and schedules a turn; `await
  host.idle()` sees what ran (d-clock).
- **Sessions are bigints**: `console.log(first)` prints `1n`, and
  `JSON.stringify` of an object holding one throws. Ids inside a typed
  method's result are numbers, so a result's session cannot be passed back
  to `send` or `terminate` without `BigInt()`; Python has one `int` for
  both (below, `l-p1-review-result-ids`).
- **An error with no `onError` ends the process** when no `idle()` is
  waiting (d-errors; the README says so). Writing this program, an
  `actorGet({name})` (a param the method does not take) did exactly that:
  `TinyactorsError: params has a field this method does not take`, thrown
  from the turn's callback, `path: 'params.name'`. Python raises the same
  error from `run_until_idle()`.

## A JavaScript chart

A basket on the native datamodel: a `<script>` with a function, a
`<foreach>` over the data, and XML content read as a DOM.

```js
// A JavaScript chart: a <script> with functions, <foreach> over the data,
// and XML content read as a DOM.
import { compileCharts, Host } from '@tinyactors/node';

const basket = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
    datamodel="ecmascript" name="basket" initial="open">
  <datamodel>
    <data id="items" expr="[]"/>
    <data id="total" expr="0"/>
    <data id="catalog">
      <prices xmlns=""><price sku="tea">4</price><price sku="cake">7</price></prices>
    </data>
  </datamodel>
  <script>
    function price(sku) {
      for (const node of catalog.getElementsByTagName('price'))
        if (node.getAttribute('sku') === sku) return Number(node.textContent);
      return 0;
    }
  </script>
  <state id="open">
    <transition event="add"><script>items.push(_event.data.sku)</script></transition>
    <transition event="checkout" target="closed">
      <foreach array="items" item="sku" index="i">
        <assign location="total" expr="total + price(sku)"/>
        <log label="line" expr="(i + 1) + '. ' + sku + ' ' + price(sku)"/>
      </foreach>
      <log label="total" expr="total"/>
    </transition>
  </state>
  <final id="closed"/>
</scxml>`;

const compiled = compileCharts([{ name: 'basket.scxml', text: basket }]);
const host = new Host({ systemID: 'shop' }, {
  log: (host, entry) => console.log(`${entry.label}: ${entry.text}`),
});
host.addImage(compiled.image);
compiled.close();

const session = host.spawn(host.chart('basket'));
for (const sku of ['tea', 'cake', 'tea']) host.send(session, 'add', { sku });
host.send(session, 'checkout');
await host.idle();
host.close();
```

Under node and bun, on the native datamodel and on quickjs:

```
line: 1. tea 4
line: 2. cake 7
line: 3. tea 4
total: 15
```

How it reads:

- **A chart reads as ordinary JavaScript:** a function in a `<script>`,
  `for...of` over `getElementsByTagName`, arrays with `push`, template
  expressions in `<log>`. The `<data>`'s XML is a DOM with the methods a
  JavaScript programmer expects (d-dom, `l-p1-datamodel-dom`), on both
  runtimes, though neither has a `DOMParser`.
- **The same chart runs on quickjs unchanged**, with `datamodel:
  'quickjs'` on the Host (d-datamodel).
- **`function price(sku)` costs a context per session.** A script that
  declares a top-level name puts its chart on a `vm` context per session,
  about 143 KB on node and 60 KB on bun (d-declarations, the maintainer's,
  so that closures work). Nothing an application developer reads said so;
  the README now does, with the form that keeps the shared context
  (`<data id="price"/>` and `price = (sku) => ...` in the script, run
  under both runtimes with the same output). Fixed:
  `l-p1-review-declaring-script`.

## Every item beside Python's

Items marked *planned* in `docs/api-map.md` are phase p2's (telemetry,
hibernation, migration, snapshots, services); their shapes are compared
as written. "Python only" and "Node only" rows say why.

| Item | Node | Python | Difference | Verdict |
|---|---|---|---|---|
| compile | `compileCharts(sources, resolver?)`, sources `{name, text}` | `compile_charts(sources, resolver=None)`, `(name, text)` | object for pair | same |
| compile a system | `compileSystem(manifest, resolver?)` | `compile_system(manifest, resolver=None)` | — | same |
| compile result | `compiled.image` a `Buffer` copied on first read; `close()`, `Symbol.dispose` | a `memoryview` until `close()`; `close()` with an export raises `BufferError`; `with` | a copy, not a view; no export count | deliberate: d-image, d-dispose |
| diagnostics | `compiled.diagnostics`, frozen `{severity, code, file, line, column, message}` | `Diagnostic` objects | — | same |
| `CompileError` | status `TA_ERROR_INVALID`, every diagnostic, message `file:line:column: error: message` | the same | the message lacked `error:` | inconsistency, fixed: `l-p1-review-compile-message` (2a0f926) |
| the resolver | any callable `(base, source) => string`; `ResolveError(message, {line, column})` | any callable; `ResolveError(message, line=, column=)` | a `SyntaxError` is not converted (no JavaScript is compiled at resolve time) | deliberate: a-resolver, `l-p1-compile-errors` |
| the host | `new Host(config, {ioProcessors, log, clock, transport, datamodel, quickjs, ...})` | `Host(config, io_processors, *, log, clock, transport, ...)` | the processors in the options; `datamodel` and `quickjs` options | same (no keywords); the options deliberate: d-datamodel, `l-p0-map-quickjs-option` |
| a refused option | `TypeError`, an unknown processor type included | `TypeError`; `ValueError` for an unknown processor type | JavaScript has no `ValueError` | deliberate: `l-p1-host-unknown-options` |
| host properties | `ticksPerSecond`, `closed`, `nextDeadline` (ms); `quickjsHeapBytes` | `ticks_per_second`, `closed`, `next_deadline` (s) | ms; the quickjs heap | deliberate: d-time, `l-p0-map-host-properties`, `l-p0-map-quickjs-heap` |
| close | `close()`, `Symbol.dispose`, `Symbol.asyncDispose` | `close()`, `with`, `async with` | `using` needs a runtime that parses it | deliberate: d-dispose (README says so) |
| images | `addImage(image) → number`, `chart(name) → {segment, chart}`, `boot(segment)` | `add_image`, `chart → ChartRef`, `boot` | `spawn` takes any object of `segment` and `chart` (core checks both); Python only its `ChartRef` | deliberate: `l-p0-map-types` |
| spawn | `spawn(ref, {name, params, traceparent}?) → bigint` | `spawn(ref, name=, params=, traceparent=) → int` | an unknown option key is a `TypeError` | same; `l-p1-compile-input-options` |
| send | `send(target, event, data?, {sendid, traceparent, origin}?)`, `send(message)` | the same with keywords | — | same; `l-p0-map-send-options` |
| fail | `fail(target, sendid?)` | `fail(target, sendid=None)` | — | same |
| send many | `sendMany(items) → number`, items objects of `send(message)`'s fields | items tuples | objects, not tuples | deliberate: `l-p0-map-send-many` |
| terminate, by name | `terminate(session)`, `actorByName(name) → bigint \| undefined` | `terminate`, `actor_by_name → int \| None` | — | same |
| sessions | `bigint` from 1 to 2^64-1, a number refused | `int` | ids in a typed method's result are numbers, and cannot be passed back | inconsistency, for the maintainer: `l-p1-review-result-ids` |
| the driver | none: the event loop runs every host; `await host.idle()` observes | `run_until_idle()`, `run()`, `await idle()` | no synchronous driver | deliberate: d-drive |
| a turn's error | rejects a waiting `idle()`, else thrown from the turn's callback | raised by the driver after the turn | — | deliberate: d-errors |
| an exhausted pool | `TinyactorsError` `TA_ERROR_NO_MEMORY` naming the pool | `MemoryError` | JavaScript has no `MemoryError` | deliberate: `l-p0-map-exhausted`, `l-p1-loop-pool-names` |
| the clock | `SimulatedClock`, `increment(ms)` schedules a turn, `now` (ms) | `increment(seconds)` turns until idle, `now` (s) | ms; increment does not turn | deliberate: d-time, d-clock |
| I/O processors | `ioProcessors: {[type]: (host, send) => void \| Promise}`; a processor with no handler fails its send | `io_processors={type: handler}`; an `async def` gets a record, refused under `with` | any thenable materializes the view, detected at the return | deliberate: d-async, `l-p1-effects-processor-without-handler` |
| a send's fields | `session`, `event`, `target`, `sendid`, `data`, `type`, `origin`, `traceparent`, `message`; absent: `undefined` | the same; absent: `None` | — | same; `l-p1-effects-empty-fields` |
| answer, fail | `answer(event, data?, {traceparent, origin, raw})`, once; `traceparent: null` a new trace; `fail()` | `answer(..., traceparent=None)` a new trace; once | `null`, since `undefined` means "not given" | deliberate: `l-p0-map-traceparent-null` |
| the transport | `transport: (host, send) => ...`, `send.message`, `Address` fields | the same | — | same; d-address |
| log | `log: (host, entry)`, `entry.session`, `.label`, `.text` | the same | — | same |
| typed methods | `actorState(params, onResult, onError?)` and ten more | `actor_state(handler, on_error=None, /, **params)` | params first; `{}` posted as an empty map; a reply's error has no `status` | deliberate: d-typed, `l-p1-methods-arguments`, `l-p1-methods-error-status` |
| `TinyactorsError` | `(message, {code, reason, path, status})` | `(message, code, reason, path, status)` | — | same; `l-p0-map-types` |
| values | `encode → Uint8Array`, `decode`; `undefined` and `null` distinct; integers past 2^53 `bigint`; tag 32 read as text, never written | `bytes`; `UNDEFINED`; `Address` for tag 32 | no reference type in ECMAScript | deliberate: d-address, `l-p1-values-encode-not-to-wire` |
| `UNDEFINED` | — (JavaScript's `undefined`) | `tinyactors.UNDEFINED` | Python only | same |
| `Address` | `new Address(text)`, `.text`, `.system`, `.session`, `.name`, `toString()`; not a value | the same, equality and hashing; a value (tag 32) | `fromSession`, `fromName` (Node only) | deliberate: d-address, `l-p0-inventory-address-format`, `l-p0-map-address` |
| BasicHTTP | `encodeHTTPPost`, `parseHTTPRequest` | — (the adapter's Python) | Node only | deliberate, for the maintainer: `l-p0-inventory-basic-http`, `l-p0-map-basic-http` |
| `.py` / JavaScript sources | — | `<script src="x.py">` checked at compile time | no JavaScript is compiled at resolve time | deliberate: a-resolver |
| the native datamodel | `"ecmascript"` in `vm` contexts, a scope per session, `_event` frozen, XML as a DOM | `"python"`, a class per chart, an instance per session | each language's | deliberate: d-datamodel, d-declarations, d-dom, d-separate |
| telemetry, metrics | *planned* (p2-telemetry): `telemetry: (host, signal, data)`, `metrics() → Buffer` | built | — | same shapes |
| hibernation | *planned* (p2-hibernate): `sweep → bigint[]`, `hibernate → Buffer`, `wake(session, blob)`, `wake:` handler | built | — | same shapes |
| migration | *planned* (p2-migrate): `migrate({chart, session, wake, timeout}) → number` (timeout in ms), `migrated`, `migrationDone` | built (timeout in s) | ms | deliberate: d-time |
| snapshots | *planned* (p2-snapshot): `snapshot() → Buffer` labelled `tinyactors-napi`, `Host.restore(snapshot, config, options)` | built, labelled `tinyactors-cpython` | the label | deliberate: `l-p0-map-snapshot-label` |
| services | *planned* (p2-services): `services`, `Invocation` with `sendBack`, `done`, `restored`; `receive`, `stop` | built | — | same shapes |
| not exposed | `ta_host_segment_count`, `ta_host_snapshot_segments`, the XML writer | the same | — | same: `l-p0-inventory-segments`, `l-p0-inventory-xml-writer` |

Errors and refusals were compared on both bindings: an unknown chart, a
refused boot, a refused image and an ended session give the same status
(`TA_ERROR_INVALID`, `TA_ERROR_STALE`) in both; Node's messages say what
was refused where Python's name the status.

## Waiting for the maintainer

The 52 entries this section listed on 2026-10-16 were decided by the
coordinator on 2026-10-17, as the maintainer delegated
(`l-coord-decisions`); what they changed is step p2-decisions of
[plan.xml](plan.xml). What waits now, with a recommendation each, is
[maintainer.md](maintainer.md), made from the entries of
[log.xml](log.xml) with status `for-maintainer`.
