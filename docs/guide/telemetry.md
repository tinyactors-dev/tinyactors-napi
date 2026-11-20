# Telemetry

This guide is part of operating a host (the README's [Operating a
host](../../README.md#operating-a-host)); `decodeTraces`, which reads
an export without a host, is the [wire format](../../README.md#wire-format)'s.

Telemetry is optional: a host without it runs the same. Turn it on to see
what your actors did in an OpenTelemetry backend.

A host can describe what its actors did as OpenTelemetry data: a span
for each step an actor takes (the event, the transitions, the states left
and entered), a log record for each `<log>` and each failed action, and
metrics of the host's counters. It writes them as OTLP requests, the
protobuf bytes an OpenTelemetry collector takes at `/v1/traces`,
`/v1/logs` and `/v1/metrics`. Sending them is your code's job, so you
choose the transport, the retries and the collector.

## Turning it on

Two things: a `telemetry` map in the config, which gives the host its
encoder, and a `telemetry` handler in the options, which gets each request
the encoder wrote, as a `Buffer`, with its signal (`'traces'` or
`'logs'`).

```js
import { compileCharts, decodeTraces, Host, SimulatedClock } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'order.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="order" initial="open">
  <state id="open">
    <transition event="pay" target="paid"><log label="order" expr="'paid'"/></transition>
  </state>
  <final id="paid"/>
</scxml>` }]);

const requests = [];
const clock = new SimulatedClock();
const host = new Host(compiled, {
  system: 'shop',
  config: {
    system: { ticksPerSecond: 1000 },                                        // the host's clock in milliseconds
    telemetry: { flushInterval: 1000, resource: { 'service.name': 'shop' } }, // a request at most a second after its first record
  },
  clock,
  telemetry: (signal, data) => {
    // A real exporter posts the bytes, from a promise so the host goes on:
    // fetch(`${collector}/v1/${signal}`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: data })
    requests.push([signal, data]);
  },
});
compiled.close();

const caller = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'; // a W3C traceparent, from an HTTP header
host.spawn('order').send('pay', undefined, { traceparent: caller });
await host.idle();
console.log('requests before the flush interval:', requests.length);
clock.increment(1000);
await host.idle();
console.log('signals:', requests.map(([signal]) => signal).sort().join(', '));

// Read the spans back (for a test; a collector does this for you).
for (const [signal, data] of requests) {
  if (signal !== 'traces') continue;
  const spans = decodeTraces(data);
  const ours = spans.filter((span) => span.trace === '0af7651916cd43dd8448eb211c80319c');
  console.log('spans in the caller\'s trace:', ours.map((span) => span.name).sort().join(', '));
  const step = ours.find((span) => span.name === 'scxml.macrostep pay');
  console.log('the step\'s parent is the caller\'s span:', step.parent === 'b7ad6b7169203331');
}
host.close();
```

```output
requests before the flush interval: 0
signals: logs, traces
spans in the caller's trace: scxml.destroyed, scxml.finished, scxml.macrostep pay, scxml.microstep pay
the step's parent is the caller's span: true
```

The handler runs in the host's turn: start the post there, and do not
wait for the collector before returning. A handler's error is the turn's
([README](../../README.md#errors)); the request it failed to send is not
offered again, so retrying is the exporter's to do.

**`host.metrics()`** returns the metrics request for the host's counters
now, a `Buffer` for `/v1/metrics`. Call it on your own schedule. It throws
`TA_ERROR_STATE` on a host without `telemetry` in its config.

**At `host.close()`** every span still open ends, marked incomplete, and
the handler gets the last requests before the host is freed. A promise the
handler returns there is awaited by `await host[Symbol.asyncDispose]()`.
A host the garbage collector frees without `close()` skips this: close
the hosts whose telemetry you want.

## The encoder's options

The config's `telemetry` map, every key optional:

| Key | Default | What it does |
|---|---|---|
| `flushInterval` | 0 | a request is ready this long after its first record, in the host's clock ticks (`system.ticksPerSecond`); 0 means only when the staging is full, or at close |
| `resource` | none | attributes on every request, such as `service.name` (at most 32, text to text) |
| `logs` | `true` | `<log>` lines and failed actions as log records |
| `values` | `false` | event data and assigned values in the spans; they may hold personal data, so turn this on knowingly |
| `linkParents` | `false` | an actor's step is a root span linked to its cause, instead of its child |
| `stagingBytes` | 1048576 | the encoder's staging memory |

The host's clock runs at `system.ticksPerSecond`, a billion by default
(nanoseconds), so a `flushInterval` of 5000 is five microseconds unless the
config sets the rate. Most programs that export set `ticksPerSecond:
1000` and give the interval in milliseconds.

A pending flush is one of the host's deadlines: once records are staged,
`host.nextDeadline` reads the time to the flush even when no actor has a
delayed send left, the host's timer is armed for it (keeping the process
alive until then), and a test that asserts "no timer is left" first steps
its clock past the flush:

```js
import { compileCharts, Host, SimulatedClock } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'job.scxml', text: `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="job">
  <final id="done"/>
</scxml>` }]);
const clock = new SimulatedClock();
const host = new Host(compiled, {
  system: 'shop',
  config: { system: { ticksPerSecond: 1000 }, telemetry: { flushInterval: 1000 } },
  clock,
  telemetry: (signal) => console.log(signal, 'at', clock.now),
});
compiled.close();
host.spawn('job');
await host.idle();
console.log('the job ended; nextDeadline', host.nextDeadline);
clock.increment(host.nextDeadline ?? 0);
await host.idle();
console.log('flushed; nextDeadline', host.nextDeadline);
host.close();
```

```output
the job ended; nextDeadline 1000
traces at 1000
logs at 1000
flushed; nextDeadline undefined
```

## Trace context

The host carries W3C trace context through every step. An input may name
the trace it continues: `actor.send(event, data, { traceparent })`,
`host.send(actor, event, data, { traceparent })` and `host.spawn(chart,
{ traceparent })` take a `traceparent` header's
text, and text that does not parse starts a new trace. Toward the
outside, a send's `traceparent` is the sending step's context, for the
header of the request your I/O processor makes, and `send.answer()`
continues it unless you pass another (`null` for a new trace):

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'c.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="c" initial="s">
  <state id="s">
    <transition event="go"><send type="urn:example:api" event="call"/></transition>
  </state>
</scxml>` }]);
const host = new Host(compiled, {
  system: 'demo',
  ioProcessors: {
    'urn:example:api': {
      receive(send) {
        const [, trace] = send.traceparent.split('-');
        console.log('the outgoing request continues trace', trace);
        // fetch(url, { headers: { traceparent: send.traceparent } })
      },
    },
  },
});
compiled.close();
host.spawn('c').send('go', undefined, {
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
});
await host.idle();
host.close();
```

```output
the outgoing request continues trace 4bf92f3577b34da6a3ce929d0e0e4736
```

Tracing is on by default (`system.tracing`), with or without an encoder,
so trace context flows even when nothing is exported.

**Each host starts its own trace IDs.** A trace the host starts itself
takes its ID from a generator seeded by `system.traceSeed`. When the
config gives none, the package draws a random seed for each new host
(`crypto.getRandomValues`), so two processes, or one process and its
restart, do not collide at the collector. To reproduce a test's traces,
set the seed: the same seed gives the same IDs. `Host.restore` keeps the
generators of the snapshot.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'c.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="c" initial="s">
  <state id="s"><onentry><send type="urn:example:api" event="call"/></onentry></state>
</scxml>` }]);
const image = compiled.image;
compiled.close();

