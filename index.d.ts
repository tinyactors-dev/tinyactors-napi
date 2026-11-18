// The types of @tinyactors/node and @tinyactors/wasm, one API (docs/api-map.md
// says where @tinyactors/wasm differs today). Every export has a doc comment, which an
// editor shows on hover; README.md and docs/guide/ teach the same API in
// order, with examples. Each declaration is a row of docs/api-map.md,
// which names the core behind it.
//
// Units: time is milliseconds (but telemetry.flushInterval, in the host's
// clock ticks, and traceWatch's seconds); sessions are bigints (inputs also
// take a safe integer from 1, and typed methods' results hold numbers);
// bytes the host hands out are Uint8Arrays (Buffers in @tinyactors/node),
// copied once, yours to keep.

// ---- disposal ------------------------------------------------------------

// `Symbol.dispose`, `Symbol.asyncDispose`, `Disposable` and
// `AsyncDisposable`, which a `Host` and a compile result implement, as
// TypeScript's `esnext.disposable` lib and @types/node declare them: a
// project need not add that lib, and these merge with it where it does.
declare global {
  interface SymbolConstructor {
    readonly dispose: unique symbol;
    readonly asyncDispose: unique symbol;
  }
  interface Disposable {
    [Symbol.dispose](): void;
  }
  interface AsyncDisposable {
    [Symbol.asyncDispose](): PromiseLike<void>;
  }
}

// ---- values -------------------------------------------------------------

/** An actor's session, as an input takes it: a `bigint` from 1 to
 * 2^64-1, or a number that is a safe integer from 1 (as a database or
 * JSON gives one back). Anything else is a `TypeError`. The calls and
 * views return a `bigint`; a typed method's result holds a number, so
 * compare with `Number(session) === listed`. */
export type Session = bigint | number;

/** A value that crosses between your program and a chart: event data,
 * spawn params, a typed method's result, and what `encode` and `decode`
 * convert. Numbers that are safe integers stay integers; integers past
 * 2^53 are `bigint`s (up to 64 bits). Plain objects only: a function, a
 * `Map`, a `Date` or a class's instance is refused. Values are copied when
 * they cross. Inside a value an actor's address is its text. */
export type Value =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Value[]
  | { [key: string]: Value };

/** A {@link Value} the host hands you (`send.data`, `invocation.data`,
 * `decode`, a typed method's variables), typed `any` as `JSON.parse`'s
 * result is: it holds whatever a chart put there, so you read its fields
 * without narrowing first. What it holds at run time is a `Value`. */
export type ReceivedValue = any;

/** What `encode` writes: a {@link Value}, or one holding `Address`es,
 * which it writes as CBOR's tag 32 (an actor reference). */
export type Encodable =
  | Value
  | Address
  | Encodable[]
  | { [key: string]: Encodable };

/** A value as CBOR bytes, the form to store or send it in. An `Address`
 * is tag 32 on its text.
 *
 * Throws a `TinyactorsError`: `TA_ERROR_UNSUPPORTED` for what is not a
 * {@link Value} (a function, a symbol, a `Date`, a `Map`, a class's
 * instance, a typed array other than `Uint8Array`), `TA_ERROR_INVALID` for
 * what a value cannot hold (a string with a lone surrogate, a `bigint` past
 * 64 bits, a cycle or nesting deeper than 64). A getter's exception passes
 * through.
 *
 * @example
 * const bytes = encode({ sku: 'tea', qty: 2 });
 * decode(bytes); // { sku: 'tea', qty: 2 }
 */
export function encode(value: Encodable): Uint8Array;

/** The value of the one CBOR item that fills `bytes`: the inverse of
 * {@link encode}, tag 32 an `Address`. Throws a `TinyactorsError` (`TA_ERROR_INVALID`) for bytes
 * that are not one such item, a `TypeError` for an argument that is not
 * bytes. */
export function decode(bytes: Uint8Array | ArrayBuffer): ReceivedValue;

// ---- errors -------------------------------------------------------------

/** The reason a call was refused, as `TinyactorsError.status` names it:
 * - `TA_ERROR_INVALID`: an argument the host does not take (a chart it
 *   does not have, a config key, malformed bytes);
 * - `TA_ERROR_STALE`: something that ended or never was (a session, a
 *   view read after its handler returned, a closed compile result);
 * - `TA_ERROR_STATE`: not now (a snapshot from a handler, a second
 *   answer, hibernating an actor that is not at rest);
 * - `TA_ERROR_UNSUPPORTED`: a value outside the value table;
 * - `TA_ERROR_NO_MEMORY`: a pool at its largest size, or the system
 *   allocator refused. */
export type Status =
  | 'TA_ERROR_INVALID'
  | 'TA_ERROR_NO_MEMORY'
  | 'TA_ERROR_STATE'
  | 'TA_ERROR_STALE'
  | 'TA_ERROR_UNSUPPORTED'
  | 'TA_ERROR_EXECUTION'
  | 'TA_ERROR_COMMUNICATION'
  | 'TA_ERROR_ABORTED'
  | 'TA_ERROR_FATAL'
  | (string & {});

/** An error the host reported. A refused call has a `status` to branch
 * on; a typed method's error, and a refused config, have `code`, `reason`
 * and `path`, as the host wrote them. The message is for
 * people: do not match on it.
 *
 * @example
 * try { host.send(session, 'go'); }
 * catch (error) { if (error instanceof TinyactorsError && error.status === 'TA_ERROR_STALE') ... }
 */
export class TinyactorsError extends Error {
  constructor(
    message?: string,
    options?: { code?: number; reason?: string; path?: string; status?: Status },
  );
  /** A typed method's error: its JSON-RPC code (`-32001` for a session that
   * does not exist, `-32602` for a param it does not take, ...). */
  readonly code: number | undefined;
  /** A typed method's error: a word for its cause (`stale`, `type`,
   * `unknown`, `range`, `missing`, `state`, ...). */
  readonly reason: string | undefined;
  /** A typed method's error: the param it is about (`params.session`). */
  readonly path: string | undefined;
  /** A refused call's reason. */
  readonly status: Status | undefined;
}

// ---- compiling ----------------------------------------------------------

/** A document to compile: its name, which error messages and `src`
 * attributes name, and its text. */
export interface Source {
  name: string;
  text: string;
}

/** One message of the compiler about a document. */
export interface Diagnostic {
  readonly severity: 'error' | 'warning' | 'note';
  /** The compiler's code for the kind of problem. */
  readonly code: number;
  /** The document's name, as its {@link Source} gave it. */
  readonly file: string;
  /** From 1. */
  readonly line: number;
  /** From 1. */
  readonly column: number;
  readonly message: string;
}

