// The Host over the module (docs/browser.md; the addon's src/host.c,
// loop.c, effects.c and methods.c, translated): the class, its inputs, the
// loop on the event loop, the effects as thin views, the typed methods,
// the invoked services, hibernation, migration and snapshots. What reads
// or writes core's structs is the C layer's (wasm/src/); this file makes
// and calls JavaScript objects and schedules.
//
// Who holds what:
//   - a Host holds its state (HostState, the owner the module's imports
//     name, held by the module weakly) and, under a symbol, its handlers
//     object (the handlers, the pending typed methods' handlers, the
//     running services): a handler that closes over its host makes a cycle
//     the collector sees through;
//   - the state holds the Host only weakly (a WeakRef), so a FinalizationRegistry
//     whose token is the state frees a host nobody closed;
//   - a pending turn (setImmediate, or a MessageChannel message) and the
//     deadline's timer hold the Host, as the addon's do.
import { Address, addressText, isAddress } from './address.mjs';
import * as cbor from './cbor.mjs';
import { bytesOf, countOf, inputOptions, onlyKnown, optionalText, sessionOf, textOf } from './checks.mjs';
import { TinyactorsError, coreError, refusal } from './errors.mjs';
import { NativeDatamodel } from './datamodel.mjs';
import { QuickJSDatamodel } from './quickjs.mjs';
import { policyRefusal } from './realms.mjs';
import { instance } from './state.mjs';

// ---- core's constants (tinyactors/host.h, system.h) ---------------------------------

const FIELD = {
  KIND: 1, SEGMENT: 2, SESSION: 4, TOKEN: 6, IO_PROCESSOR: 7, FLAGS: 8, MIGRATION: 9, PAYLOAD: 10, DATAMODEL: 11,
  CHART: 13, MIGRATED: 14, FAILED: 15, PENDING: 16,
  TARGET: 32, EVENT: 33, SENDID: 34, AUXILIARY: 35, TRACEPARENT: 36, ORIGIN: 37, WIRE: 64,
};
const EFFECT = {
  SEND: 1, INVOKE: 3, UNINVOKE: 4, LOG: 5, WAKE: 8,
  MIGRATED: 16, MIGRATION_DONE: 17, REPLY: 23,
};
const FLAG_RESTORED = 2;
const EVENT_FROM_INVOKE = 1, EVENT_INVOKE_DONE = 2, EVENT_ERROR_COMMUNICATION = 4;
const INVOCATION_FAILURE = EVENT_ERROR_COMMUNICATION | EVENT_FROM_INVOKE;
const NIL = 0xFFFFFFFF;
const TA_OK = 0, TA_ERROR_INVALID = -3, TA_ERROR_STALE = -5, TA_ERROR_UNSUPPORTED = -7;
const MIGRATE_WAKE = 1;

// The layer's own (wasm/src/web.h, loop.c).
const NEXT = { YIELD: 0, IDLE: 1, EXHAUSTED: 2, FAULT: 3, REFUSED: 4 };
const OUTPUT = { METRICS: 1, BLOB: 2, SNAPSHOT: 3, CONFIG: 4, TRACES: 5, LOGS: 6 };
const TAKE_REFUSED = 0xFFFFFFFF;
const DATAMODEL_NATIVE = 1, DATAMODEL_QUICKJS = 2;
const EVENT_WORDS = 19;
const SLICE = 256;
const CONFIG_ERROR = 8192;
// The longest delay setTimeout keeps (2^31 - 1 ms); a deadline further away
// is armed at this, and the idle turn it wakes arms the rest.
const TIMEOUT_MAX = 2147483647;
const LABEL = 'tinyactors-wasm';

const POOLS = [
  'the host\'s allocator refused memory for the host\'s own (TA_POOL_NONE)',
  'the host\'s allocator refused memory for the pool of events (TA_POOL_EVENTS)',
  'the host\'s allocator refused memory for the pool of instances and strings (TA_POOL_SLAB)',
  'the host\'s allocator refused memory for the pool of timers (TA_POOL_TIMERS)',
  'the host\'s allocator refused memory for the pool of actors (TA_POOL_ACTORS)',
  'the host\'s allocator refused memory for the pool of requests (TA_POOL_REQUESTS)',
];

const KNOWN_OPTIONS = ['ioProcessors', 'transport', 'log', 'clock', 'telemetry', 'wake', 'migrated', 'migrationDone',
  'services', 'datamodel', 'quickjs'];
const HANDLER_FUNCTIONS = ['log', 'transport', 'telemetry', 'wake', 'migrated', 'migrationDone'];
const HANDLER_MAPS = ['ioProcessors', 'services'];

// The handlers' key on a Host: not enumerable, not configurable; writable,
// so close() drops it.
const HANDLERS = Symbol('tinyactors.handlers');
// What only the layer passes the constructors of views and records.
const MAKING = Symbol('making');

// ---- the event loop's macrotasks ---------------------------------------------------------

// A turn after the event loop ran: setImmediate where it exists (node,
// bun: the addon's, so liveness is the same), else a MessageChannel
// message (a page, a Worker: a chained setTimeout(0) waits 4 ms).
const macrotask = (() => {
  if (typeof globalThis.setImmediate === 'function') {
    return { arm: (fn, host) => globalThis.setImmediate(fn, host), clear: (handle) => globalThis.clearImmediate(handle) };
  }
  const queue = [];
  let channel = null;
  const run = () => {
    const entry = queue.shift();
    if (entry !== undefined && !entry.cancelled) entry.fn(entry.host);
  };
  return {
    arm(fn, host) {
      if (channel === null) {
        channel = new MessageChannel();
        channel.port1.onmessage = run;
      }
      const entry = { fn, host, cancelled: false };
      queue.push(entry);
      channel.port2.postMessage(null);
      return entry;
    },
    clear(entry) { entry.cancelled = true; },
  };
})();

// ---- the hosts nobody closed ------------------------------------------------------------------

const unclosed = new FinalizationRegistry((state) => {
  try {
    state.release();
  } catch {
    // a poisoned module frees nothing more
  }
});

// What Host.restore passes the constructor: taken at its entry.
let restoring = null;

// The state of a Host's views and records, by the private brand of each class.
let stateOf;

// ---- the host's state: the owner of its imports ---------------------------------------------

class HostState {
  constructor(module, self) {
    this.module = module;
    this.fn = module.fn;
    this.self = new WeakRef(self);
    this.pointer = 0;
    this.id = 0;
    this.scratch = 0;
    this.open = false;
    this.depth = 0;
    this.turning = false;
    this.closing = false;
    this.immediate = null;
    this.timer = null;
    this.idle = null; // {promise, resolve, reject}
    this.promises = 0;
    this.error = null; // [the first error kept]
    this.ticksPerSecond = 0;
    this.encoder = false;
    this.telemetry = false;
    this.simulated = null; // a SimulatedClock's state
    this.processors = 0;
    this.datamodelName = 'native';
    this.native = null; // the native datamodel (datamodel.mjs)
    this.quickjs = null; // or quickjs's (quickjs.mjs)
    this.effective = null;
    this.taken = null;
    this.endings = null;
    this.reason = '';
  }

  host() { return this.self.deref(); }
  handlers() { return this.host()?.[HANDLERS]; }

  // ---- errors ----

  keep(error) {
    if (this.error === null) this.error = [error];
  }

  takeKept() {
    const kept = this.error;
    this.error = null;
    return kept;
  }

  // The import guard's: what an import's work threw.
  raised(error) { this.keep(error); }

  // ---- a call -----

  // Runs `body` as one call of the host: refused once closed, its arena
  // memory above a mark released on every path, a close() a handler asked
  // for done when the outermost call returns.
  call(body) {
    if (!this.open) throw refusal('TA_ERROR_STATE', 'the Host is closed');
    this.depth++;
    try {
      return this.module.scoped(this.scratch, body);
    } finally {
      this.leave();
    }
  }

  leave() {
    this.depth--;
    if (this.depth === 0 && !this.turning && this.closing) this.closeNow();
  }

  advance() { this.fn.ta_web_host_advance(this.pointer); }

  // An input came: a turn, one pending at a time.
  schedule() {
    if (!this.open || this.turning || this.immediate !== null) return;
    const host = this.host();
    if (host !== undefined) this.immediate = macrotask.arm(turnOf, host);
  }

  // ---- the imports ----

  effect(index, extra) {
    switch (this.word(index, FIELD.KIND)) {
    case EFFECT.SEND: this.dispatchSend(index); break;
    case EFFECT.LOG: this.dispatchLog(index); break;
    case EFFECT.WAKE: this.dispatchWake(index); break;
    case EFFECT.MIGRATED: this.dispatchMigrated(index); break;
    case EFFECT.MIGRATION_DONE: this.dispatchMigrationDone(index); break;
    case EFFECT.INVOKE: this.dispatchInvoke(index); break;
    case EFFECT.UNINVOKE: this.dispatchUninvoke(index); break;
    case EFFECT.REPLY: this.dispatchReply(index, extra); break;
    default: break;
    }
    return TA_OK;
  }

  output(kind, length) {
    const module = this.module;
    if (kind === OUTPUT.TRACES || kind === OUTPUT.LOGS) {
      const signal = kind === OUTPUT.TRACES ? 'traces' : 'logs';
      if (length === TAKE_REFUSED) {
        this.keep(refusal('TA_ERROR_NO_MEMORY', `the take of ${signal} was refused`));
        return TA_OK;
      }
      this.export(signal, module.copyOut(module.word(0), length));
      return TA_OK;
    }
    const bytes = module.copyOut(module.word(0), module.word(1));
    if (kind === OUTPUT.CONFIG) {
      this.effective = module.scoped(module.scratch, () => {
        const [at, n] = module.copyIn(module.scratch, bytes);
        return cbor.read(module, module.scratch, at, n);
      });
    } else this.taken = bytes;
    return TA_OK;
  }

  clock(which) {
    if (which === 2) return Date.now() * 1e6; // quickjs's Date: the real wall clock
    if (this.simulated !== null) return Number(this.simulated.ns);
    return which === 0 ? performance.now() * 1e6 : Date.now() * 1e6;
  }

