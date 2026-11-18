# AGENTS.md: tinyactors-napi

`@tinyactors/node`: one Node-API addon, written in C, that drives
`ta_host` from Node.js and Bun. It is being rewritten from scratch
(`70434bee` removed the first one; [ROADMAP.md](ROADMAP.md) says where
the work is: after the Python binding's step). This file is the rulebook
the rewrite starts from: it holds the binding's rules, true at every
step. The repository root's `AGENTS.md` applies too.

Read first, in this order:
[`tinyactors-core/docs/embedding.md`](../tinyactors-core/docs/embedding.md)
(how to use the core: the loop, lifetimes, memory, a complete loop in C),
[`tinyactors-core/docs/bindings.md`](../tinyactors-core/docs/bindings.md)
(the guide for a binding),
[`tinyactors-core/docs/boundary.md`](../tinyactors-core/docs/boundary.md)
(the contract of every host call), [ADR 0012](../docs/adr/0012-lifetimes-follow-the-loop.md),
and the public headers. Build from those, not from the removed addon (or
the 0.2.0 package in git history) or the proposals' sketches.

## Whom it serves

First the **application developer writing JavaScript** on Node.js or Bun:
chart logic in ECMAScript (the native `"ecmascript"` datamodel, in the
application's own engine), a `Host` on the runtime's event loop, values
that are JavaScript values. Then the **binding author**, held to the guide
by the conformance suite, and the **maintainers**, who run one suite
against every implementation. Every API item is a host input, a typed
method over a posted message, or the handling of an effect
(`docs/api-map.md`); what core does not have is not in the API.

The addon is the binding: it defines the classes, runs the loop,
dispatches effects, converts values and implements the native datamodel
in C. `lib/direct.mjs` loads the platform's `.node` file and re-exports
it, nothing else; `index.mjs` exports it and the convenience layer
(`lib/convenience.mjs`, JavaScript over `lib/direct.mjs` only), which
joined it after M1 ("Layers and the resolver"). The plan of step 8.5, with
every decision below and its evidence, is [docs/plan.xml](docs/plan.xml).

## Layers and the resolver

Shared with the Python binding (decided 2026-10-13; bindings.md section
1, "Two layers"; `tinyactors-cpython/AGENTS.md`, "Layers" and "The
API"). Node's names and shapes (decided 2026-10-16, docs/plan.xml):

- **The addon is the direct layer, and mirrors the C API** more or less
  one to one: a compile call over `ta_compile_charts` that throws with
  every diagnostic and returns an object whose `image` is a `Buffer`
  copied once on first read (a first read after `close()`, which calls
  `ta_compile_free`, throws `TA_ERROR_STALE`; not a view: a detached
  external buffer is still read after the free, `boundary.md` section 7);
  a compile call that also parses every expression and script of an
  `"ecmascript"` chart with the engine (`new vm.Script` in the native
  datamodel's shapes, nothing run; 2026-10-18,
  l-p4-examples-iot-syntax-unchecked), each syntax error a warning
  diagnostic at its element's line, an error with `{warningsAsErrors}`
  (core's `TA_COMPILE_WERROR`), since SCXML makes such an expression an
  `error.execution` at its evaluation (W3C 156, 277, 309, 312, 344, 487,
  488, 528 have them); `addImage(image)` returning the segment
  (`ta_host_add_image` copies the bytes); `chart(name)` over
  `ta_host_chart`; `spawn(ref, ...)` over `ta_host_spawn`, taking that
  reference.
- **A convenience layer in JavaScript above it, after M1:**
  `lib/convenience.mjs`, which imports only `lib/direct.mjs`, the
  addon's exports (the lint rule `convenience-imports-the-direct-layer`),
  and adds shapes, not behaviour. First the typed methods as promises
  (decided 2026-10-16: the direct layer keeps ADR 0012's response
  handlers, and a promise is what a JavaScript programmer would write over
  them anyway): **`await host.actorState({session})`**, the typed method
  given no handler (the maintainer, 2026-11-18, replacing the `…Async`
  names of 2026-10-17): the convenience layer wraps each direct method on
  `Host.prototype`, passes a call with a handler to it unchanged (one
  argument check, a few nanoseconds against the post's microseconds,
  l-maint-promises-built), and otherwise calls it with a handler that
  resolves and one that rejects with the same `TinyactorsError` (a
  refusal at the call rejects; a rejection with no `catch` is an
  unhandled rejection, never the turn's; pending at `close()`, it never
  settles); then the shapes chosen in p3-shapes (2026-10-17):
  **`host.addCharts({name: text}, {resolver}?)`** (compileCharts,
  addImage, close; returns the segment), **`host.spawnChart(name,
  options?)`** (chart, then spawn), **`directoryResolver(root)`** (reads
  `source` under `root` relative to `base`, refusing with `ResolveError` a
  path that leaves it, symbolic links included; the one use of the
  built-ins the layer may import, `node:fs` and `node:path`) and
  **`Address.prototype.toJSON`** (its text). A chart builder waits for the
  direct layer to expose `ta_xml_writer`.
- **A resolver is any callable** `(base, source) => text` (a function,
  an arrow, a bound method; decided 2026-10-16, as Python's API review
  did), given to the compile call only (a static `src`, at compile time;
  a refusal reported as a diagnostic at its line and column, the message
  in the compilation's scratch arena,
  `tinyactors-core/docs/boundary.md` section 12). **The resolver lives
  only at compile time:** the `Host` has none. A resolver that reads a directory belongs to
  the convenience layer, in JavaScript, confined to its root.
- **`TA_EFFECT_REQUEST` is a fetch at run time** (an `<invoke srcexpr>`
  whose chart is not in the image), and it stays
  (decided 2026-10-13; ADR 0012, decision 8;
  `tinyactors-core/docs/boundary.md` section 12). Core has already
  normalized the name and looked in the requesting segment's image
  (`tinyactors-core/src/system/route.c:439-497`), so until run-time
  fetching is built the addon answers it in C with `ta_host_resume` and
  `TA_ERROR_INVALID` (the parent gets `error.execution`); no JavaScript
  runs and the addon looks nothing up. How a binding will fetch
  is decided with the build-out (root `ROADMAP.md`, "Decided later");
  not now. It is not the control plane (`ta_host_post`,
  `REPLY`, `NOTIFICATION`).
- **A traceparent crosses as W3C text.** In: the string's UTF-8 for the
  call (`ta_spawn.traceparent`, `ta_event_in.traceparent`,
  `tinyactors-core/include/tinyactors/system.h:125-132`, `:171-173`),
  parsed by core (`ta_traceparent_parse`). Out: a send's traceparent is
  read through `TA_EFFECT_FIELD_TRACEPARENT` on first access (the effect
  holds the binary `ta_trace_context`), absent when untraced; an answer
  and a failure keep the send's trace unless the caller passes none
  (`traceparent` in an options object, `undefined` when untraced).

## Names

Our names carry the prefix `ta_napi_*`: every function this addon defines
or declares, static helpers included, and its types and globals. A
platform's name appears only where the platform requires it: the module's
entry points `napi_register_module_v1` and
`node_api_module_get_api_version_v1`, which `NAPI_MODULE_INIT()` defines
(Node.js's `include/node/node_api.h`). A callback given to Node-API (a
`napi_callback`, a `napi_finalize`) is our function, with our name. When
you write a name in prose, say whose it is. The lint rule
`functions-carry-the-prefix` checks functions. In JavaScript the API's
names follow the root's acronym rule (`sessionID`, `toOTLP`).

## The loop

The addon runs embedding.md's loop (sections 2 and 4), in C, as the
guide's `drain` and `turn` (bindings.md section 3) with our prefix: the
ack count that makes thin views stale is bumped in `drain`, right after
the ack.

- **One drain at a time:** take (`ta_host_effects`), handle every effect
  of the batch, ack (`ta_host_effects_ack`), and take again until a take
  is empty; then, at most, a run. A take never widens the open batch, and
  `ta_host_run` refuses while one is open. There
  is no nested drain: JavaScript a handler runs (an I/O processor's
  callback) may call the `Host` to add inputs, post, or read outputs; it
  never takes or acks.
- **The event loop drives every host, transparently** (decided
  2026-10-16: Python has a choice between an event loop and none; Node
  does not). There is no synchronous driver in the API. An input from
  outside a turn schedules one turn with `setImmediate` (one pending at a
  time; not a microtask, so I/O runs between turns); a turn that reaches
  its bound (64 runs, a drain of 64 batches) yields the same way; an idle
  turn arms one timer, the global `setTimeout`, at the deadline, ref'd
  while it is pending and replaced on the next idle turn (Bun has no
  `uv_timer_*`: oven-sh/bun#18546). So an open host with a pending
  deadline keeps the process alive until it or `close()`, which the README
  says. **`await host.idle()`** is a promise that settles at the next idle
  turn with no handler's promise pending (2026-10-18,
  l-p4-examples-order-settle: every promise a handler returns, the I/O
  processors', the services' and their `receive`'s, wake, telemetry, log,
  migration and typed-method handlers', is followed with `then` and
  counted on the host, and the count reaching zero with an `idle()`
  waiting schedules a turn; the last take's at close is `asyncDispose`'s
  instead): it observes, it drives nothing. On a closed host it returns a
  rejected promise (`TA_ERROR_STATE`) instead of throwing. **`host.now()`**
  reads the host's clock now in milliseconds, and `snapshot()` advances
  the clocks before it packs, so the snapshot's time is the call's.
- **Every run status** of bindings.md section 3; both clocks before every
  run and every input that depends on them, converted with
  `system.ticksPerSecond`, which the addon reads from `host.config` at
  creation, and after each run when an encoder is configured.
- **Time in the API is milliseconds** (decided 2026-10-16: what
  JavaScript programmers expect; Python's is seconds): `nextDeadline`,
  `migrate`'s `timeout`, `SimulatedClock.increment(ms)` and `.now`. Ticks
  stay inside the addon.
- **A simulated clock**, `SimulatedClock` with `increment(ms)` (xstate's
  shape, our meaning): it moves the clock and schedules a turn on each
  host made with it, like any input, and turns nothing itself (decided
  2026-10-16); a test writes `clock.increment(1000); await host.idle()`.
  A host made with one arms no timer.
- **Whatever a handler threw:** ack anyway, finish the turn, re-arm the
  timer, then report the first error: it rejects every waiting `idle()`,
  and with none waiting it is thrown from the turn's callback, an
  uncaught error the runtime reports (decided 2026-10-16). A handler's
  promise that rejects after its turn stays an unhandled rejection. The
  README says that either ends the process by default unless the
  application handles `uncaughtException` and `unhandledRejection`.
- **No turn inside another call:** `close()` from a handler is deferred
  to the end of the turn; a finalizer never turns or takes.

## Lifetimes and thin views

ADR 0012: **everything the host hands out about a batch lives until the
ack.** Effect fields (`TRACEPARENT` included), traces, logs,
metrics and hibernation blobs read while handling stay valid
across any later call into the host, until the ack. A datamodel's outputs
live until its next call. Snapshots and the refused config's error fill a
`ta_buffer` the addon lends.

The rules the Python binding follows hold here too (bindings.md, sections
3 and 6; `tinyactors-cpython/AGENTS.md`, "Lifetimes and thin views"):

- **Thin views, not eager conversion.** Wherever a C value is exposed to
  JavaScript, the addon hands out a view that holds the host, the ack
  count and the effect's index and converts a field when it is read: an
  I/O processor's send, a `<log>` line. A view's data from the native
  datamodel is the payload row's value copied into the application's
  realm on its first read (2026-10-18, l-p4-examples-chat-realm: the kit
  of the realm's script run in the application's own realm, its
  `exported`), an XML node as its XML text; `invocation.data` likewise.
- **A view is stale after its ack.** The addon counts its acks (bumped
  right after `ta_host_effects_ack` in its drain; core keeps no batch
  counter); a read with another count throws with
  `ta_status_name(TA_ERROR_STALE)`.
- **Materialize what outlives the ack, before the ack, when the handler
  returns a promise** (decided 2026-10-16). Every handler gets a thin
  view. When it returns a thenable (an async function, or a plain function
  returning a promise, which a check at registration would miss), the
  addon fills that view with every field before the ack, and its
  `answer()` and `fail()` then work any time while the host lives: they
  return `true` when delivered and `false` when the sender ended meanwhile
  (2026-10-18, l-p4-examples-gateway-answer-ended; Python raises), and
  any other refusal throws. The
  view records whether it was answered or failed: a promise that rejects
  before an answer fails the send (`error.communication` for the sender)
  and stays an unhandled rejection; one that rejects after an answer
  fails nothing. A view kept and used from a callback the handler did not
  return (a bare `setTimeout`) is stale there, as in Python. Since ADR 0017
  the sender waits for the ack: an answer given in the handler is what it
  sees when it goes on; one given later arrives as an ordinary event.
- **Host outputs are copied once** into a `Buffer`
  (`napi_create_buffer_copy`) before the ack: telemetry data, `metrics()`,
  `hibernate()`; never a view of host memory (boundary.md section 7).
  `snapshot()` fills a `ta_buffer` the addon lends: `ta_host_snapshot_pack`
  writes the pack once, straight into a `Buffer` of the size its probe
  gave (`napi_create_buffer`).
- **A reply's `result` is converted once**, at its dispatch, for its
  response handler.

## What reaches the application

| JavaScript sees | Through | Core |
|---|---|---|
| an actor's output | an I/O processor's handler the application configures per host, given the send as a thin view; it may answer or fail it | `TA_EFFECT_SEND`; `ta_host_send` (with `TA_EVENT_IN_ERROR_COMMUNICATION` for a failure) |
| services the charts invoke | a service registered by type | `TA_EFFECT_INVOKE`, `UNINVOKE`, sends with `IO_PROCESSOR` `TA_NIL` |
| an actor's state | the typed method over `actor.state` (subscriptions are removed, ADR 0012 decision 4) | `ta_host_post`, `TA_HOST_EFFECT_REPLY` |
| inspection and trace control | typed methods, each taking a response handler the drain calls when its `REPLY` is dispatched | `ta_host_post`, `TA_HOST_EFFECT_REPLY` |
| `<log>` | a log handler configured per host, given each line as a thin view; none: discarded; no console default | `TA_EFFECT_LOG` |
| telemetry | an exporter the application configures | `TRACES`, `LOGS`, `ta_host_metrics` |
| another system | the host's `transport` handler, given each send to another system's address as a thin view; without one, each such send is failed | `TA_EFFECT_SEND` with `io_processor` 0 |

- **Everything is per host:** handlers, the log handler and the clock are
  given to the `Host`; no global configuration.
- **The binding picks the trace seed** (the maintainer, 2026-11-18): a
  config with no `system.traceSeed` (absent or `undefined`) is copied with
  a random 64-bit one from `crypto.getRandomValues` before
  `ta_host_create` (`ta_napi_config_seeded`; the wasm package's `seeded`),
  so hosts start different trace ids; a seed the caller sets is kept and
  reproduces; `Host.restore` passes its config as given, its segments
  keeping the snapshot's generators. Core stays free of I/O.
- **`DONE` and `ERROR` are internal:** the addon releases its rows for the
  session; no application callback.
- **An I/O processor's handler that throws before answering** (or whose
  promise rejects before an answer) has its send failed, as ADR 0009 has
  a runtime that cannot do what an effect asks answer with a failed
  completion (`error.communication` for the sender), and the error is
  reported as "The loop" says.
- **A log entry is `(session, label, text)`**, no chart.
- **No synchronous request and no raw `post`** (ADR 0012, decision 3): one typed method per method of
  `tinyactors-core/docs/requests.md` but `actor.send` (which is
  `host.send`), shaped `method(params, onResult, onError)` (decided
  2026-10-16): `params` an object passed to core as given (`undefined`
  for none), `onResult(host, result)` at the `REPLY`'s dispatch,
  `onError(host, error)` optional and never a param for core; it returns
  nothing. Called with no handler it returns a promise instead (the
  convenience layer, 2026-11-18). The
  message id is the handle of a row in a pending `ta_table` holding the
  handlers; the drain finds it in O(1), the generation refusing a stale
  id, and pending handlers are dropped, never called, at `ta_host_free`.
- **No notification is defined;** the addon drops a
  `TA_HOST_EFFECT_NOTIFICATION` whose method it does not know.
- **Invoked services** (decided 2026-10-16, as Python's "Invoked
  services"; docs/plan.xml, p2-services): `services: {[type]: (host,
  invocation) => service}`. At a `TA_EFFECT_INVOKE` the handler of its
  type (`EVENT`) gets an **`Invocation`**, a record made before the ack (a
  service outlives it): `session` (a `bigint`), `invokeid` (`SENDID`),
  `type`, `src` (`TARGET`), `data` (the payload's value), `traceparent`,
  `restored` (`TA_EFFECT_FLAG_RESTORED`) and `running`; its type, src and
  invokeid are the last invocation's strings when the text is the same,
  so a population shares them. What the handler returns is the service,
  kept with its record as `[invocation, service]` in a `Map` keyed by
  core's (`SEGMENT`, `TOKEN`) as one `bigint`, on the handlers object the
  wrapper holds: no `napi_ref`, no table of invoke ids, and gone with the
  handlers at close (dropped, not stopped).
  **`invocation.sendBack(event, data?, {traceparent}?)`** is `ta_host_send`
  with `TA_EVENT_IN_FROM_INVOKE` and the token, **`invocation.done(data?,
  {traceparent}?)`** with `TA_EVENT_IN_INVOKE_DONE` (the entry goes); both
  keep the invoke's trace unless given one (`null`: a new trace) and throw
  `TA_ERROR_STALE` once it ended or the host closed. A `TA_EFFECT_SEND`
  with `IO_PROCESSOR` `TA_NIL` goes to the service's **`receive(host,
  send)`**, called on the service, with a thin `Send` whose `type` is
  `undefined`; a `TA_EFFECT_UNINVOKE` to its **`stop(host)`**, then the
  entry goes; both optional. **A handler may return a thenable of the
  service** (decided 2026-10-17, l-p2-services-promise revised: async is
  the event loop's): the invocation is starting until it settles, its
  entry kept with no service and its record's `queue`; a send that comes
  meanwhile is made a record before its ack (as a promise-returning I/O
  processor's) and queued, and given to `receive` in order when the
  promise resolves (`ta_napi_service_started`, a microtask between turns,
  never inside a run); an UNINVOKE meanwhile ends the invocation and its
  `stop` is called once it resolves, the queued sends dropped (the
  invocation has ended, so nothing could answer them); a `done()` in the
  start keeps nothing; a rejection (`ta_napi_service_start_failed`) is a
  failed start: `error.communication` to the invoker and to each queued
  send with its sendid, the entry failed, the rejection thrown on
  (unhandled, as a handler's promise's); after `close()` a settling
  promise is ignored. No handler, or a handler that throws: `ta_host_send`
  with `TA_EVENT_IN_ERROR_COMMUNICATION | TA_EVENT_IN_FROM_INVOKE` to the
  invoker, none when an UNINVOKE of the same token follows in the open
  batch; a handler's error is reported as "The loop" says, while a type
  with no handler throws nothing (a chart picks the type: an untrusted
  one must not end the process). A failed start
  stays as an entry marked failed, so each send to it gets
  `error.communication` with its sendid, until the UNINVOKE (no `stop`).
  A `receive` that throws, or whose promise rejects (its view filled
  before the ack, as an I/O processor's), is a crash: the invoker gets
  `error.communication` with the send's sendid, and the entry stays failed
  without the service (dropped, not stopped). A restored host's first run
  announces each invocation that was running, as any INVOKE.
- **Other systems** (ADR 0014; ADR 0017, decisions 4 and 5;
  bindings.md section 9): the `transport` handler gets every send to
  another system's address (`io_processor` 0; core decides local or not),
  and `send.message` is its outgoing half, an object of `ta_event_in`'s
  fields (`target`, `event`, `data`, `sendid`, `origin`, `traceparent`);
  the other side passes it unchanged to **`host.send(message)`**, which
  ignores keys it does not know, and a send the application believes
  failed is **`host.fail(target, sendid)`**
  (`TA_EVENT_IN_ERROR_COMMUNICATION`). The address fields are **`Address`**
  values, as Python's (decided 2026-10-16): immutable, `.text`, and
  `.system`, `.session` (a `bigint`) and `.name` read by core's parser on
  each access (`ta_address_parse`, `ta_address_name_decode`), `undefined`
  for a part the text lacks, `toString()` the text; `host.send` and
  `host.fail` take an `Address` or a string. No peers, envelopes or
  routes: the transport and the wire encoding are the application's.

## The host's allocator

The host allocates through the `ta_allocator` its environment gives it
(`tinyactors-core/include/tinyactors/allocator.h`), and this addon gives it
`malloc` and `free`, reporting each block to the engine with
`napi_adjust_external_memory`, so the garbage collector sees the host's
memory. That call takes a `node_api_basic_env` (Node.js 22's
`include/node/js_native_api.h:493`), so it may run where only basic-env
functions may, such as a finalizer that frees a host. The two functions
take core's parameter lists (`void *context, size_t size, size_t align`
and `void *context, void *ptr, size_t size`), which the lint exempts by
that signature; the environment they need comes through `context`.

**Alignment: `align` is at most 8, and `malloc` gives at least 8.** The
host passes 8 on every allocation it makes (`tinyactors-core/src/host/host.c`,
`host_alloc`), the largest alignment a region object needs is 8
(`src/base/config.h`, `TA_ALIGN_MAX`), and the allocator's contract says
"a power of two, at most 8 from this library"
(`include/tinyactors/allocator.h:9`). `malloc` returns memory aligned for
any object of fundamental alignment, `_Alignof(max_align_t)` (C11,
7.22.3), and the pinned clang 22 gives `max_align_t` an alignment of 16 on
x86_64 and aarch64 Linux and on x86_64 macOS, and 8 on arm64 macOS: at
least 8 on each. So the addon's `alloc` need not align by hand (an
`assert(align <= 8)` states the contract).

## The binding's memory

The addon allocates almost nothing (bindings.md, section 6):

- **Rows in core's `ta_table`** (`tinyactors/table.h`, ADR 0012 decision
  5): a session (its chart and its `_event`'s string ids, 24 B; its
  scope is the element at the row's slot of one JavaScript array per
  host, no `napi_ref`), a chart (its compiled functions), a
  payload (its reference count, and an object's `napi_ref`; a primitive
  is the element at its row's slot of one array per host: measured,
  docs/allocation.md, finding 3b), a `<foreach>`, a pending
  typed method (its handlers). The tables grow
  through the host's allocator and are freed once with the host. Keep
  handles, never row pointers across a `ta_table_add`. The addon writes no
  table of its own.
- **Images are bytes:** `ta_host_add_image` copies them during the call,
  so a caller's `ArrayBuffer` (transferable, resizable, shared) is read
  once and never held; free a compile result at once. No image rows, no
  `SEGMENT_FREED` bookkeeping.
- **One `ta_growable_arena` per host, a mark per call** (ADR 0012
  decision 5). Made with the host, freed with it,
  its chunks kept. Each call takes a mark at entry and releases to it at
  exit, on every path. It holds the call's CBOR (a config, a typed
  method's params, a payload for quickjs, `encode`: a `ta_cbor_writer`
  over the arena's `ta_allocator` view), the call's text (the copy
  Node-API forces, below) and input structs. JavaScript running during a
  call (a getter, `toJSON`) may call the `Host` again: the nested call
  allocates above the outer one and releases to its own mark.
- **An arena keeps at most its cap between calls** (2026-10-17,
  docs/allocation.md, finding 7): every release goes through
  `ta_napi_arena_release`, and a release that empties the arena (the
  outermost call's) frees its chunks when it keeps more than 256 KB (a
  host's arena) or 64 KB (the environment's, `encode`, `decode`,
  `Address`, `compileCharts`, of 16 KB chunks as a host's); below the
  cap the chunks stay and a warmed call calls no allocator. A release
  nested in a call or in a run (a datamodel's document, a `sendMany`
  slice) is uncapped, and so is the datamodel's scratch (txml's
  high-water, below). Without the cap one 2 MB `encode` kept 6.5 MB for
  the process's life and one 2 MB send to quickjs 6.4 MB for the host's
  (the arena keeps a writer's earlier blocks as it grows); with it the
  next call allocates one chunk again. Test: `test/host.test.mjs: 'one
  2 MB send leaves the host arena under its cap'` (16 hosts: about 100
  MB resident kept before, at most 21 MB after).
- **Views of what core and JavaScript hold.** Bytes come from a typed
  array's data (`napi_get_typedarray_info`, `napi_get_arraybuffer_info`),
  for the call. Text is the one copy Node-API forces: it is written as
  UTF-8 into the call's arena (`napi_get_value_string_utf8`), and read again
  as UTF-16 only when `EF BF BD` appears, to refuse a lone surrogate. What
  the host hands out is a view until the ack (above). Core's values are
  read with `ta_cbor_reader` as they stream.
- **The datamodel's scratch arena, a mark per parse** (decided
  2026-10-17, docs/allocation.md): an XML parse's tree (txml's blocks,
  about 1.7 MB in 13 blocks even for a small document) lives for the
  parse only, so txml allocates from a `ta_growable_arena` of the native
  datamodel (`native->scratch`, over the host's allocator, its chunks kept)
  above a mark released when the tree is read; its frees are nothing. A
  warmed parse calls no allocator: 1,000 parses made 13,006 blocks before
  and none after, and an event that assigns XML content went from 447-503
  us to 15 us on bun (21-23 us before and after on node), at the cost of
  the high-water mark kept for the host's life once a chart parses XML.
  txml's input window is 4096 B (a larger document streams through it),
  66 KB less of that mark at no cost; its arenas' chunk stays txml's
  64 KiB default, since a 4096 B chunk saved 787 KB more but made each
  parse 14 % slower on node and 27 % on bun, all of it txml setting its
  string pool's directory, `max_document_bytes` / chunk entries, at every
  parse (docs/allocation.md, finding 8). Test: `test/datamodel.test.mjs:
  'XML content larger than the parser\'s 4 KB input window is read whole'`.
- **The datamodel's last output.** `to_wire`, `serialize`,
  `payload_serialize` and the strings handed back to core (`eval_string`,
  `log`) are written with a writer the datamodel keeps, overwritten by its
  next call: the one buffer kept between calls, because Node-API gives no
  view of a string.
- **Payloads are copied, not encoded,** between the API and the native
  datamodel; CBOR only toward quickjs and for bytes that leave the
  process.
- **Statuses are named by core:** a bare status in a message is
  `ta_status_name(status)` (`"TA_ERROR_STATE"`), never a table of ours.
- **Where the allocator is called:** in the host's create and free, in
  the allocator (`src/module.c`, with `napi_adjust_external_memory`) and
  the environment's instance that holds it, and through core
  (`ta_table`, `ta_growable_arena` while it grows, the compiler's
  options, the datamodel's scratch arena for txml); nowhere else, nothing
  per event or per evaluation. The lint rule `allocation-in-tables-and-host`
  checks it. The module's own calls (`encode`) have no host: they use an
  arena of the environment's instance, a mark per call, as a host's
  calls use the host's.

## C rules

- **At most three parameters** for every C function this addon defines or
  declares, static helpers and callback types included (root
  `AGENTS.md`, "At most three parameters"). A function whose signature a
  typedef fixes is exempt by that typedef, not by name:
  `napi_threadsafe_function_call_js` (four parameters), `ta_allocator`'s
  two, and, should a rule grow, `napi_callback` and `napi_finalize`.
  `tools/lint/utils/fixed-signature.yml` lists them by their parameter
  types; add a typedef there, with its header and line, before a function
  it fixes fails the rule.
- **Bytes are `ta_bytes` in and `ta_buffer *` out**, never a pointer and a
  length, in every function (`buffers-are-ta-buffer`).
- **No serialization on the hot path** (root `AGENTS.md`): spawn, send,
  send_many, terminate, deliver, advance_time, resume, run, the effects
  and their ack take and give C structs. CBOR is for `ta_host_post`, the
  config and bytes that leave the process.
- **Acronyms** are all capitals or all lowercase (root `AGENTS.md`,
  "Acronyms"): `ta_napi_otlp_writer`, `TA_NAPI_IO_...` in C;
  `sessionID`, `OTLPExporter`, `ioProcessors` in JavaScript and
  TypeScript.
- **Layers**, each an ast-grep rule:
  - `extension-calls-core-and-node-api`: `src/` calls core (`ta_*`,
    `TA_*`), Node-API (`napi_*`, `node_api_*`, `NAPI_*`) and a short list
    of C library functions (memory, strings, and `malloc`, `calloc`,
    `realloc`, `free` for the host's allocator), nothing else: no libuv
    (`uv_*`; Bun has none) and no V8. A C library function the addon needs
    joins the list with its reason, in the commit that first calls it.
  - `datamodel-calls-environment-and-node-api`: `src/datamodel/` calls of
    core only `ta_datamodel_environment_*`, `ta_image_*` (the chart's
    expressions, read at `chart_attach`), `ta_cbor_*` (`to_wire`,
    `from_wire`), `ta_table_*`, `ta_growable_arena_*` (its scratch
    arena), txml's `txml_*` (XML content, "The native datamodel"), and our
    own `ta_napi_*`; never the host or the system (`datamodel.h`: "they
    must never call ta_system_* functions"). It reaches `node:vm`
    through `process.getBuiltinModule`, a JavaScript call made with
    Node-API, not V8's C++ API.
  - `one-timer-in-loop`: the global timers (`setTimeout`, `setInterval`,
    `setImmediate` and their clear functions) appear in `src/loop.c`
    only.
- **No mutable globals** (`no-mutable-globals`): no global and no static
  local the addon writes. The module is initialized once per environment
  (the main thread and each worker), and a `napi_value` or `napi_ref` of
  one environment means nothing in another, so state lives in the
  environment's instance data (`napi_set_instance_data`) or on the
  `Host`. A constant is a `const` object (`static const char *const
  names[]`, `static const napi_type_tag`; `static const char *p` is a
  mutable pointer). Arrays of `napi_property_descriptor`, the tables
  `napi_define_class` takes, are exempt by type.
- **One thread per host:** a host belongs to the environment (main thread
  or worker) that made it; record it and refuse calls from others. A
  `Host` posted to a worker arrives as a plain structured clone, which the
  type tag refuses (spike, 2026-10-16), so the recorded environment is an
  assertion.

## Values

- **The value table** is `tinyactors-core/docs/protocol.md`, "Values",
  with JavaScript's side in `docs/values.md`: numbers checked with
  `Number.isSafeInteger` and `BigInt` beyond (ids are always `BigInt`:
  `napi_get_value_int64` saturates silently; a session an input takes
  may be a safe integer too), strings as valid UTF-8 (a
  lone surrogate refused, never replaced), `Uint8Array`, arrays, plain
  objects, `true`, `false`, `null`, `undefined`; **`encode` writes an
  `Address` as tag 32 and `decode` reads tag 32 as an `Address`**
  (2026-10-18, l-coord-encode-address, as Python's codec does), while
  **inside a chart's values an actor reference is its address string**
  (decided 2026-10-12, commit `20189bdc`): the datamodels read tag 32 as
  its text, as quickjs does, and an `Address` an input carries in its
  data is its text there, since neither of Node's datamodels has a
  reference type. The API's own address fields are `Address` values
  ("Other systems").
- **`encode(value) -> Uint8Array`** and **`decode(bytes) -> value`**
  expose the one conversion the API uses (`src/values.c`, streaming with
  `ta_cbor_writer` and `ta_cbor_reader`), each with its row in
  `docs/api-map.md` and typed in `index.d.ts`. What they cannot read or
  write is refused with an exception, never turned into a value. The
  adapter frames the driver's calls with them and imports nothing else;
  the binding's own value tests (against `values.txt`'s `ecmascript`
  lines) catch a value mapped wrong both ways.
- **Nesting is limited to 64**, which stops cycles but not a value that
  shares subtrees; the README says charts are trusted code.

## The native "ecmascript" datamodel

Decided 2026-10-16 (docs/plan.xml, decisions d-datamodel, d-declarations,
d-dom, d-separate):

- **Two ECMAScript datamodels, completely separate.** The native one uses
  the application's JavaScript objects in its own engine, as the
  `"python"` datamodel uses Python's; quickjs is the sandbox, for charts
  that are not trusted (`max_ops`, a bounded heap, its realms, passed
  through from the Host's option). They share no code or text and meet
  only in the suite they both pass. Both are named `"ecmascript"`, so a
  host holds one: `new Host(config, {datamodel: "native" | "quickjs"})`,
  and a host that names none gets `"native"`, the maintainer's exception
  to "no defaults of our own" ("it's what most people will expect").
- **Charts evaluate in `node:vm` contexts, never the application's
  realm.** One shared context per host's native datamodel holds the
  charts that declare nothing at the top of their scripts; each of their
  sessions is a scope object inside it. A chart whose scripts declare
  top-level names (`var`, `function`, `let`, `const`, `class`) gets a
  context per session, where a script runs as global code and closures
  work (about 143 KB a session on node, 60 KB on bun). Which charts
  declare is asked of the engine at `chart_attach` (the script after
  `throw 0;` in a scratch context: the global's new names, and a
  redeclaration error for lexical ones): the addon parses no JavaScript.
  Pre-declaring names on a scope and copying bindings out is refused: a
  script's functions close over its own `var`s.
- **A scope is shaped once per chart:** a per-chart constructor whose
  properties are, from the start, the `<data>` ids, the names a
  `<foreach>`'s item and index and a script's assignments bind, the
  session's link and `_event`, over a frozen prototype of null prototype
  holding the system variables as read-only accessors (V8 makes an
  `Object.create(null)` object a dictionary: 280 B against 56 to 64 B).
  `_event` is a non-writable data property redefined at each
  `bind_event`.
- **Expressions compile one at a time, lazily,** at their first
  evaluation, in the context's shape sloppy outer `with (scope)`, strict
  inner function, so an undeclared assignment throws and a syntax error
  is that evaluation's `error.execution`, not the chart's.
- **Values cross by copy, made with the receiving context's
  constructors** (an application's array is not `instanceof Array` in
  another realm); immutable values are shared. The application is a
  receiver too: a payload it reads is copied into its realm then (capture
  cannot know the receiver, `ta_datamodel_capture` has no target, and a
  payload made in the application's realm would be another realm's to the
  charts that receive it). As a neutral value (`to_wire`,
  `JSON.stringify`) an XML node is its XML text (`toJSON`).
- **XML content becomes a DOM through txml** (`tinyxml/include/txml.c`,
  compiled into the addon), built as JavaScript objects; Node and Bun have
  no `DOMParser`.
- **The system variables cost a session little until read.** A
  session's link holds its `_sessionid` and `_name` (the string of the
  session made before it when the text is the same) and its params until
  the first event; `_ioprocessors` is made at its first read and kept,
  from the context's template (the first session's processors, whose first
  location ends with its id) when a session's processors match it text
  for text, else from the session's own.
- **Hibernation writes the session out** (decided 2026-10-16, as the
  Python binding's "hibernation writes the session out"; docs/plan.xml,
  p2-hibernate). `serialize` writes the session's variables and its
  `_event` as one CBOR document through the value table, `{"vars": {name:
  value}, "event": [its eight fields, then core's ids of its name, invoke
  and origintype] | null}`, into the writer the datamodel keeps until its
  next call; core puts the bytes in the blob and calls `destroy`, which
  removes the row, so a hibernated session holds nothing in the engine.
  The ids live in the session's row (set at `bind_event`), not on the
  frozen `_event`. A shared chart's variables are its scope's own names
  but `_event`; a declaring session's are the names its chart and scripts
  put on its global (the realm's baseline and the system variables left
  out), and a name the chart's scripts declare as a function is left out
  while it holds a function: a top-level `function`, and one declared in a
  script of executable content, which runs as a sloppy block and so makes
  a var of the global (Annex B) that the script fills again at each run
  (found at `chart_attach` as the names a strict instantiation of the
  scripts, in a second scratch context, does not make). A script of
  executable content that starts with a `'use strict'` directive runs as a
  strict block (`'use strict';{ ... }`), since a block takes no
  directive. `deserialize` makes a new scope, or for a
  declaring chart a new context in which every script of the chart is
  instantiated again without running a statement (`throw 0;` ahead, the
  probe `chart_attach` already compiles, kept in the chart's record), so
  its function declarations exist again before the variables are copied
  in with the context's constructors. A chart whose scripts declare with
  `let`, `const` or `class` refuses (`TA_ERROR_UNSUPPORTED`): a new
  context cannot be given those bindings again (a binding instantiated
  and never run stays in its TDZ). A value outside the table (a function,
  a `Map`, a `Date`, a class's instance, an XML document) refuses too, and
  the datamodel keeps why (the variable's name and the value table's
  message) for `host.hibernate`'s error, as quickjs's `last_error` does.
  The payloads of the session's pending delayed sends and waiting events
  stay in the payload table. `payload_serialize` writes the value table's
  CBOR (`TA_ERROR_UNSUPPORTED` outside it; `to_wire` keeps
  `TA_ERROR_INVALID`), and `payload_deserialize` reads as `from_wire`.
- **Migration writes the session out too** (decided 2026-10-16, as the
  Python binding's; docs/plan.xml, p2-migrate). A migration's export is
  `serialize`, with `payload_serialize` for the payloads of the actor's
  pending delayed sends, so what hibernation refuses a migration refuses
  (the actor fails and stays on its version). `deserialize` keeps every
  variable of the blob in the session's link as its `init`, where a
  spawn's params wait, until the first event or `migrate` takes it, as
  Python's `row->extra` holds them (no field in the session's row: the
  link is the session's already). `migrate` answers them, exactly the old
  chart's variables, as one payload copied into the shared context; on a
  declaring session's global it also deletes the names the blob added
  that the new chart's declarations did not make (`restore` keeps them on
  the link as `added`). The new chart's scripts are instantiated in the
  new context, not run: a `var` they declare is there, `undefined`, and
  core initializes the new chart's added `<data>`.
- **Snapshots write every row out** (decided 2026-10-16, as the Python
  binding's "Snapshots of the datamodel"; docs/plan.xml, p2-snapshot).
  `host.snapshot()` checks quiescence first (`ta_host_snapshot` with an
  empty buffer: `TA_ERROR_STATE` from a handler, with an effect or a reply
  pending, or during a migration, before any state is built), then packs
  (`ta_host_snapshot_pack`, labelled `tinyactors-napi`) one CBOR map of
  the host's one datamodel: `{"quickjs": bytes}`
  (`ta_datamodel_ecmascript_snapshot`, written into room for the last
  state's length and a quarter more) or `{"native": {...}}`, the session,
  payload and loop tables' handle namespaces (`ta_table_snapshot`) and
  every row: a session's chart by its attachment's segment and index
  (`ta_datamodel_chart.segment`, kept in the chart's row: two segments may
  run one image), its variables as hibernation writes them, its `_event`
  with core's ids, its link's `_sessionid`, `_name` and processors, its
  params and the names a wake added, a payload's value and references, a
  `<foreach>`'s items, each value as CBOR bytes of its own so a value
  nests as deep as in a send. What hibernation refuses the snapshot
  refuses (`TA_ERROR_UNSUPPORTED`, the message naming the variable), and
  the host goes on. `Host.restore` is a static method that makes the host
  through the constructor (the instance's `restoring`, taken at the
  constructor's entry), with `ta_host_snapshot_unpack`,
  `ta_host_snapshot_image` and `ta_host_restore` in place of
  `ta_host_create`; it reads the snapshot's bytes only after the config
  is written (a getter may run JavaScript) and copies them when they are
  not 8-aligned. Then, before anything runs, the datamodel: quickjs's
  `ta_datamodel_ecmascript_restore`, or the native tables' namespaces
  back (`ta_table_restore`) and every row filled at its handle, a row
  twice or one the tables do not hold refused, sessions made again as a
  wake makes them. The options' datamodel must be the snapshot's, and the
  effective config's `systemID` the pack's (`TA_ERROR_INVALID`). The
  clock goes on from the snapshot's time: the ticks it reads carry an
  offset (`ticks_offset`, mod 2^64) set at the restore, whatever clock
  reads them. A declaring session's globals are read by their names
  (`(0, eval)(name)` in its context), for hibernation, migration and
  snapshots alike: bun's vm context leaves a global's property stale after
  a function writes its `var` (spike, bun 1.4.1, 2026-10-16).
- **Measured cost per session** (`mise run measure`, 2026-10-17: x86_64
  Linux 6.18, Intel Xeon @ 2.10GHz, 4 CPUs, 16 GiB; node 22.23.3 with V8
  12.4, bun 1.4.1; 10,000 actors of a chart with three `<data>`, one of
  them a list, resident and idle; all four from one run, this machine's,
  not the Python binding's): bytes per actor

  | runtime, datamodel | resident | engine heap | region | after one event: resident | heap |
  |---|---|---|---|---|---|
  | node, native | 1188 | 197 | 287 | 1589 | 281 |
  | node, quickjs | 891 | 10 | 287 | 1363 | 11 |
  | bun, native | 1632 | 255 | 287 | 2602 | 345 |
  | bun, quickjs | 1195 | 24 | 287 | 1602 | 24 |

  The engine heap is node's `heapUsed + external` and bun's `heapSize +
  extraMemorySize` after a forced collection; quickjs's heap is its own
  malloc, in resident only. Resident varies between runs (bun's native
  1632 to 1919 B in three runs that day; heap and region do not). The Python binding measured 433 B resident
  on its `"python"` datamodel and 1104 B on quickjs on its own machine
  (`tinyactors-cpython/AGENTS.md`): not comparable with these, which are
  another machine's. A native session's heap is its scope (64 B on node),
  its link (60 B), its list, its `_sessionid` and its element of the
  host's `scopes` array (8 B); after one event its
  `_event` adds about 85 B. Resident above heap and region is the
  engine's, much of it a fixed cost the population amortizes: V8's young
  generation grows during the spawns (about 300 B an actor of
  `new_space` at 10,000), so at 40,000 the native datamodel is 747 B
  resident on node and 971 B on bun (`--actors 40000`, 2026-10-16).
  The region is sized up front here (`maxActors`); grown from the default
  size it grows only the pool that ran out, by a quarter of the region
  when that is at most 16 times the pool, and never shrinks (docs/allocation.md, finding 6, measured the
  doubling of every pool it replaced: 48,967,040 B at 40,000 actors
  against 10,415,192 B sized for them). The host's tables
  add a slot per row, the row and core's 8 B record: 32 B a session.
  **A session holds no `napi_ref`** (2026-10-17, docs/allocation.md,
  finding 3): node's is a `v8impl::Reference` and its global handle,
  about 96 B an actor of malloc (glibc's bytes in use, 160.4 B an actor
  with it, 63.9 B without, 52 to 65 B of either the session table), so
  the scopes are one JavaScript array per host at the row's slot and the
  row is 24 B. Before and after, three runs each of `mise run measure`:
  node native resident 1282, 1278, 1277 B and 1188, 1185, 1192 B (after
  one event 1647, 1679, 1720 and 1589, 1593, 1579), heap 189 and 197 B;
  bun native 2058, 2024, 2071 and 1632, 1661, 1919. Per event (the
  benchmark of 10,000 actors of `fit`, one event to each per round, the
  least of 40 rounds, pinned to one CPU, builds alternating, the mean of
  12 runs on node and 8 on bun): node 5.225 us before, 5.198 us after;
  bun 3.599 and 3.561. The array's read (`napi_get_element`) alone cost
  node 1 to 3 % an event in three such series (5.277 us against 5.225 in
  this one), since each entry reads its scope; the shared
  context, which only a compilation needs, is no longer read per entry,
  and that pays for it. Before the system
  variables were made lazy, an earlier run on this machine gave 356 B of
  heap on node and 448 B on bun (1565 B and 2135 B resident).

## Rules the suite cannot see, each with a test of its own

Each rule names the test that shows it (`file: 'case'`); every file runs
under node and bun, on both datamodels. Where a rule cannot be shown
through the public API, it says why. `test/rules.test.mjs: 'every rule in
AGENTS.md names tests that exist'` checks each name below against its
file.

- **Dropping a payload's last reference can run JavaScript** (a
  finalizer), and core calls `release` outside a run too (the ack,
  `ta_host_free`, posts, deliver), where it holds the run's rules. Defer
  the last drop to a list emptied after the outer call into core returns
  (bindings.md, section 8). Tests: `test/rules.test.mjs: 'a payload whose
  last reference goes is let go after the call: its value is collected'`
  (native; quickjs's payloads are quickjs's). The deferral itself cannot
  be seen: neither runtime runs JavaScript when a reference is deleted (a
  `FinalizationRegistry` callback is a task of its own), so the test shows
  that what the drops hold goes at the flush.
- **Handles are `ta_table` handles** with a generation: a stale one is
  refused, never a pointer. Tests: `test/rules.test.mjs: 'rows are
  handles: a slot reused under a new generation gives each session and
  payload its own'`; `test/methods.test.mjs: 'a typed method answers its
  own handle: a second method from onResult is answered too'` (a pending
  row's slot reused); `test/host.test.mjs: 'terminate ends an actor; a
  session that is gone is refused'`. A stale id in a reply cannot be made
  through the API (the addon posts every id), so its refusal is code
  only (`ta_napi_reply`: `ta_table_get`, NULL dropped).
- **Expressions are compiled once, lazily, as a strict function inside
  `with (scope)`**, so an undeclared assignment throws and a syntax error
  waits for its evaluation; `assign` checks the location as SCXML asks.
  Tests: `test/datamodel.test.mjs: 'the scope refuses an undeclared
  assignment, a system variable and _event'` and `'a syntax error is its
  own evaluation's error.execution: the chart's other expressions run'`.
- **One handle scope per vtable entry:** a run is one native call, so
  handles opened by the entries would pile up until it returns
  (`napi_open_handle_scope` around each entry). No test: handles live
  outside the engine's heap and neither runtime bounds them, so a missing
  scope changes nothing JavaScript can read (no failure, no counter). The
  code shows it: every entry that makes a value opens a frame
  (`ta_napi_frame_open`, through `ta_napi_enter_entry` in
  `src/datamodel/datamodel.c`), the entries that only drop a row go
  through `ta_napi_native_drop`, which opens its own, and the drain opens
  one per effect (`ta_napi_dispatch`), the resolver one per call.
- **Reference counts live in the row,** with an object payload's
  `napi_ref` (a primitive payload's value is the element at its row's slot
  of one array per host, no `napi_ref` and no box), deleted at zero (`napi_delete_reference` takes a `node_api_basic_env`:
  Node.js 22's `include/node/js_native_api.h:339, 355`), so the host's
  finalizer and the environment's teardown free a host with basic-env
  calls only, and skip the last take. Tests: `test/rules.test.mjs: 'a
  dropped host with rows (charts, sessions, payloads) is collected and
  frees them in its finalizer'` and `'a worker that ends with its hosts
  open frees them at its teardown, with no call of JavaScript'`;
  `test/compile.test.mjs: 'a compile result never closed is freed by its
  finalizer'`.
- **Handler closures make cycles:** handlers are kept reachable from the
  `Host`'s own JavaScript object (a property under a private symbol), not
  by strong `napi_ref`s, so a dropped host whose handlers close over it is
  still collected. Tests: `test/host.test.mjs: 'a dropped host whose
  handlers close over it is collected and frees its memory'` and `'the
  handlers are the wrapper's, under a symbol, and go at close'`.
- **`napi_type_tag_object` on every wrapped object,** so a method called
  on the wrong object is refused rather than misread. Node refuses a
  prototype method on another receiver itself (V8's signature check,
  "Illegal invocation"), Bun leaves it to the tag ("not a Host"): a
  `TypeError` on both. Tests: `test/host.test.mjs: 'a method on another
  object is refused by the type tag'`; `test/loop.test.mjs: 'idle() on
  another object is refused by the type tag'`; `test/rules.test.mjs: 'a
  SimulatedClock's methods on another object are refused by its type
  tag'`; `test/effects.test.mjs: 'views are made by the host only'`;
  `test/address.test.mjs: 'refusals: not a string, not called with new, a
  getter on another object'`; `test/compile.test.mjs: 'a compile result is
  made by the compile calls only'`. A thin view (a `Send`, a `LogEntry`) is
  not wrapped: its state is an array under the instance's `view` symbol,
  which another object lacks, so its getters and methods refuse it. Code
  that takes that symbol off a real view (`Object.getOwnPropertySymbols`)
  and rewrites the state can misread an effect of the host's but never
  memory: core bounds every index (`ta_host_effect_number`, `_text`) and
  payloads are handles with a generation.
- **A `Host` posted to a worker arrives as a plain object** (a
  structured clone: the wrap and the tag do not cross), which every
  method refuses; the environment the host records is then an assertion
  no input reaches. Test: `test/rules.test.mjs: 'a Host posted to a worker
  arrives as a plain object, which every method refuses'`.
- **One drain at a time and an ack before every run:** a test that a
  handler's typed method is answered in the next take, and that outputs
  read in a handler stay valid after later calls in the same batch.
  Tests: `test/methods.test.mjs: 'a typed method called from a handler is
  answered in a later take, after the ack'`; `test/rules.test.mjs:
  'outputs read in a handler stay valid across the later calls of its
  batch'`; `test/effects.test.mjs: 'a send view: each field read on first
  access and cached, valid until the ack'`.
- **A thin view read after its ack throws** `TA_ERROR_STALE`. Tests:
  `test/effects.test.mjs: 'a view read after its ack throws
  TA_ERROR_STALE; what was read stays'`, `'a view kept and used from a
  bare timer is stale there'` and `'a log entry not read in its handler
  is stale after the ack'`; `test/migration.test.mjs: 'the Migrated view:
  fields on first read, stale after the ack'`; `test/compile.test.mjs: 'a
  first read of the image after close() throws TA_ERROR_STALE'`.
- **Marks nest** (a nested call leaves the outer call's arena memory
  intact). Tests: `test/rules.test.mjs: 'marks nest in the host's arena:
  an input whose data's getter calls the host keeps its own texts'`;
  `test/values.test.mjs: 'marks nest: a getter that encodes leaves the
  outer value intact'` (the module's arena) and `'a getter that throws:
  its error, the arena released'`; `test/methods.test.mjs: 'a getter of
  params may call the host again: both methods are answered'`.
- **An output taken with no batch open opens a batch of its own,
  acknowledged at once; from a handler it joins the open one** (a
  hibernation blob, `metrics()`), tracked by a flag from a take to its ack,
  never by the call depth; and a drain stops at its bound before a take, so
  no batch stays open between turns. Tests: `test/hibernation.test.mjs:
  'hibernate from a call inside a call outside a turn leaves no batch
  open'`, `'hibernate from a handler joins the open batch'` and
  `'hibernate between turns ends no effect undispatched'`. A blob whose
  copy into a `Buffer` fails is woken back from the view before the ack;
  no input makes `napi_create_buffer_copy` fail, so that path is code only
  (`ta_napi_host_output` in `src/host.c`).
- **A hibernated native session holds nothing in the engine**, and what
  the value table cannot hold keeps it resident. Tests:
  `test/hibernation.test.mjs: 'native: a hibernated actor holds nothing in
  the engine; its values come back with the blob'`, `'native: a Map, a
  class instance, a Date or an XML document in a variable keeps the actor
  resident'` and `'a value outside the table keeps the actor resident, and
  the error names the variable'`.
- **A snapshot is refused before any state is built when the host is not
  quiescent, and a restored host's snapshot is the same bytes.** Tests:
  `test/snapshot.test.mjs: 'a snapshot from a handler is refused'`, `'a
  snapshot with a reply pending is refused'`, `'a snapshot during a
  migration is refused'` and `'the snapshot of a restored host is the
  same bytes'`; a restore refuses what is not its own:
  `test/snapshot.test.mjs: 'restore refuses another system's config,
  another datamodel, another program's pack'`. A row twice or one the
  tables do not hold needs a pack whose datamodel state was rewritten
  with its label kept; no API call makes one, so that refusal is code
  only (`ta_napi_restore_session`, `ta_napi_restore_other` in
  `src/datamodel/datamodel.c`).
- **Invoked services are the wrapper's and outlive the ack.** The
  running services are kept in a `Map` on the handlers object the wrapper
  holds, so a dropped host whose services close over it is collected, and
  at close they are dropped, not stopped; an `Invocation` is a record that
  answers after the ack until the invocation ends. Tests:
  `test/services.test.mjs: 'a dropped host whose running services close
  over it is collected'`, `'services left at close are dropped, not
  stopped, and collected'`, `'a handler that returns a promise of the
  service: what comes while it starts is given to it in order'`, `'an
  UNINVOKE while it starts stops the service once it resolves; the sends
  before it are dropped'`, `'a promise that settles after close, or after
  the invocation was cancelled, tells nobody'`, `'a service done in its handler is neither
  kept nor stopped'` and `'an async receive reads its send after the ack;
  its rejection is a crash'`; failures that reach the invoker:
  `test/services.test.mjs: 'a handler that throws is a communication
  error; a send to it fails too, until the UNINVOKE'`, `'a handler's
  promise that rejects is a failed start: the invoker and each queued
  send are told'`, `'a failure to
  start an invocation cancelled in the same run is not reported to the
  invoker'`, `'a restore without the service tells the invoker, and
  throws nothing'` and `'no service for the type is a communication error
  for the invoker, and nothing is thrown'`.
- **Sweep and wake refuse numbers out of range**, never wrapped. Test:
  `test/hibernation.test.mjs: 'sweep, hibernate and wake refuse numbers out
  of range'`.
- **Pending handlers are dropped at `ta_host_free`**, never called.
  Tests: `test/methods.test.mjs: 'pending handlers are never called after
  close; a method on a closed host throws'`; `test/rules.test.mjs: 'a
  worker that ends with its hosts open frees them at its teardown, with
  no call of JavaScript'` (a pending method at the teardown).
- **Text is valid UTF-8: a lone surrogate is refused, never replaced.**
  Tests: `test/values.test.mjs: 'text: U+FFFD itself is text, a pair is
  text, a lone surrogate is not'`; `test/host.test.mjs: 'send refuses
  what it cannot take, and keeps nothing of it'` (an event's name).
- **A session an input takes is a bigint from 1 to 2^64-1 or a number
  that is a safe integer from 1** (decided 2026-10-17, l-coord-decisions:
  `Number.isSafeInteger`, so no number that lost bits past 2^53 reaches
  core, and `napi_get_value_int64`, which saturates silently, is never
  used): `send`, `fail` and `send(message)`'s target, `terminate`,
  `hibernate`, `wake`, `migrate`'s `session` and `Address.fromSession`, in
  one function (`ta_napi_session_of`); typed methods' params go to core as
  given, where a safe integer is CBOR's integer as a bigint is. 0, 0n, a
  negative, a fraction, a number past 2^53-1, a bigint past 64 bits or
  another type is a `TypeError`, and a value's bigint past 64 bits
  `TA_ERROR_INVALID`. What the API gives back (`spawn`, `actorByName`,
  `sweep`, a view's `session`) stays a bigint. Tests:
  `test/rules.test.mjs: 'sessions are bigints from 1 to 2^64-1 or safe
  integers from 1, never a number that saturates'` (a value's bigints
  too); `test/values.test.mjs: 'integers: numbers to 2^53-1, bigints
  beyond, both ways'`.
- **Refusals no input reaches.** `TA_RUN_EXHAUSTED` comes only when the
  host's allocator refuses a pool's growth and `TA_RUN_FAULT` only from a
  run with a batch open (which the drain before every run rules out) or a
  segment that cannot grow past core's limits (millions of actors); a
  typed method's `TA_ERROR_STATE` at the post needs JavaScript inside a
  run, which no chart reaches (it gets no application object), and
  `TA_ERROR_NO_MEMORY` an allocator that refuses. The addon adds no test
  hook (no allocator that fails on demand), so these paths are code only
  (`ta_napi_turn_error` in `src/loop.c`, `ta_napi_typed` in
  `src/methods.c`).
- **The README says** chart code is trusted (a `vm` context is not a
  security boundary; untrusted charts belong on quickjs), that a pending
  deadline keeps the process alive while the host is open (bindings.md,
  section 11), that a handler's error ends the process by default, and
  that `using` needs a runtime that parses it (bun 1.4 does, node 22 does
  not); and (decided 2026-10-17, l-coord-decisions) that a chart whose
  scripts declare with `let`, `const` or `class` keeps its sessions
  resident, that the charts of a host share the builtins of its shared
  context; and its services guide (`docs/guide/services.md`) that a
  service handler returns the service or a promise of it, with the
  pattern of a service whose methods await its own start.
  Tests: `test/rules.test.mjs: 'the README says what no test can
  show: charts are trusted, deadlines keep a process alive, errors end
  it, using'` and `'the services guide says a handler returns the
  service, or a promise of it'`; `test/liveness.test.mjs: 'a pending deadline keeps the
  process alive until it comes'` and `'close() lets a process with a
  pending deadline exit'`; `test/loop.test.mjs: 'a handler's error, with
  no idle() waiting, is thrown from the turn's callback; the host goes
  on'`.

## What not to build

- No synchronous request, no raw `post`, no request facade: typed methods
  take response handlers in the direct layer; no synchronous driver.
- No eager conversion of an effect: a thin view, and a record only where
  a value must outlive the ack. No global configuration.
- No re-reading `ta_host_effects` until stable, no consumed marks, no
  nested drain, no ack inside a handler.
- No copy of a host output before the next call (it lives until the ack).
- No handle table, status table, arena or image rows of our own
  (`ta_table`, `ta_status_name`, `ta_growable_arena`, `ta_host_add_image`
  copies).
- No application callback for `DONE` or `ERROR`; no subscription.
- No defaults, limits, methods, events or messages of our own (the one
  exception, the maintainer's: a host that names no datamodel gets the
  native one); nothing C
  does done again in JavaScript (bindings.md section 2); no JavaScript
  above the addon but the convenience layer, over the addon's exports
  only ("Layers and the resolver").
- No serialization on the hot path, no struct layout read from
  JavaScript, no libuv, no V8's C++ API, no JavaScript parser of our own.

## Tasks

`mise.toml` pins node and bun, which run the package, and pnpm, which
manages its development dependencies; the C toolchain is the root's.

- `mise run build`: core's amalgamation into `build/core`
  (`mise run //tinyactors-core:amalgamate -- --out build/core`), the only
  core task this project's tasks run, never core's build; the addon
  compiles against it with `Toolchain::Target` (root
  `mise/lib/toolchain.rb`; never a compiler from `PATH`, never `$CC`).
  `Target#plugin` links a loadable module, and `Toolchain::ObjectFormat`
  already allows a Node-API addon's undefined `napi_*`.
- `mise run lint`: the rules' tests, the rules over `src/` and `lib/`, the adapters'
  lint (`mise run //tinyactors-test:lint -- conform.mjs`: the adapter
  imports only `@tinyactors/node` and `node:` built-ins),
  `docs/api-map.md` against core (`mise/lib/api_map.rb`), `index.d.ts`
  against every example of the README and the guides and the cases of
  `test/types` (`tools/typecheck.mjs`, with the `tsc` of
  `mise.toml`'s `npm:typescript`), and the root's
  checks on this project's files: the build scripts' portability and
  acronyms.
- `mise run conform [-- runner options]`: the suite against
  `conform.mjs`, with `--kind binding`, under node and under bun, each on
  the native datamodel and on quickjs (both must pass); `-- --milestone
  <M>` runs one of the suite's sets (`tinyactors-test/suites/milestones.txt`).
- `mise run test`: lint, build, both runtimes, and the suite's set named
  by `MILESTONE` in `mise/napi.rb` once the adapter exists. Its `#MISE
  sources` list this project's files, core's and the suite's. An
  exhaustive test goes behind `--full` (root `AGENTS.md`).
- `mise run measure [--actors N]`: bytes per actor at a population of
  one chart (`tools/measure.mjs`), resident and idle and after one event
  each, on both datamodels under both runtimes, each in a process of its
  own, with the machine's signature; it writes `build/measure.json`. A
  measurement, not a test: `mise run test` does not run it.
- `mise run stress [--actors N] [--resident R] [--events E]`: the
  hibernation gate (`tools/stress.mjs`): N actors of a counter, at most R
  resident, the rest in the runtime's SQLite (`node:sqlite` under node,
  `bun:sqlite` under bun), E events to actors drawn at random, a sample's
  counts checked, on both datamodels under both runtimes. `mise run test`
  runs 20,000 actors with 100 resident; `mise run test --full` two million
  with 1000.
- `mise run migration [--actors N] [--resident R] [--events E]`: the
  migration gate (`tools/migration.mjs`): the same population of a
  counter's version 1, at most R resident, moved to version 2 with
  `migrate({wake: true})` while E events come, the migration's WAKEs woken
  a batch at a time; every sampled count and version checked, none left
  behind, version 1's segment retired. `mise run test` runs it as
  `stress`'s fast and full sizes.
- `mise run snapshot [--actors N] [--resident R] [--events E]`: the
  snapshot gate (`tools/snapshot.mjs`): the same population of an order
  chart, at most R resident, E events and a delayed send for every
  resident actor; the snapshot to a file and the store copied (`VACUUM
  INTO`); a copy restored with its own store and clock, whose own
  snapshot must be the same bytes, migrated to version 2 with E more
  events, its clock run past the delayed sends; the live host goes on
  with E events of its own; every sampled count, delayed send and version
  checked on both hosts, and the live store holding only the live host's
  blobs; half the resident actors pay through an invoked service at the
  snapshot, which the copy starts again on a stand-in that declines each
  payment while the live host's real service is never stopped. `mise run
  test` runs it at `stress`'s sizes and with 5,000 actors all resident;
  `--full` two million with 1000 and 100,000 all resident.
- `mise run services [--actors N] [--events E]`: the services gate
  (`tools/services.mjs`): N actors each invoking a counter service the
  application runs, E round trips to actors drawn at random, then a third
  done with done data, a third cancelled (stopped), the rest kept; every
  pong, done datum, stop and collected service checked, on both
  datamodels under both runtimes. `mise run test` runs 10,000 actors and
  50,000 round trips; `--full` 200,000 and 1,000,000.
- `mise run scale [--actors N] [--resident-actors R]`: the scaling gate
  (`tools/scale.mjs`) against accidentally quadratic work: every
  operation of the API timed on a host of N actors and on one of 2N, each
  in a process of its own, with most of the actors hibernated in the
  runtime's SQLite (and N/100 of them running an invoked service, so
  core's requests grow too), then with every actor resident (R and 2R when
  given). An operation's cost at 2N, per call or per actor for the
  operations on the whole population, must be within `FACTOR` (1.5) of
  its cost at N, the median of five samples of at least 200 ms each, an
  operation over it measured again, with another seed, before it fails
  (a sweep of every actor timed from memory, a snapshot less the
  kernel's page faults: README.md, "Scale"); an operation in
  `KNOWN` grows because of core and names its request to core, reported
  as failing and not failing the task. `mise run test` runs it as
  `test/scale.test.mjs` at 20,000 and 40,000 actors (all resident: 40,000 and 80,000; samples of 20 ms,
  four attempts); `--full` and `mise run scale` at two and four million.
  Its numbers are in README.md, "Scale".
- `mise run examples [name...]`: the example applications
  (`examples/<name>/`, each a README, a `main.mjs` and a `test.mjs`
  written with `node:test`), each test under node (`node test.mjs`) and
  bun (`bun test <path>`), every directory with a `test.mjs` unless it
  keeps a task of its own (`NodeAPI::EXAMPLES_ELSEWHERE` in
  `mise/napi.rb`: remote-python). `mise run test` runs them all.
- `mise run remote-python [--test] [--rounds N]`: two systems in two
  processes (`examples/remote-python/`): a Python host of
  `tinyactors-cpython`, built by that project's own `mise run build`
  (about a minute cold, under a second when up to date), and a Node host
  talking over a TCP connection in length-prefixed CBOR frames of JSON-RPC
  notifications; it prints the conversation, or with `--test` runs the
  example's test under node and bun on both datamodels, as `mise run test`
  does (so the Python binding's sources are among its sources).
- `mise run pack [target...]`: the npm packages (`mise/pack.rb`; root
  `docs/adr/0001`, decisions 10, 11, 14 and 15), at HEAD's development
  version (`Release.dev_version`: package.json's is the last release's,
  which the registry has). One addon per native release target
  (`aarch64-macos`, `x86_64-macos`, `x86_64-linux`, `aarch64-linux`),
  built with the root's zig (`Toolchain::Target.release`, `-g0`: zig cc
  writes debug information by default, and the Mach-O linker then records
  each object's path and time in the addon), checked by its symbols (for
  its target, loads no library, exports `napi_register_module_v1` and
  `node_api_module_get_api_version_v1` only, leaves undefined only
  Node-API and `Pack::LIBC`), each in `@tinyactors/node-<os>-<cpu>`
  (`os` and `cpu`, no `libc`), and the main package (package.json's
  `files`: `index.mjs`, `lib/`, `index.d.ts`, README, LICENSE,
  `docs/guide/` and `docs/values.md`, so the README's relative links
  resolve after an install, which `test/links.test.mjs` checks) listing them as `optionalDependencies` at
  exactly its version; packed with the pinned `npm pack` into
  `build/packages/`, the same bytes for the same commit. This machine's
  tarballs are installed by path into a fresh project outside the
  repository, with npm for node and with `bun add` for bun, and
  `tools/smoke.mjs` runs there with `LD_BIND_NOW=1`. `lib/direct.mjs` loads
  `build/tinyactors.node` first and the platform package after, whose
  version must be its own: Bun, run where no `node_modules` is, installs
  a package it cannot resolve from the registry (the last release's
  addon).
  The same task packs **`@tinyactors/wasm`** at the same version
  (`mise run pack:wasm` packs it alone; docs/browser.md, "Packaging and
  releases"): the module (`wasm:build`, its imports and exports
  checked), `wasm/index.mjs`, `wasm/init.mjs`, `wasm/init.d.ts` and
  `wasm/lib/` (the generated `realm-script.mjs` included) at the
  package's root, `lib/convenience.mjs` beside its direct layer with
  `#direct` written as `./direct.mjs` (a page and a module Worker read no
  package.json, and a Worker has no import map), `index.d.ts` (`types`),
  `wasm/README.md`, LICENSE; exports `.`, `./init`, `./tinyactors.wasm`
  and `./package.json`, with no export condition. Every tarball's
  `package.json` must hold the one version. It prints the package's
  sizes (packed, unpacked, the module raw, gzip -9 and brotli 11) and is
  smoke-tested from fresh projects: `tools/smoke-wasm.mjs` (with
  `tools/smoke-wasm-check.mjs`) under node and bun through both entries,
  and `tools/smoke-wasm-browser.mjs`, the npm project served to Chromium
  under the guide's policy, a page importing by the package's name
  through an import map and a module Worker by path.
- `mise run status`: where the work stands after a cloud container was
  rebuilt (the agents running in it stop; git, `docs/plan.xml` and
  `docs/log.xml` survive): the checkout against `main`, the uncommitted
  files by project (an agent's unfinished work), the plan's unfinished
  steps and the log's open entries. It changes nothing. The cloud
  environment's setup script installs mise and every project's tools in a
  fresh container.
- `mise run release -- <version> [--publish] | --dev [--publish]`: the
  checks (a clean tree, the version, the changelog, npm, the test task),
  the version committed and tagged `tinyactors-napi/v<version>`, every
  package built and smoke-tested here (the wasm package under node,
  bun and in Chromium) and, with Docker, the addon in Node.js
  (Debian, Alpine) and Bun containers of each Linux architecture,
  `SHA256SUMS`, into `build/dist/<version>/`; with `--publish`, `npm
  publish` with fnox's `NPM_TOKEN` (platform packages first), then the
  root's `Release.push_and_release!`: the push, a snapshot of
  `tinyactors-napi/` pushed to tinyactors-dev/tinyactors-napi tagged
  `v<version>`, and the GitHub release there (root `docs/adr/0016`).
  `--dev` publishes HEAD under the `next` dist-tag only. A publish that
  stopped keeps its commit, tag and files: `--resume` publishes exactly
  those and pushes, and the root's `mise run release:mirror --
  tinyactors-napi/v<version> --assets tinyactors-napi/build/dist/<version>`
  finishes one whose tag is pushed. `--build-only` builds and checks
  only. `package.json`'s `repository` names the monorepo (its `directory`
  `tinyactors-napi`), as root `docs/adr/0016` says package metadata does:
  the source, the issues and the pull requests are there; its `homepage`
  is the release repository's README, tinyactors-dev/tinyactors-napi.

The adapter imports the package by its name, `@tinyactors/node`, which
resolves to this directory through `package.json`'s `exports`; its lint
refuses a path. A spike (2026-10-12) showed node v22.23.2 and bun 1.4.1
(this project's pins) both resolve it.

## Commits and the changelog

Commit subjects are the changelog's input (root `AGENTS.md`, "Releases
and changelogs"): scope `napi` (`feat(napi): ...`), `!` for a breaking
change with a body that says what a caller does. The package continues
the release line of `@tinyactors/node` (tags `tinyactors-napi/v*`, last
0.2.0), so every `feat`, `fix` and `refactor` lands in its next
changelog.

## Code search, static checks and design claims

- **ast-grep for code search and rewrites** (`ast-grep run -p ... -r
  ...`), `rg` only for plain text. Invoke `ast-grep`, never `sg`. A new
  static check is an ast-grep rule in `tools/lint/rules/` with its test in
  `tools/lint/tests/`.
- **Design claims are checked** with the reasoned-analysis skill: a
  scenario in this design, evidence (`path:line`, a primary source or a
  spike) or the word unverified, and a refutation by a fresh agent before
  a finding changes the design, the guide or a request to core.

## Gaps in core

This project never patches `tinyactors-core` or the suite
(`tinyactors-test`), and works around nothing in them. A gap is a request
to core in [ROADMAP.md](ROADMAP.md): what is missing, why, and which
suite case or test shows it. The addon waits for the change.

## Layout

The Python binding has the same files on purpose, and the two are
compared file by file.

```
README.md, CHANGELOG.md, mise.toml, package.json, sgconfig.yml
ROADMAP.md           the work in progress: plan, progress, how it runs, requests to core
index.mjs, index.d.ts   the package: both layers' exports; the types
lib/direct.mjs       the direct layer: loads the platform's .node and re-exports it
lib/convenience.mjs  the convenience layer: JavaScript over lib/direct.mjs only
docs/api-map.md      each API item → ta_* function, method or effect (checked)
docs/values.md       the JavaScript side of the value table
src/                 addon.h, module.c, host.c, loop.c, effects.c, methods.c, values.c,
                     datamodel/{datamodel.c, rows.c, expressions.c}
conform.mjs          the suite's adapter, over the public API only
test/                what the suite cannot see: liveness, workers, GC, refusals
tools/lint/          rules/, tests/, utils/ (ast-grep)
tools/measure.mjs    bytes per actor, node and bun, native and quickjs (mise run measure)
tools/stress.mjs     hibernation under load, the rest in SQLite (mise run stress)
tools/migration.mjs  live migration under load, the rest in SQLite (mise run migration)
tools/snapshot.mjs   a deploy rehearsed on a restored copy of a live host (mise run snapshot)
tools/services.mjs   invoked services under load (mise run services)
tools/scale.mjs      every operation at N and 2N actors, its cost within a factor (mise run scale)
tools/store.mjs      what the gates share: the SQLite store, a seeded generator
tools/parity.mjs     the parity check: both packages' shapes (tools/shape.mjs) compared, and each against index.d.ts
mise/napi.rb         what the tasks share
mise/pack.rb         the packages: the release build per target, its checks, npm pack, the smoke tests
mise/tasks/          build, test, conform, lint, measure, stress, migration, snapshot, services, scale, pack (and pack:wasm), wasm:*, release
tools/smoke.mjs      the packages' smoke test, run where they are installed
tools/smoke-wasm*.mjs  @tinyactors/wasm's: node and bun, and Chromium (a page, a module Worker)
examples/            applications over the package, each with a README and a test (mise run examples);
                     order-fulfillment/: payment and shipping as invoked services, timeouts, retries, cancels
                     http-gateway/: node:http sessions as actors, rate limits, an async I/O processor, OTLP export
                     chat-rooms/: rooms and users as actors, most hibernated in a file store, a bounded resident set
                     subscription-billing/: a live population migrated to a new chart version while it bills
                     turn-game/: a game server snapshotted to disk, killed, restored, its journal replayed
                     iot-rules/: customers' alert rules in the quickjs sandbox, one host per rule, hostile uploads reported
                     document-approval/: parallel reviews, history, donedata, XML records, an admin view on the typed methods
                     inventory-sync/: a warehouse and a storefront as two systems over a socket, compensation, idempotent requests
                     job-scheduler/: recurring and one-shot jobs on the real clock, retries, deadlines, drift, a graceful shutdown
                     elevator-control/: a bank of cars, parallel regions, In(), deep history, invoked door controllers, generated scenarios
                     remote-python/: a Python host and a Node host over a socket (mise run remote-python)
build/               core's amalgamation and the addon (not in git)
```