/** A compilation found an error, and compiled nothing. Its message is the
 * first error as a compiler prints it, `file:line:column: error:
 * message`; its status is `TA_ERROR_INVALID`. */
export class CompileError extends TinyactorsError {
  /** Every diagnostic of the compilation: errors, warnings and notes. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Thrown by a {@link Resolver} to refuse a document: the refusal becomes
 * a compile error of the resolved file, at `line` and `column` when given,
 * and the compile call throws a `CompileError`. */
export class ResolveError extends TinyactorsError {
  constructor(message: string, options?: { line?: number; column?: number });
  readonly line: number | undefined;
  readonly column: number | undefined;
}

/** Reads a document a chart names with `src` (`<invoke src>`, `<script
 * src>`, `<data src>`, a manifest's `<chart src>`): the text of `source`,
 * named by the document `base`. Called during the compile call only.
 * Throw a `ResolveError` to refuse; any other error is thrown from the
 * compile call as it is.
 *
 * @example
 * const resolver = (base, source) => readFileSync(join(root, source), 'utf8');
 */
export type Resolver = (base: string, source: string) => string;

/** What a compile call returns: the image and the compiler's warnings. */
export interface Compiled extends Disposable {
  /** The compiled image, for `host.addImage`: a `Uint8Array`, copied on the
   * first read and yours from then on (write it to a file, load it
   * elsewhere). A first read after `close()` throws `TA_ERROR_STALE`. */
  readonly image: Uint8Array;
  /** The warnings and notes of the compilation. */
  readonly diagnostics: readonly Diagnostic[];
  /** Frees the compiler's memory now; the garbage collector does it
   * otherwise. Read `image` first. */
  close(): void;
  /** `close()`. */
  [Symbol.dispose](): void;
}

/** Compiles SCXML documents into one image. Each chart is known by its
 * `<scxml name>`. A `src` is answered by a source of that name or by
 * `resolver`. The first source is the boot chart, which `host.boot`
 * spawns. Throws `CompileError` with every diagnostic. Every expression
 * and script of an `"ecmascript"` chart is parsed by the engine, running
 * nothing: a syntax error is a warning in `diagnostics` (`cond:
 * SyntaxError: ...`, at its element's line and column, a script's own
 * line), and an error with `warningsAsErrors`.
 *
 * @example
 * const compiled = compileCharts([{ name: 'order.scxml', text }]);
 * const segment = host.addImage(compiled.image);
 * compiled.close();
 */
export function compileCharts(sources: readonly Source[], resolver?: Resolver, options?: CompileOptions): Compiled;

/** The options of `compileCharts` and `compileSystem`. */
export interface CompileOptions {
  /** Every warning is an error, and the compile throws `CompileError`:
   * the compiler's own warnings and the syntax errors of the charts'
   * ECMAScript, which are warnings otherwise, since SCXML makes such an
   * expression an `error.execution` when it is evaluated. */
  readonly warningsAsErrors?: boolean;
}

/** Compiles a system manifest: a `<system>` document of `<chart name
 * src>`s, read through `resolver`, and `<actor name chart>`s, which
 * `host.boot` spawns with their names. Throws `CompileError`. */
export function compileSystem(manifest: Source, resolver?: Resolver, options?: CompileOptions): Compiled;

/** A {@link Resolver} that reads each `src` as a file under `root`,
 * relative to the directory of the document that names it (`base`): a
 * document named `orders/order.scxml` asking for `payment.scxml` reads
 * `<root>/orders/payment.scxml`. It refuses with a `ResolveError` (a
 * compile error) a path that leaves `root` (`..` past it, an absolute
 * path, a symbolic link that points outside), a file that does not exist,
 * and text that is not UTF-8; another error of the file system is thrown
 * from the compile call as it is. `root` is resolved through its links
 * once, here: one that does not exist throws now. A document it read is
 * named by its `src` as written. (The convenience layer: JavaScript over
 * `node:fs`.)
 *
 * @example
 * host.addCharts({ 'orders/order.scxml': text }, { resolver: directoryResolver('charts') });
 */
export function directoryResolver(root: string | URL): Resolver;

// ---- addresses ----------------------------------------------------------

/** An actor's address: `tinyactors://<system>/#_scxml_<session>`, or
 * `tinyactors://<system>/@<name>` for a named actor. Immutable. Its parts
 * are read from the text on each access, `undefined` for a part the text
 * lacks (any text makes an `Address`; one that is not an address has no
 * parts). */
export class Address {
  constructor(text: string);
  /** The address of a session of system `system`. */
  static fromSession(system: string, session: Session): Address;
  /** The address of the actor named `name` in system `system`; the name is
   * percent-encoded. */
  static fromName(system: string, name: string): Address;
  readonly text: string;
  /** The system id. */
  readonly system: string | undefined;
  readonly session: bigint | undefined;
  /** The actor's name, decoded. */
  readonly name: string | undefined;
  /** The text. */
  toString(): string;
  /** The text, so `JSON.stringify` writes an address as a string, which
   * `new Address(text)` and `host.send` read back. */
  toJSON(): string;
}

// ---- BasicHTTP ----------------------------------------------------------

/** A form field of a BasicHTTP message. */
export interface HTTPField {
  name: string;
  value: string;
}

/** A BasicHTTP POST, the request SCXML's HTTP processor makes for a send. */
export interface HTTPPost {
  /** `http://host[:port]/path`. */
  url: string;
  /** Written as the `_scxmleventname` field. */
  event?: string;
  fields?: readonly HTTPField[];
  /** The body, used when there are no fields; percent-encoded. */
  body?: string;
}

/** An incoming BasicHTTP request, read. */
export interface HTTPRequest {
  readonly method: string;
  readonly target: string;
  /** The body as received. */
  readonly body: string;
  /** The `_scxmleventname` field, else `HTTP.<METHOD>`. */
  readonly event: string;
  /** The decoded form fields, but `_scxmleventname`. */
  readonly fields: readonly HTTPField[];
}

/** The bytes of a BasicHTTP POST, to write to a socket. A URL that is not
 * `http://host[:port]/path` throws `TA_ERROR_INVALID`. */
export function encodeHTTPPost(post: HTTPPost): Uint8Array;

/** Reads an incoming BasicHTTP request: its event and form fields, for
 * `host.send`. A malformed request throws `TA_ERROR_INVALID`. */
export function parseHTTPRequest(message: Uint8Array | ArrayBuffer): HTTPRequest;

// ---- the clock ----------------------------------------------------------

/** A clock for tests and simulations, which moves only when you move it.
 * Give it to a host as `options.clock`; a host on it arms no timer.
 *
 * @example
 * const clock = new SimulatedClock();
 * const host = new Host(config, { clock });
 * clock.increment(30_000); // a 30-second timeout, at once
 * await host.idle();
 */
export class SimulatedClock {
  constructor();
  /** Milliseconds since the clock was made. */
  readonly now: number;
  /** Moves the clock `ms` forward and schedules a turn on every host made
   * with it; `await host.idle()` to see what ran. What is due runs once, at
   * the new time, and a delay it starts counts from there: to see each of
   * several deadlines, step to each. */
  increment(ms: number): void;
}

// ---- what handlers get ----------------------------------------------------

/** One `<send>` of a chart, as an I/O processor's handler, the transport
 * or a service's `receive` gets it. A view of the host's memory: each
 * field is read on first access, while the handler runs; after the
 * handler returned, a read throws `TA_ERROR_STALE`. When the handler
 * returns a promise, every field is read before the host moves on, and
 * the view stays valid, `answer` and `fail` included, while the host is
 * open. */
export interface Send {
  /** The sender. */
  readonly session: bigint;
  /** The event's name. */
  readonly event: string;
  /** `<send target>`: a string; an `Address` for the transport's sends;
   * `undefined` when the send has none. */
  readonly target: string | Address | undefined;
  /** `<send id>`, or the id the host generated; `undefined` when none. A
   * generated id is unique in the sender's session only (each session's
   * first is `send.1`): key by `session` and `sendid` together. */
  readonly sendid: string | undefined;
  /** The `<param>`s as an object, or the `<content>`'s value. */
  readonly data: ReceivedValue;
  /** The I/O processor's type; `undefined` for the transport and a service. */
  readonly type: string | undefined;
  /** The sender's address. */
  readonly origin: Address | undefined;
  /** The sending step's trace as W3C `traceparent` text, for the header of
   * the request you make; `undefined` when untraced. */
  readonly traceparent: string | undefined;
  /** The outgoing half, `{ target, event, data, sendid, origin,
   * traceparent }`: what `host.send(message)` takes on the other side,
   * unchanged. The transport's reason to exist; present on every send. A
   * text field the send lacks (`sendid`, `origin`, `traceparent`) is
   * `null`, as in a Python host's message, so encoded it is absent to
   * every binding. Its addresses are `Address`es, which `JSON.stringify` writes as their text
   * (`toJSON`) and `encode` as tag 32. */
  readonly message: SendMessage;
  /** Sends `event` back to the sender, with this send's `sendid`. It
   * continues the send's trace unless `options.traceparent` is given
   * (`null`: a new trace). Once: a second answer, or one after `fail()`,
   * throws `TA_ERROR_STATE`, as does a closed host. Returns `true` when the
   * sender gets it, `false` when the sender ended meanwhile (an answer
   * given after the handler returned): nothing is delivered. */
  answer(event: string, data?: Value, options?: AnswerOptions): boolean;
  /** Gives the sender `error.communication` with this send's `sendid`:
   * the request could not be done. Returns `true` when the sender gets it,
   * `false` when it ended meanwhile, as `answer`. */
  fail(): boolean;
}

/** The options of `send.answer`. */
export interface AnswerOptions {
  /** The answer's trace: W3C text, or `null` for a new trace. Absent: the
   * send's. */
  traceparent?: string | null;
  /** The answer's `_event.origin`. */
  origin?: string | Address;
  /** The message as you read it, for the chart's `_event.raw`. */
  raw?: string;
}

/** An event for `host.send(message)` and `host.sendMany(items)`, in the
 * shape `send.message` has. Keys it does not know are ignored. */
export interface SendMessage {
  /** A session, or an address (string or `Address`); a local address is
   * resolved to its actor. */
  target: Session | string | Address;
  event: string;
  data?: Value;
  /** The event's `_event.sendid`. */
  sendid?: string | null;
  /** The event's `_event.origin`: where an answer goes. */
  origin?: string | Address | null;
  /** The trace the event continues, as W3C text; text that does not parse
   * starts a new one. */
  traceparent?: string | null;
}

/** A `<log>` line: a view, valid while the log handler runs. */
export interface LogEntry {
  /** The actor that logged. */
  readonly session: bigint;
  /** `<log label>`; `''` when it has none. */
  readonly label: string;
  /** The value of `<log expr>`, as text. */
  readonly text: string;
}

/** An actor a migration moved: a view, valid while the handler runs. */
export interface Migrated {
  readonly session: bigint;
  /** The segment of its new version. */
  readonly segment: number;
  /** The chart's name. */
  readonly chart: string;
  /** The migration's id, as `host.migrate` returned it. */
  readonly migration: number;
}

/** A session a migration could not move: it stays on its version.
 * `reason` names core's status, `'TA_ERROR_UNSUPPORTED'` when its state
 * cannot be written out (a value outside the value table). */
export interface MigrationFailure {
  readonly session: bigint;
  readonly reason: string;
}

/** A migration's end: how many actors it moved, the ones it could not move
 * and why (they stay on their version), and the sessions its timeout left
 * behind. */
export interface MigrationResult {
  readonly migration: number;
  readonly migrated: number;
  readonly failed: readonly MigrationFailure[];
  readonly pending: readonly bigint[];
}

/** An `<invoke>` of a service your program runs, as a service handler
 * gets it. A record: keep it and use it while the service runs. */
export interface Invocation {
  /** The invoking actor. */
  readonly session: bigint;
  /** The `<invoke id>`, or the id the host generated. */
  readonly invokeid: string;
  /** `<invoke type>`. */
  readonly type: string;
  /** `<invoke src>`. */
  readonly src: string;
  /** The `<param>`s as an object, or the `<content>`'s value. */
  readonly data: ReceivedValue;
  /** The invoking step's trace, as W3C text. */
  readonly traceparent: string | undefined;
  /** True when a restored host announces an invocation that was running
   * at its snapshot: start it again, or a stand-in. */
  readonly restored: boolean;
  /** False once the invocation ended (done, cancelled, failed) or the host
   * closed. */
  readonly running: boolean;
  /** Sends `event` to the invoker, with `_event.invokeid` set. Continues
   * the invoke's trace unless given one (`null`: a new trace). Throws
   * `TA_ERROR_STALE` once the invocation ended. */
  sendBack(event: string, data?: Value, options?: { traceparent?: string | null }): void;
  /** Ends the service: the invoker gets `done.invoke.<invokeid>` with
   * `data`, and the service is dropped without `stop`. Throws
   * `TA_ERROR_STALE` once the invocation ended. */
  done(data?: Value, options?: { traceparent?: string | null }): void;
}

/** What a service handler returns: any object, kept by the host until the
 * invocation ends, whose methods the host calls. At `host.close()` a
 * running service is dropped, not stopped. */
export interface Service {
  /** A send of the invoker to the service (`<send target="#_<invokeid>">`,
   * or an autoforwarded event); `send.type` is `undefined`. A throw, or a
   * promise that rejects, is a crash: the invoker gets
   * `error.communication` and the service is dropped. */
  receive?(host: Host, send: Send): void | Promise<void>;
  /** The invoker left the state, which cancels the invocation. */
  stop?(host: Host): void;
}

// ---- the host -----------------------------------------------------------

/** A chart's current version in a host, from `host.chart(name)`, for
 * `host.spawn`. */
export interface ChartRef {
  /** The segment of the image that holds it. */
  readonly segment: number;
  /** Its index in that image. */
  readonly chart: number;
}

/** The host's config: plain values, checked by the host, every absent key
 * a default (the host's, never the package's). A key the host does not
 * take, or a value of the wrong type, throws a `TinyactorsError`
 * (`TA_ERROR_INVALID`) at `new Host`, with the host's `reason` and the key
 * as `path` (`system.maxActors`). `host.hostConfig()` answers the
 * config with every default filled in, as {@link EffectiveHostConfig}.
 *
 * @example
 * const config = { systemID: 'orders', system: { maxActors: 10_000 }, telemetry: { resource: { 'service.name': 'orders' } } };
 */
export interface HostConfig {
  /** Required: this system's id, part of every address it hands out
   * (`tinyactors://<systemID>/...`). No two systems that talk may share
   * one. */
  systemID: string;
  /** The capacities of each new segment, each its first size, not a cap
   * (a pool that fills grows its segment). */
  system?: SystemConfig;
  /** The I/O processors the charts may send to (`<send type>`), at most
   * 16; each needs a handler in `options.ioProcessors`. Sends to another
   * system need none: they go to `options.transport`. */
  ioProcessors?: readonly IOProcessorConfig[];
  /** Actors a migration looks at per run (default 256). */
  migrateQuantum?: number;
  /** Present: the host has an OTLP encoder, and `options.telemetry` gets
   * its requests. Absent: none, and nothing is paid for it. */
  telemetry?: TelemetryConfig;
}

/** An I/O processor of the config. */
export interface IOProcessorConfig {
  /** The `<send type>` it serves. */
  type: string;
  /** Its location, which `_ioprocessors` shows the charts. */
  location?: string;
}

/** Each new segment's first sizes: unsigned integers, 0 or absent for the
 * host's default; larger values are clamped to the host's limits. */
export interface SystemConfig {
  /** Default 64, at most 8388606. */
  maxActors?: number;
  /** Queued events; default 256. */
  maxEvents?: number;
  /** Delayed sends and timeouts; default 64. */
  maxTimers?: number;
  /** Actors that may be in a step at once; default 4. */
  workspaces?: number;
  /** Default 16. */
  maxRequests?: number;
  /** Default 64. */
  outbox?: number;
  /** Default 1000. */
  quantum?: number;
  /** Default 0: derived from the image and `maxActors`. */
  instanceBytes?: number;
  /** Default 16384 + 16 per actor of `maxActors`. */
  stringBytes?: number;
  /** The host's clock rate; default 1e9 (nanoseconds). */
  ticksPerSecond?: number;
  /** The trace journal; default 131072, at least 65536. */
  traceBytes?: number;
  /** Default `maxEvents`. */
  traceContexts?: number;
  /** Default 16, at most 255. */
  traceRules?: number;
  /** The seed of the trace IDs: the same seed gives the same IDs. Without
   * one, each new host draws a random seed (`crypto.getRandomValues`);
   * set it to reproduce a test's traces. */
  traceSeed?: number;
  /** Write trace records (default true), so export or a watch can be
   * turned on later. */
  tracing?: boolean;
}

/** The OTLP encoder: unsigned integers, 0 or absent for its default. */
export interface TelemetryConfig {
  /** Default 1048576, from 65536 to 1073741824. */
  stagingBytes?: number;
  /** Default a quarter of `stagingBytes`. */
  logBytes?: number;
  /** Default 1024. */
  openSpans?: number;
  /** Default 8 per open span. */
  chunks?: number;
  /** Default 64. */
  scopes?: number;
  /** Default 256. */
  valueLimit?: number;
  /** Default 16384. */
  renderBytes?: number;
  /** Default 4096. */
  resourceBytes?: number;
  /** Default 65536. */
  metricBytes?: number;
  /** Default 64. */
  spanMetricCharts?: number;
  /** A request is ready this long after its first record, in the host's
   * clock ticks; 0 or absent: only when the staging is full. */
  flushInterval?: number;
  /** A macrostep is a root span linked to its cause (default false). */
  linkParents?: boolean;
  /** Event data and assigned values in the spans (default false: they may
   * hold personal data). */
  values?: boolean;
  /** `<log>`s and failed actions as log records (default true). */
  logs?: boolean;
  /** Attributes on every request (`service.name`, ...), at most 32. */
  resource?: { readonly [key: string]: string };
}

/** The config a host runs with, every key present, as `hostConfig`
 * answers it: a host made from it answers the same. */
export interface EffectiveHostConfig {
  readonly systemID: string;
  readonly system: Readonly<Required<SystemConfig>>;
  readonly ioProcessors: readonly Readonly<IOProcessorConfig>[];
  readonly migrateQuantum: number;
  /** Only when the host has an encoder. */
  readonly telemetry?: Readonly<Required<TelemetryConfig>>;
}

/** What a handler returns: nothing, or a promise (typed `unknown`, so a
 * handler that returns another value, as `(host, send) => sent.push(send)`
 * does, is one too; the host ignores it). A send whose handler returns a
 * promise is read in full before the host moves on, and may be answered
 * when the promise gets there. */
export type Handled = unknown;

/** The handlers and choices of a host. A handler's error is reported after
 * its turn: it rejects a waiting `host.idle()`, or else is thrown as an
 * uncaught exception. */
export interface HostOptions {
  /** The handler of each I/O processor type the config lists. A listed
   * type without a handler fails each send to it; a handler for a type the
   * config does not list is a `TypeError`. */
  ioProcessors?: { [type: string]: (host: Host, send: Send) => Handled };
  /** Sends to another system's address. Pass `send.message` to the other
   * side's `host.send`. Without one, each such send is failed. */
  transport?: (host: Host, send: Send) => Handled;
  /** `<log>` lines; without one they are dropped. */
  log?: (host: Host, entry: LogEntry) => void;
  /** A `SimulatedClock`; without one the host reads the runtime's clock
   * and arms a timer at its next deadline. */
  clock?: SimulatedClock;
  /** Your exporter: each OTLP traces or logs request the encoder wrote
   * (protobuf, for a collector's `/v1/traces` or `/v1/logs`), as a
   * `Uint8Array`. Needs `telemetry` in the config; without a handler the
   * requests are dropped. It runs in the host's turn: start the post and
   * return. At `close()` it gets the last requests; the promises it
   * returns then are awaited by `[Symbol.asyncDispose]`. */
  telemetry?: (host: Host, signal: 'traces' | 'logs', data: Uint8Array) => Handled;
  /** A hibernated actor has work: an event or a due delayed send
   * (`migration` undefined), or a migration asks for it (its id). Load its
   * blob and call `host.wake`, now or later. Called once per hibernation;
   * without it the actor stays hibernated, and its events wait, until
   * `host.wake`. */
  wake?: (host: Host, session: bigint, migration: number | undefined) => Handled;
  /** Each actor a migration moved. */
  migrated?: (host: Host, migrated: Migrated) => void;
  /** The end of each migration. */
  migrationDone?: (host: Host, result: MigrationResult) => void;
  /** The handler of each `<invoke type>` your program runs: it returns the
   * service, or a promise of it. Until the promise settles the sends to
   * the invocation wait, in order; a rejection is a failed start, and the
   * invoker gets `error.communication`. */
  services?: { [type: string]: (host: Host, invocation: Invocation) => Service | void | PromiseLike<Service | void> };
  /** Where chart code runs: `'native'` (the default), your own engine
   * (`node:vm` contexts in @tinyactors/node), for trusted charts; or
   * `'quickjs'`, the sandbox, for charts you do not trust (in
   * @tinyactors/wasm the datamodel for a page whose policy forbids
   * `'unsafe-eval'`). */
  datamodel?: 'native' | 'quickjs';
  /** The sandbox's limits, with `datamodel: 'quickjs'` only (else a
   * `TypeError`). */
  quickjs?: QuickJSOptions;
}

/** The quickjs sandbox's limits. Absent: the engine's default. */
export interface QuickJSOptions {
  /** Interrupt checks one evaluation may make before it is stopped with
   * `error.execution` (default 1,000,000, which lets a busy loop run for
   * many seconds). */
  maxOps?: number;
  /** Bytes for the whole engine, every actor together (default 1 GiB,
   * `2 ** 30`; `Number.MAX_SAFE_INTEGER` is as good as none). An
   * evaluation that needs more is stopped with `error.execution`, reason
   * `'memory'`. */
  memoryLimit?: number;
  /** Bytes of native stack for JavaScript. */
  stackLimit?: number;
  /** `'auto'` (the default): the actors of a chart that declares no
   * top-level names share one context and its builtins; `'isolated'`: a
   * context per actor. */
  realm?: 'auto' | 'isolated';
}

/** The options of `host.addCharts`. */
export interface AddChartsOptions {
  /** The compile call's resolver, for each `src` the documents do not
   * answer. */
  resolver?: Resolver;
}

/** The options of `host.spawn`. */
export interface SpawnOptions {
  /** The actor's name: `host.actorByName` finds it, `_name` holds it, and
   * its address is `tinyactors://<system>/@<name>`. */
  name?: string;
  /** Initial values: each key that names a top-level `<data>` replaces that
   * variable's initial value; keys that name none are left out. */
  params?: Value;
  /** The trace the actor's start continues, as W3C text. */
  traceparent?: string;
}

/** The options of `host.send(target, event, data, options)`. */
export interface SendOptions {
  /** The event's `_event.sendid`. */
  sendid?: string;
  /** The trace the event continues, as W3C text; text that does not parse
   * starts a new one. */
  traceparent?: string;
  /** The event's `_event.origin`. */
  origin?: string | Address;
}

/** The options of `host.migrate`. */
export interface MigrateOptions {
  /** A chart's name; none: every chart. */
  chart?: string;
  /** One actor. */
  session?: Session;
  /** Ask the `wake` handler for the hibernated actors, with the
   * migration's id. */
  wake?: boolean;
  /** Milliseconds of the host's clock from now, rounded up to its next
   * tick; 0 or none: no timeout. */
  timeout?: number;
}

/** A typed method's params, passed to the host as given (the host checks
 * them); `undefined` for none. Each method has its own type below. */
export type Params = { [key: string]: Value } | undefined;
/** The params of a method that takes none: `undefined` or `{}`. */
export type NoParams = undefined | { readonly [key: string]: never };
/** A typed method's result handler, called once, in a later turn, with the
 * method's result. */
export type OnResult<R = Value> = (host: Host, result: R) => void;
/** A typed method's error handler. Without one, the error rejects a
 * waiting `idle()` or is thrown as an uncaught exception. */
export type OnError = (host: Host, error: TinyactorsError) => void;

// ---- the typed methods' params and results ---------------------------
//
// As the host writes them (each method of the host's control plane). A
// session or a count in a result is a number; an integer past 2^53 would
// be a bigint, which only `trace.spans.decode`'s nanosecond times reach.

/** An active configuration, as xstate's `value`: an atomic state is its
 * id (`'s'`), a compound state `{ [state]: its active child }`, a parallel
 * state `{ [state]: { [region]: ... } }`, an atomic region `{}`. */
export type StateValue = string | { readonly [state: string]: StateValue };

/** The params of `actorState`, `actorContext` and `actorGet`. */
export interface SessionParams {
  session: Session;
}
/** `actorState`'s result. */
export interface ActorStateResult {
  readonly value: StateValue;
  /**
   * Where each history state the actor has recorded would return, by its
   * id: its parent state as it would be entered again, in the shape of
   * `value` (a deep history down to the atomic states it recorded; a
   * shallow one names the child it recorded). A history state records when
   * its parent is exited; one that has recorded nothing is absent, so this
   * is `{}` before any exit. A hibernated actor's state is refused
   * (`reason` `'state'`): wake it first.
   */
  readonly history: { readonly [history: string]: StateValue };
}
/** `actorContext`'s result: each `<data>`, in the chart's order. */
export interface ActorContextResult {
  readonly variables: { readonly [id: string]: ReceivedValue };
}
/** The params of `actorList`. */
export interface ActorListParams {
  /** From the previous page; absent: the first. */
  cursor?: number;
  /** 1 to 512, default 256. */
  limit?: number;
}
/** `actorList`'s result: a page of sessions. */
export interface ActorListResult {
  readonly sessions: readonly number[];
  /** The next page's cursor, opaque; `null` after the last page. */
  readonly cursor: number | null;
}
/** `actorGet`'s result. */
export interface ActorGetResult {
  readonly session: number;
  readonly segment: number;
  /** The chart's name. */
  readonly chart: string;
  /** The session that invoked it; `null` for a root actor. */
  readonly parent: number | null;
  /** Events waiting for it. */
  readonly mailbox: number;
  /** Services it runs. */
  readonly invocations: number;
  /**
   * Its pending delayed sends (`<send delay>` not yet due, not cancelled),
   * earliest first, at most 32: `timersPending` says how many it has.
   */
  readonly timers: readonly PendingSend[];
  /** How many delayed sends it has pending: more than `timers` holds when the list was cut. */
  readonly timersPending: number;
}
/** A pending delayed send, in `actorGet`'s `timers`. */
export interface PendingSend {
  /** The send's id (its `id`, or the one `idlocation` was given); `null` when it has none. */
  readonly sendid: string | null;
  /** The event's name. */
  readonly event: string;
  /** When it fires: milliseconds on the clock `host.now()` reads. */
  readonly due: number;
}
/** A pool of a segment: its size, what it holds, the most it held. */
export interface Pool {
  readonly capacity: number;
  readonly used: number;
  readonly highWater: number;
}
/** One live segment's pools, in `host.stats`. */
export interface SegmentPools {
  /** The segment, as `addImage` returned it. */
  readonly segment: number;
  readonly actors: Pool;
  readonly events: Pool;
  readonly timers: Pool;
  readonly workspaces: Pool;
  readonly requests: Pool;
  /** The slab of instances and strings, in bytes. */
  readonly slabBytes: Pool;
}
/** One chart's counters, summed over every segment, retired versions
 * included. */
export interface ChartStats {
  readonly name: string;
  readonly actors: number;
  readonly hibernated: number;
  readonly spawned: number;
  readonly ended: number;
  readonly turns: number;
  readonly macrosteps: number;
  readonly fuel: number;
  readonly errorsExecution: number;
  readonly errorsCommunication: number;
  readonly errorsPlatform: number;
  readonly faults: number;
}
/** `hostStats`'s result. */
export interface HostStatsResult {
  readonly host: {
    readonly segments: number;
    readonly actors: number;
    readonly hibernated: number;
    readonly runnable: number;
    readonly migrations: number;
    /** The live segments' regions; the host's copies of the images are not
     * in it. */
    readonly regionBytes: number;
    readonly delivered: number;
    readonly routed: number;
    readonly migrated: number;
    readonly retired: number;
    readonly fuelClock: number;
  };
  /** One entry per live segment, in segment order. */
  readonly pools: readonly SegmentPools[];
  readonly charts: readonly ChartStats[];
}
/** A trace rule of `traceConfigure` and `traceWatch`: each absent field
 * matches anything. */
export interface TraceRule {
  at?: 'start' | 'take';
  chart?: string;
  /** An actor's name; a trailing `*` makes it a prefix. */
  actor?: string;
  /** An event descriptor, SCXML's prefix rule. */
  event?: string;
  session?: Session;
  from?: readonly ('host' | 'actor' | 'timer' | 'spawn' | 'sampled' | 'unsampled')[];
  /** What a match decides (default `'keep'`); a number samples that share
   * of trace IDs. */
  sample?: 'keep' | 'sample' | 'drop' | number;
  detail?: TraceDetail;
  values?: boolean;
  perSecond?: number;
  burst?: number;
}
/** How much a trace records. */
export type TraceDetail = 'summary' | 'decisions' | 'full' | 'off';
/** The params of `traceConfigure`, which replace the last ones. */
export interface TraceConfigureParams {
  /** Default `'summary'`. */
  detail?: TraceDetail;
  /** Default false. */
  values?: boolean;
  /** The share of new traces sampled, 0 to 1 (default 1). */
  sample?: number;
  /** False writes no records; traceparents still flow (default true). */
  records?: boolean;
  /** At most 32. */
  rules?: readonly TraceRule[];
}
/** The params of `traceWatch`. */
export interface TraceWatchParams {
  /** At least one. */
  rules: readonly TraceRule[];
  /** On the host's clock; `null`: no end (default 900). */
  seconds?: number | null;
}
/** `traceWatch`'s result. */
export interface TraceWatchResult {
  readonly id: number;
}
/** The params of `traceUnwatch`. */
export interface TraceUnwatchParams {
  id: number;
}
/** The params of `traceSpansDecode`. */
export interface TraceSpansDecodeParams {
  /** An OTLP traces request, as the telemetry handler gets it. */
  traces: Uint8Array;
}
/** A span event. */
export interface SpanEvent {
  readonly name: string;
  readonly time: number | bigint;
  readonly attributes: { readonly [key: string]: ReceivedValue };
}
/** A span of `traceSpansDecode`. */
export interface Span {
  /** Lowercase hex. */
  readonly trace: string;
  readonly span: string;
  /** `null` for a root span. */
  readonly parent: string | null;
  readonly name: string;
  /** OTLP's span kind. */
  readonly kind: number;
  /** Nanoseconds since the Unix epoch (a bigint past 2^53). */
  readonly start: number | bigint;
  readonly end: number | bigint;
  /** OTLP's status code. */
  readonly status: number;
  readonly statusMessage: string;
  readonly attributes: { readonly [key: string]: ReceivedValue };
  readonly events: readonly SpanEvent[];
}
/** `traceSpansDecode`'s result. */
export interface TraceSpansDecodeResult {
  readonly spans: readonly Span[];
}
/** The result of the methods that answer nothing: `{}`. */
export type EmptyResult = { readonly [key: string]: never };

/** Runs actors: many charts, many images, from a handful of actors to
 * millions, on the runtime's event loop. Inputs (`spawn`, `send`, ...)
 * apply at once and schedule a turn; in its turns the host runs the actors
 * and calls your handlers with what they sent out. There is no `run()`:
 * `await host.idle()` waits until there is nothing left to do.
 *
 * An open host with a pending deadline keeps the process alive, as a
 * `setTimeout` does; `close()` ends it. With no deadline it keeps nothing
 * alive: the process may exit with the host open and actors waiting, for
 * an answer included.
 *
 * @example
 * const host = new Host({ systemID: 'shop' }, { log: (host, entry) => console.log(entry.text) });
 * host.addImage(compileCharts([{ name: 'order.scxml', text }]).image);
 * const order = host.spawn(host.chart('order'));
 * host.send(order, 'checkout');
 * await host.idle();
 * host.close();
 */
export class Host implements Disposable, AsyncDisposable {
  /** A host for `config`, with the handlers and choices of `options`.
   * Throws `TinyactorsError` (`TA_ERROR_INVALID`) for a config the host
   * does not take, `TypeError` for options it does not take. */
  constructor(config: HostConfig, options?: HostOptions);
  /** A new host running a snapshot `host.snapshot()` gave, with the config
   * it was taken with (its `systemID` is checked) and the options `new Host`
   * takes, its `datamodel` the snapshot's. Every session stays the same, and
   * its clock goes on from the snapshot's time, whatever clock reads it.
   * Invocations that were running are announced again to `services`, with
   * `invocation.restored` true. A snapshot of a build whose layout differs
   * throws `TA_ERROR_INVALID`. */
  static restore(snapshot: Uint8Array | ArrayBuffer, config: HostConfig, options?: HostOptions): Host;

