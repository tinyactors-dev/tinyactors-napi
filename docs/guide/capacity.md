# Capacity and memory

A host keeps its actors in blocks of memory it sizes from the config,
one block (a **region**) per segment, that is per `addImage`. You can
leave the sizes to the host, which grows a region when something in it
runs out, or size a host up front for the population you expect. This
guide says what the sizes are, how a region grows, how to read what a
host uses, and what an actor costs.

## The sizes

The config's `system` map gives each new segment its first sizes. Each
key is a whole number; an absent key, or 0, is the default:

| Key | Default | What it counts |
|---|---|---|
| `maxActors` | 64 | actors, hibernated ones included |
| `maxEvents` | 256 | events waiting in the actors' queues |
| `maxTimers` | 64 | pending delayed sends |
| `maxRequests` | 16 | running invocations (child charts and services) |
| `workspaces` | 4 | actors in the middle of a step at once (a sender keeps its workspace until its send is handled); never refused: an actor waits for one, and the host adds more |
| `instanceBytes` | derived from the image and `maxActors` | the actors' variables and states |
| `stringBytes` | 16384 + 16 × `maxActors` | strings the actors hold |
| `ticksPerSecond` | 1,000,000,000 | the host's clock rate |

A size is a segment's first size, not a limit. When a pool fills, the
host grows that segment between runs, into a new region with more of what
ran out and the rest as it was. A pool doubles, or grows by more, up to 16 times
at once, when doubling would add less than a quarter of the region, so a
small pool beside a large region grows in a few copies, and in proportion
to itself. A grown region
never shrinks. A run or an input is refused (`TA_ERROR_NO_MEMORY`) only
when a pool is at its largest size (`maxActors` is at most 8,388,606) or
the system allocator refuses the memory.

## Reading what a host uses

`host.hostStats` ([Inspecting a host](inspection.md)) answers with
`pools`, an array of one entry per live segment, in segment order. Each
entry has its `segment` (the number `addImage` returned) and, for
`actors`, `events`, `timers`, `workspaces`, `requests` and `slabBytes`
(the instance and string memory), the pool's `capacity`, what it holds
now (`used`) and the most it held at once (`highWater`). Each segment
grows on its own, so their pools are reported apart: two images, or a
migration's old and new versions, are two entries.

```js
import { compileCharts, Host } from '@tinyactors/node';

const compiled = compileCharts([{ name: 'idle.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="idle"><state id="waiting"/></scxml>` }]);
const image = compiled.image;
compiled.close();

for (const system of [{}, { maxActors: 1000 }]) {
  const host = new Host({ systemID: 'demo', system });
  host.addImage(image);
  const before = (await host.hostStats()).pools[0].actors;
  for (let i = 0; i < 1000; i++) host.spawn(host.chart('idle'));
  const after = (await host.hostStats()).pools[0].actors;
  console.log(`maxActors ${system.maxActors ?? 'default'}: capacity ${before.capacity}, ` +
    `then ${after.used} used, high water ${after.highWater}, grown: ${after.capacity > before.capacity}`);

  host.addImage(image);
  console.log('segments reported:', (await host.hostStats()).pools.map((pool) => pool.segment).join(', '));
  host.close();
}
```

```output
maxActors default: capacity 64, then 1000 used, high water 1000, grown: true
segments reported: 0, 1
maxActors 1000: capacity 1000, then 1000 used, high water 1000, grown: false
segments reported: 0, 1
```

`highWater` against `capacity` is what a config sized up front needs: run
a realistic load, read the high-water marks, and give the next host those
sizes. `host.hostConfig()` answers the sizes a host was made with, every
default filled in.

## Sizing a host up front

Growing costs a copy of the region each time, and a grown region keeps
its size, so a host that will hold a known population is better sized for
it. A hibernated actor keeps its slot and its record in the host (about
64 bytes), so `maxActors` counts every actor, while the instance and
string memory are needed for the resident ones only. For `R` actors
resident out of `N` on a counter chart of a few variables, the
repository's hibernation gate uses:

```js
import { Host } from '@tinyactors/node';

