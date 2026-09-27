# Tinyactors Node-API binding design

> Superseded where they differ by the ADRs in [`adr/`](adr/README.md), which
> record the design of the from-scratch rewrite.

## Status and scope

This document records the design for the Node-API binding. The current module
is only a native loading and packaging stub: it exports its package `version`
and does not yet link Tinyactors core.

The binding targets Node.js 22 or newer and Bun. Its correctness boundary is
the stable Node-API C interface. It does not depend on V8, JavaScriptCore,
`node.h`, or direct access to a libuv event loop.

## Runtime ownership

JavaScript explicitly creates and closes each system. A system, its actors,
definitions, queues, and retained JavaScript values belong to the JavaScript
environment and thread that created it. No `ta_system` call may run
concurrently, and a system cannot move between Workers.

The native `System` wrapper will own:

- one `ta_system`;
- its in-memory actor directory;
- its external-message and runnable-actor queues;
- definition and actor handle tables;
- its data-model adapter and retained JavaScript values;
- pending message completions; and
- scheduler state and execution budgets.

There is no process-global system registry. Each Node.js or Bun Worker has its
own Node-API environment and creates independent systems.

## JavaScript definitions and data model

Definitions are authored with a fluent JavaScript builder or supplied directly
as normalized JavaScript object trees corresponding to the Tinyactors SCXML
specification structures. `System.define()` accepts either form, normalizes it,
and compiles it synchronously. Structural data and strings are copied during
compilation. JavaScript expression functions are represented as
`TA_EXPRESSION_HOST` values and retained for the lifetime of the compiled
definition.

Expressions are functions or explicit operation descriptors, not source text:

- values and conditions are functions;
- locations provide getter and setter functions;
- scripts are synchronous functions; and
- the call context provides the current event, session identity, `inState`,
  and the other SCXML system values.

Data-model functions must not return promises. A Tinyactors macrostep cannot
suspend inside an expression. Asynchronous work is initiated through an I/O
processor or invoker and reports completion as a later external event.

Definitions used for reconstruction have explicit family and revision values.
The binding does not derive a durable revision from `Function#toString`, since
function text does not identify captured closure state.

### Fluent authoring

`statechart<Data>()` creates a mutable definition builder. `System.define()` or
an explicit `build()` consumes it. Builder call order is document order for
states, transitions, handlers, actions, data declarations, parameters, and
invocations.

```ts
interface PlayerData {
  partner: string;
  volleys: number;
  limit: number;
  rallying: boolean;
  server: boolean;
}

const player = statechart<PlayerData>({
  family: "player",
  revision: "player/v1",
  name: "player",
})
  .data("partner", "#_actor_player/nobody")
  .data("volleys", 0)
  .data("limit", 15)
  .data("rallying", false)
  .data("server", false)
  .initial("idle")
  .state("idle", idle => {
    idle.always(transition => {
      transition
        .when(({ data }) => data.rallying && data.server)
        .target("rallying");
    });

    idle.on("serve", transition => {
      transition
        .target("rallying")
        .assign("volleys", 1)
        .assign("rallying", true)
        .assign("server", true);
    });
  })
  .state("rallying", rallying => {
    rallying.entry(actions => {
      actions
        .log("hit", ({ data }) =>
          `RALLY volley ${data.volleys} -> ${data.partner}`)
        .send("ball", send => {
          send
            .id("ball")
            .to(({ data }) => data.partner)
            .after("1s");
        });
    });

    rallying.exit(actions => {
      actions.cancel("ball");
    });

    rallying.on("ball", transition => {
      transition
        .when(({ data }) => data.volleys < data.limit)
        .target("rallying")
        .assign("volleys", ({ data }) => data.volleys + 1);
    });
  });

const definition = system.define(player);
```

Each `entry()` or `exit()` call creates a distinct executable-content block,
because failure skips the remainder of one handler without skipping later
handlers. `on()` creates an external transition by default; `always()` creates
an eventless transition. `internal()` changes a transition's kind.

The builder records where each state, transition, initial transition and
action was written: the file, line and column of the builder call, from a
V8 call site, as a source span of the spec (core ADR 0085).
`definition.sourceOf(kind, id)` reads one back by core's ID, which is how a
debugger places trace records and breakpoints in the JavaScript that wrote
the chart. Spans never change a revision. The capture costs about 5 to 7 µs
per element when the chart is defined and nothing afterwards. A call is
located at its own statement: JavaScriptCore (Bun) places a call inside a
chain that spans lines less exactly than V8 does.