  /** The host's clock rate, `system.ticksPerSecond`. */
  readonly ticksPerSecond: number;
  /** True once `close()` ran; every input of a closed host throws. */
  readonly closed: boolean;
  /** Milliseconds from the last idle turn to the next deadline (a delayed
   * send, a timeout, or the telemetry encoder's flush once records are
   * staged); `undefined` for none. An input given since that turn has not
   * run yet, so its deadlines are not in it. */
  readonly nextDeadline: number | undefined;
  /** The quickjs engine's heap in bytes, every actor's together, read on
   * each access (cheap): what `quickjs.memoryLimit` bounds. `undefined` on
   * a native host and once closed. */
  readonly quickjsHeapBytes: number | undefined;

  /** Loads a compiled image, which it copies, and returns its segment, a
   * number. A chart whose name the host already has gets a new version:
   * new actors are of it, running ones stay on theirs until `migrate`.
   * Throws `TA_ERROR_INVALID` for bytes that are not an image. */
  addImage(image: Uint8Array | ArrayBuffer): number;
  /** The current version of chart `name`, for `spawn`. Throws
   * `TA_ERROR_INVALID` when the host has no chart of that name. */
  chart(name: string): ChartRef;
  /** Compiles the documents of `charts` (`{ [name]: text }`, the first
   * key the boot chart), adds the image and closes the compile result, in
   * one call: `compileCharts`, `addImage` and `close()`. Returns the
   * segment. Throws `compileCharts`'s `CompileError`, with every
   * diagnostic, and adds nothing; `TypeError` for `charts` that is not an
   * object or an option it does not take.
   *
   * @example
   * host.addCharts({ 'order.scxml': text });
   * const order = host.spawnChart('order');
   */
  addCharts(charts: { readonly [name: string]: string }, options?: AddChartsOptions): number;
  /** Spawns the boot actors of the image of `segment`: a system manifest's
   * `<actor>`s, or an actor of `compileCharts`' first chart. */
  boot(segment: number): void;
  /** Starts an actor of `ref` and returns its session. It runs in a later
   * turn. */
  spawn(ref: ChartRef, options?: SpawnOptions): bigint;
  /** Starts an actor of the current version of chart `name`:
   * `host.spawn(host.chart(name), options)`. */
  spawnChart(name: string, options?: SpawnOptions): bigint;
  /** Puts `event`, with `data`, in the queue of the actor `target` names (a
   * session or an address). Throws `TA_ERROR_STALE` for an actor that
   * ended. */
  send(target: Session | string | Address, event: string, data?: Value, options?: SendOptions): void;
  /** The same, from a `SendMessage` (the transport's `send.message`). */
  send(message: SendMessage): void;
  /** Tells a sender that its send could not be delivered: the actor
   * `sender` (a session or its address, the send's `origin`) gets
   * `error.communication` with `sendid`. */
  fail(sender: Session | string | Address, sendid?: string): void;
  /** Sends each of `items` in order, and returns how many were taken: the
   * rest, from the first one refused, were not sent. */
  sendMany(items: readonly SendMessage[]): number;
  /** Ends the actor. Throws `TA_ERROR_STALE` for one that already ended. */
  terminate(session: Session): void;
  /** The running actor spawned with `name`, newest segment first, or
   * `undefined`. */
  actorByName(name: string): bigint | undefined;

