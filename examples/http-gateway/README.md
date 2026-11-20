# HTTP gateway

A rate-limited API gateway in front of an upstream service, on
`node:http`. A client logs in with its API key and gets a session token;
each session is an actor, and every request the client makes on it is an
event for that actor. The chart decides what becomes of each request, by
the rules a real gateway has to get right:

- **A rate limit per session**, a token bucket: a plan's `burst` of
  requests at once, then one more every `refillMs`. A request with no
  token left is answered `429` with a `Retry-After`. The bucket refills by
  a delayed send that stops when it is full, so an idle session costs no
  timer for it.
- **A concurrency limit:** at most `maxInFlight` requests of a session at
  the upstream; one more is `429` too, and never reaches the upstream.
- **An upstream that does not answer in time** is a `504` after
  `upstreamTimeoutMs`. Its answer may still come: it goes nowhere, and the
  chart logs it.
- **A connection to the upstream that fails** is a `502`, except for a
  `GET`, which is idempotent and sent once more within the same timeout.
  A `POST` is never repeated: the upstream may have applied it.
- **A session ends** at its logout, or after `idleMs` without a request.
  Requests still in flight then, and requests that were already queued
  behind the logout, are answered `401` by the gateway: the actor that
  would have answered them has ended. A request to an ended session is
  `401` too.
- **Tracing across the gateway:** a request's `traceparent` header is the
  trace of the step it starts, the request to the upstream carries that
  trace on in its own `traceparent`, and the response names it in a
  `traceresponse` header, the 504 and the 429 included. Traces and logs go
  to an OpenTelemetry collector over OTLP/HTTP.

## What is where

| File | What it holds |
|---|---|
| [`charts/session.scxml`](charts/session.scxml) | the session: the bucket, the concurrency limit, the timeouts, the retry, the expiry |
| [`gateway.mjs`](gateway.mjs) | the application: the HTTP server, the host, the I/O processors the chart sends to, the export of telemetry |
| [`world.mjs`](world.mjs) | the upstream service and a fake OTLP collector, both HTTP servers on port 0 |
| [`main.mjs`](main.mjs) | a busy second: clients faster than their plans allow, at an upstream that is slow and flaky |
| [`test.mjs`](test.mjs) | each tricky case over real HTTP, the charts on a `SimulatedClock`, on both datamodels |

The routes: `POST /sessions` with an `x-api-key` header logs in (`201`
with `{ token, plan, limits }`, `403` for an unknown key); `DELETE
/sessions/current` logs out (`204`); `/api/<path>` with `Authorization:
Bearer <token>` goes to `<upstream>/<path>`, with the method, the query
and the body. The plans and the API keys are the application's policy
(`PLANS` in `gateway.mjs`): the gateway gives a session its plan's limits
as spawn params, and the chart enforces them.

## The tinyactors features it uses, and why

- **An actor per session, named by its token** (`host.spawn('session',
  { name: token, params })`, `host.actor(token)`): the session's
  state (its tokens, what it has in flight, its timers) lives in one
  place, and the HTTP handler only finds the actor and sends it the
  request. A session that ended is found no more, which is how a request
  with a stale token gets its `401`.
- **An async I/O processor answers requests** (`urn:gateway:upstream`):
  the chart's `<send>` is the request to the upstream, and the handler,
  an `async` function, makes it with `fetch` and answers with the
  upstream's status and body (`send.answer`), or fails the send when the
  connection fails (`send.fail()`), which the chart gets as
  `error.communication` with the send's `sendid`. The chart keeps each
  request's `sendid` (`<send idlocation>`) to know which request failed.
- **A sync I/O processor writes the responses** (`urn:gateway:http`): the
  chart's answer to every request, a `429`, a `504` or the upstream's, is
  a send of its own, so the HTTP side never decides a status itself, but
  for sessions that are gone. Its `closed` event tells the gateway a
  session ended, with its counts.
- **Delayed sends and `<cancel>`** for the bucket's refill, each
  request's timeout (`<cancel sendidexpr>` takes it back when the answer
  comes) and the idle expiry (cancelled and sent again by every request).
- **Trace context from the request headers:** `host.send(session,
  'request', data, { traceparent })` with the header's text;
  `send.traceparent` for the upstream request's header and for the
  response's `traceresponse`; `send.answer()` keeps the trace, so the
  step that answers is in the caller's trace too.
- **Telemetry** (`telemetry` in the config and in the options): the
  handler posts each OTLP request to the collector's `/v1/traces` or
  `/v1/logs` with `fetch`, and returns the promise, so the gateway's
  `close()` (`host[Symbol.asyncDispose]()`) waits for the last ones. The
  chart's `<log>` lines (a timeout, a late answer, a retry) are log
  records in the trace of the step that wrote them. Each host draws its
  own trace seed; the test sets `system.traceSeed` to reproduce its ids.
- **A `SimulatedClock`** in the test: the 2 s timeouts, the 30 s expiry
  and the refills take no time, while the HTTP around them is real.
- **Both datamodels:** the test runs every case on the native datamodel
  and on quickjs.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/http-gateway/main.mjs              # or: bun examples/http-gateway/main.mjs
node examples/http-gateway/main.mjs --clients 6 --requests 80 --seed 7
```

It starts the upstream, the collector and the gateway on free ports, runs
the clients (half on the free plan, half on pro, with timings a hundred
times shorter than `PLANS`), and prints how each client's requests ended,
how many were answered in their caller's trace, and what the collector
got:

```output
client-0 (free)  200: 9  429: 40  504: 1
client-1 (pro )  200: 32  404: 2  429: 9  502: 3  504: 4
...
200 requests in 585 ms; 91 traced, 91 answered in their caller's trace
8 GETs retried, 9 upstream timeouts, 4 late answers dropped
```

## Test it

```sh
mise run examples http-gateway     # under node and bun
node examples/http-gateway/test.mjs
bun test ./examples/http-gateway/test.mjs
```

The test drives the upstream one request at a time (a request waits until
the test answers it) and checks what the client, the upstream and the
collector saw: the trace ids the collector's spans and log records carry,
read back with `host.traceSpansDecode`. The last case runs
`main.mjs`'s demo on the real clock. All of it takes about a second.