Top-level assignments use typed property names, such as
`.assign("volleys", 1)`. `assignAt()` accepts an explicit getter/setter
`Location` for nested or computed storage. A function in a value position is
an expression; `literal(functionValue)` explicitly stores a function as data.
`content(text, { mediaType })` is literal SCXML `<content>`: an I/O
processor or invoker gets it as text with its media type, and anywhere else
it is a value (JSON when it parses, space-normalized text otherwise). Every
builder chart compiles against the JavaScript data model; only a plain spec
with `datamodel: "null"`, or an SCXML document with `datamodel="null"`, gets
core's null data model. The normalized `DefinitionSpec` remains public as an escape hatch and as the
stable boundary between authoring helpers and native compilation.

### Updating a definition in a running system

Definitions are immutable. Updating a chart registers a new definition with
the same family and a new revision, then replaces each named actor that should
run it. Mutating an already-registered builder or definition is never an
update.

```ts
const nextDefinition = system.define(
  statechart<PlayerData>({
    family: "player",       // unchanged logical family
    revision: "player/v2",  // new exact semantics
    name: "player",
  })
    // ...the v2 chart...
);

function replace<Data extends object>(
  incumbent: Actor<Data>,
  definition: Definition<Data>,
): Actor<Data> {
  // The incumbent's live data-model root is the default binding.
  const prepared = incumbent.prepareReplacement(definition);

  try {
    // Atomically changes the named route and releases held bootstrap effects.
    const replacement = prepared.activate();
    incumbent.destroy();
    return replacement;
  } catch (error) {
    // A failed activation leaves the incumbent published at the address.
    prepared.destroy();
    throw error;
  }
}

const previousDefinition = playerDefinition;
ping = replace(ping, nextDefinition);
pong = replace(pong, nextDefinition);
playerDefinition = nextDefinition;
previousDefinition.retire();

await system.flush();
```

Preparing a replacement creates and bootstraps a fresh, unpublished
interpreter. Core holds its externally visible bootstrap effects until
activation. Activation atomically changes that actor's named route, but it does
not destroy the incumbent; the binding must do so after a successful swap. If
activation fails, the incumbent still owns the route and the binding destroys
the unpublished prepared actor.

Replacement preserves the logical address and, by default, the exact live
JavaScript data root. It does not translate the active state configuration.
The replacement starts at the new definition's initial state, and the
incumbent's delayed sends are discarded. Active invoked children and other
runtime-only service handles do not move to the replacement and need the
host's normal cancellation or cleanup policy.

Because the same data object is used during preparation, initialization may
mutate it before activation. The system's single-threaded execution discipline
prevents concurrent interpreter access, but applications that need rollback of
data mutations must prepare against a copy and explicitly choose when to make
that copy authoritative.

Route replacement is atomic for one actor, not for a group. A multi-actor
rollout may temporarily contain both revisions. When replacing related actors
in one in-process system, perform the synchronous prepare/activate calls in one
JavaScript turn so the scheduler pump cannot interleave queued traffic between
them. Distributed or durable deployments require a higher-level rollout and
fencing protocol.

Only named actors can be replaced in place, and the family must remain the
same. A family change requires destroying and respawning the actor, which has a
different routing boundary. The old definition can be retired after the
rollout; retirement prevents new spawns but does not stop any actors that were
intentionally left on the old revision.

The low-level prepare/activate methods remain public for staged rollout,
fencing, logging, and custom child cleanup. A later convenience method such as
`actor.replaceWith(definition)` may wrap preparation, activation, failure
cleanup, and incumbent destruction without changing those semantics.

## JavaScript value lifetime

A `ta_value` is backed by a native box containing the owning system, one strong
`napi_ref`, and a native reference count. Retain increments that count. Release
deletes the Node-API reference when the count reaches zero. Clone shares the
same box instead of structured-cloning the JavaScript value.

The system therefore owns the value's lifetime, not exclusive mutation rights.
If application code mutates an object after sending it, a later actor may see
that mutation. An optional higher-level copy policy can call `structuredClone`
before submission, but copying is not the native binding's default semantic.

