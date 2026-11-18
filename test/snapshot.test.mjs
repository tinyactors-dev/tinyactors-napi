// Snapshots (docs/plan.xml, p2-snapshot; translated from
// tinyactors-cpython/tests/test_snapshot.py): host.snapshot() and
// Host.restore, on the datamodel under test. A snapshot is a Uint8Array; a
// restored host goes on with its actors' variables, _event, a payload
// waiting in a mailbox and a delayed send due on a new clock that starts
// at 0; its own snapshot is the same bytes; what is not quiescent, or not
// in the value table, is refused.
import { Host, SimulatedClock, TinyactorsError } from '@tinyactors/node';
import { DATAMODEL, ENGINE, equal, image, indexOfBytes, LABEL, sameBytes, scxml, status, throws, typeError } from './charts.mjs';
import { run, test } from './harness.mjs';

const CONFIG = { systemID: 't', system: { ticksPerSecond: 1000 } };

/** tinyactors-cpython/tests/fixtures/test_snapshot/counter.ecmascript.scxml,
 * with `odd` (a function: outside the table) and `stop` added. */
const counter = ({ more = '' } = {}) => scxml('counter', `
  <datamodel>
    <data id="n" expr="0"/>
    <data id="items" expr="[]"/>
    <data id="other" expr="0"/>
  </datamodel>
  <state id="s">
    ${more}
    <transition event="inc">
      <assign location="n" expr="n + 1"/>
      <assign location="items" expr="items.concat([_event.data])"/>
    </transition>
    <transition event="report">
      <log label="n" expr="n + ' ' + JSON.stringify(items) + ' ' + _event.name + ' ' + (_sessionid == String(_event.data))"/>
    </transition>
    <transition event="wait">
      <send event="late" delay="1s">
        <content expr="({k: n})"/>
      </send>
    </transition>
    <transition event="late">
      <log label="late" expr="JSON.stringify(_event.data)"/>
    </transition>
    <transition event="odd">
      <assign location="other" expr="(function () { return 1; })"/>
    </transition>
  </state>`);

const COUNTER = counter();

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

function hostOf(document, options = {}) {
  const host = new Host(CONFIG, { ...ENGINE, clock: new SimulatedClock(), ...options });
  host.addImage(image({ counter: document }));
  return host;
}

const restore = (blob, options = {}) => Host.restore(blob, CONFIG, { ...ENGINE, ...options });

const same = sameBytes;

test('a host goes on after a restore: variables, _event, a waiting payload, a delayed send on a new clock', async () => {
  let logs = new Logs();
  let host = hostOf(COUNTER, { log: logs.handler });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc', { k: 1 });
  host.send(session, 'inc', 'two');
  host.send(session, 'wait');
  await host.idle();
  host.send(session, 'inc', 3); // waiting in the mailbox, its payload in the table
  const blob = host.snapshot();
  if (!(blob instanceof Uint8Array) || blob.length === 0) throw new Error('the snapshot is not a non-empty Uint8Array');
  host.close();
  // a new clock that starts at 0: the restored host goes on from the snapshot's time
  logs = new Logs();
  const clock = new SimulatedClock();
  host = restore(blob, { log: logs.handler, clock });
  host.send(session, 'report', String(session));
  await host.idle();
  equal(logs.labelled('late').length, 0, 'no late yet');
  clock.increment(999);
  await host.idle();
  equal(logs.labelled('late').length, 0, 'no late at 999 ms');
  clock.increment(1);
  await host.idle();
  const other = host.spawn(host.chart('counter'));
  if (other === session) throw new Error('a new actor got a restored session id');
  host.close();
  equal(logs.labelled('n').join('|'), '3 [{"k":1},"two",3] report true', 'the variables and the waiting payload');
  equal(logs.labelled('late').join('|'), '{"k":2}', 'the delayed send, due on the new clock');
});

test('the snapshot of a restored host is the same bytes', async () => {
  const clock = new SimulatedClock();
  let host = hostOf(COUNTER, { clock });
  for (let i = 0; i < 5; i++) {
    const session = host.spawn(host.chart('counter'));
    host.send(session, 'inc', [String(session)]);
    host.send(session, 'wait');
  }
  await host.idle();
  const blob = host.snapshot();
  host.close();
  host = restore(blob, { clock });
  const again = host.snapshot();
  host.close();
  if (!same(again, blob)) throw new Error(`the restored host's snapshot differs (${again.length} bytes, ${blob.length})`);
});

test('a hibernated actor wakes after a restore', async () => {
  const logs = new Logs();
  const blobs = new Map();
  const wake = (host, session) => {
    host.wake(session, blobs.get(session));
    blobs.delete(session);
  };
  let host = hostOf(COUNTER);
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc', 1);
  await host.idle();
  blobs.set(session, host.hibernate(session));
  const blob = host.snapshot();
  host.close();
  host = restore(blob, { log: logs.handler, wake, clock: new SimulatedClock() });
  host.send(session, 'report', 0);
  await host.idle();
  host.close();
  equal(logs.labelled('n').join('|'), '1 [1] report false', 'woken with its variables');
});

