// The application layer's shapes: compileDir (a directory's charts and
// their src files, compiled once), host.spawn by a chart's name, and
// Address.prototype.toJSON (its text), each over the direct layer's
// exports only.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Actor, Address, CompileError, compileDir, Host, ResolveError } from '@tinyactors/node';
import { CONFIG, ENGINE, equal, image, named, scxml, status, throws, typeError } from './charts.mjs';
import { run, test } from './harness.mjs';

const LOGGER = (name, expr) => scxml(name, `<state id="s"><onentry><log expr="${expr}"/></onentry></state>`);

/** A host running `charts` (a compile result or images) whose log lines go to `lines`. */
function logging(charts, lines, options = {}) {
  return new Host(charts, { ...CONFIG, ...ENGINE, log: (entry) => lines.push(entry.text), ...options });
}

/** A fresh directory under the system's temporary one, removed by `done`. */
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'tinyactors-dir-'));
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

/** Writes `files` (path -> text) under `root`. */
function write(root, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

test('Address.toJSON is a method of Address, as a class\'s are; the removed shapes are gone', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Address.prototype, 'toJSON');
  equal(typeof descriptor?.value, 'function', 'toJSON: a method');
  equal(descriptor.enumerable, false, 'toJSON: not enumerable');
  equal(descriptor.value.name, 'toJSON', 'toJSON: its name');
  for (const name of ['addCharts', 'spawnChart', 'actorByName']) equal(name in Host.prototype, false, `no host.${name}`);
});

test('compileDir compiles every *.scxml under the directory, named by its path and sorted; a src read relative to its document', async () => {
  const { path, done } = directory();
  try {
    write(path, {
      'b.scxml': LOGGER('b', "'b'"),
      'a.scxml': LOGGER('a', "'a'"),
      'rooms/room.scxml': scxml('room', '<state id="s"><invoke src="parts/child.scxml"/><onentry><log expr="\'room\'"/></onentry></state>'),
      'rooms/parts/child.scxml.txt': 'not a chart',
      'rooms/parts/child.scxml': scxml('child', '<state id="s"><onentry><log expr="\'child\'"/></onentry></state>'),
      'notes.txt': 'not a chart either',
    });
    for (const dir of [path, pathToFileURL(path), pathToFileURL(path).href]) {
      const compiled = compileDir(dir);
      const lines = [];
      const host = logging(compiled, lines);
      compiled.close();
      host.boot(0);
      await host.idle();
      equal(lines.join(), 'a', 'the first by path is the boot chart');
      host.spawn('room');
      await host.idle();
      equal(lines.join(), 'a,room,child', 'every chart, and the src it invokes');
      host.chart('b');
      host.close();
    }
    const asked = [];
    compileDir(path, { resolver: (base, source) => (asked.push(`${base} ${source}`), scxml('child', '<state id="s"/>')) }).close();
    equal(asked.join(), 'rooms/room.scxml parts/child.scxml', 'a resolver of its own, asked with the path under the directory');
  } finally {
    done();
  }
});

