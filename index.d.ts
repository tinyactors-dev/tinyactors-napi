// The types of @tinyactors/node and @tinyactors/wasm, one API (docs/api-map.md
// says where @tinyactors/wasm differs today). Every export has a doc comment, which an
// editor shows on hover; README.md and docs/guide/ teach the same API in
// order, with examples. Each declaration is a row of docs/api-map.md,
// which names the core behind it.
//
// The declarations come in three groups, as the README orders them: the
// application API first, then what operating a host takes, then the wire
// format. Every name is exported from the package's one entry; the groups
// say where an item fits, not where it is imported from.
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

// =========================================================================
// THE APPLICATION API
// =========================================================================
//
// Charts, a Host with its processors, store and handlers, Actors: what an
// application writes against (README.md, from "A first program" to "Before
// you use it").

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
 * catch (error) { if (error instanceof StaleError) ... } // the actor ended
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

/** An actor, session, view or handle that does not exist (any more): a
 * send to a session or name that ended, a thin view read after its batch, a
 * typed method's `stale` error. Its `status` is `'TA_ERROR_STALE'`. */
export class StaleError extends TinyactorsError {}

/** A call the host cannot make now: a closed host, a snapshot from a
 * handler, a typed method's `state` error. Its `status` is
 * `'TA_ERROR_STATE'`. */
export class StateError extends TinyactorsError {}

/** An argument the host refused: a malformed config, image or address, a
 * typed method's param. Its `status` is `'TA_ERROR_INVALID'`. */
export class InvalidError extends TinyactorsError {}

/** A value or a feature the host does not take: a value outside the value
 * table, a chart that cannot hibernate. Its `status` is
 * `'TA_ERROR_UNSUPPORTED'`. */
export class UnsupportedError extends TinyactorsError {}

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
 * const host = new Host(compiled, { system: 'shop' });
 * compiled.close();
 */
export function compileCharts(sources: readonly Source[], options?: CompileOptions): Compiled;

/** The options of `compileCharts`, `compileSystem` and `compileDir`. */
export interface CompileOptions {
  /** Answers each `src` the sources do not hold (`compileDir`'s default
   * reads them from its directory). */
  readonly resolver?: Resolver;
  /** Every warning is an error, and the compile throws `CompileError`:
   * the compiler's own warnings and the syntax errors of the charts'
   * ECMAScript, which are warnings otherwise, since SCXML makes such an
   * expression an `error.execution` when it is evaluated. */
  readonly warningsAsErrors?: boolean;
}

/** Compiles a system manifest: a `<system>` document of `<chart name
 * src>`s, read through `options.resolver`, and `<actor name chart>`s,
 * which `host.boot` spawns with their names. Throws `CompileError`. */
export function compileSystem(manifest: Source, options?: CompileOptions): Compiled;

/** Compiles every `*.scxml` file under the directory `dir` (a path or a
 * `file:` URL) into one image: keep an application's charts and their
 * helper files (a `.js` a chart reads with `<script src>`, a chart it
 * invokes with `<invoke src>`) in one directory, compile it once at
 * startup, and give the result to any number of hosts. The charts are
 * named by their path under `dir`, sorted (the first is the image's
 * default boot chart); a `src` is read from under `dir`, relative to the
 * document that names it, and one whose path leaves `dir` (`..` past it,
 * an absolute path, a symbolic link pointing outside) is refused with a
 * `ResolveError`, so a `CompileError`; give `options.resolver` to read
 * them yourself. A directory with no chart, or a chart file whose real
 * path leaves it, throws `TA_ERROR_INVALID`; an error of the file system
 * is thrown as it is. Needs `node:fs` (`TA_ERROR_UNSUPPORTED` in a page).
 *
 * @example
 * const compiled = compileDir(new URL('./charts/', import.meta.url));
 * const host = new Host(compiled, { system: 'chat' });
 * compiled.close();
 */
export function compileDir(dir: string | URL, options?: { readonly resolver?: Resolver }): Compiled;

