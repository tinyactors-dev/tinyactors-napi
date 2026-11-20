// Telemetry (docs/plan.xml, p2-telemetry; translated from
// tinyactors-cpython/tests/test_telemetry.py): the OTLP requests the host's
// encoder writes, handed to the application's handler as a Uint8Array copied
// once, metrics pulled in and outside a drain, the last take at close
// (trace.end, bounded, its handler's close() deferred, its error reported
// once the host is freed, its promises awaited by [Symbol.asyncDispose]),
// spans decoded back with traceSpansDecode, and watches on a simulated
// clock and on the real one.
import { decodeTraces, Host, InvalidError, SimulatedClock } from '@tinyactors/node';
import { ENGINE, equal, hostWith, processor, scxml, sleep, status, throws } from './charts.mjs';
import { run, test } from './harness.mjs';

/** A chart that logs and counts at each `go`. */
const LOGGING = scxml('c', `
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="s">
    <transition event="go">
      <log label="l" expr="'hi'"/>
      <assign location="n" expr="n + 1"/>
    </transition>
  </state>`);

/** A chart that does nothing at `go` but trace it. */
const quiet = (name) => scxml(name, '<state id="s"><transition event="go"/></state>');

/** A config with an encoder: ticks are milliseconds, flushInterval in ticks. */
function config(telemetry = {}) {
  return { system: { ticksPerSecond: 1000 }, telemetry: { flushInterval: 100, ...telemetry } };
}

/** A host running LOGGING with `telemetry` as its handler, on a simulated clock unless one is given. */
function logging(telemetry, { clock = new SimulatedClock(), flush, ...options } = {}) {
  return hostWith({ c: LOGGING }, { config: config(flush === undefined ? {} : { flushInterval: flush }), telemetry, clock, ...options });
}

/** The names of the spans the traces requests of `requests` hold, decoded by `host`. */
async function spanNames(host, requests) {
  const names = [];
  for (const [signal, data] of requests)
    if (signal === 'traces') host.traceSpansDecode({ traces: data }, (result) => names.push(...result.spans.map((span) => span.name)));
  await host.idle();
  return names;
}

/** A host that decodes, with no encoder of its own. */
const decoder = () => new Host([], { system: 'd', ...ENGINE });

/** The trace id of the first send of a new host made with `system` (no
 * `system` key when undefined), and its effective traceSeed. */
async function firstTrace(system) {
  let trace;
  const chart = scxml('sender', '<state id="s"><onentry><send type="urn:t:out" target="x" event="out"/></onentry></state>');
  const config = system === undefined ? {} : { system };
  const given = JSON.stringify(config);
  const host = hostWith({ sender: chart }, {
    config,
    ioProcessors: { 'urn:t:out': processor((send) => { trace = send.traceparent.split('-')[1]; }) },
  });
  equal(JSON.stringify(config), given, 'the caller\'s config is not changed');
  host.spawn(host.chart('sender'));
  await host.idle();
  const seed = (await host.hostConfig()).system.traceSeed;
  host.close();
  return { trace, seed };
}

test('the binding picks a random trace seed when the config gives none; a given seed reproduces', async () => {
  const [a, b] = [await firstTrace(undefined), await firstTrace({ ticksPerSecond: 1000 })];
  if (a.trace === b.trace) throw new Error(`two hosts without a seed started the same trace id ${a.trace}`);
  if (a.seed === b.seed) throw new Error(`two hosts without a seed got the same seed ${a.seed}`);
  const c = await firstTrace({ traceSeed: undefined });
  if (c.trace === a.trace || c.trace === b.trace) throw new Error('traceSeed: undefined is no seed');
  const [d, e] = [await firstTrace({ traceSeed: 7 }), await firstTrace({ traceSeed: 7 })];
  equal(d.trace, e.trace, 'the same given seed, the same trace id');
  equal(Number(d.seed), 7, 'the given seed is kept');
  const [f, g] = [await firstTrace({ traceSeed: 0 }), await firstTrace({ traceSeed: 0 })];
  equal(f.trace, g.trace, 'a given 0 is a seed too');
});

test('traces and logs reach the handler as Uint8Arrays, copied once, after flushInterval', async () => {
  const got = [];
  const clock = new SimulatedClock();
  const host = logging((signal, data) => got.push([signal, data]), { clock });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  equal(got.length, 0, 'staged until flushInterval passed');
  clock.increment(200);
  await host.idle();
  equal(got.map(([signal]) => signal).sort().join(), 'logs,traces', 'one request of each');
  for (const [, data] of got) {
    if (!(data instanceof Uint8Array) || data.length === 0) throw new Error('data is not a non-empty Uint8Array');
  }
  if (!(await spanNames(host, got)).includes('scxml.macrostep go')) throw new Error('no macrostep go');
  host.close();
});

