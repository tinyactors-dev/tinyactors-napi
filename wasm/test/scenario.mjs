// What the module's tests do, runtime-neutral (no node: built-in), so the
// same functions run in node, bun, a Chromium page and a Worker
// (test/wasm.test.mjs, test/browser.test.mjs): each takes a loaded
// WebModule (wasm/lib/module.mjs) and answers what it saw; the callers
// assert. They drive the C layer's exports directly, as p5-api's classes
// will.
import * as cbor from '../lib/cbor.mjs';

const FIELD = { KIND: 1, SESSION: 4, IO_PROCESSOR: 7, TARGET: 32, EVENT: 33, AUXILIARY: 35 };
const EFFECT_SEND = 1, EFFECT_LOG = 5;
const NEXT = ['yield', 'idle', 'exhausted', 'fault', 'refused'];

export const HELLO = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="null" name="hello" initial="a">
  <state id="a">
    <onentry><send type="urn:test" event="hello" target="world"/></onentry>
    <transition target="done"/>
  </state>
  <final id="done"/>
</scxml>`;

export const LOGGING = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="logging" initial="a">
  <state id="a"><onentry><log label="it" expr="greeting"/></onentry></state>
</scxml>`;

const now = () => performance.now() * 1e6;
const wall = () => (performance.timeOrigin + performance.now()) * 1e6;

// Compiles charts (an array of [name, text]) into image bytes, copied out.
export function compile(module, charts, resolver) {
  const scratch = module.scratch;
  let resolveError = null;
  const owner = {
    resolve() {
      const base = module.string(module.word(0), module.word(1));
      const source = module.string(module.word(2), module.word(3));
      const text = resolver(base, source);
      const encoded = new TextEncoder().encode(text);
      const at = module.call('ta_web_resolve_room', module.env, Math.max(1, encoded.length));
      module.bytes().set(encoded, at);
      module.setWord(0, 0);
      module.setWord(1, 0);
      module.setWord(2, 0);
      module.setWord(3, at);
      module.setWord(4, encoded.length);
      return 0;
    },
    raised(error) { resolveError = error; },
  };
  const id = module.register(owner);
  try {
    return module.scoped(scratch, () => {
      const pairs = module.room(scratch, 16 * charts.length) >>> 2;
      charts.forEach(([name, text], i) => {
        const [n, nl] = module.text(scratch, name);
        const [t, tl] = module.text(scratch, text);
        module.words().set([n, nl, t, tl], pairs + 4 * i);
      });
      module.setWord(0, pairs << 2);
      module.setWord(1, charts.length);
      module.setWord(2, 0);
      module.setWord(3, resolver ? 1 : 0);
      module.setWord(4, id);
      const result = module.call('ta_web_compile', module.env, 0);
      const status = module.word(0) | 0;
      const diagnostics = [];
      for (let i = 0, n = result ? module.call('ta_web_compile_diagnostic_count', result) : 0; i < n; i++) {
        module.call('ta_web_compile_diagnostic', module.env, result, i);
        diagnostics.push({ severity: module.word(0), line: module.word(2), message: module.string(module.word(6), module.word(7)) });
      }
      let image = null;
      if (status === 0) {
        const at = module.call('ta_web_compile_image', module.env, result);
        image = module.copyOut(at, module.word(0));
      }
      if (result) module.call('ta_web_compile_free', result);
      if (resolveError) throw resolveError;
      return { status, image, diagnostics };
    });
  } finally {
    module.unregister(id);
  }
}

// A host over the C layer: its handler object is what the imports call.
export class RawHost {
  constructor(module, { config, datamodel = 0, effect, datamodelEntry } = {}) {
    this.module = module;
    this.errors = [];
    this.effects = [];
    this.onEffect = effect;
    this.onDatamodel = datamodelEntry;
    this.id = module.register(this);
    const scratch = module.scratch;
    this.pointer = module.scoped(scratch, () => {
      const [at, length] = cbor.write(module, scratch, config);
      module.setWord(0, at);
      module.setWord(1, length);
      module.setWord(2, this.id);
      module.setWord(3, datamodel);
      module.setWord(4, 0);
      module.setWord(5, 0);
      const host = module.call('ta_web_host_new', module.env);
      if (host === 0) throw module.refusal(module.word(0) | 0, 'the config was refused');
      return host;
    });
    this.scratch = module.call('ta_web_host_scratch', this.pointer);
  }

