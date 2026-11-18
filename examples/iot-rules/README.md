# IoT rules

A device platform whose customers write their own alert rules. The
devices are actors of the platform's chart; the rules are code the
customers upload, which the platform runs for them without trusting it.

- **Devices** report samples from their sensors. Each device is an actor
  of [`charts/device.scxml`](charts/device.scxml), the platform's own
  edge logic: a sample that is not a finite number is reported as
  malformed, one within the device's deadband of the last reported value
  is dropped, every other one becomes a numbered reading. A device that
  reports nothing for 30 s goes offline, and its next sample brings it
  back.
- **Rules** come in two forms. A customer writes a condition and a
  message, two JavaScript expressions over `reading`, which the platform
  fills into [`charts/rule-template.scxml`](charts/rule-template.scxml):
  an alert is raised when the condition holds for `sustain` readings in a
  row and cleared at the first that does not. Or a customer uploads a
  whole chart, such as
  [`uploads/door-left-open.scxml`](uploads/door-left-open.scxml) or
  [`uploads/rolling-average.scxml`](uploads/rolling-average.scxml). One
  actor of a rule runs per device it watches, holding that device's
  state.
- **The customer's inbox** gets everything: the rule's alerts, its
  compile diagnostics at upload, its errors, the sends it was refused,
  and its suspension. A customer's code that loops, hoards memory, does
  not parse, throws, looks for `process` or `require`, sends where it
  should not, or invokes a service is reported there, and no other rule,
  of that customer or another, is held up for long or fails because of it.

## What is where

