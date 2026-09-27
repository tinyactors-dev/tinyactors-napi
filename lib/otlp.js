'use strict';

// decodeTraces(bytes): OTLP protobuf (an ExportTraceServiceRequest, or the
// TracesData of the same shape) to span-shaped objects (napi ADR 0016). A
// small reader with no dependency, for those who want objects: in-process
// span processors, exporters that don't speak OTLP, verifiers. It is strict:
// a malformed message throws. It reads any OTLP trace request, not only the
// ones tinyactors writes.

const { TinyactorsError } = require('./errors');

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));
const decoder = new TextDecoder('utf-8', { fatal: true });

function malformed(what) {
  return new TinyactorsError(`decodeTraces(): malformed OTLP: ${what}`, 'invalid');
}

// A cursor over one message's bytes.
class Reader {
  constructor(bytes, start, end) {
    this.bytes = bytes;
    this.at = start;
    this.end = end;
  }

  get done() {
    return this.at >= this.end;
  }

  // A varint as a number when it is safe, else a bigint.
  varint() {
    let value = 0;
    let scale = 1;
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.at >= this.end) throw malformed('a varint runs past its message');
      const byte = this.bytes[this.at++];
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if ((byte & 0x80) === 0) {
        return Number.isSafeInteger(value) ? value : this.#bigVarint(shift);
      }
    }
    throw malformed('a varint is longer than ten bytes');
  }

  // Re-reads the varint that just ended as a bigint.
  #bigVarint(lastShift) {
    let at = this.at - lastShift / 7 - 1;
    let value = 0n;
    for (let shift = 0n; at < this.at; shift += 7n, at += 1) {
      value |= BigInt(this.bytes[at] & 0x7f) << shift;
    }
    return BigInt.asUintN(64, value);
  }

  fixed64() {
    if (this.end - this.at < 8) throw malformed('a fixed64 runs past its message');
    let value = 0n;
    for (let at = 7; at >= 0; at -= 1) value = (value << 8n) | BigInt(this.bytes[this.at + at]);
    this.at += 8;
    return value;
  }

  // The next field: [number, wire type].
  tag() {
    const tag = this.varint();
    const field = Number(tag) >>> 3;
    if (field === 0) throw malformed('a field number is 0');
    return [field, Number(tag) & 7];
  }

  // A length-delimited body, as a reader.
  body() {
    const length = this.varint();
    if (typeof length !== 'number' || length > this.end - this.at) throw malformed('a length runs past its message');
    const reader = new Reader(this.bytes, this.at, this.at + length);
    this.at += length;
    return reader;
  }

  skip(wire) {
    switch (wire) {
      case 0: this.varint(); return;
      case 1: this.fixed64(); return;
      case 2: this.body(); return;
      case 5:
        if (this.end - this.at < 4) throw malformed('a fixed32 runs past its message');
        this.at += 4;
        return;
      default: throw malformed(`wire type ${wire}`);
    }
  }

  string() {
    const body = this.body();
    return decoder.decode(this.bytes.subarray(body.at, body.end));
  }

  hex() {
    const body = this.body();
    let text = '';
    for (let at = body.at; at < body.end; at += 1) text += HEX[this.bytes[at]];
    return text;
  }
}

function expect(wire, wanted, what) {
  if (wire !== wanted) throw malformed(`${what} has wire type ${wire}`);
}

