'use strict';

// The base protocol of the Debug Adapter Protocol: each message is a JSON
// object after a `Content-Length` header and a blank line. A DebugSession
// takes and gives message objects, so a transport that frames messages
// itself (a WebSocket) needs none of this; one that carries bytes (stdio, a
// TCP socket) reads with DAPReader and writes with encodeDAPMessage. Host
// neutral: Uint8Array, TextEncoder and TextDecoder only.

const { TinyactorsError } = require('../errors');

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CR = 13;
const LF = 10;

/** One message as the bytes a byte stream carries: the header, then its JSON. */
function encodeDAPMessage(message) {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

// Limits that keep a malformed stream from buffering without end: the
// headers of one message, and one body.
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const TYPES = new Set(['request', 'response', 'event']);

/**
 * Turns a byte stream into messages: push() each chunk as it arrives, and
 * `onMessage` gets every whole message in order. Chunks may split a
 * header, a body or a UTF-8 sequence anywhere; a string chunk may split a
 * surrogate pair.
 *
 * A malformed stream throws `invalid` from push(), and the reader is
 * broken from then on: every later push() throws `invalid` too, since the
 * stream cannot be resynchronized once a length is in doubt. Malformed is:
 * headers that are not UTF-8, longer than 8 KiB without the blank line, or
 * with a line that is not `Name: value`; no Content-Length, a second one, or
 * one that is not a decimal number of at most 64 MiB; a body that is not
 * UTF-8 JSON, or not an object with an integer `seq` and a `type` of
 * "request", "response" or "event". Other header fields are ignored. An
 * exception from `onMessage` is not the stream's fault: it propagates from
 * push(), the reader stays usable, and messages already buffered behind it
 * are delivered by the next push().
 */
class DAPReader {
  #onMessage;
  #buffer = new Uint8Array(0);
  #pendingSurrogate = '';
  #broken = null;

  constructor(onMessage) {
    if (typeof onMessage !== 'function') {
      throw new TinyactorsError('DAPReader: expected a function for each message', 'invalid');
    }
    this.#onMessage = onMessage;
  }

  push(chunk) {
    if (this.#broken !== null) {
      throw new TinyactorsError(`DAP: the stream was malformed earlier (${this.#broken})`, 'invalid');
    }
    this.#append(chunk instanceof Uint8Array ? chunk : this.#encode(String(chunk)));
    for (;;) {
      const message = this.#next();
      if (message === undefined) {
        return;
      }
      this.#onMessage(message);
    }
  }

  // A string chunk as UTF-8, holding back a trailing high surrogate until
  // the chunk with its low half arrives.
  #encode(text) {
    let joined = this.#pendingSurrogate + text;
    this.#pendingSurrogate = '';
    const last = joined.charCodeAt(joined.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.#pendingSurrogate = joined.slice(-1);
      joined = joined.slice(0, -1);
    }
    return encoder.encode(joined);
  }

  #append(bytes) {
    const joined = new Uint8Array(this.#buffer.length + bytes.length);
    joined.set(this.#buffer, 0);
    joined.set(bytes, this.#buffer.length);
    this.#buffer = joined;
  }

  // The next whole message, taken off the buffer, or undefined while it is
  // still arriving.
  #next() {
    const end = headerEnd(this.#buffer);
    if (end < 0) {
      if (this.#buffer.length > MAX_HEADER_BYTES) {
        this.#fail(`no blank line within ${MAX_HEADER_BYTES} bytes of headers`);
      }
      return undefined;
    }
    if (end > MAX_HEADER_BYTES) {
      this.#fail(`headers longer than ${MAX_HEADER_BYTES} bytes`);
    }
    const length = this.#contentLength(this.#text(this.#buffer.subarray(0, end), 'the headers of a message are not UTF-8'));
    const start = end + 4;
    if (this.#buffer.length < start + length) {
      return undefined;
    }
    const body = this.#buffer.subarray(start, start + length);
    let message;
    try {
      message = JSON.parse(this.#text(body, 'a body is not UTF-8'));
    } catch (error) {
      if (error instanceof TinyactorsError) throw error;
      this.#fail(`a body is not JSON: ${error.message}`);
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.#fail('a body is not a JSON object');
    }
    if (!Number.isInteger(message.seq)) {
      this.#fail('a message has no integer seq');
    }
    if (!TYPES.has(message.type)) {
      this.#fail(`a message's type is ${JSON.stringify(message.type)}, not "request", "response" or "event"`);
    }
    this.#buffer = this.#buffer.slice(start + length);
    return message;
  }

  #text(bytes, refusal) {
    try {
      return decoder.decode(bytes);
    } catch {
      return this.#fail(refusal);
    }
  }

  #contentLength(headers) {
    let length;
    for (const line of headers.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) {
        this.#fail(`a header line is not "Name: value": ${JSON.stringify(line.slice(0, 80))}`);
      }
      if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') {
        continue;
      }
      if (length !== undefined) {
        this.#fail('a message has two Content-Length headers');
      }
      const value = line.slice(colon + 1).trim();
      length = /^[0-9]{1,9}$/.test(value) ? Number(value) : NaN;
      if (!(length <= MAX_BODY_BYTES)) {
        this.#fail(`Content-Length ${JSON.stringify(value.slice(0, 20))} is not a decimal number of at most ${MAX_BODY_BYTES}`);
      }
    }
    if (length === undefined) {
      this.#fail('a message has no Content-Length header');
    }
    return length;
  }

  #fail(reason) {
    this.#broken = reason;
    throw new TinyactorsError(`DAP: ${reason}`, 'invalid');
  }
}

// The index of the blank line after the headers, or -1.
function headerEnd(bytes) {
  for (let at = 0; at + 3 < bytes.length; at += 1) {
    if (bytes[at] === CR && bytes[at + 1] === LF && bytes[at + 2] === CR && bytes[at + 3] === LF) {
      return at;
    }
  }
  return -1;
}

module.exports = { DAPReader, encodeDAPMessage };
