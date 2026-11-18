// The value table (docs/values.md) against the suite's values.txt: its
// roundtrip and malformed cases through decode and encode, and its
// ecmascript expressions through encode. values.txt's encode and invalid
// cases are an ECMAScript datamodel's to_wire, whose rules for what JSON
// would drop or convert differ from encode's, which keeps undefined apart
// from null and refuses what is not a value (docs/values.md, "encode and a
// datamodel's to_wire"); those cases are listed in DIFFERS with what encode
// gives instead, and each must still be in values.txt.
import { Address, decode, encode, TinyactorsError } from '@tinyactors/node';
import { hex, toHex, values } from './vectors.mjs';
import { run, test } from './harness.mjs';

function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: ${actual}, expected ${expected}`);
}

function refused(body, what) {
  try {
    body();
  } catch (error) {
    if (!(error instanceof TinyactorsError)) throw new Error(`${what}: threw ${error}, not a TinyactorsError`);
    if (!/^TA_ERROR_/.test(error.status ?? '')) throw new Error(`${what}: status ${error.status}`);
    return error;
  }
  throw new Error(`${what}: not refused`);
}

// What encode gives where values.txt's case is to_wire's: the CBOR, or the
// status of its refusal. "not ECMAScript" roundtrips not listed here pass
// as they are: undefined stays undefined, a reference a reference.
const DIFFERS = {
  'ECMAScript: undefined at the top is null': { back: 'f7' },
  // encode and decode keep an actor reference: an Address, tag 32 again
  'ECMAScript: an actor reference is its address': {
    back: 'a166706c61796572d820781e74696e796163746f72733a2f2f7461622d3766332f235f7363786d6c5f34',
  },
  'undefined properties are dropped': { cbor: 'a26161f7616201' },
  'undefined in arrays is null': { cbor: '82f701' },
  'undefined at the top is null': { cbor: 'f7' },
  'ArrayBuffer as bytes': { status: 'TA_ERROR_UNSUPPORTED' },
  'a view\'s own bytes': { status: 'TA_ERROR_UNSUPPORTED' },
  'Date as its JSON form': { status: 'TA_ERROR_UNSUPPORTED' },
  'functions are dropped': { status: 'TA_ERROR_UNSUPPORTED' },
};

const cases = values();

function evaluate(expression) {
  return new Function(`return (${expression});`)();
}

test('every case DIFFERS names is in values.txt', () => {
  for (const name of Object.keys(DIFFERS)) {
    if (!cases.some((each) => each.name === name)) throw new Error(`no case ${name}`);
  }
});

test('roundtrip cases: decode, then encode', () => {
  let seen = 0;
  for (const { kind, name, cbor, back } of cases) {
    if (kind !== 'roundtrip') continue;
    const expected = DIFFERS[name]?.back ?? back ?? cbor;
    equal(toHex(encode(decode(hex(cbor)))), expected, name);
    seen++;
  }
  if (!seen) throw new Error('no roundtrip case');
});

test('encode cases: the ecmascript expression encoded', () => {
  let seen = 0;
  for (const { kind, name, cbor, ecmascript } of cases) {
    if (kind !== 'encode') continue;
    const differs = DIFFERS[name];
    const value = evaluate(ecmascript);
    if (differs?.status) equal(refused(() => encode(value), name).status, differs.status, name);
    else equal(toHex(encode(value)), differs?.cbor ?? cbor, name);
    seen++;
  }
  if (!seen) throw new Error('no encode case');
});

test('invalid cases: encode refuses them with TA_ERROR_INVALID', () => {
  let seen = 0;
  for (const { kind, name, ecmascript } of cases) {
    if (kind !== 'invalid') continue;
    equal(refused(() => encode(evaluate(ecmascript)), name).status, 'TA_ERROR_INVALID', name);
    seen++;
  }
  if (!seen) throw new Error('no invalid case');
});

test('malformed cases: decode refuses them', () => {
  let seen = 0;
  for (const { kind, name, cbor } of cases) {
    if (kind !== 'malformed') continue;
    refused(() => decode(hex(cbor)), name);
    seen++;
  }
  if (!seen) throw new Error('no malformed case');
});

test('integers: numbers to 2^53-1, bigints beyond, both ways', () => {
  const value = decode(hex('841b001fffffffffffff1b00200000000000003b001ffffffffffffe3b001fffffffffffff'));
  equal(typeof value[0], 'number', '2^53-1');
  equal(typeof value[1], 'bigint', '2^53');
  equal(typeof value[2], 'number', '-(2^53-1)');
  equal(typeof value[3], 'bigint', '-2^53');
  equal(toHex(encode([2 ** 53 - 1, 2n ** 53n, -5n, 0n])), '841b001fffffffffffff1b002000000000000024' + '00', 'encode');
  equal(toHex(encode(1.5)), 'f93e00', 'a fraction is a float');
});

test('undefined and null stay apart', () => {
  const value = decode(hex('83f7a16161f7f6'));
  equal(value[0], undefined, 'undefined');
  equal(Object.hasOwn(value[1], 'a') && value[1].a, undefined, 'a key holding undefined');
  equal(value[2], null, 'null');
  equal(toHex(encode([undefined, null])), '82f7f6', 'encode');
});

test('bytes: a Uint8Array, a Buffer too (where there is one); decode takes an ArrayBuffer', () => {
  const bytes = decode(hex('43010203'));
  equal(Object.getPrototypeOf(bytes), Uint8Array.prototype, 'a plain Uint8Array');
  equal(toHex(bytes), '010203', 'its bytes');
  if (typeof Buffer === 'function') equal(toHex(encode(Buffer.from([4, 5]))), '420405', 'a Buffer');
  equal(toHex(encode(new Uint8Array([9, 8, 7]).subarray(1))), '420807', 'a view: its own bytes');
  equal(decode(hex('1864').buffer), 100, 'an ArrayBuffer');
  refused(() => encode(new Uint16Array([1])), 'another typed array');
});

test('decode refuses what is not bytes with a TypeError', () => {
  for (const argument of ['f6', [0xf6], undefined, new Uint16Array([0xf6])]) {
    try {
      decode(argument);
    } catch (error) {
      if (error instanceof TypeError) continue;
      throw error;
    }
    throw new Error(`decode(${argument}) did not throw`);
  }
});

test('tag 32 is an Address both ways', () => {
  const read = decode(hex('d8206470656572'));
  equal(read instanceof Address, true, 'an Address');
  equal(read.text, 'peer', 'its text');
  equal(toHex(encode(read)), 'd8206470656572', 'encoded back as tag 32');
  const sender = new Address('tinyactors://shop/#_scxml_4');
  const message = decode(encode({ target: sender, list: [sender] }));
  equal(message.target instanceof Address && message.list[0] instanceof Address, true, 'nested');
  equal(String(message.target), 'tinyactors://shop/#_scxml_4', 'the text');
});

test('a key "__proto__" is an own key, and no prototype is set', () => {
  const value = decode(hex('a1695f5f70726f746f5f5fa16178' + '01'));
  equal(Object.getPrototypeOf(value), Object.prototype, 'the prototype');
  equal(Object.hasOwn(value, '__proto__'), true, 'an own key');
  equal(toHex(encode(value)), 'a1695f5f70726f746f5f5fa1617801', 'encoded back');
});

test('a repeated key keeps its last value', () => {
  equal(decode(hex('a2616101616102')).a, 2, 'the last');
});

test('plain objects only: a null prototype is one, a class instance is not', () => {
  const bare = Object.assign(Object.create(null), { k: 1 });
  equal(toHex(encode(bare)), 'a1616b01', 'a null prototype');
  refused(() => encode(new (class Point { x = 1; })()), 'a class instance');
  refused(() => encode(new Map()), 'a Map');
  refused(() => encode(Symbol('s')), 'a symbol');
});

test('text: U+FFFD itself is text, a pair is text, a lone surrogate is not', () => {
  equal(toHex(encode('�')), '63efbfbd', 'U+FFFD');
  equal(toHex(encode('😀')), '64f09f9880', 'a pair');
  equal(refused(() => encode('�\ud800'), 'after U+FFFD').status, 'TA_ERROR_INVALID', 'after U+FFFD');
  equal(refused(() => encode(['\udfff']), 'in an array').status, 'TA_ERROR_INVALID', 'a lone low surrogate');
});

test('nesting: 64 levels are a value, 65 are not', () => {
  let deep = 0;
  for (let i = 0; i < 64; i++) deep = [deep];
  equal(decode(encode(deep)).length, 1, '64');
  refused(() => encode([deep]), '65');
});

test('a getter that throws: its error, the arena released', () => {
  const thrown = new Error('from the getter');
  const value = { get k() { throw thrown; } };
  try {
    encode(value);
    throw new Error('not thrown');
  } catch (error) {
    if (error !== thrown) throw error;
  }
  equal(toHex(encode({ k: 'after' })), 'a1616b656166746572', 'the next encode');
});

test('marks nest: a getter that encodes leaves the outer value intact', () => {
  const inner = 'x'.repeat(100000);
  const value = { a: 'outer', get b() { return toHex(encode(inner)).length; }, c: 'end' };
  const decoded = decode(encode(value));
  equal(decoded.a, 'outer', 'before');
  equal(decoded.b, (inner.length + 5) * 2, 'the nested encode');
  equal(decoded.c, 'end', 'after');
});

test('TinyactorsError: an Error with code, reason, path and status', () => {
  const error = new TinyactorsError('m', { code: -32602, reason: 'type', path: 'params.x', status: 'TA_ERROR_INVALID' });
  equal(error instanceof Error, true, 'an Error');
  equal(error.name, 'TinyactorsError', 'its name');
  equal(error.message, 'm', 'message');
  equal(error.code, -32602, 'code');
  equal(error.reason, 'type', 'reason');
  equal(error.path, 'params.x', 'path');
  equal(error.status, 'TA_ERROR_INVALID', 'status');
  equal(new TinyactorsError('n').status, undefined, 'no status given');
  equal(typeof error.stack, 'string', 'a stack');
});

await run();