  // ---- what the imports call ----
  effect(index, extra) {
    const m = this.module;
    const kind = m.call('ta_web_effect_word', this.pointer, index, FIELD.KIND);
    const record = { kind, extra };
    if (kind === EFFECT_SEND || kind === EFFECT_LOG) {
      record.event = this.text(index, FIELD.EVENT);
      record.target = this.text(index, FIELD.TARGET);
      record.auxiliary = this.text(index, FIELD.AUXILIARY);
      record.session = m.call('ta_web_effect_number', this.pointer, index, FIELD.SESSION);
      record.processor = m.call('ta_web_effect_word', this.pointer, index, FIELD.IO_PROCESSOR);
    }
    this.effects.push(record);
    return this.onEffect?.(record) ?? 0;
  }

  output() { return 0; }
  clock(which) { return which === 0 ? now() : wall(); }
  datamodel(entry, slot) { return this.onDatamodel ? this.onDatamodel(entry, slot) : -7; }
  raised(error) { this.errors.push(error); }

  text(index, field) {
    const at = this.module.call('ta_web_effect_text', this.pointer, index, field);
    return this.module.string(at, this.module.word(0));
  }

  // ---- inputs ----
  addImage(image) {
    const m = this.module;
    return m.scoped(this.scratch, () => {
      const [at, length] = m.copyIn(this.scratch, image);
      m.setWord(0, at);
      m.setWord(1, length);
      const status = m.call('ta_web_host_add_image', this.pointer);
      if (status !== 0) throw m.refusal(status, 'addImage');
      return m.word(1);
    });
  }

  chart(name) {
    const m = this.module;
    return m.scoped(this.scratch, () => {
      const [at, length] = m.text(this.scratch, name);
      m.setWord(0, at);
      m.setWord(1, length);
      const status = m.call('ta_web_host_chart', this.pointer);
      if (status !== 0) throw m.refusal(status, 'chart');
      return { segment: m.word(1), chart: m.word(2) };
    });
  }

  spawn(ref) {
    const m = this.module;
    m.call('ta_web_host_advance', this.pointer);
    for (let i = 0; i < 8; i++) m.setWord(i, 0);
    m.setWord(0, ref.segment);
    m.setWord(1, ref.chart);
    const status = m.call('ta_web_host_spawn', this.pointer);
    if (status !== 0) throw m.refusal(status, 'spawn');
    return m.word64(1);
  }

  // Turns until idle; answers what each turn answered.
  run(limit = 100) {
    const turns = [];
    for (let i = 0; i < limit; i++) {
      const next = NEXT[this.module.call('ta_web_turn', this.pointer)];
      turns.push(next);
      if (next !== 'yield') break;
    }
    return turns;
  }

  free() {
    const status = this.module.call('ta_web_host_free', this.pointer);
    this.module.unregister(this.id);
    return status;
  }
}

const CONFIG = { systemID: 'web', ioProcessors: [{ type: 'urn:test' }] };

// A host made, a null-datamodel chart run, the host freed.
export function nullChart(module) {
  const { image, diagnostics } = compile(module, [['hello.scxml', HELLO]]);
  if (image === null) throw new Error(`compile: ${JSON.stringify(diagnostics)}`);
  const host = new RawHost(module, { config: CONFIG });
  const ticksPerSecond = module.call('ta_web_host_ticks_per_second', host.pointer);
  host.addImage(image);
  const session = host.spawn(host.chart('hello'));
  const turns = host.run();
  const sends = host.effects.filter((e) => e.kind === EFFECT_SEND).map((e) => ({ event: e.event, target: e.target, processor: e.processor, session: e.session }));
  const freed = host.free();
  return { session, turns, sends, ticksPerSecond, freed, imageBytes: image.length, envDepth: module.call('ta_web_env_depth', module.env) };
}