test('decodeTraces reads spans without a host: the typed method\'s fields, flags, links, resource and scope', async () => {
  const got = [];
  const clock = new SimulatedClock();
  const host = logging((signal, data) => got.push([signal, data]), { clock });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  clock.increment(200);
  await host.idle();
  const traces = got.find(([signal]) => signal === 'traces')[1];
  const typed = (await host.traceSpansDecode({ traces })).spans;
  host.close();
  const spans = decodeTraces(traces);
  equal(spans.length, typed.length, 'as many spans');
  spans.forEach((span, i) => {
    for (const [key, value] of Object.entries(typed[i])) equal(JSON.stringify(span[key], (k, v) => (typeof v === 'bigint' ? String(v) : v)),
      JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v)), `span ${i}: ${key}`);
    equal(Array.isArray(span.links) && span.links.length, 0, 'no links');
    equal(typeof span.flags, 'number', 'flags');
    equal(span.scope.name, 'tinyactors', 'the scope');
    equal(span.scope.attributes['tinyactors.chart.name'], 'c', 'the scope\'s chart');
    equal(typeof span.resource, 'object', 'the resource');
  });
  equal(decodeTraces(traces.buffer.slice(traces.byteOffset, traces.byteOffset + traces.byteLength)).length, spans.length, 'an ArrayBuffer');
  equal(decodeTraces(new Uint8Array(0)).length, 0, 'no spans');
  throws(() => decodeTraces(new Uint8Array([255, 255, 255])), (error) => {
    if (!(error instanceof InvalidError)) throw error;
  }, 'not a request');
  throws(() => decodeTraces('bytes'), (error) => {
    if (!(error instanceof TypeError)) throw error;
  }, 'not bytes');
});

test('close hands over the last take: trace.end and what is staged', async () => {
  const got = [];
  const host = logging((signal, data) => got.push([signal, data]), { flush: 0 });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  equal(got.length, 0, 'no flush interval: only a full staging or the stop');
  host.close();
  if (!got.some(([signal]) => signal === 'traces')) throw new Error('no traces at close');
  const other = decoder();
  if (!(await spanNames(other, got)).includes('scxml.macrostep go')) throw new Error('no macrostep go at close');
  other.close();
});

test('without a handler the requests are taken and dropped, so the encoder goes on', async () => {
  const clock = new SimulatedClock();
  const host = hostWith({ c: LOGGING }, { config: config(), clock });
  const session = host.spawn(host.chart('c'));
  for (let i = 0; i < 3; i++) {
    host.send(session, 'go');
    clock.increment(200);
    await host.idle();
  }
  host.close();
});

test('metrics are pulled outside a drain: its own batch, acknowledged at once', async () => {
  const host = logging(undefined);
  const first = host.metrics();
  if (!(first instanceof Uint8Array) || first.length === 0) throw new Error('metrics() gave no Uint8Array');
  if (host.metrics().length === 0) throw new Error('a second metrics() gave nothing'); // the first's batch was acknowledged
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle(); // and nothing was left open for the run
  host.close();
  const plain = new Host([], { system: 't', ...ENGINE });
  throws(() => plain.metrics(), status('TA_ERROR_STATE'), 'metrics() without telemetry');
  plain.close();
  throws(() => plain.metrics(), status('TA_ERROR_STATE'), 'metrics() on a closed host');
});

test('metrics from a handler join the open batch', async () => {
  const sizes = [];
  const clock = new SimulatedClock();
  const host = logging(() => sizes.push(host.metrics().length), { clock });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  clock.increment(200);
  await host.idle();
  if (sizes.length === 0 || !sizes.every((size) => size > 0)) throw new Error(`sizes ${sizes}`);
  host.send(host.spawn(host.chart('c')), 'go'); // the drain's batch was acked once: the run goes on
  await host.idle();
  host.close();
});

test('a handler that throws: idle() rejects, the encoder goes on, close() throws the last take\'s', async () => {
  const clock = new SimulatedClock();
  const host = logging(() => { throw new Error('collector down'); }, { clock });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  clock.increment(200);
  let rejected;
  try {
    await host.idle();
  } catch (error) {
    rejected = error;
  }
  equal(rejected?.message, 'collector down', 'idle() rejects with the handler\'s error');
  host.send(host.spawn(host.chart('c')), 'go'); // the request was taken
  await host.idle();
  throws(() => host.close(), (error) => equal(error.message, 'collector down', 'close()'), 'close()');
  equal(host.closed, true, 'freed before the error');
});