  // The native datamodel's entries (wasm/src/datamodel.c, datamodel.mjs).
  datamodel(entry, slot) { return this.native === null ? TA_ERROR_UNSUPPORTED : this.native.entry(entry, slot); }

  // ---- effect fields ----

  number(index, field) { return BigInt.asUintN(64, this.fn.ta_web_effect_number(this.pointer, index, field)); }
  // u32 answers read as i32 by JavaScript: TA_NIL is 0xFFFFFFFF, not -1
  word(index, field) { return this.fn.ta_web_effect_word(this.pointer, index, field) >>> 0; }

  text(index, field) {
    const at = this.fn.ta_web_effect_text(this.pointer, index, field) >>> 0;
    return this.module.string(at, this.module.word(0));
  }

  acks() { return this.fn.ta_web_host_acks(this.pointer); }

  // The data of effect `index`: its payload's value, copied into the
  // application's realm.
  data(index) {
    const payload = this.number(index, FIELD.PAYLOAD);
    if (payload === 0n || this.word(index, FIELD.DATAMODEL) === NIL) return undefined;
    return this.exported(payload);
  }

  exported(payload) {
    if (this.quickjs !== null) return this.quickjs.exported(payload);
    return this.native === null ? undefined : this.native.exported(payload);
  }

  // The payload a value is for the target's datamodel: 0n for none
  // (undefined), a TypeError for a chart whose datamodel takes no data.
  // `target` is {session} or {segment, chart}.
  payload(value, target) {
    if (value === undefined) return 0n;
    const module = this.module;
    module.setWord64(0, target.session ?? 0n);
    module.setWord(2, target.segment ?? 0);
    module.setWord(3, target.chart ?? 0);
    const takes = this.fn.ta_web_host_takes_data(this.pointer);
    if (takes === TA_ERROR_STALE) throw refusal('TA_ERROR_STALE', 'no live session takes this data');
    if (takes !== 1) throw new TypeError('the chart\'s datamodel takes no data');
    return (this.quickjs ?? this.native).payload(value);
  }

  release(payload) {
    if (payload !== 0n && this.open) this.fn.ta_web_payload_drop(this.pointer, Number(payload & 0xFFFFFFFFn), Number(payload >> 32n));
  }

  // ---- promises a handler returned ----

  // Followed with `then`, counted, so idle() waits for them.
  follow(result) {
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return;
    let then;
    try {
      then = result.then;
      if (typeof then !== 'function') return;
      then.call(result, () => this.settled(), (reason) => {
        this.settled();
        throw reason;
      });
    } catch {
      return; // not followed: idle() does not wait for it
    }
    this.promises++;
  }

  settled() {
    if (this.promises > 0 && --this.promises === 0 && this.open && this.idle !== null) {
      this.schedule();
      if (this.error !== null && this.depth === 0 && !this.turning) throw this.takeKept()[0];
    }
  }

  // ---- the loop -----

  turn() {
    this.turning = true;
    let next;
    try {
      next = this.fn.ta_web_turn(this.pointer);
    } finally {
      this.turning = false;
    }
    return next;
  }

  turnError(next) {
    const kept = this.takeKept();
    if (kept !== null) return kept;
    if (next === NEXT.EXHAUSTED) {
      const pool = this.fn.ta_web_host_detail(this.pointer, 0);
      return [refusal('TA_ERROR_NO_MEMORY', POOLS[pool] ?? 'the host\'s allocator refused memory for a pool (TA_POOL_*)')];
    }
    if (next === NEXT.FAULT) {
      return [refusal(this.module.statusName(this.fn.ta_web_host_detail(this.pointer, 1)), 'the host\'s run faulted')];
    }
    return null;
  }

  clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  settle(error) {
    const idle = this.idle;
    if (idle === null) return;
    this.idle = null;
    if (error !== null) idle.reject(error[0]);
    else idle.resolve(undefined);
  }

  // One turn, from a macrotask or the timer: the turn's first error
  // rejects a waiting idle(); with none waiting it is thrown from here,
  // after the next turn is scheduled or the timer armed.
  run(byTimer) {
    if (byTimer) this.timer = null;
    else this.immediate = null;
    if (!this.open || this.turning || this.depth > 0) return;
    this.depth++;
    let next, error;
    try {
      next = this.turn();
    } catch (thrown) {
      next = NEXT.FAULT;
      this.keep(thrown); // the module stopped (a trap): its error
    }
    error = this.turnError(next);
    let settle = false;
    if (next === NEXT.YIELD && !this.closing) {
      this.schedule();
    } else {
      this.clearTimer();
      if (next === NEXT.IDLE && this.simulated === null && !this.closing && this.open) {
        const delay = this.fn.ta_web_host_delay(this.pointer);
        const host = this.host();
        if (delay >= 0 && host !== undefined) this.timer = setTimeout(timerOf, Math.min(delay, TIMEOUT_MAX), host);
      }
      settle = next !== NEXT.IDLE || this.promises === 0;
    }
    if (error === null) error = this.takeKept();
    // a close a handler asked for runs at the leave: the waiter is kept
    // from it (it would reject it as closed before idle) and settles after
    const closing = this.closing && this.depth === 1;
    const waiter = closing ? this.idle : null;
    if (closing) this.idle = null;
    this.leave();
    if (closing) {
      if (error === null) error = this.takeKept(); // the last take's
      this.idle = waiter;
      settle = true;
    }
    if (error !== null && this.idle !== null) {
      this.settle(error);
      error = null;
    } else if (settle) this.settle(null);
    if (error !== null) throw error[0];
  }

  // ---- the stop ----

  quiet() {
    this.clearTimer();
    if (this.immediate !== null) macrotask.clear(this.immediate);
    this.immediate = null;
    if (this.idle !== null) this.settle([refusal('TA_ERROR_STATE', 'the Host was closed before it was idle')]);
  }

  closeNow() {
    this.closing = false;
    this.endings = null;
    this.quiet();
    if (this.encoder && this.telemetry) {
      this.endings = [];
      this.depth++;
      try {
        this.fn.ta_web_host_end(this.pointer);
      } catch (error) {
        this.keep(error);
      }
      this.depth--;
      this.closing = false; // a close asked by a handler there: this one
      this.quiet();
    }
    this.release();
    const host = this.host();
    if (host !== undefined) host[HANDLERS] = undefined;
  }

  // The host freed in the module: by close(), or by the registry.
  release() {
    if (this.pointer === 0) return;
    const pointer = this.pointer;
    this.pointer = 0;
    this.open = false;
    unclosed.unregister(this);
    this.module.unregister(this.id);
    try {
      if (!this.module.poisoned) this.module.call('ta_web_host_free', pointer);
    } finally {
      this.native?.free(); // its realm: a page's iframe is removed
    }
  }

  // ---- dispatch ----

  // A handler's call: its error kept for the turn, its promise followed.
  invoke(handler, args) {
    let result;
    try {
      result = handler(...args);
    } catch (error) {
      this.keep(error);
      return;
    }
    this.follow(result);
  }

  dispatchSend(index) {
    const processor = this.word(index, FIELD.IO_PROCESSOR);
    if (processor === NIL) {
      this.dispatchServiceSend(index);
      return;
    }
    if (processor > this.processors) return;
    const host = this.host();
    const handlers = this.handlers();
    if (host === undefined || handlers === undefined) return;
    const view = new Send(MAKING, this, index, processor);
    const handler = handlers.processors?.[processor];
    if (typeof handler !== 'function') { // no handler: a failed completion
      try {
        replyTo(view, FAILURE);
      } catch (error) {
        this.keep(error);
      }
      return;
    }
    try {
      const result = handler(host, view);
      followSend(this, view, result);
    } catch (error) {
      failUnanswered(view);
      this.keep(error);
    }
  }

  dispatchLog(index) {
    const handler = this.handlers()?.log;
    if (typeof handler !== 'function') return;
    this.invoke(handler, [this.host(), new LogEntry(MAKING, this, index)]);
  }

  dispatchMigrated(index) {
    const handler = this.handlers()?.migrated;
    if (typeof handler !== 'function') return;
    this.invoke(handler, [this.host(), new Migrated(MAKING, this, index)]);
  }

  dispatchWake(index) {
    const handler = this.handlers()?.wake;
    if (typeof handler !== 'function') return;
    const migration = this.number(index, FIELD.MIGRATION);
    this.invoke(handler, [this.host(), this.number(index, FIELD.SESSION), migration === 0n ? undefined : Number(migration)]);
  }

  // {migration, migrated, failed, pending}, read now (valid until the
  // next run) into the host's arena.
  migrationResult(index) {
    const module = this.module;
    const id = this.word(index, FIELD.MIGRATION);
    const count = this.word(index, FIELD.PENDING), failedCount = this.word(index, FIELD.FAILED);
    const result = { migration: id, migrated: this.word(index, FIELD.MIGRATED) };
    module.scoped(this.scratch, () => {
      const pending = count ? module.room(this.scratch, 8 * count) : 0;
      const failures = failedCount ? module.room(this.scratch, 12 * failedCount) : 0;
      module.words().set([id, pending, count, failures, failedCount], module.record);
      this.fn.ta_web_host_migration_result(this.pointer);
      const got = module.word(0), lost = module.word(1);
      const words = module.words();
      const left = [];
      for (let i = 0; i < got; i++) left.push(BigInt(words[(pending >>> 2) + 2 * i]) | (BigInt(words[(pending >>> 2) + 2 * i + 1]) << 32n));
      const failed = [];
      for (let i = 0; i < lost; i++) {
        const at = (failures >>> 2) + 3 * i;
        const session = BigInt(words[at]) | (BigInt(words[at + 1]) << 32n);
        failed.push(Object.freeze({ session, reason: module.statusName(words[at + 2] | 0) }));
      }
      result.failed = Object.freeze(failed);
      result.pending = Object.freeze(left);
    });
    return result;
  }

