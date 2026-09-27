'use strict';

// System facade over the native System (ADR 0012) and the generated core
// module (ADR 0013). Scheduling is native (ADR 0007): nothing here takes part
// in it; spawn() and destroy() only reach core, whose hooks tell the pump.

const v8 = require('node:v8');

const native = require('./native');
const { TinyactorsError } = require('./errors');
const { Definition, identityOf } = require('./definition');
const { DefinitionBuilder } = require('./statechart');
const { ActorID } = require('./actor');
const { EventNames } = require('./events');
const { SessionImage, handleOf } = require('./image');
const { traceConfig, TRACE_KINDS } = require('./tracing');
const { buildSnapshot } = require('./metrics');

const NO_STATE = 4294967295;

const { core } = native;

// Compiles a spec in the generated shape. A refused chart throws with core's
// compile error formatted into the message (ADR 0058), and the error itself,
// with a readable path, as `detail`.
/* Core's TA_MICROSTEP_LIMIT_NONE: this definition has no limit (ADR 0075). */
const MICROSTEP_LIMIT_NONE = 0xffffffff;

/* `options.microstepLimit`: undefined, or a count from 0 (none) up. */
function microstepLimitOption(options, where) {
  if (options === null || typeof options !== 'object') {
    throw new TinyactorsError(`${where}: options must be an object`, 'invalid');
  }
  const limit = options.microstepLimit;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0 && limit < MICROSTEP_LIMIT_NONE)) {
    throw new TinyactorsError(`${where}: microstepLimit must be a whole number from 0 (none)`, 'invalid');
  }
  return limit;
}

function compile(system, spec) {
  try {
    return core.definition_compile_spec(system, spec);
  } catch (error) {
    const refusal = error instanceof TinyactorsError ? error.detail?.error : undefined;
    if (refusal === undefined) {
      throw error;
    }
    let text;
    try {
      text = core.compile_error_format(spec, refusal);
    } catch {
      text = `${refusal.code}: ${refusal.message}`;
    }
    throw new TinyactorsError(`chart refused: ${text}`, error.code, {
      error: refusal,
      code: refusal.code,
      path: pathText(refusal.path),
    });
  }
}

// What a registered compiler returned, in the shape the built-in data model
// runs (ADR 0019): a function for a value, a condition or a script, and a
// { get, set } location for a location. A data name as a location reads and
// assigns that name, and assigning a name the data does not have fails as
// the built-in model's own data names do.
function normalizeCompiled(made, role) {
  if (role !== 'location') {
    if (typeof made !== 'function') {
      throw new TypeError(`compile() must return a function for a ${role}`);
    }
    return made;
  }
  if (typeof made === 'string') {
    const name = made;
    return {
      get() { return this[name]; },
      set(value) {
        if (!Object.hasOwn(this, name)) {
          throw new TypeError(`assignment to an undeclared data name: ${name}`);
        }
        this[name] = value;
      },
    };
  }
  if (made === null || typeof made !== 'object' || typeof made.get !== 'function' || typeof made.set !== 'function') {
    throw new TypeError('compile() must return a data name or { get, set } for a location');
  }
  return made;
}

// `states[0].transitions[1].condition`, from core's path elements.
function pathText(path) {
  const noIndex = 4294967295;
  return (path ?? [])
    .map(({ member, index }, at) => `${at === 0 ? '' : '.'}${member}${index === noIndex ? '' : `[${index}]`}`)
    .join('');
}

// The native System behind a public one, for other lib/ modules and tests.
// index.js does not export it.
let nativeOf;
// handler(system, kind, payload): the pump hands every service effect to it
// (src/napi_services.h). It is one function for the environment, so no
// native reference keeps a System alive.
let effectHandler;
// observe(system, { traces, log, runaway, defined, deadLetter, dropped }):
// what lib/debug.js reads beside the application (ADR 0026).
// `traces(traces, logs)` gets every turn's OTLP bytes the application's
// trace sink gets, installing a sink of its own when the application has
// none; `log(record)` every <log> record; `runaway(actor)` each actor
// quarantined as a runaway (core ADR 0075); `defined(id)` each definition
// define() registered, a new one or one answered by identity (core ADR
// 0077), whose spans may have moved (core ADR 0085); `deadLetter(record)`
// every dead letter, as the application's deadLetter hook gets it, just
// before it does; `dropped({ source, sendID, event, type, target, error })`
// each <send> an I/O processor failed, as its sender gets
// error.communication for it. Observers never change what the application
// hears. Returns { stop() }. index.js does not export it.
let observe;

// The SCXML invoker type core normalizes "scxml" and its URI to (core
// ADR 0016); the in-system SCXML invoker is registered under it.
const SCXML_INVOKER = 'http://www.w3.org/TR/scxml/';
const SCXML_ALIASES = new Set(['scxml', 'http://www.w3.org/TR/scxml', SCXML_INVOKER]);

// Systems created in this process, to tell their metric streams apart.
let systemCount = 0;

// core's counters are uint64 (bigints across the binding); as numbers.
function numbers(counters) {
  const out = {};
  for (const [key, value] of Object.entries(counters)) {
    out[key] = Number(value);
  }
  return out;
}

class System {
  #native;
  #events;
  // Definition ID -> true when it runs the JavaScript data model; read from
  // core once per definition.
  #javascript = new Map();

  // Services (ROADMAP step 13): I/O processors by type, invokers by type,
  // live JavaScript invocations by service handle, and the log sink.
  #io = new Map();
  #invokers = new Map();
  #invocations = new Map();
  #logSink;
  #traceSink;
  #traceConfig = {};
  // observe() observers, and whether the native sink is installed for them
  // alone (the application has none).
  #observers = new Set();
  #observerSink = false;
  // Active watchTraces() handles, and every definition's identity, for the
  // watches and for metrics().
  #watches = new Set();
  // Loaders by family (napi ADR 0020), and why the last load of an address
  // failed, for the deadLetter hook's `detail`.
  #loaders = new Map();
  #loadDetails = new Map();
  // Families whose actors unload() offloaded, with no loader of their own.
  #offloadFamilies = new Set();
  #startTime = Date.now();
  #metricsName = String((systemCount += 1));
  // Aborted on close(): the signal every EffectContext carries.
  #lifetime = new AbortController();
  #effectContext;

  static {
    nativeOf = (system) => system.#native;
    effectHandler = (system, kind, payload) => system.#effect(kind, payload);
    observe = (system, observer) => system.#observe(observer);
  }

  /**
   * Options:
   * - scheduling: { resumeBudget, actionBudget, resumesPerTurn } (ADR 0007);
   * - finished: "destroy" (the default) or "retain" (ADR 0012);
   * - scheduling.messageBudget: deliveries per turn, and dead letters
   *   reported per turn; scheduling.maxQueuedMessages: post() throws
   *   `queue-full` beyond it (ADR 0005);
   * - done({ actor, finalState, data }), fault({ actor, operation, code,
   *   message }) and deadLetter({ target, event, reason, detail?, data?,
   *   traceparent? }): hooks the pump calls at the end of a turn (ADRs
   *   0008, 0012). `detail` says why a load failed, for mail that waited
   *   for a loader (napi ADR 0020); `data` and `traceparent` are what
   *   posting the message again needs, absent when it had none.
   */
  constructor(options) {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw new TinyactorsError('createSystem options must be an object', 'invalid');
    }
    // The native hook is always this system's, so observers hear dead
    // letters too; the application's hook, when it has one, gets each as
    // before. Anything else the application passed is the native side's to
    // refuse. The native side holds its hooks strongly, so the hook reaches
    // this system through a WeakRef: a system the application drops without
    // close() is still finalized, as with the environment-wide effect handler.
    const deadLetter = options?.deadLetter;
    const self = new WeakRef(this);
    const nativeOptions = deadLetter !== undefined && typeof deadLetter !== 'function' ? options
      : { ...options, deadLetter: (letter) => self.deref()?.#deadLetter(letter, deadLetter) };
    this.#native = new native.System(this, nativeOptions);
    this.#events = new EventNames(this.#native);
    const unloadValues = options?.unloadValues ?? 'serialize';
    if (unloadValues !== 'serialize' && unloadValues !== 'handles') {
      throw new TinyactorsError('createSystem(): unloadValues must be "serialize" or "handles"', 'invalid');
    }
    this.#native.setOffloadValues(v8.serialize, v8.deserialize, unloadValues === 'handles');
    const { io, invokers, log } = options ?? {};
    for (const [type, processor] of Object.entries(servicesOf(io, 'createSystem(): io'))) {
      this.registerIO(type, processor, { location: processor?.location, origin: processor?.origin });
    }
    for (const [type, invoker] of Object.entries(servicesOf(invokers, 'createSystem(): invokers'))) {
      this.registerInvoker(type, invoker);
    }
    if (log !== undefined) {
      this.setLogSink(log);
    }
  }

  /**
   * Make `processor` the I/O processor for `<send type>` (core ADRs 0015,
   * 0046). Core calls it while an actor runs, so the call is queued and
   * processor.send(request, context) runs at the end of that pump turn,
   * never inside core (ADR 0001 rule 3). `request` is { source, sendID,
   * event, type, target, data } (and { content, contentType } for a literal
   * <content>); `context` is { system, signal, post }, where `signal` aborts
   * on close(). A reply is an event the processor posts, now or later. A
   * processor that throws or whose promise rejects has failed the send: the
   * sender gets an external `error.communication` event whose data is
   * { sendID, type, error }.
   *
   * `options` says how core renders the processor's text without running
   * JavaScript (core ADR 0068):
   * - `location`: this session's address through the processor, listed in
   *   `_ioprocessors` (`context.ioProcessors`). `{session}` is the session
   *   ID, `{family}` and `{name}` its named address.
   * - `origin`: the URI of a computed origin (post with `origin: { type,
   *   token }`); `{token}` is the token.
   * A processor posts events with an origin so a chart can answer them
   * with `send(...).via(({ event }) => event.originType).to(({ event }) => event.origin)`: see post().
   */
  registerIO(type, processor, options = {}) {
    if (typeof type !== 'string' || type === '') {
      throw new TinyactorsError('registerIO(): expected a type string', 'invalid');
    }
    if (processor === null || typeof processor !== 'object' || typeof processor.send !== 'function') {
      throw new TinyactorsError('registerIO(): expected an I/O processor with a send(request, context) method', 'invalid');
    }
    const { location, origin } = options ?? {};
    for (const [name, value] of [['location', location], ['origin', origin]]) {
      if (value !== undefined && typeof value !== 'string') {
        throw new TinyactorsError(`registerIO(): options.${name} must be a string template`, 'invalid');
      }
    }
    this.#native.registerIO(type, location, origin);
    this.#io.set(type, processor);
  }

