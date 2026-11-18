// Migration (docs/plan.xml, p2-migrate; translated from
// tinyactors-cpython/tests/test_migration.py): host.migrate, the migrated
// handler and the migrationDone handler, on the datamodel under test. An
// actor moves to the current version of its chart with its bindings (the
// upgrade's data), keeps its delayed sends and their data, a hibernated
// one is asked for with the migration's id, and the result names the
// sessions a timeout left behind.
import { SimulatedClock } from '@tinyactors/node';
import { DATAMODEL, equal, hostWith, image, scxml, status, throws, typeError } from './charts.mjs';
import { run, test } from './harness.mjs';

/** Version 1 counts in n; `wait` sends `later` to itself after a second
 * with data; `odd` puts a function, outside the value table, in `other`. */
const V1 = scxml('counter', `
  <datamodel>
    <data id="n" expr="0"/>
    <data id="other" expr="0"/>
  </datamodel>
  <state id="s">
    <transition event="inc"><assign location="n" expr="n + 1"/></transition>
    <transition event="wait">
      <send event="later" delay="1s"><content expr="({at: n, items: [1, 'two', {three: 3}]})"/></send>
    </transition>
    <transition event="odd"><assign location="other" expr="(function () { return 1; })"/></transition>
  </state>`);

/** Version 2 takes n from error.platform.upgrade and knows its version;
 * `seen` is the upgrade data's names (quickjs's also names version 2's new
 * variables, undefined: left out). */
const V2 = scxml('counter', `
  <datamodel>
    <data id="n" expr="0"/>
    <data id="version" expr="2"/>
    <data id="seen" expr="0"/>
  </datamodel>
  <state id="s">
    <transition event="error.platform.upgrade">
      <assign location="n" expr="_event.data.n"/>
      <assign location="seen" expr="Object.keys(_event.data).filter(function (k) { return _event.data[k] !== undefined; }).sort()"/>
    </transition>
    <transition event="inc"><assign location="n" expr="n + 1"/></transition>
    <transition event="report"><log label="n" expr="n + ' ' + version + ' ' + JSON.stringify(seen)"/></transition>
    <transition event="later"><log label="later" expr="n + ' ' + JSON.stringify(_event.data)"/></transition>
  </state>`);

const OTHER = scxml('other', '<state id="s"/>');

class Logs {
  constructor() {
    this.lines = [];
    this.handler = (host, entry) => this.lines.push([entry.label, entry.text]);
  }
  labelled(label) {
    return this.lines.filter(([l]) => l === label).map(([, text]) => text);
  }
}

const add = (host, text) => host.addImage(image({ counter: text }));
const json = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));

test('an actor moves with its bindings: one MIGRATED, then migrationDone', async () => {
  const logs = new Logs();
  const moved = [];
  const done = [];
  const migrated = (host, entry) => moved.push([entry.session, entry.segment, entry.chart, entry.migration]);
  const host = hostWith({ counter: V1 }, { log: logs.handler, migrated, migrationDone: (host, result) => done.push(result) });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc');
  host.send(session, 'inc');
  await host.idle();
  const segment = add(host, V2);
  const migration = host.migrate();
  equal(typeof migration, 'number', 'the migration id is a number');
  await host.idle();
  host.send(session, 'inc');
  host.send(session, 'report');
  await host.idle();
  host.close();
  equal(json(done), json([{ migration, migrated: 1, failed: [], pending: [] }]), 'the result');
  equal(json(moved), json([[session, segment, 'counter', migration]]), 'the moved actor');
  equal(logs.labelled('n').join('|'), '3 2 ["n","other"]', 'the old bindings, exactly version 1\'s');
});

test('a delayed send survives the move with its data', async () => {
  const logs = new Logs();
  const clock = new SimulatedClock();
  const host = hostWith({ counter: V1 }, { log: logs.handler, clock });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc');
  host.send(session, 'wait');
  await host.idle();
  add(host, V2);
  host.migrate();
  await host.idle();
  clock.increment(1000);
  await host.idle();
  host.close();
  equal(logs.labelled('later').join('|'), '1 {"at":1,"items":[1,"two",{"three":3}]}', 'the delayed send, in version 2');
});

