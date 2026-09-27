# @tinyactors/node

Tinyactors for Node.js (22.14 or newer) and Bun: SCXML statecharts run as
actors on a native runtime, through Node-API.

```text
npm install @tinyactors/node
```

The install brings a prebuilt addon for your platform: no compiler, no
`node-gyp` and no postinstall script. There are addons for macOS on Apple
silicon and Intel (11.0 or newer) and for Linux on x64 and arm64; the Linux
addon links no C library, so one build serves glibc and musl (Alpine).

```js
const { createSystem, statechart } = require('@tinyactors/node');

const light = statechart({ family: 'light', revision: 'v1' })
  .data('switches', 0)
  .state('off', (s) => s.on('toggle', (t) => t.target('on').assign('switches', function () { return this.switches + 1; })))
  .state('on', (s) => s.on('toggle', (t) => t.target('off')));

async function main() {
  const system = createSystem();
  const lamp = system.spawn(system.define(light), { name: 'lamp' });
  await lamp.send('toggle'); // resolves once the macrostep it started ends
  console.log(lamp.inspect().activeStates, lamp.data().switches); // [ 'on' ] 1
  system.close();
}

main();
```

`index.d.ts` describes the whole API. The package is 0.x: its API changes
in minor versions.

## Working on it in the repository

In this repository the package is built and tested through the task
interface; the addon it loads is the one `mise run build` writes:

```text
mise run build
mise run test
```

The tests load the same native addon with Node.js and Bun. See
[`docs/design.md`](docs/design.md) for the binding architecture, and
[ADR 0001](../docs/adr/0001-packaging-and-releases.md) for how the packages
are built and released: `mise run build --target <t>` builds a release
target's addon with zig, `mise run symbols` checks what it imports, and
`mise run package` stages and packs the npm packages into
`build/npm/tarballs/`.

## `index.d.ts` is the desired API

`index.d.ts` is the design target, not a description of what `lib/`
implements. A declaration that is not implemented yet carries
`// status: unimplemented`, or `// status: partial: <what is missing>`, on
the line directly above it. Don't delete a declaration because `lib/` lacks
it: implement it, or leave it marked. `grep -n "^ *// status:" index.d.ts`
lists what is outstanding, and `mise run check-api-status` (part of
`mise run test`) fails when a marker is stale or a missing declaration is
unmarked, for the exports and for the objects it can probe at runtime.

## Benchmarks

`mise run bench [population ...]` runs the tracing bench on Node and Bun and
prints throughput and memory side by side; `mise run bench-compare <commit>`
builds another commit beside the working tree and runs both alternately on
this machine, flagging changes past 5%. Results are stored under
`bench/results/<machine signature>/` (see its README).

**Reporting convention.** A benchmark report always gives throughput and
memory together, names the machine signature it ran under, and compares
builds side by side with `bench-compare`, never against numbers from another
day or another machine: the same build measured 30% apart on two days on
one machine.

## Loading actors on demand

`System.setLoader(family, loader)` brings actors of a family back when mail
arrives for them. Mail for a name with no resident actor waits while the
loader runs, then is delivered first, in order. The loader returns a
`SessionImage` (process-local: for actors offloaded from memory in this
process), `{ spawn: definition, binding }` to rebuild an actor from data
the application stored (after a restart, for example), `"not-found"`, or
`"reject"` for "not now". An unloaded actor's own timers wake it through
its loader. See [ADR 0020](docs/adr/0020-mail-for-an-unloaded-actor-waits-while-a-loader-brings-it-back.md).

## Tracing

`System.setTraceSink()` hands a function you register the spans of each
pump turn as OTLP protobuf bytes, which any OTLP/HTTP collector takes as
they are; `decodeTraces()` reads them back into objects. There is no
telemetry dependency. See
[`docs/tracing.md`](docs/tracing.md), and `mise run otel-demo` to look at
a trace in otel-tui.

SCXML documents import with `define(xml, { format: 'scxml' })`, and
`registerDatamodel()` plugs in a compiler for their expression text. See
[`docs/scxml.md`](docs/scxml.md).

## Debugging an actor

`createDebugSession(system, { allow, audit, send })` is a Debug Adapter
Protocol session over one actor of a running system: give it each incoming
message with `receive()`, and it hands each outgoing one to `send`. It
opens no socket and checks no credentials; put it behind your own
transport and authentication, and decide each user's permissions before
you create it. `DAPReader` and `encodeDAPMessage` frame messages on a byte
stream (stdio, a TCP socket); a WebSocket needs neither.

A client attaches with `{ "address": "family/name" }` (or `"sessionID"`),
and may ask for fewer permissions with `"allow"`. The session watches the
actor live and never stops it: a production actor is never held by a
debugger. The client hears the actor stopped on entry, so it shows the
stack and the variables, and after each macrostep the summary in the
console and a refresh of both that leaves the keyboard focus where it is,
so typing in the Debug Console is never interrupted. `pause` and the
steps are refused, and `continue` changes nothing. Breakpoints are
tracepoints: the console says where one would have stopped, and a logpoint
writes its message.

What `allow` grants are pokes, each a transition the watcher sees as a new
macrostep: `send` an event through the mailbox, `set` a data-model
location, `goto` (an operator transition, with `abandon`, `cancel` and
`replace`), and `evaluate`. With none, the session only watches.

**`evaluate` runs arbitrary code.** Watch, hover and console expressions,
breakpoint conditions and logpoint `{expression}` parts run JavaScript in
your process. They need the `evaluate` permission, which is off unless
granted, and each is checked against the attach it runs under: a
condition set before a watch-only attach never runs. Without it the
Variables pane and the console commands still work. Grant it only to
someone who may run code on the host.

Frames and line breakpoints are on the lines a chart was written on:
the builder calls of statechart(), or the lines of an SCXML document you
name with `define(text, { format: 'scxml', name: path })`. A document
defined without a name, or a child chart inline in `<content>`, is shown
as SCXML the session writes from the definition, which the client asks
for by `sourceReference` and sets breakpoints in.

`audit(entry)` hears every attach, detach, breakpoint change, console
command, evaluation and mutation before it happens; a hook that throws
refuses it. That includes each breakpoint condition and logpoint part at
each hit: a refused condition does not fire, and a refused part is
written as `<refused>`. Only a detach is heard after it happens.

`mise run dap-server` serves sessions for a small example system over
stdio, or on a local port with `-- --port 4711`, to try a DAP client
against. It grants every permission; it is a development tool, not part
of the package. In VS Code, install
[tinyactors-vscode](../tinyactors-vscode/README.md): an `attach`
configuration with the `port` and the actor's `address` connects to such a
server. See
[ADR 0026](docs/adr/0026-a-debugger-watches-and-pokes-one-live-actor.md)
and [the status of every DAP message](../docs/debug-adapter.md).

`test/dap-transcripts.js` plays the DAP transcripts napi shares with the
test host's adapter (`../tinyactors-test/dap/transcripts/`), under Node
and Bun, so the two adapters stay in step. To add one, write the
transcript, and the chart in both forms (`dap/charts/<chart>.js` and
`.rb`) if it needs a new one, then play it in both hosts: `node
test/dap-transcripts.js <name>` here (`DAP_TRACE=1` prints every message)
and `ruby ruby/dap_transcripts.rb <name>` in tinyactors-test. The format
and where the adapters differ are in
[its README](../tinyactors-test/dap/README.md).