| File | What it holds |
|---|---|
| [`charts/device.scxml`](charts/device.scxml) | a device: deadband, malformed samples, the offline watchdog |
| [`charts/rule-template.scxml`](charts/rule-template.scxml) | the rule a condition and a message are filled into |
| [`platform.mjs`](platform.mjs) | the application: the fleet's host, one sandboxed host per rule, routing, reports, audits, suspension |
| [`check.mjs`](check.mjs) | what the platform checks in an upload before compiling it (its name, a template rule's fields), and the template's filling |
| [`uploads/`](uploads/) | customers' charts: two good ones, and one for each way a rule goes wrong |
| [`measure.mjs`](measure.mjs), [`native-rule.mjs`](native-rule.mjs) | the measurements below, and the rules on the native datamodel |
| [`main.mjs`](main.mjs) | three customers on the real clock, one of them uploading every file of `uploads/` |
| [`test.mjs`](test.mjs) | every case, on a `SimulatedClock` |

## The hostile and buggy uploads

| Upload | What it does | What its customer sees | What everyone else sees |
|---|---|---|---|
| [`broken.scxml`](uploads/broken.scxml) | XML that is not well formed | `broken.scxml:8:38: error: XML: expected quoted attribute value` at upload | nothing |
| [`typo.scxml`](uploads/typo.scxml) | JavaScript that does not parse | `typo.scxml:8:5: error: cond: SyntaxError: ...` and one for its script, at upload (`compileCharts` with `warningsAsErrors`) | nothing |
| [`peeker.scxml`](uploads/peeker.scxml) | `<data src="file:///etc/passwd">` | `peeker.scxml:5:14: error: src="file:///etc/passwd" requires a resolver` | nothing |
| [`spin.scxml`](uploads/spin.scxml) | a loop that never ends | `error.execution` for each reading, then the rule suspended after 3 | each reading held up about 50 ms |
| [`hoard.scxml`](uploads/hoard.scxml) | fills a variable until memory runs out | `error.execution`, then suspended | nothing: the memory was its own engine's |
| [`thrower.scxml`](uploads/thrower.scxml) | reads a field that is not there | `error.execution` for each reading, then suspended | nothing |
| [`nosy.scxml`](uploads/nosy.scxml) | looks for `process`, `require`, `fetch`, timers and a way out of the realm | its own alert says `undefined` for each and `refused: ReferenceError`; `require(...)` is `error.execution` | nothing |
| [`rogue.scxml`](uploads/rogue.scxml) | sends `reboot` to another customer's device, a forged reading to that customer's rule, the reading to a web server | a violation for each refused send, `error.communication` and `error.execution`, then suspended | nothing: the device and the rule never get them |
| [`invoker.scxml`](uploads/invoker.scxml) | `<invoke type="urn:shell">` | `error.communication`: the platform runs no such service | nothing: a type with no handler throws nothing in the platform |
| [`busy.scxml`](uploads/busy.scxml) | sends itself an event, forever | the rule suspended for its fuel | its host interleaves with theirs until the audit |

A template rule whose condition or message does not parse is refused at
upload the same way (`when:1:1: error: SyntaxError: ...`), and one that
tries to close the template's attribute (`true" target="..."`) is just
text in it, which does not parse either.

## The tinyactors features it uses, and why

- **The quickjs datamodel with `maxOps` and `memoryLimit`**
  (`datamodel: 'quickjs'`, `quickjs: SANDBOX` in
  [`platform.mjs`](platform.mjs)): the customers' code runs in an engine
  of its own, with no I/O and no way to the process, and an evaluation
  that runs past its checks or its memory is stopped and becomes
  `error.execution`, so the rule goes on with its next reading.
- **A host per rule.** `memoryLimit` is the whole engine's, every actor of
  the host together, and the builtins are shared by the host's actors. A
  rule that hoards memory in a variable keeps it after its evaluation is
  stopped, so every rule beside it fails its next allocation: the test
  shows a rolling average failing on memory it did not take, in one host,
  and not on the platform. A host costs about 580 KB resident with its
  first segment, so a rule's sandbox is affordable; the per-device cost is
  below.
- **A host on the native datamodel for the fleet**: the device chart is
  the platform's code, and native is what trusted charts run on.
- **I/O processors** (`urn:iot:telemetry`, `urn:iot:alert`): a device's
  reading and a rule's alert are sends with no answer. The alert's
  handler takes the rule from the host it belongs to, so a rule's
  `target` cannot send its alert to another customer.
- **The transport** of each rule's host: every send to another system's
  address reaches it, whether it names the fleet's devices, another
  customer's rule or another of the same customer's. The platform refuses
  each with `send.fail()`, which the rule gets as `error.communication`,
  and reports it. A send to a type the host does not have (the
  BasicHTTP processor) is `error.execution` in the chart.
- **Compile diagnostics** (`CompileError.diagnostics`): XML errors,
  unknown states and a `src` with no resolver are reported to the
  customer with their file, line and column, before anything runs. No
  resolver is given, so a chart can read no file.
- **`hostStats` per chart counters**: `errorsExecution` and
  `errorsCommunication` are how the platform learns that a customer's
  chart failed, since an uploaded chart need not catch its errors, and
  `fuel` is how it finds a rule that keeps its host busy without breaking
  either limit: the platform divides the fuel a rule used by the
  process's CPU time it spanned (`process.cpuUsage`), not by the wall
  clock, so a process that shares its CPUs with others still finds it.
  The counters answer while the host is busy.
- **Named actors and spawn params**: a rule's actor for a device is named
  by the device, found with `actorByName`, and spawned at the device's
  first reading with `{ device, sustain }`.
- **Delayed sends and `<cancel>`** for the device's watchdog, re-armed by
  every sample; a `SimulatedClock` in the test moves 30 s at once.
- **`host.close()`** suspends a rule: it frees the rule's engine, its
  memory and every actor of it.

## Measurements

On an Intel Xeon @ 2.10 GHz, 4 CPUs, 16 GiB, Linux 6.18; node 22.23.3
and bun 1.4.1 (`node examples/iot-rules/main.mjs --measure
--default-max-ops`).

**How long a `while (true)` holds the host.** `maxOps` counts the
engine's interrupt checks, and what a check costs depends on the loop: 26
us for `while (true) {}`, 250 us for `spin.scxml`'s `while
(_event.data.value !== null) {}`, which reads a property in each round.
So:

| Loop | `maxOps: 200` (this platform) | the engine's default, 1,000,000 |
|---|---|---|
| `while (true) {}` | 5.4 ms (node), 5.3 ms (bun) | 26.6 s (node), 25.9 s (bun) |
| `spin.scxml`'s loop | 49 ms (node), 48 ms (bun) | 256 s (node, once; 50, 529 and 5074 ms at 200, 2000 and 20,000) |

The host runs on the thread every host of the process shares, so while a
rule spins nothing else runs: another customer's alert, sent at the same
moment, waited 54 to 73 ms. With the default it would wait minutes; that
is the number to set `maxOps` against, and why the platform suspends a
rule after 3 errors. A regular expression that backtracks exponentially,
a sort of two million numbers and a string of six million characters
reversed each ended in `error.execution` within 250 ms at `maxOps: 1000`
and a 64 MB `memoryLimit` (a spike, not in the test).

**What a rule costs per device**, one actor of the template rule per
device, 2000 devices, from `hostStats` and the process:

| Rule | region per device | of it, slab in use | resident per device (node, bun) |
|---|---|---|---|
| quickjs, the template | 283 B | 115 B | 1.4 to 2.5 KB, 3.8 to 4.3 KB |
| quickjs, the template plus `<script>var unit = 'C';</script>` | 283 B | 115 B | 63 KB, 62 KB |
| native, the template | 283 B | 115 B | 1.0 to 2.2 KB, 4.1 to 4.6 KB |
| native, plus the same script | 283 B | 115 B | 196 KB, 206 KB |

The region is what `hostStats` counts (`regionBytes` of a host sized
for the devices, less one sized for one actor; `slabBytes.used`), and it
is the same for both datamodels: the rule's state and strings in core.
The engine's own heap is not in core's counters (`host.quickjsHeapBytes`
reads it), so resident is the process's growth, which varies between
runs. A rule whose script declares a name gets an engine
context per device: 62 KB on quickjs, so a rule with that one `var` over
130 devices fills an 8 MB `memoryLimit` by itself. The platform's limit
is per rule, so it is the customer's rule that fails, but the customer
pays a context for every device their rule watches.

## Why the rules do not run on the native datamodel

The same uploads on a native host (`node examples/iot-rules/main.mjs
--compare`):

- **`nosy.scxml` reaches the process.** Its `process`, `require` and
  `fetch` are `undefined` there too, since a chart runs in a `node:vm`
  context, but `In.constructor('return process')()` gives the platform's
  own `process`: the alert reads `pid 22699 (this process is 22699)`. `In`
  is a function of the application's realm, and its constructor compiles
  code there; from `process`, `process.getBuiltinModule('child_process')`
  runs programs. A `vm` context is not a security boundary.
- **`spin.scxml` never stops.** There is no `maxOps`: the evaluation runs
  on the application's thread until the process is killed, and every
  other host, timer and socket of it waits.
- **`hoard.scxml` ends the process.** There is no `memoryLimit`: the
  rule's array grows in the application's heap until V8 aborts the
  process (`FATAL ERROR: Reached heap limit Allocation failed -
  JavaScript heap out of memory`, after 0.3 s with a 128 MB heap); under
  bun it was still growing after 60 s.

So a native chart is code the application trusts, as much as its own
modules. quickjs is the datamodel for code it does not.

## What the platform cannot tell its customers

The platform reports the chart's `errorsExecution` counter, so a customer
is told "error.execution, 1" for a rule that ran out of checks, out of
memory, threw `new Error('boom')` or called `require`, alike. The reason
is in the chart now: `error.execution`'s `_event.data` is `{ reason,
message }`, `reason` `'fuel'`, `'memory'` or `'exception'` (docs/log.xml,
l-p4-examples-iot-error-reason, fixed in core), which a template rule
could send on with its alert; this example does not. `compileCharts` parses a chart's JavaScript
with the application's engine, which is V8 or JavaScriptCore, not QuickJS,
so a construct one accepts and the other does not is found only when it
runs.

## Surprises

Every example's surprises, and what became of each, are in
[docs/surprises.md](../../docs/surprises.md), generated from the log.

Recorded in `docs/log.xml` with `example="iot-rules"`:

- `l-p4-examples-iot-maxops-time`: the quickjs guide's "within
  milliseconds" for `maxOps: 10_000` is 260 ms to 2.5 s. Fixed in the
  guide, which gives these measurements and recommends values.
- `l-p4-examples-iot-syntax-unchecked`: `compileCharts` did not parse a
  chart's JavaScript. Fixed: it reports a syntax error as a warning, an
  error with `{ warningsAsErrors: true }`, which the platform passes.
- `l-p4-examples-iot-error-reason`: nothing said why an evaluation failed.
  Fixed: `error.execution` carries `{ reason, message }`.
- `l-p4-examples-iot-invoke-crash`: a sandboxed chart's `<invoke>` of an
  unknown type threw from the host's turn, which could end the process.
  Fixed: the invoker gets `error.communication`, and nothing is thrown.
- `l-p4-examples-iot-script-let`: a transition's script with a top-level
  `let` ran once, and failed every time after. Fixed: such a script runs
  in a block.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/iot-rules/main.mjs                      # or: bun examples/iot-rules/main.mjs
node examples/iot-rules/main.mjs --samples 100 --seed 7
node examples/iot-rules/main.mjs --measure            # add --default-max-ops for the half-minute one
node examples/iot-rules/main.mjs --compare
```

The run prints each customer's inbox in brief: rules installed and
rejected with their diagnostics, alerts, errors, violations and
suspensions, then checks globex's alerts against the samples its devices
sent, and prints what two of the rules cost.

## Test it

```sh
mise run examples iot-rules     # under node and bun
node examples/iot-rules/test.mjs
bun test ./examples/iot-rules/test.mjs
```

The cases run on a `SimulatedClock`; the measurements run at a small
size, the native datamodel's spin in a child process killed after 300
ms, and the last case runs `main.mjs` on the real clock. All of it takes
about a second and a half.