test('a handler that returns a promise runs in the turn; asyncDispose awaits the last take\'s', async () => {
  const got = [];
  const host = logging(async (signal) => {
    await sleep(5);
    got.push(signal);
  }, { flush: 0 });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  await host[Symbol.asyncDispose]();
  equal(got.sort().join(), 'logs,traces', 'awaited by asyncDispose');
  equal(host.closed, true, 'closed');
});

test('asyncDispose rejects with a promise\'s rejection in the last take', async () => {
  const got = [];
  const host = logging(async (signal) => {
    await sleep(5);
    got.push(signal);
    if (signal === 'logs') throw new Error('down');
  }, { flush: 0 });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  let rejected;
  try {
    await host[Symbol.asyncDispose]();
  } catch (error) {
    rejected = error;
  }
  equal(rejected?.message, 'down', 'the rejection');
  equal(got.sort().join(), 'logs,traces', 'both awaited');
});

// ---- the stop, with a handler that calls the host again --------------------------

async function staged(telemetry, options = {}) {
  const host = logging(telemetry, { flush: 0, ...options });
  host.send(host.spawn(host.chart('c')), 'go');
  await host.idle();
  return host;
}

test('close() from the handler of the last take is the close running', async () => {
  const got = [];
  const host = await staged((signal) => {
    got.push(signal);
    host.close(); // deferred: the close running now finishes
  });
  host.close();
  equal(host.closed, true, 'closed');
  if (!got.includes('traces')) throw new Error('no traces');
});

test('inputs from the handler of the last take end: it is bounded', async () => {
  let calls = 0;
  const host = await staged(() => {
    calls++;
    host.send(host.spawn('c'), 'go'); // more records at every take
  });
  host.close();
  equal(host.closed, true, 'closed');
  if (calls >= 200) throw new Error(`${calls} calls: unbounded`);
});

test('metrics from the handler of the last take join its batch', async () => {
  const sizes = [];
  const host = await staged(() => sizes.push(host.metrics().length));
  host.close();
  if (sizes.length === 0 || !sizes.every((size) => size > 0)) throw new Error(`sizes ${sizes}`);
});

test('a close a handler asked for: its last take\'s error rejects the waiting idle()', async () => {
  let closing = false;
  const host = logging(() => {
    if (closing) throw new Error('down at close');
  }, {
    flush: 0,
    log: () => {
      closing = true;
      host.close();
    },
  });
  host.send(host.spawn(host.chart('c')), 'go');
  let rejected;
  try {
    await host.idle();
  } catch (error) {
    rejected = error;
  }
  equal(rejected?.message, 'down at close', 'idle() rejects');
  equal(host.closed, true, 'closed at the end of the turn');
});

// ---- application spans above actors ------------------------------------------------

test('actor spans are children of the application\'s span, and the trace goes out to it', async () => {
  const APP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const APP_SPAN = '00f067aa0ba902b7';
  const front = scxml('front', `
    <state id="s"><transition event="order"><send event="reserve" targetexpr="_event.data.to"/></transition></state>`);
  const stock = scxml('stock', `
    <state id="s">
      <transition event="reserve"><send type="urn:test:app" target="w" event="out"/></transition>
      <transition event="reserved"/>
    </state>`);
  const got = [];
  const seen = [];
  const host = hostWith({ front, stock }, {
    config: { telemetry: {} },
    ioProcessors: { 'urn:test:app': processor((send) => { seen.push(send.traceparent); send.answer('reserved'); }) },
    telemetry: (signal, data) => got.push([signal, data]),
  });
  const frontSession = host.spawn(host.chart('front'));
  const stockSession = host.spawn(host.chart('stock'));
  await host.idle();
  host.send(frontSession, 'order', { to: `#_scxml_${stockSession.id}` }, { traceparent: `00-${APP_TRACE}-${APP_SPAN}-01` });
  await host.idle();
  host.close(); // the last take
  const other = decoder();
  const spans = [];
  for (const [signal, data] of got)
    if (signal === 'traces') other.traceSpansDecode({ traces: data }, (result) => spans.push(...result.spans));
  await other.idle();
  other.close();
  const ours = new Map(spans.filter((span) => span.trace === APP_TRACE)
    .map((span) => [`${span.name}/${span.attributes['tinyactors.chart.name']}`, span]));
  const order = ours.get('scxml.macrostep order/front');
  const sending = ours.get('scxml.microstep order/front');
  const reserve = ours.get('scxml.macrostep reserve/stock');
  const handling = ours.get('scxml.microstep reserve/stock');
  if (!order || !sending || !reserve || !handling) throw new Error(`spans: ${[...ours.keys()]}`);
  equal(order.parent, APP_SPAN, 'under the application\'s span');
  equal(sending.parent, order.span, 'the microstep under its macrostep');
  equal(reserve.parent, sending.span, 'the send between actors keeps the trace');
  equal(handling.parent, reserve.span, 'the receiver\'s microstep');
  equal(seen[0], `00-${APP_TRACE}-${handling.span}-01`, 'and out to the application');
});

