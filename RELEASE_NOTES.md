# @tinyactors/node and @tinyactors/wasm 0.4.0

### Summary

This release gives both packages, `@tinyactors/node` and `@tinyactors/wasm`, an application API, and it breaks every program written for 0.3.0 (6a5e1d4). A `Host` is now made from its charts and a system name. An I/O processor is an object with `receive`. Handlers no longer take the host: views and records carry `host`. `spawn` takes a chart's name and returns an `Actor` that you can send to, ask and wait on. A `store` and a `resident` bound on the host hibernate the surplus after each turn and load an actor back when it is wanted again (an event, a due delayed send, a migration). A `Spawner` processor spawns actors by name. `compileDir` compiles a directory. `onDone` and `onError` report how an actor ended, and `onHandlerError` gets what a handler threw. Errors of the commonest statuses have their own classes (`StaleError`, `StateError`, `InvalidError`, `UnsupportedError`); any other status stays a `TinyactorsError`. `decodeTraces` reads OTLP spans without a host, and `version` gives the installed version.

The native "ecmascript" datamodel now runs every session in the host's one shared context (2081069). Before, a chart whose scripts declared top-level names got a context of its own per session, which cost about 143 KB a session on node and 60 KB on bun. A chart-level script's functions become helpers that all of the chart's sessions share. A top-level `var` stays a session variable. A top-level `let`, `const` or `class` is refused, and the compile call warns about each top-level declaration, `var` included (an error with the warnings-as-errors option).

The README and the guides are grouped as the application API, operating a host and the wire format. A new guide covers sends to an actor that is not there, and the chat-rooms example is rebuilt on the new API.

### Upgrading

- `Host` (6a5e1d4): `new Host(config, options)` becomes `new Host(charts, options)`, where `charts` (`Charts`) is a compile result, image bytes or an array of them, added when the host is made. `Host.restore(snapshot, charts, options)` likewise. `host.addCharts` is removed: use `compileCharts` and pass the result to `new Host` (or to the host's addImage method). `host.spawnChart` is removed: `host.spawn` takes a chart's name or a `ChartRef` and returns an `Actor` (the actor's id is the session). `host.actorByName(name)` is removed: use `host.actor(name)`, which throws `StaleError` when no actor has that name, or `await host.actors({chart})`. `send`, `fail`, `terminate`, `hibernate` and `wake` also accept an `Actor`.
- `HostConfig` and `HostOptions` (6a5e1d4): `systemID` and `ioProcessors` move out of the config. Pass `system` in the options, and the rest of the config as `config`. A config that holds either of them is a `TypeError`. The system name "tinyactors-ask" is reserved for `ask`'s replies: a host with that system is refused. `IOProcessorConfig` is removed, and `EffectiveHostConfig.ioProcessors` is now a list of `{type, location}`.
- I/O processors (6a5e1d4): a handler function becomes an `IOProcessor` object with `receive(send)` and an optional `location`. A plain function is a `TypeError`.
- Handlers take no host (6a5e1d4): drop the first parameter of `transport`, `log`, `telemetry`, `migrated`, `migrationDone`, a service's handler, `Service`'s `receive` and `stop`, and a typed method's `OnResult` and `OnError`. Read `send.host` instead. `Send`, `LogEntry`, `Migrated` and `Invocation` gain `host`, and `Send` gains `sender`, an `Actor`.
- The `wake` option is removed (6a5e1d4): give the host a `store` (`MemoryStore`, `SQLiteStore`, or your own `Store`) and a `resident` bound.
- `compileCharts` and `compileSystem` (6a5e1d4): the resolver moves into the options, so `compileCharts(sources, resolver)` becomes `compileCharts(sources, {resolver})` (`CompileOptions` gains `resolver`). `directoryResolver` and `AddChartsOptions` are removed: use `compileDir`.
- `MigrateOptions`, `SessionParams` and `SendMessage` (6a5e1d4): their session or target may also be an `Actor`. Nothing to change.
- Native "ecmascript" charts (2081069): turn a top-level `let`, `const` or `class` into a `<data id="...">` that the script assigns. A chart-level function that read session variables by name must take them as arguments. A top-level `var` keeps working. A function a script of executable content declares is now that run's own, no longer a variable of the session. The compile call now warns about every top-level `let`, `const`, `class` and `var`, in any chart, quickjs's included, since it cannot know the datamodel: a build that compiles with the warnings-as-errors option fails on them, so move such names into `<data>` or drop that option. A native-datamodel snapshot taken with 0.3.0 that holds sessions is refused by `Host.restore`, because a session row now has 7 parts instead of 8.
- The `Spawner` (655fe3c) spawns the chart's current version under the requested name and answers `spawned` with `{name, address}`. It does not look the name up. This change affects no released version.

### Breaking changes

- the Spawner is a plain spawn; host.locate removed (655fe3c)
- the application API: Host(charts, {system}), processor objects, Actor, store and resident, ask, Spawner, compileDir (6a5e1d4)
- no context per session for charts whose scripts declare; chart-level functions are helpers (2081069)

### API changes

**Removed**

- export `AddChartsOptions`
- export `IOProcessorConfig`
- export `directoryResolver`

**Added**

- export `Actor`
- export `Charts`
- export `DecodedSpan`
- export `IOProcessor`
- export `InvalidError`
- export `MemoryStore`
- export `SQLiteStore`
- export `Spawner`
- export `StaleError`
- export `StateError`
- export `Store`
- export `UnsupportedError`
- export `compileDir`
- export `decodeTraces`
- export `version`

**Changed**

- export `CompileOptions`
- export `EffectiveHostConfig`
- export `Host`
- export `HostConfig`
- export `HostOptions`
- export `Invocation`
- export `LogEntry`
- export `MigrateOptions`
- export `Migrated`
- export `OnError`
- export `OnResult`
- export `Send`
- export `SendMessage`
- export `Service`
- export `SessionParams`
- export `compileCharts`
- export `compileSystem`

### Changes

**Added**

- Spawner holds a name once per version; host.locate (5caa15c)
- decodeTraces, spans without a host (686dbb4)
- one error class per status (5529761)
- version export, package.json in exports (2479be2)
- release tokens come from 1Password through fnox; npm publishes are staged (4bd054d)
- releases finish from cloud sessions through GitHub workflows (b3ec28f)

**Fixed**

- version comes from a module written at pack time (8fdca56)
- version comes from a module written at pack time (1f92267)
- a wasm test expects StateError before init (2342734)
- the wasm package's pages load its package.json as JSON (e815e12)
- the release workflow attaches the platform packages, read from npm (471859f)

<details>
<summary>Internal (5)</summary>

- the roadmap says where step 8 stands, records the browser decision, and the scale requests as answered (531e1c7)
- key a table by the sender's fragment of _event.origin (2633df6)
- operator and wire-format calls grouped apart from the application API (a4fc147)
- the chat example and the guide to a send to an actor that is not there (a155eae)
- roadmap step 8.6, the application API of both bindings (fc63118)

</details>