  /**
   * Open a scope for a connection or a session of processor `type`, storing
   * `uri` once (core ADR 0068). Events posted with `origin: { type, scope }`
   * name it; after closeScope() their origin is empty, so a late reply
   * reaches the processor with no target.
   */
  openScope(type, uri) {
    if (typeof uri !== 'string' || uri === '') {
      throw new TinyactorsError('openScope(): expected a URI string', 'invalid');
    }
    const { index, generation } = this.#native.openScope(type, uri);
    return Object.freeze({ type, uri, index, generation });
  }

  /** Close a scope from openScope(). Closing it again does nothing. */
  closeScope(scope) {
    if (scope === null || typeof scope !== 'object') {
      throw new TinyactorsError('closeScope(): expected a scope from openScope()', 'invalid');
    }
    this.#native.closeScope(scope.index, scope.generation);
  }

  /**
   * Make `invoker` the invoker for `<invoke type>` (core ADR 0016). Core
   * starts, cancels and forwards to invocations while an actor runs, so each
   * call is queued and runs at the end of that pump turn:
   * invoker.start(request, reporter) returns the service, whose cancel() runs
   * when the invoking state exits and whose optional forward(event) gets
   * autoforwarded events. The reporter's event(name, data) and done(data)
   * reach the parent as external events (done is done.invoke.<id>); its
   * unavailable(error) retires the invocation, and the parent gets
   * error.communication. Its signal aborts on cancel, done, unavailable and
   * close(). "scxml" names the in-system SCXML invoker's type; registering
   * it replaces that invoker.
   */
  registerInvoker(type, invoker) {
    if (typeof type !== 'string' || type === '') {
      throw new TinyactorsError('registerInvoker(): expected a type string', 'invalid');
    }
    if (invoker === null || typeof invoker !== 'object' || typeof invoker.start !== 'function') {
      throw new TinyactorsError('registerInvoker(): expected an invoker with a start(request, reporter) method', 'invalid');
    }
    const canonical = SCXML_ALIASES.has(type) ? SCXML_INVOKER : type;
    this.#native.registerInvoker(canonical);
    this.#invokers.set(canonical, invoker);
  }

  /**
   * Send `<log>` records to `sink` ({ source, label, hasValue, value }), at
   * the end of the pump turn that ran them (core ADR 0045). Without a sink a
   * <log> only evaluates its expression.
   */
  setLogSink(sink) {
    if (sink !== undefined && typeof sink !== 'function') {
      throw new TinyactorsError('setLogSink(): expected a function or undefined', 'invalid');
    }
    this.#logSink = sink;
    this.#native.setLogSink(sink !== undefined || this.#observing('log'));
  }