test('a hibernated actor is asked for with its migration', async () => {
  const logs = new Logs();
  const blobs = new Map();
  const asked = [];
  const done = [];
  const wake = (host, session, migration) => {
    asked.push([session, migration]);
    host.wake(session, blobs.get(session));
    blobs.delete(session);
  };
  const host = hostWith({ counter: V1 }, { log: logs.handler, wake, migrationDone: (host, result) => done.push(result) });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc');
  await host.idle();
  blobs.set(session, host.hibernate(session));
  add(host, V2);
  const migration = host.migrate({ wake: true });
  await host.idle();
  host.send(session, 'report');
  await host.idle();
  host.close();
  equal(json(asked), json([[session, migration]]), 'one WAKE naming the migration');
  equal(done[0].migrated, 1, 'migrated');
  equal(logs.labelled('n').join('|'), '1 2 ["n","other"]', 'its bindings came with the blob');
});

test('an event\'s WAKE names no migration', async () => {
  const blobs = new Map();
  const asked = [];
  const wake = (host, session, migration) => {
    asked.push(migration);
    host.wake(session, blobs.get(session));
  };
  const host = hostWith({ counter: V1 }, { wake });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  blobs.set(session, host.hibernate(session));
  host.send(session, 'inc');
  await host.idle();
  host.close();
  equal(json(asked), json([undefined]), 'migration undefined');
});

test('without wake or timeout a hibernated actor holds the migration', async () => {
  const done = [];
  const clock = new SimulatedClock();
  const host = hostWith({ counter: V1 }, { clock, migrationDone: (host, result) => done.push(result) });
  const asleep = host.spawn(host.chart('counter'));
  await host.idle();
  host.hibernate(asleep);
  add(host, V2);
  host.migrate();
  await host.idle();
  clock.increment(60_000);
  await host.idle();
  host.close();
  equal(done.length, 0, 'no end');
});

test('without wake a hibernated actor is left at the timeout, in pending', async () => {
  const done = [];
  const clock = new SimulatedClock();
  const host = hostWith({ counter: V1 }, { clock, migrationDone: (host, result) => done.push(result) });
  const asleep = host.spawn(host.chart('counter'));
  const awake = host.spawn(host.chart('counter'));
  await host.idle();
  host.hibernate(asleep);
  add(host, V2);
  const migration = host.migrate({ timeout: 500 });
  await host.idle();
  equal(done.length, 0, 'no end before the timeout');
  clock.increment(499);
  await host.idle();
  equal(done.length, 0, 'none a millisecond before it');
  clock.increment(1);
  await host.idle();
  host.close();
  equal(json(done), json([{ migration, migrated: 1, failed: [], pending: [asleep] }]), 'the result');
  if (done[0].pending.includes(awake)) throw new Error('the awake actor is pending');
  if (!Object.isFrozen(done[0].pending)) throw new Error('pending is not frozen');
});

test('a timeout is rounded up to the next tick', async () => {
  const done = [];
  const clock = new SimulatedClock();
  const config = { systemID: 't', system: { ticksPerSecond: 10 } }; // a tick is 100 ms
  const host = hostWith({ counter: V1 }, { config, clock, migrationDone: (host, result) => done.push(result) });
  const asleep = host.spawn(host.chart('counter'));
  await host.idle();
  host.hibernate(asleep);
  add(host, V2);
  host.migrate({ timeout: 150 }); // two ticks, not one
  clock.increment(100);
  await host.idle();
  equal(done.length, 0, 'not at the first tick');
  clock.increment(100);
  await host.idle();
  host.close();
  equal(done.length, 1, 'at the second');
});

test('one session or one chart', async () => {
  const done = [];
  const host = hostWith({ counter: V1, other: OTHER }, { migrationDone: (host, result) => done.push(result) });
  const a = host.spawn(host.chart('counter'));
  host.spawn(host.chart('counter'));
  await host.idle();
  add(host, V2);
  host.migrate({ session: a });
  await host.idle();
  host.migrate({ chart: 'other' });
  await host.idle();
  host.migrate({ chart: 'counter' });
  await host.idle();
  host.close();
  equal(done.map((result) => result.migrated).join(','), '1,0,1', 'one, none, the other');
});

