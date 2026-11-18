// The application: an HTTP API gateway whose client sessions are actors of
// charts/session.scxml. The chart decides what becomes of each request (the
// rate limit, the concurrency limit, the upstream's timeout, a retry, the
// session's expiry); this file does the I/O it asks for: the HTTP server,
// the request to the upstream, the HTTP response, and the export of traces
// and logs to an OTLP collector.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Host, TinyactorsError } from '@tinyactors/node';

const SESSION_CHART = readFileSync(new URL('./charts/session.scxml', import.meta.url), 'utf8');

/** The plans an API key may be on: the policy is the application's, the
 * chart enforces it. */
export const PLANS = {
  free: { burst: 3, refillMs: 1000, maxInFlight: 1, upstreamTimeoutMs: 2000, idleMs: 30_000 },
  pro: { burst: 10, refillMs: 200, maxInFlight: 4, upstreamTimeoutMs: 2000, idleMs: 30_000 },
};

const MAX_BODY = 64 * 1024;

export class Gateway {
  /**
   * @param {object} options
   * @param {string} options.upstream the upstream's base URL
   * @param {string} [options.collector] the OTLP collector's base URL;
   *   without one, nothing is exported
   * @param {{ [apiKey: string]: { client: string, plan: string } }} options.keys
   * @param {{ [plan: string]: object }} [options.plans] the limits of each plan
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {number} [options.traceSeed] seeds the trace ids the gateway starts (random without one)
   */
  constructor({ upstream, collector, keys, plans = PLANS, clock, datamodel, traceSeed }) {
    this.upstream = upstream.replace(/\/$/, '');
    this.collector = collector?.replace(/\/$/, '');
    this.keys = keys;
    this.plans = plans;
    /** requestID -> { resolve, session }: the HTTP responses not written yet */
    this.pending = new Map();
    /** the `<log>` lines of the sessions */
    this.logs = [];
    /** the sessions that closed: { client, reason, requests, limited } */
    this.closed = [];
    /** the exports in flight, and how many failed */
    this.exports = new Set();
    this.exportFailures = 0;
    /** the requests at the upstream now */
    this.forwarding = 0;
    this.nextRequest = 1;

    this.host = new Host(
      {
        systemID: 'gateway',
        ioProcessors: [{ type: 'urn:gateway:upstream' }, { type: 'urn:gateway:http' }],
        system: { ticksPerSecond: 1000, traceSeed },
        // a request at most a second after its first record
        ...(this.collector && { telemetry: { flushInterval: 1000, resource: { 'service.name': 'http-gateway' } } }),
      },
      {
        clock,
        datamodel,
        ioProcessors: {
          // The request to the upstream, answered when the upstream answers:
          // an async handler, so its send stays readable after the await. A
          // connection that fails fails the send: the chart gets
          // error.communication with its sendid.
          'urn:gateway:upstream': async (host, send) => {
            const { requestID, method, path, body, client } = send.data;
            let answer;
            this.forwarding++;
            try {
              const response = await fetch(this.upstream + path, {
                method,
                headers: {
                  'content-type': 'application/json',
                  'x-client': client,
                  ...(send.traceparent && { traceparent: send.traceparent }),
                },
                body: method === 'GET' || method === 'HEAD' ? undefined : body,
              });
              answer = { requestID, status: response.status, body: await response.text() };
            } catch {
              answer = undefined;
            } finally {
              this.forwarding--;
            }
            // The gateway may have closed while the upstream worked: nobody
            // is left to tell. A session that ended meanwhile (a logout, an
            // expiry) makes answer() and fail() deliver nothing and give
            // false.
            if (host.closed) return;
            if (answer === undefined) send.fail();
            else send.answer('upstream.response', answer);
          },
          'urn:gateway:http': (host, send) => {
            if (send.event === 'respond') this.respond(send.data, send.traceparent);
            else if (send.event === 'closed') this.sessionClosed(send.session, send.data);
          },
        },
        log: (host, entry) => this.logs.push(`${entry.label}: ${entry.text}`),
        ...(this.collector && { telemetry: (host, signal, data) => this.export(signal, data) }),
      },
    );
    this.host.addCharts({ 'session.scxml': SESSION_CHART });
    this.server = createServer((req, res) => this.serve(req, res));
  }

