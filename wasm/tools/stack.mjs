// The deepest the shadow stack goes (mise run wasm:stack): the probe
// build's stack painted, then the compiler given charts at its limits (200
// levels of states, 64 of <if>, a long document) and a host running one,
// the high-water mark read after each.
import { readFileSync } from 'node:fs';
import { load } from '../lib/module.mjs';
import * as scenario from '../test/scenario.mjs';

const module = await load(new WebAssembly.Module(readFileSync(process.argv[2])));
const measure = (what, fn) => {
  module.call('ta_web_stack_paint');
  fn();
  const used = module.call('ta_web_stack_used');
  console.log(`wasm:stack: ${what}: ${used} B of ${module.call('ta_web_stack_size')}`);
  return used;
};
const head = '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="deep" initial="s0">';
let states = '';
for (let i = 0; i < 199; i++) states += `<state id="s${i}">`;
states += '<onentry>' + '<if cond="true">'.repeat(64) + '<log expr="1"/>' + '</if>'.repeat(64) + '</onentry>';
for (let i = 0; i < 199; i++) states += '</state>';
const deep = `${head}${states}</scxml>`;
const wide = `${head}${Array.from({ length: 2000 }, (_, i) => `<state id="s${i}"><transition event="e${i}" target="s${(i + 1) % 2000}"/></state>`).join('')}</scxml>`;
const peaks = [
  measure('the compiler, 199 nested states and 64 nested <if>', () => {
    const { image, diagnostics } = scenario.compile(module, [['deep.scxml', deep]]);
    if (image === null) throw new Error(`the deep chart did not compile: ${JSON.stringify(diagnostics.slice(0, 2))}`);
  }),
  measure('the compiler, 2000 states', () => scenario.compile(module, [['wide.scxml', wide]])),
  measure('a host running a null-datamodel chart', () => scenario.nullChart(module)),
  measure('a host on the forwarded datamodel', () => scenario.forwarding(module)),
  measure('an XML parse at txml\'s depth limit (256) and its tree record', () => {
    const host = new scenario.RawHost(module, { config: { systemID: 'web' } });
    module.scoped(host.scratch, () => {
      const [at, length] = module.text(host.scratch, '<a>'.repeat(256) + '</a>'.repeat(256));
      module.setWord(0, at);
      module.setWord(1, length);
      module.call('ta_web_xml_parse', host.pointer);
      if ((module.word(0) | 0) !== 0) throw new Error(`the deep document was refused: ${module.word(0) | 0}`);
      module.call('ta_web_xml_end', host.pointer);
    });
    host.free();
  }),
];
console.log(`wasm:stack: deepest ${Math.max(...peaks)} B`);
