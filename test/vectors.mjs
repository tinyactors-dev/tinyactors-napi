// The cases of the suite's values.txt (tinyactors-test/suites/protocol),
// read for the binding's own tests of its value table.
import { readText } from './runtime.mjs';

const TEXT = await readText(new URL('../../tinyactors-test/suites/protocol/values.txt', import.meta.url));

export function hex(text) {
  return Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Each case: { kind, name, cbor, back, ecmascript }.
export function values() {
  const cases = [];
  let current = null;
  for (const line of TEXT.split('\n')) {
    if (line.startsWith('#')) continue;
    if (!line.trim()) {
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (!current) {
      current = { kind: key, name: value };
      cases.push(current);
    } else if (key === 'cbor' || key === 'back' || key === 'ecmascript') {
      current[key] ??= value;
    }
  }
  return cases;
}