  /** Listens on `port` (0: any free one) and answers the gateway's URL. */
  async listen(port = 0) {
    await new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  /** Opens a session for the client of `apiKey`: an actor named by a new
   * token, with its plan's limits. */
  login(apiKey) {
    const key = this.keys[apiKey];
    if (key === undefined) return { status: 403, body: { error: 'unknown API key' } };
    const token = randomUUID();
    const limits = this.plans[key.plan];
    this.host.spawnChart('session', { name: token, params: { client: key.client, ...limits } });
    return { status: 201, body: { token, plan: key.plan, limits } };
  }

  /** One request on the session `token`: `kind` is `'request'` or
   * `'logout'`. Resolves with the response, `{ status, headers, body }`,
   * when the chart (or the session's end) answers it. */
  dispatch({ token, kind = 'request', method = 'GET', path = '/', body = '', traceparent }) {
    const session = token === undefined ? undefined : this.host.actorByName(token);
    if (session === undefined) return Promise.resolve(this.unauthorized(traceparent));
    const requestID = `r${this.nextRequest++}`;
    const response = new Promise((resolve) => this.pending.set(requestID, { resolve, session }));
    try {
      this.host.send(session, kind, { requestID, method, path, body }, { traceparent });
    } catch (error) {
      // the session ended between the lookup and the send
      this.pending.delete(requestID);
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_STALE') return Promise.resolve(this.unauthorized(traceparent));
      throw error;
    }
    return response;
  }

  unauthorized(traceparent) {
    return { status: 401, headers: traceparent ? { traceresponse: traceparent } : {}, body: { error: 'no such session' } };
  }

  /** The chart's answer to one request: the HTTP response. */
  respond({ requestID, status, body, error, retryAfterMs }, traceparent) {
    const waiting = this.pending.get(requestID);
    if (waiting === undefined) return; // answered already: the session closed
    this.pending.delete(requestID);
    const headers = {};
    // the response names the trace it ended, as W3C's Trace Context Level 2
    // `traceresponse` header does
    if (traceparent) headers.traceresponse = traceparent;
    if (retryAfterMs !== undefined) headers['retry-after'] = String(Math.ceil(retryAfterMs / 1000));
    waiting.resolve({ status, headers, body: error === undefined ? body : { error } });
  }

  /** A session ended (a logout or its expiry): the requests it still had
   * (in flight, or queued behind the event that closed it) are answered
   * here, since the actor has gone. */
  sessionClosed(session, data) {
    this.closed.push({ session, ...data });
    for (const [requestID, waiting] of this.pending) {
      if (waiting.session !== session) continue;
      this.pending.delete(requestID);
      waiting.resolve({ status: 401, headers: {}, body: { error: `session closed (${data.reason})` } });
    }
  }

  /** The HTTP side. */
  async serve(req, res) {
    const url = new URL(req.url, 'http://gateway');
    const traceparent = req.headers.traceparent;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    let body;
    try {
      body = await readBody(req);
    } catch {
      return write(res, { status: 413, headers: {}, body: { error: 'request body too large' } });
    }
    let response;
    if (req.method === 'POST' && url.pathname === '/sessions') {
      const login = this.login(req.headers['x-api-key']);
      response = { headers: {}, ...login };
    } else if (req.method === 'DELETE' && url.pathname === '/sessions/current') {
      response = await this.dispatch({ token, kind: 'logout', traceparent });
    } else if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice('/api'.length) + url.search;
      response = await this.dispatch({ token, method: req.method, path, body, traceparent });
    } else {
      response = { status: 404, headers: {}, body: { error: 'not found' } };
    }
    write(res, response);
  }

  /** Posts one OTLP request to the collector. Returns the promise, so a
   * close awaits the last ones; a failure is counted, not thrown: the
   * request is lost, and retrying is an exporter's choice this one does not
   * make. */
  export(signal, data) {
    const posted = fetch(`${this.collector}/v1/${signal}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: data,
    }).then((response) => {
      if (!response.ok) this.exportFailures++;
      return response.arrayBuffer();
    }).catch(() => {
      this.exportFailures++;
    }).finally(() => this.exports.delete(posted));
    this.exports.add(posted);
    return posted;
  }

  /** Stops listening, closes the host (its last traces and logs go to the
   * collector, and the close waits for them), and answers what was still
   * waiting with 503. */
  async close() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
    await this.host[Symbol.asyncDispose]();
    await Promise.all([...this.exports]);
    for (const [, waiting] of this.pending) waiting.resolve({ status: 503, headers: {}, body: { error: 'shutting down' } });
    this.pending.clear();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function write(res, { status, headers, body }) {
  if (res.destroyed) return; // the client went away
  if (body === undefined || status === 204) {
    res.writeHead(status, headers).end();
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(text);
}
