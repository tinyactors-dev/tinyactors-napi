// The world around the gateway: the upstream service it fronts and an
// OpenTelemetry collector. Both are real HTTP servers on port 0, in this
// process, so the example needs no network. The upstream asks a `respond`
// function how each request ends (an answer, a delay, a dropped
// connection, never), which is how main.mjs gives it latency and failures
// and how the test drives it one request at a time.
import { createServer } from 'node:http';

/** Starts `server` on a free port of 127.0.0.1; answers its base URL. */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The service behind the gateway: a small inventory API. */
export class Upstream {
  /**
   * @param {{ respond?: (call: object) => any }} [options] `respond(call)`
   *   says how a request ends, now or as a promise: `{ status, body }`, or
   *   `'drop'` to destroy the connection. The default answers 200 with
   *   what the request asked for.
   */
  constructor({ respond = (call) => ({ status: 200, body: { path: call.path, client: call.client } }) } = {}) {
    this.respond = respond;
    /** every request that reached the upstream: method, path, headers, body */
    this.calls = [];
    this.server = createServer(async (req, res) => {
      const call = {
        method: req.method,
        path: req.url,
        client: req.headers['x-client'],
        traceparent: req.headers.traceparent,
        body: (await readAll(req)).toString('utf8'),
      };
      this.calls.push(call);
      const answer = await this.respond(call);
      if (answer === 'drop') {
        req.socket.destroy();
        return;
      }
      if (res.destroyed) return;
      // a connection per request: Bun's fetch sends a request again by
      // itself when a kept-alive connection drops, which would hide the
      // dropped connections from the gateway
      res.writeHead(answer.status, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify(answer.body));
    });
  }

  listen() { return listen(this.server); }

  close() {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

/** A stand-in for an OpenTelemetry collector: keeps every OTLP request it
 * gets at /v1/traces, /v1/logs and /v1/metrics. */
export class Collector {
  constructor() {
    /** { signal, contentType, body: Buffer } */
    this.requests = [];
    this.server = createServer(async (req, res) => {
      const body = await readAll(req);
      const signal = /^\/v1\/(traces|logs|metrics)$/.exec(req.url)?.[1];
      if (req.method !== 'POST' || signal === undefined) {
        res.writeHead(404).end();
        return;
      }
      this.requests.push({ signal, contentType: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
  }

  listen() { return listen(this.server); }

  /** The bodies of one signal's requests. */
  bodies(signal) {
    return this.requests.filter((r) => r.signal === signal).map((r) => r.body);
  }

  close() {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(resolve));
  }
}
