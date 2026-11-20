// The application layer of @tinyactors/node and @tinyactors/wasm, in
// JavaScript over the direct layer's exports only (AGENTS.md, "Layers and
// the resolver"): the API applications use. It imports nothing but
// `#direct`, the package's direct exports (the lint rule
// convenience-imports-the-direct-layer): package.json's `imports` maps it
// to the addon's lib/direct.mjs, and under the export condition
// `tinyactors-wasm` to the wasm package's wasm/lib/direct.mjs
// (docs/browser.md, "One API"), so the two packages share this file and
// present one API. The package's entries export what this module exports,
// and nothing else.
//
// The direct layer mirrors core: its Host takes a host config and
// handlers. This layer's Host is that class extended in place (ROADMAP.md,
// 8.6: no second class, no second signature), and the direct class is not
// exported:
//
//   - new Host(charts, {system, ioProcessors, config, ...}) builds the
//     config from its options (ioProcessors in the order given, each a
//     processor object with receive(send)), makes the host, then adds the
//     charts' images in order; Host.restore(snapshot, charts, options) adds
//     only the images the snapshot does not hold;
//   - spawn returns an Actor, a small immutable handle by session;
//     host.actor(session, name or address) and await host.actors() find
//     them; send.sender is one;
//   - store and resident hibernate the actors past the bound after a turn
//     and load a WAKE's blob (the direct layer's idle and wake hooks);
//   - onDone and onError get each top-level actor that ends (its done and
//     error hooks), actor.done its donedata;
//   - Actor.ask sends with an origin of the system the binding reserves,
//     tinyactors-ask, and takes the chart's reply out of the transport.
//
// The direct layer's helpers the API is built on (actorByName,
// holdsImage, residentCount, actorInfo, askOpen, askClose) are taken off
// its prototype here, so an application sees only this layer's names.
//
// The typed methods return promises when given no handler (the
// maintainer, 2026-11-18): `host.actorState(params)` returns a promise that
// resolves with the result and rejects with the TinyactorsError, while
// `host.actorState(params, onResult, onError?)` is the direct method's call
// and returns nothing. A refusal at the call rejects too. A method still
// pending at `close()` never settles: the direct layer drops its handlers
// uncalled. A `session` param may be an Actor.
//
// compileDir, SQLiteStore and directory reads reach node:fs, node:path,
// node:url and the runtime's SQLite through process.getBuiltinModule: a
// runtime without them (a browser) refuses them with TA_ERROR_UNSUPPORTED.
import {
  Address,
  CompileError,
  compileCharts,
  compileSystem,
  decode,
  decodeTraces,
  encode,
  encodeHTTPPost,
  Host as DirectHost,
  InvalidError,
  parseHTTPRequest,
  ResolveError,
  Send,
  SimulatedClock,
  StaleError,
  StateError,
  TinyactorsError,
  UnsupportedError,
} from '#direct';
export { version } from './version.mjs';
export {
  Address,
  CompileError,
  compileCharts,
  compileSystem,
  decode,
  decodeTraces,
  encode,
  encodeHTTPPost,
  InvalidError,
  parseHTTPRequest,
  ResolveError,
  SimulatedClock,
  StaleError,
  StateError,
  TinyactorsError,
  UnsupportedError,
};

// ---- the direct layer's helpers ----------------------------------------------

/** Takes method `name` off the direct Host's prototype: the application
 * layer calls it, an application does not see it. */
function taken(name) {
  const method = DirectHost.prototype[name];
  if (typeof method !== 'function') throw new Error(`@tinyactors/node: the direct layer has no Host method ${name}`);
  delete DirectHost.prototype[name];
  return method;
}

const actorByName = taken('actorByName');
const holdsImage = taken('holdsImage');
const residentCount = taken('residentCount');
const actorInfo = taken('actorInfo');
const askOpen = taken('askOpen');
const askClose = taken('askClose');

/** Defines `value` on `target` as a class's method is: writable,
 * configurable, not enumerable, its `name` the property's. */
