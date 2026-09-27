# Architecture decision records: tinyactors-napi

These ADRs record the design of the Node-API addon. The addon is being
rewritten from scratch against them. Where `../design.md` or
`../../ROADMAP.md` disagree with an ADR, the ADR wins.

Core decisions live in `tinyactors-core/docs/adr`. This addon depends in
particular on core ADRs 0011, 0029, 0040, 0047, 0050, 0053–0059, 0061,
0062, 0065, 0082 to 0085, and benefits from 0063 and 0064.

| ADR | Title |
|---|---|
| [0001](0001-core-interprets-the-addon-hosts-javascript-scripts.md) | [Core interprets, the addon hosts, JavaScript scripts](0001-core-interprets-the-addon-hosts-javascript-scripts.md) |
| [0002](0002-actors-are-ids-handles-are-plain-javascript.md) | [Actors are IDs; handles are plain JavaScript](0002-actors-are-ids-handles-are-plain-javascript.md) |
| [0003](0003-singular-calls-are-primary-enumeration-is-paged.md) | [Singular calls are primary; enumeration is paged](0003-singular-calls-are-primary-enumeration-is-paged.md) |
| [0004](0004-event-names-are-interned-once.md) | [Event names are interned once](0004-event-names-are-interned-once.md) |
| [0005](0005-per-target-mailboxes-and-a-ready-queue.md) | [Per-target mailboxes and a ready queue](0005-per-target-mailboxes-and-a-ready-queue.md) |
| [0006](0006-the-addon-routes-actor-to-actor-events.md) | [The addon routes actor-to-actor events](0006-the-addon-routes-actor-to-actor-events.md) |
| [0007](0007-the-event-loop-drives-a-bounded-pump.md) | [The event loop drives a bounded pump](0007-the-event-loop-drives-a-bounded-pump.md) |
| [0008](0008-faults-are-per-actor.md) | [Faults are per actor](0008-faults-are-per-actor.md) |
| [0009](0009-one-native-toolkit-for-memory-and-containers.md) | [One native toolkit for memory and containers](0009-one-native-toolkit-for-memory-and-containers.md) |
| [0010](0010-definitions-are-normalized-in-javascript-and-built-in-one-arena.md) | [Definitions are normalized in JavaScript and built in one arena](0010-definitions-are-normalized-in-javascript-and-built-in-one-arena.md) (superseded by 0013) |
| [0011](0011-javascript-values-cross-as-reference-counted-boxes.md) | [JavaScript values cross as reference-counted boxes](0011-javascript-values-cross-as-reference-counted-boxes.md) |
| [0012](0012-lifecycle-close-is-authoritative-finished-actors-are-reclaimed.md) | [Lifecycle: close is authoritative, finished actors are reclaimed](0012-lifecycle-close-is-authoritative-finished-actors-are-reclaimed.md) |
| [0013](0013-the-control-plane-is-generated-the-plumbing-is-hand-written.md) | [The control plane is generated; the plumbing is hand-written](0013-the-control-plane-is-generated-the-plumbing-is-hand-written.md) |
| [0014](0014-memory-is-pooled-by-lifetime.md) | [Memory is pooled by lifetime](0014-memory-is-pooled-by-lifetime.md) |
| [0015](0015-tracing-is-a-hook-that-hands-javascript-plain-records.md) | [Tracing is a hook that hands JavaScript plain records](0015-tracing-is-a-hook-that-hands-javascript-plain-records.md) |
| [0016](0016-traces-leave-the-addon-as-otlp-protobuf.md) | [Traces leave the addon as OTLP protobuf](0016-traces-leave-the-addon-as-otlp-protobuf.md) |
| [0017](0017-observability-owns-its-encoder-and-makes-off-and-sampled-out-free.md) | [Observability owns its encoder, and makes off and sampled-out free](0017-observability-owns-its-encoder-and-makes-off-and-sampled-out-free.md) |
| [0018](0018-the-encoder-writes-into-memory-the-host-provides.md) | [The encoder writes into memory the host provides](0018-the-encoder-writes-into-memory-the-host-provides.md) |
| [0019](0019-a-data-model-in-javascript-compiles-source-for-the-built-in-one.md) | [A data model in JavaScript compiles source for the built-in one](0019-a-data-model-in-javascript-compiles-source-for-the-built-in-one.md) |
| [0020](0020-mail-for-an-unloaded-actor-waits-while-a-loader-brings-it-back.md) | [Mail for an unloaded actor waits while a loader brings it back](0020-mail-for-an-unloaded-actor-waits-while-a-loader-brings-it-back.md) |
| [0021](0021-an-invoked-scxml-document-is-imported-in-the-invoke.md) | [An invoked SCXML document is imported in the invoke](0021-an-invoked-scxml-document-is-imported-in-the-invoke.md) |
| [0022](0022-mail-a-chart-sends-nowhere-raises-error-communication.md) | [Mail a chart sends nowhere raises `error.communication`](0022-mail-a-chart-sends-nowhere-raises-error-communication.md) |
| [0023](0023-invoked-documents-are-cached-in-a-bounded-lru.md) | [Invoked documents are cached in a bounded LRU](0023-invoked-documents-are-cached-in-a-bounded-lru.md) |
| [0024](0024-a-child-chart-is-a-nested-definition.md) | [A child chart is a nested definition](0024-a-child-chart-is-a-nested-definition.md) |
| [0025](0025-a-quarantined-child-tells-its-parent.md) | [A quarantined child tells its parent](0025-a-quarantined-child-tells-its-parent.md) |
| [0026](0026-a-debugger-watches-and-pokes-one-live-actor.md) | [A debugger watches and pokes one live actor](0026-a-debugger-watches-and-pokes-one-live-actor.md) |
