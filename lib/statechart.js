'use strict';

// The fluent statechart builder (docs/design.md, "Fluent authoring"). It
// emits the generated spec shape directly (ADR 0013 point 6): the same shape
// `System.define()` accepts as a plain object and core's definition export
// returns. There is no separate normalization step.
//
// Expressions are JavaScript (ADR 0011): a function is an expression (a
// condition, a value or a script) called with `this` bound to the actor's
// data and one argument, the evaluation context. A value that is not a
// function is data, and literal() makes a function data too. A location is
// a declared data name, or an object with `get` and `set`. Source text is
// accepted only as `In(state)` conditions and data names. Every builder
// chart compiles against the JavaScript data model.

const native = require('./native');
const { TinyactorsError } = require('./errors');
const { Definition } = require('./definition');

function isDefinition(value) {
  return value instanceof Definition;
}

const literalBrand = Symbol('tinyactors.literal');
native.setupLiteral(literalBrand);

/** Force a callable JavaScript value to be data rather than an expression. */
function literal(value) {
  return Object.freeze({ [literalBrand]: true, value });
}

function isLiteral(value) {
  return value !== null && typeof value === 'object' && value[literalBrand] === true;
}

const contentBrand = Symbol('tinyactors.content');

/**
 * Literal SCXML <content>: text or bytes kept in the definition, with an
 * optional media type. The bytes are copied.
 */
function content(body, options = {}) {
  let bytes;
  if (typeof body === 'string') {
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof Uint8Array) {
    bytes = new Uint8Array(body);
  } else {
    throw invalid('content(): expected a string or a Uint8Array');
  }
  const mediaType = options?.mediaType;
  if (mediaType !== undefined && (typeof mediaType !== 'string' || mediaType.length === 0)) {
    throw invalid('content(): mediaType must be a non-empty string');
  }
  return Object.freeze(mediaType === undefined ? { [contentBrand]: true, bytes }
                                               : { [contentBrand]: true, bytes, mediaType });
}

function isContent(value) {
  return value !== null && typeof value === 'object' && value[contentBrand] === true;
}

function isLocation(value) {
  return value !== null && typeof value === 'object' && !isLiteral(value) &&
    typeof value.get === 'function' && typeof value.set === 'function';
}

function invalid(message) {
  return new TinyactorsError(message, 'invalid');
}

