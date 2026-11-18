// encodeHTTPPost and parseHTTPRequest, as the addon defines them
// (src/http.c): SCXML's BasicHTTP codec of core (tinyactors/basic_http.h,
// wasm/src/codecs.c), for a transport the application runs. Both are
// module calls with no host: their scratch is the environment's arena, a
// mark per call, and what they give back is copied once (a Uint8Array,
// strings).
import { bytesOf, optionalText, textOf } from './checks.mjs';
import { refusal } from './errors.mjs';
import { instance } from './state.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true });

// encodeHTTPPost({url, event, fields, body}) -> Uint8Array
export function encodeHTTPPost(post) {
  if (post === null || typeof post !== 'object') throw new TypeError('encodeHTTPPost takes {url, event, fields, body}');
  const { url, event, fields, body } = post;
  const module = instance();
  const scratch = module.scratch;
  return module.scoped(scratch, () => {
    const u = module.text(scratch, textOf(url, 'a post\'s url is a string'));
    const e = module.text(scratch, optionalText(event, 'a post\'s event is a string'));
    let pairs = 0, count = 0;
    if (fields !== undefined && fields !== null) {
      if (!Array.isArray(fields)) throw new TypeError('a post\'s fields are an array of {name, value}');
      count = fields.length;
      pairs = module.room(scratch, 16 * (count || 1));
      for (let i = 0; i < count; i++) {
        const field = fields[i];
        if (field === null || typeof field !== 'object') throw new TypeError('a post\'s fields are an array of {name, value}');
        const [n, nl] = module.text(scratch, textOf(field.name, 'a field\'s name is a string'));
        const [v, vl] = module.text(scratch, textOf(field.value, 'a field\'s value is a string'));
        module.words().set([n, nl, v, vl], (pairs >>> 2) + 4 * i);
      }
    }
    const b = module.text(scratch, optionalText(body, 'a post\'s body is a string'));
    module.words().set([u[0], u[1], e[0], e[1], pairs, count, b[0], b[1]], module.record);
    const status = module.call('ta_web_http_encode', module.env);
    if (status !== 0) {
      throw refusal(module.statusName(status), status === -3 ? 'a post\'s url is http://host[:port]/path' : 'no memory for the request');
    }
    return module.copyOut(module.word(0), module.word(1));
  });
}

// A string of a view core wrote, refused when it is not UTF-8 (a decoded
// field may hold any byte): never replaced.
function strict(module, pointer, length) {
  try {
    return utf8.decode(module.bytes().subarray(pointer, pointer + length));
  } catch {
    throw refusal('TA_ERROR_INVALID', 'the request holds text that is not UTF-8');
  }
}

// parseHTTPRequest(message) -> {method, target, body, event, fields}
export function parseHTTPRequest(message) {
  const bytes = bytesOf(message, 'parseHTTPRequest takes the message\'s bytes: a Uint8Array or an ArrayBuffer');
  const module = instance();
  const scratch = module.scratch;
  return module.scoped(scratch, () => {
    const [at, length] = module.copyIn(scratch, bytes);
    module.setWord(0, at);
    module.setWord(1, length);
    const status = module.call('ta_web_http_parse', module.env);
    if (status !== 0) throw refusal(module.statusName(status), 'the message is not an HTTP request');
    const words = module.words().slice(module.record, module.record + 10);
    const result = {
      method: strict(module, words[0], words[1]),
      target: strict(module, words[2], words[3]),
      body: strict(module, words[4], words[5]),
      event: strict(module, words[6], words[7]),
    };
    const fields = [];
    const base = words[9] >>> 2;
    for (let i = 0; i < words[8]; i++) {
      const w = module.words();
      fields.push(Object.freeze({
        name: strict(module, w[base + 4 * i], w[base + 4 * i + 1]),
        value: strict(module, w[base + 4 * i + 2], w[base + 4 * i + 3]),
      }));
    }
    result.fields = Object.freeze(fields);
    return Object.freeze(result);
  });
}
