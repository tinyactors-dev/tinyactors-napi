'use strict';

// The debug adapter (docs/proposals/debug-adapter.md; napi ADR 0026): a
// Debug Adapter Protocol session over one attached actor of a System.
//
// napi opens no socket and checks no credentials (core ADR 0002, napi ADRs
// 0015 and 0016). The application puts a session behind its own transport
// and authentication, decides the permissions of the user before it creates
// the session, and passes each incoming DAP message to receive(); the
// session hands each outgoing one to `send`. An `audit` hook hears attach,
// detach, every console command, every evaluation and every mutation,
// before it happens: a hook that throws refuses it.
//
// The session watches and pokes, and the view updates live. It never stops
// the actor: a production actor is never held by a debugger. The actor is
// presented as stopped, because clients show a thread's stack and variables
// only then; after each macrostep the client hears the macrostep's summary
// and a stop that keeps the focus where it is, and reads the stack and the
// scopes again (see #presentStopped). A poke is
// what the permissions allow: `send` (an event through the mailbox), `set`
// (a data-model location), `goto` (an operator transition, abandon, cancel
// and replace), and `evaluate`. Each poke that moves the actor does it in a
// macrostep of its own, which the view shows like any other. With no
// permission the session only watches. Breakpoints of every kind are
// tracepoints: where one would have stopped, the console says so.
//
// Evaluating an expression runs arbitrary code in the process that hosts
// the actor. It is the `evaluate` permission, off unless granted: without
// it the Variables pane and the console commands still work.
//
// This module is host neutral, so the browser build can share it: it uses
// the System facade and core's generated bindings, and no Node.js module.

const { core } = require('./native');
const { TinyactorsError } = require('./errors');
const { ActorID } = require('./actor');
const { nativeOf, observe } = require('./system');
const { Labels } = require('./debug/labels');
const { Macrosteps, summarize } = require('./debug/macrosteps');
const { Breakpoints, EXCEPTION_FILTERS } = require('./debug/breakpoints');
const { Variables } = require('./debug/variables');
const { frames, leaves } = require('./debug/frames');
const { Sources } = require('./debug/sources');
const expressions = require('./debug/expressions');
const commands = require('./debug/console');
const { DAPReader, encodeDAPMessage } = require('./debug/protocol');

const PERMISSIONS = ['send', 'set', 'goto', 'evaluate'];
const CONDITION_NEEDS_EVALUATE =
  'a condition is an expression, which runs code in the process; it needs the "evaluate" permission';
const SCXML_INVOKER = 'http://www.w3.org/TR/scxml/';
const ATTACHED = 1; // the attached actor's thread ID
const OPERATOR_EVENT = 'operator.goto';
// Event-loop turns an abandon waits for the pump to finish a microstep in.
const MOST_TURNS = 100;

// No stepping, stepping back, restarting or exception details: the actor is
// never stopped. Breakpoints of every kind are declared, as tracepoints.
const CAPABILITIES = Object.freeze({
  supportsConfigurationDoneRequest: true,
  supportsFunctionBreakpoints: true,
  supportsConditionalBreakpoints: true,
  supportsHitConditionalBreakpoints: true,
  supportsLogPoints: true,
  supportsEvaluateForHovers: true,
  exceptionBreakpointFilters: EXCEPTION_FILTERS.map(({ filter, label, description }) => ({ filter, label, description })),
  supportsSetVariable: true,
  supportsGotoTargetsRequest: true,
  supportsCompletionsRequest: true,
  completionTriggerCharacters: ['.', ' '],
  supportsModulesRequest: true,
  supportsDelayedStackTraceLoading: true,
  supportsLoadedSourcesRequest: true,
  supportsSetExpression: true,
  supportsTerminateRequest: true,
  supportsDataBreakpoints: true,
  supportsBreakpointLocationsRequest: true,
  supportsClipboardContext: true,
  supportTerminateDebuggee: false,
  supportSuspendDebuggee: false,
});

const NEVER_STOPPED = 'a live actor is never stopped: the session watches it and shows each macrostep as it ends; ' +
  'send, goto, abandon, cancel and setVariable poke it';

// Requests the adapter answers with an error, and why. Their capabilities
// are not declared.
const REFUSED = Object.freeze({
  launch: 'napi\'s adapter attaches to a running actor: use "attach" with an address (the test host launches workbenches)',
  restart: 'napi\'s adapter watches a running actor: disconnect and attach again',
  pause: NEVER_STOPPED,
  next: NEVER_STOPPED,
  stepIn: NEVER_STOPPED,
  stepOut: NEVER_STOPPED,
  stepBack: 'a live actor is never stopped, and the session keeps no past to go back to',
  reverseContinue: 'a live actor is never stopped, and the session keeps no past to go back to',
  restartFrame: 'a live actor is never stopped, and the session keeps no past to go back to',
  exceptionInfo: 'a live actor never stops for an exception: an exception breakpoint writes to the console instead',
  cancel: 'every request answers at once, so there is nothing to cancel',
  stepInTargets: 'an action has one way in',
  terminateThreads: 'ending a thread would destroy an actor',
  setInstructionBreakpoints: 'a chart has no instructions',
  locations: 'no value in a chart names a place in a source',
  readMemory: 'a chart has no memory to show',
  writeMemory: 'a chart has no memory to show',
  disassemble: 'a chart has no instructions',
});

// A request the session refuses; its message is what the client shows.
class Refusal extends Error {}

const refuse = (message) => new Refusal(message);
const jsonText = (value) => JSON.stringify(value, (key, inner) => (typeof inner === 'bigint' ? String(inner) : inner));
const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

let sessionCount = 0;
// The request handlers, by command; set in the class's static block, where
// they can reach its private members.
let HANDLERS;

class DebugSession {
  #system;
  #allow;
  #audit;
  #send;
  #seq = 0;
  #queue = Promise.resolve();
  #client = {};
  #closed = false;

  // While attached: { allow, actor, label, address, sessionID, args,
  // labels, sources, observer, watch, console }.
  #attached = null;
  #threads = new Map();
  #nextThread = ATTACHED + 1;
  #macrosteps;
  #lastEvent = new Map();
  #lastMicrostep = new Map();
  #breakpoints = new Breakpoints();
  #variables;
  #frames = new Map();
  #nextFrame = 0;
  // A frame's ID by thread and position. The actor is always at rest, so a
  // frame names only its thread and depth: its ID stays valid across
  // macrosteps, and a request a client made before a refresh still answers.
  #frameIDs = new Map();
  #gotoTargets = new Map();
  #modules = new Map();
  // sourceReference → { definition, source, virtual }: a definition's
  // export, or the SCXML Sources writes for a chart with no file (napi ADR
  // 0026). One count numbers both.
  #sourceRefs = new Map();
  #lastReference = 0;
  #files = new Set();