test('a value outside the table refuses the snapshot, and the host goes on', async () => {
  const logs = new Logs();
  const host = hostOf(COUNTER, { log: logs.handler });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'odd');
  await host.idle();
  throws(() => host.snapshot(), (error) => {
    status('TA_ERROR_UNSUPPORTED')(error);
    if (!/'other'/.test(error.message)) throw new Error(`the error does not name the variable: ${error.message}`);
  }, 'a function in a variable');
  host.send(session, 'inc', 1); // the host goes on
  host.send(session, 'report', 0);
  await host.idle();
  host.close();
  equal(logs.labelled('n').join('|'), '1 [1] report false', 'the host went on');
});

test('a snapshot from a handler is refused', async () => {
  const refused = [];
  const log = (host) => {
    try {
      host.snapshot();
    } catch (error) {
      if (!(error instanceof TinyactorsError)) throw error;
      refused.push(error.status);
    }
  };
  const host = hostOf(COUNTER, { log });
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'report', 0);
  await host.idle();
  host.close();
  equal(refused.join(','), 'TA_ERROR_STATE', 'refused from the handler');
});

test('a snapshot with a reply pending is refused', async () => {
  const host = hostOf(COUNTER);
  host.hostStats(undefined, () => {});
  throws(() => host.snapshot(), status('TA_ERROR_STATE'), 'a reply pending');
  await host.idle();
  host.snapshot();
  host.close();
});

test('a snapshot during a migration is refused', async () => {
  const host = hostOf(COUNTER, { migrationDone: () => {} });
  host.spawn(host.chart('counter'));
  await host.idle();
  host.addImage(image({ counter: counter({ more: '<transition event="extra"/>' }) }));
  host.migrate();
  throws(() => host.snapshot(), status('TA_ERROR_STATE'), 'during a migration');
  host.close();
});

test('restore refuses what is no snapshot, and what is not bytes', async () => {
  throws(() => restore(new Uint8Array(64)), status('TA_ERROR_INVALID'), 'zeros');
  throws(() => Host.restore(), typeError, 'no snapshot');
  throws(() => Host.restore('a snapshot', CONFIG), typeError, 'a string');
  const restoreOf = Host.restore;
  throws(() => restoreOf(new Uint8Array(64), CONFIG), typeError, 'restore not called on Host');
});

test('a snapshot restores from an unaligned buffer and from an ArrayBuffer', async () => {
  let host = hostOf(COUNTER);
  host.spawn(host.chart('counter'));
  await host.idle();
  const blob = host.snapshot();
  host.close();
  const shifted = new Uint8Array(blob.length + 1);
  shifted.set(blob, 1);
  host = restore(shifted.subarray(1), { clock: new SimulatedClock() });
  if (!same(host.snapshot(), blob)) throw new Error('the unaligned restore differs');
  host.close();
  const buffer = new ArrayBuffer(blob.length);
  new Uint8Array(buffer).set(blob);
  host = restore(buffer, { clock: new SimulatedClock() });
  if (!same(host.snapshot(), blob)) throw new Error('the ArrayBuffer restore differs');
  host.close();
});

test('one image in two segments keeps each session its own chart', async () => {
  const logs = new Logs();
  const clock = new SimulatedClock();
  const bytes = image({ counter: counter({ more: '<transition event="stop" target="f"/>' }).replace('</scxml>', '<final id="f"/>\n</scxml>') });
  let host = new Host(CONFIG, { ...ENGINE, clock });
  host.addImage(bytes);
  const first = host.spawn(host.chart('counter'));
  host.addImage(bytes); // the same image again: another segment
  const second = host.spawn(host.chart('counter'));
  await host.idle();
  const blob = host.snapshot();
  host.close();
  host = restore(blob, { log: logs.handler, clock });
  host.send(first, 'stop');
  await host.idle();
  await host.idle(); // the first segment retires
  host.send(second, 'inc', 1);
  host.send(second, 'report', 0);
  await host.idle();
  host.snapshot();
  host.close();
  equal(logs.labelled('n').length, 1, 'one report');
  if (!logs.labelled('n')[0].startsWith('1 ')) throw new Error(`the second segment's actor: ${logs.labelled('n')[0]}`);
});

test('the runtime\'s clock resumes at the snapshot\'s time', async () => {
  // a snapshot taken at time 0 of a simulated clock, restored on the
  // runtime's clock: the delayed send is still a second away
  const logs = new Logs();
  let host = hostOf(COUNTER);
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'wait');
  await host.idle();
  const blob = host.snapshot();
  host.close();
  const started = performance.now();
  host = restore(blob, { log: logs.handler });
  await host.idle();
  equal(logs.labelled('late').length, 0, 'not yet');
  const deadline = host.nextDeadline;
  if (!(deadline > 900 && deadline <= 1000)) throw new Error(`the deadline is ${deadline} ms away, not about a second`);
  while (logs.labelled('late').length === 0 && performance.now() - started < 5000) await host.idle();
  host.close();
  equal(logs.labelled('late').join('|'), '{"k":0}', 'the delayed send came');
  const waited = performance.now() - started;
  if (waited < 900) throw new Error(`it came after ${waited} ms, before its second`);
});

