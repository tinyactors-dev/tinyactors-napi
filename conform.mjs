// The conformance suite's adapter: tinyactors-test/docs/driver.md over the
// package's public module, `@tinyactors/node`, and `node:` built-ins only
// (its lint, tinyactors-test/lint, refuses any other import). Translated
// from tinyactors-cpython/conform/__main__.py.
//
// Run by `mise run conform` as `node conform.mjs` or `bun conform.mjs`.
// Frames are a four-byte big-endian length and one CBOR message, read and
// written with the package's own decode and encode. Calls are answered one
// at a time, in order. Each driver method is the binding's own calls, as an
// application makes them: a host is a Host on the runtime's event loop
// (`await host.idle()` waits for the turns it drives), a control message is
// the typed method of its name, what goes to another system leaves through
// the host's transport, and BasicHTTP is a real POST written and read by
// core's codec (encodeHTTPPost, parseHTTPRequest). Standard output holds
// frames only; diagnostics go to standard error. The adapter exits with
// status 0 when its input ends.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import {
  CompileError,
  Host,
  MemoryStore,
  ResolveError,
  SimulatedClock,
  TinyactorsError,
  compileCharts,
  decode,
  encode,
  encodeHTTPPost,
  parseHTTPRequest,
} from '@tinyactors/node';

// ta_status by the name ta_status_name gives (tinyactors/types.h): what the
// driver reports as "status".
const STATUS = {
  TA_OK: 0,
  TA_ERROR_EXECUTION: -1,
  TA_ERROR_COMMUNICATION: -2,
  TA_ERROR_INVALID: -3,
  TA_ERROR_NO_MEMORY: -4,
  TA_ERROR_STALE: -5,
  TA_ERROR_STATE: -6,
  TA_ERROR_UNSUPPORTED: -7,
  TA_ERROR_FATAL: -8,
  TA_ERROR_ABORTED: -9,
};
// ta_run's statuses (tinyactors/system.h) host.run reports.
const TA_RUN_IDLE = 0;
const TA_RUN_EXHAUSTED = 3;
const TA_RUN_FAULT = 4;
// The driver's datamodel names; both are "ecmascript" on Node, so a host
// holds only the one asked for (driver.md, "The chart language").
const DATAMODELS = new Set(['native', 'quickjs']);
// requests.md's methods a binding offers as typed methods (all but
// actor.send, which is host.send), by their names in the message.
const TYPED = new Map(
  ['actor.state', 'actor.context', 'actor.list', 'actor.get', 'host.stats', 'host.config', 'trace.configure',
    'trace.watch', 'trace.unwatch', 'trace.end', 'trace.spans.decode'].map((name) => [
    name,
    name.replace(/\.(\w)/g, (_, letter) => letter.toUpperCase()),
  ]),
);

class DriverError extends Error {
  constructor(code, reason, path, message) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.path = path;
  }
}

// A ta_status for what the binding threw: a TinyactorsError's status, else
// TA_ERROR_INVALID (a TypeError: the input the API refused).
function statusOf(error) {
  if (error instanceof TinyactorsError && error.status in STATUS) return STATUS[error.status];
  return STATUS.TA_ERROR_INVALID;
}

// A TinyactorsError from a reply or a refused config, as core wrote it.
function errorMap(error) {
  return { code: error.code, message: error.message ?? '', data: { reason: error.reason, path: error.path } };
}

function required(params, name) {
  if (!(name in params)) throw new DriverError(-32602, 'missing', `params.${name}`, `params.${name}: missing`);
  return params[name];
}

function datamodelOf(params) {
  const datamodel = params.datamodel ?? 'quickjs';
  if (!DATAMODELS.has(datamodel)) throw new DriverError(-32602, 'range', 'params.datamodel', 'no such datamodel');
  return datamodel;
}

