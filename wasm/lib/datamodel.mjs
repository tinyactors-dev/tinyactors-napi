// The native "ecmascript" datamodel of @tinyactors/wasm (docs/browser.md,
// "The native datamodel without node:vm"; the addon's src/datamodel/,
// translated): the vtable's entries, which wasm/src/datamodel.c forwards
// to the import ta_web.datamodel, done in JavaScript with the host's realm
// (realms.mjs) and the realm's script (the addon's src/datamodel/realm.js).
//
// Rows are the host's tables in C (charts, sessions, payloads, loops); the
// value of each is at its row's slot in an array of this file's: a
// chart's record, a session's scope, a payload's value, a loop's items.
//
// Where a chart evaluates: a scope object per session, made by the chart's
// constructor in the host's realm, and each expression one function of
// the scope, compiled at its first evaluation, sloppy outside (`with
// (scope)`) and strict inside: the addon's code path. What a chart's
// scripts declare is asked of the engine by the kit (realm.js, `script`):
// a chart-level script's functions are the chart's helpers, on its scopes'
// prototype; a script's top-level vars are the session's variables; its
// let, const and class are refused, the script's error.execution.
import * as cbor from './cbor.mjs';
import { TinyactorsError } from './errors.mjs';
import { application, makeRealm } from './realms.mjs';

// The entries (wasm/src/datamodel.c).
const DM = {
  ATTACH: 1, DETACH: 2, CREATE: 3, DESERIALIZE: 4, DESTROY: 5, INIT_DATA: 6, BIND_EVENT: 7, DETACH_EVENT: 8,
  EVAL_CONDITION: 9, EVAL_STRING: 10, ASSIGN: 11, ASSIGN_STRING: 12, SCRIPT: 13, LOG: 14, FOREACH_BEGIN: 15,
  FOREACH_ITEM: 16, FOREACH_END: 17, CAPTURE: 18, DROP: 19, CUSTOM: 20, SERIALIZE: 21, MIGRATE: 22, TO_WIRE: 23,
  FROM_WIRE: 24, PAYLOAD_SERIALIZE: 25, PAYLOAD_DESERIALIZE: 26, VARIABLE: 27, FAILURE: 28,
};
const TA_OK = 0, TA_ERROR_EXECUTION = -1, TA_ERROR_INVALID = -3, TA_ERROR_NO_MEMORY = -4, TA_ERROR_STALE = -5;
const TA_ERROR_STATE = -6, TA_ERROR_UNSUPPORTED = -7;
const NIL = 0xFFFFFFFF;
const FAILURE_NONE = 0, FAILURE_EXCEPTION = 1;
// TA_EXPRESSION_* (tinyactors/image.h)
const KIND = { CONDITION: 1, VALUE: 2, LOCATION: 3, SCRIPT: 4, STRING: 5, CONTENT: 6, ITEM: 7, GLOBAL_SCRIPT: 8 };
const TYPES = ['platform', 'internal', 'external'];
const EVENT_FIELDS = ['name', 'type', 'sendid', 'origin', 'origintype', 'invokeid', 'data', 'raw'];
const SPACE = /[ \t\n\r]/;

// The shapes an expression is compiled in (the addon's expressions.c).
const SHARED_VALUE = ["(function(__s){with(__s){return (function(){'use strict';return (\n", "\n);})();}})"];
const SHARED_SCRIPT = ["(function(__s){with(__s){(function(){'use strict';\n", '\n})();}})'];
const SHARED_SETTER = ["(function(__s,__v){with(__s){(function(){'use strict';(\n", '\n) = __v;})();}})'];

const encoder = new TextEncoder();

// A value's source without a trailing `;` (expr="new Foo();").
function trimmed(source) {
  let end = source.length;
  while (end > 0 && (source[end - 1] === ';' || SPACE.test(source[end - 1]))) end--;
  return source.slice(0, end);
}

// The identifier a location starts with (ASCII; empty for anything else).
function leadingName(source) {
  const match = /^[ \t\n\r]*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(source);
  return match === null ? '' : match[1];
}

function trim(text) { return text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ''); }

// A refusal the datamodel answers core with, carrying its status.
class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- the datamodel -----------------------------------------------------------------------------

export class NativeDatamodel {
  constructor(state) {
    this.state = state;
    this.module = state.module;
    this.fn = state.fn;
    this.realm = null;
    this.charts = [];
    this.sessions = [];
    // per session slot: its chart's slot and core's ids of its _event's name, invoke and origintype
    this.meta = new Uint32Array(64);
    this.values = [];
    this.loops = [];
    this.strings = null;
    this.failed = false;
    this.message = '';
    this.evaluating = -1; // the chart slot of the session evaluating, for In()
    this.current = -1; // the slot of the session evaluating
    this.attachError = null; // why the last chart was refused at attach
  }

  // The host's pointer and arena: during the host's making (a restore
  // attaches its charts) JavaScript has neither yet.
  get pointer() { return this.state.pointer || (this.fn.ta_web_host_making(this.module.env) >>> 0); }
  get scratch() { return this.state.scratch || (this.fn.ta_web_host_scratch(this.pointer) >>> 0); }

  // ---- the realm ----

  kit() { return this.ensureRealm().kit; }

  ensureRealm() {
    if (this.realm === null) this.realm = makeRealm((state) => this.in(state));
    return this.realm;
  }

