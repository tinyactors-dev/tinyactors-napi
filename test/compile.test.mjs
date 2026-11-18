// The compiler (docs/plan.xml, p1-compile; decision d-image): compileCharts
// and compileSystem, the compile result and its image (a Uint8Array copied on
// first read, which outlives close(); a first read after close() throws
// TA_ERROR_STALE), CompileError with every diagnostic, the resolver and
// ResolveError, and the finalizer that frees a result never closed.
import { compileCharts, compileSystem, CompileError, Host, ResolveError, TinyactorsError } from '@tinyactors/node';
import { CONFIG, ENGINE, equal, sameBytes, scxml, status, throws, typeError, until } from './charts.mjs';
import { collect, run, test } from './harness.mjs';

const GOOD = scxml('c', '<state id="s"/>');
const BAD = scxml('c', '<state id="s">\n  <transition target="nowhere"/>\n</state>');
const PARENT = scxml('parent', '<state id="s">\n  <invoke src="child.scxml"/>\n</state>');
const CHILD = scxml('child', '<state id="s"/>');
const WORKER = scxml('worker', '<state id="ready"><transition event="stop" target="done"/></state><final id="done"/>', {
  initial: 'ready',
});
const SYSTEM = `<system>
  <chart name="worker" src="worker.scxml"/>
  <actor name="first" chart="worker"/>
  <actor name="second" chart="worker"/>
</system>`;

/** A resolver over `files` that records what it was asked and refuses an
 * unknown file at line 3, column 7. */
function resolver(files) {
  const asked = [];
  const resolve = (base, source) => {
    asked.push([base, source]);
    if (!(source in files)) throw new ResolveError(`no file ${source}`, { line: 3, column: 7 });
    return files[source];
  };
  resolve.asked = asked;
  return resolve;
}

const firstError = (error) => error.diagnostics.find((diagnostic) => diagnostic.severity === 'error');

test('an error throws CompileError with every diagnostic', () => {
  throws(() => compileCharts([{ name: 'bad.scxml', text: BAD }]), (error) => {
    if (!(error instanceof CompileError) || !(error instanceof TinyactorsError)) throw error;
    equal(error.name, 'CompileError', 'name');
    equal(error.status, 'TA_ERROR_INVALID', 'status');
    if (!Object.isFrozen(error.diagnostics) || error.diagnostics.length < 1) throw new Error('no frozen diagnostics');
    const diagnostic = firstError(error);
    equal(diagnostic.file, 'bad.scxml', 'file');
    equal(diagnostic.line, 3, 'line');
    for (const key of ['code', 'column']) equal(typeof diagnostic[key], 'number', key);
    if (!diagnostic.message.includes('nowhere')) throw new Error(`message: ${diagnostic.message}`);
    equal(error.message, `bad.scxml:3:${diagnostic.column}: error: ${diagnostic.message}`, 'the message, as a compiler prints it (and as Python reads)');
  }, 'a chart with an unknown target');
});

test('the image is a Uint8Array copied on first read, the same after, and it outlives close()', () => {
  const compiled = compileCharts([{ name: 'c.scxml', text: GOOD }]);
  equal(Array.isArray(compiled.diagnostics) && compiled.diagnostics.length, 0, 'no diagnostics');
  const image = compiled.image;
  if (!(image instanceof Uint8Array) || image.length === 0) throw new Error('not a Uint8Array of the image');
  equal(compiled.image, image, 'cached');
  const copy = image.slice();
  compiled.close();
  compiled.close(); // again: nothing
  equal(compiled.image, image, 'the copy read before close()');
  if (!sameBytes(image, copy)) throw new Error('the image changed at close()');
  const host = new Host(CONFIG, ENGINE);
  equal(host.addImage(image), 0, 'the copy makes a segment after close()');
  host.close();
});

test('a first read of the image after close() throws TA_ERROR_STALE', () => {
  const compiled = compileCharts([{ name: 'c.scxml', text: GOOD }]);
  compiled.close();
  throws(() => compiled.image, status('TA_ERROR_STALE'), 'image after close');
  const disposed = compileCharts([{ name: 'c.scxml', text: GOOD }]);
  disposed[Symbol.dispose]();
  throws(() => disposed.image, status('TA_ERROR_STALE'), 'image after Symbol.dispose');
});