// The Host options that pick the datamodel: quickjs's realm only for quickjs.
function engine(params) {
  const datamodel = datamodelOf(params);
  const options = { datamodel };
  if (datamodel === 'quickjs' && params.realm !== undefined) options.quickjs = { realm: params.realm };
  return options;
}

// The resolver of a call's documents: a `src` names one by its name, with a
// leading file://, file: or ./ removed (driver.md, "src").
function resolverOf(documents) {
  const named = new Map(documents.map((document) => [document.name, document.text]));
  return (base, source) => {
    for (const prefix of ['file://', 'file:', './']) {
      if (source.startsWith(prefix)) source = source.slice(prefix.length);
    }
    if (!named.has(source)) throw new ResolveError(`no document named ${source}`);
    return named.get(source);
  };
}

// Charts compiled into one image, added to the host: the segment. The
// compile result is freed once the host copied the image.
function compileImage(host, charts, documents) {
  const compiled = compileCharts(
    charts.map(({ name, text }) => ({ name, text })),
    { resolver: resolverOf(documents) },
  );
  try {
    return host.addImage(compiled.image);
  } finally {
    compiled.close();
  }
}

// The data of a send to another system as bytes for the wire: the value
// table's CBOR, written with ECMAScript's wire rules, as JSON writes
// undefined (null at the top and in arrays, dropped from objects): the
// transport and the wire encoding are the application's, and an ECMAScript
// datamodel's to_wire writes the same (values.txt, "ECMAScript: undefined
// at the top is null").
function wire(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(wire);
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = wire(item);
    return out;
  }
  return value;
}

// An I/O processor a protocol vector's config declares: every send to it
// fails (error.communication), as the vectors expect of a processor nobody
// serves.
class Endpoint {
  constructor(location) {
    if (location !== undefined) this.location = location;
  }

  receive(send) {
    send.fail();
  }
}

// A protocol vector's whole config as Host's options: system, ioProcessors
// and the rest of the config. Host takes the system id and the I/O
// processors apart from the config (an object of processors by type), so
// a config whose shape those options cannot hold (not a map, an
// ioProcessors that is not a list of maps with a type and at most a
// location) is no config the binding can send: the suite marks such vectors
// "only reference", and the adapter refuses one as the driver's own error
// rather than writing core's (docs/driver.md, "Kinds").
function hostOptions(config) {
  const cannot = (path) => new DriverError(-32602, 'type', `params.config${path}`, 'a config Host\'s options cannot hold (a reference-only case)');
  if (config === null || typeof config !== 'object' || Array.isArray(config) || config instanceof Uint8Array) throw cannot('');
  const { systemID, ioProcessors: entries, ...rest } = config;
  const options = { system: systemID, config: rest };
  if (entries === undefined) return options;
  if (!Array.isArray(entries)) throw cannot('.ioProcessors');
  options.ioProcessors = {};
  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string' ||
      Object.keys(entry).some((key) => key !== 'type' && key !== 'location')) throw cannot(`.ioProcessors[${index}]`);
    options.ioProcessors[entry.type] = new Endpoint(entry.location);
  });
  return options;
}

class Adapter {
  constructor() {
    this.host = null;
    this.clock = null;
    this.sends = [];
    this.error = null;
  }

  needHost() {
    if (this.host === null) throw new DriverError(-32002, 'state', '', 'no host: call host.create first');
    return this.host;
  }

  // The turns an input scheduled, waited for so an error they report is
  // kept for host.run rather than thrown with no one waiting.
  async settle() {
    try {
      await this.host.idle();
    } catch (error) {
      this.error ??= error;
    }
  }

  // ---- the protocol vectors' methods ----------------------------------------