  free() {
    const realm = this.realm;
    this.realm = null;
    this.charts = [];
    this.sessions = [];
    this.values = [];
    this.loops = [];
    realm?.free();
  }

  // SCXML In() of the evaluating session (5.9.1).
  in(state) {
    if (this.evaluating < 0 || this.pointer === 0) return false;
    const name = `${state}`;
    const module = this.module;
    return module.scoped(this.scratch, () => {
      const [at, length] = module.text(this.scratch, name);
      module.setWord(0, at);
      module.setWord(1, length);
      const index = this.fn.ta_web_chart_state(this.pointer, this.evaluating) >>> 0;
      return index !== NIL && this.fn.ta_web_dm_in(this.pointer, index) !== 0;
    });
  }

  // ---- the record and the output ----

  words(n) { return this.module.words().slice(this.module.record, this.module.record + n); }

  text(pointer, length) { return this.module.string(pointer >>> 0, length); }

  // The output room of at least `size` bytes: its address.
  room(size) {
    const at = this.fn.ta_web_dm_output(this.pointer, size) >>> 0;
    if (at === 0) throw new Refused(TA_ERROR_NO_MEMORY, 'no memory for the datamodel\'s output');
    return at;
  }

  // A string in the output room; its length in the record's word 0.
  putText(text) {
    const at = this.room(3 * text.length + 1);
    const { written } = encoder.encodeInto(text, this.module.bytes().subarray(at, at + 3 * text.length + 1));
    this.module.setWord(0, written);
  }

  // Bytes at [pointer, length] of linear memory copied into the output room;
  // the length in the record's word 0.
  putBytes(pointer, length) {
    const at = this.room(length || 1);
    const bytes = this.module.bytes();
    bytes.copyWithin(at, pointer, pointer + length);
    this.module.setWord(0, length);
  }

  // `value` as CBOR (the value table's, or to_wire's with `wire`) in the
  // output room.
  putValue(value, wire) {
    const module = this.module, scratch = this.scratch;
    module.scoped(scratch, () => {
      const [at, length] = cbor.write(module, scratch, value, { realms: true, wire });
      this.putBytes(at, length);
    });
  }

  // The value of the CBOR at [pointer, length], made in the application's realm.
  readValue(pointer, length) {
    const module = this.module;
    return cbor.read(module, this.scratch, pointer, length);
  }

  // ---- the import ----

  // One entry, as the import ta_web.datamodel gives it: its status. What it
  // throws is its error.execution (kept for `failure`), or the refusal's
  // status.
  entry(entry, slot) {
    if (entry === DM.FAILURE) return this.failure();
    if (entry === DM.DROP) {
      this.values[slot] = undefined;
      return TA_OK;
    }
    this.failed = false;
    const outer = this.evaluating, current = this.current;
    try {
      return this.dispatch(entry, slot) ?? TA_OK;
    } catch (error) {
      if (error instanceof Refused) {
        if (error.reason !== undefined) this.state.reason = error.reason;
        if (entry === DM.ATTACH) this.attachError = error.message;
        return error.status;
      }
      this.fail(error);
      if (entry === DM.ATTACH) this.attachError = this.message;
      return entry === DM.ATTACH ? TA_ERROR_INVALID : TA_ERROR_EXECUTION;
    } finally {
      this.evaluating = outer;
      this.current = current;
    }
  }

  fail(error) {
    this.failed = true;
    try {
      this.message = String(error);
    } catch {
      this.message = '';
    }
  }

  failure() {
    if (!this.failed) {
      this.module.setWord(0, FAILURE_NONE);
      return TA_OK;
    }
    this.failed = false;
    this.putText(this.message);
    const length = this.module.word(0);
    this.module.setWord(0, FAILURE_EXCEPTION);
    this.module.setWord(1, length);
    return TA_OK;
  }

  dispatch(entry, slot) {
    switch (entry) {
    case DM.ATTACH: return this.attach(slot);
    case DM.DETACH: this.charts[slot] = undefined; return TA_OK;
    case DM.CREATE: return this.create(slot);
    case DM.DESERIALIZE: return this.deserialize(slot);
    case DM.DESTROY: this.sessions[slot] = undefined; return TA_OK;
    case DM.INIT_DATA: return this.initData(slot);
    case DM.BIND_EVENT: return this.bindEvent(slot);
    case DM.DETACH_EVENT: return TA_OK; // SCXML keeps _event bound to the last event (5.10)
    case DM.EVAL_CONDITION: {
      const e = this.module.word(0);
      const value = this.evaluate(this.session(slot, true), e);
      this.module.setWord(0, value ? 1 : 0);
      return TA_OK;
    }
    case DM.EVAL_STRING: {
      const e = this.module.word(0);
      this.putText(`${this.evaluate(this.session(slot, true), e)}`);
      return TA_OK;
    }
    case DM.ASSIGN: {
      const [location, e] = this.words(2);
      const session = this.session(slot, true);
      this.assign(session, location, this.evaluate(session, e));
      return TA_OK;
    }
    case DM.ASSIGN_STRING: {
      const [location, at, length] = this.words(3);
      const text = this.text(at, length);
      this.assign(this.session(slot, true), location, text);
      return TA_OK;
    }
    case DM.SCRIPT: {
      const e = this.module.word(0);
      this.evaluate(this.session(slot, true), e);
      return TA_OK;
    }
    case DM.LOG: return this.log(slot);
    case DM.FOREACH_BEGIN: return this.foreachBegin(slot);
    case DM.FOREACH_ITEM: return this.foreachItem(slot);
    case DM.FOREACH_END: this.loops[this.module.word(0)] = undefined; return TA_OK;
    case DM.CAPTURE: return this.capture(slot);
    case DM.CUSTOM: return TA_ERROR_UNSUPPORTED;
    case DM.SERIALIZE: return this.serialize(slot);
    case DM.MIGRATE: return this.migrate(slot);
    case DM.TO_WIRE: return this.payloadOut(slot, true);
    case DM.PAYLOAD_SERIALIZE: return this.payloadOut(slot, false);
    case DM.FROM_WIRE:
    case DM.PAYLOAD_DESERIALIZE: return this.fromWire(slot);
    case DM.VARIABLE: return this.variable(slot);
    default: return TA_ERROR_UNSUPPORTED;
    }
  }