// AnyValue → a JavaScript value: string, boolean, number (or bigint when
// it is not safe), array, or an object for a kvlist.
function anyValue(reader) {
  let value;
  while (!reader.done) {
    const [field, wire] = reader.tag();
    switch (field) {
      case 1: expect(wire, 2, 'string_value'); value = reader.string(); break;
      case 2: expect(wire, 0, 'bool_value'); value = reader.varint() !== 0; break;
      case 3: {
        expect(wire, 0, 'int_value');
        const raw = reader.varint();
        value = typeof raw === 'bigint' ? BigInt.asIntN(64, raw) : raw;
        break;
      }
      case 4: {
        expect(wire, 1, 'double_value');
        const bits = reader.fixed64();
        const view = new DataView(new ArrayBuffer(8));
        view.setBigUint64(0, bits);
        value = view.getFloat64(0);
        break;
      }
      case 5: {
        expect(wire, 2, 'array_value');
        const array = reader.body();
        value = [];
        while (!array.done) {
          const [item, itemWire] = array.tag();
          if (item === 1) {
            expect(itemWire, 2, 'ArrayValue.values');
            value.push(anyValue(array.body()));
          } else {
            array.skip(itemWire);
          }
        }
        break;
      }
      case 6: expect(wire, 2, 'kvlist_value'); value = attributes(reader.body(), 1); break;
      case 7: expect(wire, 2, 'bytes_value'); value = reader.hex(); break;
      default: reader.skip(wire);
    }
  }
  return value;
}

// Repeated KeyValue at `field` of a message → { key: value }.
function keyValue(reader, into) {
  let key;
  let value;
  while (!reader.done) {
    const [field, wire] = reader.tag();
    if (field === 1) {
      expect(wire, 2, 'KeyValue.key');
      key = reader.string();
    } else if (field === 2) {
      expect(wire, 2, 'KeyValue.value');
      value = anyValue(reader.body());
    } else {
      reader.skip(wire);
    }
  }
  if (key !== undefined) into[key] = value;
}

function attributes(reader, field) {
  const out = {};
  while (!reader.done) {
    const [number, wire] = reader.tag();
    if (number === field) {
      expect(wire, 2, 'attributes');
      keyValue(reader.body(), out);
    } else {
      reader.skip(wire);
    }
  }
  return out;
}

const nanosToMillis = (nanos) => Number(nanos / 1000n) / 1000;

const STATUS = ['unset', 'ok', 'error'];
const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

function span(reader, resource, scope) {
  const out = {
    traceID: '', spanID: '', parentSpanID: undefined, name: '', kind: 'unspecified',
    startTimeUnixNano: 0n, endTimeUnixNano: 0n, startTime: 0, endTime: 0,
    attributes: {}, events: [], links: [], status: { code: 'unset' }, resource, scope,
  };
  while (!reader.done) {
    const [field, wire] = reader.tag();
    switch (field) {
      case 1: expect(wire, 2, 'trace_id'); out.traceID = reader.hex(); break;
      case 2: expect(wire, 2, 'span_id'); out.spanID = reader.hex(); break;
      case 4: {
        expect(wire, 2, 'parent_span_id');
        const parent = reader.hex();
        if (parent !== '') out.parentSpanID = parent;
        break;
      }
      case 5: expect(wire, 2, 'name'); out.name = reader.string(); break;
      case 6: expect(wire, 0, 'kind'); out.kind = KINDS[reader.varint()] ?? 'unspecified'; break;
      case 7: expect(wire, 1, 'start_time_unix_nano'); out.startTimeUnixNano = reader.fixed64(); break;
      case 8: expect(wire, 1, 'end_time_unix_nano'); out.endTimeUnixNano = reader.fixed64(); break;
      case 9: expect(wire, 2, 'attributes'); keyValue(reader.body(), out.attributes); break;
      case 11: {
        expect(wire, 2, 'events');
        const event = reader.body();
        const item = { name: '', timeUnixNano: 0n, time: 0, attributes: {} };
        while (!event.done) {
          const [number, eventWire] = event.tag();
          if (number === 1) { expect(eventWire, 1, 'Event.time_unix_nano'); item.timeUnixNano = event.fixed64(); }
          else if (number === 2) { expect(eventWire, 2, 'Event.name'); item.name = event.string(); }
          else if (number === 3) { expect(eventWire, 2, 'Event.attributes'); keyValue(event.body(), item.attributes); }
          else event.skip(eventWire);
        }
        item.time = nanosToMillis(item.timeUnixNano);
        out.events.push(item);
        break;
      }
      case 13: {
        expect(wire, 2, 'links');
        const link = reader.body();
        const item = { traceID: '', spanID: '', attributes: {} };
        while (!link.done) {
          const [number, linkWire] = link.tag();
          if (number === 1) { expect(linkWire, 2, 'Link.trace_id'); item.traceID = link.hex(); }
          else if (number === 2) { expect(linkWire, 2, 'Link.span_id'); item.spanID = link.hex(); }
          else if (number === 4) { expect(linkWire, 2, 'Link.attributes'); keyValue(link.body(), item.attributes); }
          else link.skip(linkWire);
        }
        out.links.push(item);
        break;
      }
      case 15: {
        expect(wire, 2, 'status');
        const status = reader.body();
        while (!status.done) {
          const [number, statusWire] = status.tag();
          if (number === 3) { expect(statusWire, 0, 'Status.code'); out.status.code = STATUS[status.varint()] ?? 'unset'; }
          else if (number === 2) { expect(statusWire, 2, 'Status.message'); out.status.message = status.string(); }
          else status.skip(statusWire);
        }
        break;
      }
      default: reader.skip(wire);
    }
  }
  if (out.traceID.length !== 32) throw malformed('a span has no 16-byte trace_id');
  if (out.spanID.length !== 16) throw malformed('a span has no 8-byte span_id');
  out.startTime = nanosToMillis(out.startTimeUnixNano);
  out.endTime = nanosToMillis(out.endTimeUnixNano);
  return out;
}

