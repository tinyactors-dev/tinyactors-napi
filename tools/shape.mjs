// The shape of the package this process resolves as `@tinyactors/node`
// (the addon, or @tinyactors/wasm under --conditions=tinyactors-wasm),
// printed as one JSON document for tools/parity.mjs to compare: every
// export (its kind, a function's name and length, a class's prototype
// chain, its prototype's and its static members, each member's kind,
// length and attributes), the objects the API hands out (a compile
// result, a chart reference, a send view and the record a promise-returning
// handler gets, a log entry, an invocation, a migration's result and its
// Migrated view, a diagnostic, an address, a clock, a host, the errors),
// and what a set of misuses throws (the class and core's status).
//
// Usage: node|bun [--conditions=tinyactors-wasm] tools/shape.mjs
import * as tinyactors from '@tinyactors/node';

const { Address, compileCharts, Host, SimulatedClock, TinyactorsError } = tinyactors;

/** A property descriptor's shape: what a caller can see of it. */
function member(descriptor) {
  const out = {};
  if ('value' in descriptor) {
    const { value } = descriptor;
    out.kind = typeof value === 'function' ? 'method' : `value:${value === null ? 'null' : typeof value}`;
    if (typeof value === 'function') out.length = value.length;
    out.writable = descriptor.writable;
  } else {
    out.kind = descriptor.get && descriptor.set ? 'accessor' : descriptor.get ? 'getter' : 'setter';
  }
  out.enumerable = descriptor.enumerable;
  out.configurable = descriptor.configurable;
  return out;
}

// a well-known symbol by its name (node 22 describes Symbol.dispose as
// "nodejs.dispose"), another symbol by its description
const WELL_KNOWN = new Map(Object.getOwnPropertyNames(Symbol).filter((name) => typeof Symbol[name] === 'symbol').map((name) => [Symbol[name], `[Symbol.${name}]`]));
const keyName = (key) => (typeof key === 'symbol' ? WELL_KNOWN.get(key) ?? `[${key.description}]` : key);

/** The own members of `object`, by name, without `skip`. */
function members(object, skip = []) {
  const out = {};
  for (const key of Reflect.ownKeys(object)) {
    if (skip.includes(key)) continue;
    out[keyName(key)] = member(Object.getOwnPropertyDescriptor(object, key));
  }
  return out;
}

/** The names of the constructors of `prototype`'s chain, to Object. */
function chain(prototype) {
  const names = [];
  for (let p = Object.getPrototypeOf(prototype); p !== null; p = Object.getPrototypeOf(p)) names.push(p.constructor?.name ?? '?');
  return names;
}

/** A function's shape, and a class's: its prototype and static members. */
function functionShape(fn) {
  const out = { kind: 'function', name: fn.name, length: fn.length };
  const prototype = Object.getOwnPropertyDescriptor(fn, 'prototype');
  if (prototype !== undefined && prototype.value !== undefined && Reflect.ownKeys(prototype.value).length > 1) {
    out.kind = 'class';
    out.extends = chain(prototype.value);
    out.prototype = members(prototype.value, ['constructor']);
    out.static = members(fn, ['length', 'name', 'prototype']);
  }
  return out;
}

function exportShape(value) {
  if (typeof value === 'function') return functionShape(value);
  return { kind: value === null ? 'null' : typeof value };
}

/** An object the API hands out: its constructor's name, its own members,
 * its prototype's members (when not Object's) and its chain. */
function objectShape(object) {
  const prototype = Object.getPrototypeOf(object);
  const plain = prototype === Object.prototype || prototype === null;
  const out = { constructor: plain ? 'Object' : prototype.constructor?.name, frozen: Object.isFrozen(object), own: members(object) };
  if (!plain) {
    out.prototype = members(prototype, ['constructor']);
    out.extends = chain(prototype);
  }
  return out;
}

/** What `body` throws: its class's name and core's status, or 'returned'. */
function refusal(body) {
  try {
    body();
  } catch (error) {
    return {
      class: error?.constructor?.name ?? typeof error,
      tinyactors: error instanceof TinyactorsError,
      status: error?.status,
      code: error?.code,
    };
  }
  return 'returned';
}

