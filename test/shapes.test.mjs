// The convenience layer's shapes (docs/plan.xml, p3-shapes): host.addCharts
// (compileCharts, addImage, close in one call), host.spawnChart (chart,
// then spawn), directoryResolver (a resolver reading files under a root)
// and Address.prototype.toJSON (its text), each over the direct layer's
// exports only.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address, CompileError, compileCharts, compileSystem, directoryResolver, Host, ResolveError } from '@tinyactors/node';
import { CONFIG, ENGINE, equal, scxml, status, throws, typeError, WAITER } from './charts.mjs';
import { run, test } from './harness.mjs';

const LOGGER = (name, expr) => scxml(name, `<state id="s"><onentry><log expr="${expr}"/></onentry></state>`);

/** A host whose log lines go to `lines`. */
function logging(lines, options = {}) {
  return new Host(CONFIG, { ...ENGINE, log: (host, entry) => lines.push(entry.text), ...options });
}

/** A fresh directory under the system's temporary one, removed by `done`. */
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'tinyactors-resolver-'));
  return { path, done: () => rmSync(path, { recursive: true, force: true }) };
}

/** The CompileError `body` throws. */
function compileError(body, what) {
  try {
    body();
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return error;
  }
  throw new Error(`${what}: compiled`);
}

test('the shapes are methods of Host and Address, as a class\'s are', () => {
  for (const [target, name] of [[Host.prototype, 'addCharts'], [Host.prototype, 'spawnChart'], [Address.prototype, 'toJSON']]) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    equal(typeof descriptor?.value, 'function', `${name}: a method`);
    equal(descriptor.enumerable, false, `${name}: not enumerable`);
    equal(descriptor.value.name, name, `${name}: its name`);
  }
  equal(typeof directoryResolver, 'function', 'directoryResolver: a function');
});

test('addCharts compiles, adds and closes in one call; the first key is the boot chart', async () => {
  const lines = [];
  const host = logging(lines);
  const segment = host.addCharts({ 'first.scxml': LOGGER('first', "'first'"), 'second.scxml': LOGGER('second', "'second'") });
  equal(segment, 0, 'the segment addImage returns');
  equal(host.addCharts({ 'third.scxml': LOGGER('third', "'third'") }), 1, 'a second image, a second segment');
  host.boot(segment);
  await host.idle();
  equal(lines.join(), 'first', 'boot spawns the first key\'s chart');
  host.spawn(host.chart('second'));
  host.spawn(host.chart('third'));
  await host.idle();
  equal([...lines].sort().join(), 'first,second,third', 'every chart is in the host');
  host.close();
});

test('addCharts: a CompileError with every diagnostic, and nothing added', () => {
  const host = new Host(CONFIG, ENGINE);
  const broken = { 'a.scxml': scxml('a', '<state id="s"><transition target="nowhere"/></state>'), 'b.scxml': '<scxml' };
  const error = compileError(() => host.addCharts(broken), 'addCharts of broken charts');
  const direct = compileError(() => compileCharts(Object.entries(broken).map(([name, text]) => ({ name, text }))), 'compileCharts');
  equal(error.message, direct.message, 'compileCharts\'s message');
  equal(JSON.stringify(error.diagnostics), JSON.stringify(direct.diagnostics), 'compileCharts\'s diagnostics');
  if (error.diagnostics.filter((d) => d.severity === 'error').length < 2) throw new Error('every error, not the first only');
  throws(() => host.chart('a'), status('TA_ERROR_INVALID'), 'no chart added');
  host.close();
});

test('addCharts: the resolver option, and what it refuses', () => {
  const host = new Host(CONFIG, ENGINE);
  const child = scxml('child', '<state id="s"/>');
  const asked = [];
  host.addCharts({ 'parent.scxml': scxml('parent', '<state id="s"><invoke src="child.scxml"/></state>') },
    { resolver: (base, source) => (asked.push(`${base} ${source}`), child) });
  equal(asked.join(), 'parent.scxml child.scxml', 'the resolver was asked');
  equal(host.chart('child').segment, 0, 'and its chart compiled into the image');
  throws(() => host.addCharts(null), typeError, 'null');
  throws(() => host.addCharts([{ name: 'a', text: WAITER }]), typeError, 'an array (compileCharts\'s shape)');
  throws(() => host.addCharts('x'), typeError, 'a string');
  throws(() => host.addCharts({ 'w.scxml': WAITER }, { resolve: () => '' }), typeError, 'an unknown option');
  throws(() => host.addCharts({ 'w.scxml': WAITER }, 'resolver'), typeError, 'options that are not an object');
  throws(() => host.addCharts({}), (error) => {
    if (!(error instanceof CompileError) && !(error instanceof TypeError) && error?.status !== 'TA_ERROR_INVALID')
      throw new Error(`no charts: compileCharts's refusal, not ${error}`);
  }, 'no charts');
  host.close();
  throws(() => host.addCharts({ 'w.scxml': WAITER }), status('TA_ERROR_STATE'), 'a closed host refuses the image');
});