/**
 * The version of the package installed (`'0.4.0'`, or a development
 * build's `'0.4.0-dev.20261119.3.gabc1234'`), as its package.json says.
 * `@tinyactors/node/package.json` can be imported too.
 */
export const version: string;

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

// ---- what handlers get --------------------------------------------------

/** One `<send>` of a chart, as an I/O processor's handler, the transport
 * or a service's `receive` gets it. A view of the host's memory: each
 * field is read on first access, while the handler runs; after the
 * handler returned, a read throws `TA_ERROR_STALE`. When the handler
 * returns a promise, every field is read before the host moves on, and
 * the view stays valid, `answer` and `fail` included, while the host is
 * open. */
export interface Send {
  /** The host that handed it out. */
  readonly host: Host;
  /** The sender's session. */
  readonly session: bigint;
  /** The sender, as an {@link Actor} (a new one at each read). */
  readonly sender: Actor;
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

/** A `<log>` line: a view, valid while the log handler runs. */
export interface LogEntry {
  /** The host that handed it out. */
  readonly host: Host;
  /** The actor that logged. */
  readonly session: bigint;
  /** `<log label>`; `''` when it has none. */
  readonly label: string;
  /** The value of `<log expr>`, as text. */
  readonly text: string;
}

/** An `<invoke>` of a service your program runs, as a service handler
 * gets it. A record: keep it and use it while the service runs. */
export interface Invocation {
  /** The host that runs the invocation. */
  readonly host: Host;
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
  receive?(send: Send): void | Promise<void>;
  /** The invoker left the state, which cancels the invocation. */
  stop?(): void;
}

// ---- the host's options -------------------------------------------------

/** The handlers and choices of a host, `new Host(charts, options)`. A
 * handler's error is reported after its turn: it goes to `onHandlerError`
 * when there is one; else it rejects a waiting `host.idle()`, or is thrown
 * as an uncaught exception. No handler takes the host: a view or record
 * has `.host`. */
export interface HostOptions {
  /** Required: this system's id, part of every address it hands out
   * (`tinyactors://<system>/...`). No two systems that talk may share one,
   * and `'tinyactors-ask'` is the binding's (`TA_ERROR_INVALID`). */
  system: string;
  /** The I/O processors the charts may send to (`<send type>`): an
   * object of each type's {@link IOProcessor}, the config's
   * `ioProcessors` in this order. Sends to another system need none: they
   * go to `transport`. */
  ioProcessors?: { [type: string]: IOProcessor };
  /** The rest of the host's config. */
  config?: HostConfig;
  /** A `SimulatedClock`; without one the host reads the runtime's clock
   * and arms a timer at its next deadline. */
  clock?: SimulatedClock;
  /** Where hibernated actors' blobs go: a WAKE (an event, a due delayed
   * send, a migration for a hibernated actor) loads its blob from here and
   * wakes it. Without a store a WAKE is dropped: the actor stays
   * hibernated, and its events wait, until `host.wake`. */
  store?: Store;
  /** The most actors kept in memory (an integer from 1; needs `store`):
   * after a turn that goes idle the host hibernates the actors past it
   * into the store, the coldest first (`host.sweep`, `host.hibernate`); a
   * migration's WAKE waits while the bound is reached, and loads as room
   * is made. An actor not at rest, or holding what its datamodel cannot
   * write out, stays. */
  resident?: number;
  /** `<log>` lines; without one they are dropped. */
  log?: (entry: LogEntry) => Handled;
  /** Your exporter: each OTLP traces or logs request the encoder wrote
   * (protobuf, for a collector's `/v1/traces` or `/v1/logs`), as a
   * `Uint8Array`. Needs `telemetry` in the config; without a handler the
   * requests are dropped. It runs in the host's turn: start the post and
   * return. At `close()` it gets the last requests; the promises it
   * returns then are awaited by `[Symbol.asyncDispose]`. */
  telemetry?: (signal: 'traces' | 'logs', data: Uint8Array) => Handled;
  /** The handler of each `<invoke type>` your program runs: it returns the
   * service, or a promise of it. Until the promise settles the sends to
   * the invocation wait, in order; a rejection is a failed start, and the
   * invoker gets `error.communication`. */
  services?: { [type: string]: (invocation: Invocation) => Service | void | PromiseLike<Service | void> };
  /** Sends to another system's address. Pass `send.message` to the other
   * side's `host.send`. Without one, each such send is failed. A reply to
   * an `actor.ask` never reaches it. */
  transport?: (send: Send) => Handled;
  /** Each top-level actor that reaches a final state, with its donedata
   * (`undefined` for none). */
  onDone?: (actor: Actor, donedata: ReceivedValue) => Handled;
  /** Each top-level actor that faulted and ended (a `TinyactorsError`,
   * status `TA_ERROR_FATAL`). */
  onError?: (actor: Actor, error: TinyactorsError) => Handled;
  /** A handler's error (a throw, or its promise's rejection), with the
   * view or record it was handling (`undefined` for none; a thin view is
   * readable while the hook runs). The send is failed as without it.
   * Without it, the error is the turn's. */
  onHandlerError?: (error: unknown, effect: Send | LogEntry | Migrated | Invocation | undefined) => void;
  /** Each actor a migration moved. */
  migrated?: (migrated: Migrated) => Handled;
  /** The end of each migration. */
  migrationDone?: (result: MigrationResult) => Handled;
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

/** What `new Host` and `Host.restore` take as charts: a compile result
 * (its image is read), an image's bytes, or an array of them, each added
 * in order as a segment. */
export type Charts = Compiled | Uint8Array | ArrayBuffer | readonly (Compiled | Uint8Array | ArrayBuffer)[];

/** An I/O processor: the object that serves one `<send type>`, given as
 * `options.ioProcessors[type]`. Its `receive` gets each send to the type,
 * called on the object: answer or fail it there, or return a promise
 * (every field of the send is read before the host moves on, and it may
 * be answered when the promise gets there). A throw, or a promise that
 * rejects before an answer, fails the send (`error.communication` for the
 * sender) and is reported as the turn's error, or to `onHandlerError`. A
 * plain function is a `TypeError`: switch on `send.event` in `receive`.
 *
 * @example
 * const database = {
 *   receive(send) {
 *     if (send.event === 'load') send.answer('loaded', { rows: [] });
 *     else send.fail();
 *   },
 * };
 */
export interface IOProcessor {
  receive(send: Send): Handled;
  /** Its location, which `_ioprocessors` shows the charts. */
  readonly location?: string;
}

/** A store of hibernated actors' blobs, given as `options.store`: the host
 * saves an actor's blob when it hibernates it (with `options.resident`),
 * loads it when an event, a due delayed send or a migration comes for the
 * actor (a WAKE), then wakes the actor and deletes the blob. Each method
 * may return a value or a promise: the host waits for a promise (and so
 * does `idle()`); a save still pending when its actor's WAKE comes is
 * waited for first. A `save` that throws, or whose promise rejects, wakes
 * the actor back from its blob (it stays in memory until a later turn), a
 * `load` that throws leaves it hibernated; both are reported as a
 * handler's error. `MemoryStore` and `SQLiteStore` are synchronous. */
export interface Store {
  save(session: bigint, blob: Uint8Array): void | PromiseLike<void>;
  load(session: bigint): Uint8Array | ArrayBuffer | PromiseLike<Uint8Array | ArrayBuffer>;
  delete(session: bigint): void | PromiseLike<void>;
}

/** A {@link Store} in a `Map`, in this process: for tests, and where the
 * host's memory, not the process's, is what must stay small. */
export class MemoryStore implements Store {
  constructor();
  /** The blobs by session: what a test reads to see what was stored. */
  readonly blobs: Map<bigint, Uint8Array>;
  save(session: bigint, blob: Uint8Array): void;
  /** The blob of `session`; a `StaleError` when there is none. */
  load(session: bigint): Uint8Array;
  delete(session: bigint): void;
}

/** A {@link Store} in an SQLite database file, one row per actor in the
 * table `tinyactors_blobs (session, blob)`, through the runtime's own
 * SQLite (`node:sqlite` under node, `bun:sqlite` under bun),
 * synchronously; `':memory:'` for no file. It is a cache of the host's
 * actors, not their durability: a host's blobs wake only in that host or
 * one restored from its snapshot, so keep the file with the snapshot. A
 * runtime without SQLite (a page) throws `TA_ERROR_UNSUPPORTED`. */
export class SQLiteStore implements Store {
  constructor(path: string);
  /** The runtime's database object, for an application that reads the
   * table itself. */
  readonly database: any;
  save(session: bigint, blob: Uint8Array): void;
  /** The blob of `session`; a `StaleError` when there is none. */
  load(session: bigint): Uint8Array;
  delete(session: bigint): void;
  /** Closes the database; the file keeps the blobs. */
  close(): void;
}

/** An I/O processor that spawns actors for charts: give it a type you
 * name, `ioProcessors: { spawn: new Spawner() }`, and a chart sends it
 * `{chart, name, params}` (`<send type="spawn" event="spawn">`). The new
 * actor runs the chart's current version; the sender gets `spawned` with
 * `{name, address}` and the send's `sendid`, or `error.communication`
 * when the host cannot spawn it (a chart it does not have, data of
 * another shape). A type no processor serves stays `error.execution`.
 * It does not look names up: a name has one owner, the collection actor
 * that spawns it and records the spawns it asked for. */
export class Spawner implements IOProcessor {
  constructor();
  receive(send: Send): void;
}

/** What a handler returns: nothing, or a promise (typed `unknown`, so a
 * handler that returns another value, as `(host, send) => sent.push(send)`
 * does, is one too; the host ignores it). A send whose handler returns a
 * promise is read in full before the host moves on, and may be answered
 * when the promise gets there. */
export type Handled = unknown;

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

// ---- actors -------------------------------------------------------------

/** An actor of a host: what `host.spawn` and `host.actor` return, and what
 * `send.sender` and `onDone` give. A small immutable value made where the
 * API returns one: keeping one keeps nothing alive in the host, two for
 * one actor are `equals` (key a `Map` by `id`), and one whose actor ended
 * refuses what needs the actor (`StaleError`). Every call that takes a
 * session takes an Actor. */
export class Actor {
  /** An Actor of `host` for session `id`; `host.actor(id)` checks it is live. */
  constructor(host: Host, id: bigint);
  /** The actor's session: a `bigint`, core's `_sessionid`. */
  readonly id: bigint;
  /** The host it runs in (not enumerable). */
  readonly host: Host;
  /** `tinyactors://<system>/#_scxml_<id>`, the full form: what another
   * system sends to. A chart sees this actor's sends' `_event.origin`
   * either in it or as its fragment, `#_scxml_<id>`, so compare by the
   * fragment. */
  readonly address: Address;
  /** `host.send(actor, event, data, options)`. */
  send(event: string, data?: Value, options?: SendOptions): void;
  /** Ends the actor now (`host.terminate`): no exit handlers, no done
   * event; a hibernated one is woken to end, its blob deleted. */
  terminate(): void;
  /** `host.actorState({ session: actor })`. */
  state(): Promise<ActorStateResult>;
  /** `host.actorContext({ session: actor })`. */
  context(): Promise<ActorContextResult>;
  /** `host.actorGet({ session: actor })`. */
  get(): Promise<ActorGetResult>;
  /** Sends `event` with `data` and resolves with the actor's reply, `[event,
   * data]`: the chart answers with `<send targetexpr="_event.origin"
   * event="...">`. The event's origin is an address of the host's own
   * (system `tinyactors-ask`), so the reply comes back here and never
   * reaches your transport. No timeout of its own: `options.signal` (an
   * `AbortSignal`) rejects it with the signal's reason and drops it; an ask
   * pending at `close()` never settles. A refusal at the call (an actor that
   * ended) rejects. */
  ask(event: string, data?: Value, options?: { signal?: AbortSignal }): Promise<[string, ReceivedValue]>;
  /** A promise of the actor's donedata, settled when it reaches a
   * top-level final state (rejected with the error it ended with, a
   * fault). The same promise while it is pending; an actor that ended
   * already rejects with `StaleError`, a closed host `StateError`, and one
   * pending at `close()` never settles. */
  readonly done: Promise<ReceivedValue>;
  /** Whether `other` is an Actor of the same host and session. */
  equals(other: unknown): boolean;
  /** `Actor(<id>)`. */
  toString(): string;
}

/** The options of `host.spawn`. */
export interface SpawnOptions {
  /** The actor's name: `host.actor(name)` finds it, `_name` holds it, and
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

// ---- the typed methods: their shapes, and an actor's --------------------

// As the host writes them (each method of the host's control plane). A
// session or a count in a result is a number; an integer past 2^53 would
// be a bigint, which only `trace.spans.decode`'s nanosecond times reach.

/** A typed method's params, passed to the host as given (the host checks
 * them); `undefined` for none. Each method has its own type below. */
export type Params = { [key: string]: Value } | undefined;

/** The params of a method that takes none: `undefined` or `{}`. */
export type NoParams = undefined | { readonly [key: string]: never };

/** A typed method's result handler, called once, in a later turn, with the
 * method's result. */
export type OnResult<R = Value> = (result: R) => void;

/** A typed method's error handler. Without one, the error rejects a
 * waiting `idle()` or is thrown as an uncaught exception. */
export type OnError = (error: TinyactorsError) => void;

/** An active configuration, as xstate's `value`: an atomic state is its
 * id (`'s'`), a compound state `{ [state]: its active child }`, a parallel
 * state `{ [state]: { [region]: ... } }`, an atomic region `{}`. */
export type StateValue = string | { readonly [state: string]: StateValue };

/** The params of `actorState`, `actorContext` and `actorGet`. */
export interface SessionParams {
  session: Session | Actor;
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

// ---- the host -----------------------------------------------------------

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
 * const compiled = compileCharts([{ name: 'order.scxml', text }]);
 * const host = new Host(compiled, { system: 'shop', log: (entry) => console.log(entry.text) });
 * compiled.close();
 * const order = host.spawn('order');
 * order.send('checkout');
 * await host.idle();
 * host.close();
 */
export class Host implements Disposable, AsyncDisposable {
  // ---- the application API ----