  /** Resolves at the next turn that finds nothing to do while no promise a
   * handler returned is pending (an I/O processor's, a service's or its
   * `receive`'s, a wake, telemetry, log, migration or typed-method
   * handler's): the same promise to every caller until then. A handler's
   * promise that never settles keeps it pending, and so does a handler
   * that awaits `idle()` itself. Rejects with the turn's first error (a
   * handler's, a typed method's without `onError`), or with
   * `TA_ERROR_STATE` when the host is closed first; on a closed host it
   * returns a promise rejected so. It does not wait for promises your
   * handlers start and do not return. */
  idle(): Promise<void>;
  /** The host's clock in milliseconds, read now: a `SimulatedClock`'s
   * time, or the runtime's monotonic clock, on the scale the host's
   * deadlines and `snapshot()` use, so a restored host's goes on from its
   * snapshot's. A journal of inputs records it beside each input, and a
   * replay on a restored host moves its clock to each reading. It reads
   * and advances nothing; a closed host throws `TA_ERROR_STATE`. */
  now(): number;

  // The typed methods. Each has two forms. Given handlers, `onResult` or
  // `onError` is called once, in a later turn, and the call returns
  // nothing; an error with no `onError` is the turn's (`idle()` rejects
  // with it). Given no handler, the call returns a promise that resolves
  // with the result and rejects with the `TinyactorsError` (`code`,
  // `reason`, `path`); a refusal at the call rejects too. A rejection is
  // yours: without a `catch` it is an unhandled rejection, and `idle()`
  // does not see it. Each reads the host when called; `close()` drops a
  // pending method uncalled, and its promise never settles.