test('spawnChart spawns the chart\'s current version, with spawn\'s options', async () => {
  const lines = [];
  const host = logging(lines);
  host.addCharts({ 'greeter.scxml': scxml('greeter', `<datamodel><data id="who" expr="'world'"/></datamodel>
    <state id="s"><onentry><log expr="'v1 ' + _name + ' ' + who"/></onentry></state>`) });
  const first = host.spawnChart('greeter', { name: 'ada', params: { who: 'Ada' } });
  equal(typeof first, 'bigint', 'a session');
  equal(host.actorByName('ada'), first, 'named as spawn names it');
  host.addCharts({ 'greeter.scxml': scxml('greeter', `<datamodel><data id="who" expr="'world'"/></datamodel>
    <state id="s"><onentry><log expr="'v2 ' + who"/></onentry></state>`) });
  host.spawnChart('greeter');
  await host.idle();
  equal(lines.join(), 'v1 ada Ada,v2 world', 'the version current at each call');
  throws(() => host.spawnChart('nope'), status('TA_ERROR_INVALID'), 'a chart the host does not have');
  throws(() => host.spawnChart('greeter', { colour: 'red' }), typeError, 'spawn\'s refusal of an unknown option');
  host.close();
});

test('Address.toJSON: JSON.stringify writes its text, which new Address reads back', () => {
  const address = Address.fromName('shop', 'front desk');
  equal(address.toJSON(), 'tinyactors://shop/@front%20desk', 'its text');
  const json = JSON.stringify({ target: address, list: [Address.fromSession('shop', 7n)] });
  equal(json, '{"target":"tinyactors://shop/@front%20desk","list":["tinyactors://shop/#_scxml_7"]}', 'in a value');
  equal(new Address(JSON.parse(json).target).name, 'front desk', 'read back');
});

test('Address.toJSON: a transport\'s send.message goes through JSON and back to host.send', async () => {
  const lines = [];
  const bank = new Host({ systemID: 'bank' }, { ...ENGINE, log: (host, entry) => lines.push(entry.text) });
  bank.addCharts({ 'teller.scxml': scxml('teller', `<state id="s"><transition event="charge">
    <log expr="'charge ' + _event.data.amount + ' from ' + _event.origin"/></transition></state>`) });
  bank.spawnChart('teller', { name: 'teller' });
  let wire;
  const shop = new Host({ systemID: 'shop' }, { ...ENGINE, transport: (host, send) => { wire = JSON.stringify(send.message); } });
  shop.addCharts({ 'checkout.scxml': scxml('checkout', `<state id="s"><onentry>
    <send event="charge" target="tinyactors://bank/@teller"><param name="amount" expr="12"/></send></onentry></state>`) });
  const checkout = shop.spawnChart('checkout');
  await shop.idle();
  const message = JSON.parse(wire);
  equal(message.target, 'tinyactors://bank/@teller', 'the target as text');
  equal(message.origin, `tinyactors://shop/#_scxml_${checkout}`, 'the origin as text');
  bank.send(message);
  await bank.idle();
  equal(lines.join(), `charge 12 from tinyactors://shop/#_scxml_${checkout}`, 'host.send took the parsed message');
  shop.close();
  bank.close();
});