  constructor(system, options) {
    if (system === null || typeof system !== 'object' || typeof system.withdrawSend !== 'function') {
      throw new TinyactorsError('createDebugSession(): expected a System', 'invalid');
    }
    const { allow = [], audit, send } = options ?? {};
    if (!Array.isArray(allow) || allow.some((entry) => !PERMISSIONS.includes(entry))) {
      throw new TinyactorsError(`createDebugSession(): options.allow lists ${PERMISSIONS.join(', ')}`, 'invalid');
    }
    if (typeof send !== 'function') {
      throw new TinyactorsError('createDebugSession(): options.send must be a function that takes each outgoing message',
                                'invalid');
    }
    if (audit !== undefined && typeof audit !== 'function') {
      throw new TinyactorsError('createDebugSession(): options.audit must be a function', 'invalid');
    }
    this.#system = system;
    this.#allow = new Set(allow);
    this.#audit = audit;
    this.#send = send;
    sessionCount += 1;
    this.id = sessionCount;
    this.#macrosteps = new Macrosteps((session) => this.#threadOfSession(session) !== undefined);
    const session = this;
    this.#variables = new Variables({
      system,
      native: nativeOf(system),
      get labels() { return session.#attached.labels; },
      thread: (id) => this.#thread(id),
      eventOf: (thread, view) => this.#eventOf(thread, view),
      mailboxNote: (message) => this.#mailboxNote(message),
      threadOfInvocation: (invocation) => this.#threadOfInvocation(invocation),
      documentName: (view) => this.#documentName(view),
    });
  }

  /** The permissions this session was created with. */
  get allow() {
    return [...this.#allow];
  }

  /** True while an actor is attached. */
  get attached() {
    return this.#attached !== null;
  }

  /**
   * Takes one incoming DAP message (an object). Requests are answered in
   * the order they arrive; the promise settles once this one is answered.
   */
  receive(message) {
    const run = this.#queue.then(() => this.#dispatch(message));
    this.#queue = run.catch(() => {});
    return run;
  }

  /** The transport closed: detach without answering. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach('the connection closed');
  }

  // ------------------------------------------------------------------
  // Messages

  #write(message) {
    if (this.#closed) return;
    this.#seq += 1;
    this.#send({ seq: this.#seq, ...message });
  }

  #event(event, body) {
    this.#write(body === undefined ? { type: 'event', event } : { type: 'event', event, body });
  }

  #output(category, text) {
    this.#event('output', { category, output: `${text}\n` });
  }

  async #dispatch(message) {
    if (this.#closed || message === null || typeof message !== 'object' || message.type !== 'request') {
      return;
    }
    const { command } = message;
    const respond = (body, success = true, error) => this.#write({
      type: 'response', request_seq: message.seq, success, command,
      ...(success ? { body: body ?? {} } : { message: error, body: { error: { id: 1, format: error, showUser: true } } }),
    });
    if (Object.hasOwn(REFUSED, command)) {
      respond(undefined, false, REFUSED[command]);
      return;
    }
    const handler = HANDLERS[command];
    if (handler === undefined) {
      respond(undefined, false, `${command} is not supported by napi's debug adapter`);
      return;
    }
    let after;
    try {
      const outcome = await handler.call(this, message.arguments ?? {});
      after = outcome?.after;
      respond(outcome?.body);
    } catch (error) {
      if (!(error instanceof Refusal || error instanceof TinyactorsError)) {
        this.#output('stderr', `${command}: ${error?.stack ?? error}`);
      }
      respond(undefined, false, error?.message ?? String(error));
      return;
    }
    try {
      after?.();
    } catch (error) {
      this.#output('stderr', `${command}: ${error?.message ?? error}`);
    }
  }

  // ------------------------------------------------------------------
  // Audit and permissions

  #record(entry) {
    if (this.#audit === undefined) return;
    const attached = this.#attached;
    this.#audit({
      ...entry,
      time: Date.now(),
      session: this.id,
      ...(attached === null ? {} : { actor: attached.label, sessionID: attached.sessionID }),
    });
  }

  // The audit hook hears it first; one that throws refuses it.
  #audited(entry) {
    try {
      this.#record(entry);
    } catch (error) {
      throw refuse(`the audit hook refused it: ${error?.message ?? error}`);
    }
  }

  #requireAttached() {
    if (this.#attached === null) throw refuse('attach to an actor first');
    return this.#attached;
  }

  // A poke: an operation that changes the actor, with its permission.
  #requireChange(permission, what) {
    const attached = this.#requireAttached();
    if (!attached.allow.has(permission)) {
      throw refuse(attached.allow.size === 0
        ? `${what} changes the actor, and this session only watches it`
        : `${what} needs the "${permission}" permission, which this session was not given`);
    }
    return attached;
  }

  #requireEvaluate(what) {
    const attached = this.#requireAttached();
    if (!attached.allow.has('evaluate')) {
      throw refuse(`${what} evaluates an expression, which runs code in the process; it needs the "evaluate" permission`);
    }
    return attached;
  }

  // ------------------------------------------------------------------
  // Attaching

  #resolve(args) {
    const system = this.#system;
    const { address, actor, sessionID } = args;
    if (address !== undefined) {
      const parsed = parseAddress(address);
      if (parsed === undefined) {
        throw refuse('"address" is { family, name }, "family/name" or "#_actor_family/name"');
      }
      const found = system.findActor(parsed);
      if (found === undefined) throw refuse(`no resident actor has the address ${parsed.family}/${parsed.name}`);
      return { actor: found, address: parsed };
    }
    if (actor !== undefined) {
      const id = new ActorID(system, Number(actor.slot), Number(actor.generation));
      if (!system.exists(id)) throw refuse(`no resident actor is ${actor.slot}:${actor.generation}`);
      return { actor: id, address: undefined };
    }
    if (sessionID !== undefined) {
      let wanted;
      try {
        wanted = BigInt(sessionID);
      } catch {
        throw refuse('"sessionID" is a session ID in decimal');
      }
      const found = actorOfSession(system, wanted);
      if (found === undefined) throw refuse(`no resident actor holds session ${wanted}`);
      return { actor: found, address: undefined };
    }
    throw refuse('attach needs "address", "actor" { slot, generation } or "sessionID"');
  }

  // An attach may ask for fewer permissions than the session has, never
  // more.
  #attach(args) {
    if (this.#attached !== null) throw refuse(`already attached to ${this.#attached.label}; disconnect first`);
    if (args.allow !== undefined && !Array.isArray(args.allow)) throw refuse('"allow" is a list of permissions');
    const asked = args.allow === undefined ? this.#allow : new Set(args.allow);
    const allow = new Set([...this.#allow].filter((permission) => asked.has(permission)));
    const { actor, address } = this.#resolve(args);
    const view = this.#system.inspect(actor);
    const label = address !== undefined ? `${address.family}/${address.name}` : `actor ${actor.slot}:${actor.generation}`;
    const attached = { allow, actor, label, address, sessionID: String(view.sessionID), args };
    this.#attached = attached;
    try {
      this.#audited({ type: 'attach', allow: [...allow] });
    } catch (error) {
      this.#attached = null;
      throw error;
    }
    const system = this.#system;
    const native = nativeOf(system);
    attached.labels = new Labels(native);
    attached.sources = new Sources(system, native, () => (this.#lastReference += 1));
    this.#threads.set(ATTACHED, { id: ATTACHED, actor, label, session: attached.sessionID });
    attached.observer = observe(system, {
      traces: (traces) => this.#onTraces(traces),
      log: (record) => this.#onLog(record),
      runaway: (runaway) => this.#onRunaway(runaway),
      defined: (id) => this.#onDefined(id),
      deadLetter: (letter) => this.#onDeadLetter(letter),
      dropped: (send) => this.#onDropped(send),
    });
    attached.watch = system.watchTraces({ sessions: [actor] });
    if (allow.has('send') || allow.has('goto')) {
      attached.console = commands.openConsole(system, `debug://session/${this.id}`, (request) => this.#onReply(request));
    }
    return attached;
  }

  // What attaching says, once its response is out. A DAP client shows a
  // thread's stack and variables only while it is stopped, so the actor is
  // reported stopped once, on entry, and every view refreshes after each
  // of its macrosteps (`invalidated`); it never is stopped.
  #announce(attached, verb) {
    this.#event('process', { name: attached.label, startMethod: 'attach', isLocalProcess: true });
    this.#refreshCatalog();
    this.#refreshThreads();
    const permissions = attached.allow.size === 0 ? 'watch only' : `allowed: ${[...attached.allow].join(', ')}`;
    this.#output('console', `${verb} ${attached.label} (session ${attached.sessionID}), watched live and never ` +
                            `paused; ${permissions}`);
    this.#relocateBreakpoints();
    this.#presentStopped({ focus: true });
  }

  // Presents the actor as stopped, so the client shows its stack and
  // variables. With `focus` (on attach, and after a `continue`) the client
  // selects the top frame, and its Variables view has something to show;
  // otherwise (after each macrostep) it only reads the stack again and
  // leaves the focus where it is.
  //
  // The refresh after a macrostep is a stop that keeps the focus, followed
  // by `invalidated` for the variables only, never for the stacks: VS Code
  // answers a stacks invalidation by replaying the stops it holds, and the
  // attach stop, which took the focus, would take it again after every
  // macrostep, out of the Debug Console while an operator types in it.
  #presentStopped({ focus }) {
    if (this.#attached === null) return;
    this.#event('stopped', { reason: 'entry', threadId: ATTACHED, allThreadsStopped: false, preserveFocusHint: !focus,
                             description: 'watched live, never paused: the view follows each macrostep' });
  }

  // The live view after a macrostep of the actor: the stack and the scopes
  // are read again. Frames keep their IDs (#frameIDs), so the frame the
  // client selected stays valid.
  #refreshView() {
    this.#resetViews();
    this.#presentStopped({ focus: false });
    if (this.#client.supportsInvalidatedEvent) this.#event('invalidated', { areas: ['variables'] });
  }

  // Ends the attachment: stops watching.
  #detach(reason) {
    const attached = this.#attached;
    if (attached === null) return;
    const system = this.#system;
    attached.observer?.stop();
    if (!system.closed) {
      attached.watch?.stop();
      attached.console?.close();
    }
    try {
      this.#record({ type: 'detach', reason });
    } catch {
      // Detaching cannot be refused.
    }
    this.#attached = null;
    this.#threads.clear();
    this.#frames.clear();
    this.#frameIDs.clear();
    this.#resetViews();
  }

  // The attached actor went away: the session ends.
  #ended(why) {
    if (this.#attached === null) return;
    const label = this.#attached.label;
    this.#detach(why);
    this.#output('important', `${label} ${why}; the debug session ended`);
    this.#event('terminated');
  }

  // ------------------------------------------------------------------
  // Threads

  #thread(id) {
    const thread = this.#threads.get(Number(id));
    if (thread === undefined) throw refuse(`no thread ${id}`);
    return thread;
  }

  #threadOfSession(session) {
    const text = String(session);
    for (const thread of this.#threads.values()) {
      if (thread.session === text) return thread;
    }
    return undefined;
  }

  // The thread of an invocation's in-system child, or undefined: for other
  // invokers, and for a child that is gone.
  #threadOfInvocation(invocation) {
    const child = invocation.type === SCXML_INVOKER ? childOf(this.#system, invocation.serviceHandle) : undefined;
    return child === undefined ? undefined : this.#threadOfSession(child.session);
  }

  #threadArgument(args) {
    this.#requireAttached();
    return args.threadId === undefined ? this.#threads.get(ATTACHED) : this.#thread(args.threadId);
  }

  #inspect(thread) {
    try {
      return this.#system.inspect(thread.actor);
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') return undefined;
      throw error;
    }
  }

  // The attached actor and the in-system children of its invocations, and
  // the thread events for what changed.
  #refreshThreads() {
    const attached = this.#attached;
    if (attached === null) return;
    const view = this.#inspect(this.#threads.get(ATTACHED));
    if (view === undefined) {
      this.#ended('is gone');
      return;
    }
    const children = new Map();
    for (const invocation of view.invocations) {
      if (invocation.type !== SCXML_INVOKER || !invocation.active) continue;
      const child = childOf(this.#system, invocation.serviceHandle);
      if (child !== undefined) children.set(child.session, { child: child.actor, invocation });
    }
    for (const thread of [...this.#threads.values()]) {
      if (thread.id !== ATTACHED && !children.has(thread.session)) {
        this.#threads.delete(thread.id);
        this.#macrosteps.forget(thread.session);
        this.#event('thread', { reason: 'exited', threadId: thread.id });
      }
    }
    for (const [session, { child, invocation }] of children) {
      if (this.#threadOfSession(session) === undefined) {
        const id = this.#nextThread;
        this.#nextThread += 1;
        this.#threads.set(id, { id, actor: child, label: `${attached.label} invocation ${attached.labels.invocation(invocation.id)}`,
                                    session });
        this.#event('thread', { reason: 'started', threadId: id });
      }
    }
  }

  #threadName(thread) {
    const view = this.#inspect(thread);
    if (view === undefined) return `${thread.label} (gone)`;
    const where = view.residency === 'done' ? `done in ${view.finalState ?? 'its final state'}`
      : leaves(view, this.#attached.labels).join(' ') || 'starting';
    return `${thread.label} · ${where}`;
  }

  // ------------------------------------------------------------------
  // What the actor did: traces, <log> records, replies

  #onTraces(bytes) {
    if (this.#attached === null) return;
    let read;
    try {
      read = this.#macrosteps.read(bytes);
    } catch (error) {
      this.#output('stderr', `reading the traces failed: ${error.message}`);
      return;
    }
    for (const macrostep of read.macrosteps) {
      this.#onMacrostep(macrostep);
    }
    let gone;
    for (const entry of read.lifecycle) {
      if (entry.session === this.#attached?.sessionID && ['finished', 'destroyed', 'unloaded'].includes(entry.kind)) {
        gone = entry.kind;
      }
    }
    if (read.macrosteps.length > 0) this.#refreshView();
    const attached = this.#attached;
    if (gone === 'finished' && attached !== null && this.#system.exists(attached.actor)) {
      this.#output('important', `${attached.label} finished`);
    } else if (gone !== undefined) {
      this.#ended(gone === 'unloaded' ? 'was unloaded' : gone === 'finished' ? 'finished' : 'was destroyed');
      return;
    }
    this.#refreshThreads();
    this.#refreshCatalog();
  }

  // A macrostep's summary, and the breakpoints it would have stopped at:
  // they are tracepoints, since a live actor is never stopped.
  #onMacrostep(macrostep) {
    const attached = this.#attached;
    const thread = this.#threadOfSession(macrostep.session);
    if (thread === undefined) return;
    if (macrostep.event !== null) this.#lastEvent.set(macrostep.session, macrostep.event);
    const last = macrostep.microsteps.at(-1);
    if (last !== undefined) this.#lastMicrostep.set(macrostep.session, { macrostep: macrostep.number, microstep: last });
    const location = (definition, id) => attached.labels.expression(BigInt(definition), id);
    this.#output('console', summarize(macrostep, thread.label, location).join('\n'));
    if (thread.id !== ATTACHED) return;
    const hits = this.#breakpoints.hits(macrostep, {
      label: thread.label,
      location: (id) => {
        const text = location(macrostep.definition, id);
        return text === undefined ? undefined : expressions.pathOf(text);
      },
      fires: (breakpoint) => this.#condition(breakpoint, thread),
      log: (breakpoint) => this.#logpoint(breakpoint, thread),
    });
    for (const hit of hits) {
      this.#output('console', `would have stopped after macrostep ${macrostep.number}: ${hit.description}`);
    }
    this.#onFailedSends(macrostep, thread.label);
  }

  // A <send> of the actor that core could not route (an unknown target, a
  // name with no actor) raises error.communication in it at once, or when
  // a delayed one is due; the trace names the <send> that failed.
  #onFailedSends(macrostep, label) {
    for (const { name, attributes } of macrostep.records) {
      if (name !== 'scxml.raise' || !String(attributes['scxml.event.name']).startsWith('error.communication')) continue;
      const action = attributes['scxml.action'];
      const which = action !== undefined ? action
        : `a delayed <send> from macrostep ${attributes['scxml.cause.macrostep'] ?? '?'}, when it was due,`;
      this.#output('important', `${label}: ${which} could not be delivered; it raised error.communication`);
    }
  }

  // Whether `target` (an ActorID, or an address) is the attached actor.
  #isAttached(target) {
    const attached = this.#attached;
    if (attached === null || target === undefined || target === null) return false;
    if (target instanceof ActorID) return target.equals(attached.actor);
    const { address } = attached;
    return address !== undefined && target.family === address.family && target.name === address.name;
  }

  // Mail for the attached actor that it will never take (a dead letter,
  // ADR 0008): the application's deadLetter hook hears it as well.
  #onDeadLetter(letter) {
    if (!this.#isAttached(letter.target)) return;
    const detail = letter.detail === undefined ? '' : ` (${letter.detail})`;
    this.#output('important', `${this.#attached.label}: ${letter.event} became a dead letter: ${letter.reason}${detail}`);
  }

  // A <send> of the attached actor that its I/O processor failed; the actor
  // gets error.communication for it.
  #onDropped(send) {
    if (!this.#isAttached(send.source)) return;
    const target = typeof send.target === 'string' && send.target !== '' ? ` to ${send.target}` : '';
    const why = send.error instanceof Error ? send.error.message : jsonText(send.error);
    this.#output('important', `${this.#attached.label}: the <send> of ${send.event} through ${send.type}${target} ` +
                              `failed: ${why}`);
  }

  // A breakpoint's condition, in the data model where it hit. It runs only
  // with the `evaluate` permission the attach has now, and only once the
  // audit hook has heard it; without either it never fires. One that
  // throws counts as a hit, so its author sees it fail.
  #condition(breakpoint, thread) {
    if (!this.#attached.allow.has('evaluate')) return false;
    if (!this.#auditEvaluation('condition', String(breakpoint.condition), `the condition of breakpoint ${breakpoint.id}`)) {
      return false;
    }
    try {
      return Boolean(expressions.evaluate(breakpoint.condition, this.#scope(thread)));
    } catch (error) {
      this.#output('stderr', `the condition of breakpoint ${breakpoint.id} failed: ${error.message}`);
      return true;
    }
  }

  // An evaluation the session makes on its own, at a hit: the audit hook
  // hears it first. One it refuses does not run, and the console says so.
  #auditEvaluation(context, expression, what) {
    try {
      this.#record({ type: 'evaluate', context, expression });
      return true;
    } catch (error) {
      this.#output('stderr', `the audit hook refused ${what}: ${error?.message ?? error}`);
      return false;
    }
  }

  // A logpoint writes its message: {expression} parts are evaluated with
  // the `evaluate` permission, and left as written without it; a part the
  // audit hook refuses is written as <refused>.
  #logpoint(breakpoint, thread) {
    const evaluate = this.#attached.allow.has('evaluate');
    const text = String(breakpoint.logMessage).replace(/\{([^{}]+)\}/g, (whole, expression) => {
      if (!evaluate) return whole;
      if (!this.#auditEvaluation('logpoint', expression, `a part of logpoint ${breakpoint.id}`)) return '<refused>';
      try {
        const value = expressions.evaluate(expression, this.#scope(thread));
        return typeof value === 'string' ? value : jsonText(value);
      } catch (error) {
        return `<${error.message}>`;
      }
    });
    this.#output('console', text);
  }

  #onLog(record) {
    const attached = this.#attached;
    if (attached === null) return;
    const source = record.source;
    const { address } = attached;
    const ours = source instanceof ActorID ? source.equals(attached.actor)
      : address !== undefined && source?.family === address.family && source?.name === address.name;
    if (!ours) return;
    const value = record.hasValue ? ` ${typeof record.value === 'string' ? record.value : jsonText(record.value)}` : '';
    this.#output('stdout', `${record.label ?? 'log'}:${value}`);
  }

  #onReply(request) {
    const data = request.data === undefined ? '' : ` ${jsonText(request.data)}`;
    this.#output('console', `${this.#attached?.label ?? 'an actor'} replied ${request.event}${data}`);
  }

  // A macrostep of the actor ran its microstep limit, and the addon
  // quarantined it (core ADR 0075): it stands between two microsteps of a
  // macrostep it cannot finish. The console says what can be done; the
  // `runaway` exception filter adds a tracepoint's line.
  #onRunaway(actor) {
    const attached = this.#attached;
    if (attached === null || !actor.equals(attached.actor)) return;
    this.#output('important', `${attached.label} is quarantined as a runaway: a macrostep ran its microstep limit ` +
                              '(core ADR 0075). `abandon` ends that macrostep and `goto` moves it out of the loop; ' +
                              'the application\'s release() lets the macrostep go on');
    if (this.#breakpoints.wants('runaway')) {
      this.#output('console', 'would have stopped: a macrostep ran its microstep limit');
    }
    this.#refreshView();
  }

  // ------------------------------------------------------------------
  // Views of the actor

  #resetViews() {
    this.#variables.reset();
  }

  #documentName(view) {
    const system = this.#system;
    try {
      return core.definition_inspect(nativeOf(system), view.definitionID).document_name || view.definition.family;
    } catch {
      return view.definition.family;
    }
  }

  // _event of the step the thread is in, or of its last macrostep, as the
  // chart's expressions see it: `origin` is the URI, `originType` its type.
  #eventOf(thread, view = this.#inspect(thread)) {
    if (view?.currentEvent) {
      const { origin, ...event } = view.currentEvent;
      if (origin !== undefined) {
        if (origin.uri !== undefined) event.origin = origin.uri;
        event.originType = origin.type;
      }
      return event;
    }
    const last = this.#lastEvent.get(thread.session);
    if (last === undefined) return undefined;
    let data;
    try {
      data = last.data === undefined ? undefined : JSON.parse(last.data);
    } catch {
      data = last.data;
    }
    return { name: last.name, type: last.type, ...(data === undefined ? {} : { data }), taken: 'in its last macrostep' };
  }

  #mailboxNote(message) {
    const scope = this.#attached?.console?.scope;
    const console = scope !== undefined && message.scope?.index === scope.index &&
      message.scope?.generation === scope.generation;
    return {
      event: message.event,
      ...(message.data === undefined ? {} : { data: message.data }),
      ...(message.transition === undefined ? {} : { transition: message.transition }),
      ...(message.awaited ? { awaited: true } : {}),
      ...(console ? { from: 'this console' } : {}),
    };
  }

  // What an expression sees for a thread.
  #scope(thread) {
    const view = this.#inspect(thread);
    if (view === undefined) throw refuse(`${thread.label} is gone`);
    return {
      data: view.data,
      event: this.#eventOf(thread, view),
      sessionID: String(view.sessionID),
      name: this.#documentName(view),
      activeStates: view.activeStates,
    };
  }

  #frameThread(frameId) {
    if (frameId === undefined) return this.#threads.get(ATTACHED);
    const frame = this.#frames.get(Number(frameId));
    if (frame === undefined) throw refuse(`frame ${frameId} is not valid (any more)`);
    return this.#thread(frame.thread);
  }

  // ------------------------------------------------------------------
  // Modules, sources and line breakpoints (core ADR 0085)

  #refreshCatalog() {
    const attached = this.#attached;
    const seen = new Set();
    for (const definition of this.#system.definitions()) {
      const key = String(definition.id);
      seen.add(key);
      const revision = typeof definition.identity.revision === 'string' ? definition.identity.revision
        : [...definition.identity.revision].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const module = { id: key, name: `${definition.identity.family}${definition.retired ? ' (retired)' : ''}`,
                       version: revision };
      const known = this.#modules.get(key);
      if (known === undefined) {
        this.#modules.set(key, module);
        const reference = (this.#lastReference += 1);
        this.#sourceRefs.set(reference, { definition: definition.id,
                                          source: exportSource(definition, revision, reference) });
        this.#event('module', { reason: 'new', module });
        this.#event('loadedSource', { reason: 'new', source: this.#sourceRefs.get(reference).source });
        for (const path of attached.sources.files(definition.id)) {
          if (!this.#files.has(path)) {
            this.#files.add(path);
            this.#event('loadedSource', { reason: 'new', source: Sources.source({ path }) });
          }
        }
      } else if (known.name !== module.name) {
        this.#modules.set(key, module);
        this.#event('module', { reason: 'changed', module });
      }
      this.#noteVirtual(definition.id, attached.sources.virtualSource(definition.id));
    }
    for (const [key, module] of [...this.#modules]) {
      if (!seen.has(key)) {
        this.#modules.delete(key);
        this.#event('module', { reason: 'removed', module });
        for (const [reference, entry] of [...this.#sourceRefs]) {
          if (String(entry.definition) === key) {
            this.#sourceRefs.delete(reference);
            this.#event('loadedSource', { reason: 'removed', source: entry.source });
          }
        }
      }
    }
  }

  // A definition's virtual source (napi ADR 0026), or undefined: a new one
  // is a loaded source, and one an earlier attach numbered is removed.
  #noteVirtual(definition, virtual) {
    for (const [reference, entry] of [...this.#sourceRefs]) {
      if (entry.virtual && String(entry.definition) === String(definition) && reference !== virtual?.sourceReference) {
        this.#sourceRefs.delete(reference);
        this.#event('loadedSource', { reason: 'removed', source: entry.source });
      }
    }
    if (virtual !== undefined && !this.#sourceRefs.has(virtual.sourceReference)) {
      this.#sourceRefs.set(virtual.sourceReference, { definition, source: virtual, virtual: true });
      this.#event('loadedSource', { reason: 'new', source: virtual });
    }
  }

  // The element a line of `source` (a DAP Source) stands for, in the
  // attached actor's chart, or why there is none.
  #resolveLine(source, line) {
    const attached = this.#attached;
    if (attached === null) return 'attach first: lines are resolved against the attached actor\'s chart';
    const definition = this.#system.inspect(attached.actor).definitionID;
    const found = attached.sources.locate(definition, source, line);
    if (found === undefined) {
      return attached.sources.elements(definition).length === 0
        ? 'the chart keeps no source spans (core ADR 0085) and SCXML cannot express it: statechart() records spans'
        : `no state, transition or action of ${attached.label}'s chart at or after line ${line} of this source`;
    }
    const name = found.kind === 'state' ? attached.labels.state(definition, found.id)
      : found.kind === 'transition' ? attached.labels.transition(definition, found.id)
        : attached.labels.action(definition, found.id);
    return { element: { kind: found.kind, id: found.id, name }, line: found.line, column: found.column,
             source: Sources.source(found) };
  }

  // A chart defined again: its spans may have moved (core ADRs 0077 and
  // 0085), so its lines are read again and the breakpoints placed again.
  #onDefined(id) {
    if (this.#attached === null) return;
    this.#attached.sources.forget(id);
    this.#relocateBreakpoints();
  }

  // Line breakpoints set before attaching are resolved against the
  // attached actor's chart, and the client hears where they went.
  #relocateBreakpoints() {
    for (const { source } of this.#breakpoints.lineRequests) {
      for (const breakpoint of this.#breakpoints.relocate(source, (line) => this.#resolveLine(source, line))) {
        this.#event('breakpoint', { reason: 'changed', breakpoint });
      }
    }
    this.#unverifyConditions();
  }

  // Conditions set before an attach that did not keep `evaluate` never run
  // (#condition): the client hears those breakpoints are unverified.
  #unverifyConditions() {
    if (this.#attached === null || this.#attached.allow.has('evaluate')) return;
    for (const { id } of this.#breakpoints.conditioned) {
      this.#event('breakpoint', { reason: 'changed', breakpoint: { id, verified: false, message: CONDITION_NEEDS_EVALUATE } });
    }
  }

  // ------------------------------------------------------------------
  // Pokes: each queues behind the actor's mail, or acts between its
  // macrosteps, and the view shows the macrostep it causes.

  #post(event, data, options) {
    const { actor, console } = this.#attached;
    const origin = console === undefined ? undefined : { type: commands.TYPE, scope: console.scope };
    this.#system.post(actor, event, data, { ...options, origin });
  }

  #consoleSend({ event, data }) {
    const attached = this.#requireChange('send', 'send');
    this.#audited({ type: 'mutation', operation: 'send', event, data });
    this.#post(event, data);
    return `sent ${event} to ${attached.label}`;
  }

  // An operator transition (core ADR 0082), queued behind the actor's mail.
  #jump(targets, from) {
    const attached = this.#requireChange('goto', 'goto');
    const { actor, labels } = attached;
    const definition = this.#system.inspect(actor).definitionID;
    for (const state of [...targets, ...(from === undefined ? [] : [from])]) {
      if (labels.stateID(definition, state) === undefined) throw refuse(`${state} is not a state of the chart`);
    }
    this.#audited({ type: 'mutation', operation: 'goto', targets, from });
    const data = { targets, ...(from === undefined ? {} : { from }) };
    this.#post(OPERATOR_EVENT, data, { transition: { targets, source: from } });
    return `${attached.label}: goto ${targets.join(' ')}${from === undefined ? '' : ` from ${from}`} queued`;
  }

  // Core abandons only between microsteps (core ADR 0082): an actor the
  // system's action budget paused inside one finishes it in the next turns,
  // as it would anyway, and is abandoned as soon as it stands between two.
  async #abandon() {
    const attached = this.#requireChange('goto', 'abandon');
    const { actor, label } = attached;
    const system = this.#system;
    const view = system.inspect(actor);
    if (!view.macrostepInProgress) throw refuse(`${label} has no macrostep to abandon`);
    this.#audited({ type: 'mutation', operation: 'abandon', macrostep: view.step.macrostep });
    for (let turns = 0; turns < MOST_TURNS; turns += 1) {
      if (!system.exists(actor) || !system.inspect(actor).macrostepInProgress) {
        return `${label} finished its macrostep while finishing its microstep`;
      }
      try {
        system.abandon(actor);
        return `${label}: abandoned macrostep ${view.step.macrostep}; it keeps the configuration after its last ` +
               'completed microstep';
      } catch (error) {
        if (!(error instanceof TinyactorsError && error.code === 'busy')) throw error;
      }
      await nextTurn();
    }
    throw refuse(`${label} has not finished its bootstrap, or is still inside a microstep; try again`);
  }

  #cancel({ id }) {
    const attached = this.#requireChange('goto', 'cancel');
    this.#audited({ type: 'mutation', operation: 'cancel', sendID: id });
    try {
      this.#system.withdrawSend(attached.actor, id);
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        throw refuse(`${attached.label} has no pending send ${id}`);
      }
      throw error;
    }
    return `${attached.label}: withdrew send ${id}`;
  }

  async #replace({ revision }) {
    const attached = this.#requireChange('goto', 'replace');
    if (attached.address === undefined) throw refuse('only a named actor can be replaced in place');
    const system = this.#system;
    const definition = system.findDefinition({ family: attached.address.family, revision });
    if (definition === undefined) throw refuse(`no registered, unretired ${attached.address.family} revision ${revision}`);
    const view = system.inspect(attached.actor);
    if (view.macrostepInProgress) throw refuse(`${attached.label} is inside a macrostep: \`abandon\` it first`);
    this.#audited({ type: 'mutation', operation: 'replace', revision });
    const dropped = view.delayedSends.filter((send) => !send.submitted).map((send) => send.id ?? send.event);
    const prepared = system.prepareReplacement(attached.actor, definition);
    let replacement;
    try {
      // The replacement bootstraps in a pump turn before it can be activated.
      for (let tries = 0; tries < MOST_TURNS && system.inspect(prepared).scheduling === 'runnable'; tries += 1) {
        await nextTurn();
      }
      replacement = system.activate(prepared);
    } catch (error) {
      if (!system.closed && system.exists(prepared)) system.destroy(prepared);
      throw error;
    }
    // Follow the address to the replacement.
    const args = { address: attached.address, allow: [...attached.allow] };
    this.#detach('replaced');
    const next = this.#attach(args);
    this.#refreshThreads();
    const lost = dropped.length === 0 ? '' : `; its delayed sends ${dropped.join(', ')} were dropped`;
    return `${next.label} now runs ${revision} from its initial state, with its data${lost} (actor ` +
           `${replacement.slot}:${replacement.generation})`;
  }

  // A console line (evaluate, context repl).
  async #repl(line, thread) {
    const parsed = commands.parse(line);
    const text = (result) => ({ body: { result, variablesReference: 0 } });
    switch (parsed.command) {
      case 'help':
        return text(commands.HELP.join('\n'));
      case 'send':
        return text(this.#consoleSend(parsed));
      case 'goto':
        return text(this.#jump(parsed.targets, parsed.from));
      case 'abandon':
        return text(await this.#abandon());
      case 'cancel':
        return text(this.#cancel(parsed));
      case 'replace':
        return text(await this.#replace(parsed));
      default: {
        this.#requireEvaluate('an expression');
        return { body: this.#variables.present(expressions.evaluate(parsed.text, this.#scope(thread))) };
      }
    }
  }

  // Why a function breakpoint cannot be verified, or undefined.
  #checkBreakpoint(breakpoint, definition) {
    if ((breakpoint.kind === 'entry' || breakpoint.kind === 'exit') && definition !== undefined &&
        this.#attached.labels.stateID(definition, breakpoint.target) === undefined) {
      return `${breakpoint.target} is not a state of the chart`;
    }
    return this.#checkCondition(breakpoint);
  }

  #checkCondition(breakpoint) {
    const condition = breakpoint.condition;
    const allowed = this.#attached === null ? this.#allow.has('evaluate') : this.#attached.allow.has('evaluate');
    if (condition !== undefined && condition !== null && String(condition).trim() !== '' && !allowed) {
      return CONDITION_NEEDS_EVALUATE;
    }
    return undefined;
  }

  // ----------------------------------------------------------------------
  // Requests. Each answers { body, after }: `after` runs once the response
  // is out, for events that must follow it.

  static {
    HANDLERS = {
      initialize(args) {
        this.#client = args;
        return { body: CAPABILITIES, after: () => this.#event('initialized') };
      },

      configurationDone() {
        return {};
      },

      attach(args) {
        const attached = this.#attach(args);
        return { after: () => this.#announce(attached, 'attached to') };
      },

      disconnect() {
        this.#detach('disconnect');
        return {};
      },

      terminate() {
        this.#detach('terminate');
        return { after: () => this.#event('terminated') };
      },

      // The actor was never stopped, so continuing changes nothing; the
      // client, which now thinks it runs, hears it stopped again so that it
      // keeps showing its stack and variables.
      continue() {
        const attached = this.#requireAttached();
        return { body: { allThreadsContinued: false }, after: () => {
          this.#output('console', `${attached.label} is watched live and never paused: continue changes nothing`);
          this.#presentStopped({ focus: true });
        } };
      },

      threads() {
        if (this.#attached === null) return { body: { threads: [] } };
        this.#refreshThreads();
        const threads = [...this.#threads.values()].map((thread) => ({ id: thread.id, name: this.#threadName(thread) }));
        return { body: { threads } };
      },

      stackTrace(args) {
        const thread = this.#threadArgument(args);
        const attached = this.#attached;
        const view = this.#inspect(thread);
        const waiting = view === undefined ? 0 : this.#system.mailbox(thread.actor).length;
        const list = frames({ view, labels: attached.labels, sources: attached.sources,
                              seen: this.#lastMicrostep.get(thread.session),
                              note: waiting === 0 ? undefined : `${plural(waiting, 'message')} waiting` });
        const start = Number(args.startFrame ?? 0);
        const levels = Number(args.levels ?? 0);
        const shown = list.slice(start, levels > 0 ? start + levels : undefined).map((frame, index) => {
          const key = `${thread.id}:${start + index}`;
          let id = this.#frameIDs.get(key);
          if (id === undefined) {
            this.#nextFrame += 1;
            id = this.#nextFrame;
            this.#frameIDs.set(key, id);
            this.#frames.set(id, { thread: thread.id });
          }
          const located = frame.place === undefined ? { line: 0, column: 0 }
            // DAP needs a column: the start of the line when the span has none.
            : { source: Sources.source(frame.place), line: frame.place.line, column: frame.place.column ?? 1 };
          return { id, name: frame.name, ...located, presentationHint: frame.hint };
        });
        return { body: { stackFrames: shown, totalFrames: list.length } };
      },

      scopes(args) {
        this.#requireAttached();
        return { body: { scopes: this.#variables.scopes(this.#frameThread(args.frameId)) } };
      },

      variables(args) {
        this.#requireAttached();
        return { body: { variables: this.#variables.variables(args.variablesReference, {
          start: Number(args.start ?? 0), count: Number(args.count ?? 0), filter: args.filter,
        }) } };
      },

      setVariable(args) {
        this.#requireChange('set', 'setVariable');
        const text = String(args.value);
        const where = this.#variables.location(args.variablesReference, String(args.name));
        if (where === undefined) {
          throw refuse('only the Data model can be written; the other scopes are views of core state');
        }
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          this.#requireEvaluate('a value that is not JSON');
          this.#audited({ type: 'evaluate', context: 'setVariable', expression: text });
          value = expressions.evaluate(text, this.#scope(where.thread));
        }
        this.#audited({ type: 'mutation', operation: 'set', location: expressions.locationText(where.path),
                        value: jsonText(value) });
        return { body: this.#variables.set(args.variablesReference, String(args.name), value) };
      },

      setExpression(args) {
        this.#requireChange('set', 'setExpression');
        this.#requireEvaluate('setExpression');
        const thread = this.#frameThread(args.frameId);
        const text = String(args.value);
        const scope = this.#scope(thread);
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          this.#audited({ type: 'evaluate', context: 'setExpression', expression: text });
          value = expressions.evaluate(text, scope);
        }
        this.#audited({ type: 'mutation', operation: 'set', expression: String(args.expression), value: jsonText(value) });
        expressions.assign(String(args.expression), value, scope);
        const body = this.#variables.present(value);
        return { body: { value: body.result, type: body.type, variablesReference: body.variablesReference } };
      },

      async evaluate(args) {
        this.#requireAttached();
        const expression = String(args.expression ?? '');
        const thread = this.#frameThread(args.frameId);
        if (args.context === 'repl') {
          this.#audited({ type: 'command', text: expression });
          return this.#repl(expression, thread);
        }
        this.#requireEvaluate(`evaluate (${args.context ?? 'watch'})`);
        this.#audited({ type: 'evaluate', context: args.context ?? 'watch', expression });
        const value = expressions.evaluate(expression, this.#scope(thread));
        if (args.context === 'clipboard') {
          return { body: { result: typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value),
                           variablesReference: 0 } };
        }
        return { body: this.#variables.present(value) };
      },

      completions(args) {
        const attached = this.#requireAttached();
        const thread = this.#frameThread(args.frameId);
        const columnsFrom = this.#client.columnsStartAt1 === false ? 0 : 1;
        const column = Number(args.column) - columnsFrom;
        const view = this.#inspect(thread);
        const targets = commands.completions(String(args.text ?? ''), column, {
          events: () => (view === undefined ? [] : attached.labels.events(view.definitionID)),
          states: () => (view === undefined ? [] : attached.labels.states(view.definitionID).map((state) => state.name)),
          sendIDs: () => (view === undefined ? [] : view.delayedSends.map((send) => send.id).filter((id) => id !== null)),
          data: () => view?.data,
        });
        return { body: { targets: targets.map((target) => ({ ...target, start: target.start + columnsFrom })) } };
      },

      gotoTargets(args) {
        const attached = this.#requireAttached();
        const definition = this.#system.inspect(attached.actor).definitionID;
        let states = attached.labels.states(definition);
        if (args.source !== undefined && args.line !== undefined) {
          const located = attached.sources.lines(definition, args.source, Number(args.line))
            .filter((element) => element.kind === 'state').map((element) => element.id);
          if (located.length > 0) states = states.filter((state) => located.includes(state.id));
        }
        const targets = states.map((state) => {
          const id = this.#gotoTargets.size + 1;
          this.#gotoTargets.set(id, { definition: String(definition), state: state.name });
          const place = attached.sources.place(definition, 'state', state.id);
          return { id, label: state.name, line: place?.line ?? 0, ...(place === undefined ? {} : { column: place.column }) };
        });
        return { body: { targets } };
      },

      // A poke, as the console's `goto` is: an operator transition queued
      // behind the actor's mail. The actor is not stopped, so the client
      // hears nothing of a stop; the jump's macrostep shows like any other.
      goto(args) {
        const attached = this.#requireChange('goto', 'goto');
        const target = this.#gotoTargets.get(Number(args.targetId));
        if (target === undefined) throw refuse(`no goto target ${args.targetId}; ask gotoTargets first`);
        if (target.definition !== String(this.#system.inspect(attached.actor).definitionID)) {
          throw refuse(`${attached.label} runs another revision than the target's`);
        }
        const text = this.#jump([target.state]);
        return { after: () => this.#output('console', text) };
      },

      setBreakpoints(args) {
        const reference = Number(args.source?.sourceReference ?? 0);
        const path = args.source?.path ?? (reference > 0 ? undefined : args.source?.name);
        if (path === undefined && !(reference > 0)) {
          throw refuse('setBreakpoints needs a source with a path or a sourceReference');
        }
        const source = path === undefined ? { sourceReference: reference } : { path };
        const specs = Array.isArray(args.breakpoints) ? args.breakpoints : (args.lines ?? []).map((line) => ({ line }));
        this.#audited({ type: 'breakpoints', kind: 'line', ...source,
                        breakpoints: specs.map(({ line, condition, hitCondition, logMessage }) =>
                          ({ line, condition, hitCondition, logMessage })) });
        const answered = this.#breakpoints.setLines(source, specs, (line) => {
          const problem = this.#checkCondition(specs.find((spec) => Number(spec.line) === line) ?? {});
          return problem ?? this.#resolveLine(source, line);
        });
        return { body: { breakpoints: answered } };
      },

      breakpointLocations(args) {
        const attached = this.#requireAttached();
        if (args.source?.path === undefined && !(Number(args.source?.sourceReference) > 0)) {
          return { body: { breakpoints: [] } };
        }
        const definition = this.#system.inspect(attached.actor).definitionID;
        const found = attached.sources.lines(definition, args.source, Number(args.line),
                                             Number(args.endLine ?? args.line));
        const unique = new Map(found.map((element) => [`${element.line}:${element.column}`, element]));
        const breakpoints = [...unique.values()].map((element) => ({ line: element.line, column: element.column }));
        return { body: { breakpoints } };
      },

      setFunctionBreakpoints(args) {
        const specs = Array.isArray(args.breakpoints) ? args.breakpoints : [];
        const attached = this.#attached;
        const definition = attached === null ? undefined : this.#system.inspect(attached.actor).definitionID;
        this.#audited({ type: 'breakpoints', kind: 'function',
                        breakpoints: specs.map(({ name, condition, hitCondition }) =>
                          ({ name, condition, hitCondition })) });
        const answered = this.#breakpoints.setFunctions(specs, (breakpoint) =>
          (attached === null ? this.#checkCondition(breakpoint) : this.#checkBreakpoint(breakpoint, definition)));
        return { body: { breakpoints: answered } };
      },

      setExceptionBreakpoints(args) {
        const filters = [...(args.filters ?? []), ...(args.filterOptions ?? []).map((option) => option.filterId)];
        const unique = [...new Set(filters)];
        this.#audited({ type: 'breakpoints', kind: 'exception', filters: unique });
        this.#breakpoints.setFilters(unique);
        return { body: { breakpoints: unique.map(() => ({ verified: true })) } };
      },

      dataBreakpointInfo(args) {
        this.#requireAttached();
        const name = String(args.name ?? '');
        let target;
        if (args.variablesReference !== undefined) {
          target = this.#variables.location(args.variablesReference, name);
        } else {
          const path = expressions.pathOf(name);
          target = path === undefined ? undefined : { thread: this.#frameThread(args.frameId), path };
        }
        if (target === undefined) {
          return { body: { dataId: null, description: `${name} is not a data-model location` } };
        }
        return { body: {
          dataId: Breakpoints.dataID(target.thread.label, target.path),
          description: `${target.thread.label} ${expressions.locationText(target.path)}`,
          accessTypes: ['write'],
          canPersist: true,
        } };
      },

      setDataBreakpoints(args) {
        const specs = Array.isArray(args.breakpoints) ? args.breakpoints : [];
        this.#audited({ type: 'breakpoints', kind: 'data',
                        breakpoints: specs.map(({ dataId, condition, hitCondition }) =>
                          ({ dataId, condition, hitCondition })) });
        const answered = this.#breakpoints.setData(specs, (breakpoint) => {
          if (![...this.#threads.values()].some((thread) => thread.label === breakpoint.label)) {
            return `no thread is ${breakpoint.label}`;
          }
          return this.#checkCondition(breakpoint);
        });
        return { body: { breakpoints: answered } };
      },

      modules(args) {
        if (this.#attached !== null) this.#refreshCatalog();
        const all = [...this.#modules.values()];
        const start = Number(args.startModule ?? 0);
        const count = Number(args.moduleCount ?? 0);
        return { body: { modules: all.slice(start, count > 0 ? start + count : undefined), totalModules: all.length } };
      },

      loadedSources() {
        if (this.#attached !== null) this.#refreshCatalog();
        return { body: { sources: [...[...this.#sourceRefs.values()].map((entry) => entry.source),
                                   ...[...this.#files].map((path) => Sources.source({ path }))] } };
      },

      source(args) {
        const reference = Number(args.sourceReference ?? args.source?.sourceReference ?? 0);
        const written = this.#attached?.sources.content(reference);
        if (written !== undefined) return { body: written };
        const entry = this.#sourceRefs.get(reference);
        if (entry?.virtual) throw refuse('attach first: the SCXML is written from the attached session\'s chart');
        if (entry === undefined) {
          throw refuse(args.source?.path !== undefined && this.#files.has(args.source.path)
            ? `${args.source.path} is a file the client reads itself` : 'no such source');
        }
        const spec = core.definition_export(nativeOf(this.#system), entry.definition);
        return { body: { content: exportText(spec), mimeType: 'application/json' } };
      },
    };
  }
}

/** A debug session over `system` (see the top of this module). */
function createDebugSession(system, options) {
  return new DebugSession(system, options);
}

// { family, name } from an address in one of its spellings, or undefined.
function parseAddress(address) {
  if (address !== null && typeof address === 'object') {
    const { family, name } = address;
    return typeof family === 'string' && typeof name === 'string' && family !== '' && name !== ''
      ? { family, name } : undefined;
  }
  if (typeof address !== 'string') return undefined;
  const text = address.startsWith('#_actor_') ? address.slice('#_actor_'.length) : address;
  const slash = text.indexOf('/');
  return slash > 0 && slash < text.length - 1 ? { family: text.slice(0, slash), name: text.slice(slash + 1) } : undefined;
}

/*
 * The resident actor that holds session `wanted` (a bigint), or undefined.
 * A session ID is the runtime ID its session was spawned with (core ADR
 * 0066), so the actor that still has that ID is tried first and checked;
 * one reloaded since has another ID, so every resident actor is looked
 * through for it.
 */
function actorOfSession(system, wanted) {
  const guess = new ActorID(system, Number(wanted & 0xffffffffn), Number(wanted >> 32n));
  try {
    if (system.inspect(guess).sessionID === wanted) return guess;
  } catch (error) {
    if (!(error instanceof TinyactorsError && (error.code === 'not-found' || error.code === 'invalid'))) throw error;
  }
  for (const view of system.actors()) {
    if (view.sessionID === wanted) return view.actor;
  }
  return undefined;
}

/**
 * The child an in-system SCXML invocation runs, from its serviceHandle:
 * the child's runtime ID, (generation << 32) | slot (src/adapters/invoker.c),
 * not its session ID; they differ once slots are reused or an actor is
 * reloaded. Answers { actor, session } with the session in decimal, or
 * undefined when no resident actor has that ID any more.
 */
function childOf(system, handle) {
  const actor = new ActorID(system, Number(handle & 0xffffffffn), Number(handle >> 32n));
  try {
    return { actor, session: String(system.inspect(actor).sessionID) };
  } catch (error) {
    if (error instanceof TinyactorsError && (error.code === 'not-found' || error.code === 'invalid')) return undefined;
    throw error;
  }
}

// A definition's export as a loaded source the client asks for by reference.
function exportSource(definition, revision, reference) {
  return { name: `${definition.identity.family} ${revision}.json`, sourceReference: reference, origin: 'definition export',
           presentationHint: definition.retired ? 'deemphasize' : 'normal' };
}

// A definition's export as text: JavaScript functions as their source.
function exportText(spec) {
  return JSON.stringify(spec, (key, value) => {
    if (typeof value === 'function') return String(value);
    if (typeof value === 'bigint') return String(value);
    if (value instanceof Uint8Array) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(value);
      } catch {
        return [...value];
      }
    }
    return value;
  }, 2);
}

module.exports = { DebugSession, createDebugSession, DAPReader, encodeDAPMessage, CAPABILITIES };