function text(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${what}: expected a non-empty string`);
  }
  return value;
}

// An expression: a function, a literal(), or source text (In(state) or a
// data name).
function expression(value, what) {
  if (typeof value === 'function' || isLiteral(value)) {
    return value;
  }
  return text(value, what);
}

// A location: a data name, or an object with get and set.
function location(value, what) {
  if (isLocation(value)) {
    return value;
  }
  return text(value, what);
}

// A value source: a function is evaluated, content() is literal content,
// anything else is data.
function valueSpec(value) {
  if (isContent(value)) {
    const { bytes, mediaType } = value;
    return { kind: 'content', content: mediaType === undefined ? { bytes } : { media_type: mediaType, bytes } };
  }
  if (typeof value === 'function' || isLiteral(value)) {
    return { kind: 'expr', expr: value };
  }
  return { kind: 'expr', expr: literal(value) };
}

function targets(value, what) {
  const list = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(list) || list.length === 0) {
    throw invalid(`${what}: expected a state ID or a non-empty list of state IDs`);
  }
  return list.map((target, index) => text(target, `${what}[${index}]`));
}

// A literal/expression attribute pair (`x` / `xexpr`).
function stringSpec(value, what) {
  if (typeof value === 'function') {
    return { kind: 'expr', expr: value };
  }
  return { kind: 'literal', literal: text(value, what) };
}

// A number of milliseconds becomes an SCXML duration, for literals and for
// what a delay function returns.
function duration(value) {
  return typeof value === 'number' ? `${value}ms` : value;
}

function delaySpec(value, what) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw invalid(`${what}: expected a non-negative number of milliseconds`);
    }
    return { kind: 'literal', literal: `${value}ms` };
  }
  if (typeof value === 'function') {
    const delay = value;
    return {
      kind: 'expr',
      expr: function delayInMilliseconds(context) {
        return duration(delay.call(this, context));
      },
    };
  }
  return stringSpec(value, what);
}

// An `id` / `idlocation` pair.
function idLocation(value, what) {
  return { kind: 'location', location: location(value, what) };
}

// Where a builder call was written (core ADR 0085): the first stack frame
// outside this file, as V8 reports it. Structured call sites cost less than
// formatting and parsing a stack string, and ten frames are enough to leave
// this file's own helpers.
const structured = (_, frames) => frames;

function callSite() {
  const { prepareStackTrace, stackTraceLimit } = Error;
  Error.prepareStackTrace = structured;
  Error.stackTraceLimit = 6;
  const holder = {};
  Error.captureStackTrace(holder, callSite);
  const frames = holder.stack;
  Error.prepareStackTrace = prepareStackTrace;
  Error.stackTraceLimit = stackTraceLimit;
  if (!Array.isArray(frames)) {
    return undefined;
  }
  const frame = frames.find((each) => {
    const file = each.getFileName();
    return file !== null && file !== undefined && file !== __filename;
  });
  return frame === undefined ? undefined : { file: frame.getFileName(), line: frame.getLineNumber(), column: frame.getColumnNumber() };
}

// One builder tree shares one root: once build() or System.define() has
// consumed it, every builder in the tree refuses changes. The root also
// holds the spec's spans: where each state, transition, initial transition
// and action was written, with the JavaScript files as the sources.
class Root {
  constructor() {
    this.consumed = false;
    this.spans = [];
    this.sources = new Map();
  }

  check() {
    if (this.consumed) {
      throw invalid('this statechart builder was already built; start a new one with statechart()');
    }
  }

  // The span of the builder call being evaluated: its index into the spec's
  // spans, from 1, or undefined when the stack says nothing.
  span() {
    const site = callSite();
    if (site === undefined || !(site.line > 0)) {
      return undefined;
    }
    let source = this.sources.get(site.file);
    if (source === undefined) {
      source = this.sources.size;
      this.sources.set(site.file, source);
    }
    this.spans.push({ source, line: site.line, column: site.column });
    return this.spans.length;
  }

  // The spec's spans and sources, or nothing when no call was located.
  located() {
    if (this.spans.length === 0) {
      return {};
    }
    return { spans: this.spans, sources: [...this.sources.keys()].map((name) => ({ name })) };
  }
}

// Sets `span` on an element when the call that wrote it was located.
function located(root, element) {
  const span = root.span();
  if (span !== undefined) {
    element.span = span;
  }
  return element;
}

function block(root, build, what) {
  if (typeof build !== 'function') {
    throw invalid(`${what}: expected a function that receives the builder`);
  }
  const actions = new ActionBuilder(root);
  build(actions);
  return actions.actions;
}

// Actions shared by transitions, handlers, initial transitions and
// <finalize>. Each method appends one action spec to `this.actions`.
class ActionSequenceBuilder {
  #root;

  constructor(root) {
    this.#root = root;
    this.actions = [];
  }

  #push(action) {
    this.#root.check();
    this.actions.push(located(this.#root, action));
    return this;
  }

  raise(event, data) {
    const raise = { event: text(event, 'raise event') };
    if (data !== undefined) {
      raise.data = valueSpec(data);
    }
    return this.#push({ kind: 'raise', raise });
  }

  send(event, build) {
    this.#root.check();
    const send = {
      event: typeof event === 'function' ? { kind: 'expr', expr: event } : { kind: 'name', name: text(event, 'send event') },
    };
    if (build !== undefined) {
      if (typeof build !== 'function') {
        throw invalid('send(): expected a function that receives the send builder');
      }
      build(new SendBuilder(this.#root, send));
    }
    return this.#push({ kind: 'send', send });
  }

  cancel(sendID) {
    return this.#push({ kind: 'cancel', cancel: { sendid: stringSpec(sendID, 'cancel send ID') } });
  }

  log(label, value) {
    const log = {};
    if (label !== undefined) {
      log.label = text(label, 'log label');
    }
    if (value !== undefined) {
      log.expr = expression(value, 'log value');
    }
    return this.#push({ kind: 'log', log });
  }

  choose(condition, then, otherwise) {
    this.#root.check();
    const conditional = {
      condition: expression(condition, 'choose() condition'),
      then_actions: block(this.#root, then, 'choose() then'),
    };
    if (otherwise !== undefined) {
      conditional.else_actions = block(this.#root, otherwise, 'choose() otherwise');
    }
    return this.#push({ kind: 'if', conditional });
  }

  /** Assign a declared top-level data property. */
  assign(name, value) {
    return this.#push({ kind: 'assign', assign: { location: text(name, 'assign() location'), value: valueSpec(value) } });
  }

  /** Assign through an explicit { get, set } location. */
  assignAt(at, value) {
    if (!isLocation(at)) {
      throw invalid('assignAt(): expected a location with get and set functions');
    }
    return this.#push({ kind: 'assign', assign: { location: at, value: valueSpec(value) } });
  }

  /** Run a synchronous function with `this` bound to the actor's data. */
  script(run) {
    if (typeof run !== 'function') {
      throw invalid('script(): expected a function');
    }
    return this.#push({ kind: 'script', script: { script: run } });
  }

  /**
   * Run `build`'s actions once per element of a snapshot of `array`, with
   * data property `item` bound to the element and `index` to its index.
   */
  forEach(array, item, build, index) {
    this.#root.check();
    const foreach = {
      array: expression(array, 'forEach() array'),
      item: text(item, 'forEach() item'),
      body: block(this.#root, build, 'forEach() body'),
    };
    if (index !== undefined) {
      foreach.index = text(index, 'forEach() index');
    }
    return this.#push({ kind: 'foreach', foreach });
  }
}

class ActionBuilder extends ActionSequenceBuilder {}

class SendBuilder {
  #root;
  #send;

  constructor(root, send) {
    this.#root = root;
    this.#send = send;
  }

  #set(member, value) {
    this.#root.check();
    this.#send[member] = value;
    return this;
  }

  to(target) {
    return this.#set('target', stringSpec(target, 'send target'));
  }

  via(ioType) {
    return this.#set('type', stringSpec(ioType, 'send I/O processor type'));
  }

  after(delay) {
    return this.#set('delay', delaySpec(delay, 'send delay'));
  }

  id(id) {
    return this.#set('id', { kind: 'literal', literal: text(id, 'send ID') });
  }

  idLocation(at) {
    return this.#set('id', idLocation(at, 'send idLocation'));
  }

  data(value) {
    return this.#set('data', valueSpec(value));
  }

  param(name, value) {
    this.#root.check();
    (this.#send.params ??= []).push({ name: text(name, 'send param name'), value: valueSpec(value) });
    return this;
  }
}

class TransitionBuilder extends ActionSequenceBuilder {
  #root;

  constructor(root, transition) {
    super(root);
    this.#root = root;
    this.transition = transition;
  }

  when(condition) {
    this.#root.check();
    this.transition.condition = expression(condition, 'transition condition');
    return this;
  }

  target(target) {
    this.#root.check();
    this.transition.targets = targets(target, 'transition target');
    return this;
  }

  internal() {
    this.#root.check();
    this.transition.kind = 'internal';
    return this;
  }

  external() {
    this.#root.check();
    this.transition.kind = 'external';
    return this;
  }
}

class InvokeBuilder {
  #root;
  #invoke;

  constructor(root, invoke) {
    this.#root = root;
    this.#invoke = invoke;
  }

  #set(member, value) {
    this.#root.check();
    this.#invoke[member] = value;
    return this;
  }

  id(id) {
    return this.#set('id', { kind: 'literal', literal: text(id, 'invoke ID') });
  }

  idLocation(at) {
    return this.#set('id', idLocation(at, 'invoke idLocation'));
  }

  type(type) {
    return this.#set('type', stringSpec(type, 'invoke type'));
  }

  source(source) {
    return this.#set('src', stringSpec(source, 'invoke source'));
  }

  // A Definition as content names the child of the in-system SCXML invoker:
  // it is carried as its ID (adapters/invoker.h).
  content(value) {
    return this.#set('data', valueSpec(isDefinition(value) ? value.id : value));
  }

  param(name, value) {
    this.#root.check();
    (this.#invoke.params ??= []).push({ name: text(name, 'invoke param name'), value: valueSpec(value) });
    return this;
  }

  autoforward(enabled = true) {
    if (typeof enabled !== 'boolean') {
      throw invalid('autoforward(): expected a boolean');
    }
    return this.#set('autoforward', enabled);
  }

  finalize(build) {
    return this.#set('finalize', block(this.#root, build, 'invoke finalize()'));
  }
}

// data(name, value): the value is data even when it is a function.
function literalOf(value) {
  return isLiteral(value) || isContent(value) ? value : literal(value);
}

function functionSpec(value, what) {
  if (typeof value !== 'function') {
    throw invalid(`${what}: expected a function`);
  }
  return { kind: 'expr', expr: value };
}

function dataSpec(name, initializer) {
  const data = { name: text(name, 'data name') };
  if (initializer !== undefined) {
    data.initializer = initializer;
  }
  return data;
}

class DoneDataBuilder {
  #root;
  #done;

  constructor(root, done) {
    this.#root = root;
    this.#done = done;
  }

  content(value) {
    this.#root.check();
    this.#done.content = valueSpec(value);
    return this;
  }

  param(name, value) {
    this.#root.check();
    (this.#done.params ??= []).push({ name: text(name, 'doneData param name'), value: valueSpec(value) });
    return this;
  }
}

function initialSpec(root, target, actions) {
  const initial = located(root, { targets: targets(target, 'initial target') });
  if (actions !== undefined) {
    initial.actions = block(root, actions, 'initial actions');
  }
  return initial;
}

// Methods that add child states. `this.states` holds the child specs.
class StateContainerBuilder {
  #root;

  constructor(root) {
    this.#root = root;
    this.states = [];
  }

  #child(kind, id, build, what) {
    this.#root.check();
    const state = new StateBuilder(this.#root, kind, text(id, `${what} ID`), this.#root.span());
    if (build !== undefined) {
      if (typeof build !== 'function') {
        throw invalid(`${what}(): expected a function that receives the state builder`);
      }
      build(state);
    }
    this.states.push(state.finish());
    return this;
  }

  state(id, build) {
    return this.#child(undefined, id, build, 'state');
  }

  parallel(id, build) {
    return this.#child('parallel', id, build, 'parallel');
  }

  final(id, build) {
    return this.#child('final', id, build, 'final');
  }

  history(id, depth, build) {
    if (depth !== 'shallow' && depth !== 'deep') {
      throw invalid('history(): depth must be "shallow" or "deep"');
    }
    return this.#child(`history_${depth}`, id, build, 'history');
  }
}

const stateKinds = new Set(['atomic', 'compound', 'parallel', 'final', 'history_shallow', 'history_deep']);

class StateBuilder extends StateContainerBuilder {
  #root;
  #kind;
  #spec;

  constructor(root, kind, id, span) {
    super(root);
    this.#root = root;
    this.#kind = kind;
    this.#spec = { kind: undefined, id };
    if (span !== undefined) {
      this.#spec.span = span;
    }
  }

  #list(member, value) {
    this.#root.check();
    (this.#spec[member] ??= []).push(value);
    return this;
  }

  /** Override the kind normally inferred from the builder method and children. */
  kind(kind) {
    this.#root.check();
    if (!stateKinds.has(kind)) {
      throw invalid(`kind(): expected one of ${[...stateKinds].join(', ')}`);
    }
    this.#kind = kind;
    return this;
  }

  initial(target, actions) {
    this.#root.check();
    this.#spec.initial = initialSpec(this.#root, target, actions);
    return this;
  }

  /** Declare data property `name` with `initial` as data (a function too: use dataExpression). */
  data(name, initial) {
    return this.#list('data', dataSpec(name, initial === undefined ? undefined : valueSpec(literalOf(initial))));
  }

  /** Declare data property `name`, initialized by calling `initial`. */
  dataExpression(name, initial) {
    return this.#list('data', dataSpec(name, functionSpec(initial, 'dataExpression()')));
  }

  entry(build) {
    return this.#list('onentry', { actions: block(this.#root, build, 'entry()') });
  }

  exit(build) {
    return this.#list('onexit', { actions: block(this.#root, build, 'exit()') });
  }

  on(event, build) {
    return this.#transition({ kind: 'external', event: text(event, 'transition event') }, build, 'on()');
  }

  always(build) {
    if (typeof build !== 'function') {
      throw invalid('always(): expected a function that receives the transition builder');
    }
    return this.#transition({ kind: 'external' }, build, 'always()');
  }

  #transition(transition, build, what) {
    this.#root.check();
    located(this.#root, transition);
    if (build !== undefined) {
      if (typeof build !== 'function') {
        throw invalid(`${what}: expected a function that receives the transition builder`);
      }
      const builder = new TransitionBuilder(this.#root, transition);
      build(builder);
      if (builder.actions.length > 0) {
        transition.actions = builder.actions;
      }
    }
    return this.#list('transitions', transition);
  }

  invoke(build) {
    this.#root.check();
    if (typeof build !== 'function') {
      throw invalid('invoke(): expected a function that receives the invoke builder');
    }
    const invoke = { kind: 'invoke' };
    build(new InvokeBuilder(this.#root, invoke));
    return this.#list('invokes', invoke);
  }

  /** The data a final state reports on completion: content(), or param()s. */
  doneData(build) {
    this.#root.check();
    if (typeof build !== 'function') {
      throw invalid('doneData(): expected a function that receives the done-data builder');
    }
    const done = {};
    build(new DoneDataBuilder(this.#root, done));
    this.#spec.done_data = done;
    return this;
  }

  // The finished spec. An unspecified kind is compound with children, and
  // atomic without.
  finish() {
    const spec = this.#spec;
    spec.kind = this.#kind ?? (this.states.length > 0 ? 'compound' : 'atomic');
    if (this.states.length > 0) {
      spec.states = this.states;
    }
    return spec;
  }
}

class DefinitionBuilder extends StateContainerBuilder {
  #root;
  #spec;

  constructor(options) {
    const root = new Root();
    super(root);
    this.#root = root;
    if (options === null || typeof options !== 'object') {
      throw invalid('statechart(): expected an options object with family and revision');
    }
    const { family, revision, name, binding } = options;
    if (typeof revision !== 'string' && !(revision instanceof Uint8Array)) {
      throw invalid('statechart(): revision must be a string or a Uint8Array');
    }
    this.#spec = { identity: { family: { name: text(family, 'statechart() family') }, revision } };
    if (name !== undefined) {
      this.#spec.name = text(name, 'statechart() name');
    }
    if (binding !== undefined) {
      if (binding !== 'early' && binding !== 'late') {
        throw invalid('statechart(): binding must be "early" or "late"');
      }
      this.#spec.binding = binding;
    }
  }

  /** Declare top-level data property `name` with `initial` as data. */
  data(name, initial) {
    this.#root.check();
    (this.#spec.data ??= []).push(dataSpec(name, initial === undefined ? undefined : valueSpec(literalOf(initial))));
    return this;
  }

  /** Declare top-level data property `name`, initialized by calling `initial`. */
  dataExpression(name, initial) {
    this.#root.check();
    (this.#spec.data ??= []).push(dataSpec(name, functionSpec(initial, 'dataExpression()')));
    return this;
  }

  /** A script run once at initialization, after early-bound data (SCXML 3.2.2). */
  script(run) {
    this.#root.check();
    if (typeof run !== 'function') {
      throw invalid('script(): expected a function');
    }
    this.#spec.script = run;
    const span = this.#root.span();
    if (span !== undefined) {
      this.#spec.script_span = span;
    }
    return this;
  }

  initial(target, actions) {
    this.#root.check();
    this.#spec.initial = initialSpec(this.#root, target, actions);
    return this;
  }

  /** The spec in the generated shape, with its spans. Consumes the builder. */
  build() {
    this.#root.check();
    this.#root.consumed = true;
    return { ...this.#spec, states: this.states, ...this.#root.located() };
  }
}

/**
 * Begin an ordered statechart definition. The builder is mutable until
 * build() or System.define() consumes it.
 */
function statechart(options) {
  return new DefinitionBuilder(options);
}

module.exports = { statechart, literal, content, isLiteral, DefinitionBuilder, literalBrand };