const N = 2_000_000; // actors
const R = 1000;      // resident at most
const room = 64;
const host = new Host({ systemID: 'big', system: {
  maxActors: N + room, maxEvents: 4096,
  instanceBytes: 2048 * (R + room), stringBytes: 16384 + 64 * (R + room),
} });
console.log((await host.hostConfig()).system.maxActors);
host.close();
```

```output
2000064
```

A chart with more variables or longer strings needs more per resident
actor; read `slabBytes.highWater` under load to see.

## What an actor costs

Measured with `mise run measure` in the repository (2026-10-17, x86_64
Linux 6.18, Intel Xeon @ 2.10GHz, 4 CPUs, 16 GiB; node 22.23.3, bun
1.4.1): 10,000 actors of a chart with three `<data>`, one of them a list,
resident and idle, in bytes per actor.

| runtime, datamodel | resident | engine heap | region | after one event: resident | heap |
|---|---|---|---|---|---|
| node, native | 1188 | 197 | 287 | 1589 | 281 |
| node, quickjs | 891 | 10 | 287 | 1363 | 11 |
| bun, native | 1632 | 255 | 287 | 2602 | 345 |
| bun, quickjs | 1195 | 24 | 287 | 1602 | 24 |

The engine heap is what the JavaScript engine reports after a full
collection; on quickjs the sandbox's own heap is in "resident" only, and
it is bounded by `quickjs.memoryLimit`, 1 GiB unless the host sets
another: about 2.8 KB an idle resident actor, so a host meant to keep
hundreds of thousands of quickjs actors resident raises it
([the quickjs sandbox](quickjs.md#the-limits)). The
rest of resident is mostly the engine's fixed cost, which a larger
population spreads thinner: at 40,000 actors the native datamodel is
about 750 bytes resident on Node.js and 970 on Bun. The region here was
sized up front (`maxActors`). A chart whose scripts declare top-level
names costs a `vm` context per actor on top: about 143 KB on Node.js and
60 KB on Bun ([Writing charts](charts.md#scripts)). A hibernated actor
costs about 60 bytes in the host and its blob in your store.

## Work does not grow with the population

`tools/scale.mjs` (`mise run scale` in the repository) times every
operation of the API on a host of N actors and on one of 2N, each in a
process of its own. It fails when an operation costs more than 1.5 times
as much at 2N: per call for an operation on one actor, per actor for one
on the whole population. Most of the actors are hibernated in SQLite and
one in a hundred runs an invoked service; then the same with every actor
resident.

One run of it (2026-10-17, x86_64 Linux 6.18, Intel Xeon @ 2.10GHz, 4
CPUs, 16 GiB, a virtual machine; node 22.23.3, bun 1.4.1). Each cell is
the cost at N, then at 2N, in microseconds, and their ratio.

Hibernated: 2,000,000 and 4,000,000 actors, at most 1000 counters
resident, 20,000 and 40,000 actors each running an invoked service.

| operation | unit | node, native | node, quickjs | bun, native | bun, quickjs |
|---|---|---|---|---|---|
| populate (spawn and hibernate) | µs per actor | 11.71 → 11.62 (0.99) | 7.16 → 7.36 (1.03) | 8.64 → 8.51 (0.99) | 6.74 → 6.58 (0.98) |
| spawn | µs per call | 5.47 → 5.43 (0.99) | 2.45 → 2.54 (1.04) | 4.82 → 5.59 (1.16) | 2.92 → 2.70 (0.92) |
| terminate | µs per call | 0.755 → 0.733 (0.97) | 0.565 → 0.560 (0.99) | 0.925 → 0.889 (0.96) | 0.758 → 0.742 (0.98) |
| send | µs per call | 4.44 → 4.41 (0.99) | 2.06 → 2.15 (1.04) | 3.71 → 3.61 (0.97) | 2.28 → 2.33 (1.02) |
| sendMany | µs per event | 4.84 → 4.79 (0.99) | 2.38 → 2.29 (0.96) | 3.50 → 3.40 (0.97) | 2.38 → 2.13 (0.89) |
| send (hibernated: woken from the store) | µs per call | 34.97 → 30.14 (0.86) | 33.20 → 40.71 (1.23) | 27.13 → 29.38 (1.08) | 34.26 → 35.97 (1.05) |
| hibernate | µs per call | 5.94 → 5.78 (0.97) | 4.50 → 4.55 (1.01) | 4.22 → 4.20 (0.99) | 4.37 → 4.32 (0.99) |
| wake | µs per call | 7.07 → 7.34 (1.04) | 3.84 → 4.02 (1.05) | 7.93 → 7.57 (0.95) | 4.85 → 4.75 (0.98) |
| actorByName | µs per call | 0.532 → 0.507 (0.95) | 0.415 → 0.426 (1.03) | 0.426 → 0.415 (0.98) | 0.304 → 0.300 (0.99) |
| actorState | µs per call | 4.63 → 4.38 (0.95) | 4.34 → 4.80 (1.11) | 4.13 → 4.37 (1.06) | 3.95 → 4.20 (1.06) |
| hostStats | µs per call | 19.28 → 19.47 (1.01) | 19.32 → 19.76 (1.02) | 19.45 → 16.84 (0.87) | 14.51 → 14.14 (0.97) |
| I/O processor round trip | µs per call | 13.30 → 12.54 (0.94) | 8.47 → 8.33 (0.98) | 9.89 → 9.46 (0.96) | 7.88 → 6.48 (0.82) |
| transport round trip | µs per call | 34.01 → 34.13 (1.00) | 25.85 → 28.06 (1.09) | 27.99 → 31.32 (1.12) | 22.87 → 22.52 (0.98) |
| delayed send and its timer | µs per call | 7.19 → 7.48 (1.04) | 3.39 → 3.44 (1.02) | 5.93 → 5.97 (1.01) | 3.87 → 3.79 (0.98) |
| invoked service round trip | µs per call | 14.28 → 15.49 (1.08) | 10.86 → 11.78 (1.08) | 11.54 → 13.32 (1.15) | 9.84 → 10.34 (1.05) |
| sweep (every actor) | µs per actor | 0.008 → 0.007 (0.97) | 0.007 → 0.007 (0.98) | 0.008 → 0.007 (0.94) | 0.007 → 0.008 (1.03) |
| migrate (one session) | µs per call | 32.02 → 28.74 (0.90) | 20.00 → 16.20 (0.81) | 24.48 → 24.95 (1.02) | 17.45 → 20.93 (1.20) |
| snapshot | µs per actor | 0.110 → 0.105 (0.96) | 0.075 → 0.077 (1.04) | 0.090 → 0.080 (0.89) | 0.084 → 0.082 (0.97) |
| restore (and its first turn) | µs per actor | 0.313 → 0.297 (0.95) | 0.200 → 0.200 (1.00) | 0.236 → 0.234 (0.99) | 0.193 → 0.199 (1.03) |
| close | µs per actor | 0.081 → 0.102 (1.26) | 0.078 → 0.087 (1.11) | 0.079 → 0.106 (1.35) | 0.087 → 0.104 (1.19) |

All resident: 1,000,000 and 2,000,000 actors. Two million resident actors
take up to 9.2 GB, so four million do not fit on this machine.

| operation | unit | node, native | node, quickjs | bun, native | bun, quickjs |
|---|---|---|---|---|---|
| populate (spawn, the segment growing) | µs per actor | 6.50 → 6.48 (1.00) | 4.49 → 4.17 (0.93) | 5.39 → 5.84 (1.08) | 4.55 → 4.37 (0.96) |
| spawn | µs per call | 5.36 → 5.53 (1.03) | 2.59 → 3.18 (1.23) | 4.84 → 4.93 (1.02) | 2.86 → 2.71 (0.95) |
| send | µs per call | 6.58 → 6.84 (1.04) | 4.35 → 4.88 (1.12) | 7.89 → 7.03 (0.89) | 4.55 → 4.64 (1.02) |
| hibernate | µs per call | 7.75 → 7.64 (0.99) | 7.68 → 7.42 (0.97) | 6.35 → 6.93 (1.09) | 7.48 → 7.82 (1.04) |
| wake | µs per call | 8.93 → 8.49 (0.95) | 3.05 → 3.27 (1.07) | 6.94 → 8.36 (1.20) | 3.93 → 3.57 (0.91) |
| snapshot | µs per actor | 6.62 → 6.46 (0.98) | 5.60 → 6.32 (1.13) | 4.59 → 2.94 (0.64) | 6.12 → 6.51 (1.06) |
| migrate (a chart, every actor) | µs per actor | 23.38 → 24.60 (1.05) | 12.26 → 14.03 (1.15) | 18.36 → 18.38 (1.00) | 12.01 → 13.27 (1.11) |
| restore (and its first turn) | µs per actor | 16.41 → 15.45 (0.94) | 4.45 → 5.46 (1.23) | 9.08 → 9.01 (0.99) | 4.75 → 4.90 (1.03) |
| close | µs per actor | 0.675 → 0.532 (0.79) | 1.78 → 1.47 (0.82) | 0.557 → 0.506 (0.91) | 1.70 → 1.40 (0.82) |

Peak resident memory, at N and 2N: hibernated node native 1718 / 3273
MB; node quickjs 1763 / 3368 MB; bun native 1396 / 2605 MB; bun quickjs
1358 / 2561 MB; all resident node native 3380 / 6493 MB; node quickjs
4236 / 8289 MB; bun native 4175 / 8176 MB; bun quickjs 4673 / 9239 MB.
The full run, with every operation, is in `build/scale-*.json` after
`mise run scale`.