  /** An actor's active states, `{ value, history }`: a state id, or `{
   * parent: child }` for compound states. Params `{ session }`. `const {
   * value } = await host.actorState({ session })`. */
  actorState(params: SessionParams, onResult: OnResult<ActorStateResult>, onError?: OnError | null): void;
  /** `actorState` given no handler: a promise of `{ value, history }`. */
  actorState(params: SessionParams): Promise<ActorStateResult>;
  /** An actor's variables, `{ variables }`. Params `{ session }`; refused
   * for a hibernated actor. A variable that holds `undefined` reads
   * `undefined`, apart from `null`; before the actor's first turn every
   * variable is `undefined`, its spawn params included. */
  actorContext(params: SessionParams, onResult: OnResult<ActorContextResult>, onError?: OnError | null): void;
  /** `actorContext` given no handler: a promise of `{ variables }`. */
  actorContext(params: SessionParams): Promise<ActorContextResult>;
  /** The host's sessions a page at a time, `{ sessions, cursor }`, `cursor`
   * `null` after the last page. Params `{ cursor?, limit? }` (1 to 512,
   * default 256). */
  actorList(params: ActorListParams | undefined, onResult: OnResult<ActorListResult>, onError?: OnError | null): void;
  /** `actorList` given no handler: a promise of a page, `{ sessions, cursor }`. */
  actorList(params?: ActorListParams): Promise<ActorListResult>;
  /** One actor, `{ session, segment, chart, parent, mailbox, invocations,
   * timers, timersPending }`. Params `{ session }`. */
  actorGet(params: SessionParams, onResult: OnResult<ActorGetResult>, onError?: OnError | null): void;
  /** `actorGet` given no handler: a promise of the actor. */
  actorGet(params: SessionParams): Promise<ActorGetResult>;
  /** The host's counters, `{ host, pools, charts }`: `pools` has one entry
   * per live segment with each pool's `capacity`, `used` and `highWater`.
   * No params: `await host.hostStats()`. */
  hostStats(params: NoParams, onResult: OnResult<HostStatsResult>, onError?: OnError | null): void;
  /** `hostStats` given no handler: a promise of the counters. */
  hostStats(params?: NoParams): Promise<HostStatsResult>;
  /** The config the host runs with, every default filled in. No params. */
  hostConfig(params: NoParams, onResult: OnResult<EffectiveHostConfig>, onError?: OnError | null): void;
  /** `hostConfig` given no handler: a promise of the effective config. */
  hostConfig(params?: NoParams): Promise<EffectiveHostConfig>;
  /** Sets what every actor traces: `{ detail, values, sample, records,
   * rules }`. */
  traceConfigure(params: TraceConfigureParams | undefined, onResult: OnResult<EmptyResult>, onError?: OnError | null): void;
  /** `traceConfigure` given no handler: a promise of `{}`. */
  traceConfigure(params?: TraceConfigureParams): Promise<EmptyResult>;
  /** Adds trace rules for a while: `{ rules, seconds }` (default 900);
   * answers `{ id }`. */
  traceWatch(params: TraceWatchParams, onResult: OnResult<TraceWatchResult>, onError?: OnError | null): void;
  /** `traceWatch` given no handler: a promise of `{ id }`. */
  traceWatch(params: TraceWatchParams): Promise<TraceWatchResult>;
  /** Ends a watch early: `{ id }`. */
  traceUnwatch(params: TraceUnwatchParams, onResult: OnResult<EmptyResult>, onError?: OnError | null): void;
  /** `traceUnwatch` given no handler: a promise of `{}`. */
  traceUnwatch(params: TraceUnwatchParams): Promise<EmptyResult>;
  /** Ends every open span now, marked incomplete, for the telemetry handler.
   * Refused without `telemetry` in the config. */
  traceEnd(params: NoParams, onResult: OnResult<EmptyResult>, onError?: OnError | null): void;
  /** `traceEnd` given no handler: a promise of `{}`. */
  traceEnd(params?: NoParams): Promise<EmptyResult>;
  /** The spans of a traces request: `{ traces }` (the bytes) answers `{
   * spans }`, each with `trace`, `span`, `parent`, `name`, `start`, `end`,
   * `attributes`, ... */
  traceSpansDecode(params: TraceSpansDecodeParams, onResult: OnResult<TraceSpansDecodeResult>, onError?: OnError | null): void;
  /** `traceSpansDecode` given no handler: a promise of `{ spans }`. */
  traceSpansDecode(params: TraceSpansDecodeParams): Promise<TraceSpansDecodeResult>;