test('a chart the host does not have, or a session that ended, is refused', async () => {
  const done = [];
  const host = hostWith({ counter: V1 }, { migrationDone: (host, result) => done.push(result) });
  throws(() => host.migrate({ chart: 'counters' }), status('TA_ERROR_INVALID'), 'a typo of the chart');
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  host.terminate(session);
  await host.idle();
  throws(() => host.migrate({ session }), status('TA_ERROR_STALE'), 'a session that ended');
  await host.idle();
  host.close();
  equal(done.length, 0, 'no migration was started');
});

test('an actor with a value outside the table fails and stays on version 1', async () => {
  const logs = new Logs();
  const done = [];
  const v1 = V1.replace('</state>', '<transition event="report"><log label="n" expr="\'v1 \' + n"/></transition></state>');
  const host = hostWith({ counter: v1 }, { log: logs.handler, migrationDone: (host, result) => done.push(result) });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'odd');
  await host.idle();
  add(host, V2);
  host.migrate();
  await host.idle();
  host.send(session, 'inc'); // still version 1, still running
  host.send(session, 'report');
  await host.idle();
  host.close();
  equal(done[0].migrated, 0, 'none migrated');
  equal(json(done[0].failed), json([{ session, reason: 'TA_ERROR_UNSUPPORTED' }]), 'the failed one, named, and why');
  equal(logs.labelled('n').join('|'), 'v1 1', 'still version 1');
});

test('native: a declaring chart migrates: its old names go, the new scripts\' are declared', async () => {
  if (DATAMODEL !== 'native') return; // quickjs keeps its own globals
  const logs = new Logs();
  const v1 = scxml('counter', `
    <datamodel><data id="n" expr="0"/></datamodel>
    <script>var old = 7; function twice(x) { return 2 * x; }</script>
    <state id="s"><transition event="inc"><assign location="n" expr="twice(n + 1)"/></transition></state>`);
  const v2 = scxml('counter', `
    <datamodel><data id="n" expr="0"/></datamodel>
    <script>var fresh = 1;</script>
    <state id="s">
      <transition event="error.platform.upgrade"><assign location="n" expr="_event.data.n + _event.data.old"/></transition>
      <transition event="report">
        <log label="n" expr="n + ' ' + typeof old + ' ' + typeof twice + ' ' + fresh"/>
      </transition>
    </state>`);
  const host = hostWith({ counter: v1 }, { log: logs.handler });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc');
  await host.idle();
  add(host, v2);
  host.migrate();
  await host.idle();
  host.send(session, 'report');
  await host.idle();
  host.close();
  // fresh is declared (a bare read of it does not throw) and undefined: a
  // migrated actor's new scripts are instantiated, not run
  equal(logs.labelled('n').join('|'), '9 undefined undefined undefined', 'the old bindings in the data, the old names gone');
});

test('the Migrated view: fields on first read, stale after the ack', async () => {
  const kept = [];
  const migrated = (host, entry) => {
    kept.push(entry);
    equal(entry.chart, 'counter', 'its chart, read in the handler');
  };
  const host = hostWith({ counter: V1 }, { migrated });
  host.spawn(host.chart('counter'));
  await host.idle();
  add(host, V2);
  host.migrate();
  await host.idle();
  equal(kept[0].chart, 'counter', 'a field read stays');
  throws(() => kept[0].session, status('TA_ERROR_STALE'), 'a field not read');
  host.close();
});

test('a migrationDone handler that throws: its error rejects idle()', async () => {
  const host = hostWith({ counter: V1 }, {
    migrationDone: () => {
      throw new RangeError('migrationDone handler');
    },
  });
  host.spawn(host.chart('counter'));
  await host.idle();
  add(host, V2);
  host.migrate();
  let caught;
  await host.idle().catch((error) => (caught = error));
  if (!(caught instanceof RangeError)) throw new Error(`idle() did not reject with the handler's error: ${caught}`);
  host.close();
});

