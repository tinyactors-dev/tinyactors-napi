# Tinyactors Node-API implementation roadmap

The addon is being rewritten from scratch against the ADRs in
[`docs/adr/`](docs/adr/README.md). The first addon (`src/addon.c` and its
tests) is not extended. It is deleted in step 1, and features come back one
step at a time on the new foundation.

Where this roadmap and an ADR disagree, the ADR wins, and this file should be
corrected.

**Status (2026-09-23): steps 1–14 are done.** Every exit criterion below
passes on Node and Bun. What is still open is listed under "Open
follow-ups" at the end.

## Shape of the result

- **Core interprets, the addon hosts, and JavaScript scripts** (ADR 0001).
- **Generated code:** everything JavaScript calls on core. The generator
  reads `tinyactors.api.json`, and its output is checked in (ADR 0013).
- **Hand-written plumbing:**
  - memory: a counting allocator, free lists and arenas (ADR 0014);
  - scheduling: the slot-indexed scheduling table, envelope mailboxes, ready
    and runnable queues, and the pump (ADRs 0005, 0007);
  - the router and the actor directory (ADR 0006);
  - the clock;
  - adapters for core's callback interfaces;
  - the JavaScript data model and value boxes (ADR 0011).
- **Actors cross the boundary as `(slot, generation)` pairs of small
  integers** (ADR 0002), passed to native code as two positional numbers.
  Nothing is allocated per actor on the JavaScript side.
- **Singular calls** (ADR 0003). The only batch path is paged enumeration,
  which continues from a cursor.
- **No allocator call on the hot path** (ADR 0014). Memory is managed by
  lifetime, and after warm-up a steady workload makes no allocator call in
  the addon.

## Target file tree

```text
tinyactors-napi/
├── README.md
├── ROADMAP.md
├── package.json
├── mise.toml
├── bindings.rb                  policy: bound, hooked, plumbing-owned, overridden, skipped (ADR 0013)
├── index.js                     public entry: createSystem, statechart, literal, TinyactorsError, version
├── index.d.ts                   public types
├── lib/                         JavaScript layer
│   ├── system.js                System facade over the native System and the generated core module
│   ├── actor.js                 ActorID/Actor view: { system, slot, generation } (ADR 0002)
│   ├── definition.js            Definition facade; identity read from core
│   ├── statechart.js            fluent builder; emits the generated spec shape (ADR 0013)
│   ├── events.js                event-name cache: text <-> ta_event_name_id (ADR 0004)
│   ├── errors.js                TinyactorsError; codes from the generated result table (ADR 0008)
│   └── native.js                loads the compiled addon once for every lib/ module
├── src/
│   ├── gen/
│   │   ├── ta_napi.c            GENERATED, checked in; never edited by hand
│   │   └── ta_napi.h            GENERATED, checked in
│   ├── addon.c                  module init: registers classes and the generated module; nothing else
│   ├── runtime.{c,h}            the per-environment record (error class, open systems, cleanup hook);
│   │                            support for generated code: the call context and arena, decode
│   │                            paths, result -> TinyactorsError, reentrancy guard, handle objects
│   │                            (ADR 0013)
│   ├── runtime_codecs.c         hand-written codecs: primitives, ta_str, ta_bytes, the overridden
│   │                            types (ta_actor_id, ta_actor_ref, ta_value, ta_expression) and the
│   │                            injected adapters (ta_allocator, ta_datamodel)
│   ├── system.{c,h}             native system without Node-API: owns ta_system and all plumbing,
│   │                            close, stats (ADR 0012); covered by native tests
│   ├── napi_system.{c,h}        the JavaScript System class over system.{c,h}: wrap, finalizer, stats
│   ├── containers.{c,h}         vec, ring, map, slice, free lists (ADR 0009)
│   ├── allocator.{c,h}          counting allocator shared with core, turn and call arenas over
│   │                            core's ta_arena (ADRs 0009, 0014)
│   ├── scheduler.{c,h}          slot-indexed scheduling table, envelope mailboxes, ready and
│   │                            runnable queues, deliver/resume, one bounded turn, per-actor faults
│   │                            and budgeted dead letters (ADRs 0005, 0008)
│   ├── pump.{c,h}               setImmediate turns, deadline timer via global setTimeout, monotonic
│   │                            clock read every turn, flush/advance promises, hook calls (ADR 0007)
│   ├── hooks.{c,h}              post-call hooks for spawn/load/reconstruct/prepare/destroy/unload (ADR 0013)
│   ├── router.{c,h}             external-event router into mailboxes (ADR 0006)
│   ├── directory.{c,h}          in-memory actor directory keyed by core's ta_address handles (ADR 0006)
│   ├── events.{c,h}             dotted event-name interning and formatting (ADR 0004)
│   ├── values.{c,h}             reference-counted value boxes, one napi_ref each (ADR 0011)
│   ├── napi_datamodel.{c,h}     the JavaScript data model (ADR 0011)
│   ├── enumerate.{c,h}          cursor-paged actor enumeration (ADR 0003)
│   ├── effects.{c,h}            service effects queued in the turn arena until JavaScript can run
│   │                            them (step 13); no Node-API
│   ├── napi_services.{c,h}      registerIO/registerInvoker/setLogSink/reportInvoke, and the
│   │                            dispatch of effects to lib/system.js (step 13)
│   └── adapters/
│       ├── io.{c,h}             JavaScript I/O processors
│       ├── invoker.{c,h}        JavaScript invokers and the in-system SCXML invoker
│       └── log.{c,h}            buffered log sink
├── mise/
│   ├── tasks/
│   │   ├── bindings             regenerate src/gen/ from tinyactors.api.json and bindings.rb;
│   │   │                        --check fails when src/gen is stale, --report lists every category
│   │   ├── build                compile core amalgamation + src/**/*.c into build/tinyactors_napi.node
│   │   ├── test-native          build and run test/native/*_test.c against the plumbing objects
│   │   ├── test-native-asan     the same native tests under AddressSanitizer and UBSan
│   │   └── test                 staleness check, native unit tests, then the JS suites on Node and Bun
│   └── lib/
│       ├── compile.rb           the one compile command; cached objects under build/obj shared by
│       │                        build and test-native (build/obj-asan with TNA_SANITIZE=1)
│       └── napi/                the generator (owned by this package; not shared)
│           ├── api.rb           read and validate the API description
│           ├── plan.rb          Node-API binding decisions: positional args, codecs, outputs, handles
│           ├── policy.rb        load bindings.rb and enforce complete, non-stale classification
│           └── emit.rb          format the plan as C
├── test/
│   ├── native/                  C unit tests (allocator, arenas, containers, scheduling table), built by
│   │                            mise run test
│   ├── *.js                     one suite per area (system, definition, actor, post, router, time, ...)
│   └── scale.js                 population ratio benchmark and target-population measurements
│                                (steps 10, 11, 13)
└── docs/
    ├── design.md                earlier design notes; superseded where they differ from the ADRs
    ├── scale.md                 dated scale.js measurements (step 10 and later)
    └── adr/                     binding ADRs
```