test('a value nests as deep in a snapshot as in a send', async () => {
  let deep = 1;
  for (let i = 0; i < 62; i++) deep = [deep];
  const logs = new Logs();
  let host = hostOf(COUNTER);
  const session = host.spawn(host.chart('counter'));
  host.send(session, 'inc', deep);
  await host.idle();
  const blob = host.snapshot();
  host.close();
  host = restore(blob, { log: logs.handler, clock: new SimulatedClock() });
  host.send(session, 'report', 0);
  await host.idle();
  host.close();
  if (!logs.labelled('n')[0]?.startsWith('1 [[[[')) throw new Error(`the deep value: ${logs.labelled('n')[0]}`);
});

test('restore refuses another system\'s config, another datamodel, another program\'s pack', async () => {
  const host = hostOf(COUNTER);
  const blob = host.snapshot();
  host.close();
  throws(() => Host.restore(blob, { systemID: 'other' }, ENGINE), (error) => {
    status('TA_ERROR_INVALID')(error);
    if (!/system t/.test(error.message)) throw new Error(`the message: ${error.message}`);
  }, 'another system');
  const otherModel = DATAMODEL === 'native' ? 'quickjs' : 'native';
  throws(() => Host.restore(blob, CONFIG, { datamodel: otherModel }), status('TA_ERROR_INVALID'), 'another datamodel');
  // the label: a byte of the package's label changed in the pack
  const label = new TextEncoder().encode(LABEL);
  const at = indexOfBytes(blob, label);
  if (at < 0) throw new Error('the pack does not hold its label');
  const relabelled = new Uint8Array(blob);
  relabelled[at + label.length - 1] = 'x'.charCodeAt(0);
  throws(() => restore(relabelled), status('TA_ERROR_INVALID'), "another program's label");
});

test('a declaring chart: its var and function come back after a restore', async () => {
  const logs = new Logs();
  const declaring = scxml('decl', `
  <script>var total = 0; function bump(k) { total += k; return total; }</script>
  <state id="s">
    <transition event="add"><script>bump(_event.data)</script></transition>
    <transition event="report"><log label="total" expr="total + ' ' + bump(0) + ' ' + _event.name"/></transition>
  </state>`);
  let host = new Host(CONFIG, { ...ENGINE, clock: new SimulatedClock() });
  host.addImage(image({ decl: declaring }));
  const session = host.spawn(host.chart('decl'));
  host.send(session, 'add', 2);
  host.send(session, 'add', 3);
  await host.idle();
  const blob = host.snapshot();
  host.close();
  host = restore(blob, { log: logs.handler, clock: new SimulatedClock() });
  host.send(session, 'add', 4);
  host.send(session, 'report');
  await host.idle();
  const again = host.snapshot();
  host.close();
  equal(logs.labelled('total').join('|'), '9 9 report', 'its var and function');
  if (again.length === 0) throw new Error('no snapshot of the restored host');
});

test('a snapshot holds the time of its call, and host.now() reads that clock on both hosts', async () => {
  const chart = scxml('timer', `
    <state id="s"><onentry><send event="ring" delay="300ms"/></onentry>
      <transition event="ring" target="done"/></state>
    <final id="done"/>`);
  const host = new Host(CONFIG, { ...ENGINE });
  host.addImage(image({ timer: chart }));
  host.spawn(host.chart('timer'), { name: 'timer' });
  await host.idle();
  await new Promise((resolve) => setTimeout(resolve, 150)); // idle on the runtime's clock
  const before = host.now();
  const snapshot = host.snapshot();
  const after = host.now();
  if (!(after >= before)) throw new Error(`now() went back: ${before} then ${after}`);
  host.close();
  const clock = new SimulatedClock();
  const restored = Host.restore(snapshot, CONFIG, { ...ENGINE, clock });
  const at = restored.now();
  if (!(at >= before && at <= after)) throw new Error(`the restored clock reads ${at}, the snapshot was taken between ${before} and ${after}`);
  await restored.idle();
  const left = restored.nextDeadline;
  if (!(left > 0 && left < 200)) throw new Error(`the timer has ${left} ms left after the restore; about 150 were left at the snapshot`);
  clock.increment(50);
  equal(restored.now(), at + 50, 'now() moves with the simulated clock');
  clock.increment(left);
  await restored.idle();
  equal(restored.actorByName('timer'), undefined, 'it rang');
  restored.close();
  let closed;
  try { restored.now(); } catch (error) { closed = error.status; }
  equal(closed, 'TA_ERROR_STATE', 'now() on a closed host');
});

await run();