const firstTrace = async (system) => {
  let trace;
  const host = new Host(image, {
    system: 'demo',
    config: { system },
    ioProcessors: { 'urn:example:api': { receive: (send) => { trace = send.traceparent.split('-')[1]; } } },
  });
  host.spawn('c');
  await host.idle();
  host.close();
  return trace;
};

console.log('no seed, twice:', (await firstTrace({})) === (await firstTrace({})));
console.log('seed 7, twice:', (await firstTrace({ traceSeed: 7 })) === (await firstTrace({ traceSeed: 7 })));
```

```output
no seed, twice: false
seed 7, twice: true
```

## Choosing what is traced

Typed methods ([Inspecting a host](inspection.md)) set what the host
records:

- **`traceConfigure(params)`** sets what every actor traces: `detail`
  (`'summary'`, `'decisions'`, `'full'` or `'off'`), `values`, `sample`
  (the share of new traces sampled, 0 to 1) and `rules`. It replaces the
  previous configuration.
- **`traceWatch({ rules, seconds })`** adds rules in front of the
  configured ones for a while (900 seconds by default), and answers `{ id
  }`; **`traceUnwatch({ id })`** ends a watch early. A watch is how an
  operator looks closely at one chart or one actor without tracing
  everything.
- **`traceEnd()`** ends every open span now, as `close()` does.
- **`traceSpansDecode({ traces })`** reads the spans of a traces request
  back through the host. `decodeTraces(bytes)`, used above, needs no host
  and also gives each span's `flags`, `links`, `resource` and `scope`.

A rule matches by `chart`, `actor` (a trailing `*` makes it a prefix),
`event` (SCXML's prefix rule), `session` or `from` (`'host'`, `'actor'`,
`'timer'`, `'spawn'`, ...), and decides `sample` (`'keep'`, `'sample'`,
`'drop'` or a share) and `detail`, at most `perSecond` with a `burst`.

```js
import { Host } from '@tinyactors/node';

const host = new Host([], { system: 'shop', config: { telemetry: {} } });
await host.traceConfigure({ detail: 'summary', sample: 0.01 });
console.log('1 trace in 100, summarized');
const watch = await host.traceWatch({ rules: [{ chart: 'checkout', sample: 'keep', detail: 'full' }], seconds: 60 });
console.log(`watch ${watch.id}: every checkout in full for a minute`);
host.close();
```

```output
1 trace in 100, summarized
watch 1: every checkout in full for a minute
```
