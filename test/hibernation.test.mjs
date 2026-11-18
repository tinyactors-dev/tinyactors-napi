// Hibernation (docs/plan.xml, p2-hibernate; translated from
// tinyactors-cpython/tests/test_hibernation.py): sweep, hibernate, the
// wake handler and wake, on the datamodel under test. A blob is a Uint8Array
// copied once; a hibernated native session leaves nothing in the engine;
// its events and its delayed sends wait in the host until the application
// wakes it; a value outside the value table keeps it resident.
import { Host, SimulatedClock } from '@tinyactors/node';
import { CONFIG, DATAMODEL, ENGINE, equal, hostWith, scxml, status, throws, typeError } from './charts.mjs';
import { collect, run, test } from './harness.mjs';

/** The counter: `inc` counts and keeps its data, `report` logs both and
 * the event's name, `wait` sends `later` to itself after a second. */
const counter = ({ exit = '', more = '' } = {}) => scxml('counter', `
  <datamodel>
    <data id="n" expr="0"/>
    <data id="items" expr="[]"/>
  </datamodel>
  <state id="s">
    ${exit}
    <transition event="inc">
      <assign location="n" expr="n + 1"/>
      <assign location="items" expr="items.concat([_event.data])"/>
    </transition>
    <transition event="report">
      <log label="n" expr="n + ' ' + JSON.stringify(items) + ' ' + _event.name"/>
    </transition>
    <transition event="wait">
      <send event="later" delay="1s"/>
    </transition>
    ${more}
  </state>`);

/** A wake handler over a Map, as an application's store would be. */
class Store {
  constructor() {
    this.blobs = new Map();
    this.wakes = [];
    this.handler = (host, session, migration) => {
      this.wakes.push([session, migration]);
      host.wake(session, this.blobs.get(session));
      this.blobs.delete(session);
    };
  }
}

/** A log handler keeping the lines of each label. */
class Logs {
  constructor() {
    this.lines = [];
    this.handler = (host, entry) => this.lines.push([entry.label, entry.text]);
  }
  labelled(label) {
    return this.lines.filter(([l]) => l === label).map(([, text]) => text);
  }
}

test('an actor wakes with its variables: the blob is a Uint8Array, one WAKE brings it back', async () => {
  const logs = new Logs();
  const store = new Store();
  const host = hostWith({ counter: counter() }, { log: logs.handler, wake: store.handler });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc', { k: 1 });
  host.send(session, 'inc', 'two');
  await host.idle();
  const blob = host.hibernate(session);
  if (!(blob instanceof Uint8Array) || blob.length === 0) throw new Error('the blob is not a non-empty Uint8Array');
  store.blobs.set(session, blob);
  host.send(session, 'report');
  await host.idle();
  equal(store.wakes.length, 1, 'one WAKE');
  equal(store.wakes[0][0], session, 'for the session');
  equal(store.wakes[0][1], undefined, 'no migration asked');
  equal(logs.labelled('n').join('|'), '2 [{"k":1},"two"] report', 'its variables survived');
  host.close();
});

test('an actor wakes with its last event: an <onexit> at terminate reads it', async () => {
  const logs = new Logs();
  const exit = '<onexit><log label="exit" expr="_event.name + \' \' + JSON.stringify(_event.data)"/></onexit>';
  const host = hostWith({ counter: counter({ exit }) }, { log: logs.handler });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc', { k: 7 });
  await host.idle();
  const blob = host.hibernate(session);
  host.wake(session, blob);
  host.terminate(session);
  await host.idle();
  equal(logs.labelled('exit').join('|'), 'inc {"k":7}', '_event is the last event');
  host.close();
});

test('events wait until the wake: one WAKE however many come, then they run in order', async () => {
  const logs = new Logs();
  const wakes = [];
  const host = hostWith({ counter: counter() }, { log: logs.handler, wake: (h, session) => wakes.push(session) });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  const blob = host.hibernate(session);
  for (let i = 0; i < 3; i++) host.send(session, 'inc', i);
  host.send(session, 'report');
  await host.idle();
  equal(wakes.length, 1, 'one WAKE');
  equal(logs.labelled('n').length, 0, 'nothing ran');
  host.wake(session, blob);
  await host.idle();
  equal(logs.labelled('n').join('|'), '3 [0,1,2] report', 'they ran in order');
  host.close();
});