  'host.create'(params) {
    if (this.host !== null) throw new DriverError(-32002, 'state', '', 'a host already: call host.free first');
    const options = engine(params);
    const config = hostOptions(decode(required(params, 'config')));
    const clock = new SimulatedClock();
    const sends = [];
    // A send to another system: kept for host.run, its data written for the
    // wire (no data reads as undefined, written as null).
    const transport = (send) => {
      sends.push({
        target: send.target.text,
        event: send.event,
        origin: send.origin?.text ?? '',
        data: encode(wire(send.data)),
      });
    };
    try {
      this.host = new Host([], { ...config, ...options, clock, transport });
    } catch (error) {
      const result = { status: statusOf(error) };
      if (error instanceof TinyactorsError && error.code !== undefined) result.error = encode({ error: errorMap(error) });
      return result;
    }
    this.clock = clock;
    this.sends = sends;
    this.error = null;
    return { status: 0, datamodel: 'ecmascript' };
  }

  'host.free'() {
    this.needHost().close();
    this.host = null;
    return {};
  }

  // The message's method is the typed method of its name; its reply is
  // built from what the method's handler or onError got, with the
  // message's id (driver.md, "Kinds").
  async 'host.post'(params) {
    const host = this.needHost();
    const message = decode(required(params, 'message'));
    const typed = message !== null && typeof message === 'object' ? TYPED.get(message.method) : undefined;
    const given = typed === undefined ? undefined : message.params;
    if (typed === undefined || (given !== undefined && (given === null || typeof given !== 'object' || Array.isArray(given)))) {
      throw new DriverError(-32602, 'type', 'params.message', 'a binding sends the typed methods of requests.md only');
    }
    const answered = [];
    try {
      host[typed](
        given,
        (result) => answered.push({ result }),
        (error) => answered.push({ error: errorMap(error) }),
      );
    } catch (error) {
      return { status: statusOf(error) };
    }
    await this.settle();
    const result = { status: 0, notifications: [] };
    // actor.get's due times are milliseconds on host.now()'s clock: back to core's ticks
    if (message.method === 'actor.get') {
      for (const timer of answered[0]?.result?.timers ?? []) timer.due = Math.round((timer.due * host.ticksPerSecond) / 1000);
    }
    if (answered.length > 0 && 'id' in message) result.reply = encode({ id: message.id, ...answered[0] });
    return result;
  }

  async 'image.add'(params) {
    const host = this.needHost();
    const charts = required(params, 'charts');
    try {
      return { status: 0, segment: compileImage(host, charts, charts) };
    } catch (error) {
      if (error instanceof CompileError) return { status: STATUS.TA_ERROR_INVALID };
      return { status: statusOf(error) };
    }
  }

  async 'actor.spawn'(params) {
    const host = this.needHost();
    let session;
    try {
      session = host.spawn(host.chart(required(params, 'chart')), { params: params.params }).id;
    } catch (error) {
      return { status: statusOf(error) };
    }
    await this.settle();
    return { status: 0, session };
  }

  async 'actor.send'(params) {
    const host = this.needHost();
    let data = params.data;
    if ('cbor' in params) {
      try {
        data = decode(params.cbor);
      } catch {
        return { status: STATUS.TA_ERROR_INVALID };
      }
    }
    try {
      host.send(BigInt(required(params, 'session')), required(params, 'event'), data, { origin: params.origin });
    } catch (error) {
      return { status: statusOf(error) };
    }
    await this.settle();
    return { status: 0 };
  }

  // The monotonic clock to `monotonic` ticks, as the simulated clock's
  // milliseconds; it never goes back. The simulated clock is the host's
  // wall clock too, so wallNs is not applied.
  async 'clock.advance'(params) {
    const host = this.needHost();
    const milliseconds = (Number(params.monotonic ?? 0) * 1000) / host.ticksPerSecond;
    if (milliseconds > this.clock.now) this.clock.increment(milliseconds - this.clock.now);
    await this.settle();
    return {};
  }

