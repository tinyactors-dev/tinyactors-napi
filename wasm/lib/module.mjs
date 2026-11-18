// The module instance (docs/browser.md): loads tinyactors.wasm, gives it
// its imports, and calls its exports. Everything above it (the classes)
// goes through `WebModule.call` or its guarded exports `WebModule.fn`,
// never through the exports themselves, so the two rules of "Exceptions, an unclosed host, the
// floor, the address space" hold in one place:
//
//   - every import catches what JavaScript throws and answers a status
//     (the error is kept by the import's owner for its turn to report), so
//     no exception unwinds through wasm frames, which would skip C's
//     cleanup and leave shadow stack behind;
//   - anything that still escapes an export (a trap: a WebAssembly
//     RuntimeError, the stack exhausted, unreachable) poisons the
//     instance: every later call refuses with TA_ERROR_STATE naming the
//     first cause, and the application loads the module again.
//
// Views of linear memory are this module's own, re-derived when growth
// detached them (byteLength 0); nothing the application holds is one.
import { TinyactorsError } from './errors.mjs';

// The module the package ships, beside its entries.
const BUNDLED = new URL('../tinyactors.wasm', import.meta.url);

const TA_OK = 0;
const TA_ERROR_EXECUTION = -1;
const TA_ERROR_INVALID = -3;
const TA_ERROR_NO_MEMORY = -4;
const TA_ERROR_STATE = -6;
const TA_ERROR_ABORTED = -9;

const encoder = new TextEncoder();
// A double and its two words (little-endian, as wasm's memory is).
const DOUBLE = new Float64Array(1);
const BITS = new Uint32Array(DOUBLE.buffer);
const decoder = new TextDecoder('utf-8', { fatal: true });

// node:fs by a name a bundler does not follow (esbuild cannot resolve a
// built-in of Node.js for a page): a page never takes the `file:` branch.
const NODE_FS = 'node:fs/promises';

// A WebAssembly.Module from `source`: undefined for the bundled one, a URL
// or a string (relative to this file), a Response or its promise, bytes,
// or a module. A `file:` URL is read with node:fs (node, bun).
async function compileModule(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (source === undefined || source instanceof URL || typeof source === 'string') {
    const url = source === undefined ? BUNDLED : new URL(source, import.meta.url);
    if (url.protocol === 'file:') {
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ NODE_FS);
      return WebAssembly.compile(await readFile(url));
    }
    source = fetch(url);
  }
  if (source instanceof Promise) source = await source;
  if (typeof Response !== 'undefined' && source instanceof Response) {
    if (!source.ok) throw new TinyactorsError(`tinyactors.wasm: ${source.status} ${source.statusText} for ${source.url}`, { status: 'TA_ERROR_INVALID' });
    if (WebAssembly.compileStreaming) {
      try {
        return await WebAssembly.compileStreaming(source.clone());
      } catch {
        // A server that does not give application/wasm: compile the bytes.
      }
    }
    return WebAssembly.compile(await source.arrayBuffer());
  }
  return WebAssembly.compile(source);
}

// Loads the module (the bundled one, or `source`) and makes an instance:
// each load is an instance of its own, whose hosts share its memory.
export async function load(source) {
  return new WebModule(await compileModule(source));
}

export class WebModule {
  #exports;
  #memory;
  #bytes = new Uint8Array(0);
  #words = new Uint32Array(0);
  #owners = new Map(); // id -> WeakRef of what an import calls (a host's handler, a compilation's)
  #next = 1;
  #poison = null;      // the first cause, once poisoned
  #env = 0;
  #record = 0;         // the record's index in #words