function method(target, name, value) {
  Object.defineProperty(value, 'name', { value: name });
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

/** A plain object (an object literal, Object.create(null)), not an array,
 * a class's instance or a function. */
function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** Refuses a key of `object` that is not in `known`, naming it. */
function onlyKnown(object, known, what) {
  for (const key of Object.keys(object)) if (!known.has(key)) throw new TypeError(`unknown ${what}: ${key}`);
}

// ---- the typed methods: a promise when given no handler ------------------------

/** The direct typed method `direct` as one that returns a promise of its
 * result when it is given no handler; a `session` param may be an Actor. */
function promising(direct) {
  return function (params, onResult, onError) {
    const session = params !== null && typeof params === 'object' ? Object.getOwnPropertyDescriptor(params, 'session') : undefined;
    if (session !== undefined && session.value instanceof Actor) params = { ...params, session: session.value.id };
    if (onResult !== undefined || (onError !== undefined && onError !== null)) return direct.call(this, params, onResult, onError);
    return new Promise((resolve, reject) => {
      direct.call(this, params, resolve, reject);
    });
  };
}

/** The direct typed methods of Host. */
const TYPED_METHODS = [
  'actorState', 'actorContext', 'actorList', 'actorGet', 'hostStats', 'hostConfig',
  'traceConfigure', 'traceWatch', 'traceUnwatch', 'traceEnd', 'traceSpansDecode',
];


// ---- the host's construction ------------------------------------------------------

// The system id the binding reserves for ask()'s reply addresses: a host
// may not take it as its own.
const ASK_SYSTEM = 'tinyactors-ask';

const HOST_OPTIONS = new Set([
  'system', 'ioProcessors', 'config', 'clock', 'store', 'resident', 'log', 'telemetry', 'services', 'transport',
  'onDone', 'onError', 'onHandlerError', 'migrated', 'migrationDone', 'datamodel', 'quickjs',
]);

// The direct options a Host's options pass on as given.
const PASSED = ['clock', 'log', 'telemetry', 'services', 'migrated', 'migrationDone', 'datamodel', 'quickjs'];

/** The images of `charts`: a compile result (its `image`), an image's
 * bytes, or an array of them, in order. */
function imagesOf(charts) {
  const list = Array.isArray(charts) ? charts : [charts];
  return list.map((item) => {
    if (item instanceof Uint8Array || item instanceof ArrayBuffer) return item;
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && 'image' in item) return item.image;
    throw new TypeError('a Host\'s charts are a compile result, an image\'s bytes (a Uint8Array or an ArrayBuffer), or an array of them');
  });
}

/** A Host's options as the direct layer takes them: the host config, the
 * direct options, and the application layer's state (`app`), its `host`
 * set once the host is made. */
