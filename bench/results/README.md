# Benchmark results, keyed by machine

What `mise run bench` and `mise run bench-compare --store` recorded. The
same build ran at 622 ns per event on one day and 443 on the next on the
same machine, so figures are only comparable under one **machine
signature**, and best side by side: `mise run bench-compare <commit>`
builds the other commit and runs both alternately. Never compare against
numbers from another day or another machine.

## Layout

- `<signature>/` — one folder per machine signature: the first 12 hex
  digits of a SHA-256 over the machine's fields (`mise/lib/napi/machine.rb`):
  CPU model, core counts (performance and efficiency), RAM, OS and version,
  architecture, the runtime (`node`, `bun`) and its version, and on macOS
  the power source and low-power mode. Node and Bun on one computer are two
  signatures.
- `<signature>/machine.json` — those fields, readable.
- `<signature>/<commit>.jsonl` — one JSON record per line, appended by each
  run at that commit.

## A record

| Field | Meaning |
|---|---|
| `machine`, `commit`, `dirty` | the signature, the build (short hash), and whether the tree had changes |
| `time`, `runtime` | when (UTC) and exactly which runtime |
| `conditionsBefore`, `conditionsAfter` | `loadAverage` (1, 5, 15 min) and macOS `cpuSpeedLimit` around the run; not part of the signature |
| `variant`, `population`, `rounds` | what ran: the tracing configuration (`test/bench/tracing.js`), actors, timed rounds |
| `throughput` | `eventsPerSecondMedian`, `eventsPerSecondBest`, and `nsPerEvent` (from the best round) |
| `memory.coreBytesPerActor` | core's allocator bytes in use per actor, after spawning |
| `memory.nativeBytesPerActor` | the addon's bytes in use per actor, by category (`total`, `core`, `envelopes`, `scheduling`, `values`, `directory`, `scratch`, `other`) |
| `memory.rssBytesPerActor`, `memory.heapBytesPerActor` | resident set and JavaScript heap growth per actor, from before the system was created to after spawning, each after a GC |
| `memory.allocatorCallsPerEvent` | allocations plus frees per delivered event over the timed rounds |
| `memory.peakRSSBytes` | the process's peak RSS so far (cumulative across variants in one run) |
| `memory.otlpBytesPerEvent` | OTLP bytes the trace sink received per event, when tracing |
| `error` | instead of the above, when a variant could not run on that build |

Read a folder with `jq`, for example the untraced line of every commit:

    jq -c 'select(.variant == "untraced") | [.commit, .population, .throughput.nsPerEvent, .memory.rssBytesPerActor]' a99e44a37e2e/*.jsonl