/**
 * Decodes OTLP trace bytes (the Uint8Array a trace sink receives) into
 * spans: { traceID, spanID, parentSpanID?, name, kind, startTime, endTime
 * (milliseconds since the epoch), startTimeUnixNano, endTimeUnixNano
 * (bigints), attributes, events: [{ name, time, timeUnixNano, attributes }],
 * links: [{ traceID, spanID, attributes }], status: { code, message? },
 * resource: { attributes }, scope: { name, version } }. IDs are lowercase
 * hex. Spans sharing a resource or scope share that object.
 */
function decodeTraces(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TinyactorsError('decodeTraces(): expected a Uint8Array', 'invalid');
  }
  const request = new Reader(bytes, 0, bytes.length);
  const spans = [];
  while (!request.done) {
    const [field, wire] = request.tag();
    if (field !== 1) {
      request.skip(wire);
      continue;
    }
    expect(wire, 2, 'resource_spans');
    const resourceSpans = request.body();
    const resource = { attributes: {} };
    const scopes = [];
    while (!resourceSpans.done) {
      const [number, rsWire] = resourceSpans.tag();
      if (number === 1) {
        expect(rsWire, 2, 'resource');
        resource.attributes = attributes(resourceSpans.body(), 1);
      } else if (number === 2) {
        expect(rsWire, 2, 'scope_spans');
        scopes.push(resourceSpans.body());
      } else {
        resourceSpans.skip(rsWire);
      }
    }
    for (const scopeSpans of scopes) {
      const scope = { name: '', version: '' };
      const bodies = [];
      while (!scopeSpans.done) {
        const [number, ssWire] = scopeSpans.tag();
        if (number === 1) {
          expect(ssWire, 2, 'scope');
          const reader = scopeSpans.body();
          while (!reader.done) {
            const [item, itemWire] = reader.tag();
            if (item === 1) { expect(itemWire, 2, 'scope.name'); scope.name = reader.string(); }
            else if (item === 2) { expect(itemWire, 2, 'scope.version'); scope.version = reader.string(); }
            else reader.skip(itemWire);
          }
        } else if (number === 2) {
          expect(ssWire, 2, 'spans');
          bodies.push(scopeSpans.body());
        } else {
          scopeSpans.skip(ssWire);
        }
      }
      for (const body of bodies) spans.push(span(body, resource, scope));
    }
  }
  return spans;
}

module.exports = { decodeTraces };