test('without a wake handler the effect is dropped: the actor stays hibernated until wake', async () => {
  const logs = new Logs();
  const host = hostWith({ counter: counter() }, { log: logs.handler });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  const blob = host.hibernate(session);
  host.send(session, 'report');
  await host.idle();
  equal(logs.labelled('n').length, 0, 'it waits');
  host.wake(session, new Uint8Array(blob).buffer); // an ArrayBuffer is a blob too
  await host.idle();
  equal(logs.labelled('n').join('|'), '0 [] report', 'woken by the application');
  host.close();
});

test('the sweep returns the actors that did not run since the last one', async () => {
  const host = hostWith({ counter: counter() });
  const ref = host.chart('counter');
  const sessions = [0, 1, 2, 3].map(() => host.spawn(ref));
  await host.idle();
  host.sweep(1024, 16); // clears every actor's bit
  host.send(sessions[1], 'inc', 0);
  await host.idle();
  const cold = host.sweep(1024, 16);
  for (const session of cold) if (typeof session !== 'bigint') throw new Error('a session is not a bigint');
  const sorted = (list) => list.map(String).sort().join();
  equal(sorted(cold), sorted([sessions[0], sessions[2], sessions[3]]), 'the cold ones');
  equal(host.sweep(1024, 2).length, 2, 'at most limit');
  equal(host.sweep(0, 16).length, 0, 'nothing scanned');
  host.close();
});

test('a delayed send wakes the actor it was sent to when it falls due', async () => {
  const logs = new Logs();
  const store = new Store();
  const clock = new SimulatedClock();
  const more = '<transition event="later"><log label="later" expr="String(n)"/></transition>';
  const host = hostWith({ counter: counter({ more }) }, { log: logs.handler, wake: store.handler, clock });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc', 0);
  host.send(session, 'wait');
  await host.idle();
  store.blobs.set(session, host.hibernate(session));
  clock.increment(999);
  await host.idle();
  equal(store.wakes.length, 0, 'not yet due');
  clock.increment(1);
  await host.idle();
  equal(store.wakes.length, 1, 'due: a WAKE');
  equal(logs.labelled('later').join('|'), '1', 'delivered after the wake');
  host.close();
});

test('hibernate refuses an actor with events waiting, and one hibernated already', async () => {
  const host = hostWith({ counter: counter() });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  host.send(session, 'inc', 1);
  throws(() => host.hibernate(session), status('TA_ERROR_STATE'), 'events waiting');
  await host.idle();
  host.hibernate(session);
  throws(() => host.hibernate(session), status('TA_ERROR_STATE'), 'hibernated already');
  host.close();
});

test('a value outside the table keeps the actor resident, and the error names the variable', async () => {
  const logs = new Logs();
  const chart = scxml('odd', `
    <datamodel><data id="v" expr="0"/></datamodel>
    <state id="s">
      <transition event="odd"><assign location="v" expr="(function () { return [1, 2]; })"/></transition>
      <transition event="report"><log label="v" expr="JSON.stringify(v())"/></transition>
    </state>`);
  const host = hostWith({ odd: chart }, { log: logs.handler });
  const session = host.spawn(host.chart('odd'));
  host.send(session, 'odd');
  await host.idle();
  throws(() => host.hibernate(session), (error) => {
    status('TA_ERROR_UNSUPPORTED')(error);
    if (!/'v'/.test(error.message)) throw new Error(`the message names no variable: ${error.message}`);
  }, 'a function');
  host.send(session, 'report');
  await host.idle();
  equal(logs.labelled('v').join('|'), '[1,2]', 'still resident');
  host.close();
});

