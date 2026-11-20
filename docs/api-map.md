# The mapping table: the JavaScript API and core

Each item of `@tinyactors/node`'s API next to what core has behind it
(tinyactors-core/docs/bindings.md, section 2: "An item with no core
function behind it does not belong"). Written before the item, in the
same commit, and kept in step with `index.d.ts`.

**The rule:** every row's Core cell names, in backticks, at least one of

- a function of core's API descriptions
  (`tinyactors-core/include/*.api.json`): `ta_host_send`;
- a constant of them: an effect (`TA_EFFECT_LOG`, `TA_HOST_EFFECT_PEER`),
  a run status (`TA_RUN_IDLE`), a flag;
- a request method of `tinyactors-core/docs/requests.md`: `actor.context`;

and nothing else in backticks. `mise run lint` checks it
(`mise/lib/api_map.rb` at the repository root): a name core does not have
fails. Say in Notes how the item uses them: the turn, a request, the
handling of an effect.

A core function no item uses is listed below the table: used internally
(say where) or not exposed (say why).

A row marked *planned* is an item the plan (`docs/plan.xml`, section
api) calls for, written ahead so its core is checked and the API review
sees it; the commit that adds the item removes the mark. `index.d.ts`
declares every row, planned or not; `index.mjs` exports the items
built so far: the direct layer's (`lib/direct.mjs`, the addon's
exports) and the convenience layer's (`lib/convenience.mjs`, JavaScript
over the direct layer's exports only). Names the plan left open were picked when the
rows were written (log entries `l-p0-map-*`, for the maintainer).