  async 'host.run'() {
    this.needHost();
    await this.settle();
    let status = TA_RUN_IDLE;
    const error = this.error;
    this.error = null;
    if (error !== null) {
      status = error instanceof TinyactorsError && error.status === 'TA_ERROR_NO_MEMORY' ? TA_RUN_EXHAUSTED : TA_RUN_FAULT;
      process.stderr.write(`conform: the run ended: ${error?.stack ?? error}\n`);
    }
    const sends = this.sends.splice(0);
    return { status, sends, notifications: [] };
  }

  // ---- scenarios -------------------------------------------------------------

  async 'scenario.run'(params) {
    const options = engine(params);
    return { outcome: await new Scenario(required(params, 'documents'), options).run(required(params, 'steps')) };
  }

  async 'w3c.run'(params) {
    const options = engine(params);
    return { outcome: await new W3C(required(params, 'documents'), options).run() };
  }
}

// A step the host refused: the scenario fails (driver.md).
class Refused extends Error {}

// The first Outcome log decides (driver.md, "The scenario environment").
class Judge {
  constructor() {
    this.outcome = undefined;
    this.log = (entry) => {
      if (this.outcome === undefined && entry.label === 'Outcome') this.outcome = entry.text === 'pass' ? 'pass' : 'fail';
    };
  }
}

// scenario.run in the scenario environment (driver.md): a host of its own
// on a simulated clock, the steps' calls, the turns until idle after each,
// and the first Outcome log.
class Scenario {
  static CONFIG = { system: 'conformance', config: { system: { ticksPerSecond: 1000 } } };

  constructor(documents, options) {
    this.documents = documents;
    this.options = options;
    this.aliases = new Map();
    this.judge = new Judge();
    this.clock = new SimulatedClock();
    this.store = new MemoryStore(); // the implementation's store (driver.md): hibernated actors' blobs
    this.snapshots = new Map(); // the snapshots the steps took, by name
    this.migrationsDone = []; // the results migrationDone got
    this.migrationDone = (result) => this.migrationsDone.push(result);
    this.host = null;
  }

  // "@alias" at any depth: that actor's address.
  value(value) {
    if (typeof value === 'string' && value.startsWith('@') && this.aliases.has(value.slice(1))) {
      return `#_scxml_${this.aliases.get(value.slice(1)).id}`;
    }
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.value(item)]));
    }
    return value;
  }

  // The host's options: the datamodel asked for, and the scenario's handlers.
  hostOptions() {
    return { ...Scenario.CONFIG, ...this.options, log: this.judge.log, clock: this.clock, store: this.store, migrationDone: this.migrationDone };
  }

  async run(steps) {
    this.host = new Host([], this.hostOptions());
    try {
      for (const step of steps) {
        try {
          await this.step(this.host, step);
          if (this.judge.outcome === undefined) await this.host.idle();
        } catch (error) {
          if (error instanceof CompileError) {
            process.stderr.write(`conform: a document does not compile: ${error.message}\n`);
            this.judge.outcome ??= 'compile';
          } else {
            process.stderr.write(`conform: the step ${JSON.stringify(step, (_, v) => (typeof v === 'bigint' ? `${v}` : v))} was refused: ${error?.stack ?? error}\n`);
            this.judge.outcome ??= 'fail';
          }
        }
        if (this.judge.outcome !== undefined) break;
      }
    } finally {
      this.host.close();
    }
    return this.judge.outcome ?? 'timeout';
  }

  async step(host, step) {
    if ('image' in step) {
      const named = new Map(this.documents.map((document) => [document.name, document]));
      const missing = step.image.filter((name) => !named.has(name));
      if (missing.length > 0) throw new Refused(`image names documents the call does not have: ${missing.join(', ')}`);
      compileImage(host, step.image.map((name) => named.get(name)), this.documents);
    } else if ('spawn' in step) {
      this.aliases.set(step.spawn, host.spawn(step.chart, { name: step.spawn, params: this.value(step.params) }));
    } else if ('send' in step) {
      host.send(this.session(step.send), step.event, this.value(step.data));
    } else if ('sendMany' in step) {
      const items = step.sendMany.map((item) => ({
        target: this.session(item.to),
        event: item.event,
        data: this.value(item.data),
      }));
      if (host.sendMany(items) !== items.length) throw new Refused('sendMany took fewer events');
    } else if ('advance' in step) {
      this.clock.increment(Number(step.advance)); // ticksPerSecond 1000: ticks are milliseconds
    } else if ('hibernate' in step) {
      const actor = this.session(step.hibernate);
      this.store.save(actor.id, host.hibernate(actor));
    } else if ('snapshot' in step) {
      this.snapshots.set(step.snapshot, host.snapshot());
    } else if ('restore' in step) {
      if (!this.snapshots.has(step.restore)) throw new Refused(`a restore of a snapshot no step took: ${step.restore}`);
      const restored = Host.restore(this.snapshots.get(step.restore), [], this.hostOptions());
      host.close();
      this.host = restored; // a restart: the restored host replaces the running one
    } else if ('migrate' in step) {
      const ended = this.migrationsDone.length;
      // ticksPerSecond 1000: the step's ticks are milliseconds
      host.migrate({ wake: Boolean(step.migrate.wake), timeout: Number(step.migrate.timeout ?? 0) });
      for (let i = 0; i < 100 && this.migrationsDone.length === ended; i++) await host.idle(); // until its MIGRATION_DONE, bounded as ta-conform's settles
      if (this.migrationsDone.length === ended) throw new Refused('the migration did not end');
    } else {
      throw new Refused(`not in the binding's API yet: ${Object.keys(step).join(', ')}`);
    }
  }

  session(alias) {
    if (!this.aliases.has(alias)) throw new Refused(`a send to an alias no spawn made: ${alias}`);
    return this.aliases.get(alias);
  }
}

