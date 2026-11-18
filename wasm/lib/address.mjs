// Address, as the addon defines it (src/address.c): an actor's address,
// immutable. It holds its text, an own read-only property `text`; its parts
// are read by core's parser on each access (ta_address_parse,
// ta_address_name_decode, wasm/src/codecs.c), undefined for a part the
// text lacks, so no binding parses the grammar. Address.fromSession and
// Address.fromName make one with core's formatter. The calls' scratch is
// the environment's arena, a mark per call. A private brand stands for the
// addon's type tag: a getter on another object is refused.
import { refusal } from './errors.mjs';
import { instance } from './state.mjs';
import { sessionOf } from './checks.mjs';

const KIND_SESSION = 1, KIND_NAME = 2;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class Address {
  #brand = true;

  constructor(text) {
    if (new.target === undefined) throw new TypeError('Address is a class: new Address(text)');
    if (typeof text !== 'string') throw new TypeError('an Address is made of its text, a string');
    Object.defineProperty(this, 'text', { value: text, enumerable: true });
    Object.freeze(this);
  }

  static #is(value) {
    return value !== null && typeof value === 'object' && #brand in value;
  }

  static is(value) { return Address.#is(value); }

  // The parts of `self`'s text: a function of the module, or undefined
  // when it is no address; `part` reads them in the environment's arena.
  static #parts(self, part) {
    if (!Address.#is(self)) throw new TypeError('not an Address');
    const module = instance();
    const scratch = module.scratch;
    return module.scoped(scratch, () => {
      const [at, length] = module.text(scratch, self.text);
      module.setWord(0, at);
      module.setWord(1, length);
      if (module.call('ta_web_address_parse', module.env) !== 0) return undefined;
      return part(module);
    });
  }

  get system() {
    return Address.#parts(this, (module) => module.string(module.word(1), module.word(2)));
  }

  get session() {
    return Address.#parts(this, (module) => (module.word(0) === KIND_SESSION ? module.word64(3) : undefined));
  }

  get name() {
    return Address.#parts(this, (module) => {
      if (module.word(0) !== KIND_NAME) return undefined;
      module.setWord(0, module.word(5));
      module.setWord(1, module.word(6));
      const status = module.call('ta_web_address_name', module.env);
      if (status !== 0) throw refusal(module.statusName(status), 'the address\'s name does not decode');
      try {
        return utf8.decode(module.bytes().subarray(module.word(0), module.word(0) + module.word(1)));
      } catch {
        throw refusal('TA_ERROR_INVALID', 'the address\'s name is not UTF-8');
      }
    });
  }

  toString() {
    if (!Address.#is(this)) throw new TypeError('not an Address');
    return this.text;
  }

  static fromSession(system, session) {
    if (arguments.length < 2) throw new TypeError('Address.fromSession(system, session)');
    if (typeof system !== 'string') throw new TypeError('a system id is a string');
    const id = sessionOf(session);
    return Address.#format(KIND_SESSION, system, (module) => module.setWord64(2, id));
  }

  static fromName(system, name) {
    if (arguments.length < 2) throw new TypeError('Address.fromName(system, name)');
    if (typeof system !== 'string') throw new TypeError('a system id is a string');
    if (typeof name !== 'string') throw new TypeError('an actor\'s name is a string');
    return Address.#format(KIND_NAME, system, (module, scratch) => {
      const [at, length] = module.text(scratch, name);
      module.setWord(2, at);
      module.setWord(3, length);
    });
  }

  static #format(kind, system, fill) {
    const module = instance();
    const scratch = module.scratch;
    return module.scoped(scratch, () => {
      const [at, length] = module.text(scratch, system);
      fill(module, scratch);
      module.setWord(0, at);
      module.setWord(1, length);
      const status = module.call('ta_web_address_format', module.env, kind);
      if (status !== 0) throw refusal(module.statusName(status), 'core refused the address\'s parts');
      return new Address(module.string(module.word(0), module.word(1)));
    });
  }
}

// Whether `value` is an Address: the layer's, not the API's.
export const isAddress = Address.is;
delete Address.is;
// An Address's text, or `value` itself.
export const addressText = (value) => (isAddress(value) ? value.text : value);