test('native: a Map, a class instance, a Date or an XML document in a variable keeps the actor resident', async () => {
  if (DATAMODEL !== 'native') return; // quickjs stores what its engine can
  const odd = (data, assign) => scxml('odd', `
    <datamodel>${data}</datamodel>
    <state id="s"><transition event="odd">${assign}</transition></state>`);
  const charts = ['new Map()', 'new (class Point {})()', 'new Date(0)']
    .map((expr) => odd('<data id="v" expr="0"/>', `<assign location="v" expr="${expr}"/>`));
  charts.push(odd('<data id="v"><doc><item/></doc></data>', '')); // XML content: a DOM
  for (const chart of charts) {
    const host = hostWith({ odd: chart });
    const session = host.spawn(host.chart('odd'));
    host.send(session, 'odd');
    await host.idle();
    throws(() => host.hibernate(session), status('TA_ERROR_UNSUPPORTED'), chart);
    host.close();
  }
});

test('native: a hibernated actor holds nothing in the engine; its values come back with the blob', async () => {
  if (DATAMODEL !== 'native') return; // quickjs's heap is its own malloc
  const chart = scxml('big', `
    <datamodel><data id="big" expr="[]"/></datamodel>
    <state id="s">
      <transition event="fill"><assign location="big" expr="Array.from({length: 4000}, (_, i) => i * 1.5)"/></transition>
      <transition event="report"><log label="sum" expr="String(big.reduce((a, b) => a + b, 0))"/></transition>
    </state>`);
  const logs = new Logs();
  const store = new Store();
  const host = hostWith({ big: chart }, { log: logs.handler, wake: store.handler });
  const ref = host.chart('big');
  const sessions = Array.from({ length: 200 }, () => host.spawn(ref));
  await host.idle();
  await collect();
  const empty = process.memoryUsage().heapUsed;
  for (const session of sessions) host.send(session, 'fill');
  await host.idle();
  await collect();
  const full = process.memoryUsage().heapUsed;
  for (const session of sessions) store.blobs.set(session, host.hibernate(session));
  await collect();
  // Bun counts a Buffer's bytes in heapUsed, node does not: the blobs the
  // store keeps are not the actors' (bun:jsc's heapStats, 2026-10-16)
  let blobs = 0;
  for (const blob of store.blobs.values()) blobs += blob.length;
  const after = process.memoryUsage().heapUsed - (globalThis.Bun ? blobs : 0);
  // the arrays (200 of 4000 numbers) leave the engine's heap with their actors
  if (full - empty < 1_000_000) throw new Error(`the arrays took ${full - empty} B of heap only`);
  if (full - after < 0.8 * (full - empty)) throw new Error(`the heap went from ${full} to ${after}, the arrays took ${full - empty}`);
  host.send(sessions[7], 'report');
  await host.idle();
  equal(logs.labelled('sum').join('|'), String(1.5 * (3999 * 4000) / 2), 'woken with its array');
  host.close();
});

test('a chart whose scripts declare: its var and function come back after the wake', async () => {
  const chart = scxml('declares', `
    <script>var count = 10; function next() { count = count + 1; return count; }</script>
    <state id="s">
      <transition event="tick"><script>next();</script></transition>
      <transition event="report"><log label="count" expr="String(next())"/></transition>
    </state>`);
  const logs = new Logs();
  const store = new Store();
  const host = hostWith({ declares: chart }, { log: logs.handler, wake: store.handler });
  const session = host.spawn(host.chart('declares'));
  host.send(session, 'tick');
  host.send(session, 'tick'); // the var written by the function twice: its last value goes (bun's global is stale)
  await host.idle();
  store.blobs.set(session, host.hibernate(session));
  host.send(session, 'report');
  await host.idle();
  equal(logs.labelled('count').join('|'), '13', 'the var kept, the function made again');
  host.close();
});

