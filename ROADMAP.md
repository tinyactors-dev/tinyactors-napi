# Roadmap: tinyactors-napi

**Being rewritten from scratch.** The first addon (M1 of the earlier
plan, 2026-10-12) was removed (`70434bee`: `src/`, the adapter and the
binding's docs; the tooling stays). **Next for this binding: step 8.5 of
the root [ROADMAP.md](../ROADMAP.md), later.** It starts after the Python
binding's step 8.4 and its API review, so that the API shape is settled
once, in Python, before the second binding is written. Until then this
session does nothing here. The binding's rules, true at every step, are
in [AGENTS.md](AGENTS.md); the plan of both bindings is the root
roadmap's step 8, which decides.

## Step 8.5: Node, to the same "done means" as Python's 8.4

From the root ROADMAP.md, step 8, "8.5"; read it there, and 8.4 with it,
before changing this copy.

### Done means

- **Scope:** the package's `Host`; `ta_host_create` from JavaScript
  options (the addon reads `host.config` itself); images, boot, spawn,
  send, terminate; the loop, one drain at a time, driven by the event
  loop alone (`setImmediate`, one `setTimeout`), and
  `SimulatedClock.increment(ms)`; I/O processors as the application's
  output channel, whose senders wait for the batch's ack, and the host's
  transport;
  typed methods over post with response handlers called at a later
  drain; `LOG` to a log handler per host; `DONE` and `ERROR` internal;
  rows in `ta_table`; one `ta_growable_arena` per host with a mark per
  call; thin views of effects (AGENTS.md, "Lifetimes and thin views"); `encode` and `decode`; the native
  `"ecmascript"` datamodel for `<data>`, `cond`, `assign`, `<script>`,
  `_event`, `In()`, `<send>` with params, `<foreach>`, with quickjs
  beside it; the suite's adapter (`conform.mjs`), framing the driver's
  calls with `encode` and `decode` and importing nothing but
  `@tinyactors/node` and `node:` built-ins.
- **Gates**, each in `mise run test`:
  - the suite's M1 set (`--milestone M1`) under node and under bun, on the
    native datamodel and on quickjs;
  - the value table's own tests, against `values.txt`'s `ecmascript`
    lines;
  - the mapping table (`docs/api-map.md`);
  - the layer lints, the prefix, no mutable globals;
  - each rule of AGENTS.md's "Rules the suite cannot see" with a test of
    its own.
- **Then the API review**, side by side with the Python binding. The rest
  of 8.5 (W3C per datamodel, every effect, lifecycle and peers, examples
  and release) follows for both bindings, as the root roadmap lists it.

### Plan and progress

The plan is [docs/plan.xml](docs/plan.xml) (schema `docs/plan.rng`):
the frame, the API against Python's and core, the decisions, the phases
and steps (each step's `commit` attribute is the commit that finished
it), the spikes and the findings of its refutation. Edit it with XML
tools and validate it (`xmllint --noout --relaxng docs/plan.rng
docs/plan.xml`). `GATE` in `mise/napi.rb` names what of
the set `mise run test` runs so far, and grows with the work.

Progress (2026-10-17): phases p0 and p1 are done, and p2 but its last
step: telemetry, hibernation, migration, snapshots, invoked services
and the scaling gate are built, and `mise run test` holds the whole
suite (`MILESTONE` M5, `GATE` protocol, scenarios and w3c): W3C 191 of
191 and all 8 scenarios on node and bun, on the native datamodel and
on quickjs (p2-w3c). The packages are built (p2-pack): `mise run pack`
makes one zig-built addon per platform package, checked by its symbols,
and the main package, reproducibly, and this machine's install into a
fresh project and pass the smoke test under node and bun; `mise run
release` checks, tags `tinyactors-napi/v<version>`, publishes to npm and
releases through tinyactors-dev/tinyactors-napi. All 37 steps of the plan are
done (2026-10-18), with `@tinyactors/wasm` beside the addon (phase p5).
The first release and the decisions that wait for the maintainer are in
[docs/maintainer.md](docs/maintainer.md).

## How the work runs

The root ROADMAP.md, step 8, "Rules for the work", sets these for every
session; here they are as they apply to this one.

- **The Node session owns `tinyactors-napi/` and nothing else.** A Python
  session owns `tinyactors-cpython/`, in the same checkout; a
  coordinating session owns `tinyactors-core`, `tinyactors-test` and the
  root documents.
- **This file is the session's.** The session keeps it current and
  commits it with its own paths. It never edits the root `ROADMAP.md`:
  the coordinator reads this file, moves each request below into the
  root's "Requests to core", and marks the step done there after its
  audit and review.
- **Core and the suite are frozen.** A gap in either (AGENTS.md, "Gaps in
  core") is written under "Requests to core" below and committed alone
  (`docs(napi): request to core: ...`). The coordinator makes the change,
  with C tests and suite cases, and says when to go on.
- **One checkout, on `main`, commits of this project's paths only:**
  `git commit -- tinyactors-napi/` (`git add` a new file by its path
  first). Never `git add -A`, `git add .` at the root, `git commit -a`,
  `git stash`, `git checkout -- .` or `git reset --hard`: they take or
  undo the other sessions' work. History stays linear: `git pull
  --rebase` when `main` moved.
- **`.git/index.lock` belongs to another session's git command.** When
  git says the index is locked, wait a few seconds and run the same
  command again. Never delete the lock.
- **Tests: this project's only.** Run this project's `mise run test`
  before every commit, and the suite against the adapter (`mise run
  conform`). Never the root `mise run test` and never `tinyactors-core`'s
  build or tests: the coordinator runs those. `mise run build` here runs
  core's `amalgamate` task, the only core task this session runs.
- **An audit after the step**, by the coordinator: both bindings side by
  side, against the guide's "never" list, each `AGENTS.md`'s "What not to
  build", and their mapping tables. What it finds is fixed here.

## Requests to core

Gaps in core or in the suite this session finds. Each says what is
missing, why, and which suite case or test shows it; the coordinator moves
it into the root ROADMAP.md's "Requests to core" and answers there.

- **An event string longer than a slab page grows a segment without
  bound** (2026-10-16, p1-rules; log entry `l-p1-rules-long-string`).
  `host.send(session, 'x'.repeat(8000))` never returns: `ta_system_send`
  answers `TA_ERROR_NO_MEMORY` for a string that no slab size class holds
  (`src/base/slab.h`: "Max object size is TA_SLAB_PAGE", 4096 bytes), and
  `host_send_to` (`src/host/host.c:724-737`) grows the segment and tries
  again for as long as the growth succeeds: each doubling is allocated and
  `ta_system_relocate`d (a `memset` of the new block), so the process
  reaches 6 GB resident in four seconds and the kernel kills it. Seen
  under node 22.23.3 on both datamodels (gdb: `ta_napi_host_send` →
  `ta_host_send` → `segment_grow` → `ta_system_relocate` → `place`); 4000
  bytes pass, 6000 and 8000 do not. Any input that carries text (an event
  name, a sendid, an origin; an I/O processor's answer; a transport
  passing a message from the network) reaches it, so an application input
  can exhaust the machine. Asked: a refusal the caller can see (a status
  for text longer than core keeps, or strings past a page kept another
  way), and growth that stops when it cannot help; the same loop is at
  `host.c:713`, `:1481`, `:1530` and `:2083`. The addon works around
  nothing: its tests keep each text under 4096 bytes
  (`test/rules.test.mjs`, "marks nest in the host's arena").
  **Answered 2026-10-16 (`269646f`):** each text core keeps is at most
  `TA_SYSTEM_MAX_STRING` bytes (4087, `system.h`); a longer one in an
  input (`ta_host_send`, `_send_many`, `ta_host_spawn`, the system's
  calls) is `TA_ERROR_INVALID` with nothing allocated and the payload the
  caller's; a chart's expression past it is `error.execution`; a
  traceparent has no limit. `segment_grow` stops when every capacity is
  at its hard limit, so no retry loop in `host.c` grows without bound.
  Tests: `tinyactors-core/tests/unit/test_host_strings.c`. The addon
  needs no change; a test of the refusal is its own to add.

- **Every run scans every live request: a population of invocations
  makes each run O(invocations)** (2026-10-16, p2-services; log entry
  `l-p2-services-retry-pending`). `ta_system_run` calls
  `ta_system_retry_pending` (`src/system/schedule.c:254`). That function
  walks `system->requests` from 0 to its high-water mark
  (`src/system/route.c:326-368`), only to find the
  `REQUEST_PENDING_SPAWN`s. An external invocation holds a request for
  as long as it runs, so with 200,000 running services each run scans
  200,000 slots, however little it does. `tools/services.mjs` makes
  50,000 round trips at 33,000 to 42,000 a second with 10,000 actors,
  but only 4,000 to 4,600 a second with 200,000 (`mise run services`,
  2026-10-16, all four runtime and datamodel pairs). gdb sampled the
  200,000-actor traffic six times; five samples were in
  `ta_system_retry_pending` under `ta_host_run`. The Python binding built
  on today's core shows the same: `tools/services.py --actors 200000
  --events 50000`, 4,525 round trips a second, where its README measured
  26,000 a second on 2026-10-14. The suite cannot see this (it is a rate,
  not a result). Asked: a run finds the pending spawns without walking
  every request, for example a list or a count of them so that no
  pending spawn means no scan. The addon works around nothing; the gate
  passes, only slower.
  **Answered 2026-10-16 (`dd29558e`):** the parked spawns are a queue in
  the system header, so a run retries only them (O(parked), nothing when
  none), whatever the number of live requests. The slowdown came with
  `d7db9ada` (a sender waits for its send), which made a round trip take
  more runs, each of them walking the requests: the Python services gate
  ran 52,332 round trips a second before it and 4,654 after (200,000
  actors, 50,000 round trips). Now `mise run services` makes 37,000 to
  53,000 a second at 200,000 actors (README, "Invoked services"); the
  Python gate 144,544. The addon needs no change.

- **Three whole-table walks per call: `host.actorByName`, the hibernate
  and migration check, and waking a queued actor** (2026-10-16, p2-scale;
  log entries `l-p2-scale-actor-by-name`, `l-p2-scale-stable-member`,
  `l-p2-scale-wake-queue`). The scaling gate (`tools/scale.mjs`, `mise run
  scale`) times every operation at 2,000,000 and 4,000,000 actors; these
  cost twice as much per call at twice the actors (the gate allows 1.5):
  - `ta_system_actor_by_name` (`src/system/system.c:764`) walks every
    actor slot, hibernated ones included: 14.9 ms a lookup at 2M, 29.1 ms
    at 4M (gdb: 5 of 6 samples in `ta_host_actor_by_name`, the walk
    inlined). Asked: an index from name to actor.
  - `stable_member` (`src/system/hibernate.c:149-152`) walks every request
    of the segment on each hibernate, each migration export and each sweep
    candidate. With N/100 actors running an invoked service: a hibernate
    costs 23.7 us at 2M and 52 to 67 us at 4M; a migration of one session
    46 us and 80 to 95 us (20 to 37 us at both sizes with no services
    running); gdb: 5 of 6 samples in `stable_member` under
    `ta_host_hibernate`. Asked: the requests an actor holds found without
    walking the pool (a per-actor count or list).
  - `ta_actor_wake` (`src/system/hibernate.c:767-778`) unlinks a woken
    actor from the singly linked wake queue by walking from its head: with
    N/100 hibernated actors each sent an event before the run, waking the
    last of them ahead of core's WAKE costs 1.1 ms a call at 2M and 2.7 to
    3.1 ms at 4M. `ta_system_reclaim`'s `unqueue` (`system.c:614-619`) is
    the same walk for the run, workspace and wake queues, reached when a
    runnable actor leaves (an export); terminating one does not walk (it
    is reclaimed after the run pops it). Asked: O(1) removal from the
    queues.

  The addon works around nothing: `tools/scale.mjs` lists the three
  operations in `KNOWN`, the README's "Scale" table records them as
  failing, and the step stays open until they pass.
  **Answered 2026-10-17 (`e43239c1`, `fc8ff117`, `ae93a346`):** a system
  keeps an index of names (one slot per distinct name, holding its oldest
  live actor; the others in a ring beside the actor pool), each actor
  counts its live requests, and the wake queue is linked both ways. At
  2,000,000 and 4,000,000 actors (`mise run scale`, README "Scale"):
  `actorByName` 0.3 to 0.6 µs a call (ratio 0.97 to 1.16; 5 to 29 ms
  before), `hibernate` 4 to 6 µs (0.91 to 1.04), `migrate (one session)`
  18 to 29 µs (0.97 to 1.20), `wake (an event waiting)` 4 to 9 µs (0.95
  to 1.13; 1.1 to 3.3 ms before), on all four pairs. Within a segment
  `actorByName` now answers the oldest live actor of the name. Core's
  region grows by about 17 B per actor of capacity. `KNOWN` is empty; the
  addon needs no change. The gate still fails on one pair: bun native's
  snapshot of the hibernated population, whose fastest sample at
  2,000,000 is faster than any at 4,000,000 (log `l-p2-scale-rerun`).

- **A hibernation blob carries no identity of the system that made it**
  (2026-10-18, p5-parity; log entry `l-p5-parity-blob-identity`). A blob
  of another host, for a session of the same number running the same
  image, wakes and brings the other actor's state: a blob of an addon
  host woken into a `@tinyactors/wasm` host, and into a second addon
  host, each holding a session 1 it had hibernated itself, came back with
  the first host's count. The header (`src/system/hibernate.c:39-45`)
  holds the chart, the image's hash and a serial, nothing of the system,
  and `boundary.md`'s row for `ta_host_wake` refuses "another session's"
  blob, which a session of the same number on another host is not. A
  store two hosts share (a server and a browser client, two servers) that
  mixes up its keys imports one actor's state into another without a
  word. Asked: a system identity in the blob (made at creation and kept by
  a snapshot, so a restored host still wakes its own blobs) and
  `ta_host_wake` refusing another system's blob with `TA_ERROR_INVALID`.
  The addon works around nothing; its guide says to keep each host's
  blobs apart (`docs/guide/browser.md`, "One store, two packages").
  **Answered 2026-10-18 (`934d62d1`):** a host's identity, mixed from the
  system id and `ta_host_environment.nonce` (random bits both packages
  draw from `crypto.getRandomValues`), is in every blob's header and kept
  by a snapshot; `ta_host_wake` refuses another identity with
  `TA_ERROR_INVALID`.

The first addon's two requests were answered on 2026-10-12
(the runner skips envelope-level vectors for a binding, `34c09cfa`; the
tick rate through `host.config`, `9bd33f03`); their text is in this file's
history before `70434bee`.