const scxml = (name, body, initial = 's') =>
  `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="${name}" initial="${initial}">${body}</scxml>`;

const CHARTS = [
  { name: 'main.scxml', text: scxml('main', `
    <state id="s">
      <onentry>
        <log label="it" expr="'hello'"/>
        <send event="out" target="#_x" type="http://www.w3.org/TR/scxml/#BasicHTTPEventProcessor" id="first"><param name="n" expr="1"/></send>
        <send event="later" target="#_x" type="http://www.w3.org/TR/scxml/#BasicHTTPEventProcessor"/>
      </onentry>
      <invoke type="thing" id="inv" src="thing://here"><param name="a" expr="1"/></invoke>
      <transition event="reply" target="s2"/>
    </state>
    <state id="s2"/>`) },
  { name: 'plain.scxml', text: scxml('plain', '<state id="s"/>') },
  // a syntax error in an expression is a warning: a compile result with a diagnostic
  { name: 'warn.scxml', text: scxml('warn', '<state id="s"><transition event="e" cond="1 +" target="s"/></state>') },
];

const shapes = { exports: {}, objects: {}, refusals: {} };
for (const [name, value] of Object.entries(tinyactors).sort(([a], [b]) => (a < b ? -1 : 1))) shapes.exports[name] = exportShape(value);

const objects = shapes.objects;
const config = { systemID: 't', telemetry: {}, ioProcessors: [{ type: 'http://www.w3.org/TR/scxml/#BasicHTTPEventProcessor' }] };
const compiled = compileCharts(CHARTS);
objects.Compiled = objectShape(compiled);
objects.Diagnostic = compiled.diagnostics.length > 0 ? objectShape(compiled.diagnostics[0]) : 'none';
const image = compiled.image;
objects.image = { constructor: Object.getPrototypeOf(image).constructor.name, isUint8Array: image instanceof Uint8Array };

const clock = new SimulatedClock();
objects.SimulatedClock = objectShape(clock);
const seen = {};
const host = new Host(config, {
  clock,
  telemetry: () => {},
  ioProcessors: {
    'http://www.w3.org/TR/scxml/#BasicHTTPEventProcessor': (h, send) => {
      if (send.event === 'out') {
        seen.Send = objectShape(send);
        seen.message = objectShape(send.message);
        return undefined;
      }
      return Promise.resolve().then(() => {
        seen.record = objectShape(send);
      });
    },
  },
  log: (h, entry) => {
    seen.LogEntry = objectShape(entry);
  },
  services: {
    thing: (h, invocation) => {
      seen.Invocation = objectShape(invocation);
      return { receive() {}, stop() {} };
    },
  },
  migrated: (h, migrated) => {
    seen.Migrated = objectShape(migrated);
  },
  migrationDone: (h, result) => {
    seen.MigrationResult = objectShape(result);
  },
});
objects.Host = objectShape(host);
const segment = host.addImage(image);
compiled.close();
const ref = host.chart('main');
objects.ChartRef = objectShape(ref);
const session = host.spawn(ref, { name: 'one' });
host.spawn(host.chart('plain')); // an actor with no invocation running, to migrate
objects.session = typeof session;
await host.idle();
objects.snapshot = Object.getPrototypeOf(host.snapshot()).constructor.name;
host.addImage(image);
host.migrate({ chart: 'plain' });
for (let i = 0; i < 100 && seen.MigrationResult === undefined; i++) await host.idle();
Object.assign(objects, seen);
objects.segment = typeof segment;
objects.metrics = Object.getPrototypeOf(host.metrics()).constructor.name;
objects.encode = Object.getPrototypeOf(tinyactors.encode(1)).constructor.name;