| API item | Core | Notes |
|---|---|---|
| `compileCharts(sources, {resolver, warningsAsErrors}?) → Compiled` | `ta_compile_charts`, `ta_compile_diagnostics`, `TA_DIAGNOSTIC_ERROR`, `TA_DIAGNOSTIC_WARNING`, `TA_COMPILE_WERROR`, `ta_image_open`, `ta_image_expression`, `ta_image_chart_source` | the compiler's call; `sources` an array of `{name, text}`, the first the default boot chart; `resolver` the compile-time resolver, the only place a resolver is given; `warningsAsErrors` is `TA_COMPILE_WERROR`; an option of another name throws `TypeError`; an error throws `CompileError` with every diagnostic, the result freed first; then every expression and script of an `"ecmascript"` chart of the image is parsed by `new vm.Script` in the shape the native datamodel evaluates it in (nothing runs), a syntax error a diagnostic (code 0) at the expression's element's line and column, a script's own line within it: a warning, or with `warningsAsErrors` an error that throws `CompileError` |
| `compileSystem(manifest, {resolver, warningsAsErrors}?) → Compiled` | `ta_compile_system`, `ta_compile_diagnostics`, `TA_DIAGNOSTIC_ERROR` | a `<system>` manifest (`{name, text}`): its charts, read through `resolver`, and the boot actors `host.boot` spawns; the same options, `Compiled` and `CompileError` as `compileCharts` |
| `compiled.image`, `compiled.diagnostics` | `ta_compile_image`, `ta_compile_diagnostics` | `image` a `Buffer` copied once from the result on first read (`napi_create_buffer_copy`) and cached, the application's from then on; a first read after `close()` throws `TinyactorsError` with `TA_ERROR_STALE`; `diagnostics` the warnings and notes, converted once |
| `compiled.close()`, `compiled[Symbol.dispose]()` | `ta_compile_free` | frees the result and removes its wrap; a second call does nothing; the finalizer as a fallback; a copy of `image` already read lives on with the collector (no export count: nothing holds the result's memory) |
| `CompileError`, `Diagnostic` | `ta_compile_diagnostics`, `TA_DIAGNOSTIC_ERROR`, `TA_DIAGNOSTIC_WARNING`, `TA_DIAGNOSTIC_NOTE` | a `TinyactorsError` (status `TA_ERROR_INVALID`) whose message is the first error as a compiler prints it, `file:line:column: error: message` (as Python's), and whose `diagnostics` are every diagnostic: `severity` (`"error"`, `"warning"`, `"note"`), `code`, `file`, `line`, `column`, `message` |
| `resolver(base, source) → string`, `new ResolveError(message, {line, column}?)` | `ta_compile_charts`, `ta_compile_diagnostics` | any callable, as `ta_compile_options.resolve`, given to the compile calls only (a static `src` at compile time); a `ResolveError` becomes a diagnostic of the resolved file at its line and column, the message's UTF-8 in the compilation's scratch arena; a `SyntaxError` is not converted (no JavaScript is compiled at resolve time); any other error is thrown from the compile call after the result is freed |
| `compileDir(dir, {resolver}?) → Compiled` | `ta_compile_charts`, `ta_compile_diagnostics` | the convenience layer (JavaScript over `node:fs`, `node:path` and `node:url`, no C): every `*.scxml` file under the directory `dir` (a path or a `file:` URL, resolved through its links once), named by its path under it with `/`, sorted by name (the first the default boot chart), its text UTF-8 (a fatal `TextDecoder`), compiled by `compileCharts`; a file whose real path leaves `dir`, a `dir` that is no directory or holds no chart throws `InvalidError`; a `src` no file of the list answers is read by a resolver confined to `dir`, relative to the directory of `base`: a path that leaves it (`..`, an absolute path, a symbolic link pointing outside, checked on the path as written and on its real path), a file that does not exist and text that is not UTF-8 throw `ResolveError`, which the compile call reports as a diagnostic of the resolved file; another error of the file system is thrown as it is; `resolver` replaces that one |
| `new Host(charts, options)`: `system`, `ioProcessors`, `config`, `clock`, `store`, `resident`, `log`, `telemetry`, `services`, `transport`, `onDone`, `onError`, `onHandlerError`, `migrated`, `migrationDone`, `datamodel`, `quickjs` | `ta_host_create`, `host.config`, `ta_host_add_image`, `ta_datamodel_ecmascript_new`, `ta_datamodel_ecmascript_binding` | the convenience layer's `Host` (`lib/convenience.mjs`), a subclass of the direct layer's (the addon's class, `(config, options)`, not exported): `config` (a plain object; `systemID` and `ioProcessors` in it a `TypeError`, since `system` and `ioProcessors` make them) with `systemID` from `system` (a string; `"tinyactors-ask"` reserved, a `TypeError`) and `ioProcessors` from the option's types and their `location`s, as CBOR in the host's arena for `ta_host_create`; a refused config throws `TinyactorsError` with core's error; then `charts` (a `Compiled`, image bytes, or an array of them) added in order by `ta_host_add_image`, segments 0, 1, ...; `host.config` posted once at creation for `system.ticksPerSecond` and the I/O processors' indices; `datamodel` `"native"` (the default, the maintainer's exception) or `"quickjs"`; `quickjs` the sandbox's limits, refused on a native host; an unknown option, a handler that is not a function, or a processor that is not an object with a `receive` method throws `TypeError` naming it; the handlers kept on the Host's own object under a symbol, never by a strong reference |
| `options.ioProcessors`: `{[type]: {receive(send), location?}}` | `ta_host_create`, `TA_EFFECT_SEND`, `TA_EFFECT_FIELD_IO_PROCESSOR`, `ta_host_send`, `TA_EVENT_IN_ERROR_COMMUNICATION` | each type an I/O processor of the config, in the object's order (`IO_PROCESSOR` `i + 1`), with its `location`; the handling of an effect: `receive` called on the processor (`this` the processor) with `send`, a thin view until the ack (a read after it throws `TA_ERROR_STALE`); its `data` on the native datamodel copied into the application's realm at its first read, an XML node as its text; a `receive` returning a thenable has its view filled with every field before the ack, and its `answer()` and `fail()` work while the host lives; one that throws, or whose promise rejects before an answer, has its send failed |
| `host.system` | `host.config` | the system id the host was made with (`options.system`), read once at creation |
| `options.quickjs`: `{maxOps, memoryLimit, stackLimit, realm}` | `ta_datamodel_ecmascript_new`, `TA_DATAMODEL_ECMASCRIPT_REALM_AUTO`, `TA_DATAMODEL_ECMASCRIPT_REALM_ISOLATED` | the sandbox's limits, passed through as `ta_datamodel_ecmascript_config`'s `max_ops`, `memory_limit` (bytes), `stack_limit` (bytes) and `realm` (`"auto"` or `"isolated"`), each absent field core's default (0: `max_ops` 1,000,000, `memory_limit` `TA_DATAMODEL_ECMASCRIPT_MEMORY_LIMIT_DEFAULT`, 1 GiB); given with `datamodel: "native"` it throws `TypeError` at creation |
| `host.quickjsHeapBytes` | `ta_datamodel_ecmascript_heap_bytes` | the quickjs engine's heap in bytes, read on each access (O(1)), for an operator watching a sandboxed host against `memoryLimit`; `undefined` on a native host and on a closed one |
| `host.ticksPerSecond`, `host.closed` | `host.config`, `ta_host_free` | read once at creation; whether the host was freed (as Python's) |
| `host.close()`, `host[Symbol.dispose]()`, `host[Symbol.asyncDispose]()` | `trace.end`, `ta_host_traces`, `ta_host_logs`, `ta_host_effects_ack`, `ta_host_free` | frees the host (`ta_host_free`), its tables and its datamodel, and drops the handlers; a second call does nothing; the stop of bindings.md section 4: the timers cleared, a waiting `idle()` rejected with `TA_ERROR_STATE`, and with a telemetry handler and an encoder `trace.end` ends the open spans and the last take (bounded: 64 batches of at most 64 takes per signal; inputs from the handler allowed, its `close()` deferred, its error thrown once the host is freed) goes to it; pending response handlers dropped, never called; from a handler, deferred to the end of the turn; `asyncDispose` also awaits the promises the last take's handlers returned |
| `host.addImage(image) → number` | `ta_host_add_image` | any `Uint8Array` or `ArrayBuffer` (`compiled.image`, a `.tai` file read), copied by the host during the call; returns the segment |
| `host.chart(name) → ChartRef`, `ref.segment`, `ref.chart` | `ta_host_chart` | the current version of chart `name`: a frozen object of its segment and chart index, which `spawn` takes |
| `host.boot(segment)` | `ta_host_boot` | the segment's boot actors (`<system><actor>`s, or the first chart compiled), each under its name |
| `host.spawn(chart, {name, params, traceparent}?) → Actor` | `ta_host_chart`, `ta_host_spawn` | an input, applied at the call, the clocks advanced first; `chart` a chart's name (its current version, `ta_host_chart`) or a `ChartRef` (any object of `segment` and `chart`); `params` a payload of the chart's datamodel, moved on success, released on refusal; `traceparent` W3C text, its UTF-8 for the call, parsed by core; returns an `Actor` of the session (the convenience layer wraps the direct call, which returns the `bigint`) |
| `host.actor(which) → Actor` | `ta_host_actor_by_name`, `ta_host_locate`, `ta_actor_info_get`, `ta_address_parse` | the convenience layer over the direct layer's hidden calls: `which` a session (a `bigint` or a safe integer), an `Actor`, a name (`ta_host_actor_by_name`, newest segment first) or an address of this system (a string or an `Address`: its session or its name; another system's an `InvalidError`); a live actor (`ta_host_locate` and `ta_actor_info_get` in the direct layer's `actorInfo`, which also gives the chart's name and whether it is hibernated) or `StaleError` |
| `host.actors({chart}?) → Promise<Actor[]>` | `actor.list`, `ta_host_post`, `TA_HOST_EFFECT_REPLY`, `ta_actor_info_get` | the convenience layer: every page of `actorList` (512 a page), each session an `Actor`, those of another chart left out (the chart's name read by `actorInfo` at the reply) |
| `Actor`: `actor.id`, `actor.host`, `actor.address`, `actor.send(event, data?, options?)`, `actor.terminate()`, `actor.state()`, `actor.context()`, `actor.get()`, `actor.equals(other)` | `ta_host_send`, `ta_host_terminate`, `ta_address_format`, `actor.state`, `actor.context`, `actor.get` | the convenience layer: a frozen value of a host and a session (a `bigint` from 1 to 2^64-1), made where the API returns an actor (`spawn`, `actor`, `actors`, `send.sender`, `onDone`), holding nothing in the host; `address` `Address.fromSession(host.system, id)`; its methods the host's calls with its session (`host.send`, `host.terminate`, the typed methods as promises); `equals` the same host and session; every call that takes a session takes an `Actor` (the direct layer reads its `id`) |
| `actor.done → Promise` | `TA_EFFECT_DONE`, `TA_EFFECT_ERROR`, `TA_EFFECT_FIELD_PAYLOAD` | the convenience layer over the direct layer's `done` and `error` hooks: settled when the actor, spawned by the host, ends at a top-level final state (with its donedata) or is ended by a fault (rejected with a `TinyactorsError`); one ended already rejects with `StaleError`, a closed host `StateError`; one waiter per session, kept until it ends |
| `options.onDone`: `(actor, donedata) => ...`, `options.onError`: `(actor, error) => ...` | `TA_EFFECT_DONE`, `TA_EFFECT_ERROR`, `TA_EFFECT_FIELD_PAYLOAD` | the handling of an effect (before core's own release of the session's rows): a top-level actor ended at its final state, `donedata` its value (copied as `send.data` is), or by a fault; called in the turn, after its `actor.done` settled; a promise it returns is followed as a handler's |
| `options.onHandlerError`: `(error, effect) => void` | `TA_EFFECT_SEND`, `TA_EFFECT_LOG`, `TA_EFFECT_INVOKE`, `TA_HOST_EFFECT_MIGRATED` | where a handler's error goes (a processor's `receive`, `transport`, `log`, `telemetry`, a service's handler or `receive`, `migrated`, `migrationDone`, `onDone`, `onError`, a store's call, a typed method's handler): called with it, and with the view or record the handler was given (`undefined` for others), instead of rejecting `idle()` or throwing from the turn; a promise's rejection likewise; what it throws itself is the turn's error |
| `actor.ask(event, data?, {signal}?) → Promise<[event, data]>` | `ta_host_send`, `TA_EFFECT_SEND`, `TA_EFFECT_FIELD_TARGET`, `ta_address_parse` | the convenience layer over the direct layer's hidden `askOpen` and `askClose`: a row of the pending `ta_table` (method `TA_NAPI_METHOD_ASK`, in `@tinyactors/wasm` a marked row of its pending table) holds the ask's settle function, and the event is sent with `origin` `tinyactors://tinyactors-ask/@<handle>` (the reserved system); a send to that address reaches the transport's dispatch, which the layer intercepts before the application's `transport`: its row taken (a stale handle dropped) and the promise settled with the reply's event and data; `signal` aborts it (the row removed, the promise rejected with the signal's reason); pending at `close()`, it never settles |
| `options.store`: `{save, load, delete}`, `options.resident` | `TA_EFFECT_WAKE`, `TA_EFFECT_FIELD_MIGRATION`, `ta_host_sweep`, `ta_host_hibernate`, `ta_host_wake`, `ta_system_stats_get` | the convenience layer over the direct layer's `wake` and `idle` hooks: at a WAKE the session's blob is loaded (`load(session)`, or the promise it returns), woken (`ta_host_wake`) and deleted, a pending save of it waited for first; a migration's WAKE waits while `resident` actors are in memory (`residentCount`: each segment's actors less its hibernated, `ta_system_stats_get`); after each turn that went idle, the actors past `resident` hibernated (CLOCK sweeps of 1024, `ta_host_sweep`, then `ta_host_hibernate`; an actor not at rest or holding a value outside the table stays) and saved (`save(session, blob)`; a save that throws or rejects wakes the actor back from its blob, which stays resident until a later turn), then the waiting migration WAKEs loaded while there is room; a store's error is a handler's; `resident` without a `store` is a `TypeError` |
| `new MemoryStore()`, `store.blobs` | `ta_host_hibernate`, `ta_host_wake` | the convenience layer: a store over a `Map` of session to blob, for tests; `load` of a session it lacks throws `StaleError` |
| `new SQLiteStore(path)`, `store.database`, `store.close()` | `ta_host_hibernate`, `ta_host_wake` | the convenience layer: a store in the table `tinyactors_blobs (session INTEGER PRIMARY KEY, blob BLOB)` of an SQLite file (WAL, `synchronous=NORMAL`), through the runtime's own SQLite (`node:sqlite`'s `DatabaseSync`, `bun:sqlite`'s `Database`) reached by `process.getBuiltinModule`, synchronous, the session as a signed 64-bit key; a runtime without either throws `UnsupportedError` |
| `new Spawner()` | `ta_host_chart`, `ta_host_spawn`, `ta_host_send` | the convenience layer: an I/O processor whose `receive` spawns the chart a send names (`{chart, name, params}`) and answers `spawned` with `{name, address}` and its sendid, or fails the send (`error.communication`) when the host refuses the spawn or the data is not such an object |
| `host.send(target, event, data?, {sendid, traceparent, origin}?)`, `host.send(message)` | `ta_host_resolve`, `ta_host_send` | an input, applied at the call; `target` a session (a `bigint`, or a number that is a safe integer from 1), or a local address (a string or an `Address`) core resolves first; `data` a payload of the target session's datamodel; `traceparent` parsed by core (none, or text that does not parse: a new trace); `origin` another system's sender (a string or an `Address`); `send(message)` takes the fields of an object `send.message` gave (`target`, `event`, `data`, `sendid`, `origin`, `traceparent`), ignoring other keys; options other than `sendid`, `traceparent` and `origin` throw `TypeError`; data a chart whose datamodel takes none throws `TypeError`; what `actor.send` does for a client outside the process, so it has no typed method |
| `host.fail(target, sendid?)` | `ta_host_resolve`, `ta_host_send`, `TA_EVENT_IN_ERROR_COMMUNICATION` | an input: a send the transport could not deliver, reported to its sender (a session, or its local address as a string or an `Address`) with the sendid; core raises `error.communication` in the sender |
| `host.sendMany(items) → number` | `ta_host_send_many` | inputs, applied at the call; each item an object of `host.send(message)`'s fields, the `ta_event_in` array in the call's arena; returns the length of the accepted prefix; handed to core in slices of 256, so the arena holds a slice, not the array; an item that cannot be converted throws, the slices before it sent |
| `host.terminate(session)` | `ta_host_terminate` | an input, applied at the call; a session an input takes is a `bigint` from 1 to 2^64-1 or a number that is a safe integer from 1 (`send`, `fail`, `terminate`, `hibernate`, `wake`, `migrate`'s `session`, `Address.fromSession`), anything else a `TypeError` |
| the turn, with no driver; `await host.idle()` | `ta_host_effects`, `ta_host_effects_ack`, `ta_host_advance_time`, `ta_host_run`, `TA_RUN_IDLE`, `TA_RUN_YIELDED`, `TA_RUN_EFFECTS`, `TA_RUN_EFFECTS_FULL`, `TA_RUN_EXHAUSTED`, `TA_RUN_FAULT` | the event loop drives every host: an input outside a turn schedules one turn (`setImmediate`, one pending), a turn at its bound (64 runs of 10000 fuel, a drain of 64 batches) yields the same way, an idle turn arms one ref'd `setTimeout` at the deadline (at most 2^31-1 ms; the Host its argument), replacing the last; both clocks before every run, and after it with an encoder; `idle()` a promise settled at the next idle turn, the same to every caller until then, rejected with the turn's first error (an exhausted pool as `TinyactorsError` with `TA_ERROR_NO_MEMORY` naming the pool, a fault as `TinyactorsError` with its status) or with `TA_ERROR_STATE` by `close()`; it settles only while no promise a handler returned is pending (each followed with `then`, counted on the host, a turn scheduled when the count reaches zero with an `idle()` waiting; the last take's at close is `asyncDispose`'s, not counted); with none waiting the error is thrown from the turn's callback, after the next turn is scheduled or the timer armed; on a closed host a promise rejected with `TA_ERROR_STATE` |
| `host.now()` | `ta_runtime_now_ns` | the host's clock as it reads now (`ta_runtime_now_ns`, or a `SimulatedClock`'s time), plus a restored host's offset, in milliseconds at `system.ticksPerSecond`; advances nothing; a closed host throws `TA_ERROR_STATE` |
| `host.nextDeadline` | `ta_host_run`, `TA_RUN_IDLE` | the last idle run's next deadline as milliseconds from now on the host's clock; `undefined` for none (`UINT64_MAX`) |
| `new SimulatedClock()`, `clock.increment(ms)`, `clock.now` | `ta_host_advance_time`, `ta_host_run` | a clock in milliseconds (nanoseconds inside, exact) given as `options.clock`, its time the host's monotonic and wall clocks: `increment` (a number, not negative; `RangeError` otherwise) moves it and schedules a turn on every open host made with it, turning nothing itself; it holds the hosts weakly (`WeakRef`); such a host arms no timer; `options.clock` that is not one throws `TypeError` |
| `options.transport`: `(send) => ...` | `TA_EFFECT_SEND`, `TA_EFFECT_FIELD_IO_PROCESSOR`, `TA_EVENT_IN_ERROR_COMMUNICATION` | the handling of an effect: a send to another system's address (`IO_PROCESSOR` 0, the SCXML processor), as for an I/O processor, `send.type` `undefined`; a send to the reserved system `tinyactors-ask` is an ask's reply and never reaches it; without a handler each such send is failed |
| `send.host`, `send.session`, `send.sender`, `send.event`, `send.target`, `send.sendid`, `send.data`, `send.type`, `send.origin` | `ta_host_effect_number`, `ta_host_effect_text`, `TA_EFFECT_FIELD_SESSION`, `TA_EFFECT_FIELD_EVENT`, `TA_EFFECT_FIELD_TARGET`, `TA_EFFECT_FIELD_SENDID`, `TA_EFFECT_FIELD_PAYLOAD`, `TA_EFFECT_FIELD_ORIGIN`, `ta_datamodel_ecmascript_payload_to_cbor` | fields read on first access and cached; `host` the view's host (readable after the ack too); `sender` the sending session as an `Actor` (the convenience layer's getter); `data` the native row's value itself, or quickjs's payload decoded; `origin`, and the transport's `target`, an `Address`; `type` the processor's type from the config (`undefined` for the transport); `target` and `sendid` `undefined` when empty; a read after the ack throws `TA_ERROR_STALE` |
| `send.traceparent` | `ta_host_effect_text`, `TA_EFFECT_FIELD_TRACEPARENT` | the sending step's trace, formatted from the effect's binary context on first read; `undefined` when untraced (empty text) |
| `send.answer(event, data?, {traceparent, origin, raw}?)` | `ta_host_send`, `ta_host_locate` | to `SESSION`, with the send's `sendid`, `origintype` the processor's type, and the send's trace unless `traceparent` is given (`null`: a new trace); `origin` (a string or an `Address`) and `raw` are `ta_event_in`'s, and core gives the receiver an `origintype` only with an `origin`; once only: a second answer or a fail after it throws `TA_ERROR_STATE`; `true` when delivered, `false` when the sender ended (`ta_host_locate` refuses it, or `ta_host_send` gives `TA_ERROR_STALE`), any other refusal thrown |
| `send.fail()` | `ta_host_send`, `TA_EVENT_IN_ERROR_COMMUNICATION`, `ta_host_locate` | with the send's `sendid` and `send.traceparent`; core raises `error.communication` in the sender; recorded, so a later rejection fails nothing again; `true` when delivered, `false` when the sender ended, as `answer` |
| `send.message` | `ta_host_effect_text`, `TA_EFFECT_FIELD_ORIGIN`, `TA_EFFECT_FIELD_TRACEPARENT` | the send's outgoing half as an object, the value `host.send(message)` takes on the other side: `target` (an `Address` for the transport), `event`, `data`, `sendid`, `origin` (an `Address`), `traceparent`; a text field the send lacks (`sendid`, `origin`, `traceparent`) is `null`, as in the Python binding's message, so encoded it is absent to every binding |
| `options.log`: `(entry) => void`, `entry.host`, `entry.session`, `entry.label`, `entry.text` | `TA_EFFECT_LOG`, `ta_host_effect_text`, `ta_host_effect_number`, `TA_EFFECT_FIELD_AUXILIARY` | the handling of an effect; `entry` a thin view until the ack (`label` from `AUXILIARY`, `text` from `EVENT`), `host` its host; without a handler the line is discarded, no console default |
| `host.actorState(params, onResult, onError?)` | `actor.state`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method: `params` an object passed to core as given (`undefined` for none; anything else core refuses in the reply), the clocks advanced and a turn scheduled; `onResult(result)` at the `REPLY`'s dispatch in a later drain, the result converted once; `onError(error)` (or `null`/absent with an `onResult`: the error rejects the turn's `idle()`) with a `TinyactorsError` of `code`, `reason`, `path` and `message`, no `status`; never a param; returns nothing; the message id is a pending row's handle (`ta_table`), read from the reply in C, a stale one dropped; a refusal at the call (`TA_ERROR_NO_MEMORY`, `TA_ERROR_STATE`) throws and leaves nothing pending; pending handlers are dropped, never called, at `close()` |
| `host.actorContext(params, onResult, onError?)` | `actor.context`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.actorList(params, onResult, onError?)` | `actor.list`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.actorGet(params, onResult, onError?)` | `actor.get`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method; its result's `timers[].due`, core's host ticks, converted to milliseconds on `host.now()`'s clock at the dispatch (`ta_napi_milliseconds`; in `@tinyactors/wasm`, `ta_web_host_milliseconds`) |
| `host.hostStats(params, onResult, onError?)` | `host.stats`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.hostConfig(params, onResult, onError?)` | `host.config`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.traceConfigure(params, onResult, onError?)` | `trace.configure`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.traceWatch(params, onResult, onError?)` | `trace.watch`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method; the host's clock advanced before the post (a watch ends at a time of it) |
| `host.traceUnwatch(params, onResult, onError?)` | `trace.unwatch`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.traceEnd(params, onResult, onError?)` | `trace.end`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.traceSpansDecode(params, onResult, onError?)` | `trace.spans.decode`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | a typed method |
| `host.actorState(params?) → Promise`, and so for each typed method | `actor.state`, `ta_host_post`, `TA_HOST_EFFECT_REPLY` | the convenience layer (`lib/convenience.mjs`, JavaScript, no C): given no handler (`onResult` absent, `onError` absent or `null`), the method returns a promise over its direct call with a result handler that resolves and an error handler that rejects with the `TinyactorsError` `onError` gets (`code`, `reason`, `path`), so a reply's error never reaches the turn: without a `catch` it is an unhandled rejection; a refusal at the call (a closed host, another object) rejects too; still pending at `close()`, it never settles; given handlers, the call goes to the direct method as it is (one argument check and one call more, a few nanoseconds against microseconds of the post), and an `onError` without an `onResult` is its `TypeError`; each wrapper keeps the direct method's `name` and `length` |
| the types of the config and the results (`index.d.ts`): `HostConfig`, `EffectiveHostConfig`, `SessionParams`, `ActorStateResult`, `ActorContextResult`, `ActorListParams`, `ActorListResult`, `ActorGetResult`, `PendingSend`, `HostStatsResult`, `TraceConfigureParams`, `TraceWatchParams`, `TraceWatchResult`, `TraceUnwatchParams`, `TraceSpansDecodeParams`, `TraceSpansDecodeResult`, `EmptyResult`, `ReceivedValue` | `ta_host_create`, `host.config`, `host.stats`, `actor.state`, `actor.context`, `actor.list`, `actor.get`, `trace.configure`, `trace.watch`, `trace.unwatch`, `trace.end`, `trace.spans.decode` | types only, no code: the shapes core's config and replies have (host-config.md, requests.md), for `new Host`, `Host.restore`, each typed method's `params`, its `onResult` and its promise (`host.stats`'s `pools` an array, one entry per live segment); a count or session a number, a span's times `number` or `bigint`; data the host hands out (`send.data`, `invocation.data`, `decode`, variables, attributes) `ReceivedValue`, `any`, as `JSON.parse`'s; checked by the pinned tsc in `mise run lint` (`tools/typecheck.mjs`: every example of the README and the guides, and `test/types`)
| `options.telemetry`: `(signal, data) => ...` | `TA_HOST_EFFECT_TRACES`, `TA_HOST_EFFECT_LOGS`, `ta_host_traces`, `ta_host_logs` | the handling of an effect: the request taken when its effect comes and copied once into a `Buffer` (`napi_create_buffer_copy`), `signal` `"traces"` or `"logs"`, called in the turn; without a handler the request is taken and dropped, so the encoder goes on; its error is the turn's; a take the allocator refused is reported once and retried at the next turn; what it returns in the last take is awaited by `[Symbol.asyncDispose]` |
| `host.metrics() → Buffer` | `ta_host_metrics` | pulled when the application wants them, copied once; outside a drain its batch is acknowledged at once, from a handler it joins the open one; `TA_ERROR_STATE` without telemetry in the config |
| `host.sweep(maxScan, limit) → bigint[]` | `ta_host_sweep` | the CLOCK sweep: at most `limit` sessions that did not run since the previous sweep and can be hibernated now, scanning at most `maxScan` slots; each an integer from 0 to 2^32-1, anything else a `TypeError` |
| `host.hibernate(session) → Buffer` | `ta_host_hibernate`, `ta_datamodel_ecmascript_last_error` | the actor's blob copied once (a copy that fails wakes it back from the view first); outside a drain its batch is acknowledged at once, from a handler it joins the open one; `TA_ERROR_STATE` when the actor is not at a stable point, `TA_ERROR_UNSUPPORTED` for a value the datamodel cannot store, the message naming the variable on both datamodels |
| `host.wake(session, blob)` | `ta_host_wake` | the blob `hibernate` gave (a `Uint8Array` or an `ArrayBuffer`), read during the call; the actor's waiting events run at the next turn; with a `store` the host calls it itself at a WAKE |
| `host.migrate({chart, session, wake, timeout}?) → number` | `ta_host_migrate`, `TA_HOST_MIGRATE_WAKE` | starts a migration of every chart, of `chart` (a name) or of one `session` to the current version in later runs, hibernated ones asked for with `wake`, until `timeout` milliseconds of the host's clock (ticks, rounded up, counted from the clock advanced at the call; 0 or none: no timeout); returns core's id (a number); schedules a turn; an unknown option, a `chart` or `wake` of another type, a session that is neither a bigint from 1 to 2^64-1 nor a safe integer from 1, or a `timeout` that is not a number throws `TypeError`, an empty `chart` or a negative, NaN or infinite `timeout` `RangeError`, core's refusal `TinyactorsError` |
| `options.migrationDone`: `(result) => void` | `TA_HOST_EFFECT_MIGRATION_DONE`, `ta_host_migration_failed`, `ta_host_migration_pending` | the handling of an effect: `result` is `{migration, migrated, failed, pending}`, the failed sessions (a frozen array of frozen `{session, reason}`, `reason` the status's name) and the pending ones (a frozen array of `bigint`s) read at the dispatch into the host's arena; a handler of the host, so a restored host's migrations reach it; without one nothing is read |
| `options.migrated`: `(migrated) => void` | `TA_HOST_EFFECT_MIGRATED` | the handling of an effect: a thin `Migrated` view (`session`, `segment`, `chart`: its name, `migration`; `host` its host) per actor moved, until the ack; without a handler nothing is read |
| `host.snapshot() → Buffer` | `ta_host_advance_time`, `ta_host_snapshot_pack`, `ta_datamodel_ecmascript_snapshot`, `ta_table_snapshot` | the whole host as one blob labelled `tinyactors-napi`, written once into the `Buffer`: every segment, the images, the system id, the host's time (`ta_host_advance_time` first, so the time of the call) and the datamodel's state, a CBOR map of one key, `"native"` (the session, payload and loop tables' namespaces and every row, each value as CBOR bytes of its own, a session's chart named by its segment and index) or `"quickjs"` (its state's bytes); quiescence is checked first (`ta_host_snapshot` with an empty buffer): refused from a handler, with an effect or reply pending, or during a migration (`TA_ERROR_STATE`) before any state is built, and for a value outside the value table or a session of a chart whose scripts declare with `let`, `const` or `class` (`TA_ERROR_UNSUPPORTED`, the message naming the variable) |
| `Host.restore(snapshot, charts, options) → Host` | `ta_host_snapshot_unpack`, `ta_host_snapshot_image`, `ta_host_restore`, `ta_datamodel_ecmascript_restore`, `ta_table_restore`, `ta_host_add_image` | a static method: a new host made by the constructor with the options as `new Host`'s (the config made from them as there), running the snapshot (a `Uint8Array` or an `ArrayBuffer`, read once the config is written, copied when it is not 8-aligned); then each of `charts` whose bytes no segment of the snapshot holds (`holdsImage`: `ta_host_segment_info_get` and the image's bytes) added as `new Host` adds it; the datamodel's handles valid again before the first run (`ta_table_restore`, every row filled at its handle; a row twice or one the tables do not hold refused); `TA_ERROR_INVALID` for bytes that are no pack, a pack another program labelled, another datamodel's state, or a `system` that is not the snapshot's; its clock goes on from the snapshot's time, whatever clock reads it |
| `options.services`: `{[type]: (invocation) => service}` | `TA_EFFECT_INVOKE` | the handling of an effect: the handler of the `<invoke>`'s own type (`EVENT`) gets an `Invocation` record (`host`, `session`, `invokeid` from `SENDID`, `type`, `src` from `TARGET`, `data` from the payload, `traceparent`; the type, src and invokeid strings shared with the last invocation's when the text is the same), made before the ack, and returns the service, kept by (`SEGMENT`, `TOKEN`) in a `Map` on the Host's own handlers (gone at close: dropped, not stopped) unless it called `done`; a promise of the service makes the invocation starting until it settles: its sends (`IO_PROCESSOR` `TA_NIL`) made records before their ack and given to `receive` in order once it resolves, an UNINVOKE meanwhile its `stop` once it resolves (the sends before it dropped), a rejection a failed start (the invoker and each queued send told, with its sendid), between turns, never inside a run; no handler, or one that throws: `ta_host_send` with `TA_EVENT_IN_ERROR_COMMUNICATION` and `TA_EVENT_IN_FROM_INVOKE` to the invoker (none when an UNINVOKE of the same token follows in the batch) and the entry kept as failed until the UNINVOKE; a handler's error reported after the turn, no handler nothing thrown |
| `invocation.sendBack(event, data?, {traceparent}?)` | `ta_host_send`, `TA_EVENT_IN_FROM_INVOKE` | an event from the service to its invoker with the invocation's token and trace (`traceparent: null` a new one); `TA_ERROR_STALE` once it ended (done, cancelled, failed) or the host closed; `invocation.running` is false then |
| `invocation.done(data?, {traceparent}?)` | `ta_host_send`, `TA_EVENT_IN_INVOKE_DONE` | the service's end: `done.invoke.<invokeid>` with `data` for the invoker; the service is dropped, never stopped |
| `invocation.restored` | `TA_EFFECT_FIELD_FLAGS`, `TA_EFFECT_FLAG_RESTORED` | the INVOKE is a restored host's announcement of an invocation that was running at the snapshot; no handler for its type: `TA_EVENT_IN_ERROR_COMMUNICATION` to the invoker, nothing thrown |
| `service.receive(send)` | `TA_EFFECT_SEND`, `TA_EFFECT_FIELD_IO_PROCESSOR`, `TA_NIL` | the handling of an effect: a send with `IO_PROCESSOR` `TA_NIL` for the service of (`SEGMENT`, `TOKEN`), called on the service, as a thin `Send` view whose `type` is `undefined` (filled before the ack when it returns a promise); a service without `receive` or one done: dropped; to a service that failed or crashed: `ta_host_send` with `TA_EVENT_IN_ERROR_COMMUNICATION` and the send's sendid; a `receive` that throws, or whose promise rejects, is a crash: the same for the invoker, the service dropped, not stopped |
| `service.stop()` | `TA_EFFECT_UNINVOKE` | the handling of an effect: the invoker cancelled the invocation (it left the state, or ended), called on the service; none for one that failed or crashed; the service is dropped |
| `TinyactorsError` (`message`, `code`, `reason`, `path`, `status`) | `ta_host_post`, `TA_HOST_EFFECT_REPLY`, `ta_status_name` | an `Error` subclass, `new TinyactorsError(message, {code, reason, path, status}?)`, each field read-only and `undefined` when not given; a reply's error (`code`, `reason`, `path`, `message` as core wrote them), a refusal at a call, a fault, a stale view; `status` a bare status named by `ta_status_name` (`"TA_ERROR_STALE"`) |
| `StaleError`, `StateError`, `InvalidError`, `UnsupportedError` | `TA_ERROR_STALE`, `TA_ERROR_STATE`, `TA_ERROR_INVALID`, `TA_ERROR_UNSUPPORTED` | subclasses of `TinyactorsError`, defined by the same script, whose constructor makes the one of a status itself, and of a reply's code (-32001 stale, -32002 state, any other invalid): no call that throws chooses a class; made directly, each has its status |
| `encode(value) → Uint8Array`, `decode(bytes) → value` | `ta_cbor_writer_init`, `ta_cbor_reader_init`, `ta_cbor_read`, `ta_cbor_writer_bytes`, `ta_cbor_writer_free` | the one conversion the API uses, streaming, the writer and the call's text in an arena of the environment's instance, a mark per call; `undefined` and `null` distinct, integers beyond 2^53 `bigint`; an `Address` written as tag 32 on its text and tag 32 read as an `Address` (inside a chart's values an `Address` is its text, and tag 32 its address string); what it cannot read or write throws a `TinyactorsError` (`TA_ERROR_UNSUPPORTED` for a value outside the table, `TA_ERROR_INVALID` for one it cannot hold or malformed CBOR); `decode` takes a `Uint8Array` or an `ArrayBuffer`, anything else a `TypeError` (docs/values.md) |
| `new Address(text)`, `address.text`, `address.toString()`, `address.system`, `address.session`, `address.name` | `ta_address_parse`, `ta_address_name_decode` | immutable; the parts read by core's parser on each access, `session` a `bigint`, `name` decoded; `undefined` for a part the text lacks, or when the text is no address; `toString()` the text |
| `Address.fromSession(system, session)`, `Address.fromName(system, name)` | `ta_address_format`, `ta_address_format_name` | an `Address` made from its parts by core's formatter (the name percent-encoded; the session a `bigint` or a safe integer from 1, else a `TypeError`); a system id or name core refuses throws `TinyactorsError` with `TA_ERROR_INVALID` |
| `address.toJSON()` | `ta_address_parse`, `ta_host_resolve` | the convenience layer (JavaScript, no C, on the direct layer's `Address.prototype`): the address's text, so `JSON.stringify` writes an address as the string that `new Address(text)` parses and `host.send` resolves; calls nothing of core itself |
| `decodeTraces(bytes) → DecodedSpan[]` | `ta_otlp_next_span`, `ta_otlp_next_attribute`, `ta_otlp_next_value`, `ta_otlp_next_event`, `ta_otlp_next_link`, `ta_trace_id_format`, `ta_span_id_format` | no host: `src/traces.c` (language-free, compiled into the wasm package's module too) writes the spans as one CBOR array into the environment's arena, a mark per call, read with the value table; `traceSpansDecode`'s fields and `flags`, `links`, `resource`, `scope`; malformed bytes throw `InvalidError`, an argument that is not bytes a `TypeError` |
| `encodeHTTPPost({url, event, fields, body}) → Buffer` | `ta_http_encode_post` | SCXML's BasicHTTP (C.2.1): the POST request of a send, `fields` an array of `{name, value}` (or `body` when there are none), written into the call's arena and copied once; a URL that is not `http://host[:port]/path` throws `TA_ERROR_INVALID` |
| `parseHTTPRequest(message) → {method, target, body, event, fields}` | `ta_http_parse_request` | SCXML's BasicHTTP (C.2.2): an incoming request's event name (`_scxmleventname`, else `HTTP.<METHOD>`) and its decoded form fields, as strings, the scratch in the call's arena; a malformed request throws `TA_ERROR_INVALID` |
| the native `"ecmascript"` datamodel, `_event` | `TA_DATAMODEL_EVENT_DETACHABLE`, `ta_datamodel_environment_in`, `ta_image_chart_datamodel` | the vtable of `datamodel.h` in the application's engine: `node:vm` contexts (one shared per host, one per session for a chart whose scripts declare top-level names, as the engine says at `chart_attach`), a scope per session made by its chart's constructor over a frozen prototype of the system variables, expressions compiled one at a time at their first evaluation (sloppy `with`, strict inside: an undeclared assignment, a write to a system variable or to `_event` is `error.execution`), values crossing by copy into the receiving context, `_event` frozen and kept until the next `bind_event` or `destroy` (across `detach_event`), XML content a DOM through txml; hibernation (`serialize` writes the session's variables and `_event` as the value table's CBOR, `TA_ERROR_UNSUPPORTED` for a value outside it or a chart whose scripts declare with `let`, `const` or `class`; `deserialize` makes a new scope, or a new context whose scripts' declarations are made again; `payload_serialize` the value table's CBOR, `payload_deserialize` as `from_wire`, both for a migrated actor's pending delayed sends); migration (`deserialize` keeps the blob's variables in the session's link until the first event or `migrate`, which answers them, exactly the old chart's variables, as one payload, and drops from a declaring session's global the old names the new chart does not declare); snapshots (every session row written as hibernation writes it, with its link's `_sessionid`, `_name`, processors, params and added names, a payload's value and references, a `<foreach>`'s items; restored into a new scope, or a new context whose scripts' declarations are made again, at the row's handle; a declaring session's globals read by name, since bun's vm context leaves a global's property stale after a function writes its `var`) |

**The same items in `@tinyactors/wasm`.** Every row above is an item of
`@tinyactors/wasm` too, with the same name, shape, errors and lifetimes
(docs/browser.md, "One API"): its direct layer (`wasm/lib/direct.mjs` and
the files beside it) is JavaScript over the module's C layer
(`wasm/src/`, whose `ta_web_*` exports call the core functions each row
names), and `lib/convenience.mjs` is the same file, its `#direct` mapped
to that direct layer under the export condition `tinyactors-wasm`. Where
it differs today, it says so at the call, never silently:

- bytes the host hands out (`compiled.image`, telemetry's data,
  `metrics()`, `hibernate()`, `snapshot()`) are a `Uint8Array`, the
  addon's a `Buffer` (a subclass);
- `datamodel: "quickjs"` runs core's quickjs datamodel inside the module,
  its engine's stack at most 256 KiB whatever `quickjs.stackLimit` asks
  (the module's shadow stack is 384 KiB), its `Date` given the real wall
  clock before each run (`ta_datamodel_ecmascript_wasm_set_time`);
- the native `"ecmascript"` datamodel runs charts in one realm per host
  (a hidden iframe on a page, the worker's global in a Worker, a
  `node:vm` context in node and bun), a scope per session as the addon's;
  under a policy that refuses
  string evaluation a native host is refused at `new Host`
  (docs/guide/browser.md, "Where charts run" and "What a page needs");
- a snapshot is labelled `tinyactors-wasm` (the addon's
  `tinyactors-napi`), and each package refuses the other's, naming it: a
  snapshot is the memory of the build that made it;
- `compileDir` and `SQLiteStore` reach `node:fs`, `node:path`,
  `node:url` and the runtime's SQLite through `process.getBuiltinModule`
  (node, bun) and throw `TA_ERROR_UNSUPPORTED` where there is none (a
  page, a Worker);
- a host nobody closed is freed by a `FinalizationRegistry`, the
  addon's finalizer's place; its state reaches the `Host` only weakly;
- the second entry, `@tinyactors/wasm/init`, exports the same names and
  `init(source?)` (`wasm/init.d.ts`), which loads the module that the
  default entry loads with top-level `await`.

`tools/parity.mjs` (in `mise run test`) compares the two packages' exports,
the objects they hand out and their refusals under node and bun, and each
against `index.d.ts`; what it accepts is listed with its reason in
`wasm/test/differences.mjs`.

**Not an API item: the package's documents.** The main package ships
the README, `docs/guide/` and `docs/values.md` beside the code and the
types (package.json's `files`, which `mise/pack.rb` stages), so the
README's relative links lead to files in `node_modules` and on npm's page;
`test/links.test.mjs` checks that every relative link of every shipped
document, and its heading, resolves inside the package. It calls nothing,
so it has no row: an item with nothing in core behind it does not belong
in the table.

## Every public function of core, in one of three lists

The inventory of core's public headers (`tinyactors-core/include/tinyactors/*.h`,
every `TA_API` function, as `include/*.api.json` lists them), taken
2026-10-16: each function is behind an API item, used internally, or not
exposed, with the reason. The API items are those of `docs/plan.xml`
(section api), whose rows the table above gets marked *planned*. A
function decided here for the API review is marked so; its decision is in
`docs/log.xml` (kind decision, for the maintainer).

### Behind an API item

- **Compiling** (`compileCharts`, `compileSystem`, `Compiled`, the
  resolver): `ta_compile_charts`, `ta_compile_system`,
  `ta_compile_image`, `ta_compile_diagnostics`, `ta_compile_free`.
- **The `Host`, its images and inputs**: `ta_host_create`,
  `ta_host_free` (`close`, the dispose symbols, the finalizer),
  `ta_host_add_image`, `ta_host_chart`, `ta_host_boot`,
  `ta_host_actor_by_name`, `ta_host_spawn`, `ta_host_send`,
  `ta_host_resolve` (a local address as `send`'s target),
  `ta_host_send_many`, `ta_host_terminate`.
- **The turn** (`idle()`, `nextDeadline`, `SimulatedClock`):
  `ta_host_effects`, `ta_host_effects_ack`, `ta_host_advance_time`,
  `ta_host_run`.
- **Effects as views** (the I/O processors' and transport's `send`, the
  log `entry`, `Migrated`, `Invocation`): `ta_host_effect_number`,
  `ta_host_effect_text`.
- **Typed methods** (`actorState` and the others) and their replies:
  `ta_host_post`; the reply's result read from `ta_host_effect_bytes`.
- **Telemetry and outputs**: `ta_host_traces`, `ta_host_logs`,
  `ta_host_metrics` (`metrics()`).
- **Hibernation**: `ta_host_sweep`, `ta_host_hibernate`, `ta_host_wake`.
- **Migration**: `ta_host_migrate`, `ta_host_migration_failed`, `ta_host_migration_pending`
  (`migrationDone`'s pending sessions).
- **Snapshots** (`snapshot()`, `Host.restore`): `ta_host_snapshot_pack`,
  `ta_host_snapshot_unpack`, `ta_host_snapshot_image`, `ta_host_restore`,
  `ta_datamodel_ecmascript_snapshot` and `ta_datamodel_ecmascript_restore`
  (quickjs's state in the pack).
- **`Address`** (`.system`, `.session`, `.name`): `ta_address_parse`,
  `ta_address_name_decode`. *Decided for the API review*: an `Address`
  made from its parts, `Address.fromSession(system, session)` and
  `Address.fromName(system, name)`, over `ta_address_format` and
  `ta_address_format_name` (log `l-p0-inventory-address-format`).
- **`encode` and `decode`** (`src/values.c`, the one conversion the API
  uses, streaming): `ta_cbor_reader_init`, `ta_cbor_read`,
  `ta_cbor_writer_init`, `ta_cbor_write_map`, `ta_cbor_write_array`,
  `ta_cbor_write_end`, `ta_cbor_write_text`, `ta_cbor_write_bytes`,
  `ta_cbor_write_uint`, `ta_cbor_write_int`, `ta_cbor_write_negative`,
  `ta_cbor_write_float`, `ta_cbor_write_simple`, `ta_cbor_write_tag`,
  `ta_cbor_writer_bytes`, `ta_cbor_writer_free`.
- **`TinyactorsError`**: `ta_status_name` (a status named by core).
- **quickjs's memory, for the operator of a sandboxed host** (*decided
  for the API review*, log `l-p0-inventory-quickjs-limits`):
  `ta_datamodel_ecmascript_heap_bytes` behind `host.quickjsHeapBytes`, a
  read of the engine's heap on a `datamodel: "quickjs"` host; the limit
  itself is the Host option at creation (`options.quickjs.memoryLimit`,
  `ta_datamodel_ecmascript_config.memory_limit`), so
  `ta_datamodel_ecmascript_set_memory_limit` is not exposed (below).
- **BasicHTTP** (*decided for the API review*, log
  `l-p0-inventory-basic-http`): `ta_http_encode_post` and
  `ta_http_parse_request` behind two functions of the module,
  `encodeHTTPPost` (the POST of a send) and `parseHTTPRequest` (the event
  of an incoming request), for an application's
  HTTP I/O processor and the adapter's W3C BasicHTTP loopback.

### Used internally, with no item

- **The loop** (`src/loop.c`): `ta_runtime_now_ns`, the wall clock of a
  host given no clock (as Python's `loop.c`); `ta_host_snapshot` with an
  empty buffer, the quiescence check `snapshot()` makes before any
  datamodel state is built.
- **Effects** (the drain's dispatch, `src/loop.c`, until `src/effects.c`
  is built): `ta_host_resume`, the answer in C to
  `TA_EFFECT_REQUEST` with `TA_ERROR_INVALID` until run-time fetching is
  built (no JavaScript runs).
- **Inputs** (`src/host.c`): `ta_host_locate`, `ta_host_system`,
  `ta_actor_info_get` and `ta_host_segment_info_get`, to find the target
  session's datamodel, of which an input's data becomes a payload
  (`ta_image_chart_datamodel`, below).
- **The environment** (`src/host.c`): `ta_datamodel_ecmascript_new`,
  `ta_datamodel_ecmascript_free`, `ta_datamodel_ecmascript_vtable` and
  `ta_datamodel_ecmascript_binding` (quickjs in the environment when the
  Host option names it); `ta_datamodel_ecmascript_payload_to_cbor` and
  `ta_datamodel_ecmascript_payload_from_cbor` (a value to or from a
  quickjs payload); `ta_datamodel_ecmascript_last_error`, the message of
  the `TinyactorsError` that `hibernate()`, `snapshot()` or a migration's
  failure gives on quickjs with `TA_ERROR_UNSUPPORTED` (which variable
  could not be stored; log `l-p0-inventory-quickjs-limits`).
- **The arena** (`src/host.c` per host, `src/module.c` per environment for
  the module's own calls, a mark per call): `ta_growable_arena_init`,
  `ta_growable_arena_alloc`, `ta_growable_arena_position`,
  `ta_growable_arena_release`, `ta_growable_arena_allocator` (the CBOR
  writer's allocator), `ta_growable_arena_free`.
- **The tables** (`src/host.c`, `src/methods.c`, `src/datamodel/rows.c`:
  charts, sessions, payloads, loops, pending replies): `ta_table_init`,
  `ta_table_add`, `ta_table_get`, `ta_table_at`, `ta_table_handle`,
  `ta_table_remove`, `ta_table_free`; `ta_table_snapshot` and
  `ta_table_restore` for the native datamodel's part of a snapshot.
- **The native datamodel** (`src/datamodel/`): `ta_datamodel_environment_in`
  (`In()`), `ta_datamodel_environment_charge` (fuel per evaluation),
  `ta_datamodel_environment_image` and `ta_datamodel_environment_chart`;
  the chart's code and names, read from its image: `ta_image_data_count`,
  `ta_image_data`, `ta_image_expression_count`, `ta_image_expression`
  (each expression's source, compiled at its first evaluation),
  `ta_image_state_by_name` (`In()`'s argument) and `ta_image_string`
  (`<param>` names); `ta_image_chart_datamodel` in `src/host.c`, above.
  Event names and invoke ids are shared per chart by core's ids
  (`ta_event_view`), not read from the image.
- **txml, for XML content** (`src/datamodel/dom.c`; tinyxml's API,
  `tinyxml/include/txml.h`, not core's): the parser, `txml_parser_init`
  (over the host's allocator), `txml_parse_feed`, `txml_parse_step`,
  `txml_parser_doc`, `txml_parser_destroy`; the tree, `txml_doc_root`,
  `txml_first_child`, `txml_next_sibling`, `txml_kind`, `txml_flags`
  (CDATA), `txml_node_name_id`, `txml_node_prefix` and `txml_doc_name_at`
  (`nodeName`, the qualified name), `txml_node_text` (text, CDATA,
  comments, processing instructions); the attributes,
  `txml_first_attribute`, `txml_next_attribute`, `txml_attribute_read`. Nothing else of txml is
  called: `getElementsByTagName` walks the JavaScript objects already
  built, and the DOM is read-only, so no writer.

### Not exposed

- **The system layer, below the host** (`system.h`): the host drives it,
  and a binding drives the host (bindings.md, section 1).
  `ta_system_layout`, `ta_system_init`, `ta_system_relocate`,
  `ta_system_deinit`, `ta_system_boot`, `ta_system_spawn`,
  `ta_system_terminate`, `ta_system_actor_by_name`,
  `ta_system_actor_by_session`, `ta_system_actors`, `ta_system_send`,
  `ta_system_send_many`, `ta_system_resume`, `ta_system_run`,
  `ta_system_advance_time`, `ta_system_next_deadline`,
  `ta_system_effects`, `ta_system_effects_ack`, `ta_actor_watch`,
  `ta_actor_config`, `ta_system_stats_get`, `ta_system_chart_stats_get`
  (the host's `host.stats` and `actor.*` methods report them),
  `ta_system_trace`, `ta_system_trace_ack`, `ta_system_trace_clock`,
  `ta_trace_policy_default`, `ta_system_trace_set` (the host's
  `trace.*` methods), `ta_actor_hibernate`, `ta_actor_wake`,
  `ta_system_cold_actors`, `ta_actor_export`, `ta_blob_migrate`,
  `ta_system_adopt`, `ta_system_set_next_serial`, `ta_system_snapshot`,
  `ta_system_restore` (the host's hibernation, migration and snapshots).
  `ta_actor_info_get` is used internally (above).
- **The core, below the system** (`core.h`): `ta_core_instance_size`,
  `ta_core_workspace_size`, `ta_core_step`, `ta_core_deliver`.
- **The system's tracing** (`trace.h`): a traceparent crosses as W3C
  text, which core parses and formats itself (`ta_traceparent_parse` and
  `ta_traceparent_format` are called by core, not by the addon), and
  spans leave as OTLP from `ta_host_traces`. `ta_step_key_span_id`,
  `ta_trace_context_child`, `ta_traceparent_parse`,
  `ta_traceparent_format`, `ta_trace_id_format`, `ta_span_id_format`,
  `ta_trace_generator_seed`, `ta_trace_generator_next`,
  `ta_trace_ratio_threshold`, `ta_trace_sampled`, `ta_trace_kind_name`,
  `ta_trace_kind_by_name`, `ta_trace_detail_by_name` (`trace.configure`
  takes the names as params), `ta_trace_body_size`, `ta_trace_next`,
  `ta_trace_body`, `ta_trace_list`, `ta_trace_dynamic_string`.
- **The OTLP encoder's internals** (`otlp.h`): the host runs the encoder
  and hands out its requests (`ta_host_traces`, `ta_host_logs`,
  `ta_host_metrics`); decoding spans is the `trace.spans.decode` method.
  `ta_otlp_layout`, `ta_otlp_init`, `ta_otlp_relocate`,
  `ta_otlp_set_resource`, `ta_otlp_set_flags`, `ta_otlp_mark`,
  `ta_otlp_read`, `ta_otlp_end_all`, `ta_otlp_put_traces`,
  `ta_otlp_put_logs`, `ta_otlp_add_log`, `ta_otlp_add_metric`,
  `ta_otlp_add_stats`, `ta_otlp_add_span_metrics`, `ta_otlp_put_metrics`,
  `ta_otlp_stats_get`, `ta_otlp_next_span`, `ta_otlp_next_attribute`,
  `ta_otlp_next_value`, `ta_otlp_next_event`, `ta_otlp_next_link`,
  `ta_otlp_next_metric`, `ta_otlp_next_point`, `ta_otlp_next_exemplar`.
- **The hosted runtime** (`runtime.h`), core's own tools' driver of one
  system: files, a resolver that does not confine reads to a root
  (a directory resolver is the convenience layer's, in JavaScript), and a
  system runner the host replaces. `ta_runtime_malloc`,
  `ta_runtime_load_file`, `ta_runtime_free_file`, `ta_runtime_files_new`,
  `ta_runtime_files_free`, `ta_runtime_resolve`,
  `ta_runtime_compile_file`, `ta_runtime_system_new`, `ta_runtime_run`,
  `ta_runtime_system_grow`, `ta_runtime_system_free`.
  `ta_runtime_now_ns` is used internally (above).
- **The image reader beyond the datamodel's needs** (`image.h`): the
  host opens and keeps the images (`ta_host_add_image` copies them,
  `ta_host_chart` names a chart, `ta_host_boot` spawns the boot actors).
  `ta_image_open`, `ta_image_bytes`, `ta_image_chart_by_name`,
  `ta_image_state_count`, `ta_image_state_name`, `ta_image_state_info`,
  `ta_image_boot_actor`, `ta_image_ahead_of_time_section`.
- **Segments**, as Python decided (tinyactors-cpython/ROADMAP.md, "The
  API review"): `ta_host_segment_count` (`host.stats` has `segments`) and
  `ta_host_snapshot_segments` (`Host.restore` reads the images from the
  pack) (log `l-p0-inventory-segments`).
- **The XML writer** (`compile.h`): `ta_xml_writer_new`,
  `ta_xml_writer_open`, `ta_xml_writer_attribute`, `ta_xml_writer_text`,
  `ta_xml_writer_close`, `ta_xml_writer_finish`, `ta_xml_writer_free`.
  The chart builder that would use it is the convenience layer's, after
  M1 and when the maintainer picks it; the direct layer gains an item
  over it in the same change (log `l-p0-inventory-xml-writer`).
- **quickjs, beyond the environment** (`datamodel_ecmascript.h`):
  `ta_datamodel_ecmascript_set_memory_limit` (the limit is the Host
  option at creation; no need shown for changing it while a host runs),
  `ta_datamodel_ecmascript_payload_eval` (an ECMAScript expression made a
  quickjs payload, for inspection: the API's values are JavaScript
  values already), `ta_datamodel_ecmascript_js_runtime` (QuickJS's C API,
  which JavaScript cannot use), `ta_datamodel_ecmascript_wasm_set_time`
  (the wasm build only).
- **The null datamodel** (`datamodel.h`): `ta_datamodel_null`, which core
  builds in; the environment lists only the datamodels the binding adds.
- **The address parts no item needs** (`address.h`):
  `ta_address_parse_local` (core resolves a local address itself,
  `ta_host_resolve`) and `ta_address_system_valid` (core checks the
  system id in the config and in `ta_address_format`).
- **CBOR beyond the streaming codec** (`cbor.h`): `ta_cbor_decode`,
  `ta_cbor_next`, `ta_cbor_member` and `ta_cbor_string`, the tree reader
  (`values.c` streams with `ta_cbor_reader`, and nothing needs a decoded
  tree), and `ta_cbor_diagnostic` (diagnostic notation for logs and
  tests; `decode` gives values).
- **wasm** (`wasm.h`): `ta_wasm_alloc`, `ta_wasm_free`, the wasm build's
  allocator.