test('a migration unfinished at close never reaches its handler', async () => {
  const done = [];
  const host = hostWith({ counter: V1 }, { migrationDone: (host, result) => done.push(result) });
  const asleep = host.spawn(host.chart('counter'));
  await host.idle();
  host.hibernate(asleep);
  add(host, V2);
  host.migrate();
  await host.idle();
  host.close();
  equal(done.length, 0, 'never called');
});

test('migrate refuses bad arguments', async () => {
  const host = hostWith({ counter: V1 });
  const range = (error) => {
    if (!(error instanceof RangeError)) throw error;
  };
  throws(() => host.migrate(3), typeError, 'not an object');
  throws(() => host.migrate({ chart: 3 }), typeError, 'chart 3');
  throws(() => host.migrate({ chart: '' }), range, 'chart ""');
  throws(() => host.migrate({ session: 0n }), typeError, 'session 0n');
  throws(() => host.migrate({ session: 1.5 }), typeError, 'session 1.5, not an integer');
  throws(() => host.migrate({ wake: 1 }), typeError, 'wake 1');
  throws(() => host.migrate({ timeout: '1' }), typeError, 'timeout "1"');
  throws(() => host.migrate({ timeout: -1 }), range, 'timeout -1');
  throws(() => host.migrate({ timeout: Number.NaN }), range, 'timeout NaN');
  throws(() => host.migrate({ timeout: Infinity }), range, 'timeout Infinity');
  throws(() => host.migrate({ timeout: 2 ** 64 / 1e6 }), range, 'timeout of 2^64 nanoseconds');
  throws(() => host.migrate({ wakes: true }), typeError, 'an unknown option');
  host.close();
  throws(() => host.migrate(), status('TA_ERROR_STATE'), 'a closed host');
});

/** Version 1 invokes a service of type `thing` for as long as it is in `s`. */
const INVOKING = scxml('counter', `
  <state id="s">
    <invoke type="thing" id="svc" src="thing://here"/>
    <transition event="done.invoke.svc" target="after"/>
    <transition event="report"><log label="n" expr="'v1'"/></transition>
  </state>
  <state id="after">
    <transition event="report"><log label="n" expr="'v1'"/></transition>
  </state>`);

test('an actor running an invocation fails a migration without a timeout, and keeps its service', async () => {
  const logs = new Logs();
  const done = [];
  const stopped = [];
  const services = { thing: () => ({ stop: () => stopped.push('stop') }) };
  const host = hostWith({ counter: INVOKING }, { log: logs.handler, services, migrationDone: (host, result) => done.push(result) });
  const session = host.spawn(host.chart('counter'));
  await host.idle();
  add(host, V2);
  const migration = host.migrate();
  await host.idle();
  host.send(session, 'report');
  await host.idle();
  host.close();
  equal(json(done), json([{ migration, migrated: 0, failed: [{ session, reason: 'TA_ERROR_STATE' }], pending: [] }]),
    'it ends at once, the actor failed, and why');
  equal(stopped.length, 0, 'the service was not stopped');
  equal(logs.labelled('n').join('|'), 'v1', 'still version 1');
});

test('with a timeout, an actor running an invocation moves once it ends, or is pending at the timeout', async () => {
  const done = [];
  const invocations = [];
  const clock = new SimulatedClock();
  const services = { thing: (host, invocation) => { invocations.push(invocation); return {}; } };
  const host = hostWith({ counter: INVOKING }, { clock, services, migrationDone: (host, result) => done.push(result) });
  const ends = host.spawn(host.chart('counter'));
  const runs = host.spawn(host.chart('counter'));
  await host.idle();
  add(host, V2);
  const migration = host.migrate({ timeout: 500 });
  await host.idle();
  equal(done.length, 0, 'waiting for the invocations');
  invocations.find((invocation) => invocation.session === ends).done();
  await host.idle();
  clock.increment(500);
  await host.idle();
  host.close();
  equal(json(done), json([{ migration, migrated: 1, failed: [], pending: [runs] }]),
    'the one whose invocation ended moved, the other is pending');
});

await run();