const address = Address.fromSession('t', 1n);
objects.Address = objectShape(address);
objects.TinyactorsError = objectShape(new TinyactorsError('x'));
objects.CompileError = objectShape(refusalError(() => compileCharts([{ name: 'bad.scxml', text: '<scxml' }])));
objects.ResolveError = objectShape(new tinyactors.ResolveError('x', { line: 1, column: 2 }));
objects.HTTPRequest = objectShape(tinyactors.parseHTTPRequest(tinyactors.encodeHTTPPost({ url: 'http://h/p', event: 'e', body: 'b' })));

function refusalError(body) {
  try {
    body();
  } catch (error) {
    return error;
  }
  throw new Error('not refused');
}

// misuses, each refused the same way by both packages
const refusals = shapes.refusals;
refusals['new Host without a config'] = refusal(() => new Host());
refusals['new Host with an unknown option'] = refusal(() => new Host({ systemID: 't' }, { nonsense: 1 }));
refusals['new Host with a bad config'] = refusal(() => new Host({ systemID: 't', system: { maxActors: -1 } }));
refusals['new Host with datamodel quickjs'] = refusal(() => new Host({ systemID: 't' }, { datamodel: 'quickjs' }).close());
refusals['new Host with an unknown datamodel'] = refusal(() => new Host({ systemID: 't' }, { datamodel: 'lua' }));
refusals['host.chart of an unknown chart'] = refusal(() => host.chart('nothing'));
refusals['host.spawn of a bad reference'] = refusal(() => host.spawn({ segment: 99, chart: 0 }));
refusals['host.send of an unknown event type'] = refusal(() => host.send(session, 1));
refusals['host.send of a function'] = refusal(() => host.send(session, 'e', () => 1));
refusals['host.send to a session that never was'] = refusal(() => host.send(123456, 'e'));
refusals['host.addImage of garbage'] = refusal(() => host.addImage(new Uint8Array(8)));
refusals['host.hibernate of a session that never was'] = refusal(() => host.hibernate(123456));
refusals['host.wake with garbage'] = refusal(() => host.wake(123456, new Uint8Array(8)));
refusals['Host.restore of garbage'] = refusal(() => Host.restore(new Uint8Array(16), config));
refusals['compileCharts of nothing'] = refusal(() => compileCharts([]));
refusals['compileCharts of a broken chart'] = refusal(() => compileCharts([{ name: 'bad.scxml', text: '<scxml' }]));
refusals['compiled.image after close'] = refusal(() => {
  const c = compileCharts(CHARTS);
  c.close();
  return c.image;
});
refusals['encode of a function'] = refusal(() => tinyactors.encode(() => 1));
refusals['encode of a lone surrogate'] = refusal(() => tinyactors.encode('\ud800'));
refusals['encode of an unsafe integer'] = refusal(() => tinyactors.encode(2 ** 60));
refusals['decode of a truncated document'] = refusal(() => tinyactors.decode(new Uint8Array([0x82, 1])));
refusals['new Address of garbage'] = refusal(() => new Address('nonsense'));
refusals['parseHTTPRequest of garbage'] = refusal(() => tinyactors.parseHTTPRequest(new Uint8Array([1, 2, 3])));
refusals['clock.increment of a negative time'] = refusal(() => clock.increment(-1));
refusals['a method of Host called on another object'] = refusal(() => Host.prototype.spawn.call({}, ref));
// a typed method's error: the class, core's status, its JSON-RPC code and reason
const replied = (method, params) => new Promise((resolve) => {
  host[method](params, () => resolve('answered'), (h, error) => resolve({
    class: error?.constructor?.name, tinyactors: error instanceof TinyactorsError, status: error?.status, code: error?.code, reason: error?.reason,
  }));
});
refusals['actorState of a session that never was'] = await replied('actorState', { session: 123456 });
refusals['actorList with a param it does not take'] = await replied('actorList', { nonsense: 1 });
refusals['traceWatch without its params'] = await replied('traceWatch', {});
host.close();
refusals['host.spawn after close'] = refusal(() => host.spawn(ref));
refusals['host.metrics after close'] = refusal(() => host.metrics());

process.stdout.write(`${JSON.stringify(shapes)}\n`);
