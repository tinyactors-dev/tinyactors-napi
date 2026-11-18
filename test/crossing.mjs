// The other package's side of test/crossing.test.mjs, run as a process of
// the same runtime: `crossing.mjs <file>` writes there a snapshot of a
// host of the package this process resolves (the addon, or the wasm
// package under --conditions=tinyactors-wasm), one actor of COUNTER on it
// after two events.
import { writeFileSync } from 'node:fs';
import { compileCharts, Host } from '@tinyactors/node';

const COUNTER = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="s">
  <datamodel><data id="count" expr="0"/></datamodel>
  <state id="s">
    <transition event="inc"><assign location="count" expr="count + 1"/></transition>
    <transition event="report"><log expr="'count=' + count"/></transition>
  </state>
</scxml>`;

if (process.argv[2] !== undefined) {
  const compiled = compileCharts([{ name: 'counter.scxml', text: COUNTER }]);
  const host = new Host({ systemID: 't' });
  host.addImage(compiled.image);
  compiled.close();
  const session = host.spawn(host.chart('counter'), { name: 'c' });
  host.send(session, 'inc');
  host.send(session, 'inc');
  await host.idle();
  writeFileSync(process.argv[2], host.snapshot());
  host.close();
}
