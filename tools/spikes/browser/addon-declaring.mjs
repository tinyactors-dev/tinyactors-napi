// What the addon does with a declaring chart: an undeclared assignment in a
// sloppy script (does it throw, or land on the session's global, kept by
// hibernation?), a const at hibernation, a chart-level script that throws
// (do the later chart-level scripts run?), and forward references between
// chart-level scripts. Run from tinyactors-napi: node tools/spikes/browser/addon-declaring.mjs
import { hostWith, scxml } from '../../../test/charts.mjs';
const out = {};
const logs = [];
const log = (host, entry) => logs.push(`${entry.label}: ${entry.text}`);
const blobs = new Map();
const wake = (host, session) => host.wake(session, blobs.get(session));
async function run(chart, events, after) {
  logs.length = 0;
  const host = hostWith({ c: chart }, { log, wake });
  const s = host.spawn(host.chart('c'));
  for (const e of events) { if (e === 'HIBERNATE') { await host.idle(); try { blobs.set(s, host.hibernate(s)); logs.push('hibernated'); } catch (err) { logs.push('hibernate refused: ' + err.message); } } else host.send(s, e); }
  await host.idle(); host.close(); return [...logs];
}
const err = '<transition event="error.execution"><log label="error" expr="_event.data &amp;&amp; _event.data.message"/></transition>';
out.undeclared = await run(scxml('c', `<script>var n = 0;</script><state id="s">
  <transition event="go"><script>undeclaredX = 5;</script><log label="x" expr="typeof undeclaredX + ' ' + (typeof globalThis.undeclaredX)"/></transition>
  ${err}</state>`), ['go', 'HIBERNATE', 'go']);
out.constHibernate = await run(scxml('c', `<script>const LIMIT = 2;</script><state id="s"><transition event="go"><log label="l" expr="LIMIT"/></transition>${err}</state>`), ['go', 'HIBERNATE']);
out.throwingScript = await run(scxml('c', `<script>var a = 1; throw new Error('first');</script><script>var b = 2;</script><state id="s"><transition event="go"><log label="ab" expr="typeof a + ' ' + a + ' ' + typeof b + ' ' + b"/></transition>${err}</state>`), ['go']);
out.forwardRef = await run(scxml('c', `<script>function f() { return LIMIT * 2; }</script><script>const LIMIT = 3;</script><state id="s"><transition event="go"><log label="f" expr="f()"/></transition>${err}</state>`), ['go']);
out.execVar = await run(scxml('c', `<script>var n = 0;</script><state id="s"><transition event="go"><script>var seen = (typeof seen === 'number' ? seen : 0) + 1;</script><log label="seen" expr="seen"/></transition>${err}</state>`), ['go', 'go', 'HIBERNATE', 'go']);
console.log(JSON.stringify(out, null, 1));