  dispatchMigrationDone(index) {
    const handler = this.handlers()?.migrationDone;
    if (typeof handler !== 'function') return;
    let result;
    try {
      result = this.migrationResult(index);
    } catch (error) {
      this.keep(error);
      return;
    }
    this.invoke(handler, [this.host(), result]);
  }

  // The telemetry handler gets the request as a Uint8Array it keeps; in
  // the last take what it returns is kept for [Symbol.asyncDispose].
  export(signal, bytes) {
    const handler = this.handlers()?.telemetry;
    if (typeof handler !== 'function') return;
    let result;
    try {
      result = handler(this.host(), signal, bytes);
    } catch (error) {
      this.keep(error);
      return;
    }
    if (this.endings === null) this.follow(result);
    else if (result !== null && (typeof result === 'object' || typeof result === 'function')) this.endings.push(result);
  }

  // actor.get's result with each timer's due, the host's ticks, as
  // milliseconds on the clock now() reads (ta_web_host_milliseconds).
  timesInMilliseconds(result) {
    for (const timer of result?.timers ?? []) {
      const ticks = BigInt(timer.due);
      timer.due = this.fn.ta_web_host_milliseconds(this.pointer, Number(ticks & 0xFFFFFFFFn), Number(ticks >> 32n));
    }
    return result;
  }

  // A typed method's REPLY: its pending row's handlers at `slot` (the row
  // found and removed in C), the reply read once.
  dispatchReply(index, slot) {
    const handlers = this.handlers();
    if (handlers === undefined || !Array.isArray(handlers.pending)) return;
    const at = 2 * (slot - 1);
    const onResult = handlers.pending[at], onError = handlers.pending[at + 1];
    handlers.pending[at] = undefined;
    handlers.pending[at + 1] = undefined;
    let reply;
    try {
      const module = this.module;
      const pointer = this.fn.ta_web_effect_bytes(this.pointer, index, FIELD.WIRE) >>> 0;
      const length = module.word(0);
      reply = module.scoped(this.scratch, () => cbor.read(module, this.scratch, pointer, length));
    } catch (error) {
      this.keep(error);
      return;
    }
    if (reply === null || typeof reply !== 'object') return;
    if (Object.hasOwn(reply, 'error')) {
      const error = coreError(reply.error);
      if (typeof onError !== 'function') {
        this.keep(error);
        return;
      }
      this.invoke(onError, [this.host(), error]);
      return;
    }
    if (typeof onResult === 'function') this.invoke(onResult, [this.host(), reply.result]);
  }

  // ---- invoked services ----

  invocations() { return this.handlers()?.invocations; }

  dispatchInvoke(index) {
    const handlers = this.handlers();
    if (handlers === undefined) return;
    let record;
    try {
      record = new Invocation(MAKING, this, index);
    } catch (error) {
      this.keep(error);
      return;
    }
    const state = invocationState(record);
    const services = handlers.services;
    const handler = services !== null && typeof services === 'object' && Object.hasOwn(services, state.type) ? services[state.type] : undefined;
    let started = false, result, thrown = null;
    if (typeof handler === 'function') {
      try {
        result = handler(this.host(), record);
        const then = result !== null && (typeof result === 'object' || typeof result === 'function') ? result.then : undefined;
        if (typeof then === 'function') {
          startInvocation(state, result);
          return;
        }
        started = true;
      } catch (error) {
        thrown = [error];
      }
    }
    if (!started) { // it does not run: kept as failed, so sends to it fail too, until the UNINVOKE
      failInvocation(state, { sendid: undefined, tell: !this.uninvokedInBatch(index) });
      if (thrown !== null) this.keep(thrown[0]);
      return;
    }
    if (state.flags & INVOCATION.ENDED) return; // done() in the handler: nothing to keep
    this.invocations()?.set(state.key, [record, result]);
  }

  // An UNINVOKE of the same (segment, token) later in the open batch: the
  // invoker cancelled it in the run that started it.
  uninvokedInBatch(index) {
    const segment = this.word(index, FIELD.SEGMENT), token = this.word(index, FIELD.TOKEN);
    for (let i = index + 1; ; i++) {
      const kind = this.word(i, FIELD.KIND);
      if (kind === 0) return false; // past the batch
      if (kind === EFFECT.UNINVOKE && this.word(i, FIELD.SEGMENT) === segment && this.word(i, FIELD.TOKEN) === token) return true;
    }
  }

  entryOf(index) {
    const key = invocationKey(this.word(index, FIELD.SEGMENT), this.word(index, FIELD.TOKEN));
    return this.invocations()?.get(key);
  }

  dispatchServiceSend(index) {
    const entry = this.entryOf(index);
    if (entry === undefined) return;
    const [record, service] = entry;
    const state = invocationState(record);
    if (state.flags & INVOCATION.FAILED) { // a service that never ran: the send fails, as core's do
      const sendid = this.text(index, FIELD.SENDID);
      try {
        postInvocation(state, { flags: INVOCATION_FAILURE, sendid: sendid === '' ? undefined : sendid });
      } catch (error) {
        this.keep(error);
      }
      return;
    }
    const starting = (state.flags & INVOCATION.STARTING) !== 0;
    let receive = null;
    if (!starting) {
      try {
        receive = serviceMethod(service, 'receive');
      } catch (error) {
        this.keep(error);
        return;
      }
      if (receive === null) return;
    }
    const view = new Send(MAKING, this, index, NIL);
    if (starting) { // a record now, for the service once it started
      try {
        materialize(view);
        state.queue.push(view);
      } catch (error) {
        this.keep(error);
      }
      return;
    }
    try {
      serviceReceive(state, service, receive, view);
    } catch (error) {
      this.keep(error);
    }
  }

  dispatchUninvoke(index) {
    const entry = this.entryOf(index);
    if (entry === undefined) return; // done already, or never kept
    const [record, service] = entry;
    const state = invocationState(record);
    const failed = (state.flags & INVOCATION.FAILED) !== 0, starting = (state.flags & INVOCATION.STARTING) !== 0;
    if (starting) state.flags |= INVOCATION.UNINVOKED;
    endInvocation(state);
    if (failed || starting) return;
    try {
      const stop = serviceMethod(service, 'stop');
      if (stop !== null) stop.call(service, this.host());
    } catch (error) {
      this.keep(error);
    }
  }
}

// The macrotask's and the timer's callbacks: the Host is their argument.
function turnOf(host) { stateOf(host)?.run(false); }
function timerOf(host) { stateOf(host)?.run(true); }

// ---- an event's words (wasm/src/host.c, ta_web_event_at) -------------------------------------

// Writes an event's words at word index `at`; texts are [pointer, length].
function eventWords(words, at, event) {
  const session = event.session ?? 0n, data = event.data ?? 0n;
  const none = [0, 0];
  const [name, sendid, origin, origintype, raw, traceparent] =
    [event.name, event.sendid, event.origin, event.origintype, event.raw, event.traceparent].map((t) => t ?? none);
  words[at] = Number(session & 0xFFFFFFFFn);
  words[at + 1] = Number(session >> 32n);
  words[at + 2] = event.flags ?? 0;
  words[at + 3] = event.token ?? 0;
  words[at + 4] = name[0]; words[at + 5] = name[1];
  words[at + 6] = sendid[0]; words[at + 7] = sendid[1];
  words[at + 8] = origin[0]; words[at + 9] = origin[1];
  words[at + 10] = origintype[0]; words[at + 11] = origintype[1];
  words[at + 12] = Number(data & 0xFFFFFFFFn);
  words[at + 13] = Number(data >> 32n);
  words[at + 14] = raw[0]; words[at + 15] = raw[1];
  words[at + 16] = traceparent[0]; words[at + 17] = traceparent[1];
  words[at + 18] = 0;
}

// ---- thin views ------------------------------------------------------------------------------

const SEND_FIELDS = ['session', 'event', 'target', 'sendid', 'data', 'type', 'origin', 'traceparent'];
const VIEW_RECORD = 1, VIEW_ANSWERED = 2, VIEW_FAILED = 4;
// What answer() and fail() send: an answer, or the failure (`name` absent).
const FAILURE = Object.freeze({ data: undefined });

let viewOf;

function stale() {
  return refusal('TA_ERROR_STALE', 'the effect\'s batch was acknowledged: read its fields in the handler, or return a promise from it');
}

// A send's thin view: the host's state, the ack count of its batch, the
// effect's index, its I/O processor and flags, then one slot per field,
// converted on first read and cached; a read with another ack count throws
// TA_ERROR_STALE. A record (a handler returned a promise) has every field
// filled before the ack and never goes stale.
class Send {
  #view;

  constructor(making, state, index, processor) {
    if (making !== MAKING) throw new TypeError('a view of an effect is made by the host and given to its handler');
    this.#view = { state, acks: state.acks(), index, processor, flags: 0, fields: new Map() };
  }