  // ---- charts ----

  // Expression `e` of the chart at `slot`, from the image: {kind, line, column, source}.
  expressionOf(chart, e) {
    let info = chart.expressions[e];
    if (info !== undefined) return info;
    const status = this.fn.ta_web_chart_expression(this.pointer, chart.slot, e);
    const w = this.words(6);
    info = status === TA_OK ? { kind: w[1], line: w[2], column: w[3], source: this.text(w[4], w[5]) } : null;
    chart.expressions[e] = info;
    return info;
  }

  attach(slot) {
    const [index, segment, binding] = this.words(3);
    const realm = this.ensureRealm();
    const chart = {
      slot, index, segment, binding, expressions: [], getters: [], setters: [], names: [], invokeids: [], origins: [],
      leading: [], scripts: [], Scope: undefined, data: [],
    };
    const pointer = this.pointer;
    const dataCount = this.fn.ta_web_chart_data_count(pointer, slot);
    for (let i = 0; i < dataCount; i++) {
      if (this.fn.ta_web_chart_data(pointer, slot, i) !== TA_OK) continue;
      const w = this.words(5);
      chart.data.push({ id: this.text(w[1], w[2]), expression: w[3] });
    }
    const count = this.fn.ta_web_chart_expression_count(pointer, slot);
    const names = chart.data.map((d) => d.id);
    const scripts = [];
    for (let e = 0; e < count; e++) {
      const info = this.expressionOf(chart, e);
      if (info === null) continue;
      if (info.kind === KIND.ITEM) {
        const item = trim(info.source);
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item) && !names.includes(item)) names.push(item);
      } else if (info.kind === KIND.SCRIPT || info.kind === KIND.GLOBAL_SCRIPT) scripts.push([e, info]);
    }
    // the scripts, as the kit runs them: the vars they declare are the
    // session's, a chart-level script's functions the chart's helpers
    const helpers = [];
    for (const [e, info] of scripts) {
      const found = realm.kit.script(info.source);
      if (found === null) continue; // it does not parse: its evaluation's SyntaxError
      const [functions, vars, refusal, head, tail] = found;
      if (refusal !== undefined) {
        chart.scripts[e] = refusal;
        continue;
      }
      chart.scripts[e] = [head, tail];
      names.push(...vars);
      if (info.kind === KIND.GLOBAL_SCRIPT && functions.length) helpers.push([info.source, functions]);
    }
    chart.Scope = realm.kit.shape(names, helpers);
    this.charts[slot] = chart;
    return TA_OK;
  }

  // ---- sessions ----

  // The session at `slot` (its scope), with the
  // evaluating chart set for In() and, with `charge`, a fuel unit charged.
  session(slot, charge) {
    const session = this.sessions[slot];
    if (session === undefined) throw new Refused(TA_ERROR_STALE, 'no such session');
    this.evaluating = this.meta[4 * slot];
    this.current = slot;
    if (charge) this.fn.ta_web_dm_charge(this.pointer, 1);
    return session;
  }

  chartOf(slot) { return this.charts[this.meta[4 * slot]]; }

  grow(slot) {
    if (4 * slot + 4 <= this.meta.length) return;
    let length = this.meta.length;
    while (length < 4 * slot + 4) length *= 2;
    const meta = new Uint32Array(length);
    meta.set(this.meta);
    this.meta = meta;
  }

  // The strings of _event the datamodel keeps: the three types, then the
  // I/O processors' types (every session of a host has the same ones).
  keepStrings(types) {
    if (this.strings !== null) return;
    this.strings = [...TYPES, ...types];
  }

  // The start's system variables: [sessionid, name, processors].
  systemOf(words) {
    const pointer = this.pointer;
    const sessionid = this.text(words[3], words[4]), name = this.text(words[5], words[6]);
    const processors = [];
    for (let i = 0; i < words[7]; i++) {
      this.fn.ta_web_dm_processor(pointer, i);
      const w = this.words(4);
      processors.push([this.text(w[0], w[1]), this.text(w[2], w[3])]);
    }
    return [sessionid, name, processors];
  }

  make(slot, chart, link, init) {
    link.init = init;
    return new chart.Scope(link);
  }

  create(slot) {
    const words = this.words(8);
    const init = (BigInt(words[1]) | (BigInt(words[2]) << 32n));
    const chart = this.charts[words[0]];
    const value = init !== 0n ? this.values[Number(init & 0xFFFFFFFFn) - 1] : undefined;
    if (init !== 0n) this.fn.ta_web_payload_drop(this.pointer, words[1], words[2]); // the init's reference is ours
    if (chart === undefined) throw new Refused(TA_ERROR_INVALID, 'no such chart');
    const system = this.systemOf(words);
    this.keepStrings(system[2].map(([type]) => type));
    const link = this.realm.kit.system(...system);
    const session = this.make(slot, chart, link, value);
    this.grow(slot);
    this.meta.set([words[0], NIL, NIL, NIL], 4 * slot);
    this.sessions[slot] = session;
    return TA_OK;
  }

  linkOf(session) { return session[this.realm.kit.LINK]; }

  initData(slot) {
    const declaration = this.module.word(0);
    const session = this.session(slot, true);
    const chart = this.chartOf(slot);
    const data = chart.data[declaration];
    if (data === undefined) throw new Error('no such <data>');
    const init = this.linkOf(session).init;
    let value;
    if (init !== null && typeof init === 'object' && Object.hasOwn(init, data.id)) value = init[data.id];
    else if (data.expression !== NIL) value = this.evaluate(session, data.expression);
    session[data.id] = value;
    return TA_OK;
  }

  // ---- _event ----

  // The string of `text` kept at `index` of a chart's list: the one there
  // when its text is the same, else a new one, kept when the place was empty.
  kept(list, index, text) {
    if (index === NIL) return text;
    const kept = list[index];
    if (kept === text) return kept;
    if (kept === undefined) list[index] = text;
    return text;
  }

  bindEvent(slot) {
    const w = this.words(18);
    const session = this.session(slot, true);
    const chart = this.chartOf(slot);
    const optional = (at) => (w[at + 1] === 0 ? undefined : this.text(w[at], w[at + 1]));
    const strings = this.strings ?? TYPES;
    const data = (BigInt(w[14]) | (BigInt(w[15]) << 32n));
    const fields = [
      this.kept(chart.names, w[1], this.text(w[4], w[5])),
      strings[w[0] % 3],
      optional(6),
      w[9] ? this.kept(chart.origins, w[2], this.text(w[8], w[9])) : undefined,
      w[11] === 0 ? undefined : w[3] !== NIL ? this.kept(strings, 3 + w[3], this.text(w[10], w[11])) : this.text(w[10], w[11]),
      w[13] ? this.kept(chart.invokeids, w[2], this.text(w[12], w[13])) : undefined,
      data !== 0n ? this.values[Number(data & 0xFFFFFFFFn) - 1] : undefined,
      optional(16),
    ];
    const event = this.realm.kit.event(fields);
    Object.defineProperty(session, '_event', { value: event, enumerable: true, configurable: true, writable: false });
    session[this.realm.kit.LINK].init = undefined; // an event has come: the params were read by init_data
    this.meta[4 * slot + 1] = w[1];
    this.meta[4 * slot + 2] = w[2];
    this.meta[4 * slot + 3] = w[3];
    return TA_OK;
  }

  // ---- evaluations ----

  evaluate(session, e) {
    const chart = this.chartOf(this.current);
    const info = this.expressionOf(chart, e);
    if (info === null) throw new Error('no such expression');
    if (info.kind === KIND.CONTENT) return this.content(info.source);
    if (info.kind === KIND.SCRIPT || info.kind === KIND.GLOBAL_SCRIPT) {
      if (chart.getters[e] === undefined && typeof chart.scripts[e] === 'string') chart.getters[e] = chart.scripts[e];
      const [head, tail] = Array.isArray(chart.scripts[e]) ? chart.scripts[e] : SHARED_SCRIPT;
      return this.compiled(chart.getters, e, () => head + info.source + tail)(session);
    }
    return this.compiled(chart.getters, e, () => SHARED_VALUE[0] + trimmed(info.source) + SHARED_VALUE[1])(session);
  }

  // The compiled function of `e` in `cache`, compiled in the realm at its
  // first use; null kept when it did not compile, so it is not compiled
  // again; a string is a refusal, thrown at each evaluation.
  compiled(cache, e, source) {
    const kept = cache[e];
    if (kept === null) throw new this.realm.global.Error('the expression did not compile');
    if (typeof kept === 'string') throw new this.realm.global.Error(kept);
    if (kept !== undefined) return kept;
    let made;
    try {
      made = this.realm.evaluate(source(), `<expr:${e}>`);
    } catch (error) {
      cache[e] = null;
      throw error;
    }
    cache[e] = made;
    return made;
  }

  assign(session, location, value) {
    const chart = this.chartOf(this.current);
    const info = this.expressionOf(chart, location);
    if (info === null) throw new Error('no such location');
    let name = chart.leading[location];
    if (name === undefined) chart.leading[location] = name = leadingName(info.source);
    if (name === '' || !Object.hasOwn(session, name)) throw new this.realm.global.Error('an assignment to a location the session does not declare');
    const fn = this.compiled(chart.setters, location, () => SHARED_SETTER[0] + trimmed(info.source) + SHARED_SETTER[1]);
    fn(session, value);
  }

  log(slot) {
    const e = this.module.word(0);
    let value = this.evaluate(this.session(slot, true), e);
    if (value !== null && typeof value === 'object') {
      try {
        const json = JSON.stringify(value);
        if (typeof json === 'string') value = json;
      } catch {
        // a cycle: its text instead
      }
    }
    this.putText(`${value}`);
    return TA_OK;
  }

  // ---- SCXML B.2: <content> and <data> text ----

  content(text) {
    const kit = this.realm.kit;
    try {
      return kit.parse(text); // JSON
    } catch {
      // not JSON
    }
    if (/^[ \t\n\r]*</.test(text)) {
      const document = this.dom(text);
      if (document !== undefined) return document;
    }
    return text.replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '');
  }

  // The XML document of `text`, made with the kit's XML nodes from the
  // tree txml read in C; undefined when the text is not well-formed XML.
  dom(text) {
    const module = this.module, pointer = this.pointer, scratch = this.scratch;
    return module.scoped(scratch, () => {
      const [at, length] = module.copyIn(scratch, encoder.encode(text));
      module.setWord(0, at);
      module.setWord(1, length);
      const tree = this.fn.ta_web_xml_parse(pointer) >>> 2;
      try {
        const status = module.word(0) | 0;
        if (status === TA_ERROR_NO_MEMORY) throw new Refused(TA_ERROR_NO_MEMORY, 'no memory for the XML content');
        if (status !== TA_OK || tree === 0) return undefined;
        const words = module.words();
        let i = tree;
        const read = () => words[i++];
        const string = () => {
          const p = read(), n = read();
          return module.string(p, n);
        };
        const qualified = (prefix, local) => (prefix ? `${prefix}:${local}` : local);
        const node = () => {
          const kind = read();
          const prefix = string(), name = string(), value = string();
          const attributes = read(), children = read();
          const entry = [kind, undefined, undefined, undefined, []];
          if (kind === 1) {
            entry[1] = qualified(prefix, name);
            const list = {};
            for (let a = 0; a < attributes; a++) {
              const ap = string(), an = string(), av = string();
              Object.defineProperty(list, qualified(ap, an), { value: av, writable: true, enumerable: true, configurable: true });
            }
            entry[3] = list;
          } else {
            entry[1] = kind === 3 ? '#text' : kind === 4 ? '#cdata-section' : kind === 8 ? '#comment' : name;
            entry[2] = value;
          }
          for (let c = 0; c < children; c++) entry[4].push(node());
          return entry;
        };
        const count = read();
        const children = [];
        for (let c = 0; c < count; c++) children.push(node());
        return this.realm.kit.dom(children, text);
      } finally {
        this.fn.ta_web_xml_end(pointer);
      }
    });
  }

  // ---- <foreach> ----

  foreachBegin(slot) {
    const [array, loop] = this.words(2);
    const value = this.evaluate(this.session(slot, true), array);
    if (!Array.isArray(value)) throw new this.realm.global.TypeError('<foreach>\'s array is not an array');
    const items = value.slice(); // the loop walks the items it had
    this.loops[loop] = items;
    this.module.setWord(0, items.length);
    return TA_OK;
  }

  foreachItem(slot) {
    const [loop, i, item, index] = this.words(4);
    const session = this.session(slot, true);
    const items = this.loops[loop];
    if (items === undefined) throw new Refused(TA_ERROR_STALE, 'no such loop');
    this.assign(session, item, items[i]);
    if (index !== NIL) this.assign(session, index, i);
    return TA_OK;
  }

  // ---- payloads ----

  capture(slot) {
    const [session, kind, namelistCount, paramCount, content, namelist, params] = this.words(7);
    void kind;
    const s = this.session(session, true);
    const chart = this.chartOf(session);
    const kit = this.realm.kit;
    let captured;
    if (content !== NIL) captured = kit.copy(this.evaluate(s, content));
    else {
      const names = [], values = [];
      const words = () => this.module.words();
      for (let i = 0; i < namelistCount; i++) {
        const location = words()[(namelist >>> 2) + i];
        const info = this.expressionOf(chart, location);
        if (info === null) throw new Error('no such location');
        names.push(trim(info.source));
        values.push(this.evaluate(s, location));
      }
      for (let i = 0; i < paramCount; i++) {
        const sid = words()[(params >>> 2) + 2 * i], e = words()[(params >>> 2) + 2 * i + 1];
        const at = this.fn.ta_web_chart_string(this.pointer, chart.slot, sid) >>> 0;
        names.push(this.module.string(at, this.module.word(0)));
        values.push(this.evaluate(s, e));
      }
      captured = kit.record(names, values);
    }
    this.values[slot] = captured;
    this.module.setWord(0, 1);
    return TA_OK;
  }

  // A payload's value (to_wire's or the value table's CBOR) in the output.
  payloadOut(slot, wire) {
    try {
      this.putValue(this.values[slot], wire);
    } catch (error) {
      if (error instanceof Refused) throw error;
      if (error instanceof TinyactorsError) {
        const status = error.status === 'TA_ERROR_NO_MEMORY' ? TA_ERROR_NO_MEMORY : wire ? TA_ERROR_INVALID : TA_ERROR_UNSUPPORTED;
        this.fail(error);
        return status;
      }
      throw error;
    }
    return TA_OK;
  }

  // A payload from CBOR (from_wire, payload_deserialize): read, then copied
  // into the host's realm.
  fromWire(slot) {
    const [at, length] = this.words(2);
    let value;
    try {
      value = this.kit().copy(this.readValue(at, length));
    } catch (error) {
      this.fail(error);
      return TA_ERROR_INVALID;
    }
    this.values[slot] = value;
    this.module.setWord(0, 1);
    return TA_OK;
  }

  // A <data> variable for inspection (actor.context): the value itself as a
  // payload, which core writes out with to_wire at once and releases.
  variable(slot) {
    const [session, at, length] = this.words(3);
    const name = this.text(at, length);
    const s = this.session(session, false);
    const chart = this.chartOf(session);
    if (!chart.data.some((d) => d.id === name)) throw new Refused(TA_ERROR_INVALID, 'no such variable');
    const value = s[name];
    this.module.setWord(0, value === undefined ? 0 : 1);
    if (value !== undefined) this.values[slot] = value;
    return TA_OK;
  }

  // The value of payload `handle` (a bigint) in the application's realm.
  exported(handle) {
    const value = this.values[Number(handle & 0xFFFFFFFFn) - 1];
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    return application().exported(value);
  }

  // A payload of the host's realm for a value the application gives: one
  // reference, its handle. A value that cannot cross throws a
  // TinyactorsError of the kit's status.
  payload(value) {
    const kit = this.kit();
    let copy;
    try {
      copy = kit.copy(value);
    } catch (error) {
      const refusal = kit.refusal(error);
      if (refusal === undefined) throw error;
      throw new TinyactorsError(String(error?.message ?? error), { status: refusal === 'invalid' ? 'TA_ERROR_INVALID' : 'TA_ERROR_UNSUPPORTED' });
    }
    const slot = this.fn.ta_web_payload_new(this.pointer);
    if (slot === 0) throw new TinyactorsError('no memory for the payload', { status: 'TA_ERROR_NO_MEMORY' });
    this.values[slot - 1] = copy;
    return this.module.word64(0);
  }

  // ---- hibernation ----

  // A session's variables as hibernation writes them: [names, values].
  stored(session) { return this.realm.kit.stored(session); }

  // _event as a blob holds it: its eight fields, then core's ids; null
  // when no event came yet.
  eventOut(session, slot) {
    const event = session._event;
    if (event === null || typeof event !== 'object') return null;
    const fields = EVENT_FIELDS.map((field) => event[field]);
    fields.push(this.meta[4 * slot + 1], this.meta[4 * slot + 2], this.meta[4 * slot + 3]);
    return fields;
  }

  // The value-table refusal of a session's state as the reason the host
  // gives: which variable, and why.
  reason(what, name, error) {
    const message = error instanceof Error || (error !== null && typeof error === 'object' && 'message' in error)
      ? String(error.message) : 'it is not a value of the value table';
    return name !== undefined ? `${what}${name}' cannot be stored: ${message}` : `${what} cannot be stored: ${message}`;
  }

  // Writes one value's CBOR: [pointer, length] in the scratch; a Refused
  // naming it when the value table refuses it.
  written(value, what, name) {
    try {
      return cbor.write(this.module, this.scratch, value, { realms: true });
    } catch (error) {
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_NO_MEMORY') throw new Refused(TA_ERROR_NO_MEMORY, error.message);
      const refused = new Refused(TA_ERROR_UNSUPPORTED, this.reason(what, name, error));
      refused.reason = refused.message;
      throw refused;
    }
  }

  serialize(slot) {
    this.state.reason = '';
    const session = this.session(slot, false);
    const [names, values] = this.stored(session);
    const vars = {};
    for (let i = 0; i < names.length; i++) {
      Object.defineProperty(vars, names[i], { value: values[i], enumerable: true, writable: true, configurable: true });
    }
    let event;
    try {
      event = this.eventOut(session, slot);
    } catch (error) {
      const refused = new Refused(TA_ERROR_UNSUPPORTED, this.reason('_event', undefined, error));
      refused.reason = refused.message;
      throw refused;
    }
    const module = this.module, scratch = this.scratch;
    module.scoped(scratch, () => {
      let written;
      try {
        written = cbor.write(module, scratch, { vars, event }, { realms: true });
      } catch (error) {
        if (error instanceof TinyactorsError && error.status === 'TA_ERROR_NO_MEMORY') throw new Refused(TA_ERROR_NO_MEMORY, error.message);
        // which value: the variable it names, else _event
        for (let i = 0; i < names.length; i++) module.scoped(scratch, () => this.written(values[i], 'variable \'', names[i]));
        module.scoped(scratch, () => this.written(event, '_event', undefined));
        throw error;
      }
      this.putBytes(written[0], written[1]);
    });
    return TA_OK;
  }

  // A session from a blob serialize wrote, for its chart now: its
  // variables (all of them kept in its link's init until the first event
  // or migrate takes them) and its _event.
  deserialize(slot) {
    const words = this.words(8);
    const chart = this.charts[words[0]];
    if (chart === undefined) throw new Refused(TA_ERROR_INVALID, 'no such chart');
    const state = this.readValue(words[1], words[2]);
    if (state === null || typeof state !== 'object' || state.vars === null || typeof state.vars !== 'object') {
      throw new Refused(TA_ERROR_INVALID, 'not a blob of the native datamodel');
    }
    const system = this.systemOf(words);
    this.keepStrings(system[2].map(([type]) => type));
    const session = this.revive(slot, { chart, link: this.realm.kit.system(...system), vars: state.vars, init: state.vars });
    this.eventIn(session, slot, chart, state.event);
    return TA_OK;
  }

  // A session made again (a wake, a restore): its variables set, the blob's
  // all kept in its link's init for migrate.
  revive(slot, { chart, link, vars, init }) {
    const session = this.make(slot, chart, link, init);
    this.grow(slot);
    this.meta.set([chart.slot, NIL, NIL, NIL], 4 * slot);
    this.realm.kit.restore(session, vars);
    this.sessions[slot] = session;
    return session;
  }

  // _event from the fields a blob holds, its strings shared with the
  // chart's (by core's ids, when the text is the same).
  eventIn(session, slot, chart, fields) {
    if (fields === null || fields === undefined) return;
    if (!Array.isArray(fields) || fields.length !== 11) throw new Refused(TA_ERROR_INVALID, 'not a blob of the native datamodel');
    const id = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= NIL ? v : NIL);
    const [nameID, invoke, origintype] = [id(fields[8]), id(fields[9]), id(fields[10])];
    const made = fields.slice(0, 8);
    const keep = (list, index, text) => (typeof text === 'string' ? this.kept(list, index, text) : text);
    made[0] = keep(chart.names, nameID, made[0]);
    const types = this.strings ?? TYPES;
    for (let i = 0; i < 3; i++) if (types[i] === made[1]) made[1] = types[i];
    made[3] = keep(chart.origins, invoke, made[3]);
    made[4] = origintype < NIL - 3 ? keep(types, 3 + origintype, made[4]) : made[4];
    made[5] = keep(chart.invokeids, invoke, made[5]);
    if (made[6] !== undefined) made[6] = this.realm.kit.copy(made[6]);
    const event = this.realm.kit.event(made);
    Object.defineProperty(session, '_event', { value: event, enumerable: true, configurable: true, writable: false });
    this.meta[4 * slot + 1] = nameID;
    this.meta[4 * slot + 2] = invoke;
    this.meta[4 * slot + 3] = origintype;
  }

  // After deserialize, for a blob of an older version of the chart: the
  // old bindings (exactly the old chart's variables) as one payload.
  migrate(slot) {
    const session = this.session(this.module.word(0), true);
    const old = this.realm.kit.upgrade(session);
    if (old !== null && typeof old === 'object') {
      this.values[slot] = this.realm.kit.copy(old);
      this.module.setWord(0, 1);
    } else this.module.setWord(0, 0);
    return TA_OK;
  }

  // ---- snapshots ----

  // The native datamodel's state for a host snapshot: the tables'
  // namespaces and every row, each value as CBOR bytes of its own (the
  // addon's format). Throws a TinyactorsError when a session's state
  // cannot be stored.
  snapshot() {
    const module = this.module, pointer = this.pointer, scratch = this.scratch;
    const layout = (which) => {
      const status = this.fn.ta_web_dm_layout(pointer, which);
      if (status !== TA_OK) throw new TinyactorsError('no memory for the snapshot', { status: 'TA_ERROR_NO_MEMORY' });
      return module.copyOut(module.word(0), module.word(1));
    };
    const rows = (which) => {
      for (let room = 1024; ; room *= 4) {
        const out = module.scoped(scratch, () => {
          const at = module.room(scratch, 12 * room);
          module.setWord(0, at);
          module.setWord(1, room);
          const n = this.fn.ta_web_dm_rows(pointer, which);
          if (n === room) return null; // perhaps more: again with more room
          const words = module.words(), base = at >>> 2, found = [];
          for (let i = 0; i < n; i++) found.push([BigInt(words[base + 3 * i]) | (BigInt(words[base + 3 * i + 1]) << 32n), words[base + 3 * i + 2]]);
          return found;
        });
        if (out !== null) return out;
      }
    };
    const bytes = (value, what, name) => module.scoped(scratch, () => {
      const [at, length] = this.writtenSnapshot(value, what, name);
      return module.copyOut(at, length);
    });
    const state = { sessions: layout(0), payloads: layout(1), loops: layout(2) };
    state.rows = rows(0).map(([handle]) => this.snapshotSession(handle, bytes));
    state.values = rows(1).map(([handle, count]) => [handle, count, bytes(this.values[Number(handle & 0xFFFFFFFFn) - 1], 'a payload')]);
    state.items = rows(2).map(([handle]) => [handle, bytes(this.loops[Number(handle & 0xFFFFFFFFn) - 1], 'a <foreach>\'s items')]);
    return state;
  }

  writtenSnapshot(value, what, name) {
    try {
      return cbor.write(this.module, this.scratch, value, { realms: true });
    } catch (error) {
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_NO_MEMORY') throw error;
      throw new TinyactorsError(this.reason(what, name, error), { status: 'TA_ERROR_UNSUPPORTED' });
    }
  }

  // One session row: [handle, segment, chart index, {name: bytes}, _event
  // as bytes, the link's [sessionid, name, processors] as bytes, its init
  // as bytes or null].
  snapshotSession(handle, bytes) {
    const slot = Number(handle & 0xFFFFFFFFn) - 1;
    const session = this.sessions[slot];
    const chart = this.chartOf(slot);
    if (session === undefined || chart === undefined) throw new TinyactorsError('a session without its chart', { status: 'TA_ERROR_INVALID' });
    const [names, values] = this.stored(session);
    const vars = {};
    for (let i = 0; i < names.length; i++) {
      Object.defineProperty(vars, names[i], { value: bytes(values[i], 'variable \'', names[i]), enumerable: true, writable: true, configurable: true });
    }
    let event;
    try {
      event = this.eventOut(session, slot);
    } catch (error) {
      throw new TinyactorsError(this.reason('_event', undefined, error), { status: 'TA_ERROR_UNSUPPORTED' });
    }
    const linked = this.realm.kit.linked(session);
    return [
      handle, chart.segment, chart.index, vars, bytes(event, '_event'),
      bytes([linked[0], linked[1], linked[2]], 'the system variables'),
      linked[3] === undefined ? null : bytes(linked[3], 'the params'),
    ];
  }

  // The state a snapshot holds back into a fresh datamodel: the tables'
  // namespaces, then every row at its handle (a row twice, or one the
  // tables do not hold, refused).
  restore(state) {
    const module = this.module, pointer = this.pointer, scratch = this.scratch;
    const invalid = (message) => new TinyactorsError(message, { status: 'TA_ERROR_INVALID' });
    const keys = ['sessions', 'payloads', 'loops', 'rows', 'values', 'items'];
    if (state === null || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).join() !== keys.join()) {
      throw invalid('not a snapshot of the native datamodel');
    }
    const bytesOf = (value) => {
      if (!(value instanceof Uint8Array)) throw invalid('not a snapshot of the native datamodel');
      return value;
    };
    const valueOf = (value) => module.scoped(scratch, () => {
      const [at, length] = module.copyIn(scratch, bytesOf(value));
      return cbor.read(module, scratch, at, length);
    });
    for (const [which, key] of [[0, 'sessions'], [1, 'payloads'], [2, 'loops']]) {
      module.scoped(scratch, () => {
        const [at, length] = module.copyIn(scratch, bytesOf(state[key]));
        module.setWord(0, at);
        module.setWord(1, length);
        const status = this.fn.ta_web_dm_restore(pointer, which);
        if (status === TA_ERROR_STATE) throw new TinyactorsError('the native datamodel is not a fresh one', { status: 'TA_ERROR_STATE' });
        if (status !== TA_OK) throw new TinyactorsError('a table of the snapshot does not restore', { status: module.statusName(status) });
      });
    }
    const handleOf = (value) => {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
      if (typeof value === 'bigint' && value > 0n) return value;
      throw invalid('not a snapshot of the native datamodel');
    };
    const fill = (which, handle, value, what) => {
      module.setWord64(0, handle);
      module.setWord(2, value);
      if (this.fn.ta_web_dm_fill(pointer, which) !== TA_OK) throw invalid(what);
    };
    const rows = state.rows, values = state.values, items = state.items;
    if (!Array.isArray(rows) || !Array.isArray(values) || !Array.isArray(items)) throw invalid('not a snapshot of the native datamodel');
    this.ensureRealm();
    const kit = this.realm.kit;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 7) throw invalid('not a session of a snapshot');
      const handle = handleOf(row[0]);
      const chart = this.charts.find((c) => c !== undefined && c.segment === row[1] && c.index === row[2]);
      if (chart === undefined) throw invalid('a session whose chart the restored host does not have');
      fill(0, handle, chart.slot, 'a session the snapshot\'s tables do not hold, or twice');
      const slot = Number(handle & 0xFFFFFFFFn) - 1;
      const system = valueOf(row[5]);
      if (!Array.isArray(system) || system.length !== 3 || !Array.isArray(system[2])) throw invalid('not a session of a snapshot');
      this.keepStrings(system[2].map((pair) => pair[0]));
      const init = row[6] === null ? undefined : kit.copy(valueOf(row[6]));
      if (row[3] === null || typeof row[3] !== 'object') throw invalid('not a session of a snapshot');
      const vars = {};
      for (const name of Object.keys(row[3])) {
        Object.defineProperty(vars, name, { value: valueOf(row[3][name]), enumerable: true, writable: true, configurable: true });
      }
      const session = this.revive(slot, { chart, link: kit.system(system[0], system[1], system[2]), vars, init });
      this.eventIn(session, slot, chart, valueOf(row[4]));
    }
    for (const row of values) {
      if (!Array.isArray(row) || row.length !== 3) throw invalid('a payload the snapshot\'s tables do not hold, or twice');
      const handle = handleOf(row[0]);
      const count = row[1];
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > NIL) throw invalid('a payload the snapshot\'s tables do not hold, or twice');
      fill(1, handle, count, 'a payload the snapshot\'s tables do not hold, or twice');
      this.values[Number(handle & 0xFFFFFFFFn) - 1] = kit.copy(valueOf(row[2]));
    }
    for (const row of items) {
      if (!Array.isArray(row) || row.length !== 2) throw invalid('a <foreach> the snapshot\'s tables do not hold, or twice');
      const handle = handleOf(row[0]);
      fill(2, handle, 0, 'a <foreach> the snapshot\'s tables do not hold, or twice');
      const slot = Number(handle & 0xFFFFFFFFn) - 1;
      if (this.loops[slot] !== undefined) throw invalid('a <foreach> the snapshot\'s tables do not hold, or twice');
      const value = kit.copy(valueOf(row[1]));
      if (!Array.isArray(value)) throw invalid('a <foreach>\'s items are not an array');
      this.loops[slot] = value;
    }
  }
}