  /** A host of system `options.system` running `charts` (each image added
   * in order, a segment each: `addImage`), with the handlers and choices
   * of `options`. Throws `TinyactorsError` (`TA_ERROR_INVALID`) for a
   * config the host does not take, `TypeError` for options it does not
   * take. */
  constructor(charts: Charts, options: HostOptions);
  /** The system id, `options.system`. */
  readonly system: string;
  /** True once `close()` ran; every input of a closed host throws. */
  readonly closed: boolean;
  /** Milliseconds from the last idle turn to the next deadline (a delayed
   * send, a timeout, or the telemetry encoder's flush once records are
   * staged); `undefined` for none. An input given since that turn has not
   * run yet, so its deadlines are not in it. */
  readonly nextDeadline: number | undefined;

  /** Starts an actor of `chart`, a chart's name (its current version) or a
   * `ChartRef` (a version), and returns it. It runs in a later turn.
   * Throws `TA_ERROR_INVALID` for a chart the host does not have. */
  spawn(chart: string | ChartRef, options?: SpawnOptions): Actor;
  /** The live actor `which` names: a session, an Actor, the name it was
   * spawned with (newest segment first), or an address of this system
   * (text or an `Address`). Throws `StaleError` for no live actor,
   * `InvalidError` for another system's address. */
  actor(which: Session | Actor | string | Address): Actor;
  /** Every live actor of the host (`actorList`, a page at a time), or the
   * actors of the chart named `options.chart`. */
  actors(options?: { chart?: string }): Promise<Actor[]>;