function shape(charts, options, restoring) {
  if (options === undefined) options = {};
  if (!plain(options)) throw new TypeError('a Host\'s options are an object');
  onlyKnown(options, HOST_OPTIONS, 'Host option');
  const images = imagesOf(charts);
  const { system, config, ioProcessors, store, resident } = options;
  if (system === undefined && restoring) throw new TypeError('restore needs options.system, the system id the snapshot was taken with');
  if (system === ASK_SYSTEM) throw new InvalidError(`the system id ${ASK_SYSTEM} is reserved for ask()'s replies`);
  if (config !== undefined && !plain(config)) {
    throw new TypeError('config is an object of the host config\'s system, migrateQuantum and telemetry');
  }
  for (const key of ['systemID', 'ioProcessors']) {
    if (config !== undefined && Object.hasOwn(config, key)) {
      throw new TypeError(`config has no ${key}: a Host takes it as options.${key === 'systemID' ? 'system' : 'ioProcessors'}`);
    }
  }
  const full = system === undefined ? { ...config } : { systemID: system, ...config };
  const direct = {};
  if (ioProcessors !== undefined) {
    if (!plain(ioProcessors)) throw new TypeError('ioProcessors is an object of a type -> its processor');
    const entries = [];
    for (const [type, processor] of Object.entries(ioProcessors)) {
      if (processor === null || typeof processor !== 'object' || typeof processor.receive !== 'function') {
        throw new TypeError(`the I/O processor ${type} is not an object with receive(send)`);
      }
      const entry = { type };
      if (processor.location !== undefined) entry.location = processor.location;
      entries.push(entry);
    }
    if (entries.length > 0) {
      full.ioProcessors = entries;
      direct.ioProcessors = ioProcessors;
    }
  }
  for (const name of PASSED) if (options[name] !== undefined) direct[name] = options[name];
  for (const name of ['transport', 'onDone', 'onError', 'onHandlerError']) {
    if (options[name] !== undefined && typeof options[name] !== 'function') throw new TypeError(`${name} is a function`);
  }
  if (store !== undefined) {
    for (const name of ['save', 'load', 'delete']) {
      if (store === null || typeof store !== 'object' || typeof store[name] !== 'function') {
        throw new TypeError(`store is an object with save(session, blob), load(session) and delete(session): it has no ${name}`);
      }
    }
  }
  if (resident !== undefined) {
    if (!Number.isSafeInteger(resident) || resident < 1) throw new TypeError('resident is the most actors kept in memory, an integer from 1');
    if (store === undefined) throw new TypeError('resident needs a store to hibernate the other actors into');
  }
  const app = {
    host: undefined,
    system,
    transport: options.transport,
    onDone: options.onDone,
    onError: options.onError,
    store,
    resident,
    dones: new Map(), // session -> the waiter of actor.done
    deferred: new Set(), // migrations' WAKEs waiting for room (resident)
    saving: new Map(), // session -> its blob, while a save that returned a promise is pending
    unsaved: new Set(), // sessions whose last save failed: the next trim leaves them resident
  };
  direct.transport = (send) => transported(app, send);
  direct.done = (session, donedata) => ended(app, session, { donedata });
  direct.error = (session, fault) => ended(app, session, { fault });
  if (options.onHandlerError !== undefined) direct.handlerError = options.onHandlerError;
  if (store !== undefined) direct.wake = (session, migration) => woken(app, session, migration);
  if (resident !== undefined) direct.idle = () => trimmed(app);
  return { config: full, direct, app, images };
}

// What Host.restore passes the constructor: taken at its entry.
let restoring = null;

let appOf;

/** Runs actors: many charts, many images, from a handful of actors to
 * millions, on the runtime's event loop (index.d.ts has the whole API). */
export class Host extends DirectHost {
  #app;