test('a compile result is made by the compile calls only', () => {
  const compiled = compileCharts([{ name: 'c.scxml', text: GOOD }]);
  const Compiled = compiled.constructor;
  throws(() => new Compiled(), typeError, 'new Compiled()');
  throws(() => Object.getOwnPropertyDescriptor(Compiled.prototype, 'image').get.call({}), typeError, 'image of another object');
  throws(() => Compiled.prototype.close.call({}), typeError, 'close on another object');
  compiled.close();
});

test('a resolver reads src, and a ResolveError is a diagnostic at its line and column', () => {
  const resolve = resolver({ 'child.scxml': CHILD });
  const compiled = compileCharts([{ name: 'parent.scxml', text: PARENT }], resolve);
  if (!(compiled.image.length > 0)) throw new Error('no image');
  compiled.close();
  equal(JSON.stringify(resolve.asked), JSON.stringify([['parent.scxml', 'child.scxml']]), 'asked');
  throws(() => compileCharts([{ name: 'parent.scxml', text: PARENT }], resolver({})), (error) => {
    if (!(error instanceof CompileError)) throw error;
    const diagnostic = firstError(error);
    equal(diagnostic.line, 3, 'line');
    equal(diagnostic.column, 7, 'column');
    if (!diagnostic.message.includes('no file child.scxml')) throw new Error(`message: ${diagnostic.message}`);
  }, 'an unknown file');
  const refusal = new ResolveError('no', { line: 2 });
  if (!(refusal instanceof TinyactorsError)) throw new Error('ResolveError is not a TinyactorsError');
  equal(refusal.line, 2, 'line');
  equal(refusal.column, undefined, 'column');
  equal(refusal.name, 'ResolveError', 'name');
});

test('any callable resolves: an arrow, a bound method', () => {
  const files = { 'child.scxml': CHILD };
  const reader = { files, read(base, source) { return this.files[source]; } };
  for (const resolve of [(base, source) => files[source], reader.read.bind(reader)]) {
    compileCharts([{ name: 'parent.scxml', text: PARENT }], resolve).close();
  }
});

test('another error of a resolver is thrown from the compile call, whatever value it is', () => {
  const disk = new Error('disk');
  throws(() => compileCharts([{ name: 'parent.scxml', text: PARENT }], () => {
    throw disk;
  }), (error) => {
    if (error !== disk) throw error;
  }, 'a resolver that throws');
  for (const thrown of ['a string', 7, undefined, null]) { // any value, not only an object
    let caught = 'nothing';
    try {
      compileCharts([{ name: 'parent.scxml', text: PARENT }], () => { throw thrown; });
    } catch (error) {
      caught = error;
    }
    if (caught !== thrown) throw new Error(`a resolver that throws ${String(thrown)}: ${String(caught)} thrown`);
  }
  throws(() => compileCharts([{ name: 'parent.scxml', text: PARENT }], () => 42), typeError, 'a resolver returning a number');
  throws(() => compileCharts([{ name: 'parent.scxml', text: PARENT }], () => '\uD800'), status('TA_ERROR_INVALID'),
    'a resolver returning a lone surrogate');
});

test('a resolver is a function; without one, src is refused', () => {
  throws(() => compileCharts([{ name: 'parent.scxml', text: PARENT }], { 'child.scxml': CHILD }), typeError, 'an object');
  throws(() => compileCharts([{ name: 'parent.scxml', text: PARENT }]), (error) => {
    if (!(error instanceof CompileError)) throw error;
  }, 'no resolver');
  compileCharts([{ name: 'c.scxml', text: GOOD }], null).close();
});

test('sources are an array of {name, text} of strings', () => {
  for (const sources of [undefined, 'text', { name: 'c', text: GOOD }, [{ name: 'c' }], [{ text: GOOD }], [{ name: 1, text: GOOD }], [null]]) {
    throws(() => compileCharts(sources), typeError, `sources ${JSON.stringify(sources)}`);
  }
  throws(() => compileCharts([{ name: 'c.scxml', text: `${GOOD}\uDC00` }]), status('TA_ERROR_INVALID'), 'a lone surrogate');
  throws(() => compileCharts([]), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'no source');
});