`build/` holds only the compiled addon and is not checked in.

## Core prerequisites

The rewrite depends on these core ADRs. Each step below names the ones it
needs, and a step waits for its prerequisites instead of working around them
(ADR 0001).

| Core ADR | Needed by | State |
|---|---|---|
| 0054: delayed sends live with their owner | step 8 | implemented |
| 0055: deliver is the admission test (`TA_ERR_DONE`) | step 6 | implemented |
| 0056: a finished actor reports its final state | step 5 | implemented |
| 0057: core ships the null data model | step 4 | implemented |
| 0058: compile errors say what and where | step 4 (error quality only) | implemented |
| 0059: an actor ID is a public slot and generation | step 3 | implemented |
| 0061: a macrostep can pause inside executable content | step 5 | implemented |
| 0062: the actor walk is paged by position | step 9 | implemented |
| 0063: an actor is one allocation in a paged table | step 10 (measured there) | implemented |
| 0064: an internal queue is lent to a running actor | step 10 (measured there) | implemented |
| 0065: named addresses are shared, reference-counted handles | step 7 | implemented |
| 0066: a session ID outlives residency | steps 5 and 14 | implemented |

All of them are implemented. Two notes on what they mean for the addon:
- **Core ADR 0065** fixed a use-after-free the addon would have hit: a named
  origin kept after its sender was destroyed. The router keeps an event's
  references with `ta_event_retain()`, and the directory receives
  `ta_address` handles.
- **Core ADR 0066:** a session keeps its ID across unload and load, but its
  runtime ID changes. An `ActorID` (slot and generation, ADR 0002) is a
  runtime ID, so it goes stale when a virtual actor pages out and back in.
  Inspection reports `sessionID` (step 5). Step 14 names virtual actors by
  address or session ID, not by `ActorID`.

Core now measures about 532 bytes per actor without data.

The libraries in this repository are private (root `AGENTS.md`). When the
addon needs a core change, core's API changes in place and every caller
moves with it, the addon included. There are no second functions and no
compatibility shims.

## Steps

Each step leaves `main` building and passing `mise run test`, and is
committed separately, in several commits where that helps. Every test runs on
both Node and Bun.

### 1. Reset the package

- Delete `src/addon.c`, `src/binding.h`, `src/null_datamodel.{c,h}` and the
  tests that exercise them.
- `index.d.ts` describes the public API, but parts of it predate the ADRs.
  For example, it still types `ActorID` as a branded `bigint`, against
  ADR 0002. Each step brings the types it touches in line with the ADRs.
- Create the tree above with empty modules. `addon.c` exports only
  `version`.
- Add `allocator.{c,h}` (ADR 0014):
  - the system's counting allocator over `malloc`, which is also core's
    allocator;
  - turn and call arenas over core's `ta_arena`;
  - counters for bytes in use and allocator calls, per category.
  - Size-class pools are deferred (ADR 0014, point 5).
- Add `containers.{c,h}`, including a free list for fixed-size records and a
  ring that keeps one spare chunk.
- Native unit tests under `test/native/` cover:
  - growing, wrapping, and map deletion with tombstones;
  - free-list reuse: freeing and taking again makes no allocator call;
  - arenas that are reset make no allocator call;
  - accounting that balances to zero.
- `mise run build` compiles every `src/**/*.c` together with the core
  amalgamation.

Exit criterion: `version` loads on Node and Bun, and the native allocator
and container tests pass.

### 2. Own a system

- `system.{c,h}`: `createSystem()` builds a `ta_system` with the counting
  allocator as core's allocator. `close()` is idempotent and authoritative,
  and frees everything the system holds. The environment cleanup hook
  closes any system still open. `stats()` reports the counters per lifetime
  and category.
- `lib/errors.js` and `lib/system.js`.

