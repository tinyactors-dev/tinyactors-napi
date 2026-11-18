# The browser package: design (p5-design)

**Status:** design, 2026-10-18, written before any code (docs/plan.xml,
`p5-design`), refuted by a fresh agent and revised with the
coordinator's decisions on its verdicts (below, "Refutation"). The plan's
steps p5-build to p5-quickjs are refined from it.

The maintainer decided (2026-10-17, plan.xml phase p5): core compiled to
WebAssembly with a JavaScript layer over it, not the Node-API addon over
emnapi; the same JavaScript API in Node.js, Bun and the browser (one
`index.d.ts`); no quickjs at first; async continuations on the same
thread's event loop; arenas over an allocator, never `malloc` and `free`
per block; user convenience balanced against performance. This document
answers the step's questions within those decisions. Every number below
was measured on 2026-10-18 on this machine (x86_64 Linux 6.18, 4 CPUs,
node 22.23.3, bun 1.4.1, Chromium 141.0.7390.37 from the pre-installed
Playwright 1.56.1); the programs are in `tools/spikes/browser/`.

## Contents

- [Summary](#summary)
- [Whom it serves, and who pays](#whom-it-serves-and-who-pays)
- [The frame](#the-frame)
- [Measurements](#measurements)
- [What is C and what is JavaScript](#what-is-c-and-what-is-javascript)
- [The loop on the event loop](#the-loop-on-the-event-loop)
- [Memory](#memory)
- [How values cross](#how-values-cross)
- [The native datamodel without node:vm](#the-native-datamodel-without-nodevm)
- [Lifetimes](#lifetimes)
- [One API](#one-api)
- [Packaging and releases](#packaging-and-releases)
- [Node.js and Bun](#nodejs-and-bun)
- [Exceptions, an unclosed host, the floor, the address space](#exceptions-an-unclosed-host-the-floor-the-address-space)
- [Not chosen](#not-chosen)
- [Decisions and open choices](#decisions-and-open-choices)
- [Refutation](#refutation)
- [The steps after this one](#the-steps-after-this-one)

## Summary

| Question | Recommendation | Evidence |
|---|---|---|
| What is C | core, the host, the compiler, txml, and a C layer of ours (`ta_web_*`) that builds core's structs, owns the arenas, runs the drain and the turn, reads CBOR and effect fields, and forwards the datamodel's vtable to imports | ADR 0009 ("only C touches host structs"); staticjs-js's `src/js.c` is the same split (ADR 0013) |
| What is JavaScript | the classes, scheduling (`setImmediate` where it exists, else `MessageChannel`; one `setTimeout` at the deadline), the handlers' dispatch, making JavaScript values from CBOR tokens and back, the native datamodel's side (with the addon's `realm.js`, shared) | a wasm module cannot make JavaScript objects (root ROADMAP.md, "Decided later") |
| Download | built: 137 KiB brotli at `-Oz` (core, the compiler, txml and our C layer; 166 KiB at `-O2`); quickjs later as a second module, about 300 KB brotli more | "Sizes" |
| Boundary | 5 to 11 ns a call either way, against 75 to 210 ns for a Node-API call; a short string 50 to 600 ns depending on how it is copied | "Boundary costs" |
| Memory growth | no view of linear memory outlives a call that can allocate: the layer re-derives its views when one reads `byteLength === 0` (1 to 2.4 ns); nothing the application holds is a view | "Memory" |
| Native datamodel | one shared realm per host (a hidden iframe on a page, `node:vm` in node and bun, the worker's own global in a Worker); a chart that declares nothing: a scope per session, as the addon (49 B); a declaring chart, `var` or lexical: one session function per chart, made once from its chart-level scripts' text, called once per session (634 B, 3.6 us in Chromium), never an iframe per session; what it cannot match is refused at attach or reported, never a silent difference | "The native datamodel without node:vm" |
| CSP | the module needs `'wasm-unsafe-eval'`, the native datamodel `'unsafe-eval'`; without it, under a CSP `sandbox`, or with Trusted Types enforced, a host on the native datamodel is refused at creation (`TA_ERROR_UNSUPPORTED`, the message naming the directive) and quickjs (later) is the way | spike, "CSP" |
| Exceptions | every import catches and returns a status; an exception that escapes into wasm, or a `WebAssembly.RuntimeError`, poisons the instance, and every host on it refuses with a fault naming the cause; the stack size is set explicitly | the refuter's spike: 1,000 throws leaked 256 KB of shadow stack |
| Values | CBOR is read and written by core's `ta_cbor_reader` and `ta_cbor_writer` in C, one token per call, and JavaScript makes the values; payloads of the native datamodel are never encoded (a row in `ta_table`, the value at its slot in a JavaScript array, as the addon) | "How values cross" |
| One API | one `index.d.ts`; one source of tests, made runtime-neutral (harness and helpers), run against the wasm package by an export condition in node and bun and by an import map in Chromium, with a few documented exclusions; a parity check of the exports | "One API" |
| Loading | top-level `await` in the entry by default, and an explicit `@tinyactors/wasm/init` (`await init(url?)`) for Service Workers and old bundlers; target es2022 | "Packaging and releases" |
| Package | a sibling package `@tinyactors/wasm`, made from `tinyactors-napi/` at the same version, changelog and tag, released to `tinyactors-dev/tinyactors-napi` | "Packaging and releases" |
| Node and Bun | the wasm package is supported there (its tests run there anyway), the way on Windows, which has no addon; no silent fallback in `@tinyactors/node`; whether one implementation can go is decided on measurements at p5-parity | "Node.js and Bun" |

## Whom it serves, and who pays

Following [docs/roles.md](../../docs/roles.md):

- **First: the application developer writing JavaScript for a browser**
  (a page's or a worker's statecharts: UI flows, offline sync, games),
  who wants the API they know from Node.js, charts compiled in the page,
  and values that are JavaScript values. Today nothing answers them: the
  addon needs Node-API, and the old web binding was deleted with the
  bindings (`997706b8`).
- **Then: the application developer on a platform with no addon**
  (Windows: `mise/pack.rb:46-49` builds macOS and Linux only), and the
  **maintainers**, who run one suite and one set of test files against
  both packages.
- **Out of scope:** quickjs in the browser (p5-quickjs, later);
  run-time fetching (`TA_EFFECT_REQUEST` stays answered in C with
  `TA_ERROR_INVALID`, as the addon does); a convenience layer of the
  browser's own (the existing one is shared); changes to core.
- **Who pays:**
  - *download:* about 175 to 190 KB brotli for the module (estimate:
    core and the compiler measured, txml measured, our C layer not), plus
    the JavaScript layer (unmeasured);
  - *per event:* core's part of an event costs 1.1 to 2 times its native
    cost in wasm (0.1 to 0.25 us more on a 5.2 us event of the addon's);
    each crossing costs 5 to 11 ns where a Node-API call costs 75 to 210
    ns, so the JavaScript side may be cheaper than the addon's
    (unverified until p5-api's benchmark);
  - *per actor:* the same as the addon for a chart that declares nothing
    (a scope object); about 634 B for a declaring chart's session (its
    session function's call), against the addon's 60 to 143 KB `node:vm`
    context;
  - *memory:* linear memory never shrinks, so a page keeps its peak
    (core's `allocator_wasm.c`; bindings.md section 11);
  - *API surface:* none: the same `index.d.ts`;
  - *work in every binding:* a second implementation of the JavaScript
    API's plumbing (a C layer of a few thousand lines, unverified, and
    the JavaScript classes and datamodel), held to the addon by shared
    tests, the suite and a parity check; every later API item is written
    twice. This is the largest cost, and "Node.js and Bun" says how it
    could shrink.

## The frame

Facts the design depends on, each checked:

- **One thread per host.** Every call comes from the thread that made the
  host (bindings.md section 5); in a browser there is no other thread
  that can reach a module instance's memory unless it is shared, and ours
  is not. Reentrancy is on that thread only: a handler calling the host,
  a getter, a datamodel expression.
- **Inputs are read during their call; effects and the host's outputs
  live until `ta_host_effects_ack`** (ADR 0012; `tinyactors-core/docs/boundary.md`).
- **Only C reads core's structs** (ADR 0009, "Only C touches host
  structs"; boundary-design skill, rejected ideas: "Struct layouts read
  from Python or JS"). The old web binding read them at wasm32 offsets
  generated from the API descriptions (`git show 997706b8^:tinyactors-core/bindings/web/README.md`),
  before ADR 0009.
- **Core's wasm builds today:** `mise run wasm:test` builds
  `tinyactors.wasm` (wasm32-freestanding, its own page allocator,
  `src/base/allocator_wasm.c`), `tinyactors_runtime.wasm` and
  `tinyactors_datamodel_ecmascript.wasm` (wasm32-wasi with wasi-libc
  compiled in, `-mexec-model=reactor`, `_initialize` exported), each
  importing nothing and exporting the API (`mise/lib/c_release/build.rb:359`,
  `CRelease.build_wasm`; `link_flags` lets a binding add its own).
  `include/tinyactors/wasm.h` gives `ta_wasm_alloc` and `ta_wasm_free`;
  the runtime module's are `aligned_alloc` and `free` over wasi-libc
  (`dist/tinyactors_runtime_wasm.c`). `tests/wasm/release_test.mjs`
  drives a module from JavaScript by struct offsets, as a test.
- **The compiler needs the C library** (`src/compile/compile_support.c:4`
  includes `stdlib.h`; `tinyactors_runtime` is `libc: true`,
  `tinyactors-core/mise/core.rb:124`), so our module is a wasm32-wasi
  reactor like the runtime module.
- **staticjs-js is the pattern** (ADR 0013): its C layer (`src/js.c`)
  calls the library's API, its exports take and return numbers, the few
  records JavaScript reads are the layer's own arrays of words, and its
  module imports `staticjs_js.native` and `staticjs_js.release`
  (staticjs-js/AGENTS.md). Its loader resolves the module with
  `new URL('./staticjs.wasm', import.meta.url)` and reads a `file:` URL
  with `node:fs` (staticjs-js/index.mjs); its Chromium test serves the
  package and imports it in a page (staticjs-js/test/browser.test.mjs).
- **The addon:** about 11,900 lines (`src/`, `lib/`, `index.d.ts`), of
  which the native datamodel is 2,800 (`src/datamodel/`, its kit
  `realm.js` 423 lines of plain JavaScript run in every `node:vm`
  context); its loop, drain, dispatch and values are C over Node-API.

## Measurements

### Sizes

Core's release modules as `mise run wasm:test` builds them (`-O2`), and
spike builds with the same zig (`tools/spikes/browser/`, commands in
"Reproducing"). "Stripped" drops the custom sections (names, DWARF):

| Module | File | Stripped | gzip -9 | brotli 11 |
|---|---|---|---|---|
| `tinyactors.wasm` (core, host, OTLP, HTTP codec; no compiler) | 418,617 | 409,450 | 146,783 | 116,288 |
| `tinyactors_runtime.wasm` (the above, the compiler, wasi-libc) | 1,403,617 | 504,137 | 181,071 | 144,949 |
| `tinyactors_datamodel_ecmascript.wasm` (core and quickjs) | 2,551,245 | 1,527,647 | 530,218 | 417,059 |
| core and compiler, only the 95 functions the addon calls exported, `-O2` | | 481,854 | 174,918 | 139,269 |
| the same at `-Oz` | | 331,958 | 135,528 | 113,560 |
| txml (`tinyxml/include/txml.c`), `-O2` / `-Oz` | | 119,685 / 77,004 | 39,505 / 29,207 | 31,502 / 24,989 |
| built (p5-build): `wasm/tinyactors.wasm`, core, the compiler, txml and the `ta_web_*` layer, `-O2` | 1,489,057 | 587,632 | 207,009 | 164,838 |
| built (the release, `mise run pack:wasm`, 2026-10-18): the same at `-Oz` | | 421,735 | 167,215 | 139,810 |
| built (p5-quickjs, 2026-10-18): the same and quickjs, one module, `-Oz` | | 1,177,513 | 467,200 | 386,800 |

- Exporting only what the layer calls saves little (139 KB against 145
  KB brotli): almost all of core is reachable from the host.
- `-Oz` saves 19 % on core and the compiler (139 KB to 114 KB), 18 % on
  the built module (170 KB to 140 KB brotli), for about 3 % more per
  event of core work (`l-p5-pack-oz`); the module is built at `-Oz`.
- The release's `tinyactors_runtime.wasm` carries 899 KB of DWARF
  (`.debug_info`, `.debug_loc`, `.debug_line`, ...) though its sources
  compile with `-g0`: they come with the C library's objects (unverified
  where exactly). Our module strips custom sections; logged for core as
  `l-p5-design-release-wasm-debug`.
- A wasm32-wasi link starts with 257 pages (16 MiB) of memory, the
  freestanding one with 17 (spike: `memory.buffer.byteLength` after
  instantiation); likely the linker's default stack size (unverified;
  p5-build sets and measures it).
- For scale, not measured here: quickjs is about 300 KB brotli of the
  ECMAScript module (417 KB less core's 116 KB).

### Boundary costs

`tools/spikes/browser/bench.mjs`, 2,000,000 calls each (str2.mjs: a
million), ns per operation:

| Operation | node | bun | Chromium |
|---|---|---|---|
| JavaScript calls a wasm export | 5.2 | 5.0 | 10.9 |
| wasm calls a JavaScript import | 6.6 | 8.2 | 8.5 |
| a Node-API call: the addon's `decode` of `null` (its arena mark included) | 75 to 88 | 210 | — |
| a 16 B string in: `TextEncoder.encodeInto` over a `subarray` | 86 to 92 | 95 | 588 |
| a 16 B string in: a loop of `charCodeAt` (ASCII; else `encodeInto`) | 51 to 109 | 61 | 76 |
| a 16 B string out: `TextDecoder.decode` over a `subarray` | 157 to 188 | 104 | 263 |
| a 16 B string out: `String.fromCharCode.apply` | 231 | 137 | 146 |
| `memory.buffer` read and compared | 27 | — | 30 |
| a view's `byteLength === 0` | 2.4 | 1.0 | unmeasured |
| `String.prototype.isWellFormed` (lone surrogates) | 6.3 | — | 26 |

So a crossing is nearly free, and text is what costs: a string in is a
copy into linear memory, a string out a decode. The layer copies ASCII by
hand and reads text lazily (thin views), and never reads `memory.buffer`
per access.

### Core's cost per event

`tools/spikes/browser/perevent.c`: one actor of a two-state chart, the
null datamodel, tracing off; `ta_system_send`, `ta_runtime_run`, a take
and an ack per event; three runs of a million, the last three of eight
rounds:

| Build | ns per event |
|---|---|
| native (zig, `-O2`) | 261, 284, 288 |
| wasm32-wasi in node (`node:wasi`) | 392, 392, 534 |
| wasm32-wasi in bun | 370, 513, 310 |

Core's part runs 1.1 to 2 times slower in wasm. The addon's whole event
on the native datamodel is 5.2 us on node (AGENTS.md, "Measured cost per
session"), so core's part is about 5 % of it and the wasm penalty on it
0.1 to 0.25 us. Chromium was not measured (the same V8 as node:
unverified).

### Realms

`tools/spikes/browser/drive.mjs`, Chromium; the JavaScript heap after two
collections (`Runtime.getHeapUsage` through the DevTools protocol) and
the renderer's resident set (`/proc`), divided by the count:

| A session's datamodel state | Made | JS heap each | Resident each | Time each |
|---|---|---|---|---|
| a scope object in the host's realm (a chart that declares nothing; the addon's shape) | 10,000 | 49 B | 46 B | — |
| a generator in the host's realm, one script of three `var`s and a `function` run in it | 10,000 | 245 B | 248 B | 3 us |
| a same-origin iframe | 200 | 350,793 B | 607,744 B | 3.6 ms |
| (the addon's `node:vm` context per session, AGENTS.md) | | 143 KB node, 60 KB bun | | |

- A generator session's evaluation is a direct `eval` in it: 230 ns for
  `count < 3`, against 82 ns for the shared chart's compiled
  `with (scope)` function (Chromium, 200,000 each).
- The generator (`realms2.mjs`) keeps its `var` and `function`
  declarations between scripts, its functions close over them, two
  sessions do not see each other's, nothing lands on the realm's global
  or the page's, a throwing script leaves it running (a `try` inside the
  generator), and a script after `throw 0;` instantiates its declarations
  without running a statement (a `function` declared so closes over the
  `var` set later). It does not keep `let`, `const` or `class`, nor the
  `var`s of a script that starts with `'use strict'` (a strict `eval` has
  its own variables); its two protocol names (`__tinyactors_in` and the
  catch's) are visible to chart code; an undeclared assignment in sloppy
  code lands on the realm's global. The same generator works in a
  `node:vm` context on node and bun (`vmgen.mjs`).
- **The session function per chart** (`chartgen.mjs`, run in an
  iframe's realm in Chromium and in a `node:vm` context on node and bun;
  `drive4.mjs`, `chartgen-node.mjs`): the chart-level scripts' text,
  joined, is the body of one sloppy function made with the realm's
  `Function` at attach, the `<data>` ids its `var`s, and a generator
  declared in it (hoisted, so it exists before a script can throw) runs
  each later evaluation as a direct `eval`. In all three runtimes: `let`,
  `const` and `class` are kept between scripts and are each session's
  own; a function of an earlier script sees a `const` of a later one; a
  `const` assignment throws; nothing lands on the realm's global; a `var`
  a script of executable content declares persists in its session, and a
  `let` there is its own at each run; a restore runs the function with a
  `throw 0` ahead of the scripts, so its functions exist and close over
  the `var`s set afterwards. Cost: 634 B of heap and 3.6 us a session in
  Chromium (2.2 us bun, 7.9 us node); an evaluation of `count < 3` as a
  direct `eval` 507 ns (Chromium), 485 ns (bun), 1,855 ns (node). It
  differs from the addon (`addon-declaring.mjs` shows the addon's side)
  in four places: a chart-level script that throws stops the later ones
  of that session (the addon runs them); an undeclared sloppy assignment
  lands on the host's realm (the addon's lands on the session's own
  global and is hibernated); a declared `eval` shadows the loop's
  (`var eval`, `function eval`), and `let __tinyactors_loop` is a
  `SyntaxError` at attach; `arguments` is the function's (`object` on
  node and Chromium). Counting the realm's global names to find a leaked
  assignment costs 7 to 9 us on node and bun and 125 us in Chromium (an
  iframe's window has many), too much per script.
- An iframe removed from the document keeps running: its realm's
  functions, `eval` and constructors still work after `f.remove()`
  (`detach.mjs`, Chromium 141).
- `ShadowRealm` is absent from Chromium 141 and node 22; bun 1.4.1 has
  one. `WebAssembly.Memory.prototype.toResizableBuffer` is absent from
  Chromium 141 and node 22, present in bun.

### Scheduling, Workers and CSP

- A chain of 200 turns: `setTimeout(fn, 0)` 4.045 ms a turn (the nesting
  clamp), a `MessageChannel` message 0.011 ms (Chromium).
- A module Worker has no `DOMParser`, no `document` (so no iframe), no
  `setImmediate`; it has `MessageChannel`, `WebAssembly`, and
  `new Function` (no policy).
- Pages served with a Content Security Policy (`csp.mjs`, `drive3.mjs`):

  | `script-src` | `WebAssembly.instantiate` | `new Function` | an iframe's `eval`, `Function` |
  |---|---|---|---|
  | `'self'` | refused (`CompileError`) | `EvalError` | `EvalError` |
  | `'self' 'wasm-unsafe-eval'` | works | `EvalError` | `EvalError` (the policy is inherited) |
  | `'self' 'unsafe-eval' 'wasm-unsafe-eval'` | works | works | works |

  Trusted Types (`require-trusted-types-for 'script'`) also guards
  string evaluation: not spiked (unverified).

## What is C and what is JavaScript

The rule that decides: **what reads or writes core's structs, owns
memory, or must hold an invariant is C; what makes or calls JavaScript
objects, or schedules, is JavaScript.** "Nothing C does is done again in
a language" (ADR 0009, Consequences) is kept by doing each thing once,
on the side that can.

| Piece | Where | Why |
|---|---|---|
| core: base, image, trace, core, system, host, OTLP, BasicHTTP; the compiler and runtime; txml | C, from core's and tinyxml's amalgamations | the library |
| the host's creation and free, the allocator, the host's arena and a mark per call, the environment's arena for `encode`, `decode`, `compileCharts`, `Address` | C (`ta_web_*`) | allocation by lifetime, as the addon (AGENTS.md, "The binding's memory") |
| inputs (`spawn`, `send`, `sendMany`, `terminate`, `boot`, `wake`, `hibernate`, `migrate`, ...) | C builds core's structs from the layer's own input record, words written by JavaScript in the order its header states, the text JavaScript copied into the call's arena | only C touches core's structs; the record is ours, as staticjs-js's |
| the drain and the turn | C: `ta_web_turn(host)` returns what the driver does next (yield, idle with a deadline, exhausted, fault), and calls one import per effect JavaScript must see | "one drain at a time" made structural: no take or ack is exported, so no handler can nest a drain; the guide's two functions in C, as both bindings (bindings.md section 3) |
| effects JavaScript never sees: `REQUEST` (resumed with `TA_ERROR_INVALID`), `DONE` and `ERROR` (rows released), `SEGMENT_FREED`, an unknown `NOTIFICATION`, a `REPLY`'s lookup in the pending table | C | the addon's rules, with no crossing |
| an effect's fields | C accessors over `ta_host_effect_number` and `_text`; JavaScript asks per field, on first read | thin views pay nothing for a field nobody reads |
| the ack counter that makes views stale | C bumps it after the ack; JavaScript reads it | one counter, where the ack is |
| tables: payloads, sessions, charts, loops, pending typed methods, services | core's `ta_table` in C, the JavaScript object at the row's slot of one array per host | no handle table of ours, as the addon (no `napi_ref`: the array) |
| CBOR (config, typed methods' params and replies, `encode`, `decode`, hibernation, snapshots, `to_wire`) | C reads and writes with `ta_cbor_reader` and `ta_cbor_writer`, one token per call | one codec; core validates (UTF-8, nesting, tags) |
| JavaScript values from tokens and back, and the value table's refusals (safe integers, `BigInt`, lone surrogates through `isWellFormed`, plain objects only, tag 32 as `Address`) | JavaScript | C cannot make JavaScript objects |
| scheduling: a turn, the deadline's timer | JavaScript | the runtime's |
| the classes, errors, handlers, thin views, records for promise-returning handlers | JavaScript | the API |
| the native datamodel's vtable | C entries that forward to imports, each with at most three parameters, the rest in the layer's own record | core calls a vtable; imports, not the old web binding's generated module in the function table (that was because the release module imports nothing; ours is the binding's own) |
| the native datamodel's work: scopes, sessions, evaluation, copies, `_event`, XML nodes | JavaScript, with the addon's `realm.js` run in each realm | the same kit, one source, so copies and the DOM behave the same |
| XML content | txml in C parses into the datamodel's scratch arena; the layer writes the tree as its own record; `realm.js`'s `XMLNode` builds it | the addon's DOM; `DOMParser` is missing in a Worker (spike) and makes another DOM |

The module's imports are the layer's own (`ta_web.*`) and its exports
the layer's functions, `memory` and `_initialize`; a check like
staticjs-js's (`mise run build` there checks its imports exactly) holds
it. Our C follows the addon's C rules: the prefix (`ta_web_*`), at most
three parameters, `ta_bytes` in and `ta_buffer *` out, no mutable
globals (state on the host or the environment's record; a module
instance is one environment), allocation only in the tables, the arenas
and the host.

## The loop on the event loop

The addon's rules, unchanged (AGENTS.md, "The loop"), with the browser's
scheduler:

- **A turn** is `ta_web_turn` from a macrotask: `setImmediate` where it
  exists (node, bun: the addon's, so liveness is the same), else a
  `MessageChannel` message (a page, a Worker: 0.011 ms a turn, where a
  chained `setTimeout(0)` waits 4 ms). One pending at a time; an input
  from outside a turn schedules one; a turn at its bound (64 runs, 64
  batches) yields the same way.
- **The deadline:** an idle turn arms one `setTimeout` at it, replaced at
  the next idle turn. A hidden tab throttles it; a late timer only makes
  delayed sends late (bindings.md section 11), which the README says.
- **Continuations:** a handler that returns a thenable gets its view
  filled before the ack, and its continuation runs after the turn, on the
  same thread: the addon's rule, the same code path.
- **`idle()`**, errors after the turn, `close()` deferred from a handler,
  `SimulatedClock`: the same.
- **The clock:** `performance.now()` for the monotonic ticks,
  `performance.timeOrigin + performance.now()` for the wall time. A
  browser coarsens it (to 100 us without cross-origin isolation in
  Chromium: unverified), which only rounds the times core stamps.

## Memory

- **The environment's allocator** is the module's `ta_wasm_alloc` and
  `ta_wasm_free` (wasi-libc's `aligned_alloc` and `free`, as
  `tinyactors_runtime.wasm`). Every lifetime has its arena over it, as in
  the addon: the host's `ta_growable_arena` with a mark per call, the
  environment's for module-level calls, the datamodel's scratch arena for
  txml; the arena cap (256 KB a host, 64 KB the environment's,
  docs/allocation.md finding 7) is kept, so a freed chunk is reused by
  another host rather than kept by one.
- **Growth detaches every view** (spike: a `Uint8Array` over
  `memory.buffer` reads `byteLength` 0 after `memory.grow`, and
  `memory.buffer` is a new object). The layer keeps its views
  module-private and re-derives them when one reads `byteLength === 0`,
  after any export that can allocate and before reading memory in an
  import (a handler may have called the host and grown it). Nothing the
  application holds is a view of linear memory: images, telemetry,
  `metrics()`, `hibernate()` and `snapshot()` are copied once into a
  `Uint8Array` (`slice`), as the addon copies into a `Buffer`
  (`tinyactors-core/docs/boundary.md` section 7). `toResizableBuffer`
  would avoid the detaching, but node 22 and Chromium 141 lack it.
- **It never shrinks.** wasm cannot give memory back (core's
  `allocator_wasm.c`), so a page keeps its peak: hibernation makes room
  for other actors, not a smaller footprint (bindings.md section 11). A
  snapshot is packed into a buffer in linear memory (the probed size)
  before it is copied out, so a 100 MB snapshot leaves linear memory 100
  MB larger; the README says so.
- **No `napi_adjust_external_memory`:** linear memory is one
  `ArrayBuffer` the engine already counts.

## How values cross

- **Payloads of the native datamodel are never encoded**, as in the
  addon: a payload is a row of core's `ta_table` in C, its value at the
  row's slot of a JavaScript array; `capture`, `retain`, `release` and
  the input calls cross as handles. `send.data` and `invocation.data` are
  copied into the application's realm on first read (the addon's
  `exported()`, `l-p4-examples-chat-realm`), an XML node as its text.
- **CBOR crosses as tokens.** Where core takes or gives CBOR (the config,
  a typed method's params and its reply, `encode`, `decode`, the
  datamodel's `to_wire`, `from_wire`, `serialize`, snapshots), C holds a
  `ta_cbor_reader` or `ta_cbor_writer` and JavaScript pulls or pushes one
  token per call: the kind and its scalar in the layer's record, text and
  bytes through the call's arena. A reply of 200 tokens costs about 200
  crossings (1 to 2 us) and its strings: the control plane, not the hot
  path. Not chosen: a CBOR decoder in JavaScript over the bytes (a second
  codec beside core's, with its own validation; the boundary-design
  skill's rejected "a language layer ... decoding values").
- **Text in** is copied into the call's arena: ASCII by a loop, else
  `encodeInto`, after `isWellFormed` refuses a lone surrogate (the
  addon's rule). **Text out** is decoded when read: an effect's fields on
  first access, `_event`'s name from the chart's interned names by
  core's `name_id` (the addon's sharing), so an event name is decoded
  once per chart, not per event.
- **Ids** are `BigInt` (`i64` crosses as a `BigInt`), sessions accepted
  as safe integers too, as the addon.

## The native datamodel without node:vm

The addon evaluates charts in `node:vm` contexts, never the
application's realm: one shared context per host for charts that declare
nothing at the top of their scripts (a scope object per session), a
context per session for charts that declare (AGENTS.md, "The native
"ecmascript" datamodel"). A browser has no `node:vm`.

**The host's shared realm** (decided, M3):

| Where | The shared realm | Why |
|---|---|---|
| a page | a hidden same-origin iframe, one per host (608 KB, 3.6 ms, once), removed at `close()` | its own globals and constructors, so `realm.js`'s copies behave as in the addon; a removed iframe keeps working |
| a Worker | the worker's own global | a Worker has no `document`; an application that wants the charts apart from its own code gives tinyactors a dedicated worker, which the README says |
| node, bun | a `node:vm` context (`process.getBuiltinModule`) | the addon's |

Not chosen: a Worker per realm (the vtable is synchronous and a page's
thread cannot `Atomics.wait`); `ShadowRealm` (absent from Chromium 141
and node 22, and only primitives and callables cross it).

**Sessions** (decided, M2):

- **A chart that declares nothing:** a scope object per session in the
  shared realm, the addon's code path (49 B).
- **A declaring chart, whatever it declares:** one session function per
  chart, made at `chart_attach` from the text of its chart-level scripts
  with the realm's `Function` (no parser of ours: the engine compiles
  it), called once per session; its generator runs the session's
  evaluations as direct `eval`s that see the function's `let`, `const`,
  `class`, `var` and `function` bindings ("Realms": 634 B and 3.6 us a
  session in Chromium). No iframe per session, on a page or in a Worker.
  Expressions are evaluated strict, as the addon's are, so an undeclared
  assignment in one throws. Whether each distinct expression is compiled
  once per session into a closure (faster: node's direct `eval` costs
  1.9 us) or evaluated as a direct `eval` each time is measured in
  p5-datamodel.
- **Hibernation, migration and snapshots** as the addon: a `var` and
  `function` chart's variables are read by name in the session and set
  again after a restore that runs the function with `throw 0` ahead; a
  chart that declares with `let`, `const` or `class` refuses hibernation
  with the addon's message (its sessions stay resident: the addon does
  the same, `addon-declaring.mjs`).
- **Where it cannot match the addon, it says so; it never differs
  silently:**
  - a chart that declares `eval`, `arguments` or a name with the prefix
    `__tinyactors_` is refused at attach, the message naming it (the
    engine's `SyntaxError` for a lexical clash, a check of the scratch
    session's `eval` and `arguments` for the rest); the function's own
    `arguments` is shadowed by its prologue;
  - a chart-level script that throws: the session's `error.execution`
    says that the chart-level scripts after it did not run (the addon
    runs them);
  - an undeclared sloppy assignment in a script lands on the host's
    shared realm, as it does for the addon's charts that declare nothing;
    since that name is not the session's, `hibernate` and `snapshot`
    compare the realm's global names with its baseline (one count, at
    those calls only) and refuse with `TA_ERROR_UNSUPPORTED` naming the
    new names, so no state is lost without a word. The README says to
    declare variables.

Which kind a chart is, is asked of the engine at `chart_attach` as the
addon asks it (the scripts after `throw 0;` in a scratch realm). The
suite has one declaring chart (a `var`), the addon's tests have `let` and
`const` ones (`test/datamodel.test.mjs:148`,
`test/hibernation.test.mjs:274`).

**CSP** (decided, with M3). The native datamodel evaluates chart text,
so it needs `'unsafe-eval'`; the module itself needs `'wasm-unsafe-eval'`
(spike, "Scheduling, Workers and CSP"). A host on the native datamodel
is refused at creation with `TA_ERROR_UNSUPPORTED` when the realm's
`Function` is refused (no `'unsafe-eval'`), when the page runs under a
CSP `sandbox` without `allow-same-origin`, or when Trusted Types are
enforced (`require-trusted-types-for 'script'`, which guards string
evaluation even with `'unsafe-eval'`), the message naming the directive.
`compileCharts`'s syntax check of `"ecmascript"` charts
(`l-p4-examples-iot-syntax-unchecked`) parses with the same constructor,
nothing run, and is skipped under such a policy, which the README says.
quickjs (p5-quickjs) is the datamodel for such a page, in a second module
that a page without it does not download (bindings.md section 11).

**As built (p5-datamodel,** `wasm/lib/datamodel.mjs`, `wasm/lib/realms.mjs`;
docs/log.xml, `l-p5-datamodel-*`): the session function is a generator
made inside `with (scope)` (the session's system variables and `_event`),
declaring the `<data>` ids, the `<foreach>` names and the vars of the
scripts of executable content, which stops before each chart-level script
so `<data>` is initialized before the scripts run, as core orders them;
expressions are closures made once per session; the names a chart declares
are found by parsing, not by a scratch realm (a script followed by
`let <name>` that does not parse declares it), so a Worker needs none; the
realm is made at the host's first chart, and the policy is checked at its
creation. A chart-level script with a `'use strict'` directive in a
declaring chart, and a strict script of executable content that declares a
`var`, are refused at attach too. On `fit` the wasm package's event costs
less than the addon's (3.7 against 5.0 us on node, 2.7 against 3.7 us on
bun), its resident memory above the addon's being mostly a fixed cost, V8's
code for the module (`l-p5-datamodel-benchmark`).

**Observation, out of scope:** the generator works in `node:vm` too, so
the addon could give a declaring session a few hundred bytes instead of
a context of 60 to 143 KB. It is not proposed here.

## Lifetimes

| Object | Owner | Created | Read by, when | Ends | Thread |
|---|---|---|---|---|---|
| a view of linear memory (`Uint8Array`, `DataView`) | the layer, module-private | at first need, again when it reads `byteLength` 0 | the layer, during a call | the next growth (detached) | the module's |
| an input's text and record | the call's arena | the method writes it above its mark | core, during the input call | the release to the mark at the method's exit, every path | the host's |
| an effect's text field | core | the take, in C | a thin view, decoded on first read | the ack; the view then throws `TA_ERROR_STALE` | the host's |
| a thin view (`send`, a log entry, `Migrated`) | the handler | the dispatch import | the handler | the ack, by the counter | the host's |
| the record of a promise-returning handler | the continuation | filled before the ack | after the ack | the collector | the host's |
| a host output (traces, logs, metrics, blob) | core | a take | copied once into a `Uint8Array` | the ack; the copy is the application's | the host's |
| a snapshot | a buffer the layer lends in linear memory | `snapshot()`, of the probed size | copied out | freed after the copy | the host's |
| a compiled image | the compile result in linear memory | `compileCharts` | `image` copies it once, on first read | `close()` (`ta_compile_free`) | the creating one |
| a payload's value | a `ta_table` row in C, the value at its slot in JavaScript | capture, `from_wire`, an input | the datamodel's imports; `send.data` copies it on first read | reference count 0, the drop deferred past the outer call | the host's |
| the datamodel's last output (`eval_string`, `log`, `to_wire`, `serialize`) | a buffer the C layer keeps | JavaScript writes it during the import | core | the datamodel's next call | the host's |
| a reply's CBOR | core | the `REPLY`'s dispatch | the layer's reader, token by token, into values | the ack | the host's |
| a pending typed method's handlers | the slot of its `ta_table` row | the method's call | the `REPLY`'s dispatch | its dispatch, or the host's free (dropped, never called) | the host's |
| the host's realm (iframe, context) | the host | at creation | its sessions | `close()` removes the iframe | the host's |

## One API

- **One `index.d.ts`** for both packages. What it says of bytes the host
  hands out becomes "a `Uint8Array`" (the addon's are `Buffer`s, a
  subclass), and `HostOptions.datamodel`'s note names the realm per
  runtime; nothing else in it is Node's (`grep Buffer index.d.ts`: lines
  9, 176, 643, 1118, 1127, 1150).
- **The same exports,** `directoryResolver` included: in the wasm package
  it uses `node:fs` and `node:path` through `process.getBuiltinModule`
  where they exist (node, bun) and throws `TinyactorsError` with
  `TA_ERROR_UNSUPPORTED` at the call where they do not
  (`l-p3-shapes-browser`).
- **The convenience layer is one file.** `lib/convenience.mjs` imports
  `#direct`, a subpath import each package's `package.json` maps to its
  direct layer (the addon's `lib/direct.mjs`, the wasm package's own),
  in place of `./direct.mjs`; the lint rule follows.
- **One source of tests, not unchanged ones** (the refutation): they
  import `@tinyactors/node` by name and their own harness, never
  `node:test`, but `test/charts.mjs` and `test/harness.mjs` read
  `process.env`, call `setImmediate` and reach `node:v8` and `node:vm`
  for the collector. Those two become runtime-neutral (the datamodel and
  the package from a module the runner provides, a macrotask through the
  scheduler the package uses, the collector through a hook each runner
  supplies), a check for a `Buffer` becomes a check for a `Uint8Array`
  (which the addon's `Buffer`s pass too), and the "memory never shrinks"
  case gets a wasm variant (linear memory keeps its peak; the arena cap
  still lets another host reuse it). In node and bun the wasm package
  answers the name under an export condition the test task passes
  (`--conditions=tinyactors-wasm`), which the staged package drops; in
  Chromium a page with an import map runs each file. What stays excluded
  (a file or case that needs `node:fs`, `node:child_process`,
  `node:worker_threads`, or quickjs before p5-quickjs) is listed with its
  reason, and the list is short.
- **The suite** runs through an adapter speaking the driver protocol as
  `conform.mjs` does, in node and in Chromium (p5-datamodel).
- **A parity check** (p5-parity): the two packages' exports compared
  property by property, and `index.d.ts` type-checked against both.
  **As built:** `tools/parity.mjs` in `mise run test` compares, under node
  and bun, every export, the objects the API hands out and what 31
  misuses throw, and each package against `index.d.ts` through the
  TypeScript compiler's API (tsc cannot type the addon, and infers the
  wasm package's JavaScript too loosely to check it); the differences it
  accepts are in `wasm/test/differences.mjs` with their reasons
  (`Buffer` against `Uint8Array`, quickjs, engine artifacts). The user
  documentation runs in Chromium (`wasm/test/documentation.mjs`), and
  `docs/guide/browser.md` says what differs. A snapshot does not cross
  between the packages (each labels its own and refuses the other's,
  naming it), nor does a hibernation blob, which belongs to its host
  (docs/log.xml, `l-p5-parity-crossing`).

## Packaging and releases

**Decided** (M1, which the refutation upheld): **a sibling package,
`@tinyactors/wasm`**, made from `tinyactors-napi/` as the platform
packages already are (`mise/pack.rb` stages `@tinyactors/node-<platform>-<arch>`
from this directory): the same version, the same `CHANGELOG.md` and tag
(`tinyactors-napi/v<version>`), released together and mirrored to
`tinyactors-dev/tinyactors-napi` (ADR 0016 names a release repository
after its directory). Its files: `index.mjs` (the entry, loading the
module with top-level `await`), the layer's JavaScript, the module,
`index.d.ts`, and its `package.json` with `"type": "module"` and plain
`exports`, `"./tinyactors.wasm"` among them so a bundler or a CDN can
place it. Its sources live in `tinyactors-napi/wasm/` (`src/*.c`,
`lib/*.mjs`). Built (p5-pack): `mise run pack:wasm`, and `mise run pack` and the
release with the addon's packages, every tarball at one version
(`mise/pack.rb`, `stage_wasm`). The staged package holds the entries,
`init.d.ts`, `wasm/lib/` and `lib/convenience.mjs` at its root, the
latter's `#direct` written as `./direct.mjs` (a module Worker has no
import map), and drops the `tinyactors-wasm` export condition, which
only the repository's shared tests use.

- Not one package with conditional exports (`"browser"` to the wasm
  build): a browser project would install `@tinyactors/node` and,
  through its optional dependencies, the developer machine's addon, and
  the name says Node.
- Not a directory and component of its own: one API means one version
  and one changelog, and ADR 0016 would give it a release repository of
  its own for no reader.

**Loading** (decided, M4): the default entry awaits the module at the
top level (`new URL('./tinyactors.wasm', import.meta.url)`,
`instantiateStreaming` in a page, `node:fs` for a `file:` URL), so
`import { Host } from '@tinyactors/wasm'` is the same line as in Node.
The old web binding did the same (its README: "top-level `await`,
`instantiateStreaming`"). A second entry, **`@tinyactors/wasm/init`**,
exports the same names and **`await init(url?)`**, for a Service Worker
(which refuses a module graph with top-level `await`) and for bundlers
that do not handle it; a call before `init` settles throws
`TA_ERROR_STATE`. The package targets es2022; esbuild does not follow
`new URL(..., import.meta.url)`, so its users copy `tinyactors.wasm`
beside the bundle or pass its URL to `init`, which the README says.

## Node.js and Bun

The wasm package must run in node and bun anyway: the shared tests run
there (p5-api). So it serves them at no extra cost:

- **Supported there,** with its realm from `node:vm`, and the way on a
  platform without an addon (Windows). `@tinyactors/node`'s error for a
  missing addon (`lib/direct.mjs`) names `@tinyactors/wasm`.
- **No silent fallback** inside `@tinyactors/node`: an application would
  change its memory profile and lose quickjs (until p5-quickjs) without
  asking.
- **Both packages are kept:** `@tinyactors/node`, the addon, for Node.js
  and Bun on the platforms it is built for, and `@tinyactors/wasm` for
  browsers, Workers and Windows, since they will change for different
  reasons. `mise run perevent` measures both side by side, per event and
  in resident bytes per actor.

## Exceptions, an unclosed host, the floor, the address space

From the refutation, each decided:

- **Exceptions never unwind through wasm.** A JavaScript exception that
  crosses wasm frames skips C's cleanup (an arena mark, an ack, a
  depth counter) and leaks the shadow stack: the refuter's spike threw
  1,000 times through an import and leaked 256,000 B of stack, its C
  depth counter left at 1,000. So every import catches everything and
  returns a status, the error kept for the turn to report, as the addon
  reports a handler's. A `WebAssembly.RuntimeError` (a trap: out of
  bounds, the stack exhausted, `unreachable`) or anything else that
  escapes into wasm poisons the instance: every host on it refuses each
  later call with a fault naming the first cause (`TA_ERROR_STATE` and
  the trap's message), and the application makes new hosts after loading
  the module again. The stack size is set explicitly at link
  (`-Wl,-z,stack-size=`), measured in p5-build against the deepest the
  compiler and a run go, rather than the linker's default (the 16 MiB of
  `l-p5-design-initial-memory`).
- **A host nobody closed** is freed by a `FinalizationRegistry`: its
  token frees the host in the module and removes its iframe. The realm
  reaches the host only weakly (the datamodel's imports go through a
  table of hosts the instance keeps by `WeakRef`), so a page's iframe and
  its charts do not keep the host alive. `close()` stays the documented
  way; the registry is a fallback, as the addon's finalizer is.
- **The browser floor** follows from what the module and the layer use.
  zig's default wasm CPU emits `bulk-memory-opt`, `call-indirect-overlong`,
  `extended-const`, `multivalue`, `mutable-globals`,
  `nontrapping-fptoint` and `sign-ext` (the module's `target_features`
  section); `extended-const` is the newest of them, and the layer needs
  es2022 (top-level `await`) and `String.prototype.isWellFormed`. By the
  engines' release notes, that is Chrome and Edge 114, Firefox 119
  (`isWellFormed`) and Safari 16.4 (unverified here: no other browser was
  run). Recommended: keep zig's features, since turning `extended-const`
  off would lower only Chrome's and Safari's floor by a few releases
  while Firefox's stays at 119, unless p5-pack measures that the module
  loses neither size nor speed without it.
- **The address space.** wasm32 linear memory stops at 4 GiB. A region
  that grows is copied into a new block before the old one is freed, so
  at its peak a host needs about twice its region. The wasm scale gate
  runs at two million actors; four million, the addon's `--full` size, is
  beyond the address space with that copy, which the README says.
  `memory64` is logged for the maintainer (`l-p5-design-memory64`).
- **An `i64` crossing as a `BigInt`** costs 10 to 30 ns (the refuter's
  `i64.mjs`), against 5 to 11 ns for an `i32`: sessions cross as
  `BigInt`s at the API, as in the addon, and inside the layer as two
  `i32`s where a call is hot.

## Not chosen

- **emnapi** (the addon over an emulated Node-API): the maintainer's
  decision (2026-10-17).
- **JavaScript reading core's structs at wasm32 offsets** (the old web
  binding): ADR 0009 keeps structs in C.
- **The drain in JavaScript over exported take and ack:** a handler could
  then nest a drain or skip the ack; with only `ta_web_turn` exported it
  cannot. The crossings cost the same either way (5 to 11 ns).
- **The release's `tinyactors_runtime.wasm` as it is:** it imports
  nothing, so the vtable could reach JavaScript only through a generated
  module in its function table, and it exports core's API, which
  JavaScript must not call by struct. The binding builds its own module
  from the release's sources (bindings.md section 11 says to link the
  release's libraries; it does).
- **A JavaScript CBOR codec:** a second codec ("How values cross").
- **`DOMParser`** for XML content: absent in Workers, another DOM.
- **A shared `ArrayBuffer` or `toResizableBuffer`** to avoid detaching:
  not in node 22 or Chromium 141, and a shared memory needs cross-origin
  isolation.

## Decisions and open choices

Each is logged in docs/log.xml; the coordinator decided M1, M2, M3, M4
and M6 on the refutation's verdicts, and M5 stays the maintainer's.

- **M1, the package** (`l-p5-design-package`, decided): a sibling
  `@tinyactors/wasm` from `tinyactors-napi/`, same version, changelog,
  tag and release repository.
- **M2, declaring charts** (`l-p5-design-declaring`, decided): one
  session function per chart for every declaring chart, `var` or
  lexical; refusals at attach and explicit reports where it cannot match
  ("The native datamodel without node:vm").
- **M3, the shared realm and the policy** (`l-p5-design-realm`,
  decided): an iframe on a page, `node:vm` in node and bun, the worker's
  global in a Worker; the native datamodel refused at creation without
  `'unsafe-eval'`, under a CSP `sandbox` or with Trusted Types enforced.
- **M4, loading** (`l-p5-design-loading`, decided): top-level `await` by
  default, `@tinyactors/wasm/init` for Service Workers and old bundlers,
  es2022.
- **M5, two implementations** (`l-p5-design-retire`, decided): both
  packages are kept, the addon for Node.js and Bun on its platforms, the
  wasm package for browsers, Workers and Windows.
- **M6, size against speed** (`l-p5-design-optimize`, decided): `-Oz`
  (the coordinator, after p5-pack's measurement). Measured (p5-pack, `l-p5-pack-oz`): `-Oz` is 421,294 B against
  605,553 B (brotli 139.9 KB against 170.4 KB, 18 % less) and 2.8 % (node)
  and 3.6 % (bun) slower per event on the null chart, 1.8 % and 0.3 % on
  `fit`; the module is built at `-Oz`, its shadow stack measured again
  there (384 KiB, five times the deepest, 65,768 B). `-mno-extended-const`
  gives the same bytes: the feature is in the `target_features` of the
  linked objects, not used by the code, so dropping it buys nothing.
- **The floor** (`l-p5-design-floor`, decided): zig's wasm features
  stay (Chrome and Edge 114, Firefox 119, Safari 16.4), since dropping
  `extended-const` gives the same bytes (above).
- **memory64** (`l-p5-design-memory64`, for the maintainer): beyond
  about two million actors a host needs more than wasm32's 4 GiB.

## Refutation

A fresh agent tried to break the recommendations, with spikes of its own
(the coordinator's session scratchpad, `refute-browser/`); the
coordinator decided on each verdict. The verdicts, and the change each
led to:

| # | Claim | Verdict | Change |
|---|---|---|---|
| 1 | imports may throw into wasm | **refuted**: 1,000 throws leaked 256 KB of shadow stack and skipped C's cleanup | every import catches and returns a status; an escape or a trap poisons the instance; the stack size is set ("Exceptions, ...") |
| 2 | the test files run unchanged | **refuted**: `charts.mjs` and `harness.mjs` use `process.env`, `setImmediate`, `node:v8`, `node:vm`; checks of `Buffer` | the helpers made runtime-neutral, `Uint8Array` checks, a wasm variant of the memory case, documented exclusions ("One API") |
| 3 | a host is freed at `close()` | **plausible gap**: a host never closed, and its iframe, would live for the page | a `FinalizationRegistry`, the realm holding the host weakly |
| 4 | M2, a generator per session for `var`, a realm per session for lexical charts | **refuted as recommended**: the generator differs from the addon, and lexical charts are the common case, so most charts would pay 608 KB | the session function per chart, spiked (`chartgen.mjs`): it keeps lexical bindings at 634 B a session; refusals and reports where it differs |
| 5 | M3, the Worker and the policy | **confirmed, with gaps**: CSP `sandbox` and Trusted Types not covered | the worker's own global documented with a dedicated worker; refusal at creation for `sandbox`, no `'unsafe-eval'`, Trusted Types |
| 6 | M4, top-level `await` | **confirmed for pages, refuted for Service Workers and some bundlers** | `@tinyactors/wasm/init`, es2022, esbuild's copy documented |
| 7 | the browser floor | **unstated** | stated from the module's features ("Exceptions, ...") |
| 8 | memory | **confirmed, with a limit**: four million actors exceed 4 GiB with the region's copy | the gate at two million, the limit documented, memory64 logged |
| 9 | M5, retire on two ratios | **premature** | measured on both datamodels, memory after hibernation included; both packages kept |
| 10 | M1 and M6 | **confirmed** | none; an `i64` as a `BigInt` costs 10 to 30 ns, noted |

## The steps after this one

plan.xml's p5-build to p5-quickjs, refined from this document:

- **p5-build:** `wasm/src/` (the C layer: the host and its arenas, input
  records, `ta_web_turn` with the drain, effect accessors, CBOR token
  calls, the vtable's forwarding, txml's tree record, the poisoned
  state), compiled with core's and txml's amalgamations by
  `Toolchain::Target` (zig, wasm32-wasi reactor, `-Oz`, custom sections
  stripped, the stack size set and measured), its imports and exports
  checked; its lint rules; the loaders (top-level `await` and
  `init(url?)`) for a page, a Worker, node and bun; an import that throws
  and a trap tested; the size and the features reported.
- **p5-api:** the direct layer in JavaScript, every item of
  docs/api-map.md, `datamodel: "quickjs"` refused; `#direct`; the
  `FinalizationRegistry`; the test helpers made runtime-neutral and the
  test files run against the wasm package in node, bun and Chromium,
  exclusions listed; the per-event benchmark beside the addon's.
- **p5-datamodel:** the shared realms (M3), the session function per
  declaring chart (M2) with its refusals and reports, `realm.js` shared,
  XML content through txml, the CSP, `sandbox` and Trusted Types
  refusals, the compile check; hibernation, migration and snapshots; the
  suite in node and Chromium.
- **p5-parity:** the parity check, the documentation and examples in
  Chromium, and the measurements for M5 (both datamodels, memory after
  hibernation).
- **p5-pack:** `@tinyactors/wasm` packed with both entries, `-Oz` and the
  floor measured, smoke-tested from a fresh project in Chromium, node and
  bun and with a bundler.
- **p5-quickjs:** quickjs as a second module, as planned. As built:
  quickjs in the one module, since `new Host` is synchronous and a
  second module would have to be loaded before it by every page anyway
  (docs/log.xml, `l-p5-quickjs-module`); its stack bounded by the
  module's (`l-p5-quickjs-stack`).

## Reproducing

From `tinyactors-napi/tools/spikes/browser/`, with the root's tools
(`mise which zig`, `mise which node`, `mise which bun`):

```sh
zig cc -target wasm32-freestanding -O2 -nostdlib -Wl,--no-entry calls.c -o calls.wasm
node drive.mjs; node drive2.mjs; node drive3.mjs     # Chromium (Playwright from npm root -g)
node run.mjs; bun run.mjs; node vmgen.mjs; bun vmgen.mjs
D=../../../../tinyactors-core/dist
zig cc -O2 -std=c11 -w -I$D perevent.c $D/tinyactors.c $D/tinyactors_runtime.c $D/tinyactors_runtime_hosted.c -o perevent
zig cc -target wasm32-wasi -O2 -std=c11 -w -I$D perevent.c $D/tinyactors.c $D/tinyactors_runtime.c $D/tinyactors_runtime_wasm.c -o perevent.wasm
./perevent; node --no-warnings runwasi.mjs perevent.wasm; bun runwasi.mjs perevent.wasm
node sections.mjs <module.wasm>; node strip.mjs <in.wasm> <out.wasm>
node chartgen-node.mjs; bun chartgen-node.mjs; node drive4.mjs  # the session function per chart
node addon-declaring.mjs  # what the addon does with a declaring chart (needs mise run build)
```