  static {
    viewOf = (self) => {
      if (self === null || typeof self !== 'object' || !(#view in self)) throw new TypeError('not a view of an effect');
      return self.#view;
    };
  }

  get session() { return sendField(viewOf(this), 'session'); }
  get event() { return sendField(viewOf(this), 'event'); }
  get target() { return sendField(viewOf(this), 'target'); }
  get sendid() { return sendField(viewOf(this), 'sendid'); }
  get data() { return sendField(viewOf(this), 'data'); }
  get type() { return sendField(viewOf(this), 'type'); }
  get origin() { return sendField(viewOf(this), 'origin'); }
  get traceparent() { return sendField(viewOf(this), 'traceparent'); }

  // The send's outgoing half, the object host.send(message) takes: a text
  // field the send lacks is null.
  get message() {
    const view = viewOf(this);
    const message = {};
    for (const key of ['target', 'event', 'data', 'sendid', 'origin', 'traceparent']) {
      const value = sendField(view, key);
      message[key] = value === undefined && (key === 'sendid' || key === 'origin' || key === 'traceparent') ? null : value;
    }
    return message;
  }

  // answer(event, data?, {traceparent, origin, raw}?): true when
  // delivered, false when the sender ended meanwhile.
  answer(event, data, options) {
    const view = viewOf(this);
    const answer = { name: event, data, traceparent: undefined, origin: undefined, raw: undefined, given: false };
    if (options !== undefined) {
      if (options === null || typeof options !== 'object') throw new TypeError('an answer\'s options are an object of traceparent, origin, raw');
      for (const key of Object.keys(options)) {
        if (key !== 'traceparent' && key !== 'origin' && key !== 'raw') throw new TypeError('an answer\'s options are traceparent, origin and raw');
      }
      if (options.traceparent !== undefined) {
        answer.traceparent = options.traceparent; // null: a new trace
        answer.given = true;
      }
      answer.origin = options.origin;
      answer.raw = options.raw;
    }
    if (typeof answer.name !== 'string') throw new TypeError('answer(event, data?, options?): the event is a string');
    return replyTo(this, answer, view);
  }

  // fail(): error.communication for the sender, with the send's sendid and
  // trace; false when the sender ended, as answer().
  fail() {
    return replyTo(this, FAILURE, viewOf(this));
  }
}

function live(view) {
  if (view.flags & VIEW_RECORD) return;
  if (!view.state.open || view.state.acks() !== view.acks) throw stale();
}

function sendField(view, name) {
  if (view.fields.has(name)) return view.fields.get(name);
  live(view);
  const { state, index, processor } = view;
  let value;
  switch (name) {
  case 'session': value = state.number(index, FIELD.SESSION); break;
  case 'event': value = state.text(index, FIELD.EVENT); break;
  case 'target': {
    const text = state.text(index, FIELD.TARGET);
    value = text === '' ? undefined : processor === 0 ? new Address(text) : text;
    break;
  }
  case 'sendid': value = state.text(index, FIELD.SENDID) || undefined; break;
  case 'data': value = state.data(index); break;
  case 'type': value = processor === NIL ? undefined : state.handlers()?.types?.[processor]; break;
  case 'origin': {
    const text = state.text(index, FIELD.ORIGIN);
    value = text === '' ? undefined : new Address(text);
    break;
  }
  default: value = state.text(index, FIELD.TRACEPARENT) || undefined;
  }
  view.fields.set(name, value);
  return value;
}

// Every field read now, the view marked a record.
function materialize(send) {
  const view = viewOf(send);
  for (const name of SEND_FIELDS) sendField(view, name);
  view.flags |= VIEW_RECORD;
}

// A handler returned a thenable: its view filled before the ack, and its
// rejection followed (the send failed if nobody answered it, the rejection
// thrown on, so the promise `then` made rejects unhandled).
function followSend(state, send, result) {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return;
  const then = result.then;
  if (typeof then !== 'function') return;
  materialize(send);
  const chained = then.call(result, undefined, (reason) => {
    failUnanswered(send);
    throw reason;
  });
  state.follow(chained);
}

// An answer or the failure of a send: ta_host_send to its session with its
// sendid. true delivered, false the sender ended; a refusal throws.
function replyTo(send, answer, view = viewOf(send)) {
  live(view);
  if (view.flags & (VIEW_ANSWERED | VIEW_FAILED)) {
    throw refusal('TA_ERROR_STATE', view.flags & VIEW_FAILED ? 'the send was failed already' : 'the send was answered already');
  }
  const session = sendField(view, 'session');
  const sendid = sendField(view, 'sendid');
  const type = sendField(view, 'type');
  const failure = answer === FAILURE;
  const traceparent = failure || !answer.given ? sendField(view, 'traceparent') : answer.traceparent;
  const state = view.state;
  return state.call(() => {
    const module = state.module, scratch = state.scratch;
    if (state.fn.ta_web_host_locate(state.pointer, Number(session & 0xFFFFFFFFn), Number(session >> 32n)) !== TA_OK) return false;
    const event = {
      session,
      sendid: module.text(scratch, optionalText(sendid, 'a sendid is a string')),
      traceparent: module.text(scratch, optionalText(traceparent, 'a traceparent is W3C text, a string, or null for a new trace')),
    };
    if (failure) event.flags = EVENT_ERROR_COMMUNICATION; // the name is not repeated
    else {
      event.name = module.text(scratch, textOf(answer.name, 'an answer\'s event is a string'));
      event.origintype = module.text(scratch, optionalText(type, 'a processor\'s type is a string'));
      event.origin = module.text(scratch, optionalText(addressText(answer.origin), 'an origin is an address, a string or an Address'));
      event.raw = module.text(scratch, optionalText(answer.raw, 'raw is the message as read, a string'));
      event.data = state.payload(answer.data, { session });
    }
    eventWords(module.words(), module.record, event);
    const status = state.fn.ta_web_host_send(state.pointer);
    if (status === TA_ERROR_STALE) return false; // the sender ended: nobody to tell (C released the data)
    if (status !== TA_OK) throw refusal(module.statusName(status), failure ? 'the failure was refused' : 'the answer was refused');
    view.flags |= failure ? VIEW_FAILED : VIEW_ANSWERED;
    state.schedule();
    return true;
  });
}

// Fails a send nobody answered, for a handler that could not; what that
// throws is dropped.
function failUnanswered(send) {
  const view = viewOf(send);
  if (view.flags & (VIEW_ANSWERED | VIEW_FAILED) || !view.state.open) return;
  try {
    replyTo(send, FAILURE, view);
  } catch {
    // nobody's news
  }
}

let entryOf;

// A <log> line: (session, label, text), a thin view until the ack.
class LogEntry {
  #view;

  constructor(making, state, index) {
    if (making !== MAKING) throw new TypeError('a view of an effect is made by the host and given to its handler');
    this.#view = { state, acks: state.acks(), index, flags: 0, fields: new Map() };
  }

  static {
    entryOf = (self, name, read) => {
      if (self === null || typeof self !== 'object' || !(#view in self)) throw new TypeError('not a view of an effect');
      return cachedField(self.#view, name, read);
    };
  }

  get session() { return entryOf(this, 'session', (s, i) => s.number(i, FIELD.SESSION)); }
  get label() { return entryOf(this, 'label', (s, i) => s.text(i, FIELD.AUXILIARY)); }
  get text() { return entryOf(this, 'text', (s, i) => s.text(i, FIELD.EVENT)); }
}

function cachedField(view, name, read) {
  if (view.fields.has(name)) return view.fields.get(name);
  live(view);
  const value = read(view.state, view.index);
  view.fields.set(name, value);
  return value;
}

let migratedOf;

// An actor moved by a migration: a thin view until the ack.
class Migrated {
  #view;

  constructor(making, state, index) {
    if (making !== MAKING) throw new TypeError('a view of an effect is made by the host and given to its handler');
    this.#view = { state, acks: state.acks(), index, flags: 0, fields: new Map() };
  }

  static {
    migratedOf = (self, name, read) => {
      if (self === null || typeof self !== 'object' || !(#view in self)) throw new TypeError('not a view of an effect');
      return cachedField(self.#view, name, read);
    };
  }

  get session() { return migratedOf(this, 'session', (s, i) => s.number(i, FIELD.SESSION)); }
  get segment() { return migratedOf(this, 'segment', (s, i) => s.word(i, FIELD.SEGMENT)); }
  get chart() { return migratedOf(this, 'chart', (s, i) => s.text(i, FIELD.EVENT)); }
  get migration() { return migratedOf(this, 'migration', (s, i) => s.word(i, FIELD.MIGRATION)); }
}

// ---- invoked services --------------------------------------------------------------------------

const INVOCATION = { ENDED: 1, FAILED: 2, RESTORED: 4, STARTING: 8, UNINVOKED: 16 };

let invocationState;

const invocationKey = (segment, token) => (BigInt(segment) << 32n) | BigInt(token);

// A text field of the INVOKE shared with the last invocation's when the
// text is the same, so a population holds one string of its type, src
// and invokeid.
function sharedText(state, index, slot, field) {
  const text = state.text(index, field);
  const last = state.handlers()?.last;
  if (last === undefined) return text;
  if (last[slot] === text) return last[slot];
  last[slot] = text;
  return text;
}

// What an INVOKE said, read once before the ack (the service runs until
// done or cancelled), and how to answer the invoker.
class Invocation {
  #state;

  constructor(making, state, index) {
    if (making !== MAKING) throw new TypeError('an Invocation is made by the host and given to its service handler');
    const segment = state.word(index, FIELD.SEGMENT), token = state.word(index, FIELD.TOKEN);
    this.#state = {
      self: this,
      host: state,
      segment,
      token,
      key: invocationKey(segment, token),
      flags: state.word(index, FIELD.FLAGS) & FLAG_RESTORED ? INVOCATION.RESTORED : 0,
      session: state.number(index, FIELD.SESSION),
      invokeid: sharedText(state, index, 0, FIELD.SENDID),
      type: sharedText(state, index, 1, FIELD.EVENT),
      src: sharedText(state, index, 2, FIELD.TARGET),
      data: state.data(index),
      traceparent: state.text(index, FIELD.TRACEPARENT) || undefined,
      queue: undefined,
    };
  }

  static {
    invocationState = (self) => {
      if (self === null || typeof self !== 'object' || !(#state in self)) throw new TypeError('not an Invocation');
      return self.#state;
    };
  }

  get session() { return invocationState(this).session; }
  get invokeid() { return invocationState(this).invokeid; }
  get type() { return invocationState(this).type; }
  get src() { return invocationState(this).src; }
  get data() { return invocationState(this).data; }
  get traceparent() { return invocationState(this).traceparent; }
  get restored() { return (invocationState(this).flags & INVOCATION.RESTORED) !== 0; }

  get running() {
    const state = invocationState(this);
    return !(state.flags & INVOCATION.ENDED) && state.host.open;
  }

  // sendBack(event, data?, {traceparent}?)
  sendBack(event, data, options) {
    const state = invocationState(this);
    if (typeof event !== 'string') throw new TypeError('sendBack(event, data?, options?): the event is a string');
    const traceparent = invocationOptions(options);
    postInvocation(state, { flags: EVENT_FROM_INVOKE, name: event, data, traceparent });
  }

  // done(data?, {traceparent}?): done.invoke.<invokeid> for the invoker;
  // the service is dropped.
  done(data, options) {
    const state = invocationState(this);
    const traceparent = invocationOptions(options);
    postInvocation(state, { flags: EVENT_INVOKE_DONE, data, traceparent });
    endInvocation(state);
  }
}

// sendBack's and done's options: {traceparent}; undefined when absent (the
// invocation's trace), null a new trace.
function invocationOptions(options) {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object') throw new TypeError('an invocation\'s options are an object of traceparent');
  for (const key of Object.keys(options)) {
    if (key !== 'traceparent') throw new TypeError('an invocation\'s options are traceparent only');
  }
  return options.traceparent;
}

// An event from the service to its invoker (TA_EVENT_IN_FROM_INVOKE), its
// done (TA_EVENT_IN_INVOKE_DONE), or its failure (with the failed send's
// sendid when there is one).
function postInvocation(state, what) {
  const host = state.host;
  const failure = (what.flags & EVENT_ERROR_COMMUNICATION) !== 0;
  if (((state.flags & INVOCATION.ENDED) && !failure) || !host.open) {
    throw refusal('TA_ERROR_STALE', !host.open ? 'the Host is closed' : 'the invocation ended: done, cancelled or failed');
  }
  const traceparent = what.traceparent === undefined ? state.traceparent : what.traceparent;
  host.call(() => {
    const module = host.module, scratch = host.scratch;
    const event = {
      session: state.session,
      flags: what.flags,
      token: state.token,
      name: what.name === undefined ? undefined : module.text(scratch, textOf(what.name, 'a service\'s event is a string')),
      traceparent: module.text(scratch, optionalText(traceparent, 'a traceparent is W3C text, a string, or null for a new trace')),
      sendid: what.sendid === undefined ? undefined : module.text(scratch, optionalText(what.sendid, 'a sendid is a string')),
    };
    if (!failure) event.data = host.payload(what.data, { session: state.session });
    eventWords(module.words(), module.record, event);
    const status = host.fn.ta_web_host_send(host.pointer);
    if (status !== TA_OK) {
      throw refusal(module.statusName(status), what.flags & EVENT_INVOKE_DONE ? 'the done was refused' : failure ? 'the failure was refused' : 'the event was refused');
    }
    host.schedule();
  });
}

// The invocation ended (done, cancelled): its entry goes, and with it the
// host's hold on the service.
function endInvocation(state) {
  state.flags |= INVOCATION.ENDED;
  state.host.invocations()?.delete(state.key);
}

// The invocation failed (its start, or its service crashed): unless it
// ended already it is marked failed, kept without its service, and the
// invoker told (with `sendid` when a send failed).
function failInvocation(state, { sendid, tell }) {
  if (state.flags & INVOCATION.ENDED) return;
  state.flags |= INVOCATION.ENDED | INVOCATION.FAILED;
  state.host.invocations()?.set(state.key, [state.self, undefined]);
  if (!tell) return;
  try {
    postInvocation(state, { flags: INVOCATION_FAILURE, sendid });
  } catch {
    // what the failure's post threw is nobody's news
  }
}

// A method of a service (receive, stop), or null when it has none.
function serviceMethod(service, name) {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return null;
  const method = service[name];
  return typeof method === 'function' ? method : null;
}

// A send for a running service's receive, called on the service. A receive
// that returns a promise has its view filled now, before the ack, and a
// rejection is a crash; one that throws is a crash too (the error thrown
// on).
function serviceReceive(state, service, receive, send) {
  let result;
  try {
    result = receive.call(service, state.host.host(), send);
    const then = result !== null && (typeof result === 'object' || typeof result === 'function') ? result.then : undefined;
    if (typeof then === 'function') {
      materialize(send);
      const chained = then.call(result, undefined, (reason) => {
        failInvocation(state, { sendid: sendidOf(send), tell: true });
        throw reason;
      });
      state.host.follow(chained);
    }
  } catch (error) {
    failInvocation(state, { sendid: sendidOf(send), tell: true });
    throw error;
  }
}

function sendidOf(send) {
  try {
    return send.sendid;
  } catch {
    return undefined;
  }
}

// A service handler returned a thenable: the invocation is starting until
// it settles; what comes meanwhile is queued.
function startInvocation(state, thenable) {
  state.queue = [];
  state.flags |= INVOCATION.STARTING;
  const chained = thenable.then((service) => startedInvocation(state, service), (reason) => startFailed(state, reason));
  state.host.follow(chained);
  if (state.flags & INVOCATION.ENDED) return; // done() in the handler: nothing to keep
  state.host.invocations()?.set(state.key, [state.self, undefined]);
}

function settleQueue(state) {
  const queue = state.queue ?? [];
  state.queue = undefined;
  state.flags &= ~INVOCATION.STARTING;
  return queue;
}

// The handler's promise resolved with the service (between turns, never
// inside a run).
function startedInvocation(state, service) {
  const queue = settleQueue(state);
  const host = state.host;
  if (!host.open) return; // closed: dropped, not started
  if (state.flags & INVOCATION.UNINVOKED) { // cancelled while it started: stopped now
    const stop = serviceMethod(service, 'stop');
    if (stop !== null) stop.call(service, host.host());
    return;
  }
  if (state.flags & INVOCATION.ENDED) return; // done in its start
  host.invocations()?.set(state.key, [state.self, service]);
  let raised = null;
  for (const send of queue) {
    if (!host.open) break;
    try {
      if (state.flags & INVOCATION.FAILED) { // crashed on an earlier send: this one fails
        postInvocation(state, { flags: INVOCATION_FAILURE, sendid: sendidOf(send) });
      } else if (!(state.flags & INVOCATION.ENDED)) {
        const receive = serviceMethod(service, 'receive');
        if (receive !== null) serviceReceive(state, service, receive, send);
      }
    } catch (error) {
      if (raised === null) raised = [error];
    }
  }
  if (raised !== null) throw raised[0];
}

// The handler's promise rejected: a failed start, unless it ended
// meanwhile; the invoker told, then each queued send with its sendid.
function startFailed(state, reason) {
  const queue = settleQueue(state);
  const host = state.host;
  if (host.open && !(state.flags & INVOCATION.ENDED)) {
    failInvocation(state, { sendid: undefined, tell: true });
    for (const send of queue) {
      if (!host.open) break;
      try {
        postInvocation(state, { flags: INVOCATION_FAILURE, sendid: sendidOf(send) });
      } catch {
        // a failure core refuses is nobody's news
      }
    }
  }
  throw reason;
}

// ---- SimulatedClock ---------------------------------------------------------------------------

let clockOf;

// A clock in milliseconds (nanoseconds inside, exact) that moves only with
// increment(ms), which schedules a turn on each host made with it; such a
// host arms no timer. It holds the hosts weakly.
export class SimulatedClock {
  #clock = { ns: 0n, hosts: [] };

  constructor() {
    if (new.target === undefined) throw new TypeError('SimulatedClock is a class: new SimulatedClock()');
  }

  static {
    clockOf = (self) => {
      if (self === null || typeof self !== 'object' || !(#clock in self)) throw new TypeError('not a SimulatedClock');
      return self.#clock;
    };
  }

  get now() { return Number(clockOf(this).ns) / 1e6; }

  increment(ms) {
    const clock = clockOf(this);
    if (typeof ms !== 'number') throw new TypeError('increment(ms): a number of milliseconds');
    if (!(ms >= 0)) throw new RangeError('increment(ms): not negative, not NaN');
    const step = ms * 1e6 + 0.5;
    if (step >= 18446744073709551616 - Number(clock.ns)) throw new RangeError('increment(ms): the clock would pass 2^64 nanoseconds');
    clock.ns += BigInt(Math.trunc(step));
    const live = [];
    for (const reference of clock.hosts) {
      const host = reference.deref();
      const state = host === undefined ? undefined : stateOf(host);
      if (state === undefined || !state.open) continue;
      live.push(reference);
      state.schedule();
    }
    clock.hosts = live;
  }
}

// ---- the Host ----------------------------------------------------------------------------------

// The options' handlers, checked, into the handlers object the Host holds.
function readHandlers(options) {
  const handlers = {};
  for (const name of HANDLER_FUNCTIONS) {
    const value = options?.[name];
    if (value === undefined) continue;
    if (typeof value !== 'function') throw new TypeError('a Host\'s handler is a function');
    handlers[name] = value;
  }
  for (const name of HANDLER_MAPS) {
    const value = options?.[name];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object') throw new TypeError('ioProcessors and services are objects of a type -> its handler');
    for (const key of Object.keys(value)) {
      if (typeof value[key] !== 'function') throw new TypeError('ioProcessors and services are objects of a type -> its handler');
    }
    handlers[name] = value;
  }
  handlers.invocations = new Map();
  handlers.last = new Array(3);
  return handlers;
}

// The quickjs option's limits, checked as the addon checks them, as the
// record's words 10-15 of ta_web_host_new (wasm/src/host.c,
// ta_web_quickjs_config): maxOps, memoryLimit, stackLimit, realm.
function checkQuickjs(given) {
  if (given === undefined) return;
  if (given === null || typeof given !== 'object') throw new TypeError('quickjs is an object of the sandbox\'s limits');
  onlyKnown(given, ['maxOps', 'memoryLimit', 'stackLimit', 'realm'], 'quickjs option');
  if (given.maxOps !== undefined) countOf(given.maxOps, 'quickjs.maxOps is an integer from 0 to 2^32-1');
  if (given.memoryLimit !== undefined) countOf(given.memoryLimit, 'quickjs.memoryLimit is a safe integer of bytes, 0 or more', Number.MAX_SAFE_INTEGER);
  if (given.stackLimit !== undefined) countOf(given.stackLimit, 'quickjs.stackLimit is a safe integer of bytes, 0 or more', Number.MAX_SAFE_INTEGER);
  if (given.realm !== undefined && given.realm !== 'auto' && given.realm !== 'isolated') throw new TypeError('quickjs.realm is "auto" or "isolated"');
}

function quickjsWords(given) {
  const words = new Uint32Array(6);
  const wide = (at, n) => {
    words[at] = n % 0x100000000;
    words[at + 1] = Math.floor(n / 0x100000000);
  };
  words[0] = given?.maxOps ?? 0;
  wide(1, given?.memoryLimit ?? 0);
  wide(3, given?.stackLimit ?? 0);
  words[5] = given?.realm === 'isolated' ? 1 : 0;
  return words;
}

// The effective config read once: the tick rate, whether an encoder runs,
// the I/O processors (each type's handler at its number, processors[i + 1]
// for ioProcessors[i], 0 the transport; types likewise).
function readEffective(state, handlers) {
  const reply = state.effective;
  const config = reply?.result;
  const rate = config?.system?.ticksPerSecond;
  if (config === null || typeof config !== 'object' || typeof rate !== 'number' || rate < 1) {
    throw refusal('TA_ERROR_STATE', 'host.config gave no system.ticksPerSecond');
  }
  state.ticksPerSecond = rate;
  state.encoder = Object.hasOwn(config, 'telemetry');
  const entries = Array.isArray(config.ioProcessors) ? config.ioProcessors : [];
  const given = handlers.ioProcessors;
  const processors = [handlers.transport], types = [undefined];
  let found = 0;
  for (const entry of entries) {
    const type = entry !== null && typeof entry === 'object' && typeof entry.type === 'string' ? entry.type : undefined;
    types.push(type);
    let handler;
    if (given !== undefined && type !== undefined && Object.hasOwn(given, type)) {
      handler = given[type];
      found++;
    }
    processors.push(handler);
  }
  if (given !== undefined && Object.keys(given).length !== found) {
    throw new TypeError('ioProcessors names a type the config\'s ioProcessors does not have');
  }
  state.processors = entries.length;
  handlers.processors = processors;
  handlers.types = types;
}

// The config a new host is made with: the caller's, or, when it gives no
// system.traceSeed, a copy with a random one (the language layer picks the
// seed, the maintainer, 2026-11-18), so hosts start different trace ids; a
// seed the caller sets is kept, and so reproduces. A config core will refuse
// anyway (not an object, a `system` that is not one) and a runtime without
// crypto.getRandomValues keep the config as it is. As the addon's
// ta_napi_config_seeded (src/host.c).
function seeded(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return config;
  const system = config.system;
  if (system !== undefined) {
    if (system === null || typeof system !== 'object' || Array.isArray(system)) return config;
    if (system.traceSeed !== undefined) return config; // the caller's
  }
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return config;
  const [low, high] = globalThis.crypto.getRandomValues(new Uint32Array(2));
  return Object.assign({}, config, { system: Object.assign({}, system, { traceSeed: (BigInt(high) << 32n) | BigInt(low) }) });
}

// ta_web_host_new or ta_web_host_restore, with the config written into the
// environment's arena and room for a refused config's error; then the
// checks of a restore. Answers the host's pointer and, for a restore, the
// snapshot's time.
function makeHost(state, config, pack, limits) {
  const module = state.module;
  const scratch = module.scratch;
  return module.scoped(scratch, () => {
    // a restore keeps its config as given: its segments keep the snapshot's generators
    const [at, length] = cbor.write(module, scratch, pack === null ? seeded(config) : config);
    const room = module.room(scratch, CONFIG_ERROR);
    // a new host: random bits for its identity, so its hibernation blobs wake
    // in no other host (a restore keeps its snapshot's)
    let packed = pack === null ? globalThis.crypto.getRandomValues(new Uint32Array(2)) : [0, 0];
    if (pack !== null) packed = module.copyIn(scratch, pack); // 8-aligned, as a pack's parts need
    const datamodel = state.quickjs !== null ? DATAMODEL_QUICKJS : DATAMODEL_NATIVE;
    module.words().set([at, length, state.id, datamodel, room, CONFIG_ERROR, packed[0], packed[1], 0, 0, ...quickjsWords(limits)], module.record);
    const pointer = module.call(pack === null ? 'ta_web_host_new' : 'ta_web_host_restore', module.env) >>> 0;
    const w = module.words().slice(module.record, module.record + 9);
    const status = w[0] | 0;
    if (pointer === 0) {
      if (state.error !== null) throw state.takeKept()[0];
      if (pack !== null && w[2] === 2) {
        throw refusal('TA_ERROR_INVALID', 'a snapshot of @tinyactors/node: a snapshot restores only in the package that made it, ' +
          'of the same version (it is the host\'s memory); move actors between the packages as hibernation blobs');
      }
      if (pack !== null && (w[2] === 1 || (status === TA_ERROR_INVALID && w[1] === 0))) {
        throw refusal('TA_ERROR_INVALID', 'not a snapshot of a Host of @tinyactors/wasm');
      }
      let error = null;
      if (w[1] > 0 && w[1] <= CONFIG_ERROR) {
        try {
          error = cbor.read(module, scratch, room, w[1])?.error ?? null;
        } catch {
          error = null;
        }
      }
      throw coreError(error, module.statusName(status));
    }
    if (pack === null) return { pointer };
    // what is checked once the host is made: views of the pack in the arena
    const time = BigInt(w[3]) | (BigInt(w[4]) << 32n);
    const systemID = module.string(w[5], w[6]);
    let datamodels = null;
    try {
      datamodels = cbor.read(module, scratch, w[7], w[8]);
    } catch {
      datamodels = null;
    }
    return { pointer, time, systemID, datamodels };
  });
}

const STATE_KEYS = ['native', 'quickjs'];

// The datamodel's state back: {"native": ...} or {"quickjs": bytes}, the
// key the host's datamodel: the native tables' namespaces and rows
// (datamodel.mjs, restore), or quickjs's state (quickjs.mjs).
function restoreDatamodel(state, datamodels) {
  if (datamodels === null || typeof datamodels !== 'object' || Array.isArray(datamodels) || Object.keys(datamodels).length !== 1) {
    throw refusal('TA_ERROR_INVALID', 'not a snapshot of a Host');
  }
  const [key] = Object.keys(datamodels);
  if (key !== state.datamodelName) {
    throw refusal('TA_ERROR_INVALID', state.datamodelName === 'native'
      ? 'the snapshot is of a host on quickjs: restore it with datamodel "quickjs"'
      : 'the snapshot is of a host on the native datamodel: restore it with datamodel "native"');
  }
  (state.quickjs ?? state.native).restore(datamodels[key]);
}

let checked;

export class Host {
  #s;

  static {
    stateOf = (host) => (host !== null && typeof host === 'object' && #s in host ? host.#s : undefined);
    checked = (host, open) => {
      if (host === null || typeof host !== 'object' || !(#s in host)) throw new TypeError('not a Host');
      const state = host.#s;
      if (open && !state.open) throw refusal('TA_ERROR_STATE', 'the Host is closed');
      return state;
    };
  }

  constructor(config, options) {
    const restore = restoring;
    restoring = null;
    if (new.target === undefined) throw new TypeError('Host is a class: new Host(config, options)');
    if (options !== undefined) {
      if (options === null || typeof options !== 'object') throw new TypeError('a Host\'s options are an object');
      onlyKnown(options, KNOWN_OPTIONS, 'Host option');
    }
    const handlers = readHandlers(options);
    const datamodel = options?.datamodel;
    if (datamodel !== undefined && datamodel !== 'native' && datamodel !== 'quickjs') throw new TypeError('datamodel is "native" or "quickjs"');
    if (datamodel !== 'quickjs' && options?.quickjs !== undefined) {
      throw new TypeError('quickjs\'s limits are for a host with datamodel "quickjs"');
    }
    if (datamodel === 'quickjs') checkQuickjs(options.quickjs);
    else {
      const policy = policyRefusal(); // the native datamodel evaluates chart text; quickjs evaluates none
      if (policy !== null) throw refusal('TA_ERROR_UNSUPPORTED', policy);
    }
    const clock = options?.clock;
    let clockState = null;
    if (clock !== undefined) {
      try {
        clockState = clockOf(clock);
      } catch {
        throw new TypeError('clock is a SimulatedClock');
      }
    }
    const module = instance();
    const state = new HostState(module, this);
    state.telemetry = options?.telemetry !== undefined;
    if (datamodel === 'quickjs') {
      state.datamodelName = 'quickjs';
      state.quickjs = new QuickJSDatamodel(state);
    } else {
      state.datamodelName = 'native';
      state.native = new NativeDatamodel(state);
    }
    state.id = module.register(state);
    let made;
    try {
      made = makeHost(state, config, restore === null ? null : bytesOf(restore.snapshot, 'restore takes the snapshot\'s bytes: a Uint8Array or an ArrayBuffer'), options?.quickjs);
    } catch (error) {
      module.unregister(state.id);
      throw error;
    }
    state.pointer = made.pointer;
    state.scratch = module.call('ta_web_host_scratch', made.pointer) >>> 0;
    state.open = true;
    unclosed.register(this, state, state);
    try {
      readEffective(state, handlers);
      if (restore !== null) {
        restoreDatamodel(state, made.datamodels);
        if (state.effective.result.systemID !== made.systemID) {
          throw refusal('TA_ERROR_INVALID', `the snapshot is of system ${made.systemID}: restore it with the config it was taken with`);
        }
      }
    } catch (error) {
      state.release();
      throw error;
    }
    state.effective = null;
    Object.defineProperty(this, HANDLERS, { value: handlers, writable: true, enumerable: false, configurable: false });
    this.#s = state;
    if (clockState !== null) {
      state.simulated = clockState;
      clockState.hosts.push(new WeakRef(this));
    }
    if (restore !== null) { // on from the snapshot's time
      module.setWord64(0, made.time);
      module.call('ta_web_host_clock_resume', state.pointer);
    }
    state.advance(); // the host's clock starts now, not at 0
  }

  // Host.restore(snapshot, config, options) -> Host: a new Host running the
  // snapshot, made by the constructor with `config` and `options`.
  static restore(snapshot, config, options) {
    bytesOf(snapshot, 'restore takes the snapshot\'s bytes first: a Uint8Array or an ArrayBuffer');
    if (typeof this !== 'function') throw new TypeError('restore is called on Host: Host.restore(snapshot, config, options)');
    const outer = restoring;
    restoring = { snapshot };
    try {
      return new this(config, options);
    } finally {
      restoring = outer;
    }
  }

  get closed() { return !checked(this, false).open; }
  get ticksPerSecond() { return checked(this, false).ticksPerSecond; }
  // the quickjs engine's heap in bytes (O(1)); undefined on a native host
  // and on a closed one
  get quickjsHeapBytes() {
    const state = checked(this, false);
    return state.quickjs !== null && state.open ? state.quickjs.heapBytes() : undefined;
  }

  get nextDeadline() {
    const state = checked(this, false);
    if (!state.open) return undefined;
    const delay = state.fn.ta_web_host_delay(state.pointer);
    return delay < 0 ? undefined : delay;
  }

  now() {
    const state = checked(this, true);
    return state.fn.ta_web_host_now(state.pointer);
  }

  // The promise of the next idle turn, the same to every caller until it
  // settles; it schedules a turn when none is pending.
  idle() {
    const state = checked(this, false);
    if (!state.open) return Promise.reject(refusal('TA_ERROR_STATE', 'the Host is closed'));
    if (state.idle !== null) return state.idle.promise;
    const idle = {};
    idle.promise = new Promise((resolve, reject) => {
      idle.resolve = resolve;
      idle.reject = reject;
    });
    state.idle = idle;
    if (state.immediate === null) state.schedule(); // a turn inside this one settles it at its end
    return idle.promise;
  }

  close() {
    const state = checked(this, false);
    closeSelf(state);
    state.endings = null;
  }

  [Symbol.dispose]() { this.close(); }

  [Symbol.asyncDispose]() {
    let state;
    try {
      state = checked(this, false);
      closeSelf(state);
    } catch (error) {
      return Promise.reject(error);
    }
    const endings = state.endings;
    state.endings = null;
    if (endings !== null && endings.length > 0) return Promise.all(endings).then(() => undefined);
    return Promise.resolve(undefined);
  }

  // ---- images and charts ----

  addImage(image) {
    const state = checked(this, true);
    return state.call(() => {
      const bytes = bytesOf(image, 'addImage takes the image\'s bytes: a Uint8Array or an ArrayBuffer');
      const module = state.module;
      const [at, length] = module.copyIn(state.scratch, bytes);
      module.setWord(0, at);
      module.setWord(1, length);
      const status = state.fn.ta_web_host_add_image(state.pointer);
      const why = state.native?.attachError;
      if (state.native !== null) state.native.attachError = null;
      if (status === TA_ERROR_UNSUPPORTED && why == null) {
        throw refusal('TA_ERROR_UNSUPPORTED', 'the image was refused: a chart\'s datamodel is not in this host');
      }
      if (status !== TA_OK) throw refusal(module.statusName(status), why == null ? 'the image was refused' : `the image was refused: ${why}`);
      return module.word(1);
    });
  }

  chart(name) {
    const state = checked(this, true);
    return state.call(() => {
      const module = state.module;
      const [at, length] = module.text(state.scratch, textOf(name, 'chart takes the chart\'s name, a string'));
      module.setWord(0, at);
      module.setWord(1, length);
      const status = state.fn.ta_web_host_chart(state.pointer);
      if (status !== TA_OK) throw refusal(module.statusName(status), 'the host has no chart of that name');
      return Object.freeze({ segment: module.word(1), chart: module.word(2) });
    });
  }

  boot(segment) {
    const state = checked(this, true);
    return state.call(() => {
      const index = countOf(segment, 'boot takes a segment, the number addImage returned');
      state.advance();
      const status = state.fn.ta_web_host_boot(state.pointer, index);
      if (status !== TA_OK) throw refusal(state.module.statusName(status), 'the segment\'s boot was refused');
      state.schedule();
    });
  }

  actorByName(name) {
    const state = checked(this, true);
    return state.call(() => {
      const module = state.module;
      const [at, length] = module.text(state.scratch, textOf(name, 'actorByName takes the actor\'s name, a string'));
      module.setWord(0, at);
      module.setWord(1, length);
      state.fn.ta_web_host_actor_by_name(state.pointer);
      const session = module.word64(0);
      return session === 0n ? undefined : session;
    });
  }

  // ---- actors ----

  spawn(ref, options) {
    const state = checked(this, true);
    return state.call(() => {
      const module = state.module, scratch = state.scratch;
      inputOptions(options, ['name', 'params', 'traceparent'], 'spawn option');
      const usage = 'spawn takes a chart reference, {segment, chart}, from host.chart';
      if (ref === null || typeof ref !== 'object') throw new TypeError(usage);
      const segment = countOf(ref.segment, usage), chart = countOf(ref.chart, usage);
      const name = module.text(scratch, optionalText(options?.name, 'spawn\'s name is a string'));
      const traceparent = module.text(scratch, optionalText(options?.traceparent, 'a traceparent is W3C text, a string'));
      const params = state.payload(options?.params, { segment, chart }); // moved to core on success
      state.advance();
      const w = module.words(), r = module.record;
      w[r] = segment;
      w[r + 1] = chart;
      w[r + 2] = name[0]; w[r + 3] = name[1];
      w[r + 4] = Number(params & 0xFFFFFFFFn); w[r + 5] = Number(params >> 32n);
      w[r + 6] = traceparent[0]; w[r + 7] = traceparent[1];
      const status = state.fn.ta_web_host_spawn(state.pointer);
      if (status !== TA_OK) throw refusal(module.statusName(status), 'the spawn was refused');
      state.schedule();
      return module.word64(1);
    });
  }

  // send(target, event, data?, options?) or send(message): its length is 4
  send(target, event, data, options) { // eslint-disable-line no-unused-vars
    const args = [...arguments];
    const state = checked(this, true);
    return state.call(() => {
      let message;
      if (args.length === 1 && args[0] !== null && typeof args[0] === 'object') message = messageOf(args[0]);
      else {
        const options = inputOptions(args[3], ['sendid', 'traceparent', 'origin'], 'send option');
        message = { target: args[0], event: args[1], data: args[2], sendid: options?.sendid, origin: options?.origin, traceparent: options?.traceparent };
      }
      const event = eventOf(state, message);
      eventWords(state.module.words(), state.module.record, event);
      const status = state.fn.ta_web_host_send(state.pointer);
      if (status !== TA_OK) throw refusal(state.module.statusName(status), 'the send was refused');
      state.schedule();
    });
  }

  fail(target, sendid) {
    const state = checked(this, true);
    return state.call(() => {
      const event = eventOf(state, { target, sendid, name: null });
      event.flags = EVENT_ERROR_COMMUNICATION;
      eventWords(state.module.words(), state.module.record, event);
      const status = state.fn.ta_web_host_send(state.pointer);
      if (status !== TA_OK) throw refusal(state.module.statusName(status), 'the failure was refused');
      state.schedule();
    });
  }

  sendMany(items) {
    const state = checked(this, true);
    return state.call(() => {
      if (!Array.isArray(items)) throw new TypeError('sendMany takes an array of messages');
      const module = state.module;
      let accepted = 0;
      try {
        for (let first = 0; first < items.length; first += SLICE) {
          const count = Math.min(SLICE, items.length - first);
          const taken = module.scoped(state.scratch, () => {
            const room = module.room(state.scratch, 4 * EVENT_WORDS * count) >>> 2;
            const payloads = [];
            try {
              for (let i = 0; i < count; i++) {
                const event = eventOf(state, messageOf(items[first + i]));
                if (event.data !== undefined && event.data !== 0n) payloads.push(event.data);
                eventWords(module.words(), room + i * EVENT_WORDS, event);
              }
            } catch (error) {
              for (const payload of payloads) state.release(payload); // still ours
              throw error;
            }
            module.setWord(0, room << 2);
            module.setWord(1, count);
            return state.fn.ta_web_host_send_many(state.pointer);
          });
          accepted += taken;
          if (taken !== count) break; // refused at an event: the rest is not sent
        }
      } finally {
        if (accepted) state.schedule();
      }
      return accepted;
    });
  }

  terminate(session) {
    const state = checked(this, true);
    return state.call(() => {
      const id = sessionOf(session);
      const status = state.fn.ta_web_host_terminate(state.pointer, Number(id & 0xFFFFFFFFn), Number(id >> 32n));
      if (status !== TA_OK) throw refusal(state.module.statusName(status), 'the terminate was refused');
      state.schedule();
    });
  }

  // ---- outputs ----

  metrics() {
    const state = checked(this, true);
    return state.call(() => {
      state.taken = null;
      const status = state.fn.ta_web_host_metrics(state.pointer);
      if (status !== TA_OK) throw refusal(state.module.statusName(status), 'metrics were refused (TA_ERROR_STATE: the config has no telemetry)');
      const taken = state.taken;
      state.taken = null;
      return taken;
    });
  }

  // ---- hibernation ----

  sweep(maxScan, limit) {
    const state = checked(this, true);
    return state.call(() => {
      const scan = countOf(maxScan, 'sweep\'s maxScan is an integer from 0 to 2^32-1');
      const most = countOf(limit, 'sweep\'s limit is an integer from 0 to 2^32-1');
      const module = state.module;
      const room = Math.min(scan, most); // it answers at most one session a slot scanned
      const at = room ? module.room(state.scratch, 8 * room) : 0;
      module.words().set([scan, at, room], module.record);
      const found = state.fn.ta_web_host_sweep(state.pointer);
      const words = module.words(), base = at >>> 2;
      const sessions = new Array(found);
      for (let i = 0; i < found; i++) sessions[i] = BigInt(words[base + 2 * i]) | (BigInt(words[base + 2 * i + 1]) << 32n);
      return sessions;
    });
  }

  hibernate(session) {
    const state = checked(this, true);
    return state.call(() => {
      const id = sessionOf(session);
      state.taken = null;
      const status = state.fn.ta_web_host_hibernate(state.pointer, Number(id & 0xFFFFFFFFn), Number(id >> 32n));
      if (status !== TA_OK) {
        let message = status === -6
          ? 'the actor is not at a stable point now (events waiting, in a macrostep, an invoked child), or not resident'
          : 'the hibernation was refused';
        const reason = state.quickjs !== null ? state.quickjs.reason() : state.reason;
        if (status === TA_ERROR_UNSUPPORTED && reason) message = reason;
        throw refusal(state.module.statusName(status), message);
      }
      const taken = state.taken;
      state.taken = null;
      return taken;
    });
  }

  wake(session, blob) {
    const state = checked(this, true);
    return state.call(() => {
      const id = sessionOf(session);
      const bytes = bytesOf(blob, 'wake takes the blob hibernate gave: a Uint8Array or an ArrayBuffer');
      const module = state.module;
      const [at, length] = module.copyIn(state.scratch, bytes);
      module.setWord64(0, id);
      module.setWord(2, at);
      module.setWord(3, length);
      const status = state.fn.ta_web_host_wake(state.pointer);
      if (status !== TA_OK) {
        throw refusal(module.statusName(status), 'the wake was refused (TA_ERROR_STATE: the session is not hibernated; TA_ERROR_INVALID: not its blob; TA_ERROR_STALE: not its latest blob)');
      }
      state.schedule(); // its mailbox runs at the next turn
    });
  }

  // ---- migration ----

  migrate(options) {
    const state = checked(this, true);
    return state.call(() => {
      const module = state.module;
      let name = [0, 0], session = 0n, flags = 0, timeout = 0n;
      if (options !== undefined) {
        if (options === null || typeof options !== 'object') throw new TypeError('migrate takes an object of chart, session, wake, timeout, or nothing');
        onlyKnown(options, ['chart', 'session', 'wake', 'timeout'], 'migrate option');
        const { chart, session: given, wake, timeout: ms } = options;
        if (chart !== undefined) {
          textOf(chart, 'migrate\'s chart is a chart\'s name, a string');
          if (chart.length === 0) throw new RangeError('migrate\'s chart is a chart\'s name; leave it out for every chart');
          name = module.text(state.scratch, chart);
        }
        if (given !== undefined) session = sessionOf(given);
        if (wake !== undefined) {
          if (typeof wake !== 'boolean') throw new TypeError('migrate\'s wake is a boolean');
          flags = wake ? MIGRATE_WAKE : 0;
        }
        if (ms !== undefined) {
          if (typeof ms !== 'number') throw new TypeError('migrate\'s timeout is a number of milliseconds');
          const ns = ms * 1e6 + 0.5;
          if (!(ms >= 0) || !(ns < 18446744073709551616)) {
            throw new RangeError('migrate\'s timeout is milliseconds, not negative, below 2^64 nanoseconds');
          }
          timeout = ticksAfter(state, BigInt(Math.trunc(ns)));
        }
      }
      state.advance(); // the timeout counts from the host's clock now
      const w = module.words(), r = module.record;
      w[r] = name[0]; w[r + 1] = name[1];
      w[r + 2] = Number(session & 0xFFFFFFFFn); w[r + 3] = Number(session >> 32n);
      w[r + 4] = flags;
      w[r + 5] = Number(timeout & 0xFFFFFFFFn); w[r + 6] = Number(timeout >> 32n);
      const status = state.fn.ta_web_host_migrate(state.pointer);
      if (status !== TA_OK) throw refusal(module.statusName(status), 'the migration was refused');
      state.schedule(); // the migration moves actors in the next runs
      return module.word(1);
    });
  }

  // ---- snapshots ----

  snapshot() {
    const state = checked(this, true);
    return state.call(() => {
      const module = state.module;
      const ready = state.fn.ta_web_host_quiescent(state.pointer);
      if (ready !== TA_OK) {
        throw refusal(module.statusName(ready), 'a snapshot needs a quiescent host (TA_ERROR_STATE: from a handler, with an effect or a reply pending, or during a migration)');
      }
      state.advance(); // the snapshot's time is now, not the last turn's
      const [stateAt, stateLength] = cbor.write(module, state.scratch, { [state.datamodelName]: (state.quickjs ?? state.native).snapshot() });
      const [labelAt, labelLength] = module.text(state.scratch, LABEL);
      module.words().set([labelAt, labelLength, stateAt, stateLength], module.record);
      state.taken = null;
      const status = state.fn.ta_web_host_snapshot(state.pointer);
      if (status !== TA_OK) throw refusal(module.statusName(status), 'the snapshot was refused');
      const taken = state.taken;
      state.taken = null;
      return taken;
    });
  }
}

// Nanoseconds as ticks at the host's rate, rounded up.
function ticksAfter(state, ns) {
  const rate = BigInt(state.ticksPerSecond), billion = 1000000000n;
  const ticks = (ns / billion) * rate + ((ns % billion) * rate) / billion;
  const back = (ticks / rate) * billion + ((ticks % rate) * billion) / rate;
  return back < ns ? ticks + 1n : ticks;
}

// close()'s work: from a handler (a call or a turn on the stack) it is done
// when the outermost one returns; a kept error of the last take is thrown
// once the host is freed.
function closeSelf(state) {
  state.endings = null;
  if (!state.open) return;
  if (state.depth > 0 || state.turning) state.closing = true;
  else state.closeNow();
  if (!state.open) {
    const kept = state.takeKept();
    if (kept !== null) throw kept[0];
  }
}

// A message, the object send.message gives: its known keys, the others
// ignored, so a newer sender's keys do not break an older host.
function messageOf(value) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('a message is an object of target, event, data, sendid, origin, traceparent');
  }
  const { target, event, data, sendid, origin, traceparent } = value;
  if (target === undefined || event === undefined) throw new TypeError('a message has a target and an event');
  return { target, event, data, sendid, origin, traceparent };
}

// An event of send, sendMany and fail as words for core (texts in the
// host's arena, the data a payload of the target session's datamodel, made
// last, so nothing needs releasing when an earlier field is refused).
function eventOf(state, message) {
  const module = state.module, scratch = state.scratch;
  const session = targetOf(state, message.target);
  const event = { session };
  if (message.name !== null) event.name = module.text(scratch, textOf(message.event, 'an event\'s name is a string'));
  event.sendid = module.text(scratch, optionalText(message.sendid, 'a sendid is a string'));
  event.origin = module.text(scratch, optionalText(addressText(message.origin), 'an origin is an address, a string or an Address'));
  event.traceparent = module.text(scratch, optionalText(message.traceparent, 'a traceparent is W3C text, a string'));
  event.data = state.payload(message.data, { session });
  return event;
}

// An event's target: a session, or a local address core resolves.
function targetOf(state, target) {
  const value = isAddress(target) ? target.text : target;
  if (typeof value !== 'string') {
    if (typeof value === 'bigint' || typeof value === 'number') return sessionOf(value);
    throw new TypeError('a target is a session (a bigint or a safe integer) or a local address (a string or an Address)');
  }
  const module = state.module;
  const [at, length] = module.text(state.scratch, value);
  module.setWord(0, at);
  module.setWord(1, length);
  const status = state.fn.ta_web_host_resolve(state.pointer);
  if (status !== TA_OK) throw refusal(module.statusName(status), 'the address names no local session');
  return module.word64(1);
}

// ---- typed methods (methods.c) ------------------------------------------------------------------

const METHODS = [
  ['actorState', 'actor.state'], ['actorContext', 'actor.context'], ['actorList', 'actor.list'],
  ['actorGet', 'actor.get'], ['hostStats', 'host.stats'], ['hostConfig', 'host.config'],
  ['traceConfigure', 'trace.configure'], ['traceWatch', 'trace.watch'], ['traceUnwatch', 'trace.unwatch'],
  ['traceEnd', 'trace.end'], ['traceSpansDecode', 'trace.spans.decode'],
];

for (const [js, core] of METHODS) {
  const method = {
    [js](params, onResult, onError) {
      const state = checked(this, true);
      return state.call(() => {
        const failed = onError === null ? undefined : onError;
        if (typeof onResult !== 'function' || (typeof failed !== 'function' && failed !== undefined)) {
          throw new TypeError('a typed method takes (params, onResult(host, result), onError?(host, error))');
        }
        const handlers = state.handlers();
        if (handlers === undefined) throw refusal('TA_ERROR_STATE', 'the Host\'s handlers are gone');
        handlers.pending ??= [];
        const module = state.module;
        const slot = state.fn.ta_web_pending_add(state.pointer);
        if (slot === 0) throw refusal('TA_ERROR_NO_MEMORY', 'no memory for a pending method');
        const id = module.word64(0);
        const at = 2 * (slot - 1);
        // actor.get's timers[].due: the host's ticks as milliseconds on now()'s clock
        handlers.pending[at] = core === 'actor.get' ? (host, result) => onResult(host, state.timesInMilliseconds(result)) : onResult;
        handlers.pending[at + 1] = failed;
        let posted = false;
        try {
          state.advance(); // trace.watch's end is a time of the host's clock
          const message = params === undefined ? { method: core, id } : { method: core, params, id };
          const [bytesAt, length] = cbor.write(module, state.scratch, message);
          module.words().set([bytesAt, length, Number(id & 0xFFFFFFFFn), Number(id >> 32n)], module.record);
          const status = state.fn.ta_web_host_post(state.pointer);
          if (status !== TA_OK) {
            posted = true; // the row went with the refusal
            throw refusal(module.statusName(status), 'the method\'s post was refused');
          }
          posted = true;
        } catch (error) {
          handlers.pending[at] = undefined;
          handlers.pending[at + 1] = undefined;
          if (!posted && state.open) state.fn.ta_web_pending_remove(state.pointer, Number(id & 0xFFFFFFFFn), Number(id >> 32n));
          throw error;
        }
        state.schedule();
      });
    },
  }[js];
  Object.defineProperty(Host.prototype, js, { value: method, writable: true, configurable: true, enumerable: false });
}

export { TinyactorsError };
