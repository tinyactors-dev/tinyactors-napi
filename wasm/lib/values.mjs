// encode and decode, as the addon defines them (src/values.c): the one
// conversion the API uses, streaming through core's writer and reader
// (cbor.mjs), the call's text and bytes in the environment's arena, a mark
// per call. encode writes an Address as tag 32 on its text, decode reads
// tag 32 as an Address.
import * as cbor from './cbor.mjs';
import { bytesOf } from './checks.mjs';
import { instance } from './state.mjs';

// encode(value) -> Uint8Array: the value's CBOR, copied once out of the
// call's arena.
export function encode(value) {
  const module = instance();
  const scratch = module.scratch;
  return module.scoped(scratch, () => {
    const [at, length] = cbor.write(module, scratch, value, { addresses: true });
    return module.copyOut(at, length);
  });
}

// decode(bytes) -> value: a Uint8Array or an ArrayBuffer, read during the
// call.
export function decode(bytes) {
  const view = bytesOf(bytes, 'decode takes a Uint8Array or an ArrayBuffer');
  const module = instance();
  const scratch = module.scratch;
  return module.scoped(scratch, () => {
    const [at, length] = module.copyIn(scratch, view);
    return cbor.read(module, scratch, at, length, { addresses: true });
  });
}
