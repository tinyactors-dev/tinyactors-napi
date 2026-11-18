// BasicHTTP's codec (docs/api-map.md): encodeHTTPPost and parseHTTPRequest
// are core's ta_http_encode_post and ta_http_parse_request, for a transport
// the application runs; the addon writes no HTTP of its own.
import { encodeHTTPPost, parseHTTPRequest } from '@tinyactors/node';
import { equal, status, throws, typeError } from './charts.mjs';
import { run, test } from './harness.mjs';

const invalid = status('TA_ERROR_INVALID');
const text = (bytes) => new TextDecoder().decode(bytes);

test('a post with fields: the event first, every name and value percent-encoded', () => {
  const message = encodeHTTPPost({
    url: 'http://localhost:8080/scxml',
    event: 'foo.bar',
    fields: [{ name: 'a b', value: 'ü&=' }, { name: 'n', value: '' }],
  });
  equal(message instanceof Uint8Array, true, 'bytes');
  const body = '_scxmleventname=foo.bar&a%20b=%C3%BC%26%3D&n=';
  equal(
    text(message),
    'POST /scxml HTTP/1.1\r\nHost: localhost:8080\r\nContent-Type: application/x-www-form-urlencoded\r\n' +
      `Content-Length: ${body.length}\r\n\r\n${body}`,
    'the request',
  );
});

test('a post read back: its event, fields and body', () => {
  const request = parseHTTPRequest(
    encodeHTTPPost({ url: 'http://h/p', event: 'e', fields: [{ name: 'k', value: 'v w' }] }),
  );
  equal(request.method, 'POST', 'method');
  equal(request.target, '/p', 'target');
  equal(request.event, 'e', 'event: _scxmleventname');
  equal(JSON.stringify(request.fields), '[{"name":"k","value":"v w"}]', 'fields but _scxmleventname, decoded');
  equal(request.body, '_scxmleventname=e&k=v%20w', 'body as sent');
  equal(Object.isFrozen(request) && Object.isFrozen(request.fields), true, 'frozen');
});

test('a body without fields; HTTP.<METHOD> without an event; a request larger than the first room', () => {
  const long = 'x'.repeat(5000);
  const request = parseHTTPRequest(encodeHTTPPost({ url: 'http://h', body: long }));
  equal(request.event, 'HTTP.POST', 'no _scxmleventname');
  equal(request.target, '/', 'a URL without a path posts to /');
  equal(request.body, long, 'the body, not fields');
  equal(request.fields.length, 0, 'no fields');
  const get = parseHTTPRequest(new TextEncoder().encode('GET /x HTTP/1.1\r\n\r\n'));
  equal(get.event, 'HTTP.GET', 'the method names the event');
  equal(parseHTTPRequest(new TextEncoder().encode('GET /x HTTP/1.1\r\n\r\n').buffer).target, '/x', 'an ArrayBuffer');
});

test('refusals', () => {
  throws(() => encodeHTTPPost({ url: 'https://h/' }), invalid, 'a URL that is not http://');
  throws(() => encodeHTTPPost({ url: 'http:///p' }), invalid, 'a URL without a host');
  throws(() => encodeHTTPPost({}), typeError, 'no url');
  throws(() => encodeHTTPPost({ url: 'http://h/', fields: [{ name: 1, value: 'v' }] }), typeError, 'a name that is not text');
  throws(() => encodeHTTPPost({ url: 'http://h/', fields: 'a=b' }), typeError, 'fields that are not an array');
  throws(() => encodeHTTPPost({ url: 'http://h/', event: '\ud800' }), invalid, 'a lone surrogate');
  throws(() => parseHTTPRequest(new TextEncoder().encode('POST')), invalid, 'no target');
  throws(() => parseHTTPRequest(new TextEncoder().encode('POST / HTTP/1.1\r\n')), invalid, 'no end of the headers');
  throws(() => parseHTTPRequest(new TextEncoder().encode('POST / HTTP/1.1\r\n\r\na=%FF')), invalid,
    'a field that is not UTF-8 is refused, never replaced');
  throws(() => parseHTTPRequest('POST / HTTP/1.1\r\n\r\n'), typeError, 'text, not bytes');
});

await run();
