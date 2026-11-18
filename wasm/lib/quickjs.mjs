// A host's quickjs datamodel (datamodel: "quickjs"): core's ECMAScript
// datamodel on quickjs-ng, inside the same module (wasm/src/quickjs.c), as
// the addon holds it (src/host.c, src/effects.c). Its values cross as CBOR
// only: a value the application gives is written into the host's arena
// and made a payload by quickjs (an Address as tag 32 on its text); a
// payload the application reads is quickjs's CBOR, a view of its memory
// until its next call, read at once (tag 32 as its text).
import * as cbor from './cbor.mjs';
import { TinyactorsError } from './errors.mjs';

const TA_OK = 0, TA_ERROR_UNSUPPORTED = -7;

export class QuickJSDatamodel {
  constructor(state) {
    this.state = state;
  }

  get module() { return this.state.module; }

  // A payload of `value`, one reference (core's once an input takes it).
  payload(value) {
    const state = this.state, module = this.module;
    const [at, length] = cbor.write(module, state.scratch, value, { addresses: true });
    module.setWord(0, at);
    module.setWord(1, length);
    const status = module.call('ta_web_quickjs_payload', state.pointer);
    if (status !== TA_OK) {
      throw new TinyactorsError('the value could not be made a payload', { status: module.statusName(status) });
    }
    return module.word64(0);
  }

  // A payload's value, made from its CBOR in the application's realm.
  exported(payload) {
    const state = this.state, module = this.module;
    const status = module.call('ta_web_quickjs_cbor', state.pointer, Number(payload & 0xFFFFFFFFn), Number(payload >> 32n));
    if (status !== TA_OK) throw new TinyactorsError('the send\'s data could not be read', { status: module.statusName(status) });
    const at = module.word(0), length = module.word(1);
    return module.scoped(state.scratch, () => cbor.read(module, state.scratch, at, length));
  }

  // quickjs's state, as bytes (a copy: the room is the datamodel's next
  // output's); a refusal names what could not be stored.
  snapshot() {
    const state = this.state, module = this.module;
    const status = module.call('ta_web_quickjs_state', state.pointer);
    if (status !== TA_OK) {
      const reason = status === TA_ERROR_UNSUPPORTED ? this.reason() : '';
      throw new TinyactorsError(reason || 'the quickjs datamodel\'s state could not be written', { status: module.statusName(status) });
    }
    return module.copyOut(module.word(0), module.word(1));
  }

  // quickjs's state back, before anything runs.
  restore(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TinyactorsError('not a snapshot of a Host', { status: 'TA_ERROR_INVALID' });
    const state = this.state, module = this.module;
    const status = module.scoped(state.scratch, () => {
      const [at, length] = module.copyIn(state.scratch, bytes);
      module.setWord(0, at);
      module.setWord(1, length);
      return module.call('ta_web_quickjs_restore', state.pointer);
    });
    if (status !== TA_OK) throw new TinyactorsError('the quickjs datamodel\'s state does not restore', { status: module.statusName(status) });
  }

  // Why the last hibernation, export or snapshot was refused ("" when it
  // was not).
  reason() {
    const module = this.module;
    const at = module.call('ta_web_quickjs_reason', this.state.pointer) >>> 0;
    return module.string(at, module.word(0));
  }

  heapBytes() { return this.module.call('ta_web_quickjs_heap_bytes', this.state.pointer); }

  free() {}
}