  /** The host's counters now as an OTLP metrics request (a `Uint8Array`, for a
   * collector's `/v1/metrics`). `TA_ERROR_STATE` without `telemetry` in the
   * config. */
  metrics(): Uint8Array;
  /** Finds cold actors: at most `limit` sessions that did not run since
   * the previous sweep and can be hibernated now, looking at most at `maxScan`
   * actors (each an integer from 0 to 2^32-1). The first sweep after an
   * actor ran skips it. */
  sweep(maxScan: number, limit: number): bigint[];
  /** Takes the actor out of memory and returns its blob (a `Uint8Array`) for
   * your store. `TA_ERROR_STATE` when it is not at rest (events waiting, a
   * step not over, running an invoked child or service) and when it is not
   * resident (already hibernated, its wake asked for and not given): the
   * status does not tell the two apart. `TA_ERROR_STALE` for a session that
   * ended or never was, `TA_ERROR_UNSUPPORTED` when a variable holds what
   * the datamodel cannot store (the message names it); it stays where it
   * is then. */
  hibernate(session: Session): Uint8Array;
  /** Puts a hibernated actor back from the blob `hibernate` gave; its
   * waiting events run at the next turn. Only its latest blob: one of an
   * earlier hibernation (a store that fell behind) throws `TA_ERROR_STALE`,
   * another session's `TA_ERROR_INVALID`, and the actor stays hibernated.
   * On a restored host a blob of a hibernation made after the snapshot is
   * taken too. */
  wake(session: Session, blob: Uint8Array | ArrayBuffer): void;
  /** Starts moving running actors (every chart's, `chart`'s, or one
   * `session`) to the current version of their chart, in later turns; each
   * gets `error.platform.upgrade` with its old variables. Returns the
   * migration's id, which `migrated`, `migrationDone` and the wake handler
   * name. Throws `TA_ERROR_INVALID` for a chart the host does not have and
   * `TA_ERROR_STALE` for a session that ended. */
  migrate(options?: MigrateOptions): number;
  /** The whole host as one `Uint8Array`: every segment, the images, the system
   * id, the host's time (its clocks advanced first: the time of the call,
   * as `now()` reads it) and the datamodel's state, for `Host.restore` on the
   * same build of the package. Only when quiescent: from a handler, with an
   * effect or a reply pending, or during a migration it throws
   * `TA_ERROR_STATE`; a value outside the value table throws
   * `TA_ERROR_UNSUPPORTED`. */
  snapshot(): Uint8Array;

  /** Frees the host: the last telemetry requests go to the handler, the
   * timer is cleared, pending typed methods and running services are
   * dropped without being called. From a handler it waits for the end of
   * the turn. Again: nothing. */
  close(): void;
  /** `close()`. */
  [Symbol.dispose](): void;
  /** `close()`, then the promises the telemetry handler returned at it. */
  [Symbol.asyncDispose](): Promise<void>;
}