  /** Puts `event`, with `data`, in the queue of the actor `target` names (a
   * session or an address). Throws `TA_ERROR_STALE` for an actor that
   * ended. */
  send(target: Session | Actor | string | Address, event: string, data?: Value, options?: SendOptions): void;
  /** The same, from a `SendMessage` (the transport's `send.message`). */
  send(message: SendMessage): void;
  /** Ends the actor. Throws `TA_ERROR_STALE` for one that already ended. */
  terminate(session: Session | Actor): void;

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

  /** Frees the host: the last telemetry requests go to the handler, the
   * timer is cleared, pending typed methods and running services are
   * dropped without being called. From a handler it waits for the end of
   * the turn. Again: nothing. */
  close(): void;
  /** `close()`. */
  [Symbol.dispose](): void;
  /** `close()`, then the promises the telemetry handler returned at it. */
  [Symbol.asyncDispose](): Promise<void>;


  // ---- operating a host (README.md, "Operating a host") ----
  //
  // A snapshot and its restore; the clock's rate and quickjs's heap;
  // images, segments and versions; the typed methods that inspect and
  // trace the host (their two forms as above); metrics; hibernation by a
  // policy of your own; migration.

  /** A new host running a snapshot `host.snapshot()` gave, with the system
   * it was taken with (checked) and the options `new Host` takes, its
   * `datamodel` the snapshot's; of `charts`, the images the snapshot does
   * not hold (compared by their bytes) are added after its own. Every
   * session stays the same, and its clock goes on from the snapshot's
   * time, whatever clock reads it. Invocations that were running are
   * announced again to `services`, with `invocation.restored` true. A
   * snapshot of a build whose layout differs throws `TA_ERROR_INVALID`. */
  static restore(snapshot: Uint8Array | ArrayBuffer, charts: Charts, options: HostOptions): Host;

