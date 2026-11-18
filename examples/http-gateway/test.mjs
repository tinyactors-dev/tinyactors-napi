// The gateway's tricky cases, over real HTTP on port 0, with the session
// charts on a SimulatedClock, an upstream the test drives one request at a
// time and a fake OTLP collector, on both datamodels; then the demo of
// main.mjs on the real clock. Run by `mise run examples` (`node test.mjs`,
// `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Host, SimulatedClock } from '@tinyactors/node';
import { Gateway } from './gateway.mjs';
import { run } from './main.mjs';
import { Collector, Upstream } from './world.mjs';

const KEYS = { 'key-free': { client: 'acme', plan: 'free' }, 'key-pro': { client: 'globex', plan: 'pro' } };
// the caller's trace, as an HTTP client that traces would send it
const TRACE = '0af7651916cd43dd8448eb211c80319c';
const TRACEPARENT = `00-${TRACE}-b7ad6b7169203331-01`;
const traceOf = (traceparent) => traceparent?.split('-')[1];

/** A `respond` function whose calls wait until the test answers them. */
function held() {
  const calls = [];
  const respond = (call) => new Promise((resolve) => calls.push({ ...call, resolve }));
  return { calls, respond };
}

/** Waits until `condition()` holds: the HTTP side runs on real I/O. */
async function until(condition, what = 'the condition') {
  const end = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A gateway on a simulated clock in front of an upstream, exporting to a
 * collector; `respond` defaults to answering at once. */
async function setup(datamodel, { respond } = {}) {
  const clock = new SimulatedClock();
  const upstream = new Upstream({ respond });
  const collector = new Collector();
  const gateway = new Gateway({
    upstream: await upstream.listen(), collector: await collector.listen(), keys: KEYS, clock, datamodel, traceSeed: 7,
  });
  const url = await gateway.listen();
  const close = async () => {
    await gateway.close();
    await upstream.close();
    await collector.close();
  };
  return { clock, upstream, collector, gateway, url, close };
}

async function login(url, apiKey = 'key-free') {
  const response = await fetch(`${url}/sessions`, { method: 'POST', headers: { 'x-api-key': apiKey } });
  return { status: response.status, ...(await response.json()) };
}

/** One request through the gateway; answers status, headers and the body
 * as JSON. */
async function call(url, token, path, { method = 'GET', body, traceparent } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (traceparent) headers.traceparent = traceparent;
  const response = await fetch(`${url}${path}`, { method, headers, body });
  const text = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers), body: text ? JSON.parse(text) : undefined };
}

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: a request goes upstream and back, in the caller's trace`, async () => {
    const { upstream, url, close } = await setup(datamodel);
    try {
      assert.equal((await login(url, 'key-unknown')).status, 403);
      assert.equal((await call(url, undefined, '/api/items')).status, 401, 'no token');
      assert.equal((await call(url, 'not-a-session', '/api/items')).status, 401, 'no such session');

      const { status, token, plan } = await login(url);
      assert.equal(status, 201);
      assert.equal(plan, 'free');
      const response = await call(url, token, '/api/items/7?fields=name', { traceparent: TRACEPARENT });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { path: '/items/7?fields=name', client: 'acme' });
      assert.equal(traceOf(response.headers.traceresponse), TRACE, 'the response names the caller\'s trace');

      assert.equal(upstream.calls.length, 1);
      assert.equal(traceOf(upstream.calls[0].traceparent), TRACE, 'the upstream request continues it');
      assert.notEqual(upstream.calls[0].traceparent, TRACEPARENT, 'from a span of its own');

      const posted = await call(url, token, '/api/orders', { method: 'POST', body: '{"sku":"tea"}' });
      assert.equal(posted.status, 200);
      assert.deepEqual(upstream.calls[1], {
        method: 'POST', path: '/orders', client: 'acme', traceparent: upstream.calls[1].traceparent, body: '{"sku":"tea"}',
      });
      assert.notEqual(traceOf(upstream.calls[1].traceparent), TRACE, 'a request without a traceparent starts a trace');
    } finally {
      await close();
    }
  });

  test(`${datamodel}: the rate limit is a token bucket: a burst, then 429 until a refill`, async () => {
    const { clock, url, close } = await setup(datamodel);
    try {
      const { token } = await login(url); // free: a burst of 3, a token a second
      for (let n = 0; n < 3; n++) assert.equal((await call(url, token, '/api/items')).status, 200);
      const limited = await call(url, token, '/api/items');
      assert.equal(limited.status, 429);
      assert.deepEqual(limited.body, { error: 'rate limited' });
      assert.equal(limited.headers['retry-after'], '1');

      clock.increment(999);
      assert.equal((await call(url, token, '/api/items')).status, 429, 'not refilled yet');
      clock.increment(1);
      assert.equal((await call(url, token, '/api/items')).status, 200, 'one token back');
      assert.equal((await call(url, token, '/api/items')).status, 429);

      // three seconds, one deadline at a time: the bucket is full again, and
      // no fuller
      for (let s = 0; s < 4; s++) {
        clock.increment(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      const statuses = [];
      for (let n = 0; n < 4; n++) statuses.push((await call(url, token, '/api/items')).status);
      assert.deepEqual(statuses, [200, 200, 200, 429]);
    } finally {
      await close();
    }
  });

  test(`${datamodel}: a request over the plan's concurrency is refused while the others are in flight`, async () => {
    const upstreamCalls = held();
    const { url, upstream, close } = await setup(datamodel, { respond: upstreamCalls.respond });
    try {
      const { token } = await login(url); // free: one at a time
      const first = call(url, token, '/api/slow');
      await until(() => upstreamCalls.calls.length === 1, 'the first request upstream');
      const second = await call(url, token, '/api/items');
      assert.equal(second.status, 429);
      assert.deepEqual(second.body, { error: 'too many requests in flight' });
      upstreamCalls.calls[0].resolve({ status: 200, body: { ok: true } });
      assert.equal((await first).status, 200);
      const third = call(url, token, '/api/items');
      await until(() => upstreamCalls.calls.length === 2, 'the third request upstream');
      upstreamCalls.calls[1].resolve({ status: 404, body: { error: 'no such item' } });
      assert.deepEqual(await third, { status: 404, headers: (await third).headers, body: { error: 'no such item' } }, 'the upstream\'s status passes through');
      assert.equal(upstream.calls.length, 2, 'the refused one never went upstream');
    } finally {
      await close();
    }
  });

  test(`${datamodel}: an upstream that does not answer in time is a 504; its late answer goes nowhere`, async () => {
    const upstreamCalls = held();
    const { clock, gateway, url, close } = await setup(datamodel, { respond: upstreamCalls.respond });
    try {
      const { token } = await login(url);
      const slow = call(url, token, '/api/slow', { traceparent: TRACEPARENT });
      await until(() => upstreamCalls.calls.length === 1, 'the request upstream');
      clock.increment(1999);
      // a turn, not idle(): idle() waits for the upstream handler's promise,
      // which this test holds
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(gateway.pending.size, 1, 'still waiting');
      clock.increment(1);
      const response = await slow;
      assert.equal(response.status, 504);
      assert.deepEqual(response.body, { error: 'upstream timeout' });
      assert.equal(traceOf(response.headers.traceresponse), TRACE, 'the timeout ends the caller\'s trace too');

      upstreamCalls.calls[0].resolve({ status: 200, body: {} });
      await until(() => gateway.logs.some((line) => line.startsWith('late:')), 'the late answer');
      assert.deepEqual(gateway.logs, [
        'timeout: upstream did not answer r1 in 2000 ms',
        'late: upstream answered r1 after its timeout',
      ]);
      // the slot is free again
      const next = call(url, token, '/api/items');
      await until(() => upstreamCalls.calls.length === 2, 'the next request upstream');
      upstreamCalls.calls[1].resolve({ status: 200, body: { ok: 1 } });
      assert.equal((await next).status, 200);
    } finally {
      await close();
    }
  });

  test(`${datamodel}: a dropped upstream connection: a GET is retried once, a POST is a 502`, async () => {
    const answers = ['drop', { status: 200, body: { second: true } }, 'drop', 'drop', 'drop'];
    const { url, upstream, gateway, close } = await setup(datamodel, { respond: () => answers.shift() });
    try {
      const { token } = await login(url, 'key-pro');
      const retried = await call(url, token, '/api/items');
      assert.equal(retried.status, 200);
      assert.deepEqual(retried.body, { second: true });
      assert.equal(upstream.calls.length, 2);

      const failed = await call(url, token, '/api/items');
      assert.equal(failed.status, 502, 'a GET that fails twice');
      assert.deepEqual(failed.body, { error: 'upstream unavailable' });
      assert.equal(upstream.calls.length, 4);

      const posted = await call(url, token, '/api/orders', { method: 'POST', body: '{}' });
      assert.equal(posted.status, 502, 'a POST is not retried: it may have been applied');
      assert.equal(upstream.calls.length, 5);
      assert.deepEqual(gateway.logs, [
        'retry: upstream connection failed for r1, retrying the GET',
        'retry: upstream connection failed for r2, retrying the GET',
      ]);
    } finally {
      await close();
    }
  });

  test(`${datamodel}: an idle session expires; its requests are refused from then on`, async () => {
    const { clock, gateway, url, close } = await setup(datamodel);
    try {
      const { token } = await login(url);
      assert.equal((await call(url, token, '/api/items')).status, 200);
      clock.increment(29_999);
      assert.equal((await call(url, token, '/api/items')).status, 200, 'a request keeps it open');
      clock.increment(29_999);
      await gateway.host.idle();
      assert.equal(gateway.closed.length, 0);
      clock.increment(1);
      await gateway.host.idle();
      assert.deepEqual(gateway.closed.map(({ reason, requests, limited }) => ({ reason, requests, limited })), [{ reason: 'idle', requests: 2, limited: 0 }]);
      assert.equal(gateway.host.actorByName(token), undefined, 'the actor has ended');
      const late = await call(url, token, '/api/items');
      assert.equal(late.status, 401);
      // the encoder's flush is a deadline too (docs/log.xml,
      // l-p4-examples-gateway-flush-deadline): past it, none is left
      clock.increment(1000);
      await gateway.host.idle();
      assert.equal(gateway.host.nextDeadline, undefined, 'no timer is left');
    } finally {
      await close();
    }
  });

  test(`${datamodel}: a logout answers the requests behind it and in flight with 401`, async () => {
    const upstreamCalls = held();
    const { gateway, url, close } = await setup(datamodel, { respond: upstreamCalls.respond });
    try {
      const { token } = await login(url, 'key-pro');
      const inFlight = call(url, token, '/api/slow');
      await until(() => upstreamCalls.calls.length === 1, 'the request upstream');
      // the logout and a request in the same tick: the logout is first in
      // the actor's queue, so the request reaches an actor that has ended
      const logout = gateway.dispatch({ token, kind: 'logout' });
      const behind = gateway.dispatch({ token, path: '/items' });
      assert.equal((await logout).status, 204);
      assert.deepEqual(await behind, { status: 401, headers: {}, body: { error: 'session closed (logout)' } });
      assert.equal((await inFlight).status, 401);
      assert.equal((await call(url, token, '/api/items')).status, 401);
      assert.equal((await call(url, token, '/sessions/current', { method: 'DELETE' })).status, 401, 'a second logout');

      upstreamCalls.calls[0].resolve({ status: 200, body: {} }); // its answer, for an actor that is gone
      await until(() => gateway.forwarding === 0, 'the late answer');
      await gateway.host.idle();
      assert.equal(upstreamCalls.calls.length, 1);
      assert.deepEqual(gateway.closed.map((c) => c.reason), ['logout']);
    } finally {
      await close();
    }
  });

  test(`${datamodel}: traces and logs reach the collector in the caller's trace`, async () => {
    const upstreamCalls = held();
    const { clock, url, collector, gateway, close } = await setup(datamodel, { respond: upstreamCalls.respond });
    let decoder;
    try {
      const { token } = await login(url);
      const slow = call(url, token, '/api/slow', { traceparent: TRACEPARENT });
      await until(() => upstreamCalls.calls.length === 1, 'the request upstream');
      clock.increment(2000); // a timeout, and its <log> line
      assert.equal((await slow).status, 504);
      upstreamCalls.calls[0].resolve({ status: 200, body: {} }); // late: idle() waits for the handler's promise
      await gateway.host.idle();
      clock.increment(1000); // the flush interval
      await gateway.host.idle();
      await until(() => collector.requests.length >= 2, 'the first export');
      assert.deepEqual(new Set(collector.requests.map((r) => r.signal)), new Set(['traces', 'logs']));
      assert.ok(collector.requests.every((r) => r.contentType === 'application/x-protobuf'));
    } finally {
      await close();
    }
    // after the close, which sent the last requests and waited for them
    assert.equal(gateway.exportFailures, 0);
    decoder = new Host({ systemID: 'decoder', telemetry: {} });
    try {
      const spans = [];
      for (const traces of collector.bodies('traces')) spans.push(...(await decoder.traceSpansDecode({ traces })).spans);
      const ours = spans.filter((span) => span.trace === TRACE);
      const names = new Set(ours.map((span) => span.name));
      assert.ok(names.has('scxml.macrostep request'), [...names].join(', '));
      assert.ok(names.has('scxml.macrostep upstream.timeout'), [...names].join(', '));
      const step = ours.find((span) => span.name === 'scxml.macrostep request');
      assert.equal(step.parent, TRACEPARENT.split('-')[2], 'the request\'s step is a child of the caller\'s span');
    } finally {
      decoder.close();
    }
    // a log record carries its trace id as 16 raw bytes
    const traceID = Buffer.from(TRACE, 'hex');
    const logs = collector.bodies('logs');
    assert.ok(logs.some((body) => body.includes(traceID) && body.includes('upstream did not answer r1')), 'the timeout\'s <log> line, in the caller\'s trace');
  });
}

test('the demo on the real clock: every request is answered, by the chart or the gateway', async () => {
  const { results, collector, closed } = await run({ clients: 4, requests: 40, seed: 3 });
  assert.equal(results.length, 160);
  const statuses = new Set(results.map((r) => r.status));
  for (const status of [200, 429]) assert.ok(statuses.has(status), [...statuses].join());
  assert.ok(results.every((r) => [200, 401, 404, 429, 502, 504].includes(r.status)), [...statuses].join());
  assert.ok(results.filter((r) => r.traced).every((r) => r.traceresponse === r.trace), 'every traced response names its trace');
  assert.equal(closed.length, 4, 'every session logged out');
  assert.ok(collector.bodies('traces').length > 0 && collector.bodies('logs').length > 0);
});