  /**
   * Hand traces and logs to `sink(traces, logs)` as OTLP protobuf (napi
   * ADRs 0016 and 0017): once per pump turn, `traces` is one Uint8Array
   * holding one ExportTraceServiceRequest with the spans that ended in that
   * turn (empty when none ended), and `logs` one ExportLogsServiceRequest
   * with the turn's log records, or undefined. Post them to an OTLP/HTTP
   * endpoint's `/v1/traces` and `/v1/logs` as they are (Content-Type:
   * application/x-protobuf), or decode traces with decodeTraces(). Logs are
   * failures (an action that failed, an error.* raised, a run stopped for
   * lack of memory) and <log>, written whatever the sampling, at most
   * `logLimit` (default 20) per definition and name per second; the next
   * log that passes carries `tinyactors.suppressed`. `logs: false` writes
   * none. Without a sink (undefined) core builds no record.
   *
   * options:
   * - detail: "summary" (default: a span per macrostep, lifecycle, and
   *   failures), "decisions" (adds microsteps, conditions, raised events)
   *   or "full" (every kind); see TRACE_DETAIL. Watched actors
   *   (watchTraces) always get every kind;
   * - kinds: the record kinds wanted (TRACE_KINDS names), overriding
   *   `detail`: core builds no other record;
   * - sample: the ratio of the traces this system starts that are sampled,
   *   0 to 1 (default 1), decided as OpenTelemetry's TraceIDRatioBased
   *   does (core ADR 0073); a traceparent keeps its caller's decision;
   * - unsampled: also trace macrosteps whose traceparent is not sampled;
   * - resource: resource attributes, { "service.name": "orders", ... },
   *   strings only;
   * - values: put event data and assigned values in attributes, as JSON
   *   cut at `valueLimit` characters (default 256, at most 1023). Off by
   *   default: values may hold personal data;
   * - parent: "cause" (default) parents a macrostep under the step that
   *   caused it; "link" makes it a root and links it to its cause;
   * - seed: a bigint; trace IDs the system starts (for deliveries and
   *   spawns without a traceparent) become a fixed sequence, for tests.
   *
   * Replacing or removing a sink ends the spans still open, marked
   * `scxml.incomplete`, and hands them to the previous sink first.
   */
  setTraceSink(sink, options = {}) {
    if (sink !== undefined && typeof sink !== 'function') {
      throw new TinyactorsError('setTraceSink(): expected a function or undefined', 'invalid');
    }
    const { unsampled = false, resource = {}, values = false, valueLimit = 256, parent = 'cause', seed,
            logs = true, logLimit = 20 } = options ?? {};
    if (!Number.isInteger(logLimit) || logLimit < 1 || logLimit > 1e6) {
      throw new TinyactorsError('setTraceSink(): options.logLimit must be an integer from 1 to 1000000', 'invalid');
    }
    const config = traceConfig(options ?? {}, 'setTraceSink()');
    if (parent !== 'cause' && parent !== 'link') {
      throw new TinyactorsError('setTraceSink(): options.parent must be "cause" or "link"', 'invalid');
    }
    if (!Number.isInteger(valueLimit) || valueLimit < 0 || valueLimit > 1023) {
      throw new TinyactorsError('setTraceSink(): options.valueLimit must be an integer from 0 to 1023', 'invalid');
    }
    if (resource === null || typeof resource !== 'object') {
      throw new TinyactorsError('setTraceSink(): options.resource must be an object of strings', 'invalid');
    }
    const pairs = [];
    for (const [key, value] of Object.entries(resource)) {
      if (typeof value !== 'string') {
        throw new TinyactorsError(`setTraceSink(): resource attribute "${key}" must be a string`, 'invalid');
      }
      pairs.push(key, value);
    }
    const previous = this.#traceSink;
    const observed = sink === undefined && this.#observing('traces');
    const remaining = observed
      ? this.#installObserverSink()
      : this.#native.setTraceSink(sink !== undefined, config.kinds, config.watchedKinds,
                                  unsampled === true ? config.kinds : 0, config.sample,
                                  values === true, valueLimit, parent === 'link', pairs, seed,
                                  logs === false ? 0 : logLimit);
    this.#traceSink = sink;
    this.#observerSink = observed;
    this.#traceConfig = { detail: options?.detail, kinds: options?.kinds, sample: options?.sample,
                          unsampled: unsampled === true };
    if (remaining !== undefined) {
      previous?.(remaining.traces, remaining.logs);
      this.#notify('traces', remaining.traces, remaining.logs);
    }
  }

  // The native sink observers get when the application has none: nothing
  // but what is watched, every kind of it, with values (ADR 0026).
  #installObserverSink() {
    const all = 2 ** TRACE_KINDS.length - 1;
    return this.#native.setTraceSink(true, 0, all, 0, 0, true, 256, false, [], undefined, 0);
  }

  #observing(what) {
    for (const observer of this.#observers) {
      if (typeof observer[what] === 'function') return true;
    }
    return false;
  }

  // Calls `what` of every observer that has it.
  #notify(what, ...args) {
    for (const observer of this.#observers) {
      observer[what]?.(...args);
    }
  }

  #observe(observer) {
    this.#observers.add(observer);
    this.#applyObservers();
    return Object.freeze({
      stop: () => {
        if (this.#observers.delete(observer) && !this.closed) {
          this.#applyObservers();
        }
      },
    });
  }

  // Installs or removes the observers' own trace sink, and turns <log>
  // records on or off, as the observers and the application need them.
  #applyObservers() {
    this.#native.setLogSink(this.#logSink !== undefined || this.#observing('log'));
    if (this.#traceSink !== undefined) {
      return;
    }
    const wanted = this.#observing('traces');
    if (wanted === this.#observerSink) {
      return;
    }
    const all = 2 ** TRACE_KINDS.length - 1;
    const remaining = wanted
      ? this.#installObserverSink()
      : this.#native.setTraceSink(false, 0, all, 0, 0, false, 256, false, [], undefined, 0);
    this.#observerSink = wanted;
    if (remaining !== undefined) {
      this.#notify('traces', remaining.traces, remaining.logs);
    }
  }

  /**
   * Changes what the installed sink gets, without reinstalling it, so open
   * spans are not ended (napi ADR 0017 section 3). `options` takes
   * `detail`, `kinds` and `sample` as setTraceSink() does; what it leaves
   * out keeps its current value.
   */
  configureTraces(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TinyactorsError('configureTraces(): expected an options object', 'invalid');
    }
    const merged = { ...this.#traceConfig };
    for (const key of ['detail', 'kinds', 'sample']) {
      if (key in options) {
        merged[key] = options[key];
      }
    }
    if ('detail' in options && !('kinds' in options)) {
      merged.kinds = undefined;
    }
    const config = traceConfig(merged, 'configureTraces()');
    if (!this.#observerSink) {
      // An observers' own sink keeps its masks: they are not the application's.
      this.#native.configureTraces(config.kinds, config.watchedKinds, merged.unsampled ? config.kinds : 0,
                                   config.sample);
    }
    this.#traceConfig = merged;
  }

  /**
   * Traces what matches in full, sampled whatever the ratio, until the
   * returned handle's stop() (napi ADR 0017 section 3): deliveries to the
   * actors of `sessions` (session IDs or ActorIDs), to the named actors of
   * `addresses` ({ family, name }, resolved to their sessions now), and to
   * the actors of the definitions of `families` (family names; spawns of
   * those families are watched from their bootstrap). Everything a watched
   * delivery causes in this system is watched too. It needs a sink.
   */
  watchTraces({ sessions = [], families = [], addresses = [] } = {}) {
    const watch = { sessions: new Set(), families: new Set(families.map(String)) };
    for (const session of sessions) {
      watch.sessions.add(session instanceof ActorID ? BigInt(this.inspect(session).sessionID) : BigInt(session));
    }
    for (const address of addresses) {
      const actor = this.findActor(address);
      if (actor === undefined) {
        throw new TinyactorsError('watchTraces(): no resident actor has that address', 'not-found');
      }
      watch.sessions.add(BigInt(this.inspect(actor).sessionID));
    }
    this.#watches.add(watch);
    this.#applyWatches();
    return Object.freeze({
      stop: () => {
        if (this.#watches.delete(watch) && !this.closed) {
          this.#applyWatches();
        }
      },
    });
  }

  #watchedFamily(family) {
    for (const watch of this.#watches) {
      if (watch.families.has(family)) {
        return true;
      }
    }
    return false;
  }

  #applyWatches() {
    const sessions = new Set();
    const families = new Set();
    for (const watch of this.#watches) {
      watch.sessions.forEach((session) => sessions.add(session));
      watch.families.forEach((family) => families.add(family));
    }
    // Families go to the addon as names: it resolves each definition the
    // first time a delivery meets it, so definitions core registers later
    // (nested and invoke-time children, core ADR 0078) are watched too.
    this.#native.setTraceWatch([...sessions], [...families]);
  }

  // One service effect, in the order core made the calls (napi_services.h).
  #effect(kind, payload) {
    switch (kind) {
      case 'loads':
        // Loads the turn started (napi ADR 0020); each finishes itself.
        for (const request of payload) {
          this.#runLoad(request).catch(() => {});
        }
        return;
      case 'log':
        this.#logSink?.(payload);
        this.#notify('log', payload);
        return;
      case 'trace':
        this.#traceSink?.(payload.traces, payload.logs);
        this.#notify('traces', payload.traces, payload.logs);
        return;
      case 'runaway':
        this.#notify('runaway', payload);
        return;
      case 'io':
        this.#runIO(payload);
        return;
      case 'invoke-start':
        this.#startInvocation(payload);
        return;
      case 'invoke-cancel':
        this.#cancelInvocation(payload.handle, undefined);
        return;
      case 'invoke-forward':
        this.#forwardInvocation(payload);
        return;
      default:
        return;
    }
  }

  // The context every I/O processor call gets; made once per system.
  #context() {
    this.#effectContext ??= Object.freeze({
      system: this,
      signal: this.#lifetime.signal,
      post: (target, event, data, options) => this.post(target, event, data, options),
    });
    return this.#effectContext;
  }

  #replyContext(traceparent) {
    const base = this.#context();
    return Object.freeze({
      system: base.system,
      signal: base.signal,
      post: (target, event, data, options) =>
        this.post(target, event, data, options?.traceparent === undefined ? { ...options, traceparent } : options),
    });
  }

  #runIO(payload) {
    // payload.traceparent names the sending step, for the processor to carry along (ADR 0015).
    const request = payload;
    const processor = this.#io.get(request.type);
    if (processor === undefined) {
      this.#communicationError(request, new TinyactorsError(`no I/O processor for "${request.type}"`, 'not-found'));
      return;
    }
    // A reply the processor posts stays in the trace of the sending step
    // unless it names another (napi ADR 0017 section 6).
    const context = request.traceparent === undefined ? this.#context() : this.#replyContext(request.traceparent);
    let outcome;
    try {
      outcome = processor.send(request, context);
    } catch (error) {
      this.#communicationError(request, error);
      return;
    }
    if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
      outcome.then(undefined, (error) => this.#communicationError(request, error));
    }
  }

  // A failed send reaches its sender as error.communication (ADR 0008:
  // failures after the call reach JavaScript through events or hooks).
  #communicationError(request, error) {
    if (this.closed || request.source === undefined) {
      return;
    }
    if (this.#observers.size > 0) {
      try {
        this.#notify('dropped', { source: request.source, sendID: request.sendID, event: request.event,
                                  type: request.type, target: request.target, error });
      } catch {
        // An observer's failure is its own.
      }
    }
    try {
      this.post(request.source, 'error.communication', { sendID: request.sendID, type: request.type, error });
    } catch {
      // The sender is gone or its mailbox is full: nobody is left to tell.
    }
  }

  #startInvocation(payload) {
    const { handle, parent, invocationID } = payload;
    const controller = new AbortController();
    const invocation = { controller, service: undefined, live: true };
    this.#invocations.set(handle, invocation);
    // done() and unavailable() end the invocation once core took the
    // report, or answered that the parent or the invocation is gone. A
    // report that throws (queue-full, out-of-memory) was not taken: the
    // invocation stays alive, its signal unaborted, for the service to
    // report again.
    const report = (kind, name, data) => {
      if (!invocation.live || this.closed) {
        return false;
      }
      const taken = this.#native.reportInvoke(parent.slot, parent.generation, invocationID, kind, name, data,
                                              payload.traceparent);
      if (kind !== 'event') {
        this.#endInvocation(handle, invocation);
      }
      return taken;
    };
    const reporter = Object.freeze({
      signal: controller.signal,
      event: (name, data) => report('event', this.#events.id(name), data),
      done: (data) => report('done', 0, data),
      unavailable: (error) => report('unavailable', 0, error),
    });
    const invoker = this.#invokers.get(payload.type);
    // No service is left to retry these reports, and a throw would reach the
    // pump's effect loop: a report core cannot take is dropped here.
    const unavailable = (error) => {
      try {
        reporter.unavailable(error);
      } catch {
        // queue-full or out-of-memory: the parent does not hear of it, and
        // the invocation, with no service, ends here.
        if (invocation.live) {
          this.#endInvocation(handle, invocation);
        }
      }
    };
    if (invoker === undefined) {
      unavailable(new TinyactorsError(`no invoker for "${payload.type}"`, 'not-found'));
      return;
    }
    const request = Object.freeze({
      system: this,
      parent,
      invocationID,
      invokeID: payload.invokeID,
      type: payload.type,
      source: payload.source,
      content: payload.content,
      contentType: payload.contentType,
      params: payload.params,
      autoforward: payload.autoforward,
      // The invoking step, for a service that starts work elsewhere (ADR 0015).
      traceparent: payload.traceparent,
    });
    try {
      invocation.service = invoker.start(request, reporter);
    } catch (error) {
      unavailable(error);
    }
  }

  #endInvocation(handle, invocation) {
    invocation.live = false;
    this.#invocations.delete(handle);
    invocation.controller.abort();
  }

  #cancelInvocation(handle, reason) {
    const invocation = this.#invocations.get(handle);
    if (invocation === undefined) {
      return;
    }
    this.#endInvocation(handle, invocation);
    try {
      const outcome = invocation.service?.cancel?.(reason);
      if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
        outcome.then(undefined, () => {});
      }
    } catch {
      // A service that fails to cancel is gone as far as the actor is concerned.
    }
  }

  #forwardInvocation({ handle, event }) {
    const invocation = this.#invocations.get(handle);
    if (invocation === undefined || typeof invocation.service?.forward !== 'function') {
      return;
    }
    try {
      const outcome = invocation.service.forward(event);
      if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
        outcome.then(undefined, () => {});
      }
    } catch {
      // Forwarding is best effort (SCXML 6.4: autoforward has no error path).
    }
  }

  /** True once close() has run. */
  get closed() {
    return this.#native.closed;
  }

  /** "realtime" (the default) or "manual" (ADR 0007 point 3). */
  get clock() {
    return this.#native.clock;
  }

  /**
   * Core's logical time in milliseconds. With the realtime clock it follows
   * a monotonic clock read natively, relative to system creation plus
   * `initialTime`.
   */
  get time() {
    return this.#native.time;
  }

  /**
   * Manual clock only: move time to `time` (never backwards) and resolve once
   * everything due has been dispatched and the system is quiet.
   */
  advanceTo(time) {
    return this.#native.advanceTo(time);
  }

  /** Manual clock only: advanceTo(time + milliseconds). */
  advanceBy(milliseconds) {
    if (typeof milliseconds !== 'number' || !(milliseconds >= 0)) {
      throw new TinyactorsError('advanceBy(): expected a non-negative number of milliseconds', 'invalid');
    }
    return this.#native.advanceTo(this.#native.time + milliseconds);
  }

  /**
   * Register a data model for imported documents (ADR 0019): `compile(source,
   * role)` turns each source expression of a document whose `datamodel` is
   * `name` into what a builder chart would pass. For the roles `value`,
   * `condition` and `script` that is a function called with `this` = the
   * data and one argument, the context; for `location` it is a data name or
   * `{ get(context), set(value, context) }`. Throwing refuses the chart; an
   * error with numeric `offset` and `length` points into the source. The
   * built-in data model runs what it returns, so storage, <foreach>,
   * <param>, <content> and wire JSON behave as for builder charts.
   * `javascript` and `null` are napi's own names. Register before the first
   * define() that uses it. lib/ ships no expression compiler: running
   * expression text is the caller's choice (tools/ecmascript-datamodel.js is
   * an example).
   */
  registerDatamodel(name, { compile } = {}) {
    if (typeof name !== 'string' || name === '') {
      throw new TinyactorsError('registerDatamodel(): expected a data model name', 'invalid');
    }
    if (typeof compile !== 'function') {
      throw new TinyactorsError('registerDatamodel(): expected { compile(source, role) }', 'invalid');
    }
    this.#native.registerDatamodel(name, (source, role) => normalizeCompiled(compile(source, role), role));
  }

  /**
   * Compile and register a chart: a statechart() builder, or a spec in the
   * generated shape (the shape core's definition export returns). It
   * compiles against the JavaScript data model ("javascript", ADR 0011); a
   * plain spec opts into core's null data model with `datamodel: "null"`.
   *
   * `options.microstepLimit` overrides the system's
   * `scheduling.microstepLimit` for this definition's actors (core ADR
   * 0075): the microsteps one macrostep may run before its actor is
   * quarantined as a runaway; 0 for no limit.
   *
   * With `{ format: 'scxml' }`, `source` is an SCXML document (a string or
   * a Uint8Array of UTF-8). Its `datamodel` attribute picks the data model:
   * `javascript` (also for a document without one), one registerDatamodel()
   * registered, or `null`, which a document opts into by naming it. A refusal says where in the document (ADR
   * 0058): `detail` has `stage`, `line`, `column` and `offset`.
   * `options.resolve(src)` fetches `<data src>` and `<script src>` while the
   * document is defined: it returns the content as a string or a
   * Uint8Array, or undefined for a src it does not know, which refuses the
   * document. Without it, any `src` is refused. `options.name` is what the
   * document is called, such as its path or a file:// URL: the source its
   * spans name (core ADR 0085), which Definition.sourceOf() answers and a
   * debugger opens.
   * An `<invoke type="scxml">` whose child chart is inline in `<content>`,
   * or a literal `src` that `resolve` fetches, is compiled now, as part of
   * this definition (napi ADR 0024, core ADR 0077): a broken child refuses
   * the document. The definition keeps `resolve` for children compiled at
   * invoke time from `srcexpr`, and its children inherit it. A child
   * fetched by `src` or `srcexpr` is named by that src; a child inline in
   * `<content>` is unnamed, as its lines count from the start of its
   * content, not of the document.
   */
  define(source, options = {}) {
    const limit = microstepLimitOption(options, 'define()');
    const format = options?.format;
    if (format !== undefined) {
      if (format !== 'scxml') {
        throw new TinyactorsError(`define(): unknown format ${JSON.stringify(format)}; expected "scxml"`, 'invalid');
      }
      const resolve = options?.resolve;
      if (resolve !== undefined && typeof resolve !== 'function') {
        throw new TinyactorsError('define(): resolve must be a function of src', 'invalid');
      }
      const name = options?.name;
      if (name !== undefined && typeof name !== 'string') {
        throw new TinyactorsError('define(): name must be a string, such as the document\'s path', 'invalid');
      }
      return this.#registered(this.#importSCXML(source, name, resolve), limit);
    }
    let spec = source;
    if (source instanceof DefinitionBuilder) {
      spec = source.build();
    } else if (source === null || typeof source !== 'object') {
      throw new TinyactorsError('define(): expected a statechart() builder or a spec object', 'invalid');
    }
    this.#native.selectDatamodel(spec.datamodel === 'null' ? 'null' : 'javascript');
    const compiled = compile(this.#native, spec);
    return this.#registered(core.system_register_definition(this.#native, compiled.out), limit);
  }

  // A registered definition's facade, with its microstep limit when one is
  // given.
  #registered(id, limit) {
    if (limit !== undefined) {
      core.definition_set_microstep_limit(this.#native, id, limit === 0 ? MICROSTEP_LIMIT_NONE : limit);
    }
    this.#notify('defined', id);
    return new Definition(this, this.#native, id);
  }

  // Decodes, compiles and registers an SCXML document; a refusal throws with
  // its position (core ADRs 0058 and 0076).
  #importSCXML(source, name, resolve) {
    let bytes = source;
    if (typeof source === 'string') {
      bytes = new TextEncoder().encode(source);
    } else if (!(source instanceof Uint8Array)) {
      throw new TinyactorsError('define(): an SCXML document is a string or a Uint8Array', 'invalid');
    }
    const result = this.#native.importDefinition(bytes, name, resolve);
    if (typeof result === 'bigint') {
      return result;
    }
    const where = result.line === undefined ? '' : ` at line ${result.line}, column ${result.column}`;
    throw new TinyactorsError(`chart refused${where}: ${result.message}`, result.code, {
      stage: result.stage,
      message: result.message,
      line: result.line,
      column: result.column,
      offset: result.offset,
    });
  }

  /**
   * The newest registered, unretired definition with this identity, or
   * undefined.
   */
  findDefinition(identity) {
    if (identity === null || typeof identity !== 'object') {
      throw new TinyactorsError('findDefinition(): expected { family, revision }', 'invalid');
    }
    try {
      const id = core.system_find_definition(this.#native, {
        family: { name: identity.family },
        revision: identity.revision,
      });
      return new Definition(this, this.#native, id);
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Create an actor of `definition`. It is bootstrapped by a later pump turn,
   * never inside this call (ADR 0007); `await system.flush()` to see it in its
   * initial state.
   */
  spawn(definition, options = {}) {
    if (!(definition instanceof Definition) || definition.system !== this) {
      throw new TinyactorsError('spawn(): expected a Definition of this system', 'invalid');
    }
    let address;
    if (options.address !== undefined) {
      address = { family: { name: options.address.family }, name: options.address.name };
    } else if (options.name !== undefined) {
      address = { family: { name: definition.identity.family }, name: options.name };
    }
    const watched = this.#watches.size !== 0 && this.#watchedFamily(definition.identity.family);
    const trace = this.#native.spawnTrace(options.traceparent, watched);
    const pending = options.pendingSends === undefined ? undefined : this.#pendingSends(options.pendingSends);
    const id = core.actor_spawn(this.#native, definition.id, address, options.binding, undefined, trace, pending);
    return new ActorID(this, id.slot, id.generation);
  }

  /**
   * The resident actor the directory has at `address` ({ family, name }), or
   * undefined (ADR 0006).
   */
  findActor(address) {
    const { family, name } = addressOf(address, 'findActor()');
    try {
      const id = core.actor_find(this.#native, { family: { name: family }, name });
      return new ActorID(this, id.slot, id.generation);
    } catch (error) {
      if (error instanceof TinyactorsError && (error.code === 'not-found' || error.code === 'unloaded')) {
        return undefined;
      }
      throw error;
    }
  }

  /** A snapshot of core's view of `actor` (ADR 0054: O(size of the actor)). */
  inspect(actor) {
    const { slot, generation } = actorOf(this, actor);
    const view = core.actor_inspect(this.#native, slot, generation);
    const stateName = (state) => core.definition_state(this.#native, view.definition_id, state).id;
    const idOrNull = (id) => (id === NO_STATE ? null : id);
    const inspection = {
      actor: new ActorID(this, view.actor.slot, view.actor.generation),
      sessionID: view.session_id,
      definition: identityOf(view.definition),
      // The definition's ID, which names its states, transitions and
      // actions to core's lookups (core ADR 0071).
      definitionID: view.definition_id,
      residency: view.residency,
      published: view.published,
      activeStates: core.actor_active_states(this.#native, slot, generation).map(stateName),
      macrostepInProgress: view.macrostep_in_progress,
      microstepInProgress: view.microstep_in_progress,
      // Where a paused macrostep stands (core ADR 0083): its step key, and
      // the unit it runs next; outside a macrostep, (session, 0, 0) and
      // `at: "none"`.
      step: { session: view.step.session, macrostep: Number(view.step.macrostep), microstep: view.step.microstep },
      position: {
        at: view.position.at,
        state: view.position.state === NO_STATE ? null : stateName(view.position.state),
        transition: idOrNull(view.position.transition),
        action: idOrNull(view.position.action),
        iteration: view.position.iteration,
      },
      // The external event of the macrostep in progress, and the internal
      // queue, as `context.event` shows events.
      currentEvent: view.current_event === undefined ? null : this.#eventOf(view.current_event),
      internalEvents: view.internal_events.map((queued) => this.#eventOf(queued.event)),
      internalEventCount: view.internal_events.length,
      invocations: view.invokes.map((invoke) => ({
        id: invoke.id,
        type: core.system_atom_text(this.#native, invoke.type),
        active: invoke.active,
        autoforward: invoke.autoforward,
        serviceHandle: invoke.service_handle,
      })),
      delayedSendCount: view.delayed_sends.length,
      delayedSends: view.delayed_sends.map((send) => this.#delayedSend(view, send)),
      scheduling: this.#native.scheduling(slot, generation),
      // The top-level final it reached, or null (core ADR 0056).
      finalState: view.final_state === NO_STATE ? null : stateName(view.final_state),
      allocatedBytes: view.allocated_bytes,
      // The live data object (JavaScript data model), shared, not copied.
      data: this.#dataRoot(view.definition_id, slot, generation),
      // A finished actor's completion data (<donedata>).
      completion: view.has_completion && view.completion?.has_data ? view.completion.data : undefined,
    };
    return inspection;
  }

  // An event from core's inspection, as `context.event` shows one.
  #eventOf(event) {
    const out = { name: this.#events.name(event.name), type: event.type };
    if (event.send_id !== 0n) {
      try {
        out.sendID = core.send_id_format(this.#native, event.send_id);
      } catch (error) {
        if (!(error instanceof TinyactorsError && error.code === 'not-found')) throw error;
      }
    }
    const origin = this.#originOf(event.origin);
    if (origin !== undefined) {
      out.origin = origin;
    }
    if (event.data !== undefined) {
      out.data = event.data;
    }
    return out;
  }

  // An event's EventOrigin, from core's ta_origin; undefined for none.
  // `type` and `uri` are what the receiver sees as _event.origintype and
  // _event.origin; a closed scope has no URI (core ADR 0068).
  #originOf(origin) {
    let out;
    switch (origin?.kind) {
      case 'actor':
        out = { kind: 'actor', actor: this.#destination(origin.actor) };
        break;
      case 'invoke':
        out = { kind: 'invocation', invocation: origin.invoke };
        break;
      case 'io':
        out = origin.scope === undefined ? { kind: 'io' } : { kind: 'io', scope: origin.scope };
        break;
      default:
        return undefined;
    }
    out.type = origin.type ?? '';
    if (origin.uri !== undefined) {
      out.uri = origin.uri;
    }
    return out;
  }

  // The actor's data root, or undefined under the null data model.
  #dataRoot(definitionID, slot, generation) {
    return this.#usesJavaScript(definitionID) ? core.actor_datamodel_root(this.#native, slot, generation) : undefined;
  }

  // One pending delayed send of the actor `view` inspects, from core's
  // ta_delayed_send_info (core ADR 0054). A literal target is text in the
  // owner's definition, named by content ID. A destination naming the owner,
  // by its runtime ID or its session ID, is "self": stored and re-armed in
  // another session, those IDs would name another actor (core ADR 0074).
  #delayedSend(view, send) {
    const definitionID = view.definition_id;
    let id = null;
    try {
      id = core.send_id_format(this.#native, send.send_id);
    } catch (error) {
      if (!(error instanceof TinyactorsError && error.code === 'not-found')) {
        throw error;
      }
    }
    return {
      id,
      due: send.due,
      event: this.#events.name(send.event),
      ioType: core.system_atom_text(this.#native, send.io_type),
      destination: isOwner(view, send.destination) ? 'self' : this.#destination(send.destination),
      target: send.has_target_text
        ? new TextDecoder().decode(core.definition_content(this.#native, definitionID, send.target_text).bytes)
        : send.target,
      data: send.data,
      submitted: send.submitted,
      // What a re-arm needs (core ADR 0074 section 8): the literal target's
      // and <content>'s IDs in the definition, and the sending step's trace.
      targetContent: send.has_target_text ? send.target_text : null,
      content: send.has_content ? send.content : null,
      traceparent: traceparentOf(send.trace),
    };
  }

  // Records core can re-arm from pendingSends, the shape inspect() returns
  // (core ADR 0074 section 8). Text becomes this system's IDs again.
  #pendingSends(sends) {
    if (!Array.isArray(sends)) {
      throw new TinyactorsError('spawn(): pendingSends must be an array of inspect().delayedSends entries', 'invalid');
    }
    return sends.map((send, index) => {
      if (send === null || typeof send !== 'object' || !Number.isSafeInteger(send.due) || typeof send.event !== 'string') {
        throw new TinyactorsError('spawn(): a pending send needs { due, event, ... } as inspect() gives it', 'invalid');
      }
      return {
        send_id: send.id === null || send.id === undefined ? 0 : core.send_id_parse(this.#native, send.id),
        due: send.due,
        event: this.#events.id(send.event),
        io_type: send.ioType ? core.system_intern_atom(this.#native, send.ioType) : 0,
        destination: this.#destinationRef(send.destination, index),
        target: send.targetContent === null || send.targetContent === undefined ? send.target : undefined,
        data: send.data,
        submitted: false,
        has_target_text: send.targetContent !== null && send.targetContent !== undefined,
        target_text: send.targetContent ?? 0,
        has_content: send.content !== null && send.content !== undefined,
        content: send.content ?? 0,
        trace: send.traceparent ? this.#native.spawnTrace(send.traceparent, false) : NO_TRACE,
      };
    });
  }

  // A stored pending send's destination as core's actor ref (core ADR 0074
  // section 8). "self" and null (a custom I/O processor's send, which has
  // none) are runtime ID 0: core re-arms an SCXML send there to the new
  // session. An address is named. An unnamed other actor re-arms only as a
  // live ActorID of this system: a stored slot and generation would name
  // whichever actor holds that slot by now.
  #destinationRef(destination, index) {
    if (destination === 'self' || destination === null || destination === undefined) {
      return { kind: 'runtime', runtime: { slot: 0, generation: 0 } };
    }
    if (destination instanceof ActorID) {
      if (destination.system !== this) {
        throw new TinyactorsError(`spawn(): pendingSends[${index}] is a send to an unnamed actor of another system, ` +
          'which cannot be re-armed here', 'invalid');
      }
      return { kind: 'runtime', runtime: { slot: destination.slot, generation: destination.generation } };
    }
    if (typeof destination === 'object' && typeof destination.family === 'string' && typeof destination.name === 'string') {
      return { kind: 'named', named: { family: { name: destination.family }, name: destination.name } };
    }
    throw new TinyactorsError(`spawn(): pendingSends[${index}] is a send to an unnamed actor, which a stored entry ` +
      'cannot name again: send to an address, or to the actor itself', 'invalid');
  }

  // A resolved destination: an ActorID, an address, or null for a custom
  // I/O processor, whose destination core leaves as runtime ID 0.
  #destination(ref) {
    if (ref === undefined || ref === null) {
      return null;
    }
    if (ref.kind === 'named') {
      return ref.named === undefined ? null : { family: ref.named.family.name, name: ref.named.name };
    }
    const { slot, generation } = ref.runtime;
    return generation === 0 ? null : new ActorID(this, slot, generation);
  }

  /**
   * The resident actors as pages of IDs (ADR 0003): each page is a
   * Uint32Array of interleaved [slot, generation] pairs, with no object per
   * actor. Pages come from core's walk in slot order and continue from its
   * cursor, so a whole iteration is linear and holds one page at a time. A
   * page is a snapshot: an actor resident for the whole iteration appears
   * exactly once, one destroyed before the walk reaches it does not appear,
   * and one spawned meanwhile appears when its slot is ahead of the cursor
   * (core ADR 0062). Options: { pageSize } (default 1024, at most 65536).
   */
  /**
   * Every definition the system holds, as inspections, one page of IDs at
   * a time (core ADR 0078): builder and imported charts, their nested inline
   * children, and children compiled when an <invoke> ran. Retired
   * definitions still in use are included (`retired` says so). A definition
   * freed after its page was taken, and before it was reached, is skipped.
   * Options: { pageSize } (default 1024, at most 65536).
   */
  *definitions(options = {}) {
    const pageSize = pageSizeOf(options, 'definitions()');
    for (const id of this.#definitionIDs(pageSize)) {
      let inspection;
      try {
        inspection = new Definition(this, this.#native, id).inspect();
      } catch (error) {
        if (error instanceof TinyactorsError && error.code === 'not-found') {
          continue;
        }
        throw error;
      }
      yield inspection;
    }
  }

  // The IDs of the definitions core holds, in slot order, `pageSize` at a
  // time; a page shorter than that is the last (core ADR 0078).
  *#definitionIDs(pageSize) {
    let from = 0;
    for (;;) {
      const ids = core.system_definitions(this.#native, from, pageSize);
      yield* ids;
      if (ids.length < pageSize) {
        return;
      }
      from = Number(BigInt.asUintN(32, BigInt(ids[ids.length - 1]))) + 1;
    }
  }

  *actorIDs(options = {}) {
    const pageSize = pageSizeOf(options, 'actorIDs()');
    let from = 0;
    while (from !== null) {
      const page = this.#native.idPage(from, pageSize);
      if (page.ids.length > 0) {
        yield page.ids;
      }
      from = page.next;
    }
  }

  /**
   * The resident actors' inspections, one page of IDs at a time (ADR 0003).
   * Each actor is inspected when the iterator reaches it, with inspect(), so
   * at most one page of IDs and one inspection are held at a time. An actor
   * destroyed after its page was taken, and before it was reached, is
   * skipped. Options: { pageSize } (default 1024, at most 65536).
   */
  *actors(options = {}) {
    for (const ids of this.actorIDs(options)) {
      for (let at = 0; at < ids.length; at += 2) {
        let inspection;
        try {
          inspection = this.inspect(new ActorID(this, ids[at], ids[at + 1]));
        } catch (error) {
          if (error instanceof TinyactorsError && error.code === 'not-found') {
            continue;
          }
          throw error;
        }
        yield inspection;
      }
    }
  }

  /** True when a resident actor has this ID. */
  exists(actor) {
    const { slot, generation } = actorOf(this, actor);
    try {
      core.actor_inspect(this.#native, slot, generation);
      return true;
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        return false;
      }
      throw error;
    }
  }

  /** Terminate `actor`. Throws `not-found` for an actor that is gone. */
  destroy(actor) {
    const { slot, generation } = actorOf(this, actor);
    core.actor_destroy(this.#native, slot, generation);
  }

  /**
   * Queue `event` for `target` and return (ADR 0005). Nothing runs inside
   * this call: a later pump turn delivers it, in the order posts to that
   * target were accepted. Mail for an actor that is gone or finished is a
   * dead letter (the `deadLetter` hook), not an error. `target` is an
   * ActorID or an address { family, name }, resolved through the directory
   * when the post is accepted (ADR 0006); a name with no resident actor is a
   * dead letter too. `data` is any JavaScript value, shared with the
   * receiver, not copied (ADR 0011); it is `_event.data`
   * (`context.event.data`) in the receiver's expressions. Throws
   * `queue-full` when scheduling.maxQueuedMessages or maxRetainedBytes would
   * be passed: post() has no promise to report it through (ADR 0008).
   */
  post(target, event, data, options) {
    if (options?.signal?.aborted) {
      throw new TinyactorsError('post(): the signal is already aborted', 'aborted');
    }
    this.#accept(target, event, data, options, false, 'post()');
  }

  /**
   * Queue `event` for `target` and return a promise (ADR 0005 point 11).
   * With `until: "completed"` (the default) it resolves with
   * { actor, status: "stable" | "done", completion } once the macrostep this
   * message starts has ended: the actor is stable again, or it finished
   * (`completion` is its done data). It rejects when the message becomes a
   * dead letter (`not-found`, `done`, `unloaded`, `invalid`), when the
   * macrostep faults (the fault's code; the actor is quarantined), on
   * `options.signal` (`aborted`), after `options.timeout` milliseconds
   * (`timeout`), and on close() (`closed`). Aborting or timing out withdraws
   * the message if it is still queued; a message the actor already took is
   * not undone. With `until: "accepted"` it resolves with
   * { actor, status: "accepted" } as soon as the message is queued.
   * A full queue rejects with `queue-full`; only misuse throws (ADR 0008).
   */
  send(target, event, data, options = {}) {
    const until = options.until ?? 'completed';
    if (until !== 'completed' && until !== 'accepted') {
      throw new TinyactorsError('send(): options.until must be "completed" or "accepted"', 'invalid');
    }
    const timeout = options.timeout;
    if (timeout !== undefined && !(typeof timeout === 'number' && timeout >= 0 && Number.isFinite(timeout))) {
      throw new TinyactorsError('send(): options.timeout must be a non-negative number of milliseconds', 'invalid');
    }
    const signal = options.signal;
    if (signal?.aborted) {
      // Validate the call first: misuse throws even with an aborted signal.
      if (!(target instanceof ActorID)) addressOf(target, 'send()');
      else actorOf(this, target);
      return Promise.reject(new TinyactorsError('send(): the signal is already aborted', 'aborted'));
    }
    let promise;
    try {
      promise = this.#accept(target, event, data, options, until === 'completed', 'send()');
    } catch (error) {
      if (error instanceof TinyactorsError && (error.code === 'queue-full' || error.code === 'out-of-memory')) {
        return Promise.reject(error);
      }
      throw error;
    }
    if (until === 'accepted') {
      return Promise.resolve({ actor: target instanceof ActorID ? target : undefined, status: 'accepted' });
    }
    if (signal === undefined && timeout === undefined) {
      return promise;
    }
    const native = this.#native;
    const token = native.lastSendToken;
    const cancel = (code) => {
      try {
        if (!native.closed) native.cancelSend(token, code);
      } catch {
        // The system closed in the meantime; close() settled the promise.
      }
    };
    const onAbort = () => cancel('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeout === undefined ? undefined : setTimeout(() => cancel('timeout'), timeout);
    timer?.unref?.();
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    return promise.then(
      (result) => {
        cleanup();
        return result;
      },
      (error) => {
        cleanup();
        throw error;
      },
    );
  }

  // Accepts one message for post() or send(); returns send()'s native promise.
  #accept(target, event, data, options, completion, what) {
    const bytes = retainedBytes(data, options, what);
    const origin = originOf(options?.origin, what);
    const trace = options?.traceparent;
    if (!(target instanceof ActorID)) {
      if (options?.transition !== undefined) {
        throw new TinyactorsError(`${what}: options.transition needs an actor ID: it names that actor's states`, 'invalid');
      }
      if (target !== null && typeof target === 'object' && 'name' in target) {
        const { family, name } = addressOf(target, what);
        const id = this.#events.id(event);
        return completion
          ? this.#native.sendNamed(family, name, id, data, bytes, origin, trace)
          : this.#native.postNamed(family, name, id, data, bytes, origin, trace);
      }
      throw new TinyactorsError(`${what}: expected an actor of this system or an address`, 'invalid');
    }
    const { slot, generation } = actorOf(this, target);
    const id = this.#events.id(event);
    const jump = options?.transition === undefined ? undefined : this.#jumpOf(target, options.transition, what);
    return completion
      ? this.#native.send(slot, generation, id, data, bytes, origin, trace, jump)
      : this.#native.post(slot, generation, id, data, bytes, origin, trace, jump);
  }

  // An operator transition by state names, as the native post takes it: the
  // target's definition now and state IDs (core ADR 0082, ADR 0026).
  #jumpOf(actor, transition, what) {
    const { targets, source } = transition ?? {};
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((state) => typeof state === 'string') ||
        (source !== undefined && source !== null && typeof source !== 'string')) {
      throw new TinyactorsError(`${what}: options.transition must be { targets: [state, ...], source? }`, 'invalid');
    }
    const definition = core.actor_inspect(this.#native, actor.slot, actor.generation).definition_id;
    const state = (name) => {
      try {
        return core.definition_find_state(this.#native, definition, name);
      } catch (error) {
        if (error instanceof TinyactorsError && error.code === 'not-found') {
          throw new TinyactorsError(`${what}: "${name}" is not a state of the actor's chart`, 'invalid');
        }
        throw error;
      }
    };
    return {
      definition,
      source: source === undefined || source === null ? NO_STATE : state(source),
      targets: targets.map(state),
    };
  }

  /*
   * Persistence and replacement (ROADMAP step 14; core ADRs 0013, 0014,
   * 0043, 0051, 0052, 0066).
   */

  /**
   * Capture `actor` in memory: core's session image, plus the data-model
   * root it has now (core's image does not hold it). A macrostep in
   * progress is captured too; an unpublished (prepared) actor cannot be
   * captured (`busy`).
   */
  capture(actor) {
    const { slot, generation } = actorOf(this, actor);
    const view = core.actor_inspect(this.#native, slot, generation);
    const handle = core.actor_capture(this.#native, slot, generation);
    const self = this.#destination(view.self);
    return new SessionImage(this, handle, {
      actor: new ActorID(this, slot, generation),
      sessionID: view.session_id,
      definition: identityOf(view.definition),
      address: self instanceof ActorID || self === null ? undefined : self,
      data: this.#dataRoot(view.definition_id, slot, generation),
    });
  }

  /**
   * Evict a stable named actor from memory (core ADR 0074): it is offloaded
   * to bytes the system keeps, with its data (serialized with v8.serialize,
   * or kept by handle; see the `unloadValues` option of createSystem), its
   * history and its pending delayed sends. The directory keeps its address
   * as unloaded, and mail to the address, or its own next delayed send,
   * loads it back from those bytes first (napi ADR 0020), with no loader
   * needed; load() brings it back at once. Throws `busy` while the actor has
   * mail waiting, is inside a macrostep, or is quarantined, so unloading
   * never drops accepted mail, and `unsupported` when a value it holds can
   * be neither serialized nor kept. Its ActorID is stale afterwards. The
   * bytes are for this process only: to survive a restart, store the
   * actor's data and inspect().delayedSends, and spawn it again with
   * { binding, pendingSends }.
   */
  unload(actor) {
    const { slot, generation } = actorOf(this, actor);
    const scheduling = this.#native.scheduling(slot, generation);
    if (scheduling !== 'idle' && scheduling !== 'none') {
      throw new TinyactorsError(`unload(): the actor is ${scheduling}; unload it once it is idle`, 'busy');
    }
    const view = core.actor_inspect(this.#native, slot, generation);
    const self = this.#destination(view.self);
    if (self === null || self instanceof ActorID) {
      throw new TinyactorsError('unload(): only a named actor can be unloaded', 'invalid');
    }
    let due;
    for (const send of view.delayed_sends) {
      due = due === undefined || send.due < due ? send.due : due;
    }
    // Mail or a timer for an offloaded actor starts a load, loader or not.
    if (!this.#loaders.has(self.family)) {
      this.#offloadFamilies.add(self.family);
      this.#native.setLoaderFamily(self.family, DEFAULT_MAX_WAITING);
    }
    this.#native.offload(slot, generation);
    if (due !== undefined) {
      this.#native.wakeAt(self.family, self.name, due);
    }
  }

  /**
   * Bring an unloaded named actor back (core ADRs 0051 and 0074): from the
   * bytes unload() kept for `target`, an address { family, name }, or from
   * a SessionImage. It keeps its session ID, gets a new runtime ID (core
   * ADR 0066), and its address is resident again. `binding`, when given,
   * replaces the data root outright (it is not merged): for an address,
   * the data the actor was unloaded with; from an image, the root the image
   * kept, which it defaults to. The image stays the caller's to destroy. An
   * invocation that was active when it was captured does not come back:
   * the actor gets `error.communication.invoke.<id>.unavailable` for it
   * (core ADR 0038).
   */
  load(target, options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TinyactorsError('load(): expected options { binding }', 'invalid');
    }
    if (!(target instanceof SessionImage)) {
      const { family, name } = addressOf(target, 'load()');
      const id = this.#native.loadOffloaded(family, name, options.binding);
      return new ActorID(this, id.slot, id.generation);
    }
    const image = target;
    const handle = handleOf(image, this, 'load()');
    if (image.address !== undefined) {
      // The image replaces whatever unload() offloaded to its address.
      this.#native.dropOffloaded(image.address.family, image.address.name);
    }
    const id = core.actor_load(this.#native, handle, undefined, this.#bindingFor(image, options), undefined).out;
    return new ActorID(this, id.slot, id.generation);
  }

  /**
   * Restore an image under a fresh runtime ID without touching the
   * directory (core ADR 0052). It keeps the session ID unless a resident
   * session holds it (core ADR 0066). `binding` defaults to the data root
   * the image kept, which is shared with the captured actor if that still
   * runs; pass one for an independent copy.
   */
  reconstruct(image, options = {}) {
    const handle = handleOf(image, this, 'reconstruct()');
    const id = core.actor_reconstruct(this.#native, handle, this.#bindingFor(image, options));
    return new ActorID(this, id.slot, id.generation);
  }

  /** Release the address of an actor that stays unloaded; its image is the caller's to destroy. */
  removeUnloaded(address) {
    const { family, name } = addressOf(address, 'removeUnloaded()');
    this.#native.dropOffloaded(family, name);
    core.actor_remove_unloaded(this.#native, { family: { name: family }, name });
    this.#native.cancelWake(family, name);
  }

  /**
   * Bring actors of `family` back when mail arrives for them (napi ADR
   * 0020). Mail for a name in `family` that has no resident actor (it is
   * unloaded, or there has never been one here: the family is virtual)
   * waits while `loader(address, why, { offloaded })` runs; `why` is
   * "mail", or "timer" when an unloaded actor's own delayed send is due, and
   * `offloaded` is true when unload() kept the actor's bytes here (core ADR
   * 0074). The loader returns, or resolves to:
   * - "offloaded": the actor comes back from those bytes, and the waiting
   *   mail is delivered first, in order. A family with no loader does this
   *   for an offloaded actor on its own;
   * - a SessionImage of this system: it is loaded (as load() does), and
   *   the waiting mail is delivered first, in order;
   * - { image, restore }: the image is loaded, and `await restore(actor)`
   *   runs before the waiting mail is delivered (for replaying a log);
   * - { spawn: definition, binding?, pendingSends? }: a new actor of
   *   `definition` (of this family) at the address, from data the
   *   application stored, with the delayed sends it stored from
   *   inspect().delayedSends re-armed (core ADR 0074 section 8); the waiting
   *   mail is delivered first;
   * - "not-found": dead letters with reason `not-found`;
   * - "reject" or { reject: reason }: "not now", as during a shutdown: dead
   *   letters with reason `rejected`.
   * A thrown error is `load-failed`; a loader that has not settled after
   * `timeout` ms (default 5000) is `load-timeout`, and a result that comes
   * later is discarded (an image in it is destroyed). One load runs per
   * address; at most `maxWaiting` messages (default 1000) wait, and the rest
   * are dead letters with reason `waiting-full`. Pass `null` as the loader
   * to remove it.
   */
  setLoader(family, loader, options = {}) {
    if (typeof family !== 'string' || family === '') {
      throw new TinyactorsError('setLoader(): expected a family name', 'invalid');
    }
    if (loader === null || loader === undefined) {
      this.#loaders.delete(family);
      // Offloaded actors still load back from their bytes.
      this.#native.setLoaderFamily(family, this.#offloadFamilies.has(family) ? DEFAULT_MAX_WAITING : 0);
      return;
    }
    if (typeof loader !== 'function') {
      throw new TinyactorsError('setLoader(): expected a loader function or null', 'invalid');
    }
    if (options === null || typeof options !== 'object') {
      throw new TinyactorsError('setLoader(): expected options { timeout, maxWaiting }', 'invalid');
    }
    const { timeout = 5000, maxWaiting = 1000 } = options;
    for (const [what, value] of [['timeout', timeout], ['maxWaiting', maxWaiting]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
        throw new TinyactorsError(`setLoader(): ${what} must be a positive integer`, 'invalid');
      }
    }
    this.#loaders.set(family, { loader, timeout, maxWaiting });
    this.#native.setLoaderFamily(family, maxWaiting);
  }

  /**
   * Wake the unloaded actor at `address` ({ family, name }) at `time`
   * (core's clock) through its family's loader, with `why` "timer" (napi
   * ADR 0020). unload() does this for the image's next deadline.
   */
  wakeAt(address, time) {
    const { family, name } = addressOf(address, 'wakeAt()');
    this.#native.wakeAt(family, name, time);
  }

  // Runs one load the pump started (napi ADR 0020) and finishes it.
  async #runLoad({ index, generation, family, name, why }) {
    const key = `${family}\u0000${name}`;
    this.#loadDetails.delete(key);
    const offloaded = this.#native.hasOffloaded(family, name);
    const entry = this.#loaders.get(family);
    if (entry === undefined) {
      // With no loader, an actor unload() offloaded comes back from its bytes.
      if (offloaded) {
        this.#loadOffloaded({ index, generation, key, address: { family, name } });
      } else {
        this.#completeLoad(index, generation, 'not-found');
      }
      return;
    }
    const address = { family, name };
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        this.#failLoad(key, { index, generation }, 'timed-out', `the loader did not settle within ${entry.timeout} ms`);
      }
    }, entry.timeout);
    timer.unref?.();
    let result;
    try {
      result = await entry.loader(address, why, { offloaded });
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        this.#failLoad(key, { index, generation }, 'failed', describe(error));
      }
      return;
    }
    if (settled) {
      discardLoad(result); // the load timed out: nothing may use this result
      return;
    }
    settled = true;
    clearTimeout(timer);
    try {
      await this.#applyLoad({ index, generation, key, address }, result);
    } catch (error) {
      this.#failLoad(key, { index, generation }, 'failed', describe(error));
    }
  }

  // Acts on a loader's result (setLoader()).
  async #applyLoad(load, result) {
    if (this.closed) {
      discardLoad(result);
      return;
    }
    const { index, generation, key } = load;
    if (result === 'offloaded') {
      this.#loadOffloaded(load);
    } else if (result === 'not-found') {
      this.#completeLoad(index, generation, 'not-found');
    } else if (result === 'reject') {
      this.#failLoad(key, load, 'rejected', '');
    } else if (result !== null && typeof result === 'object' && 'reject' in result) {
      this.#failLoad(key, load, 'rejected', String(result.reject));
    } else if (result instanceof SessionImage) {
      this.#completeLoad(index, generation, 'loaded', this.#loadImage(result, load));
    } else if (result !== null && typeof result === 'object' && result.image instanceof SessionImage) {
      const actor = this.#loadImage(result.image, load);
      if (typeof result.restore === 'function') {
        await result.restore(actor);
      }
      if (!this.closed) {
        this.#completeLoad(index, generation, 'loaded', actor);
      }
    } else if (result !== null && typeof result === 'object' && result.spawn instanceof Definition) {
      this.#completeLoad(index, generation, 'spawned', this.#spawnAt(result, load));
    } else {
      this.#failLoad(key, load, 'failed', 'the loader returned something it cannot: expected "offloaded", ' +
        'a SessionImage, { image, restore }, { spawn, binding, pendingSends }, "not-found", "reject" or { reject }');
    }
  }

  // Loads the actor unload() offloaded to the load's address (core ADR 0074).
  #loadOffloaded({ index, generation, key, address }) {
    try {
      const id = this.#native.loadOffloaded(address.family, address.name);
      this.#completeLoad(index, generation, 'loaded', new ActorID(this, id.slot, id.generation));
    } catch (error) {
      this.#failLoad(key, { index, generation }, 'failed', describe(error));
    }
  }

  // Loads a loader's image under the trace of the mail that caused the load.
  #loadImage(image, { index, generation, address }) {
    const handle = handleOf(image, this, "setLoader(): the loader's image");
    if (image.address === undefined || image.address.family !== address.family ||
        image.address.name !== address.name) {
      throw new TinyactorsError(`the loader returned an image of another address than ${address.family}/${address.name}`,
        'invalid');
    }
    const id = core.actor_load(this.#native, handle, undefined, this.#bindingFor(image, {}),
      this.#native.loadTrace(index, generation)).out;
    // The image replaces whatever unload() offloaded to this address.
    this.#native.dropOffloaded(address.family, address.name);
    return new ActorID(this, id.slot, id.generation);
  }

  // Spawns a loader's { spawn, binding, pendingSends } at the load's address.
  #spawnAt({ spawn: definition, binding, pendingSends }, { index, generation, address }) {
    if (definition.system !== this || definition.identity.family !== address.family) {
      throw new TinyactorsError(`{ spawn } needs a definition of family ${address.family} of this system`, 'invalid');
    }
    if (this.#unloadedAt(address)) {
      this.removeUnloaded(address); // the application's data replaces the image
    }
    const pending = pendingSends === undefined ? undefined : this.#pendingSends(pendingSends);
    const id = core.actor_spawn(this.#native, definition.id, { family: { name: address.family }, name: address.name },
      binding, undefined, this.#native.loadTrace(index, generation), pending);
    return new ActorID(this, id.slot, id.generation);
  }

  // True when the directory keeps `address` as unloaded.
  #unloadedAt({ family, name }) {
    try {
      core.actor_find(this.#native, { family: { name: family }, name });
      return false;
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'unloaded') {
        return true;
      }
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        return false;
      }
      throw error;
    }
  }

  #completeLoad(index, generation, outcome, actor) {
    if (!this.closed) {
      this.#native.completeLoad(index, generation, outcome, actor?.slot, actor?.generation);
    }
  }

  #failLoad(key, { index, generation }, outcome, detail) {
    if (this.closed) {
      return;
    }
    if (detail !== '') {
      this.#loadDetails.set(key, detail);
    }
    this.#native.completeLoad(index, generation, outcome, undefined, undefined, detail);
  }

  // A dead letter of mail that waited for a failed load carries why it failed.
  // One dead letter: observers first, never letting them fail the turn,
  // then the application's hook, whose exceptions are the application's.
  #deadLetter(letter, hook) {
    const record = this.#withLoadDetail(letter);
    if (this.#observers.size > 0) {
      try {
        this.#notify('deadLetter', record);
      } catch {
        // An observer's failure is its own.
      }
    }
    hook?.(record);
  }

  #withLoadDetail(letter) {
    if ((letter.reason === 'rejected' || letter.reason === 'load-failed' || letter.reason === 'load-timeout') &&
        !(letter.target instanceof ActorID)) {
      const detail = this.#loadDetails.get(`${letter.target.family}\u0000${letter.target.name}`);
      if (detail !== undefined) {
        return { ...letter, detail };
      }
    }
    return letter;
  }

  /**
   * Create a fresh, unpublished actor of `definition` to replace the named
   * actor `incumbent` in place (core ADR 0043; docs/design.md). It
   * bootstraps like a spawned actor, and core holds its visible bootstrap
   * effects until activate(). `binding` defaults to the incumbent's live
   * data root when the new definition uses the JavaScript data model.
   */
  prepareReplacement(incumbent, definition, options = {}) {
    const { slot, generation } = actorOf(this, incumbent);
    if (!(definition instanceof Definition) || definition.system !== this) {
      throw new TinyactorsError('prepareReplacement(): expected a Definition of this system', 'invalid');
    }
    let binding = options.binding;
    if (binding === undefined && this.#usesJavaScript(definition.id)) {
      const view = core.actor_inspect(this.#native, slot, generation);
      binding = this.#dataRoot(view.definition_id, slot, generation);
    }
    const id = core.actor_prepare_replacement(this.#native, slot, generation, definition.id, binding);
    return new PreparedActor(this, id.slot, id.generation, incumbent);
  }

  /**
   * Publish `prepared` at its incumbent's address, then destroy the
   * incumbent (docs/design.md). Mail still waiting for the incumbent moves,
   * in order, to the front of the replacement's mailbox, so nothing accepted
   * for the address is lost; the incumbent's delayed sends are discarded.
   * Throws `busy` while the incumbent is inside a macrostep. If activation
   * fails, the incumbent keeps the address and the prepared actor is left
   * for the caller to destroy.
   */
  activate(prepared) {
    if (!(prepared instanceof PreparedActor) || prepared.system !== this) {
      throw new TinyactorsError('activate(): expected a prepared actor of this system', 'invalid');
    }
    const { incumbent } = prepared;
    if (this.#native.scheduling(incumbent.slot, incumbent.generation) === 'runnable') {
      throw new TinyactorsError('activate(): the incumbent is inside a macrostep; activate once it is idle', 'busy');
    }
    core.actor_activate_replacement(this.#native, incumbent.slot, incumbent.generation,
      prepared.slot, prepared.generation);
    core.actor_destroy(this.#native, incumbent.slot, incumbent.generation);
    return new ActorID(this, prepared.slot, prepared.generation);
  }

  // The binding load() and reconstruct() pass: the option, or the image's root.
  #bindingFor(image, options) {
    if (options === null || typeof options !== 'object') {
      throw new TinyactorsError('expected options { binding }', 'invalid');
    }
    return options.binding !== undefined ? options.binding : image.data;
  }

  // True when the definition runs the JavaScript data model, under its own
  // name or a registered one (ADR 0019): every data model napi offers but
  // core's null one is the built-in model. Cached.
  #usesJavaScript(definitionID) {
    let javascript = this.#javascript.get(definitionID);
    if (javascript === undefined) {
      javascript = core.definition_inspect(this.#native, definitionID).datamodel !== 'null';
      this.#javascript.set(definitionID, javascript);
    }
    return javascript;
  }

  /** Put an actor that faulted back into scheduling (ADR 0008). */
  release(actor) {
    const { slot, generation } = actorOf(this, actor);
    this.#native.release(slot, generation);
  }

  /*
   * Debugging and operating one actor (ADR 0026, core ADRs 0082 and 0084).
   */

  /**
   * The messages waiting in `actor`'s mailbox, oldest first, at most
   * `limit` (default 100): { event, data, awaited, scope, transition }.
   * `awaited` is true when a send() waits for the message; `scope` is
   * { index, generation } when its origin is an openScope() scope;
   * `transition` is { source, targets } (state IDs, source null for the
   * root) when it carries an operator transition. O(limit).
   */
  mailbox(actor, options = {}) {
    const { slot, generation } = actorOf(this, actor);
    const { limit = 100 } = options ?? {};
    if (!Number.isInteger(limit) || limit < 0 || limit > 4294967295) {
      throw new TinyactorsError('mailbox(): limit must be a non-negative integer', 'invalid');
    }
    const messages = this.#native.mailbox(slot, generation, limit);
    const definition = messages.some((message) => message.transition !== undefined)
      ? core.actor_inspect(this.#native, slot, generation).definition_id
      : undefined;
    const stateName = (state) => (state === NO_STATE ? null : core.definition_state(this.#native, definition, state).id);
    return messages.map((message) => (message.transition === undefined ? message : {
      ...message,
      transition: { source: stateName(message.transition.source), targets: message.transition.targets.map(stateName) },
    }));
  }

  /**
   * Abandon `actor`'s macrostep (core ADR 0082): one that never ends, or an
   * event delivered and not yet taken. The actor keeps the configuration
   * after its last completed microstep; what the macrostep did so far stays
   * done. The send() that follows it rejects with `abandoned`. Throws `busy`
   * while it is paused inside a microstep (the pump finishes that microstep
   * in its next turns, and it can be abandoned between two) or has not
   * finished its bootstrap, `invalid` when no macrostep is in progress,
   * `done` and `not-found` as delivery does.
   */
  abandon(actor) {
    const { slot, generation } = actorOf(this, actor);
    core.actor_abandon(this.#native, slot, generation);
  }

  /**
   * Withdraw `actor`'s pending delayed send `sendID` (core ADR 0084): the
   * `id` inspect() shows in `delayedSends`, such as "#_send.3" or a chart's
   * literal ID. Every pending send of this actor with that ID goes, as a
   * <cancel> of it would. Throws `not-found` when the actor has none, `done`
   * when its only ones were refused once and now belong to their receiver.
   */
  withdrawSend(actor, sendID) {
    const { slot, generation } = actorOf(this, actor);
    if (typeof sendID !== 'string' || sendID === '') {
      throw new TinyactorsError('withdrawSend(): expected a send ID string', 'invalid');
    }
    let id;
    try {
      id = core.send_id_parse(this.#native, sendID);
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        throw new TinyactorsError(`withdrawSend(): no pending send has the ID ${sendID}`, 'not-found');
      }
      throw error;
    }
    try {
      core.actor_withdraw_send(this.#native, slot, generation, id);
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        throw new TinyactorsError(`withdrawSend(): the actor has no pending send ${sendID}`, 'not-found');
      }
      if (error instanceof TinyactorsError && error.code === 'done') {
        throw new TinyactorsError(`withdrawSend(): send ${sendID} was refused once and belongs to its receiver now`, 'done');
      }
      throw error;
    }
  }

  /**
   * Resolves once the system is quiet: nothing runnable, nothing ready, no
   * dead letters to report, and nothing due at the current time (ADR 0007
   * point 4). A delayed send due later does not hold it. It spans as many
   * pump turns as needed and yields to the event loop between them. close()
   * rejects it with `closed`.
   */
  flush() {
    return this.#native.flush();
  }

  /**
   * Memory counters by category and the number of allocator calls
   * (ADRs 0009 and 0014). Throws `closed` after close().
   */
  stats() {
    return this.#native.stats();
  }

  /**
   * A metrics snapshot as plain data (napi ADR 0017 section 7, core ADR
   * 0072): core's counters per definition, state occupancy, and napi's
   * messages and memory, as { startTime, time, system, metrics }, where
   * each metric is { name, unit, kind: "sum" | "gauge", points:
   * [{ attributes, value }] }. Read it from an OpenTelemetry observable
   * instrument, or encode it with metricsToOTLP(). Cheap enough to call at
   * every export interval: it walks definitions, not actors.
   */
  metrics() {
    const native = this.#native;
    const definitions = [];
    // Every definition core holds, nested and invoke-time children included
    // (core ADR 0078); a freed one's counts live on in the system's totals.
    for (const id of this.#definitionIDs(DEFAULT_PAGE_SIZE)) {
      const identity = identityOf(core.definition_inspect(native, id).identity);
      const counters = core.definition_counters(native, id);
      const occupancy = [];
      core.definition_occupancy(native, id).forEach((actors, state) => {
        if (actors !== 0) {
          occupancy.push({ state: core.definition_state(native, id, state).id, actors });
        }
      });
      definitions.push({
        attributes: { 'tinyactors.definition.family': identity.family,
                      'tinyactors.definition.revision': identity.revision },
        counters: numbers(counters),
        occupancy,
      });
    }
    const stats = native.stats();
    const memory = {};
    for (const [category, counters] of Object.entries(stats.memory)) {
      if (category !== 'total') {
        memory[category] = counters.bytesInUse;
      }
    }
    return buildSnapshot({
      startTime: this.#startTime,
      time: Date.now(),
      systemName: this.#metricsName,
      system: numbers(core.system_counters(native)),
      definitions,
      host: { queued: stats.messages.queued, delivered: stats.messages.delivered, memory,
              native: native.hostMetrics() },
    });
  }

  /**
   * Destroy the native system and everything it holds. Idempotent and
   * authoritative: afterwards every method except close() throws `closed`.
   */
  close() {
    if (!this.#native.closed) {
      // Services first: their signals abort and live invocations are
      // cancelled; what core's teardown asks of them afterwards is dropped.
      this.#lifetime.abort();
      for (const handle of [...this.#invocations.keys()]) {
        this.#cancelInvocation(handle, 'closed');
      }
    }
    this.#native.close();
  }

  [Symbol.dispose]() {
    this.close();
  }
}

/*
 * The retained-bytes estimate of a message's data (ADR 0005 point 9):
 * `options.bytes` when given; otherwise 0 for no data and for numbers,
 * booleans, null and the like (they ride inline, ADR 0011), 2 bytes per
 * UTF-16 code unit for a string, byteLength for an ArrayBuffer or a view of
 * one, and a flat 64 bytes for any other object. Objects are not walked:
 * the estimate must stay O(1), so pass `bytes` for large objects.
 */
const OBJECT_BYTES = 64;
/*
 * The origin option of post() and send() (core ADR 0068): who a chart
 * answers with `_event.origin`. { type, uri } is one request's reply URI,
 * { type, scope } names a scope from openScope(), { type, token } a
 * computed origin rendered from the processor's origin template.
 */
function originOf(origin, what) {
  if (origin === undefined) return undefined;
  if (origin === null || typeof origin !== 'object' || typeof origin.type !== 'string') {
    throw new TinyactorsError(`${what}: options.origin must be { type, uri }, { type, scope } or { type, token }`, 'invalid');
  }
  if (origin.scope !== undefined) {
    return { type: origin.type, scope: { index: origin.scope.index, generation: origin.scope.generation } };
  }
  return origin;
}

function retainedBytes(data, options, what) {
  const hint = options?.bytes;
  if (hint !== undefined) {
    if (!(typeof hint === 'number' && hint >= 0 && Number.isFinite(hint))) {
      throw new TinyactorsError(`${what}: options.bytes must be a non-negative number`, 'invalid');
    }
    return Math.ceil(hint);
  }
  switch (typeof data) {
    case 'string':
      return data.length * 2;
    case 'object':
      if (data === null) return 0;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
      return OBJECT_BYTES;
    case 'function':
      return OBJECT_BYTES;
    case 'bigint':
      return 16;
    default:
      return 0;
  }
}

const DEFAULT_PAGE_SIZE = 1024;
const MAX_PAGE_SIZE = 65536;

// The page size of actors() and actorIDs().
function pageSizeOf(options, method) {
  if (options === null || typeof options !== 'object') {
    throw new TinyactorsError(`${method}: options must be an object`, 'invalid');
  }
  const { pageSize = DEFAULT_PAGE_SIZE } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new TinyactorsError(`${method}: pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`, 'invalid');
  }
  return pageSize;
}

// The (slot, generation) of an ActorID of `system` (ADR 0002).
function actorOf(system, actor) {
  if (!(actor instanceof ActorID) || actor.system !== system) {
    throw new TinyactorsError('expected an actor of this system', 'invalid');
  }
  return actor;
}

// How many messages wait for an offloaded actor's load with no loader
// (setLoader's maxWaiting default, napi ADR 0020).
const DEFAULT_MAX_WAITING = 1000;

// A trace parent that names no trace (core ADR 0067).
const NO_TRACE = Object.freeze({
  context: Object.freeze({ trace_id_high: 0, trace_id_low: 0, flags: 0, detail: 0 }),
  cause: Object.freeze({ session: 0, macrostep: 0, microstep: 0 }),
});

// A delayed send's trace parent as traceparent text, or null for none.
function traceparentOf(trace) {
  if (trace === undefined || trace === null || (!trace.context?.trace_id_high && !trace.context?.trace_id_low)) {
    return null;
  }
  try {
    return core.traceparent_format(trace);
  } catch (error) {
    if (error instanceof TinyactorsError) {
      return null;
    }
    throw error;
  }
}

// True when core's actor ref names the inspected actor: its runtime ID, or
// its session ID, which a send to `#_scxml_<session>` keeps after a reload.
function isOwner(view, ref) {
  if (ref?.kind !== 'runtime' || ref.runtime.generation === 0) {
    return false;
  }
  const { slot, generation } = ref.runtime;
  return (slot === view.actor.slot && generation === view.actor.generation) ||
    ((BigInt(generation) << 32n) | BigInt(slot)) === BigInt(view.session_id);
}

// A named address { family, name } with non-empty text (ADR 0006).
function addressOf(address, caller) {
  if (address === null || typeof address !== 'object' ||
      typeof address.family !== 'string' || address.family === '' ||
      typeof address.name !== 'string' || address.name === '') {
    throw new TinyactorsError(`${caller}: expected an address { family, name } of non-empty strings`, 'invalid');
  }
  return address;
}

// The io or invokers option: undefined or an object of services by type.
function servicesOf(value, what) {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== 'object') {
    throw new TinyactorsError(`${what} must be an object of services by type`, 'invalid');
  }
  return value;
}

native.setupEffects(effectHandler);

// A fresh unpublished actor that replaces `incumbent` once activated (step 14).
class PreparedActor extends ActorID {
  constructor(system, slot, generation, incumbent) {
    super(system, slot, generation);
    this.incumbent = incumbent;
  }

  /** False until activate() publishes it at the incumbent's address. */
  get published() {
    return this.system.inspect(this).published;
  }

  /** Publish at the incumbent's address and destroy the incumbent (System.activate). */
  activate() {
    return this.system.activate(this);
  }
}

function createSystem(options) {
  return new System(options);
}

// The text of what a loader threw, for a log and a dead letter's `detail`.
function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// A loader's result that came too late or cannot be used: its image goes.
function discardLoad(result) {
  if (result instanceof SessionImage) {
    result.destroy();
  } else if (result !== null && typeof result === 'object' && result.image instanceof SessionImage) {
    result.image.destroy();
  }
}

module.exports = { System, createSystem, nativeOf, observe, ActorID, PreparedActor, SessionImage };
