// The native "ecmascript" datamodel through the package's API, runtime-
// neutral, for a page and a Worker (browser.mjs): a chart that declares
// nothing and one that declares, their logs, where the charts ran, and,
// on a page, the host's realm (a hidden iframe) made at its first chart
// and removed at close().
import { Host, compileCharts } from '../index.mjs';

const SHARED = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="shared" initial="a">
  <datamodel><data id="count" expr="0"/><data id="doc"><item n="1">x</item></data></datamodel>
  <state id="a">
    <transition event="inc"><assign location="count" expr="count + 1"/><log label="count" expr="count + ':' + doc.documentElement.getAttribute('n')"/></transition>
    <transition event="where"><log label="realm" expr="typeof window === 'undefined' ? 'no window' : window === window.top ? 'top' : 'iframe'"/></transition>
  </state>
</scxml>`;

const DECLARING = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="declaring" initial="a">
  <datamodel><data id="n" expr="5"/></datamodel>
  <script>const LIMIT = 2; var total = n; function twice() { return total * 2; } let k = 1;</script>
  <state id="a">
    <transition event="go"><script>total = total + 1; k++;</script><log label="t" expr="twice() + ':' + k + ':' + LIMIT"/></transition>
  </state>
</scxml>`;

const frames = () => (typeof document === 'undefined' ? null : document.querySelectorAll('iframe[data-tinyactors]').length);

export async function nativeScenario() {
  const logs = [];
  const before = frames();
  const host = new Host({ systemID: 'web' }, { log: (h, entry) => logs.push(`${entry.label}=${entry.text}`) });
  const compiled = compileCharts([{ name: 'shared', text: SHARED }, { name: 'declaring', text: DECLARING }]);
  host.addImage(compiled.image);
  compiled.close();
  const during = frames();
  const shared = host.spawn(host.chart('shared'));
  const declaring = host.spawn(host.chart('declaring'));
  host.send(shared, 'inc');
  host.send(shared, 'inc');
  host.send(shared, 'where');
  host.send(declaring, 'go');
  host.send(declaring, 'go');
  await host.idle();
  host.close();
  return { logs, frames: [before, during, frames()] };
}

// A host nobody closed, on a page: its iframe goes when the collector
// finds the host (the FinalizationRegistry), since the realm holds the
// host only weakly. `gc` is Chromium's (--expose-gc). Answers the iframes
// before, while the host lived, and after.
export async function droppedHost(gc) {
  const before = frames();
  let during;
  await (async () => {
    const host = new Host({ systemID: 'web' });
    const compiled = compileCharts([{ name: 'shared', text: SHARED }]);
    host.addImage(compiled.image);
    compiled.close();
    host.spawn(host.chart('shared'));
    await host.idle();
    during = frames();
  })();
  for (let i = 0; i < 200 && frames() !== before; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [before, during, frames()];
}

// What a page under a policy gets: the native datamodel's refusal at the
// host's creation, a compile call that skips its syntax check, and a
// quickjs host that runs, its chart's text evaluated by quickjs.
export async function underPolicy() {
  const out = {};
  try {
    new Host({ systemID: 'web' }); // eslint-disable-line no-new
    out.host = 'made';
  } catch (error) {
    out.host = [error.status, error.message];
  }
  const compiled = compileCharts([{ name: 'typo', text: SHARED.replace('count + 1', 'count + )') }]);
  out.syntaxChecked = compiled.diagnostics.some((d) => /SyntaxError/.test(d.message));
  compiled.close();
  // quickjs evaluates no chart text with the page's engine: it runs here
  const lines = [];
  try {
    const host = new Host({ systemID: 'web' }, { datamodel: 'quickjs', log: (h, entry) => lines.push(entry.text) });
    const sandboxed = compileCharts([{ name: 'q', text: '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="q" initial="s"><datamodel><data id="n" expr="[1, 2, 3].map((x) => x * 2)"/></datamodel><state id="s"><onentry><log expr="JSON.stringify(n)"/></onentry></state></scxml>' }]);
    host.addImage(sandboxed.image);
    sandboxed.close();
    host.spawn(host.chart('q'));
    await host.idle();
    host.close();
    out.quickjs = lines;
  } catch (error) {
    out.quickjs = [String(error?.stack ?? error)];
  }
  return out;
}

// A snapshot of @tinyactors/node (made by the test's process with the
// addon) restored here: refused by its label, naming the package; and a
// snapshot of this package's own, for the test to restore with the addon.
export async function crossing(addonSnapshot) {
  let refused = null;
  try {
    Host.restore(new Uint8Array(addonSnapshot), { systemID: 't' }).close();
  } catch (error) {
    refused = [error.status, error.message];
  }
  const host = new Host({ systemID: 't' });
  const compiled = compileCharts([{ name: 'c.scxml', text: '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="c" initial="s"><state id="s"/></scxml>' }]);
  host.addImage(compiled.image);
  compiled.close();
  host.spawn(host.chart('c'));
  await host.idle();
  const own = Array.from(host.snapshot());
  host.close();
  return { refused, own };
}