test('a chart whose scripts declare with let: native keeps it resident, quickjs hibernates it', async () => {
  const chart = scxml('lexical', `
    <script>let count = 10;</script>
    <state id="s">
      <transition event="tick"><script>count = count + 1;</script></transition>
      <transition event="report"><log label="count" expr="String(count)"/></transition>
    </state>`);
  const logs = new Logs();
  const store = new Store();
  const host = hostWith({ lexical: chart }, { log: logs.handler, wake: store.handler });
  const session = host.spawn(host.chart('lexical'));
  host.send(session, 'tick');
  await host.idle();
  if (DATAMODEL === 'native') {
    throws(() => host.hibernate(session), (error) => {
      status('TA_ERROR_UNSUPPORTED')(error);
      if (!/let, const or class/.test(error.message)) throw new Error(`the message says nothing of let: ${error.message}`);
    }, 'a let binding');
  } else store.blobs.set(session, host.hibernate(session));
  host.send(session, 'report');
  await host.idle();
  equal(logs.labelled('count').join('|'), '11', 'its binding kept');
  host.close();
});

test('wake refuses an older blob of the session: a store that fell behind loses no state', async () => {
  const logs = new Logs();
  const host = hostWith({ counter: counter() }, { log: logs.handler });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  const older = host.hibernate(session);
  host.wake(session, older);
  host.send(session, 'inc', 1);
  await host.idle();
  const latest = host.hibernate(session);
  throws(() => host.wake(session, older), status('TA_ERROR_STALE'), 'an earlier blob');
  host.wake(session, latest);
  host.send(session, 'report');
  await host.idle();
  equal(logs.labelled('n').join('|'), '1 [1] report', 'woken from the latest');
  host.close();
});

test('wake refuses another host\'s blob for a session of the same number; a restored host wakes its own', async () => {
  const logs = new Logs();
  const one = hostWith({ counter: counter() }, { log: logs.handler });
  const two = hostWith({ counter: counter() }); // the same config, system id and image
  const session = one.spawn(one.chart('counter'));
  equal(two.spawn(two.chart('counter')), session, 'the same session number');
  one.send(session, 'inc', 1);
  await one.idle();
  await two.idle();
  const blobOne = one.hibernate(session);
  const blobTwo = two.hibernate(session);
  throws(() => two.wake(session, blobOne), status('TA_ERROR_INVALID'), 'the first host\'s blob in the second');
  throws(() => one.wake(session, blobTwo), status('TA_ERROR_INVALID'), 'and the reverse');
  two.wake(session, blobTwo);
  two.close();
  const snapshot = one.snapshot();
  one.close();
  const restored = Host.restore(snapshot, CONFIG, { ...ENGINE, log: logs.handler });
  throws(() => restored.wake(session, blobTwo), status('TA_ERROR_INVALID'), 'the second host\'s blob after the restore');
  restored.wake(session, blobOne);
  restored.send(session, 'report');
  await restored.idle();
  restored.close();
  equal(logs.labelled('n').join('|'), '1 [1] report', 'woken in the restored host, with its state');
});

test('wake refuses a blob it cannot read, and a session that is not hibernated', async () => {
  const host = hostWith({ counter: counter() });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  const blob = host.hibernate(session);
  throws(() => host.wake(session, new TextEncoder().encode('\u0000not a blob')), (error) => {
    if (error.status === undefined) throw error;
  }, 'not a blob');
  host.wake(session, blob);
  throws(() => host.wake(session, blob), (error) => {
    if (error.status === undefined) throw error;
  }, 'awake already');
  throws(() => host.wake(session, 'a string'), typeError, 'not bytes');
  host.close();
});

test('a wake handler that throws: its error rejects idle()', async () => {
  const host = hostWith({ counter: counter() }, {
    wake: () => {
      throw new Error('store down');
    },
  });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  host.hibernate(session);
  host.send(session, 'inc', 1);
  let caught;
  await host.idle().catch((error) => (caught = error));
  equal(caught?.message, 'store down', 'the handler\'s error');
  host.close();
});

test('an async wake handler wakes the actor later, from its promise', async () => {
  const logs = new Logs();
  const blobs = new Map();
  const host = hostWith({ counter: counter() }, {
    log: logs.handler,
    wake: async (h, session) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      h.wake(session, blobs.get(session));
    },
  });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  blobs.set(session, host.hibernate(session));
  host.send(session, 'inc', 5);
  host.send(session, 'report');
  await host.idle();
  for (let i = 0; i < 50 && logs.labelled('n').length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await host.idle();
  }
  equal(logs.labelled('n').join('|'), '1 [5] report', 'woken from the promise');
  host.close();
});