test('directoryResolver reads source relative to base under its root', () => {
  const { path, done } = directory();
  try {
    mkdirSync(join(path, 'charts', 'parts'), { recursive: true });
    writeFileSync(join(path, 'charts', 'child.scxml'), scxml('child', '<state id="s"/>'));
    writeFileSync(join(path, 'charts', 'parts', 'grandchild.scxml'), scxml('grandchild', '<state id="s"/>'));
    writeFileSync(join(path, 'top.scxml'), scxml('top', '<state id="s"/>'));
    const resolver = directoryResolver(path);
    equal(resolver('charts/order.scxml', 'child.scxml'), scxml('child', '<state id="s"/>'), 'base\'s directory');
    equal(resolver('charts/order.scxml', 'parts/grandchild.scxml'), scxml('grandchild', '<state id="s"/>'), 'below it');
    equal(resolver('charts/order.scxml', '../top.scxml'), scxml('top', '<state id="s"/>'), 'up, still under the root');
    equal(resolver('order.scxml', 'charts/child.scxml'), scxml('child', '<state id="s"/>'), 'a base at the root');
    const compiled = compileCharts([{ name: 'charts/order.scxml',
      text: scxml('order', '<state id="s"><invoke src="child.scxml"/><invoke src="parts/grandchild.scxml"/></state>') }], resolver);
    compiled.close();
    const host = new Host(CONFIG, ENGINE);
    host.addCharts({ 'charts/order.scxml': scxml('order', '<state id="s"><invoke src="child.scxml"/></state>') }, { resolver });
    equal(host.chart('child').segment, 0, 'addCharts with it');
    host.close();
    writeFileSync(join(path, 'system.xml'), '<system><chart name="top" src="top.scxml"/><actor name="t" chart="top"/></system>');
    compileSystem({ name: 'system.xml', text: '<system><chart name="top" src="top.scxml"/><actor name="t" chart="top"/></system>' }, resolver).close();
  } finally {
    done();
  }
});

test('directoryResolver refuses what leaves its root: .., an absolute path, a symbolic link', () => {
  const { path, done } = directory();
  const outside = directory();
  try {
    mkdirSync(join(path, 'root'));
    const root = join(path, 'root');
    writeFileSync(join(path, 'secret.scxml'), scxml('secret', '<state id="s"/>'));
    writeFileSync(join(outside.path, 'far.scxml'), scxml('far', '<state id="s"/>'));
    symlinkSync(join(path, 'secret.scxml'), join(root, 'link.scxml'));
    symlinkSync(outside.path, join(root, 'away'));
    writeFileSync(join(root, 'inner.scxml'), scxml('inner', '<state id="s"/>'));
    symlinkSync(join(root, 'inner.scxml'), join(root, 'alias.scxml'));
    const resolver = directoryResolver(root);
    const refused = (error) => {
      if (!(error instanceof ResolveError)) throw new Error(`a ResolveError: ${error}`);
    };
    throws(() => resolver('order.scxml', '../secret.scxml'), refused, '..');
    throws(() => resolver('a/b/order.scxml', '../../../secret.scxml'), refused, '.. from a nested base');
    throws(() => resolver('order.scxml', join(path, 'secret.scxml')), refused, 'an absolute path');
    throws(() => resolver('../order.scxml', 'secret.scxml'), refused, 'a base that leaves the root');
    throws(() => resolver('order.scxml', 'link.scxml'), refused, 'a link to a file outside');
    throws(() => resolver('order.scxml', 'away/far.scxml'), refused, 'a link to a directory outside');
    throws(() => resolver('order.scxml', '.'), refused, 'the root itself');
    throws(() => resolver('order.scxml', 'missing.scxml'), refused, 'a file that does not exist');
    equal(resolver('order.scxml', 'alias.scxml'), scxml('inner', '<state id="s"/>'), 'a link that stays inside is read');
    const error = compileError(() => compileCharts([{ name: 'order.scxml', text: scxml('order', '<state id="s"><invoke src="../secret.scxml"/></state>') }], resolver), 'a src that leaves');
    if (!/leaves the resolver's root/.test(error.message)) throw new Error(`the diagnostic says why: ${error.message}`);
    equal(error.diagnostics[0].file, '../secret.scxml', 'the diagnostic names the src');
  } finally {
    done();
    outside.done();
  }
});

test('directoryResolver: text is UTF-8 or refused; other errors of the file system pass; the root must exist', () => {
  const { path, done } = directory();
  try {
    writeFileSync(join(path, 'latin1.scxml'), new Uint8Array([0x3c, 0x73, 0xe9, 0x3e]));
    mkdirSync(join(path, 'folder.scxml'));
    const resolver = directoryResolver(path);
    throws(() => resolver('order.scxml', 'latin1.scxml'), (error) => {
      if (!(error instanceof ResolveError) || !/not UTF-8/.test(error.message)) throw new Error(`not UTF-8: ${error}`);
    }, 'bytes that are not UTF-8');
    throws(() => resolver('order.scxml', 'folder.scxml'), (error) => {
      if (error instanceof ResolveError || error?.code !== 'EISDIR') throw new Error(`EISDIR as it is: ${error}`);
    }, 'a directory');
    throws(() => directoryResolver(join(path, 'nowhere')), (error) => {
      if (error?.code !== 'ENOENT') throw new Error(`ENOENT: ${error}`);
    }, 'a root that does not exist');
  } finally {
    done();
  }
});

await run();