test('a manifest compiles into an image whose actors boot by name', async () => {
  const resolve = resolver({ 'worker.scxml': WORKER });
  const compiled = compileSystem({ name: 'system.xml', text: SYSTEM }, resolve);
  const host = new Host(CONFIG, ENGINE);
  const segment = host.addImage(compiled.image);
  compiled.close();
  equal(host.actorByName('first'), undefined, 'before boot');
  host.boot(segment);
  const first = host.actorByName('first');
  const second = host.actorByName('second');
  if (typeof first !== 'bigint' || typeof second !== 'bigint' || first === second) throw new Error(`${first} ${second}`);
  host.terminate(first);
  host.send(second, 'stop');
  if (!(await until(() => host.actorByName('first') === undefined && host.actorByName('second') === undefined)))
    throw new Error('the boot actors did not end');
  equal(JSON.stringify(resolve.asked), JSON.stringify([['system.xml', 'worker.scxml']]), 'asked');
  throws(() => host.boot('0'), typeError, 'a segment that is not a number');
  throws(() => host.boot(7), status('TA_ERROR_INVALID'), 'a segment the host does not have');
  host.close();
});

test('a manifest with an error throws CompileError; a manifest is one {name, text}', () => {
  throws(() => compileSystem({ name: 'system.xml', text: '<charts/>' }), (error) => {
    if (!(error instanceof CompileError)) throw error;
    if (!error.diagnostics[0].message.includes('<system>')) throw new Error(error.diagnostics[0].message);
  }, 'not a system');
  throws(() => compileSystem([{ name: 'system.xml', text: '<system/>' }]), typeError, 'an array');
});

test('a compile result never closed is freed by its finalizer', async () => {
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  (() => {
    for (let i = 0; i < 20; i++) registry.register(compileCharts([{ name: 'c.scxml', text: GOOD }]), i);
  })();
  await collect();
  equal(collected, 20, 'results collected');
});

test('compileCharts parses each expression and script: a syntax error is a warning at its line, an error with warningsAsErrors', () => {
  const text = [
    '<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="typo" initial="s">',
    '  <datamodel><data id="limit" expr="3"/></datamodel>',
    '  <state id="s">',
    '    <transition event="reading" cond="_event.data.value &gt; limit)" target="s"/>',
    '    <transition event="other"><script>',
    '      var ok = 1;',
    '      let x = ;',
    '    </script></transition>',
    '    <transition event="fine" cond="_event.data.value > limit;"><assign location="limit" expr="limit + 1"/></transition>',
    '  </state>',
    '</scxml>'].join('\n');
  const compiled = compileCharts([{ name: 'typo.scxml', text }]);
  const found = compiled.diagnostics.filter((d) => /SyntaxError/.test(d.message));
  compiled.close();
  equal(found.length, 2, 'two of them');
  const [cond, script] = found;
  equal([cond.severity, cond.file, cond.line].join(), 'warning,typo.scxml,4', 'the condition');
  if (!/^cond: SyntaxError: /.test(cond.message)) throw new Error(cond.message);
  equal([script.severity, script.line].join(), 'warning,7', 'the script, at its own line');
  if (!/^<script>: SyntaxError: /.test(script.message)) throw new Error(script.message);
  let error;
  try { compileCharts([{ name: 'typo.scxml', text }], undefined, { warningsAsErrors: true }); } catch (caught) { error = caught; }
  equal(error instanceof CompileError, true, 'a CompileError');
  equal(error.diagnostics.filter((d) => d.severity === 'error' && /SyntaxError/.test(d.message)).length, 2, 'both, as errors');
  if (!/^typo\.scxml:4:\d+: error: cond: SyntaxError: /.test(error.message)) throw new Error(error.message);
  let refused;
  try { compileCharts([{ name: 'typo.scxml', text }], undefined, 'strict'); } catch (caught) { refused = caught; }
  equal(refused instanceof TypeError, true, 'options are an object');
});

await run();