  static {
    appOf = (host) => {
      if (host === null || typeof host !== 'object' || !(#app in host)) throw new TypeError('not a Host');
      return host.#app;
    };
  }

  constructor(charts, options) {
    const restore = restoring;
    restoring = null;
    const made = restore ?? shape(charts, options, false);
    super(made.config, made.direct);
    made.app.host = this;
    this.#app = made.app;
    try {
      for (const image of made.images) if (restore === null || !holdsImage.call(this, image)) this.addImage(image);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Host.restore(snapshot, charts, options): a new Host running the
   * snapshot, with the images of `charts` it does not hold added. */
  static restore(snapshot, charts, options) {
    const made = shape(charts, options, true);
    const outer = restoring;
    restoring = made;
    try {
      return super.restore(snapshot, made.config, made.direct);
    } finally {
      restoring = outer;
    }
  }

  /** The host's system id, `options.system`. */
  get system() { return appOf(this).system; }

  /** spawn(chart, options?) -> Actor: an actor of `chart`, a chart's name
   * (its current version) or a ChartRef. */
  spawn(chart, options) {
    const ref = typeof chart === 'string' ? this.chart(chart) : chart;
    return new Actor(this, super.spawn(ref, options));
  }

  /** actor(which) -> Actor: a live actor by its session (a bigint or a
   * safe integer), an Actor, the name it was spawned with, or an address
   * of this system (a string or an Address); StaleError for none. */
  actor(which) {
    let session;
    if (which instanceof Actor) session = which.id;
    else if (typeof which === 'bigint' || typeof which === 'number') session = which;
    else if (typeof which === 'string' && !which.startsWith('tinyactors://')) return this.#named(which);
    else if (typeof which === 'string' || which instanceof Address) {
      const address = which instanceof Address ? which : new Address(which);
      if (address.system !== this.system) throw new InvalidError(`${address.text} is an address of another system`);
      if (address.session !== undefined) session = address.session;
      else if (address.name !== undefined) return this.#named(address.name);
      else throw new InvalidError(`${address.text} names no actor`);
    } else throw new TypeError('actor takes a session, an Actor, a name or an address');
    if (actorInfo.call(this, session) === undefined) throw new StaleError(`no live actor has the session ${session}`);
    return new Actor(this, BigInt(session));
  }

  #named(name) {
    const session = actorByName.call(this, name);
    if (session === undefined) throw new StaleError(`no live actor is named ${name}`);
    return new Actor(this, session);
  }

  /** actors({chart}?) -> Promise<Actor[]>: every live actor of the host
   * (actor.list, a page at a time), or those of the chart named `chart`. */
  async actors(options) {
    if (options !== undefined) {
      if (!plain(options)) throw new TypeError('actors\' options are an object: {chart}');
      onlyKnown(options, new Set(['chart']), 'actors option');
    }
    const chart = options?.chart;
    if (chart !== undefined && typeof chart !== 'string') throw new TypeError('chart is a chart\'s name, a string');
    const found = [];
    let cursor = 0;
    for (;;) {
      const page = await this.actorList({ cursor, limit: 512 });
      for (const listed of page.sessions) {
        const session = BigInt(listed);
        if (chart === undefined || (!this.closed && actorInfo.call(this, session)?.chart === chart)) found.push(new Actor(this, session));
      }
      if (page.cursor === null) return found;
      cursor = page.cursor;
    }
  }
}

for (const name of TYPED_METHODS) {
  const direct = taken(name);
  const wrapped = promising(direct);
  method(Host.prototype, name, wrapped);
  // the direct method's length (index.d.ts declares it)
  Object.defineProperty(wrapped, 'length', { value: direct.length });
}

// ---- actors ------------------------------------------------------------------

/** An actor of a host: what spawn and actor() return, what send.sender
 * and onDone get. A small immutable value made where the API returns one:
 * keeping one keeps nothing alive in the host, and two for one actor are
 * equal by `equals` (or by `id`, the key to use in a Map). */
export class Actor {
  constructor(host, id) {
    if (!(host instanceof Host)) throw new TypeError('an Actor is of a Host: new Actor(host, id)');
    if (typeof id !== 'bigint' || id < 1n || id > 0xFFFFFFFFFFFFFFFFn) {
      throw new TypeError('an Actor\'s id is its session, a bigint from 1 to 2^64-1');
    }
    Object.defineProperty(this, 'host', { value: host, enumerable: false });
    Object.defineProperty(this, 'id', { value: id, enumerable: true });
    Object.freeze(this);
  }

  /** tinyactors://<system>/#_scxml_<id>, the full form: what another
   * system sends to. A chart sees this actor's sends' _event.origin
   * either in it or as its fragment, #_scxml_<id>, so compare by the
   * fragment. */
  get address() { return Address.fromSession(this.host.system, this.id); }

  /** send(event, data?, options?): host.send to the actor. */
  send(event, data, options) {
    this.host.send(this.id, event, data, options);
  }

  /** Ends the actor now (host.terminate). */
  terminate() {
    this.host.terminate(this.id);
  }

  /** A promise of the actor's active states (actorState). */
  state() { return this.host.actorState({ session: this.id }); }
  /** A promise of the actor's variables (actorContext). */
  context() { return this.host.actorContext({ session: this.id }); }
  /** A promise of what the host knows of the actor (actorGet). */
  get() { return this.host.actorGet({ session: this.id }); }

  /** ask(event, data?, {signal}?) -> Promise<[event, data]>: sends the
   * event with an origin the host answers itself; the chart replies with
   * <send targetexpr="_event.origin">. */
  ask(event, data, options) { return asked(this.host, this.id, event, data, options); }

  /** A promise of the actor's donedata, settled when it reaches a
   * top-level final state (or rejected with the error it ended with). */
  get done() { return doneOf(this.host, this.id); }

  /** Whether `other` is an Actor of the same host and session. */
  equals(other) { return other instanceof Actor && other.host === this.host && other.id === this.id; }

  toString() { return `Actor(${this.id})`; }
}

// send.sender: the sending actor, an Actor (the view's session).
Object.defineProperty(Send.prototype, 'sender', {
  get() { return new Actor(this.host, this.session); },
  configurable: true,
  enumerable: false,
});

/** The waiter of actor.done, kept in the host's map until the actor ends;
 * one that ended already is StaleError, a closed host StateError. */
function doneOf(host, id) {
  const app = appOf(host);
  const kept = app.dones.get(id);
  if (kept !== undefined) return kept.promise;
  if (host.closed) return Promise.reject(new StateError('the Host is closed'));
  if (actorInfo.call(host, id) === undefined) return Promise.reject(new StaleError(`actor ${id} ended: its donedata is gone`));
  const waiter = {};
  waiter.promise = new Promise((resolve, reject) => {
    waiter.resolve = resolve;
    waiter.reject = reject;
  });
  app.dones.set(id, waiter);
  return waiter.promise;
}

/** A top-level actor ended (the direct layer's done or error hook): its
 * actor.done settles, then onDone(actor, donedata) or onError(actor, error). */
function ended(app, session, how) {
  const failed = how.fault !== undefined;
  const error = failed
    ? new TinyactorsError(`actor ${session} faulted (fault ${how.fault}) and ended`, { status: 'TA_ERROR_FATAL' })
    : undefined;
  const waiter = app.dones.get(session);
  if (waiter !== undefined) {
    app.dones.delete(session);
    if (failed) waiter.reject(error);
    else waiter.resolve(how.donedata);
  }
  const handler = failed ? app.onError : app.onDone;
  if (handler === undefined) return undefined;
  return handler(new Actor(app.host, session), failed ? error : how.donedata);
}

// ---- ask: a request and its reply over a send ------------------------------------

const ASK_PREFIX = `tinyactors://${ASK_SYSTEM}/@`;

/** Actor.ask: a row of the host's pending table holds the ask's settle
 * function; the event goes with origin tinyactors://tinyactors-ask/@<the
 * row's handle>. */
function asked(host, id, event, data, options) {
  if (options !== undefined) {
    if (!plain(options)) return Promise.reject(new TypeError('ask\'s options are an object: {signal}'));
    try {
      onlyKnown(options, new Set(['signal']), 'ask option');
    } catch (error) {
      return Promise.reject(error);
    }
  }
  if (typeof event !== 'string') return Promise.reject(new TypeError('ask(event, data?, options?): the event is a string'));
  const signal = options?.signal;
  if (signal !== undefined && (signal === null || typeof signal.addEventListener !== 'function')) {
    return Promise.reject(new TypeError('signal is an AbortSignal'));
  }
  if (signal?.aborted) return Promise.reject(signal.reason);
  let resolve, reject, aborted;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const settle = (name, value) => {
    if (aborted !== undefined) signal.removeEventListener('abort', aborted);
    resolve([name, value]);
  };
  let handle;
  try {
    handle = askOpen.call(host, settle);
    host.send(id, event, data, { origin: `${ASK_PREFIX}${handle}` });
  } catch (error) {
    if (handle !== undefined) askClose.call(host, handle); // refused: no reply comes
    return Promise.reject(error);
  }
  if (signal !== undefined) {
    aborted = () => {
      if (askClose.call(host, handle) !== undefined) reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
  }
  return promise;
}

/** The host's transport (the direct layer's): a send to an ask's reply
 * address settles the ask, and never reaches the application's transport;
 * any other goes to it, or fails without one. */
function transported(app, send) {
  const target = send.target;
  if (target !== undefined && target.system === ASK_SYSTEM) {
    let handle;
    try {
      handle = BigInt(target.name ?? '');
    } catch {
      return undefined; // not an ask's address: dropped
    }
    const settle = askClose.call(app.host, handle);
    if (settle !== undefined) settle(send.event, send.data); // a stale handle: dropped
    return undefined;
  }
  if (app.transport === undefined) {
    send.fail(); // no transport: a failed completion, error.communication for the sender
    return undefined;
  }
  return app.transport(send);
}

// ---- the store: hibernation the host does itself ------------------------------------

/** Whether `value` is a thenable. */
function thenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

/** A WAKE (the direct layer's wake hook): the session's blob loaded from
 * the store and woken; a migration's WAKE waits while the resident bound
 * is reached, for trimmed() to load as room allows. */
function woken(app, session, migration) {
  if (!actorInfo.call(app.host, session)?.hibernated) return undefined; // woken already by the application, or gone
  if (migration !== undefined && app.resident !== undefined && residentCount.call(app.host) >= app.resident) {
    app.deferred.add(session);
    return undefined;
  }
  return loaded(app, session);
}

/** The blob of `session` loaded and woken, then deleted from the store; a
 * load (or delete) that returns a promise is followed. */
function loaded(app, session) {
  const saving = app.saving.get(session);
  if (saving !== undefined) { // its save is pending: woken once it settled, if still hibernated
    return saving.then(() => {
      if (actorInfo.call(app.host, session)?.hibernated) return loaded(app, session);
      return undefined;
    });
  }
  const blob = app.store.load(session);
  if (thenable(blob)) return blob.then((bytes) => wokenWith(app, session, bytes));
  return wokenWith(app, session, blob);
}

function wokenWith(app, session, blob) {
  if (!(blob instanceof Uint8Array || blob instanceof ArrayBuffer)) {
    throw new StaleError(`the store has no blob of actor ${session}: it stays hibernated`);
  }
  app.host.wake(session, blob);
  return app.store.delete(session); // the blob is spent
}

// Sessions swept at once: one sweep's slice.
const SLICE = 1024;
const MAX_SCAN = 0xFFFFFFFF;

/** A turn went idle (the direct layer's idle hook): the actors past the
 * resident bound hibernated into the store (room made first for the
 * migrations' WAKEs that wait), then those WAKEs loaded while there is
 * room. Saves that return promises are followed, together. */
function trimmed(app) {
  const host = app.host;
  const waiting = app.deferred.size;
  const pending = [];
  let first = null;
  const failed = (error) => {
    if (first === null) first = [error];
  };
  // a session whose save failed was woken back, which made this turn: it
  // stays resident now, or saving it again would turn without end
  const skip = app.unsaved;
  app.unsaved = new Set();
  hibernateSurplus(app, waiting < app.resident ? app.resident - waiting : 0, { pending, failed, skip });
  while (app.deferred.size > 0 && residentCount.call(host) < app.resident) {
    const [session] = app.deferred;
    app.deferred.delete(session);
    if (!actorInfo.call(host, session)?.hibernated) continue;
    try {
      const result = loaded(app, session);
      if (thenable(result)) pending.push(result);
    } catch (error) {
      failed(error);
    }
  }
  if (first !== null) throw first[0];
  if (pending.length > 0) return Promise.all(pending).then(() => undefined);
  return undefined;
}

/** Down to `target` resident actors: the CLOCK sweep takes the actors that
 * did not run since the last one, so a revolution marks the others, a
 * second finds them, a third whatever ran in between. */
function hibernateSurplus(app, target, report) {
  const host = app.host;
  const start = residentCount.call(host);
  const sweeps = start > target ? 3 + Math.floor((start - target) / SLICE) : 0;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const resident = sweep === 0 ? start : residentCount.call(host);
    if (resident <= target) return;
    const surplus = resident - target;
    for (const session of host.sweep(MAX_SCAN, Math.min(surplus, SLICE))) {
      if (!report.skip.has(session)) stored(app, session, report);
    }
  }
}

/** One session hibernated into the store: an actor that cannot hibernate
 * now (not at rest, a value outside the table) stays. A save that throws,
 * or whose promise rejects, wakes the actor back from its blob. */
function stored(app, session, report) {
  const host = app.host;
  let blob;
  try {
    blob = host.hibernate(session);
  } catch (error) {
    if (error instanceof StateError || error instanceof UnsupportedError) return; // it stays resident
    report.failed(error);
    return;
  }
  let saved;
  try {
    saved = app.store.save(session, blob);
  } catch (error) {
    host.wake(session, blob); // back from the blob, or the actor would have none anywhere
    app.unsaved.add(session);
    report.failed(error);
    return;
  }
  if (!thenable(saved)) return;
  const settled = Promise.resolve(saved).then(
    () => {
      app.saving.delete(session);
    },
    (error) => {
      app.saving.delete(session);
      if (!host.closed && actorInfo.call(host, session)?.hibernated) {
        host.wake(session, blob);
        app.unsaved.add(session);
      }
      throw error;
    },
  );
  app.saving.set(session, settled.then(undefined, () => undefined));
  report.pending.push(settled);
}

/** A store of hibernated actors' blobs in a Map: Host's store saves an
 * actor's blob here when it hibernates the actor, loads it when an event
 * comes for it, and deletes it once the actor is back or ended. */
export class MemoryStore {
  constructor() {
    /** The blobs by session: what a test reads to see what was stored. */
    this.blobs = new Map();
  }

  save(session, blob) {
    this.blobs.set(session, blob);
  }

  load(session) {
    const blob = this.blobs.get(session);
    if (blob === undefined) throw new StaleError(`no blob of actor ${session}`);
    return blob;
  }

  delete(session) {
    this.blobs.delete(session);
  }
}

/** A session id (to 2^64 - 1) as SQLite's signed 64-bit integer. */
const signed = (session) => BigInt.asIntN(64, BigInt(session));

/** The runtime's SQLite, synchronous: node:sqlite's DatabaseSync, bun's
 * Database; a runtime without either refuses. */
function sqlite() {
  const process = globalThis.process;
  const name = globalThis.Bun ? 'bun:sqlite' : 'node:sqlite';
  let module;
  try {
    if (typeof process?.getBuiltinModule !== 'function') module = undefined;
    else module = globalThis.Bun ? process.getBuiltinModule('bun:sqlite') : process.getBuiltinModule('node:sqlite');
  } catch {
    module = undefined;
  }
  const Database = module?.DatabaseSync ?? module?.Database;
  if (typeof Database !== 'function') {
    throw new TinyactorsError(`SQLiteStore needs the runtime's SQLite (${name}), which this runtime does not have`, {
      status: 'TA_ERROR_UNSUPPORTED',
    });
  }
  return { Database, bun: globalThis.Bun !== undefined };
}

/** A store of hibernated actors' blobs in an SQLite database file, one row
 * per actor in the table tinyactors_blobs (session, blob), through the
 * runtime's own SQLite (node:sqlite, bun:sqlite), synchronously. */
export class SQLiteStore {
  #insert;
  #select;
  #delete;

  constructor(path) {
    if (typeof path !== 'string') throw new TypeError('SQLiteStore takes the database file\'s path (":memory:" for none)');
    const { Database, bun } = sqlite();
    const db = new Database(path);
    const run = (sql) => (bun ? db.run(sql) : db.exec(sql));
    run('PRAGMA journal_mode=WAL');
    run('PRAGMA synchronous=NORMAL');
    run('CREATE TABLE IF NOT EXISTS tinyactors_blobs (session INTEGER PRIMARY KEY, blob BLOB NOT NULL)');
    /** The database, for an application that reads the table itself. */
    this.database = db;
    this.#insert = db.prepare('INSERT OR REPLACE INTO tinyactors_blobs VALUES (?, ?)');
    this.#select = db.prepare('SELECT blob FROM tinyactors_blobs WHERE session = ?');
    this.#delete = db.prepare('DELETE FROM tinyactors_blobs WHERE session = ?');
  }

  save(session, blob) {
    this.#insert.run(signed(session), blob);
  }

  load(session) {
    const row = this.#select.get(signed(session));
    if (row === undefined || row === null) throw new StaleError(`no blob of actor ${session}`);
    return row.blob;
  }

  delete(session) {
    this.#delete.run(signed(session));
  }

  /** Closes the database; the file keeps the blobs saved. */
  close() {
    this.database.close();
  }
}

// ---- Spawner: spawning from a chart ------------------------------------------------

/** An I/O processor that spawns actors for charts: give it to the host
 * under a type you name, `ioProcessors: { spawn: new Spawner() }`, and a
 * chart sends `{chart, name, params}` with `<send type="spawn">`. It
 * spawns the chart's current version under the name, and the sender gets
 * `spawned` with `{name, address}` (the new actor's session address) and
 * the send's sendid, or error.communication when the host cannot spawn
 * it. It does not look names up: a name has one owner, the collection
 * actor that spawns it and records the spawns it asked for. */
export class Spawner {
  receive(send) {
    const data = send.data;
    let actor;
    try {
      if (!plain(data) || typeof data.chart !== 'string') throw new TypeError('a Spawner\'s data is {chart, name, params}');
      actor = send.host.spawn(data.chart, { name: data.name ?? undefined, params: data.params ?? undefined });
    } catch (error) {
      if (error instanceof TinyactorsError || error instanceof TypeError || error instanceof RangeError) {
        send.fail();
        return;
      }
      throw error;
    }
    send.answer('spawned', { name: data.name ?? null, address: actor.address });
  }
}

// ---- a directory of charts ---------------------------------------------------------

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** node:fs, node:path and node:url, from the runtime (node, bun); a
 * runtime without them refuses. */
function builtins(what) {
  const process = globalThis.process;
  if (typeof process?.getBuiltinModule !== 'function') {
    throw new TinyactorsError(`${what} reads files with node:fs, which this runtime does not have`, { status: 'TA_ERROR_UNSUPPORTED' });
  }
  return {
    fs: process.getBuiltinModule('node:fs'),
    path: process.getBuiltinModule('node:path'),
    url: process.getBuiltinModule('node:url'),
  };
}

/** Whether `file`, absolute, is under `root` (`path`: node:path). */
function inside(path, root, file) {
  const rest = path.relative(root, file);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${path.sep}`) && !path.isAbsolute(rest);
}

/** Text as UTF-8, refused when it is not. */
function utf8(bytes, what) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new ResolveError(`${what} is not UTF-8`);
  }
}

/** compileDir's resolver: `source` read under `root`, relative to the
 * document `base` that names it, refused when it leaves `root`, symbolic
 * links included. */
function confined({ fs, path }, top) {
  return function resolve(base, source) {
    const file = path.resolve(top, path.dirname(base), source);
    if (!inside(path, top, file)) throw new ResolveError(`${source} (from ${base}) leaves the charts' directory`);
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new ResolveError(`no file ${source} (from ${base}) under the charts' directory`);
      throw error;
    }
    if (!inside(path, top, real)) throw new ResolveError(`${source} (from ${base}) leaves the charts' directory through a symbolic link`);
    if (!fs.statSync(real).isFile()) throw new ResolveError(`${source} (from ${base}) is not a file`);
    return utf8(fs.readFileSync(real), `${source} (from ${base})`);
  };
}

/** compileDir(dir, {resolver}?) -> Compiled: every *.scxml file under the
 * directory `dir` (a path, or a file: URL) compiled into one image, named
 * by its path under it (sorted; the first is the image's default boot
 * chart), a `src` read from under `dir` by a resolver confined to it. */
export function compileDir(dir, options) {
  if (options !== undefined) {
    if (!plain(options)) throw new TypeError('compileDir\'s options are an object: {resolver}');
    onlyKnown(options, new Set(['resolver']), 'compileDir option');
  }
  const modules = builtins('compileDir');
  const { fs, path, url } = modules;
  const given = dir instanceof URL || (typeof dir === 'string' && dir.startsWith('file:')) ? url.fileURLToPath(dir) : dir;
  if (typeof given !== 'string') throw new TypeError('compileDir takes a directory: a path or a file: URL');
  const top = fs.realpathSync(given);
  if (!fs.statSync(top).isDirectory()) throw new InvalidError(`compileDir takes a directory: ${given} is not one`);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.scxml') && (entry.isFile() || entry.isSymbolicLink())) files.push(full);
    }
  };
  walk(top);
  const sources = [];
  for (const file of files) {
    const real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) continue;
    if (!inside(path, top, real)) throw new InvalidError(`the chart ${file} leaves ${top}`);
    const name = path.relative(top, file).split(path.sep).join('/');
    sources.push({ name, text: utf8(fs.readFileSync(real), name) });
  }
  if (sources.length === 0) throw new InvalidError(`no *.scxml file under ${top}`);
  sources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return compileCharts(sources, { resolver: options?.resolver ?? confined(modules, top) });
}

// ---- Address ---------------------------------------------------------------------------

// Address.prototype.toJSON: its text, so JSON.stringify writes an address
// as the string an Address is made from (new Address(text) reads it back).
method(Address.prototype, 'toJSON', function () {
  return this.text;
});