test('hibernate from a call inside a call outside a turn leaves no batch open', async () => {
  const logs = new Logs();
  const store = new Store();
  const host = hostWith({ counter: counter() }, { log: logs.handler, wake: store.handler });
  const ref = host.chart('counter');
  const a = host.spawn(ref);
  const b = host.spawn(ref);
  await host.idle();
  const item = {
    target: b,
    get event() {
      store.blobs.set(a, host.hibernate(a)); // a getter sendMany reads: a call inside a call
      return 'inc';
    },
    data: 1,
  };
  equal(host.sendMany([item]), 1, 'sent');
  await host.idle();
  host.send(a, 'report');
  await host.idle();
  equal(logs.labelled('n').join('|'), '0 [] report', 'the next runs were not refused');
  host.close();
});

test('hibernate from a handler joins the open batch', async () => {
  const store = new Store();
  const logs = new Logs();
  let taken = 0;
  const host = hostWith({ counter: counter() }, {
    wake: store.handler,
    log: (h, entry) => {
      logs.handler(h, entry);
      if (taken++ === 0) store.blobs.set(entry.session, h.hibernate(entry.session));
      equal(entry.label, 'n', 'the view is still valid after the take');
    },
  });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'report');
  await host.idle();
  equal(store.blobs.size, 1, 'hibernated from the handler');
  host.send(session, 'report');
  await host.idle();
  equal(logs.labelled('n').length, 2, 'woken and reported again');
  host.close();
});

test('hibernate between turns ends no effect undispatched', async () => {
  let replies = 0;
  const again = (h) => {
    replies++;
    if (replies < 200) h.hostStats(undefined, again);
  };
  const host = hostWith({ counter: counter() });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  host.hostStats(undefined, () => {
    throw new Error('stop the turn');
  });
  host.hostStats(undefined, again);
  await host.idle().catch(() => {});
  host.hibernate(session);
  await host.idle();
  equal(replies, 200, 'every reply dispatched');
  host.close();
});

test('sweep, hibernate and wake refuse numbers out of range', async () => {
  const host = hostWith({ counter: counter() });
  for (const [scan, limit] of [[10, -1], [10, 2 ** 32 + 3], [-1, 1], [1.5, 1], [10n, 1], [10, undefined]])
    throws(() => host.sweep(scan, limit), typeError, `sweep(${scan}, ${limit})`);
  for (const session of [-1n, 0n, 0, 1.5, 2 ** 53, 2n ** 64n])
    throws(() => host.wake(session, new Uint8Array(1)), typeError, `wake(${session})`);
  throws(() => host.hibernate(1.5), typeError, 'hibernate(1.5)');
  host.close();
  throws(() => host.sweep(1, 1), status('TA_ERROR_STATE'), 'a closed host');
});

test('a function declared in a transition\'s script, and a \'use strict\' that starts one, hibernate and wake', async () => {
  // a chart-level var makes the chart declaring: a context per session
  const chart = scxml('blocks', `
    <script>var n = 0;</script>
    <state id="s">
      <transition event="go"><script>function f() { return n + 1; } n = f();</script><log label="n" expr="String(n)"/></transition>
      <transition event="strict"><script>'use strict'; try { undeclared = 1; n = -1; } catch (e) { n = 100; }</script>
        <log label="n" expr="String(n)"/></transition>
    </state>`);
  const logs = new Logs();
  const store = new Store();
  const host = hostWith({ blocks: chart }, { log: logs.handler, wake: store.handler });
  const session = host.spawn(host.chart('blocks'));
  host.send(session, 'go');
  await host.idle();
  store.blobs.set(session, host.hibernate(session)); // f is the script's again at each run: not stored
  host.send(session, 'go');
  await host.idle();
  host.send(session, 'strict');
  await host.idle();
  store.blobs.set(session, host.hibernate(session));
  host.send(session, 'go');
  await host.idle();
  host.close();
  equal(logs.labelled('n').join(), '1,2,100,101', 'n across the wakes; the directive applied');
});

await run();