test('compileDir refuses a src that leaves the directory: .., an absolute path, a symbolic link', () => {
  const { path, done } = directory();
  const outside = directory();
  try {
    const root = join(path, 'root');
    write(path, { 'secret.scxml': scxml('secret', '<state id="s"/>') });
    write(outside.path, { 'far.scxml': scxml('far', '<state id="s"/>') });
    write(root, { 'inner.scxml': scxml('inner', '<state id="s"/>') });
    symlinkSync(join(path, 'secret.scxml'), join(root, 'link.txt'));
    symlinkSync(outside.path, join(root, 'away'));
    const leaves = (src) => {
      write(root, { 'order.scxml': scxml('order', `<state id="s"><invoke src="${src}"/></state>`) });
      const error = compileError(() => compileDir(root), src);
      if (!/leaves the charts' directory|no file/.test(error.message)) throw new Error(`the diagnostic says why: ${error.message}`);
      equal(error.diagnostics.some((d) => d.file === src), true, `the diagnostic names ${src}`);
    };
    leaves('../secret.scxml');
    leaves(join(path, 'secret.scxml'));
    leaves('link.txt');
    leaves('away/far.scxml');
    leaves('missing.scxml');
    write(root, { 'order.scxml': scxml('order', '<state id="s"><invoke src="inner.scxml"/></state>') });
    compileDir(root).close();
  } finally {
    done();
    outside.done();
  }
});

test('compileDir refuses what is not a directory of charts, and src that is not UTF-8', () => {
  const { path, done } = directory();
  try {
    throws(() => compileDir(join(path, 'nowhere')), (error) => {
      if (error?.code !== 'ENOENT') throw new Error(`ENOENT: ${error}`);
    }, 'a directory that does not exist');
    throws(() => compileDir(path), status('TA_ERROR_INVALID'), 'no chart in it');
    write(path, { 'file.txt': 'x' });
    throws(() => compileDir(join(path, 'file.txt')), status('TA_ERROR_INVALID'), 'a file');
    throws(() => compileDir(7), typeError, 'not a path');
    throws(() => compileDir(path, { resolve: () => '' }), typeError, 'an unknown option');
    writeFileSync(join(path, 'latin1.txt'), new Uint8Array([0x3c, 0x73, 0xe9, 0x3e]));
    write(path, { 'order.scxml': scxml('order', '<state id="s"><invoke src="latin1.txt"/></state>') });
    const error = compileError(() => compileDir(path), 'not UTF-8');
    if (!/not UTF-8/.test(error.message)) throw new Error(error.message);
  } finally {
    done();
  }
});

test('spawn takes a chart\'s name (its current version) or a ChartRef, with spawn\'s options, and returns an Actor', async () => {
  const lines = [];
  const host = logging(image({ greeter: scxml('greeter', `<datamodel><data id="who" expr="'world'"/></datamodel>
    <state id="s"><onentry><log expr="'v1 ' + _name + ' ' + who"/></onentry></state>`) }), lines);
  const first = host.spawn('greeter', { name: 'ada', params: { who: 'Ada' } });
  equal(first instanceof Actor, true, 'an Actor');
  equal(typeof first.id, 'bigint', 'its id a session');
  equal(named(host, 'ada'), first.id, 'named as spawn names it');
  const ref = host.chart('greeter');
  host.addImage(image({ greeter: scxml('greeter', `<datamodel><data id="who" expr="'world'"/></datamodel>
    <state id="s"><onentry><log expr="'v2 ' + who"/></onentry></state>`) }));
  host.spawn('greeter');
  host.spawn(ref, { name: 'old' });
  await host.idle();
  equal([...lines].sort().join(), 'v1 ada Ada,v1 old world,v2 world', 'the version current at each call, or the ref\'s');
  throws(() => host.spawn('nope'), status('TA_ERROR_INVALID'), 'a chart the host does not have');
  throws(() => host.spawn('greeter', { colour: 'red' }), typeError, 'spawn\'s refusal of an unknown option');
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
  const bank = new Host(image({ teller: scxml('teller', `<state id="s"><transition event="charge">
    <log expr="'charge ' + _event.data.amount + ' from ' + _event.origin"/></transition></state>`) }),
  { system: 'bank', ...ENGINE, log: (entry) => lines.push(entry.text) });
  bank.spawn('teller', { name: 'teller' });
  let wire;
  const shop = new Host(image({ checkout: scxml('checkout', `<state id="s"><onentry>
    <send event="charge" target="tinyactors://bank/@teller"><param name="amount" expr="12"/></send></onentry></state>`) }),
  { system: 'shop', ...ENGINE, transport: (send) => { wire = JSON.stringify(send.message); } });
  const checkout = shop.spawn('checkout');
  await shop.idle();
  const message = JSON.parse(wire);
  equal(message.target, 'tinyactors://bank/@teller', 'the target as text');
  equal(message.origin, `tinyactors://shop/#_scxml_${checkout.id}`, 'the origin as text');
  bank.send(message);
  await bank.idle();
  equal(lines.join(), `charge 12 from tinyactors://shop/#_scxml_${checkout.id}`, 'host.send took the parsed message');
  shop.close();
  bank.close();
});

await run();