// `count` actors each send once to a handler that throws: every import
// catches, the stack and the depths are where they were.
export function throwingImports(module, count) {
  const { image } = compile(module, [['hello.scxml', HELLO]]);
  const host = new RawHost(module, { config: CONFIG, effect() { throw new Error('a handler that throws'); } });
  host.addImage(image);
  const ref = host.chart('hello');
  const before = module.call('ta_web_stack');
  for (let i = 0; i < count; i++) host.spawn(ref);
  const turns = host.run(1000);
  const after = module.call('ta_web_stack');
  const result = {
    before, after, turns: turns.length, last: turns.at(-1), raised: host.errors.length,
    hostDepth: module.call('ta_web_host_depth', host.pointer), envDepth: module.call('ta_web_env_depth', module.env),
  };
  host.free();
  return result;
}

// The same module instantiated with imports that do not catch: what each
// throw through wasm frames leaves behind (docs/browser.md, "Exceptions,
// ..."), for comparison. `wasm` is the compiled WebAssembly.Module.
export function unguardedImports(wasm, count) {
  let stackOf = null;
  const exports = new WebAssembly.Instance(wasm, {
    ta_web: {
      effect() { throw new Error('unguarded'); },
      output: () => 0, clock: () => now(), resolve: () => 0, datamodel: () => -7,
    },
  }).exports;
  exports._initialize();
  const env = exports.ta_web_env_new();
  const record = exports.ta_web_env_record(env) >>> 2;
  const words = () => new Uint32Array(exports.memory.buffer);
  stackOf = () => exports.ta_web_stack();
  // a raw host of the hello chart, made with the record by hand
  const scratch = exports.ta_web_env_scratch(env);
  const level = exports.ta_web_scratch_enter(scratch);
  const put = (text) => {
    const bytes = new TextEncoder().encode(text);
    const at = exports.ta_web_scratch_room(scratch, bytes.length);
    new Uint8Array(exports.memory.buffer).set(bytes, at);
    return [at, bytes.length];
  };
  const [n, nl] = put('hello.scxml');
  const [t, tl] = put(HELLO);
  const pairs = exports.ta_web_scratch_room(scratch, 16);
  words().set([n, nl, t, tl], pairs >>> 2);
  words().set([pairs, 1, 0, 0, 0], record);
  const result = exports.ta_web_compile(env, 0);
  const at = exports.ta_web_compile_image(env, result);
  const image = new Uint8Array(exports.memory.buffer).slice(at, at + words()[record]);
  exports.ta_web_compile_free(result);
  // config {systemID: "web", ioProcessors: [{type: "urn:test"}]} as CBOR, by hand
  const config = new Uint8Array([0xa2, 0x68, ...new TextEncoder().encode('systemID'), 0x63, 0x77, 0x65, 0x62,
    0x6c, ...new TextEncoder().encode('ioProcessors'), 0x81, 0xa1, 0x64, ...new TextEncoder().encode('type'),
    0x68, ...new TextEncoder().encode('urn:test')]);
  const c = exports.ta_web_scratch_room(scratch, config.length);
  new Uint8Array(exports.memory.buffer).set(config, c);
  words().set([c, config.length, 1, 0, 0, 0], record);
  const host = exports.ta_web_host_new(env);
  const i = exports.ta_web_scratch_room(scratch, image.length);
  new Uint8Array(exports.memory.buffer).set(image, i);
  words().set([i, image.length], record);
  exports.ta_web_host_add_image(host);
  const before = stackOf();
  let thrown = 0;
  for (let k = 0; k < count; k++) {
    words().set([0, 0, 0, 0, 0, 0, 0, 0], record);
    exports.ta_web_host_spawn(host);
    try {
      while (exports.ta_web_turn(host) === 0);
    } catch {
      thrown++;
    }
  }
  const after = stackOf();
  exports.ta_web_scratch_leave(scratch, level);
  return { before, after, thrown, envDepth: exports.ta_web_env_depth(env) };
}