All reference operations and system destruction occur on the owning JavaScript
thread.

## Queues and scheduling

The host owns external scheduling. The binding uses two sparse native queue
layers:

1. External envelopes contain calls to `send`, normalized inter-actor
   deliveries, and asynchronous I/O or invocation completions. An envelope
   retains its JavaScript data.
2. The runnable queue contains actors whose macrostep has started but paused at
   an execution budget. A paused actor remains runnable until it becomes
   stable, done, or erroneous.

External mailboxes are allocated only for actors that have queued messages.
This avoids permanent per-actor mailbox overhead while also avoiding global
head-of-line blocking when one target is paused.

The external-event router copies every borrowed `ta_external_delivery` into the
host queue and returns accepted. It never recursively delivers to an actor.
Calls made from data-model, I/O, invoker, or logging callbacks may enqueue work
but may not re-enter the Tinyactors interpreter.

One bounded pump turn:

1. resumes runnable actors for a configured budget;
2. delivers queued external events only to stable actors;
3. dispatches due delayed sends with a configured callback budget; and
4. schedules another turn when work remains.

Message promises resolve according to an explicitly documented mode: queue
acceptance or completion of the message's macrostep. Queue depth and retained
data size limits provide backpressure. Closing a system rejects queued and
pending messages.

### Poking one actor for a debugger

A debugger watches one actor and pokes it; it never stops it
([ADR 0026](adr/0026-a-debugger-watches-and-pokes-one-live-actor.md)). An
operator transition (core ADR 0082) travels in the envelope behind the
actor's queued mail, abandoning a macrostep settles the send() that waited
for it, and `mailbox()` lists what waits for an actor.

## MessageChannel and Workers

A private `MessageChannel` may provide the scheduler wake-up. The real
envelopes stay in the native retained-reference queues. Enqueueing work posts a
single coalesced token when no pump is already scheduled. The port callback
runs one bounded pump and posts another token if work remains.

The channel does not carry actor data. `postMessage` uses structured cloning,
which would lose object identity, reject functions, change prototypes and
accessors, and provide no portable queue-depth or backpressure control. Posting
only opaque IDs would still require a retained-value table and deterministic
cleanup, which is the native queue under another name.

The scheduler must not keep an otherwise idle process alive. Its ports are
unreferenced where the runtime supports that operation and are closed when the
system closes.

An optional Worker-hosted facade may use Worker `postMessage` as its ingress
transport. That is a distinct mode with structured-clone semantics: the real
system and definitions live inside the Worker, functions are registered there,
and message IDs plus acknowledgements provide completion and backpressure.
Local actor-to-actor traffic still uses the native queues.

## Logical time

The JavaScript layer supplies monotonic milliseconds, normally relative to
`performance.now()`. After a pump it reads the next Tinyactors deadline and
arms one JavaScript timer. The timer advances logical time, dispatches due
sends, and wakes the pump. A manual-clock mode supports deterministic tests.

This deliberately avoids `napi_get_uv_event_loop` and direct libuv timers so
the same design works under Node.js and Bun.

## I/O, invocation, and logs

The first implementation will provide an in-memory actor directory and an
SCXML invoker that creates child actors in the same system. Application I/O
processors and invokers are JavaScript callbacks. They may start asynchronous
work, but their promise completion re-enters the system only by enqueueing an
event or invocation report.

Log callbacks are buffered until the current core call returns. This prevents
logging code from re-entering the interpreter.

Durable virtual actors are a later layer. Checkpoint storage, binding locators,
unloaded-actor deadlines, and fencing are host infrastructure rather than
requirements of the initial in-process binding.

## Errors and teardown

Binding misuse and C API failures become thrown exceptions or rejected message
promises. Exceptions from chart expressions are captured as fault data so the
core can produce the corresponding `error.execution` event.

`System.close()` is explicit, idempotent, and authoritative. It stops new
messages, cancels the scheduler timer and wake-up channel, detaches external
services, rejects pending messages, destroys the `ta_system`, releases all
definition callbacks and JavaScript values, and invalidates subordinate
handles.

The JavaScript wrapper finalizer and Node-API environment cleanup hook are
safety nets. Cleanup is ordered through the owning system; independent actor,
definition, and value finalizers must not race environment teardown.