// A value in CBOR diagnostic notation (RFC 8949, section 8), as a form
// field's text: what ta-conform writes with ta_cbor_diagnostic.
function diagnostic(value) {
  if (value === true || value === false) return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return Object.is(value, -0) ? '-0.0' : String(value);
  }
  if (ArrayBuffer.isView(value)) return `h'${Buffer.from(value).toString('hex')}'`;
  if (Array.isArray(value)) return `[${value.map(diagnostic).join(', ')}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `${diagnostic(key)}: ${diagnostic(item)}`)
    .join(', ')}}`;
}

// The form of a BasicHTTP send (SCXML 1.0, C.2.1): the fields of its data
// when it is a map (each value as text: text as it is, anything else in
// diagnostic notation), or the data as the body when it is text.
function form(data) {
  if (typeof data === 'string') return { fields: [], body: data };
  if (data !== null && typeof data === 'object' && !Array.isArray(data) && !ArrayBuffer.isView(data)) {
    return {
      fields: Object.entries(data).map(([name, value]) => ({
        name,
        value: typeof value === 'string' ? value : diagnostic(value),
      })),
      body: '',
    };
  }
  return { fields: [], body: '' };
}

// w3c.run in the W3C environment (driver.md): the start chart booted on a
// host of its own, BasicHTTP written as a POST and read back for its
// sender, and the clock moved to the next deadline whenever the host is
// idle.
class W3C {
  static LOCATION = 'http://localhost:8080/scxml';
  static BASIC_HTTP = 'http://www.w3.org/TR/scxml/#BasicHTTPEventProcessor';
  static CONFIG = { system: 'w3c', config: { system: { ticksPerSecond: 1000, maxEvents: 1024, maxActors: 64 } } };
  static ROUNDS = 200;

  constructor(documents, options) {
    this.documents = documents;
    this.options = options;
    this.judge = new Judge();
  }