  constructor(module) {
    const guard = (id, answer, failed) => {
      // what an import does: its owner's work, never an exception into wasm
      try {
        return answer(this.#owner(id));
      } catch (error) {
        this.#raised(id, error);
        return failed;
      }
    };
    const imports = {
      ta_web: {
        effect: (host, index, extra) => guard(host, (owner) => owner.effect(index, extra) ?? TA_OK, TA_ERROR_EXECUTION),
        output: (host, kind, length) => guard(host, (owner) => owner.output(kind, length) ?? TA_OK, TA_ERROR_NO_MEMORY),
        clock: (host, which) => guard(host, (owner) => owner.clock(which), 0),
        resolve: (compilation) => guard(compilation, (owner) => owner.resolve() ?? TA_OK, TA_ERROR_ABORTED),
        datamodel: (host, entry, slot) => guard(host, (owner) => owner.datamodel(entry, slot) ?? TA_OK, TA_ERROR_EXECUTION),
      },
    };
    const instance = new WebAssembly.Instance(module, imports);
    this.#exports = instance.exports;
    this.#memory = instance.exports.memory;
    // Each export guarded as call() guards it, with its three arguments
    // fixed (no export takes more): the calls the hot paths make.
    const fn = {};
    for (const [name, f] of Object.entries(instance.exports)) {
      if (typeof f !== 'function') continue;
      fn[name] = (a, b, c) => {
        if (this.#poison !== null) throw this.#poisoned();
        let result;
        try {
          result = f(a, b, c);
        } catch (error) {
          if (this.#poison === null) this.#poison = error;
          throw this.#poisoned();
        }
        if (this.#poison !== null) throw this.#poisoned();
        return result;
      };
    }
    this.fn = Object.freeze(fn);
    this.call('_initialize');
    this.#env = this.call('ta_web_env_new');
    if (this.#env === 0) throw new TinyactorsError('no memory for the module\'s environment', { status: 'TA_ERROR_NO_MEMORY' });
    this.#record = this.call('ta_web_env_record', this.#env) >>> 2;
  }

  // ---- calls ------------------------------------------------------------------

  // Calls export `name`: refused once poisoned; whatever escapes it poisons
  // the instance (and so does a nested call's escape, seen when this one
  // returns).
  call(name, ...args) {
    if (this.#poison !== null) throw this.#poisoned();
    let result;
    try {
      result = this.#exports[name](...args);
    } catch (error) {
      if (this.#poison === null) this.#poison = error;
      throw this.#poisoned();
    }
    if (this.#poison !== null) throw this.#poisoned();
    return result;
  }

  get poisoned() { return this.#poison !== null; }

  #poisoned() {
    const cause = this.#poison;
    const what = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    return new TinyactorsError(`the tinyactors module stopped (load it again): ${what}`, { status: 'TA_ERROR_STATE', cause });
  }

  // ---- owners of imports ----------------------------------------------------------

  // A number for `owner` (a host's handler, a compilation's resolver),
  // which C gives back to name it in an import; held weakly, so the table
  // keeps nothing alive.
  register(owner) {
    const id = this.#next++;
    this.#owners.set(id, new WeakRef(owner));
    return id;
  }

  unregister(id) { this.#owners.delete(id); }

  #owner(id) {
    const owner = this.#owners.get(id)?.deref();
    if (owner === undefined) throw new TinyactorsError(`no owner ${id} for an import`, { status: 'TA_ERROR_STALE' });
    return owner;
  }

  // What an import's owner threw: kept by it (raised), for its turn or call
  // to report; an owner that is gone loses it.
  #raised(id, error) {
    try {
      this.#owners.get(id)?.deref()?.raised?.(error);
    } catch {
      // keeping the error threw (out of memory): nothing more can be done
    }
  }

  // ---- memory --------------------------------------------------------------------

  get env() { return this.#env; }

  // The record's index in words(), for a caller that writes many words.
  get record() { return this.#record; }

  // The views of linear memory, re-derived when growth detached them.
  bytes() {
    if (this.#bytes.byteLength === 0) this.#views();
    return this.#bytes;
  }

  words() {
    if (this.#words.byteLength === 0) this.#views();
    return this.#words;
  }

  #views() {
    const buffer = this.#memory.buffer;
    this.#bytes = new Uint8Array(buffer);
    this.#words = new Uint32Array(buffer);
  }

  // The record's words (web.h): written right before an export, read right
  // after; an import reads them at its entry and writes them at its exit.
  word(at) { return this.words()[this.#record + at]; }
  setWord(at, value) { this.words()[this.#record + at] = value; }
  word64(at) { return BigInt(this.word(at)) | (BigInt(this.word(at + 1)) << 32n); }
  setWord64(at, value) {
    const v = BigInt.asUintN(64, BigInt(value));
    this.setWord(at, Number(v & 0xffffffffn));
    this.setWord(at + 1, Number(v >> 32n));
  }

  // The double whose bits are the record's words `at` and `at + 1`.
  wordFloat(at) {
    BITS[0] = this.word(at);
    BITS[1] = this.word(at + 1);
    return DOUBLE[0];
  }

  setWordFloat(at, value) {
    DOUBLE[0] = value;
    this.setWord(at, BITS[0]);
    this.setWord(at + 1, BITS[1]);
  }

  // ---- calls with an arena: a mark at entry, a release on every path ----------------

  // Runs `fn` as one call of `scratch` (an arena of the environment's or a
  // host's): what it allocates there ends when it returns or throws.
  scoped(scratch, fn) {
    const level = this.call('ta_web_scratch_enter', scratch);
    if (level === 0) throw new TinyactorsError('calls nested 64 deep', { status: 'TA_ERROR_STATE' });
    try {
      return fn();
    } finally {
      this.call('ta_web_scratch_leave', scratch, level);
    }
  }

  get scratch() { return this.call('ta_web_env_scratch', this.#env); }

  // `length` bytes of room in `scratch`, above its current call's mark.
  room(scratch, length) {
    const at = this.call('ta_web_scratch_room', scratch, length) >>> 0; // a u32: past 2 GiB, an i32 reads negative
    if (at === 0) throw new TinyactorsError('no memory for the call', { status: 'TA_ERROR_NO_MEMORY' });
    return at;
  }

  // Text in: the string's UTF-8 in `scratch`, as [pointer, length]; a lone
  // surrogate is refused, never replaced (docs/values.md).
  text(scratch, string) {
    const n = string.length;
    if (n === 0) return [0, 0];
    let ascii = true;
    for (let i = 0; i < n; i++) {
      if (string.charCodeAt(i) > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      const at = this.room(scratch, n);
      const bytes = this.bytes();
      for (let i = 0; i < n; i++) bytes[at + i] = string.charCodeAt(i);
      return [at, n];
    }
    if (!string.isWellFormed()) throw new TinyactorsError('text with a lone surrogate', { status: 'TA_ERROR_INVALID' });
    const at = this.room(scratch, 3 * n);
    const { written } = encoder.encodeInto(string, this.bytes().subarray(at, at + 3 * n));
    return [at, written];
  }

  // Bytes in: a copy of `bytes` (a Uint8Array) in `scratch`.
  copyIn(scratch, bytes) {
    if (bytes.byteLength === 0) return [0, 0];
    const at = this.room(scratch, bytes.byteLength);
    this.bytes().set(bytes, at);
    return [at, bytes.byteLength];
  }

  // Text out: the UTF-8 at `pointer`, decoded.
  string(pointer, length) {
    if (length === 0) return '';
    const bytes = this.bytes();
    if (length <= 32) {
      let ascii = true;
      for (let i = 0; i < length; i++) {
        if (bytes[pointer + i] > 0x7f) {
          ascii = false;
          break;
        }
      }
      if (ascii) return String.fromCharCode.apply(null, bytes.subarray(pointer, pointer + length));
    }
    return decoder.decode(bytes.subarray(pointer, pointer + length));
  }

  // Bytes out: a copy the application owns.
  copyOut(pointer, length) { return this.bytes().slice(pointer, pointer + length); }

  // core's name of a status (ta_status_name).
  statusName(status) {
    const at = this.call('ta_web_status_name', status) >>> 0;
    const bytes = this.bytes();
    let end = at;
    while (bytes[end] !== 0) end++;
    return this.string(at, end - at);
  }

  refusal(status, message) {
    return new TinyactorsError(`${message} (${this.statusName(status)})`, { status: this.statusName(status) });
  }
}

export const STATUS = Object.freeze({ TA_OK, TA_ERROR_EXECUTION, TA_ERROR_INVALID, TA_ERROR_NO_MEMORY, TA_ERROR_STATE, TA_ERROR_ABORTED });
