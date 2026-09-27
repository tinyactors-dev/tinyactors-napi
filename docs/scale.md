# Scale measurements

`test/scale.js` (ROADMAP step 10) checks that per-actor costs stay flat
from one population to the next. It asserts ratios and zero allocator calls
in steady state, never absolute durations. This file records the numbers it
printed, so later steps can compare against them.

Run it with a larger cap:

```sh
TAT_SCALE_MAX_POPULATION=4000000 node test/scale.js
TAT_SCALE_MAX_POPULATION=4000000 bun test/scale.js
```

## 2026-09-23: baseline without data (after step 9)

Chart: one `idle` state that takes `ping` (an external self-transition) and
`work` (to a top-level `<final>`). Default scheduling options. macOS, Apple
silicon, 48 GB. Node 22 and Bun 1. Times are CPU time per operation, except
the actor-ID page and the pump turns, which are wall time.

| | Node 4M | Bun 4M | Node 50k | Bun 50k |
|---|---|---|---|---|
| spawn (call), µs/actor | 0.49 | 0.35 | 0.64 | 0.51 |
| bootstrap, µs/actor | 0.10 | 0.11 | 0.11 | 0.13 |
| longest single spawn, µs | 70 | 540 | 78 | 230 |
| largest block allocated, bytes | 65,536 | 65,536 | 65,536 | 65,536 |
| post + delivery, µs/message | 0.32 | 0.24 | 0.22 | 0.22 |
| inspect, µs | 3.85 | 2.05 | 3.77 | 2.06 |
| actor-ID page of 1,024, µs | 8.6 | 7.9 | 8.7 | 7.5 |
| end to end (post `work` to all, flush), µs/actor | 0.61 | 0.45 | 0.67 | 0.50 |
| native bytes/actor (core + addon) | 480 | 480 | 483 | 483 |
| JS heap bytes/actor | 0.0 | 0.0 | 3.0 | 4.1 |
| RSS bytes/actor (from startup) | 512 | 529 | 693 | 939 |
| peak RSS, whole run | 2.7 GB | 2.7 GB | | |
| pump turns during flush, p50 / p99 / max, ms | 1.1 / 1.2 / 13–15 | 0.1 / 0.3 / 15–16 | 1.0 / 1.1 / 1.1 | 0.1 / 0.8 / 0.8 |
| total GC pause over the population's life, ms | 21 | n/a | 6 | n/a |
| addon allocator calls in steady state | 0 | 0 | 0 | 0 |
| core allocator calls per delivered message | 2 | 2 | 2 | 2 |

Plain-JavaScript baseline at 4M (one object per actor with a switch-based
handler, called directly): 40 bytes per object on the JS heap, and 0.027 µs
(Node) or 0.018 µs (Bun) per event.

Every ratio stayed within its bound on both runtimes. Notes:

- **Core allocates once per message for a chart with a top-level `<final>`.**
  The same chart without the final makes no allocator call per message. So
  core allocates and frees something each macrostep when the definition has
  a top-level final state. That is a core finding, left for a core change
  like ADRs 0063 and 0064. The addon's own count is zero.
