# For the maintainer: tinyactors-napi after the build-out

The plan's 37 steps are done (2026-10-18). This page lists what waits for
the maintainer, most important first. Each section gives the question, the
options, the recommendation and the evidence. The log entries named in
brackets hold the details ([log.xml](log.xml); edit it with
`tools/planxml.py`). It also lists the decisions already made, the
coordinator's decisions the maintainer may want to overrule, and the work
left undone.

## Open decisions

### 1. The first release (0.3.0 of both packages)

**Question:** what has to happen before `mise run release -- 0.3.0
--publish`?

- **Release repositories:** a release pushes a snapshot of
  `tinyactors-napi/` to tinyactors-dev/tinyactors-napi, tags it
  `v0.3.0` and makes the GitHub release there (`Release.push_and_release!`,
  root ADR 0016). `package.json`'s `repository` names the monorepo, and
  its `homepage` is the release repository's README.
- **Mirroring 0.1.0 and 0.2.0:** already done. tinyactors-dev/tinyactors-napi
  holds `v0.1.0` and `v0.2.0` with their releases ("@tinyactors/node
  0.1.0" and "0.2.0", six assets each; `gh api
  repos/tinyactors-dev/tinyactors-napi/releases`). So 0.3.0 is above the
  repository's latest, which `push_snapshot!` requires
  [l-p2-pack-mirror-first, resolved].
- **The changelog:** the release refuses to run without a 0.3.0 section
  that passes `mise run changelog:check napi`. Write it with the
  **release-changelog skill** (root AGENTS.md, "Releases and changelogs"),
  at release time. The skill's draft does not summarize 307db2f5, which
  is a `test(napi)` commit. That commit gave every addon function the
  name and length that index.d.ts declares, and it made the addon's
  accessors non-enumerable. Mention it in the summary
  [l-p5-parity-changelog-307db2f5, left open for this]. 0.3.0 replaces
  0.2.0's xstate-style API with the direct layer and the convenience
  layer, so its "Upgrading" text tells a 0.2.0 caller to rewrite.
- **Not verified here** [l-p2-pack-unverified]: this container has no
  Docker daemon, so the Linux container smoke tests (Debian, Alpine, Bun,
  both architectures) did not run. The macOS addons were checked by their
  symbols only, and no publishing path ran (npm, tag, push, `--resume`).
  `mise run release -- 0.3.0 --build-only --skip-containers` passed.
- **`@tinyactors/wasm` is a new npm name** (the registry answers "Not
  found"). The `NPM_TOKEN` in fnox must be allowed to create packages in
  the `@tinyactors` scope.

**Decided** (the maintainer, 2026-11-18): publish 0.3.0 now, without
the container and Mac smoke tests. The changelog still goes through the
release-changelog skill for the maintainer's approval.

### 2. The API shape

**Question:** are the convenience layer's names and the cross-binding
rules right before 0.3.0 makes them public?

- **A resolver that names its document** [l-p3-shapes-resolved-name]:
  `directoryResolver` cannot say which file it read, so a `src` inside
  `orders/payment.scxml` resolves against the root. Recommended: let a
  resolver return text or `{name, text}` in both direct layers. Core's
  `ta_resolve_result.source.name` already exists.
- **The newcomer review's wishes** [l-p2-docs-review-wishes]: the typed
  results, the typed `HostConfig` (998b7a3e) and `Address.toJSON` have
  been built. Two wishes are left. Recommended: add the actor's name to
  core's `actor.get` result, and keep refusing a notification when an
  actor ends (ADR 0012).

### 3. Core's defaults for a host

**Question:** should core change defaults that every new user meets?
[l-coord-p2-docs-maintainer]

- **The null datamodel** [l-p2-docs-review-null-datamodel]: a chart
  without a `datamodel` attribute compiles and evaluates nothing, and
  `datamodel="xpath"` is refused at `addImage` without a reason.
  Recommended: core gives a compile warning for expressions on the null
  datamodel, and a diagnostic that names an unknown datamodel.

### 4. What a chart and an operator cannot see

**Question:** should core add semantics that SCXML does not have?

- **A clock that a chart can read** [l-p4-examples-jobs-chart-clock]: a
  chained delayed send drifts by its latency. Recommended: keep SCXML's
  relative delays. If a clock is wanted, put it under `_x` (for example
  `_x.now()`, the host's clock, which a `SimulatedClock` moves too).

### 5. One native datamodel behaviour in both packages

**Question:** should the addon's declaring charts work as the wasm
package's do? [l-p5-design-generator-addon, l-p5-datamodel-differences]

- **Now:** the addon gives a declaring chart a `node:vm` context per
  session, which costs 60 to 143 KB. The wasm package gives it a
  generator session of about 245 B, which works in `node:vm` on node and
  bun too.
- **The differences this leaves:** an Annex B block function, a
  chart-level `let` that shadows a `<data>` id, and an undeclared sloppy
  assignment. Each of them is refused or documented, never silent.

**Recommendation:** accept the differences for 0.3.0. After the release,
make it a step of its own to move the addon to the generator sessions,
behind the shared tests.

**Answered (2026-11-19):** neither package keeps declaring sessions. The
maintainer cut the declaring-chart context (root ROADMAP.md 8.6, items
16 and 17): both packages run every session as a scope in the shared
context, a chart-level script's functions are the chart's helpers, a
top-level `var` is a variable of the session, and a top-level `let`,
`const` or `class` is the script's `error.execution`.

### 6. Limits of the wasm package

- **memory64** [l-p5-design-memory64]: wasm32 stops near two million
  actors. Recommended: do not build for memory64 until every engine of
  the floor runs it (Safari has not shipped it). Past two million actors,
  `@tinyactors/node` is the answer.
- **A simulated time past 2^53 ns (104 days)** reaches the wasm host
  rounded to a double [l-p5-api-clock]. Recommended: when the clock
  moves, write its exact uint64 into the host's state (one call per
  `increment`, nothing per advance).

### 7. Small requests to core

- **`ta_pool_name`** [l-p1-loop-request-pool-name]: add it beside
  `ta_status_name`. Then the two packages drop their six messages each,
  and Python can name the pool instead of printing its number.
- **DWARF in core's wasm release modules**
  [l-p5-design-release-wasm-debug]: `tinyactors_runtime.wasm` (1.4 MB)
  and `tinyactors_datamodel_ecmascript.wasm` (2.6 MB) carry `.debug_*`
  sections from the libc build. Recommended: link them with
  `-Wl,--strip-debug` in `mise/lib/c_release/build.rb`. That change
  reruns every project's tests, so make it at core's next release.

## Decided

The maintainer's decisions of 2026-11-18 [l-maint-2026-11-18]:

- **Typed methods return a promise when given no handler**
  [l-maint-promises-built]: `await host.actorState({ session })`; with
  handlers the call is the direct one and returns nothing. The `…Async`
  names are gone. Built in the convenience layer, which wraps each direct
  method on `Host.prototype` (a few nanoseconds per call with handlers,
  within the noise of the post).
- **An answer or a failure to a sender that ended is dropped** in both
  bindings, as XState drops an event sent to a stopped actor
  [l-p4-surprises-answer-cpython]: Node returns `false`, Python `False`,
  and neither raises; any other refusal still raises. Breaking for
  Python.
- **The binding picks the trace seed** [l-p2-docs-review-trace-seed-default]:
  a config with no `system.traceSeed` gets a random one
  (`crypto.getRandomValues` in both packages, `os.urandom` in Python)
  before `ta_host_create`; a seed the caller sets is kept and reproduces;
  `Host.restore` keeps the snapshot's generators. Core stays free of I/O.
- **quickjs has a default `memoryLimit`** of 1 GiB
  [l-p2-docs-maxops-default]; `maxOps` keeps its default (7b19ec88).
- **`actor.get` lists the pending delayed sends and `actor.state` the
  history states** [l-p4-examples-approval-hidden-timers]: `timers`
  (sendid, event, due in milliseconds on the host clock; capped, with
  `timersPending`) and `history`. No `actor.timers` method; a host-wide
  list of what fires next waits until operators ask for it (712305de).

Earlier:

- **Both packages are kept** (the maintainer, 2026-10-18):
  `@tinyactors/node` and `@tinyactors/wasm`, "because they will change
  for different reasons". The addon serves Node.js and Bun on the
  platforms it is built for. The wasm package serves browsers, Workers and
  Windows. No retirement criterion applies. p5-parity's measurements stay
  in the log as a record [l-p5-design-retire].
- **The browser floor** [l-p5-design-floor]: zig's wasm features are
  kept (Chrome and Edge 114, Firefox 119, Safari 16.4). Dropping
  `extended-const` gives the same bytes (l-p5-pack-oz).

## The coordinator's decisions the maintainer may want to overrule

Each of these was decided without the maintainer, as delegated:

- **The 52 entries of 2026-10-17** [l-coord-decisions]: most were
  accepted as built. Sessions may also be safe-integer numbers, a long
  `<log>` text is truncated at a UTF-8 boundary
  [l-coord-long-string-leftovers], and other text past 4087 bytes is
  refused.
- **What p3-shapes built** [l-coord-p3-shapes]: `addCharts`,
  `spawnChart`, `directoryResolver`, `Address.toJSON`, typed configs and
  results, and the docs shipped in the package. The chart builder waits
  for `ta_xml_writer`.
- **The examples' 35 surprises** [l-coord-surprise-triage]: `idle()`
  waits for the promises that handlers return. `host.now()` was added.
  Payloads are copied into the application's realm when the application
  reads them. An invoke of a type with no handler fails without
  throwing. `answer()` and `fail()` return `false` for a sender that
  ended. `compileCharts` checks every expression with the engine.
- **The binding batch's deviations** [l-coord-binding-batch]: the realm
  copy is made when a value is read, and a script's syntax error is a
  warning unless `warningsAsErrors` is set (W3C requires
  `error.execution` at run time).
- **`encode` writes an `Address` as tag 32** [l-coord-encode-address],
  as Python does. Inside a chart an address is its text.
- **Python takes UNDEFINED as absent** in a message's text fields
  [l-coord-cpython-undefined, 542e0137].
- **The core defaults left alone** [l-coord-p2-docs-maintainer]: see
  section 3.
- **p5-datamodel was marked done** with its protocol gate moved to
  p5-quickjs [l-coord-p5-datamodel-protocol]. The gate now passes there
  (dfebd1ed).
- **`-Oz` for the wasm module** [l-p5-pack-oz]: the module is 30 %
  smaller and costs about 2 to 4 % more per event.

## Work left undone

- The release itself: section 1, including the container and Mac smoke
  tests.
- The chart builder of the convenience layer, which waits for the direct
  layer to expose `ta_xml_writer`.
- Fetching at run time (`TA_EFFECT_REQUEST` is answered in C with
  `TA_ERROR_INVALID`; root ROADMAP.md, "Decided later").
- The generator sessions in the addon (section 5), memory64 and the exact
  simulated clock in wasm (section 6), and the two requests to core
  (section 7).
- Bun's resident memory with the wasm module, about 700 B an actor above
  the addon's at 10,000 actors, is not explained (l-p5-design-retire).
- The wasm package's value messages cite `docs/values.md`, which that
  package does not ship (l-p2-docs-review-links).