  /** The host's clock rate, `system.ticksPerSecond`. */
  readonly ticksPerSecond: number;
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
  /** Spawns the boot actors of the image of `segment`: a system manifest's
   * `<actor>`s, or an actor of `compileCharts`' first chart. */
  boot(segment: number): void;

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
  hibernate(session: Session | Actor): Uint8Array;
  /** Puts a hibernated actor back from the blob `hibernate` gave; its
   * waiting events run at the next turn. Only its latest blob: one of an
   * earlier hibernation (a store that fell behind) throws `TA_ERROR_STALE`,
   * another session's `TA_ERROR_INVALID`, and the actor stays hibernated.
   * On a restored host a blob of a hibernation made after the snapshot is
   * taken too. */
  wake(session: Session | Actor, blob: Uint8Array | ArrayBuffer): void;

  /** Starts moving running actors (every chart's, `chart`'s, or one
   * `session`) to the current version of their chart, in later turns; each
   * gets `error.platform.upgrade` with its old variables. Returns the
   * migration's id, which `migrated` and `migrationDone` name. Throws `TA_ERROR_INVALID` for a chart the host does not have and
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

  // ---- wire format (README.md, "Wire format") ----
  //
  // A transport's messages delivered and failed on the receiving side;
  // `send(message)`, above, takes one too.

  /** Tells a sender that its send could not be delivered: the actor
   * `sender` (a session or its address, the send's `origin`) gets
   * `error.communication` with `sendid`. */
  fail(sender: Session | Actor | string | Address, sendid?: string): void;
  /** Sends each of `items` in order, and returns how many were taken: the
   * rest, from the first one refused, were not sent. */
  sendMany(items: readonly SendMessage[]): number;
}

// =========================================================================
// OPERATING A HOST
// =========================================================================
//
// What an operator's tools, a deploy script or an admin endpoint use: the
// host's config and sizes, inspection, telemetry, hibernation by a policy
// of your own, images, segments and migration, snapshots (README.md,
// "Operating a host"). The Host's own methods for them are grouped in the
// class, under the same heading.

// ---- config and sizes ---------------------------------------------------

/** The rest of the host's config, `options.config`: plain values, checked
 * by the host, every absent key a default (the host's, never the
 * package's). A key the host does not take, or a value of the wrong type,
 * throws a `TinyactorsError` (`TA_ERROR_INVALID`) at `new Host`, with the
 * host's `reason` and the key as `path` (`system.maxActors`). The system
 * id is `options.system` and the I/O processors `options.ioProcessors`:
 * a `systemID` or `ioProcessors` here is a `TypeError`.
 * `host.hostConfig()` answers the whole config with every default filled
 * in, as {@link EffectiveHostConfig}.
 *
 * @example
 * const config = { system: { maxActors: 10_000 }, telemetry: { resource: { 'service.name': 'orders' } } };
 */
export interface HostConfig {
  /** The capacities of each new segment, each its first size, not a cap
   * (a pool that fills grows its segment). */
  system?: SystemConfig;
  /** Actors a migration looks at per run (default 256). */
  migrateQuantum?: number;
  /** Present: the host has an OTLP encoder, and `options.telemetry` gets
   * its requests. Absent: none, and nothing is paid for it. */
  telemetry?: TelemetryConfig;
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
  /** The I/O processors, in the order `options.ioProcessors` gave them. */
  readonly ioProcessors: readonly { readonly type: string; readonly location?: string }[];
  readonly migrateQuantum: number;
  /** Only when the host has an encoder. */
  readonly telemetry?: Readonly<Required<TelemetryConfig>>;
}

// ---- images, segments and migration -------------------------------------

/** A chart's current version in a host, from `host.chart(name)`, for
 * `host.spawn`. */
export interface ChartRef {
  /** The segment of the image that holds it. */
  readonly segment: number;
  /** Its index in that image. */
  readonly chart: number;
}

/** The options of `host.migrate`. */
export interface MigrateOptions {
  /** A chart's name; none: every chart. */
  chart?: string;
  /** One actor. */
  session?: Session | Actor;
  /** Load the hibernated actors from the store (as `resident` allows),
   * for the migration to move. */
  wake?: boolean;
  /** Milliseconds of the host's clock from now, rounded up to its next
   * tick; 0 or none: no timeout. */
  timeout?: number;
}

/** An actor a migration moved: a view, valid while the handler runs. */
export interface Migrated {
  /** The host that handed it out. */
  readonly host: Host;
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

// ---- inspection ---------------------------------------------------------

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

// ---- tracing ------------------------------------------------------------

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

// =========================================================================
// WIRE FORMAT
// =========================================================================
//
// What values, sends and addresses become when they leave the process:
// CBOR, a transport's messages, addresses read into their parts, SCXML's
// BasicHTTP, an OTLP export read back (README.md, "Wire format"). An
// application of one host and its own store needs none of it.

// ---- values as bytes ----------------------------------------------------

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

// ---- other systems ------------------------------------------------------

/** An event for `host.send(message)` and `host.sendMany(items)`, in the
 * shape `send.message` has. Keys it does not know are ignored. */
export interface SendMessage {
  /** A session, or an address (string or `Address`); a local address is
   * resolved to its actor. */
  target: Session | Actor | string | Address;
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

// ---- an OTLP export, read back ------------------------------------------

/** The spans of an OTLP ExportTraceServiceRequest (the bytes a telemetry
 * handler gets for `'traces'`, or any exporter's), read without a host:
 * for tests and a collector of your own. Throws an `InvalidError` for bytes
 * that are not such a request, a `TypeError` for an argument that is not
 * bytes.
 *
 * @example
 * const spans = decodeTraces(data);
 * console.log(spans.map((span) => `${span.name} ${span.scope.attributes['tinyactors.chart.name']}`));
 */
export function decodeTraces(bytes: Uint8Array | ArrayBuffer): DecodedSpan[];

/** A span as {@link decodeTraces} gives it: a {@link Span} and more of
 * what the request holds. */
export interface DecodedSpan extends Span {
  /** OTLP's Span.flags. */
  readonly flags: number;
  readonly links: readonly { readonly trace: string; readonly span: string; readonly attributes: { readonly [key: string]: ReceivedValue } }[];
  /** Its resource's attributes (`service.name`, ...). */
  readonly resource: { readonly [key: string]: ReceivedValue };
  /** Its instrumentation scope. */
  readonly scope: { readonly name: string; readonly version: string; readonly attributes: { readonly [key: string]: ReceivedValue } };
}