  // A send to BasicHTTP: written as a POST by core's codec, read back as an
  // incoming request, and delivered to its sender; a send to another
  // target, or one that cannot be written, fails.
  post(send) {
    const target = send.target ?? '';
    if (!target.startsWith(W3C.LOCATION)) {
      send.fail();
      return;
    }
    let message;
    try {
      message = encodeHTTPPost({ url: target, event: send.event, ...form(send.data) });
    } catch (error) {
      process.stderr.write(`conform: the POST cannot be written: ${error.message}\n`);
      send.fail();
      return;
    }
    const request = parseHTTPRequest(message);
    const data = Object.fromEntries(request.fields.map(({ name, value }) => [name, value]));
    send.answer(request.event, data, { origin: W3C.LOCATION, raw: Buffer.from(message).toString('latin1') });
  }

  async run() {
    const charts = this.documents.filter((document, index) => index === 0 || document.name.endsWith('.scxml'));
    const clock = new SimulatedClock();
    const host = new Host([], {
      ...W3C.CONFIG,
      ...this.options,
      ioProcessors: { [W3C.BASIC_HTTP]: { location: W3C.LOCATION, receive: (send) => this.post(send) } },
      log: this.judge.log,
      clock,
    });
    try {
      let segment;
      try {
        segment = compileImage(host, charts, this.documents);
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        process.stderr.write(`conform: a document does not compile: ${error.message}\n`);
        return 'compile';
      }
      host.boot(segment);
      for (let round = 0; round < W3C.ROUNDS; round++) {
        await host.idle();
        const delay = host.nextDeadline;
        if (this.judge.outcome !== undefined || delay === undefined) break;
        clock.increment(Math.max(1, Math.ceil(Math.round(delay * 1e6) / 1e6))); // ticksPerSecond 1000
      }
    } catch (error) {
      process.stderr.write(`conform: the run ended: ${error?.stack ?? error}\n`);
    } finally {
      host.close();
    }
    return this.judge.outcome ?? 'timeout';
  }
}

// ---- frames ------------------------------------------------------------------

const adapter = new Adapter();
const OFFERED = new Set([
  'host.create', 'host.free', 'host.post', 'image.add', 'actor.spawn', 'actor.send', 'clock.advance', 'host.run',
  'scenario.run', 'w3c.run',
]);

function failure(id, error) {
  return { id, error: { code: error.code, message: error.message, data: { reason: error.reason, path: error.path } } };
}

async function answer(frame) {
  let call;
  try {
    call = decode(frame);
  } catch (error) {
    return failure(null, new DriverError(-32700, 'malformed', '', `the frame is not CBOR: ${error.message}`));
  }
  if (call === null || typeof call !== 'object' || Array.isArray(call) || !Number.isInteger(call.id)) {
    return failure(null, new DriverError(-32600, 'malformed', '', 'not a call: a map with an integer id'));
  }
  if (!OFFERED.has(call.method)) {
    return failure(call.id, new DriverError(-32601, 'unknown', 'method', `${call.method} is not offered`));
  }
  try {
    return { id: call.id, result: await adapter[call.method](call.params ?? {}) };
  } catch (error) {
    if (error instanceof DriverError) return failure(call.id, error);
    throw error;
  }
}

function write(reply) {
  const body = encode(reply);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

// The input as it arrives: whole frames are answered in order, each after
// the one before it settled.
let pending = Buffer.alloc(0);
let queue = Promise.resolve();

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const size = pending.readUInt32BE(0);
    if (pending.length < 4 + size) break;
    const frame = new Uint8Array(pending.subarray(4, 4 + size));
    pending = pending.subarray(4 + size);
    queue = queue.then(() => answer(frame)).then(write);
  }
});

process.stdin.on('end', () => {
  queue.then(() => {
    if (pending.length > 0) {
      process.stderr.write(`conform: the input ended inside a frame (${pending.length} bytes)\n`);
      process.exitCode = 1;
    }
    adapter.host?.close();
  });
});

// An error the adapter did not expect is a crash the runner reports with
// standard error's end.
process.on('unhandledRejection', (error) => {
  process.stderr.write(`conform: ${error?.stack ?? error}\n`);
  process.exit(70);
});