// ---- watches ---------------------------------------------------------------------

const TWO = { a: quiet('a'), b: quiet('b') };

/** The charts whose `go` macrosteps the traces requests hold; `requests` emptied. */
async function chartsTraced(host, requests) {
  const traced = [];
  for (const [signal, data] of requests)
    if (signal === 'traces')
      host.traceSpansDecode({ traces: data }, (result) => traced.push(...result.spans
        .filter((span) => span.name === 'scxml.macrostep go').map((span) => span.attributes['tinyactors.chart.name'])));
  await host.idle();
  requests.length = 0;
  return traced.sort().join();
}

test('a watch traces what it matches until it ends, on a simulated clock', async () => {
  const got = [];
  const replies = [];
  const clock = new SimulatedClock();
  const host = hostWith(TWO, { config: config({ flushInterval: 10 }), telemetry: (signal, data) => got.push([signal, data]), clock });
  const a = host.spawn(host.chart('a'));
  const b = host.spawn(host.chart('b'));
  const keep = (result) => replies.push(result);
  async function step() {
    host.send(a, 'go');
    host.send(b, 'go');
    await host.idle();
    clock.increment(20); // past flushInterval: the requests come
    await host.idle();
    return chartsTraced(host, got);
  }
  host.traceConfigure({ sample: 0 }, keep); // nothing is sampled but what a watch keeps
  host.traceWatch({ rules: [{ chart: 'b', sample: 'sample', detail: 'full' }], seconds: 1 }, keep);
  await host.idle();
  equal(JSON.stringify(replies.at(-1)), '{"id":1}', 'the watch\'s id');
  equal(await step(), 'b', 'b alone, while the watch lasts');
  clock.increment(1000); // the watch's end: a deadline of the host's clock
  await host.idle();
  equal(await step(), '', 'nothing after it');
  host.traceWatch({ rules: [{ chart: 'a', sample: 'sample' }] }, keep);
  await host.idle();
  equal(await step(), 'a', 'a watch with no end');
  host.traceUnwatch({ id: replies.at(-1).id }, keep);
  await host.idle();
  equal(await step(), '', 'unwatched');
  const errors = [];
  host.traceUnwatch({ id: 2 }, keep, (error) => errors.push(error.reason));
  await host.idle();
  equal(errors.join(), 'stale', 'a watch that ended');
  host.close();
});

test('a watch ends on the real clock, through the host\'s timer', async () => {
  // The watch's end is the host's clock at the call plus its length, read
  // between `start` and `started`. The event during it counts only if its
  // turn ended before the earliest end; a machine too slow for that makes
  // the attempt inconclusive, and the next one is four times longer. The
  // event after it is sent once the clock is past the latest end.
  for (let seconds = 0.25; ; seconds *= 4) {
    const got = [];
    // 1 ms: ticks are nanoseconds by default
    const host = hostWith(TWO, { config: { telemetry: { flushInterval: 1_000_000 } }, telemetry: (signal, data) => got.push([signal, data]) });
    async function settle() { // the host's own timer flushes what is staged
      for (let i = 0; i < 10; i++) {
        await sleep(5);
        await host.idle();
      }
    }
    try {
      const a = host.spawn(host.chart('a'));
      host.traceConfigure({ sample: 0 }, () => {});
      await settle();
      got.length = 0;
      const start = performance.now();
      host.traceWatch({ rules: [{ chart: 'a', sample: 'sample' }], seconds }, () => {});
      const started = performance.now();
      host.send(a, 'go');
      await host.idle();
      const ran = performance.now();
      for (let i = 0; i < 400 && !got.some(([signal]) => signal === 'traces'); i++) { // flushed by the host's timer
        await sleep(5);
        await host.idle();
      }
      const during = await chartsTraced(host, got);
      if (ran - start >= seconds * 1000) {
        if (seconds >= 64) throw new Error(`the event's turn took ${ran - start} ms, longer than every watch`);
        continue; // inconclusive: the watch may have ended before the event's turn
      }
      await sleep(started + seconds * 1000 + 5 - performance.now()); // past the watch's end, a deadline of the host's timer
      await settle();
      host.send(a, 'go');
      await settle();
      const after = await chartsTraced(host, got);
      equal(`${during}|${after}`, 'a|', 'traced during the watch, not after');
      return;
    } finally {
      host.close();
    }
  }
});

test('options.telemetry is a function', () => {
  throws(() => new Host(config(), { ...ENGINE, telemetry: 1 }), (error) => {
    if (!(error instanceof TypeError)) throw error;
  }, 'a number');
});

await run();