- **The largest pump turn grows with the population, but p99 does not.** p50
  and p99 stay flat (on Node at the monitor's 1 ms resolution). The maximum
  is one outlier among about 4,000 turns at 4M, most likely a GC pause.
- **Longest single spawn** is noisy (allocator and page faults), as core ADR
  0063's notes found, and is not asserted. The largest block is asserted
  instead: one 64 KiB page at every population.
- **Inspect is the most expensive call per actor** (2–4 µs), because it
  builds a full JS inspection object. It is not a hot path.

## 2026-09-23: with data, and value-box models A and B (step 11)

Chart `data` (`scale.js`, `SCALE_VARIANTS=data`): the JavaScript data model.
Every actor has a data object `{ count, last }`; every `ping` carries a new
object `{ sequence, text }` as event data, and two functions assign from it
(`count + 1`, and `last = event.data`). That is the load of one actor per
websocket connection. Same machine and options as above.

| | Node 4M, model A | Node 4M, model B | Bun 4M, model A | Bun 4M, model B |
|---|---|---|---|---|
| spawn (call), µs/actor | 0.58 | 0.61 | 0.59 | 0.49 |
| bootstrap (data object, initializers), µs/actor | 0.73 | 0.82 | 0.76 | 0.61 |
| post + delivery with data, µs/message | 1.27 | 1.49 | 0.96 | 1.21 |
| inspect, µs | 4.06 | 4.13 | 2.18 | 2.17 |
| end to end, µs/actor | 0.63 | 0.66 | 0.51 | 0.49 |
| native bytes/actor (core + addon) | 528 | 528 | 528 | 528 |
| JS heap bytes/actor | 56 | 65 | 64 | 74 |
| RSS bytes/actor (from startup) | 788 | 713 | 932 | 752 |
| GC pause over the population's life, ms (minor / major) | 154 (106 / 44) | 126 (104 / 22) | n/a | n/a |
| pump turns during flush, p50 / p99 / max, ms | 1.1 / 1.3 / 32 | 1.2 / 1.3 / 27 | 0.2 / 1.2 / 23 | 0.2 / 0.3 / 24 |
| addon allocator calls in steady state | 0 | 0 | 0 | 0 |

- **Model A** is one `napi_ref` per value box (ADR 0011, the default).
  **Model B** is a handle table: an index into one JavaScript array per
  system (`TNA_VALUES_MODEL=table mise run build`).
- **The cost per message with data is about 1 µs**, against about 0.25 µs
  without data and xstate's ~2.7 µs (measured in the design discussion). It
  is two JavaScript calls (the assign functions), one value box for the
  payload, and the event object the context builds.
- **Model B halves major GC time** (the global handles are gone from the
  mark phase) and uses about 10% less RSS on Node, but posts are 17–26%
  slower (two Node-API calls per access instead of one) and minor GC is
  unchanged. Over the population's whole life the GC saving is 28 ms at 4M
  actors. By ADR 0011 point 3, model A stays: B is not clearly better.
- Every ratio from 50k to 4M stayed within its bound with data, on both
  runtimes and both models.

## 2026-09-23: a websocket-shaped load (step 13)

Chart `ws` (`scale.js`, `SCALE_VARIANTS=ws`): one actor per simulated
connection, with data (`{ count, last }`). Every inbound `ping` carries a new
object as event data; the transition assigns from it, sends it out through a
registered I/O processor (`ws.write` via `"ws"`, which counts the writes),
and re-enters the state, whose exit cancels the 30-second idle timeout and
whose entry arms it again. So every actor always holds one delayed send, and
every message cancels and arms one. Same machine and options as above.

| | Node 1M | Node 4M | Bun 4M |
|---|---|---|---|
| spawn (call), µs/actor | 0.57 | 0.57 | 0.59 |
| bootstrap (data, first timeout), µs/actor | 0.84 | 0.87 | 0.91 |
| inbound post + delivery + outbound write + re-arm, µs/message | 2.36 | 2.61 | 1.74 |
| inspect, µs | 5.21 | 5.36 | 2.95 |
| end to end, µs/actor | 0.96 | 1.02 | 0.90 |
| native bytes/actor (core + addon) | 1225 | 1224 | 1224 |
| JS heap bytes/actor | 56 | 56 | 64 |
| RSS bytes/actor (from startup) | 1564 | 1503 | 1679 |
| GC pause over the population's life, ms (minor / major) | 43 (25 / 16) | 153 (104 / 46) | n/a |
| pump turns during flush, p50 / p99 / max, ms | 0.9 / 1.8 / 15 | 0.9 / 1.9 / 56 | 0.4 / 1.0 / 66 |
| longest single spawn, µs | 6,132 | 6,057 | 40,599 |
| largest block, bytes (core's timer heap) | 8,388,608 | 33,554,432 | 33,554,432 |
| allocator calls in steady state, addon / core | 0 / 0 | 0 / 0 | 0 / 0 |

- **About 2.6 µs per message on Node and 1.7 µs on Bun** at 4M, for the
  whole round trip of one connection's message: the inbound post, two
  assign functions, one outbound I/O effect handed to JavaScript after the
  turn, and a cancel plus a new delayed send. Against the `data` chart
  (about 1 µs), the outbound write and the timer re-arm cost about 1.3 µs on
  Node. Every ratio from 50k to 4M stayed within its bound.
- **Holding a timeout per actor costs about 700 bytes** (1224 against 528
  for `data`): the actor's sparse state and its delayed-send list in core.
- **Core finding: the delayed-send owner heap doubles.** Core keeps one
  entry per actor with a pending send (core ADR 0054) in one array grown by
  doubling and copying (`ta_timer_reserve_heap` in
  `tinyactors-core/src/timer.c`). Its largest block is 512 KiB at 50k
  actors, 2 MiB at 200k, 8 MiB at 1M and 32 MiB at 4M, and the spawn that
  crosses a power of two copies all of it: the longest spawn is about 6 ms
  from 1M on (40 ms on Bun at 4M), where the `data` chart stays well under a
  millisecond. This is the spike core ADR 0063 removed from the actor table;
  the owner heap needs the same paging. `scale.js` prints it as a known core
  finding and holds the addon's own largest block flat.
- **The longest pump turn grows at 4M** (56–66 ms, one outlier among
  thousands of turns; p99 stays about 2 ms). It is most likely a GC pause or
  the heap copy above, not a turn's own work.

## 2026-09-23: tinyactors against xstate and plain objects

`SCALE_BASELINES=xstate,object` runs the same three charts as xstate 5.33.2
actors and as plain JavaScript objects. Each implementation and chart ran in
a process of its own, at 50k, 200k and 1M actors, with
`TAT_SCALE_MAX_POPULATION=1000000` and
`NODE_OPTIONS=--max-old-space-size=14000`. The runtimes were Node 22 and
Bun 1 on the same machine as above. The numbers below are at 1M actors, and
the pattern at 50k and 200k is the same. Per message is CPU time, median of
seven rounds over the same 1,024 actors spread over the population. GC is
Node's total pause over the whole run, including the measurement's own
forced collections. Bun doesn't report GC pauses.

The charts:
- `plain`: `ping` loops on `idle`, and `work` ends the actor.
- `data`: adds two assignments from the event's data.
- `ws`: adds an outbound write through a named effect and a 30-second idle
  timeout re-armed on every message.

How each implementation expresses them:
- **xstate:** `reenter: true` self-transitions, `assign`, a
  `setup({ actions })` action for the write, and `after` for the timeout.
- **plain object:** a switch-based handler, and `setTimeout`/`clearTimeout`
  for the timeout.

Node, 1M actors:

| chart | implementation | per message µs | spawn µs/actor | JS heap B/actor | native B/actor | RSS B/actor | GC total / longest ms | end-to-end blocks the loop |
|---|---|---|---|---|---|---|---|---|
| plain | tinyactors | 0.28 | 0.56 | 0 | 480 | 518 | 8 / 0.9 | no, turns of ≤ 4.6 ms |
| plain | xstate | 1.2–7.1 ¹ | 4.67 | 3,641 | — | 3,963 | 1,700 / 348 | 1.9 s |
| plain | object | 0.02 | 0.05 | 64 | — | 139 | 33 / 8 | 8 ms |
| data | tinyactors | 1.26 | 1.36 | 56 | 528 | 849 | 41 / 9.9 | no, turns of ≤ 9 ms |
| data | xstate | 2.02 | 5.49 | 3,641 | — | 3,904 | 1,898 / 400 | 1.9 s |
| data | object | 0.04 | 0.05 | 64 | — | 139 | 32 / 8 | 10 ms |
| ws | tinyactors | 2.51 | 1.46 | 56 | 1,225 | 1,565 | 42 / 9.9 | no, turns of ≤ 12.6 ms |
| ws | xstate | 5.06 | 9.01 | 4,361 | — | 4,841 | 2,864 / 468 | 3.0 s |
| ws | object | 0.20 | 0.30 | 280 | — | 340 | 62 / 24 | 32 ms |

Bun, 1M actors:

| chart | implementation | per message µs | spawn µs/actor | JS heap B/actor | RSS B/actor | end-to-end blocks the loop |
|---|---|---|---|---|---|---|
| plain | tinyactors | 0.25 | 0.48 | 0 | 548 | no, turns of ≤ 3.4 ms |
| plain | xstate | 1.45 | 5.05 | 2,768 | 5,223 | 2.0 s |
| plain | object | 0.01 | 0.04 | 72 | 104 | 9 ms |
| data | tinyactors | 0.99 | 1.35 | 64 | 922 | no, turns of ≤ 5.7 ms |
| data | xstate | 2.19 | 5.70 | 2,768 | 5,334 | 1.9 s |
| data | object | 0.01 | 0.05 | 72 | 104 | 10 ms |
| ws | tinyactors | 1.84 | 1.45 | 64 | 1,645 | no, turns of ≤ 12.7 ms |
| ws | xstate | 3.50 | 6.98 | 3,244 | 5,931 | 2.9 s |
| ws | object | 0.08 | 0.12 | 160 | 295 | 26 ms |

¹ xstate `plain` on Node measured 1.18 µs at 200k and 7.10 µs at 1M. The
1M figure most likely includes major GC pauses that fell inside the timed
rounds: that run paused 1.7 s in total, with a longest pause of 348 ms. The
`data` chart, which does strictly more work, measured 2.02 µs at 1M. Read
`plain` at 1M as "about 1.2 µs plus GC".

What the comparison is and isn't:
- **Where the work is done differs.**
  - xstate and the objects process a send synchronously inside the caller,
    so their per-message time is all of the work.
  - tinyactors queues the message and processes it in a later pump turn, and
    its per-message time includes the flush. A websocket server would see
    xstate's cost inside each socket callback, and tinyactors' cost spread
    over turns.
  - The "end-to-end blocks the loop" column shows the practical difference.
    Sending `work` to every actor in one loop blocks xstate's event loop for
    the whole loop, 2–3 s at 1M. tinyactors accepts the posts quickly and
    runs them in bounded turns, the longest 4.6–12.7 ms.
- **Timers differ.**
  - xstate's `after` and the objects use one JavaScript timer per actor.
  - tinyactors keeps delayed sends in core and arms one native timer per
    system.
  - The object `ws` row's 280 B per actor is mostly the `Timeout` object.
- **GC pauses are counted over the whole run, not per message.** xstate's
  run-long totals of 1.7–2.9 s at 1M, with single pauses up to 468 ms,
  happen while the application runs. tinyactors' actor state is outside the
  V8 heap, so its GC totals stay near those of the plain objects.
- **The plain objects are a floor, not a competitor.** They have no
  statechart semantics: no hierarchy, no run-to-completion, no event
  queue, no delayed-send bookkeeping, no inspection.

## 2026-09-24: an idle actor carries no event (core ADR 0069)

Core moved an actor's events into the event block it lends a running
actor, so an idle actor holds no event. The addon sizes core's block
cache to `messageBudget`. `TAT_SCALE_MAX_POPULATION=1000000 node
test/scale.js`, same machine, before (`0a37619`) and after:

| At 1M actors, Node | plain | data | ws |
|---|---|---|---|
| native bytes/actor, before | 480 | 528 | 1225 |
| native bytes/actor, after | 272 | 320 | 1017 |
| RSS bytes/actor, before | 518 | 1411 | 2135 |
| RSS bytes/actor, after | 319 | 700 | 1456 |
| core allocator calls per steady-state round, before and after | 16384 | 16384 | 0 |

Every ratio stayed within its bound, and the times per operation did not
move beyond run-to-run noise.

`test/bench/event_blocks.js` (200,000 actors) measures the rest:
- core bytes per idle actor: 464 before, 256 after;
- while every actor holds a delivered event it has not taken: 152 more
  bytes per actor, a header-only block;
- after the flush, with `messageBudget` at 200,000: 728 bytes per actor
  in core's block cache. At the default budget of 1,024 the cache keeps at
  most about 745 KB;
- delivery throughput: 2.9 M events/s on Node and 3.4 M on Bun, before
  and after.

## 2026-09-25: tracing throughput, the accepted baseline (napi ADRs 0016 to 0018)

> **Note (2026-09-26):** the figures below were taken before results were
> keyed by machine signature, and the same build later measured about 30%
> faster on the same computer. Read them as ratios to their own untraced
> row, not as absolutes. From now on, results live in
> `bench/results/<machine signature>/` (`mise run bench`), and builds are
> compared side by side with `mise run bench-compare <commit>`; this
> machine's signatures are `a99e44a37e2e` (Node 22.23.2) and
> `c989bd79a51f` (Bun 1.4.1).

**This is the baseline tracing is held to from now on.** The traced-path
targets of napi ADR 0017 section 4 (about 280 ns per event over untraced
for macrostep spans, 780 for every record) are withdrawn: two rounds of
work (ADR 0017's follow-up and ADR 0018) did not move the traced path
measurably, and the numbers below are accepted as good enough. A change
that makes any row worse by more than the run-to-run spread (about 5%)
needs a reason in its commit.

`test/bench/tracing.js`, Apple M4 Max (16 cores), load 1.3 to 3.0, Node
22.23.2 and Bun 1.4.1 through `mise exec`, best of 5 rounds, ns per event.
One `ping` per actor per round; the transition assigns, so a fully traced
macrostep writes BEGIN, MICROSTEP, ASSIGN and END. Without a
`traceparent`, the system starts every trace itself.

| Configuration | Node 10k | Node 100k | Node 1M | Bun 10k | Bun 100k | Bun 1M | OTLP bytes/event |
|---|---|---|---|---|---|---|---|
| untraced | 621 | 622 | 622 | 522 | 540 | 531 | |
| untraced, `traceparent` passed | 655 | 671 | 654 | 575 | 599 | 590 | |
| sink installed, sampled out | 658 | 669 | 640 | 573 | 601 | 603 | |
| `summary` (the default) | 1,128 | 1,208 | 1,155 | 1,066 | 1,123 | 1,221 | 362 |
| `summary`, 10% sampled | 726 | 709 | 688 | 592 | 641 | 687 | 64 |
| `summary`, 1% sampled | 635 | 652 | 626 | 537 | 581 | 592 | 36 |
| `decisions` | 1,716 | 1,838 | 1,772 | 1,709 | 1,807 | 1,917 | 828 |
| macrostep records only | 1,163 | 1,268 | 1,145 | 1,066 | 1,115 | 1,200 | |
| `full` (every record) | 2,062 | 2,134 | 2,034 | 2,000 | 2,166 | 2,246 | 1,110 |
| `full` + values | 2,427 | 2,510 | 2,404 | 2,245 | 2,408 | 2,595 | 1,130 |
| `full`, then `decodeTraces` | 13,333 | 13,642 | 13,897 | 14,426 | 14,232 | 13,042 | |
| nothing sampled, 10 actors watched | 649 | 652 | 655 | 579 | 582 | 592 | |
| nothing sampled, 100 actors watched | 686 | 679 | 654 | 606 | 607 | 609 | |
| nothing sampled, 1,000 actors watched | 1,141 | 1,031 | 1,017 | 1,118 | 956 | 965 | |

Core bytes per idle actor: 280 to 286 untraced, 280 to 307 with a sink
(the difference shrinks with the population: per-system state).

What the numbers say:

- **Sampling is the lever.** `summary` at 10% costs 70 to 150 ns per event
  over untraced, at 1% within 60. Everything traced costs about 1.9 times
  untraced for `summary` and 3.3 times for `full`.
- **Logs off changes nothing measurable** for this chart (no failures, no
  `<log>`): 1,138 and 1,188 ns against 1,128 and 1,208 for `summary`.
- **Population does not change the cost per event** between 10,000 and a
  million actors, on either runtime.
- **Watching costs by the size of the watch list, not by what it traces.**
  10 or 100 watched actors cost 10 to 60 ns; 1,000 watched cost about 400,
  even at a million actors where that is 0.1% of the traffic. The watch
  check apparently walks the list on every delivery. `watchTraces` takes at
  most 1,024 sessions and definitions.
- **Budgets (napi ADR 0017 section 2, 40 ns):** on Node, `traceparent` and
  sampled-out came in at 25 to 49 ns over untraced across runs; on Bun at
  38 to 62. They stay a guide, checked by `mise run bench-check`, not a
  gate.
- **Decoding in JavaScript** (`decodeTraces`) costs about 11 µs per event
  with every record: for tests and in-process consumers, not for export.

### Changes to the baseline, 2026-09-25 (later)

Same bench and machine (load 2.6 to 4.3), 1M actors, best of 5, ns per
event. These rows replace the ones above; the others stand.

| Configuration | Node | Bun | Change |
|---|---|---|---|
| untraced | 614 to 629 | 530 to 543 | unchanged |
| untraced, `traceparent` passed | 640 to 648 | 580 to 590 | core parses the IDs eight digits at a time (`b9ba91c`): 33 to 12.5 ns per parse |
| sink installed, sampled out | 647 to 652 | 603 to 607 | same parser |
| nothing sampled, 10 actors watched | 635 | 585 | `watchTraces` checks a hash set (`e9d194e`) |
| nothing sampled, 100 actors watched | 637 | 589 | same |
| nothing sampled, 1,000 actors watched | 656 (was 1,017) | 597 (was 965) | same |
| nothing sampled, 10,000 actors watched | 662 | 604 | new: `watchTraces` has no limit now |

- **Budgets:** a `traceparent` and sampled-out now cost 11 to 23 ns over
  untraced on Node (were 25 to 49). On Bun, a `traceparent` costs 24 to
  47 ns and sampled-out 29 to 65 ns, at or near the 40 ns budget, with
  run-to-run noise of about 15 ns.
- **Where Bun's remaining cost is** (macOS `sample` of the `post` path):
  about 10 ns in the string crossing (`napi_get_value_string_latin1`),
  the rest spread through Bun's runtime. A trace-context handle would
  save at most the crossing, so it was not built.
- **Watching** now costs the same whatever the list's size: the
  remaining 20 to 60 ns is `ta_actor_inspect` on every delivery and the
  full-detail spans of the watched actors.

## 2026-09-25: the core findings of steps 7, 10 and 13

The three core findings above were measured again, with core's allocator
calls per delivered event after warm-up (1,000 actors, five rounds), on
Node 22.

| Chart | Core allocator calls per event |
|---|---|
| an `<assign>` | 0 |
| a top-level `<final>` (`plain`, with its external self-transition) | 0 |
| a `<send>` to another actor | 0 |
| a `<send>` to `#_internal` | 0 |
| a `<raise>` | 0 |
| a delayed `<send>` re-armed with `<cancel>` | 0 |
| a timeout re-armed on entry and cancelled on exit (`ws`) | 0 |

- **Steps 7 and 10 were already fixed** by other work. The top-level
  `<final>` cost came from reserving an actor's sparse state before every
  microstep of such a chart (`microstep_needs_sparse`), which core ADR 0070
  removed. `test/allocations.js` now pins every row above on Node and Bun,
  and `scale.js` asserts core's steady-state calls are zero, as it did for
  the addon's.
- **One way to see calls per event is an error path.** A `<send>` that
  fails after its storage was reserved (a delayed send to `#_internal`,
  for example) reserves the actor's sparse state and send storage, raises
  `error.execution`, and frees both when the macrostep ends: three
  allocations and three frees per event. That is the cost of a chart that
  fails on every event, not of a working one, so it is left as it is.
  `test/allocations.js` checks that its charts raise no errors, so it
  cannot pass on such a path.
- **Step 13: the owner heap is paged** (`84dfd0a`), in pages of 8,192
  owners (64 KiB) found through a directory, as core ADR 0063 pages the
  actor table. `ws` at 50,000, 200,000 and a million actors now reports a
  largest block of 65,536 B, where it was 512 KiB, 2 MiB and 8 MiB, and
  `scale.js` holds it flat.
- **The long spawns were not the heap copy.** An A/B of the re-arm shape on
  the same machine and load (about 3) gives the same cost per event in both
  builds (636 to 645 ns against 613 to 643 at 200,000 actors; 645 against
  692 at a million), and a longest single spawn call of 2 to 6 ms in both.
  `ws` in `scale.js` at a million actors: longest spawn 6.8 ms on Node and
  9.3 ms on Bun with the paged heap, against 6.1 ms (Node) recorded above.
  The step 13 note that blamed the doubling copy for the long spawns was
  wrong for Node; the spikes are most likely GC or page faults, as the note
  on `plain` already suspected. Bun at 4M (40.6 ms above) was not measured
  again.

## 2026-09-25: offloading unloaded actors (core ADR 0074)

`unload()` now offloads a stable named actor to bytes the system keeps
(core ADR 0074), instead of holding an in-memory `SessionImage`. Measured
with a throwaway script: 50,000 named actors of a one-state chart whose
data is `{ count }` or a small entity (customer, email, a two-line cart,
flags), Node 22.23.2 through `mise exec`, `--expose-gc` and two forced GCs
before each reading; native bytes from `system.stats()`, heap from
`process.memoryUsage().heapUsed`. Bytes per actor:

| Data, `unloadValues` | Resident (native + heap) | Offloaded (native + heap) | Of which offload store |
|---|---|---|---|
| `{ count }`, `serialize` | 432 + 121 = 553 | 517 + 2 = 519 | 309 |
| small entity, `serialize` | 432 + 463 = 895 | 682 + 0 = 682 | 475 |
| `{ count }`, `handles` | 432 + 120 = 552 | 525 + 64 = 589 | 317 |
| small entity, `handles` | 432 + 464 = 896 | 525 + 408 = 933 | 317 |

Before this change, an unloaded actor holding its image cost 870 native
bytes plus about 430 more heap than resident (core ADR 0074, Context):
about twice a resident actor. Now:

- **`serialize` (the default) frees the data:** the heap part goes to
  zero, and the actor costs 6% (`{ count }`) to 24% (small entity) less
  than resident.
- **`handles` keeps the objects alive** and frees only core's part, so an
  offloaded actor costs slightly more than a resident one. It exists for
  values `v8.serialize` refuses; `serialize` falls back to a handle for
  those values alone.
- **The floor is 208 bytes per unloaded address** (core 114, directory 45,
  value box 32, scheduling 17), kept whatever the bytes: a later, measured
  follow-up (napi roadmap).
- **Core's bytes are larger than core ADR 0074 estimated:** about 250 per
  stable actor with no pending sends, against about 60. The layout writes a
  fixed header, the definition identity's text and a raw address record;
  compacting it (varints, the definition's ID in place of its text, the
  address left to the caller) is a follow-up.

## 2026-09-26: tracing throughput against the baseline, same machine

`test/bench/tracing.js` at `8b73533` (after ADRs 0074 to 0080, the
invoker, definition identity and the definition walk and sink), Node
22.23.2 and Bun 1.4.1 through `mise exec`, load about 3 on 16 cores, best
of 5 rounds, ns per event.

**Absolute numbers moved with the machine, not the code.** Every row came
in about 30% faster than the 2026-09-25 baseline (untraced 436 ns on Node
at 1M, against 622). Built and run side by side on the same machine, the
baseline commit (`2f48123`) and `8b73533` measure the same within noise,
Node, 1M actors, two alternating runs each:

| Configuration | `2f48123` | `8b73533` | Change |
|---|---|---|---|
| untraced | 443, 443 | 447, 442 | 0% |
| `summary` | 815, 813 | 831, 846 | +2 to +4% |
| `summary`, 10% sampled | 497, 499 | 500, 501 | +1% |
| `full` (every record) | 1,411, 1,417 | 1,429, 1,471 | +1 to +4% |

All within the baseline's 5% rule. **Compare builds side by side on one
machine, not against the absolute figures above:** the same build varied
by about 30% between the two days.

This run, `8b73533`, ns per event:

| Configuration | Node 10k | Node 100k | Node 1M | Bun 10k | Bun 100k | Bun 1M |
|---|---|---|---|---|---|---|
| untraced | 416 | 421 | 436 | 360 | 369 | 388 |
| `traceparent` passed | 443 | 439 | 448 | 396 | 380 | 413 |
| sampled out | 420 | 438 | 449 | 382 | 395 | 427 |
| `summary` | 807 | 784 | 823 | 734 | 773 | 891 |
| `summary`, 10% | 490 | 470 | 494 | 405 | 442 | 476 |
| `summary`, 1% | 432 | 446 | 460 | 382 | 405 | 423 |
| `decisions` | 1,154 | 1,159 | 1,225 | 1,113 | 1,193 | 1,325 |
| `full` | 1,329 | 1,322 | 1,376 | 1,356 | 1,380 | 1,493 |
| `full` + values | 1,549 | 1,571 | 1,673 | 1,562 | 1,578 | 1,774 |
| `full`, then `decodeTraces` | 8,964 | 9,120 | 9,520 | 9,929 | 9,456 | 9,718 |

Watching at 1M actors, nothing sampled, over untraced: Node +12 (10
watched), +19 (100), +25 (1,000), +31 (10,000) ns; Bun +37, +39, +41, +55.
The 40 ns budgets held on Node in every run (`traceparent` 12 to 27,
sampled out 5 to 17 over untraced) and on Bun in this run (11 to 39).

## 2026-09-26: machine-keyed results begin

From here on, results are records in `bench/results/<machine signature>/`
(`mise run bench`, see its README), with throughput and memory together.
The seed run, at `716197a`, each variant in a process of its own:
`a99e44a37e2e` (Apple M4 Max, 12 performance and 4 efficiency cores,
48 GiB, macOS 26.6.2, arm64, AC power, Node 22.23.2) and `c989bd79a51f`
(the same with Bun 1.4.1). At 1M actors, Node:

| Variant | ns/event | core B/actor | native B/actor | RSS B/actor | heap B/actor | OTLP B/event |
|---|---|---|---|---|---|---|
| untraced | 445 | 280 | 328 | 652 | 115 | |
| sampled out | 456 | 280 | 597 | 1,109 | 115 | |
| `summary` | 910 | 280 | 597 | 1,301 | 115 | 365 |
| `summary` 10% | 499 | 280 | 597 | 1,081 | 115 | 66 |
| `full` | 1,704 | 280 | 597 | 1,111 | 115 | 1,112 |

Installing a sink adds about 270 native bytes per actor at 1M actors (and
about 340 at 100k): per-system buffers of the encoder, amortized over the
population. Allocator calls per event are 0 untraced and 0.2 with a sink
installed.

## 2026-09-26: an installed trace sink at rest

Machine `a99e44a37e2e` (Node 22.23.2) and `c989bd79a51f` (Bun 1.4.1),
`mise run bench-compare 27d38c5 1000000`, 2 alternating runs each,
medians; records in `bench/results/`. With a sink installed, native bytes
per actor fall from 597 to 329 (untraced: 328) and allocator calls per
event from 0.20 to 0.00, in every traced variant on both runtimes;
throughput is unchanged within the 5% rule. Causes and the full table:
napi ADR 0017, "Follow-up, 2026-09-26". RSS per actor with a sink stays
above untraced (Node 1,124 against 669), the high-water mark of the spawn
turn's staging buffer.