// A trap (a read out of bounds through a bogus host) poisons the
// instance: that call and every later one refuse with TA_ERROR_STATE.
export function trap(module) {
  const seen = [];
  for (const attempt of [() => module.call('ta_web_host_free', 0xFFFFFF00), () => module.call('ta_web_version')]) {
    try {
      attempt();
      seen.push(null);
    } catch (error) {
      seen.push({ name: error.name, status: error.status, message: error.message, cause: error.cause?.constructor?.name });
    }
  }
  return { seen, poisoned: module.poisoned };
}

// The native datamodel's entries reach JavaScript: a stub that answers a
// <log>'s expression with text written into the output room.
export function forwarding(module) {
  const ENTRY = { ATTACH: 1, CREATE: 3, DESTROY: 5, BIND_EVENT: 7, LOG: 14, DETACH_EVENT: 8 };
  const { image, diagnostics } = compile(module, [['logging.scxml', LOGGING]]);
  if (image === null) throw new Error(`compile: ${JSON.stringify(diagnostics)}`);
  const entries = [];
  let host = null;
  host = new RawHost(module, {
    config: { systemID: 'web' },
    datamodel: 1,
    datamodelEntry(entry, slot) {
      entries.push(entry);
      if (entry === ENTRY.LOG) {
        const e = module.word(0);
        module.call('ta_web_chart_expression', host.pointer, 0, e);
        const source = module.string(module.word(4), module.word(5));
        const text = new TextEncoder().encode(`${source} says hello`);
        const at = module.call('ta_web_dm_output', host.pointer, text.length);
        module.bytes().set(text, at);
        module.setWord(0, text.length);
      }
      if (entry === ENTRY.CREATE) entries.push(`session ${module.string(module.word(3), module.word(4))}`);
      return 0;
    },
  });
  host.addImage(image);
  host.spawn(host.chart('logging'));
  host.run();
  const logs = host.effects.filter((e) => e.kind === EFFECT_LOG).map((e) => ({ label: e.auxiliary, text: e.event }));
  host.free();
  return { entries, logs };
}

// txml's tree record: an element with an attribute, text and a comment.
export function xmlTree(module) {
  const { image } = compile(module, [['hello.scxml', HELLO]]);
  const host = new RawHost(module, { config: CONFIG });
  host.addImage(image);
  const tree = module.scoped(host.scratch, () => {
    const [at, length] = module.text(host.scratch, '<?xml version="1.0"?><a xmlns:x="urn:x" x:k="v">hi<!--c--><b/></a>');
    module.setWord(0, at);
    module.setWord(1, length);
    const words = module.call('ta_web_xml_parse', host.pointer);
    const status = module.word(0) | 0, count = module.word(1);
    const w = module.words().slice(words >>> 2, (words >>> 2) + count);
    let i = 0;
    const str = () => { const s = module.string(w[i], w[i + 1]); i += 2; return s; };
    const node = () => {
      const kind = w[i++];
      const prefix = str(), name = str(), text = str();
      const attributes = w[i++], children = w[i++];
      const out = { kind, name: prefix ? `${prefix}:${name}` : name, text, attributes: [], children: [] };
      for (let a = 0; a < attributes; a++) { const p = str(), n = str(), v = str(); out.attributes.push([p ? `${p}:${n}` : n, v]); }
      for (let c = 0; c < children; c++) out.children.push(node());
      return out;
    };
    const top = [];
    for (let c = 0, n = w[i++]; c < n; c++) top.push(node());
    module.call('ta_web_xml_end', host.pointer);
    return { status, top };
  });
  host.free();
  return tree;
}

// A resolver crosses: a chart whose <script src> the resolver gives.
export function resolving(module) {
  const chart = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="r"><script src="lib.js"/><state id="a"/></scxml>`;
  const asked = [];
  const { status, image } = compile(module, [['r.scxml', chart]], (base, source) => {
    asked.push([base, source]);
    return 'var x = 1;';
  });
  return { status, asked, compiled: image !== null };
}

// The CBOR codec both ways.
export function roundTrip(module, value) {
  const scratch = module.scratch;
  return module.scoped(scratch, () => {
    const [at, length] = cbor.write(module, scratch, value);
    return cbor.read(module, scratch, at, length);
  });
}