Exit criterion: many systems can be created, closed and finalized in any
order without leaks (the allocator's bytes in use return to zero).

Done: `system.{c,h}` holds the native system with no Node-API in it, so
native tests (also run under AddressSanitizer) cover create, close and free.
`napi_system.{c,h}` wraps it as the JavaScript `System`, and `runtime.{c,h}`
holds the per-environment record: the registered `TinyactorsError` class,
the list of open systems that the environment cleanup hook closes, and the
counters `environmentStats()` reports to tests.

### 3. Generate the control plane

Needs core ADR 0059.

- `mise/lib/napi/{api,plan,policy,emit}.rb`, `mise/tasks/bindings` and
  `bindings.rb`. Every function and type in the API description is
  classified, and the generator fails otherwise.
- `runtime.{c,h}`:
  - primitive codecs, and the `(slot, generation)` codec for
    `ta_actor_id`, which takes two positional numbers and never reads
    properties of a view object;
  - enum symbols for result codes;
  - the reentrancy guard;
  - handle wrapping, with finalizers that call the release function the
    description names.
- Commit the first `src/gen/ta_napi.{c,h}`.
- `mise run test` regenerates into a temporary directory and fails on any
  difference.
- The hooks are declared in `bindings.rb` and called by the generated code,
  but `src/hooks.c` does nothing until step 5. An actor spawned through the
  generated layer is created and not bootstrapped, because nothing
  schedules it yet.
- Until step 11, `ta_value` crosses only when absent, and `ta_expression`
  only as source text. A JavaScript value or function throws
  `unsupported`; nothing is dropped silently.

Exit criterion:
- a bound function (for example `ta_system_time`) is callable through the
  internal module;
- a plumbing-owned function (for example `ta_actor_deliver`) is absent;
- editing `bindings.rb` without regenerating fails `mise run test`.

### 4. Define charts

Needs core ADR 0057; core ADR 0058 improves error messages.

- `lib/statechart.js` emits the generated spec shape.
- `System.define()` calls the generated `ta_definition_compile_spec` and
  `ta_system_register_definition` with `ta_null_datamodel()`.
- A refused chart throws a `TinyactorsError` that carries core's
  `ta_compile_error` (core ADR 0058): its code, path, subject and message.
  The call arena is passed as `error_arena`, and the error is copied into
  JavaScript before the arena is reset.
  - The `error` member of `ta_definition_compile_params` is annotated
    `TA_ALWAYS`: it is written after every result, with code
    `TA_COMPILE_ERROR_NONE` unless the spec was refused (core ADR 0057,
    implementation notes). The generated binding returns it on a refusal,
    so the addon needs no override.
- `lib/definition.js` reads `identity`, `inspect()` and `retired` through
  generated calls. `retire()` is bound.

Exit criterion:
- the charts from the old `test/definition.js` compile;
- malformed specs fail with the generated codec's error path;
- under the null data model, a chart with any expression other than
  `In(state)` is refused when it is defined, with
  `TA_COMPILE_ERROR_EXPRESSION_REJECTED` and the expression's path;
  `In()` used as a value compiles, and faults as `error.execution` when it
  runs (core ADR 0057);
- nothing about a definition is stored in the addon.

### 5. Spawn, run, inspect, destroy

Needs core ADRs 0056 and 0061.

- `lib/actor.js`: the `ActorID` view.
- Spawn, run and destroy:
  - the scheduling table (ADR 0005), in fixed pages that are never copied;
  - the spawn hook fills the actor's entry and puts it on the runnable
    queue;
  - `scheduler.{c,h}` runs the runnable part of one turn. It has no
    Node-API in it; data-model callbacks open their own handle scope
    (step 11, ADR 0007);
  - a turn resumes up to `resumesPerTurn` actors, and each resume passes two
    budgets: `budget` counts microsteps, and `action_budget` counts units of
    executable content (core ADR 0061). The system options expose them as
    `resumeBudget` and `actionBudget`. The action budget is what bounds one
    resume when a single microstep runs a long script or a `<foreach>` over
    a large array;
  - an actor paused by either budget answers `TA_RUN_PAUSED` and stays
    `runnable` (ADR 0005);
  - `pump.{c,h}` schedules coalesced turns with `setImmediate` from native
    code, and implements `flush()` with native promises;
  - hook records go into the turn arena;
  - the destroy hook clears the actor's entry.
- `inspect()` goes through the generated `ta_actor_inspect`, and reports
  `sessionID` (core ADR 0066) beside the actor's ID. `finalState`
  comes from the inspection's `final_state` (core ADR 0056), named through
  `ta_definition_state()`. It is `null` while the actor runs, while it is
  paused inside a microstep, and for a cancelled invoked child. The addon
  keeps no copy of a chart's final states.
- The `done` hook reads the final state and completion the same way,
  before a `finished: "destroy"` actor is destroyed.
- The `done` hook and the `finished: "destroy" | "retain"` option
  (ADR 0012).

Exit criterion:
- spawned actors reach their initial state after `await flush()`, and
  nothing runs synchronously inside `spawn()` (checked on both runtimes;
  ADR 0007);
- while a large population bootstraps over many turns, an I/O callback and
  a timer callback run between two consecutive turns (on both runtimes);
- a chart with two top-level finals reports the one that was actually
  reached;
- with a small `actionBudget`, one long entry handler runs over several
  turns, and other actors run between them. Under the null data model the
  handler is a run of `<log>` actions; the `<foreach>` variant needs the
  data model and is checked in step 11;
- with `finished: "destroy"`, finished actors are gone after `done`.

### 6. Post events through mailboxes

Needs core ADR 0055.

- `events.{c,h}` and `lib/events.js` (ADR 0004).
- `post()`, mailboxes of reused envelopes and the ready queue (ADR 0005):
  - mail for a stale generation is a dead letter at enqueue;
  - delivery acts on `ta_actor_deliver`'s result alone. Core checks in
    this order: `TA_ERR_INVALID` for a malformed event, `TA_ERR_NOT_FOUND`,
    `TA_ERR_DONE`, then `TA_ERR_BUSY` (core ADR 0055). An actor paused by
    an action budget is inside its macrostep and answers `TA_ERR_BUSY`,
    which the scheduling table already rules out because that actor is
    `runnable`;
  - `TA_ERR_DONE` and `TA_ERR_NOT_FOUND` go to `deadLetter`, at most
    `messageBudget` records per turn;
  - other failures quarantine the actor in its entry and call `fault`
    (ADR 0008). The envelope core refused becomes a dead letter with reason
    `refused`, so `release()` does not fault again on it.
- `maxQueuedMessages` backpressure.
- Posts carry no data until step 11 (value boxes), and targets are
  `ActorID`s until step 7 (the directory).

Built: the envelope store, mailboxes, the ready queue and dead letters are
in `scheduler.{c,h}`, which has no Node-API and is covered by
`test/native/mailbox_test.c` (also under ASan). A malformed event can only
be posted through the native method, which `test/post.js` uses to provoke a
delivery fault.

Exit criterion:
- per-target FIFO holds even when a turn stops at its message budget;
- one faulting actor does not stop the others;
- a quarantined actor with an empty mailbox stays out of scheduling when
  new mail arrives, and `release()` brings it back;
- mail posted to an actor between `spawn` and its bootstrap is delivered
  after the bootstrap, with no `TA_ERR_BUSY`;
- a stale ID's mail never reaches the slot's next actor;
- posting a name that was seen before does no string work;
- after warm-up, posting and delivering messages without data makes no
  allocator call in the addon (ADR 0014).

### 7. Route actor-to-actor events

Needs core ADR 0065 (implemented).

- `router.{c,h}` and `directory.{c,h}`, installed at system creation
  (ADR 0006):
  - the router keeps the event with `ta_event_retain()`; the destination is
    resolved at once, so only the event goes into the envelope, which
    releases it after delivery;
  - the directory is a map keyed by the `ta_address` handle's pointer;
  - a name with no resident actor is a dead letter whose record keeps the
    name (`target: { family, name }`, reason `not-found`, or `unloaded`
    until step 14).
- `System.post()` to an address, resolved the same way.
- Named spawn and `findActor()`.
- Literal `<send>` between actors.
- The router's `submit` only enqueues. It never destroys or unloads an
  actor. Core relies on this: a due send that the router refuses goes back
  to its owner's list without allocating only while the owner is still
  there (core ADR 0054, implementation notes).

Exit criterion:
- a ping-pong pair exchanges N messages with no JavaScript involvement
  between `post` and `flush`;
- sends to a named address follow the directory;
- an external send to self is delivered in a later macrostep, with no
  `TA_ERR_BUSY`;
- after warm-up, a named ping-pong pair makes no allocator call in the
  addon and copies no address (a named target costs core exactly what a
  session target costs);
- a named sender finishes and is destroyed while its message waits in a
  mailbox. The envelope's origin stays valid: a native test reads it with
  `ta_address_view()` under AddressSanitizer, and step 11 checks
  `_event.origin` in JavaScript.

Measured while building this step: core makes one allocation and one free
for every `<send>` it executes, for a named and a session target alike. It
is core's own send path, not an address copy. Core's scale test is the place
to chase it.

### 8. Time

- Manual clock: `advanceTo()` and `advanceBy()`.
- Realtime clock in `pump.{c,h}`:
  - time comes from a native monotonic clock and is set at the start of
    every turn;
  - one timer is armed from native code with the global `setTimeout`,
    based on `ta_system_next_deadline`, and unreferenced so it does not
    keep the process alive;
  - the timer is re-armed only for an earlier deadline.
- Due sends are dispatched in the pump turn.
- Inspection shows `delayedSends` with `submitted` and `destination`
  (core ADR 0054). For a custom I/O processor, core leaves `destination`
  as a zeroed runtime ref (ID 0). JavaScript sees `null` there, and the
  send's `target`.

Exit criterion:
- delayed sends fire in deadline order under both clocks;
- cancelled sends never fire;
- under the realtime clock, a send armed by the first message after an
  idle period fires no earlier than its delay;
- an idle realtime system does not keep the process alive.

Built as:
- `system.{c,h}` owns the clock, Node-API-free. `clock_test.c` drives it
  with a fake monotonic clock.
- `pump.c` arms the timer.
- `test/time.js` checks the criteria on both runtimes. The idle-process
  check runs `test/fixtures/time_idle_child.js` in a child process.

`delayedSends[].id` is the send ID text, or null. `destination` is null for a
custom processor; checking that waits for registered processors (step 13).

### 9. Enumerate

Needs core ADR 0062.

- `enumerate.{c,h}`: `system.actors()` and `system.actorIDs()` as pages
  (ADR 0003). Core's visitor writes each page's IDs straight into the
  page's `ArrayBuffer`, and `actors()` inspects each actor when it reaches
  it. Each page is one call of
  `ta_system_visit_actors` with a `ta_actor_visit_params`:
  - `from` is the position the previous page returned in `next`, or 0 for
    the first page. `limit` is the page size;
  - the iteration ends when `next` is `TA_ACTOR_VISIT_END`. A last page
    that is exactly full takes one more call, which visits nothing;
  - the iterator keeps the position as an opaque number and only passes
    back a `next` that core gave it;
  - if a visit fails (for example, the page cannot copy for want of
    memory), `next` is the actor that failed, so the page can be retried
    without skipping it.
- Pages follow core ADR 0062's rules for changes between pages: an actor
  resident for the whole iteration is visited exactly once.

Exit criterion:
- iterating over a large population keeps peak JavaScript heap bounded by
  the page size;
- the last page of a large population costs about the same as the first,
  so a whole iteration is linear;
- an actor spawned or destroyed between pages follows core ADR 0062 §4.

Done: `test/native/enumerate_test.c` and `test/enumerate.js`. Delayed-send
targets and data in `actors()` inspections wait for value boxes (step 11),
like every other inspection.

### 10. Prove the scale properties

This step sets a baseline with charts that have no data. Steps 11 and 13
run it again with data and I/O, which is the load of one actor per
websocket connection.

- `test/scale.js`: a population benchmark in the style of tinyactors-test's
  `scale_test.c`. That test now measures 50,000, 200,000, 1,000,000 and
  4,000,000 actors, and core measures about 532 bytes per data-less actor.
  `scale.js` uses the same populations, but `mise run test` runs only the
  first two (50,000 and 200,000): the full-size run in tinyactors-test
  stalled this machine while other work was running.
  `TAT_SCALE_MAX_POPULATION` raises the cap, and a population above
  200,000 then runs only when its predicted peak fits in three quarters of
  the available memory. It checks that each of the following stays flat per
  actor from one population to the next: spawn plus bootstrap, post plus
  delivery, inspect, one enumeration page, the end-to-end run, and native
  bytes. It measures CPU time, except for the page and the pump turns.
- A steady-state check: after warm-up, a round of posts and deliveries
  makes no allocator call in the addon. Core's allocator calls are
  reported beside it (ADR 0014).
- The longest single spawn at each population, and the largest block
  allocated while spawning, which core ADR 0063 keeps at one page.
- The end-to-end many-actor test from the old roadmap (spawn N, post `work`
  to all, flush once, all done), with N from the same populations.
- At the largest population measured, the test reports:
  - the longest pump turn and the largest event-loop delay;
  - RSS, V8 heap and native bytes per actor;
  - total GC pause time.

Exit criterion: every ratio stays within its bound on Node and Bun, and
steady state makes no allocator call in the addon. No test asserts an
absolute duration. The target-population numbers are recorded for
comparison, not asserted, in `docs/scale.md`.

Done (2026-09-23). The baseline is in `docs/scale.md`: at 4M actors, 480
native bytes and no JS heap per actor, 0.3 µs per post and delivery, a
largest block of one 64 KiB page, and pump turns with a flat p99. One
finding is for core: a chart with a top-level `<final>` makes core allocate
and free once per delivered message.

### 11. The JavaScript data model

- `values.{c,h}`: value boxes with one `napi_ref` each (ADR 0011, model
  A), records from a free list, behind a make/retain/release/get
  interface. Also `napi_datamodel.{c,h}`:
  - data declarations;
  - conditions, values, locations, assignments and scripts as
    JavaScript functions;
  - event data;
  - completion data.
- The reentrancy guard is exercised by expressions that try to call core.

Exit criterion:
- the ping-pong player chart in `docs/design.md` runs;
- with a small `actionBudget`, a `<foreach>` over a large array in one
  entry handler runs over several turns, with other actors running between
  them (the variant step 5 left for the data model);
- data-model callbacks open their own handle scope, so a turn that runs
  many expressions does not keep their handles until it ends (ADR 0007);
- the number of value boxes returns to zero after `close()`;
- model A is measured against a handle table (model B) at 1M and 4M
  actors with data (bytes per value, make and release cost, full and minor
  GC time, allocator calls per message). The result is recorded in
  ADR 0011, and B replaces A only if it is clearly better;
- a receiver reads `_event.origin` of a message whose named sender was
  destroyed before delivery, and replies to it (core ADR 0065);
- `test/scale.js` runs again with a chart that has data: its ratios stay
  within their bounds, steady state with data makes no allocator call in
  the addon, and the target-population numbers are recorded.

Done (2026-09-23). Every exit criterion passes on Node and Bun
(`test/datamodel.js`, `test/scale.js`). What was built, and the choices the
ADRs left open:
- **The data model is named "javascript".** A function is an expression
  (condition, value or script) with `this` bound to the actor's data object;
  `literal()` is a constant; `{ get, set }` is a location. Source text is
  accepted only as `In(state)` and a data name, and anything else is
  refused at define time, naming the expression. Importing SCXML with
  ECMAScript source text stays an open decision; `ta_definition_import`
  stays skipped.
- **The data model is the JavaScript one.** `System.define()` compiled a
  chart without data against core's null data model at first, so it cost
  nothing per actor; napi no longer infers it. Every builder chart and plain
  spec uses the JavaScript data model unless a spec says `datamodel:
  "null"`, and an SCXML document without a `datamodel` attribute gets
  `javascript` too. The generated layer alone compiles against the null
  data model.
- **An actor's data is one object:** the spawn binding (shared, not copied),
  or a new object. A bound name skips its initializer, and assigning to a
  name the object does not have is `error.execution`.
- **The evaluation context is one frozen object per system.** Its getters
  (`data`, `event`, `sessionID`, `name`, `ioProcessors`, `inState()`) read
  the core call in progress and throw after it. `event.origin` is the URI a
  reply can target.
- **Expressions cannot call core** (the reentrancy guard), but can `post()`
  names already interned. Interning a new name is a core call.
- **Value boxes stay model A**, one `napi_ref` each. The A/B at 4M actors is
  in ADR 0011 and `docs/scale.md`: the handle table halves major GC time but
  makes every message 17–26% slower. The addon builds against Node-API 10,
  which is needed for references to strings, bigints and symbols.
- **With data, a message costs about 1 µs** (Node 1.27 µs, Bun 0.96 µs at
  4M actors): two JavaScript calls and a boxed payload. That compares with
  about 2.7 µs for xstate and 0.03 µs for a plain JavaScript object. An
  actor with a data object costs 528 native bytes and about 56–64 bytes of
  JS heap.
- `inspect()` reports `data` and `completion`, the `done` hook receives
  completion data, and `stats().values` counts live boxes.

### 12. `send()` and backpressure

- `send()` promises with acceptance and completion modes, abort signals and
  timeouts.
- A retained-bytes limit.

Exit criterion: pending promises settle on completion, on abort, and on
`close()`.

Done (ADR 0005 points 9 and 11, ADR 0008 point 3):
- `until: "completed"` (the default) resolves when the macrostep the message
  starts ends, stable or done (with the done data). `until: "accepted"`
  resolves when the message is queued.
- Dead letters reject with the reason's code, and a failed macrostep with
  the fault's. `signal` and `timeout` withdraw a message still queued; a
  delivered one is not undone. `close()` rejects with `closed`.
- A full queue rejects a `send()` with `queue-full`; `post()` throws it.
- Retained bytes are an O(1) estimate made when a message is accepted:
  `options.bytes`, 2 bytes per string code unit, `byteLength` for buffers,
  64 for other objects, 0 for primitives. Mail between actors carries none.
- Waiters come from a free list: after warm-up a `send()` makes no
  allocator call in the addon. At 100k actors, a completed `send()` costs
  about 0.6 µs on Node and 0.4 µs on Bun, against 0.2 µs for a `post()`.

### 13. Services

- `adapters/io`, `adapters/invoker` (JavaScript invokers and the in-system
  SCXML invoker) and `adapters/log`.
- JavaScript-facing `registerIO`, `registerInvoker` and `setLogSink`.

Exit criterion:
- an asynchronous I/O processor completes by enqueuing an event;
- an invoked child chart reports `done.invoke` to its parent;
- `test/scale.js` runs a websocket-shaped load: one actor per simulated
  connection, with data, an inbound post and an outbound I/O send per
  message, and an idle timeout that is re-armed on each message. Its
  ratios stay within their bounds, and the target-population numbers are
  recorded.

Done (ADR 0001 rule 3, ADR 0007 point 5, core ADRs 0015, 0016, 0045, 0046):
- **Nothing runs JavaScript inside core.** The adapters copy each call into
  an effect (`src/effects.h`) in the turn arena, retaining its values. The
  pump hands effects to `lib/system.js` after the turn's hooks, in the order
  core made the calls. Waiting effects keep the system from being quiet,
  and close releases them while core is alive.
- **I/O processors:** `processor.send(request, context)` with request
  `{ source, sendID, event, type, target, data }` (plus `content`,
  `contentType`) and one frozen context per system `{ system, signal, post }`,
  whose signal aborts on `close()`. `sendID` is the send's ID text, or
  `null` for a send without one. A reply is an event the processor posts.
  A processor that throws or rejects fails the send, and the sender gets an
  external `error.communication` event with `{ sendID, type, error }`
  (it cannot be an internal event: the send already returned).
- **JavaScript invokers:** `start(request, reporter)` runs after the turn;
  `cancel()` when the invoking state exits; `forward(event)` for
  autoforwarded events. `reporter.event()` and `reporter.done()` post to the
  parent's mailbox with the invoke ID set (done as `done.invoke.<id>`), so
  they keep its order and backpressure; `reporter.unavailable()` goes
  through core, which retires the invocation and queues
  `error.communication`. The reporter's signal aborts on cancel, done,
  unavailable and `close()`, which also cancels live services.
- **The in-system SCXML invoker** (type `scxml`) spawns the child named by
  the invoke's `content(definition)` (a definition ID) with core's parent
  link, so core routes `#_<invokeid>`, `#_parent` and `done.invoke` itself;
  the invoke's params become the child's data binding; exiting the parent's
  state destroys the child.
- **Log sink:** `<log>` records `{ source, label, hasValue, value }` reach
  the sink after the turn.
- **Scale (`scale.js` variant `ws`):** at 4M actors, 2.6 µs (Node) and
  1.7 µs (Bun) per inbound message, including the outbound write and
  re-arming the timeout. The addon makes no allocator call in steady state,
  and neither does core. See `docs/scale.md`.
- **A core finding:** core's delayed-send owner heap grows by doubling
  (`ta_timer_reserve_heap`, `tinyactors-core/src/timer.c`). With one timeout
  per actor, core's largest block is 32 MiB at 4M actors, and the spawn that
  crosses a power of two copies the whole heap. That is the spike core
  ADR 0063 removed from the actor table. `scale.js` reports it, and holds
  the addon's own largest block flat. It needs a core change, like ADR 0063.

### 14. Persistence and replacement

- Capture, unload, load and reconstruct, through generated calls with
  hooks.
- `prepareReplacement()` and `activate()`.
- A virtual actor keeps its session ID across unload and load, but gets a
  new runtime ID (core ADR 0066). The JavaScript API names it by address
  or session ID. An `ActorID` held from before the unload fails with
  `not-found`.

Exit criterion:
- an actor with pending delayed sends round-trips through capture and load;
- a named actor is replaced in place with no lost messages;
- a delayed send to `#_scxml_<sessionid>` armed before an unload reaches
  the actor after it is loaded again.

What was built (`lib/image.js`, `test/persist.js`):
- **Images:** `capture()` returns a `SessionImage` over core's handle. Its
  finalizer, `destroy()` and `close()` release it, so it never outlives its
  system (ADR 0012). Core's image does not hold the data-model root, so the
  `SessionImage` keeps the root the actor had at capture, and `load()` and
  `reconstruct()` bind it unless given another `binding`. It is the same
  object: reconstructing an image of an actor that still runs shares its
  data unless a binding is passed.
- **Unload:** throws `busy` while the actor has mail waiting, is inside a
  macrostep or is quarantined, so it never drops accepted mail. Mail to an
  unloaded address is a dead letter with reason `unloaded`; mail is not held
  for it, and nothing loads it on demand. (ADR 0020 later added loaders:
  mail waits while a family's loader brings the actor back.)
- **Load:** the same session ID, a new runtime ID, the address resident
  again. Delayed sends travel in the image, including ones that fell due
  while the actor was out. An invocation active at capture does not come
  back: the actor gets `error.communication.invoke.<id>.unavailable` (core
  ADR 0038). After `removeUnloaded()`, `load()` of its image fails with
  `stale`.
- **Replacement:** `prepareReplacement()` binds the incumbent's live root by
  default. `activate()` throws `busy` while the incumbent is inside a
  macrostep. Otherwise it publishes the replacement, whose hook moves the
  incumbent's waiting mail and `send()`s, in order, to the front of the
  replacement's mailbox (ADR 0005 point 12), and then destroys the
  incumbent.

### 15. Tracing

Done (ADR 0015, then ADR 0016; core ADR 0067): `System.setTraceSink(sink,
{ kinds, unsampled, resource, values, parent, seed })` hands the spans that
ended in each turn to JavaScript as one OTLP protobuf request, encoded in C
by the portable `src/otlp.c`; core's null sink runs without one.
`options.traceparent` on `post()`, `send()` and `spawn()`, and a started
trace when there is none; `request.traceparent` for I/O processors and
invokers. `lib/otlp.js`: `decodeTraces`; `lib/tracing.js`:
`parseTraceparent`, `formatTraceparent`, `stepSpanID`; no telemetry
dependency. `tools/otlp.js` (tests and `mise run otel-demo` only) posts
the bytes. Tests: `test/tracing.js`, `test/otlp.js`, `test/otel-sdk.js`
(the official SDK, a pinned dev dependency), `test/native/otlp_test.c`;
bench: `test/bench/tracing.js`. See `docs/tracing.md`.

### 16. Observability at 3am

Done (ADR 0017; core ADRs 0072 and 0073):
- **Off and sampled out cost next to nothing.** Core parses `traceparent`
  and makes trace IDs, and `mise run bench-check` holds both paths to a
  40 ns budget.
- **Detail.** `detail` presets default to `summary`, `sample` sets the
  ratio of traces sampled, and `configureTraces()` changes both in place.
  `watchTraces({ sessions, families, addresses })` traces one actor,
  definition or request in full.
- **Replies** from I/O processors and invokers stay in the request's
  trace.
- **Logs.** Failures and `<log>` reach the sink as OTLP logs,
  `sink(traces, logs)`, rate-limited.
- **Metrics.** `system.metrics()` returns core's counters, occupancy,
  messages and memory as plain data, and `metricsToOTLP()` writes them as
  OTLP.
- **Failure logs say why:** the failing action's label and the thrown
  message, in the body and as `exception.message`.
- **Host metrics:** turn duration and timer lateness as histograms with
  exemplars, overdue timers, the run queues, quarantine, faults by code,
  dead letters by reason; quarantines and dead letters are also logs.
- **The SDK example** with observable instruments, tested against the
  official metrics SDK (a dev dependency).
- **Tests:** `test/tracing.js`, `test/metrics.js`, `test/otel-metrics.js`,
  `test/native/otlp_test.c` and `test/native/host_metrics_test.c`.

Done (ADR 0018): the encoder reports a request's size and writes it into
memory the host provides; napi writes each request straight into a
`napi_create_buffer` block, with no zero-fill and no second copy.

Open (ADR 0017's implementation notes, follow-up of 2026-09-25, and ADR
0018's notes):
- the traced-path targets, unchanged by ADR 0018: about 530 ns per event
  over untraced for macrostep spans against about 280, and 1,470 for every
  record against 780. Next: build each span once in the staging buffer
  instead of assembling and appending it, encode constant keys in
  advance, slimmer summary spans; profile per span phase first;
- Bun's budgets for `traceparent` and sampled out.

## Open follow-ups

**Core findings** (measured in `scale.js`, recorded in `docs/scale.md`):
- ~~every executed `<send>` makes one allocation and one free in core
  (step 7)~~ and ~~a chart with a top-level `<final>` makes core allocate
  and free once per delivered message (step 10)~~: both gone, fixed on the
  way by core ADRs 0069 and 0070. `test/allocations.js` and `scale.js` now
  assert zero core allocator calls per event after warm-up;
- ~~the delayed-send owner heap grows by doubling~~: paged like the actor
  table (`84dfd0a`), so core's largest block stays 64 KiB at every
  population.

**SCXML conformance gaps** (found while checking the spec for the
[distributed systems proposal](../docs/proposals/distributed-systems.md)):
- event data sent between sessions is shared, not copied. SCXML C.1 says it
  MUST be a copy, so that a mutation in one session never shows in the
  other. The JavaScript data model shares objects by reference (ADR 0011).
  Fixing it needs a core data-model operation for values leaving a session
  (gap G4);
- ~~`ioProcessors` lists only the SCXML processor~~: done (gap G2, core
  ADR 0068). `ioProcessors` lists every processor, with the location its
  `registerIO(type, processor, { location })` template renders. Gaps G1 and
  G3 are fixed too: `post()`/`send()` take `options.origin` (a request's
  URI, a scope from `openScope()`, or a token rendered by an `origin`
  template), and events from invoked services name the service's type as
  `originType`.

**Open decisions:**
- ~~importing XML charts whose expressions are ECMAScript source text~~:
  **done, ADR 0019.** `registerDatamodel(name, { compile })` and
  `define(xml, { format: 'scxml' })`, with the SCXML codec linked in and
  `tools/ecmascript-datamodel.js` as the example compiler. The W3C IRP
  suite runs against the addon (`mise run irp`): all 176 that run pass
  (2026-09-25), and `test/irp/expected-failures.json` is empty. The SCXML
  child-session invoker is done (ADR 0021), and so are the `<data src>`
  resolver and `value_text`'s `TA_OP_NOMEM`. Tests 496 and 521 pass since
  ADR 0022: mail a chart sends to a target that does not exist raises
  `error.communication` in the sender (decision 8, option A);
- ~~the public spec shape uses core's C field names~~: **decided
  2026-09-25, keep them** (option A). Specs keep core's and SCXML's names
  (`onentry`, `history_shallow`, `{ kind, … }`), as ADR 0013 point 6 says;
  the `statechart()` builder is the camelCase API;
- ~~loading unloaded actors on demand when mail arrives for their
  address~~: **done**, ADR 0020. `setLoader(family, loader, { timeout,
  maxWaiting })` and `wakeAt(address, time)`; the waiting mail and the
  loads are portable C (`src/loads.{c,h}`) that moves to the host kernel.
  Dead letters carry their message's data and `traceparent` (a9a47d7), so
  an outbox replays a refused message as it was;
- network handoff of actors, modeled explicitly with I/O processors rather
  than by serializing session images;
- a host-neutral `lib/` shared with a WebAssembly browser build;
- size-class pools behind the allocator, if the steady-state measurement
  asks for them (ADR 0014);
- ~~a limit that quarantines runaway actors (ADR 0008)~~: **done**, core
  ADR 0075. A macrostep that runs `scheduling.microstepLimit` microsteps
  (default 100,000; per definition with `define(chart, {
  microstepLimit })`) quarantines its actor with fault code `runaway`,
  after a `tinyactors.macrostep.long` log at a tenth of it. It counts
  microsteps, not turns, so a long `<foreach>` never trips it.
  `release()` lets the macrostep finish;
- ~~holding and releasing an actor's mailbox for flow control~~:
  **decided 2026-09-25, nothing new** (option D). Hosts pause an actor by
  unloading it, which keeps graceful restarts easy to reason about. With
  ADR 0020's loader, a loader answers "not now" during shutdown so mail
  does not load the actor straight back;
- a helper for naming effects that expands to `send(...).via(...)`;
- ~~an xstate baseline next to the plain-object one in `scale.js`~~: done.
  `SCALE_BASELINES=xstate,object` runs it; `docs/scale.md` has the numbers.

**Tracing** (core ADR 0080, 2026-09-26: definition records are trace kinds for hosts following core's record stream; the addon's OTLP output keeps the definition logs as its one path for definitions. Baseline accepted 2026-09-25, `docs/scale.md`; ADR 0016's
open points on replies, open spans and the name cache are done in
`17b0ca5`; `watchTraces` is a hash set with no limit (`e9d194e`); core
parses a traceparent eight digits at a time (`b9ba91c`); autoforwarding,
UNAVAILABLE and lost invocations are recorded (`74ebe18`); Node is pinned
at the repository root (`abee06b`)):
- Bun stays at or near the 40 ns budgets: a `traceparent` costs 24 to 47
  ns over untraced, sampled-out 29 to 65. The string crossing is about
  10 ns of it and the rest is spread through Bun's runtime, so a
  trace-context handle (`system.traceContext(header)`) would not close
  the gap; revisit only if Bun's Node-API gets faster or a profile shows
  a single cause.
- A watched delivery calls `ta_actor_inspect` to find the session and
  definition; a watch that keyed on runtime IDs would avoid it, at the
  cost of re-keying on unload and load.
- RSS stays above untraced once a sink has traced a burst (Node, 1M
  actors: 1,124 bytes per actor against 669). Native bytes are back to
  untraced (ADR 0017's follow-up of 2026-09-26); the rest is the malloc
  behind the freed staging buffer keeping its pages. Encoding a burst in
  smaller pieces, or handing large turns over part by part, would lower
  the peak itself.
- Mail carrying a trace parent keeps a 48-byte parent per queued message
  in a pool that stays at its high-water mark, as the envelope pool does:
  a burst of N queued traced messages leaves N parents on the free list.

**Offloading** (core ADR 0074, 2026-09-25; `docs/scale.md`):
- the 208 bytes kept per unloaded address (core 114, directory 45, value
  box 32, scheduling 17) cap what offloading saves: we need to learn more,
  then shrink them with a measurement;
- core's offloaded bytes are about 250 per stable actor, not the 60 the
  ADR estimated: compact the layout;
- a load from the offload store does not run under the trace parent of the
  mail that caused it;
- the test host's RPC carries `ta_bytes` as a JSON string, so its scenarios
  cannot offload; a binary-safe encoding would let them.

**Child charts** (ADR 0024 and core ADR 0077: nested at define time,
reused by identity, freed with their children; ADR 0023's cache is gone;
kept resolvers go when core frees their definition, core ADR 0079; every
definition event is counted and logged by origin, and the watch's sets
shrink as definitions go, `docs/tracing.md`):
- the binding filter still exports the child's whole definition on every
  invoke to read its declared `<data>`; cache the names per definition;
- a `resolve` is found by a linear search of the kept resolvers, one per
  definition defined with it; a map by definition ID would make it
  constant;
- a repeated `define()` of the same text, and each invoke of the same
  `<content expr>` text, still decodes and compiles before identity answers
  it: see ADR 0024's notes for the cost.

**Debugging** (ADR 0026, with core ADRs 0082 to 0085):
- measure the jump branches of ADR 0026 with `bench-compare` against the
  base they sit on, on a quiet machine.

**Later:**
- port the tinyactors-test scenario suite to run against the addon;
- consider publishing a filtered raw core module (it would need an ADR,
  see ADR 0013);
- add bulk mutation only when a measurement justifies it (ADR 0003).
