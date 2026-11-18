// node:buffer in the page that runs conform.mjs (wasm/test/conform.mjs):
// the part of Buffer the adapter uses (alloc, concat, from, toString of
// hex and latin1, the big-endian u32 reads and writes), over Uint8Array.
export class Buffer extends Uint8Array {
  static alloc(size) { return new Buffer(size); }

  static from(value) {
    if (typeof value === 'string') return new Buffer(new TextEncoder().encode(value));
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    const made = new Buffer(bytes.length);
    made.set(bytes);
    return made;
  }

  static concat(list) {
    const made = new Buffer(list.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of list) {
      made.set(part, at);
      at += part.length;
    }
    return made;
  }

  readUInt32BE(at) { return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(at, false); }

  writeUInt32BE(value, at = 0) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(at, value, false);
    return at + 4;
  }

  toString(encoding = 'utf8') {
    if (encoding === 'hex') return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
    if (encoding === 'latin1') {
      let text = '';
      for (const b of this) text += String.fromCharCode(b);
      return text;
    }
    return new TextDecoder().decode(this);
  }
}
export default { Buffer };
