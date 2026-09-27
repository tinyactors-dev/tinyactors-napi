# ADR 0020: Mail for an unloaded actor waits while a loader brings it back

**Status:** Accepted and implemented (2026-09-25); see the implementation notes for where the code differs from the text. Answer 1 is superseded by core ADR 0074 (rewritten): session images are process-local, so a restart after a process exit rebuilds actors from the application's data (`{ spawn, binding }`) or a replayed log, not from stored images. Refines ADR 0005 (a mailbox can belong to an address, not only to an actor), ADR 0006 point 4 (an unloaded or unknown name is no longer always a dead letter) and ADR 0012. Research: [`docs/research/loading-actors-on-demand.md`](../../../docs/research/loading-actors-on-demand.md). Core ADR 0074 (accepted 2026-09-25) adds to the restart sequence: an application stores an actor's pending delayed sends with its data, and a loader returns `{ spawn, binding, pendingSends }`, so the actor's timers survive the restart; in-process loads read napi's offload store before calling the loader.
**Date:** 2026-09-25

## Context

Step 14 of the roadmap added `unload()` and `load()`. An unloaded named
actor keeps its session ID (core ADR 0066) but has no runtime ID. Mail for
its address is a dead letter with reason `unloaded` (ADR 0006 point 4).
Nothing holds the mail and nothing brings the actor back: the host has to
load it before anyone sends to it.

Core already routes every kind of mail for an unloaded actor to one
place. Mail sent to `#_scxml_<sessionid>` of an unloaded named session is
rewritten to its named address (core ADR 0066), so all of it reaches
napi's router as "a named address whose directory entry is unloaded".
Mail to a name with no entry at all is "not found" there too.

The user chose, for this decision (option A of decision 3), a loader hook:
mail for an unloaded actor waits while the host brings the actor back, so
senders need not know whether an actor is resident. Two other decisions
constrain the design:

- **No hold or release state for resident actors** (decision 4, option
  D). A host pauses an actor by unloading it, because that is easy to
  reason about, especially for graceful process restarts: drain, unload,
  restart, load. So during a shutdown the loader must be able to answer
  "not now", or mail would load the actor straight back.
- **A limit on microsteps per macrostep that quarantines runaway actors**
  (decision 5, leaning towards option A). Nothing here conflicts with it:
  a loaded actor starts with no macrostep in progress.

What other runtimes do (research note): Orleans and Akka buffer mail per
activation or shard, deliver it in order to the new incarnation, bound it
(Akka: 100,000 per region, then dropped and counted), and make failure
visible to callers. Proto.Actor and Erlang buffer nothing and leave
retries to callers. tinyactors' senders are statecharts, which cannot
retry, so the runtime has to hold their mail.

## Decision

### 1. The waiting mail lives in napi's portable plumbing, and moves to the host kernel with it

A directory entry gains a third state beside resident and unloaded:
**waiting**, with a mailbox of its own. It is the same kind of mailbox as
an actor's (ADR 0005 point 3): a list threaded through envelopes from the
system's free list, with its `send()` waiters. The directory
(`directory.c`) and the scheduler (`scheduler.c`) hold it. Both are
already free of Node-API, so the waiting mail moves into the host kernel
unchanged when the kernel is extracted (`docs/proposals/host-kernel.md`).
The user suspected the kernel; the answer is "the part of napi that
becomes the kernel", which needs no waiting.

**Core does not change for the queues.** Core is freestanding and
deterministic, and residency policy (caps, timeouts, asynchronous loads)
is the host's. Core already hands every such message to the router, and
the router already owns mail that core has accepted. The database hosts
will keep waiting mail in a table, with the same contract (section 2).

### 2. A loader per definition family

```ts
system.setLoader(family, async (address, why) => result, { timeout = 5000, maxWaiting = 1000 })
```

- **Which mail triggers it:** mail for a name in `family` whose directory
  entry is unloaded, **or which has no entry at all.** The second case
  makes a family virtual: every name in it can be addressed, and the
  first message brings the actor into existence or back from storage.
  That is also what makes a restart work (section 6): after a restart the
  directory is empty.
- **`why`** is `'mail'`, or `'timer'` for a wake-up (section 4).
- **The result** says what to do with the waiting mail:

| Result | Meaning | Waiting mail |
|---|---|---|
| a `SessionImage` | load it (`load()`, same session ID, new runtime ID) | delivered first, in order |
| `{ spawn: definition, binding? }` | a new actor at this address | delivered first, in order |
| `'not-found'` | there is no such actor | dead letters, reason `not-found` |
| `'reject'`, or `{ reject: reason }` | not now (for example during a shutdown) | dead letters, reason `rejected`, with the reason |
| a thrown error or a rejected promise | loading failed | dead letters, reason `load-failed`, with the error |

- **One load in flight per address.** The loader is called once. Mail
  that arrives while it runs joins the same waiting mailbox. When the
  load succeeds, the mailbox is moved to the front of the new actor's
  mailbox, exactly as replacement moves an incumbent's mail (ADR 0005
  point 12), and the entry becomes resident.
- **Timeout.** A loader that has not settled after `timeout` ms fails the
  load with reason `load-timeout`. A result that arrives later is
  discarded, and an image in it is destroyed; a WARN log says so.
- **Before the waiting mail is delivered,** the loader may return
  `{ image, restore: async (actor) => {} }`. `restore` runs with the
  actor resident but its waiting mail not yet delivered, so replay-based
  persistence can replay its log in place (section 5). This is internal
  to one load, not a hold state that a host can set on an actor.
- **The loader's own calls.** It may call `system` normally, including
  `load()` of other actors. It may not `load()` its own address itself:
  it returns the image, so that the waiting mail and the new actor meet
  in one step.

### 3. Order

- **Mail from one sender to one address keeps its order across a load.**
  It is appended to the waiting mailbox in the order the router accepts
  it, and that mailbox goes to the front of the new actor's mailbox
  before anything else can reach it. Once the actor is resident, new
  mail goes to its mailbox as usual.
- **RETRY.** If the system-wide limits (section 5) make the router answer
  `TA_EXTERNAL_EVENT_RETRY`, core keeps the message and offers it again.
  As today, a later message from the same sender may then be accepted
  first (core ADR 0070 open point 6). Waiting mail neither fixes nor
  worsens that.
- **Delayed sends to the actor** from other actors, which come due while
  it is unloaded, are routed like any other mail, so they wait and are
  delivered after the load.

### 4. The actor's own timers wake it

An unloaded actor's pending delayed sends travel in its image, so today
they don't fire until someone loads it. An actor that sets a timeout and
then gets unloaded would never time out. Orleans separates timers, which
die with the activation, from reminders, which wake the grain; here every
delayed send is a reminder.

- **At `unload()`,** napi reads `ta_session_image_next_deadline()` and
  keeps it on the unloaded entry.
- **When that time comes,** napi calls the loader with `why = 'timer'`.
  After the load, core fires the due sends late, as after any
  `unload`/`load`.
- **After a restart** there is no entry to keep the time on. The host
  stored the deadline next to the image, and re-registers it with
  `system.wakeAt(address, time)`.

### 5. Limits

- **Per address:** `maxWaiting` (default 1,000) envelopes. Mail beyond it
  is a dead letter with reason `waiting-full`, counted and logged. This is
  Akka's choice: drop visibly rather than let one address fill the
  system.
- **System-wide:** waiting envelopes are envelopes, so `maxQueuedMessages`
  and `maxRetainedBytes` (ADR 0005 point 9) count them. When those are
  full, `post` and `send` report `queue-full` and the router answers
  RETRY, as today.
- **`send()`'s promise** resolves when the message is delivered after the
  load, and rejects with the dead-letter reason if the mail is dropped.

### 6. A graceful restart

With no hold state, a restart is a sequence of unloads, a loader that
refuses, and a loader that loads:

1. **Stop intake** at the edge (the HTTP server stops accepting).
2. **Refuse loads.** `setLoader(family, () => 'reject')` for every family.
   Mail for unloaded actors becomes a dead letter with reason `rejected`.
   The `deadLetter` hook writes those messages to an outbox in the host's
   storage.
3. **Drain.** `await system.flush()` until the system is quiet.
4. **Unload every named actor:** capture, serialize, store the image and
   its next deadline, then `unload()`. `unload()` refuses (`busy`) while
   mail waits or a macrostep runs; flush and try again, up to a deadline.
5. **Exit.**
6. **Restart:** `createSystem`, `define` the charts, and `setLoader` for
   each family to read the stored image (or `'not-found'`, or
   `{ spawn }` for a first-ever message).
7. **Register wake-ups:** `wakeAt(address, deadline)` for each stored
   deadline.
8. **Replay the outbox:** post the dead letters stored in step 2, in the
   order they were stored.
9. **Open intake.** Actors load as their mail arrives.

**This needs a serialized session image, which does not exist yet.**
Images today are in-memory handles (`SessionImage`) with no byte format.
Steps 4 and 6 need one. The replay-based persistence proposal needs the
same value codec. Until then, the loader works within one process: for
unloading idle actors to save memory, not for restarts.

### 7. Observability

- **Metrics** (core ADR 0072 names, napi ADR 0017):
  - `tinyactors.loads`, a sum by `tinyactors.load.outcome`: `loaded`,
    `spawned`, `not_found`, `rejected`, `failed`, `timed_out`;
  - `tinyactors.load.duration` (s), a histogram whose exemplars link to
    the trace of the mail that triggered the load;
  - `tinyactors.messages.waiting`, a gauge;
  - `tinyactors.dead_letters` gains the reasons `rejected`, `load-failed`,
    `load-timeout` and `waiting-full`.
- **Logs:** WARN `tinyactors.load.failed` and `tinyactors.load.timed_out`,
  with the address, the error and the number of messages dropped, under
  the existing rate limit.
- **Traces.** Waiting envelopes keep their trace parent (napi keeps it out
  of line for traced mail), so the macrostep each one starts after the
  load is in its sender's trace. The `LOADED` lifecycle span today has no
  parent (core ADR 0067: host operations that are not events carry none).
  A small core change would let `ta_actor_load` take the parent of the
  message that triggered it, putting the load itself in the sender's
  trace. That is question 4.

## Options considered

**Where the waiting mail lives:**

| Option | Pros | Cons |
|---|---|---|
| **A. napi's portable directory and scheduler, moving to the kernel** (chosen) | reuses mailboxes, envelopes, waiters and limits; mail between actors stays native; moves to the kernel unchanged | napi's directory entry grows a third state |
| B. Core holds mail for unloaded addresses | deterministic; every host gets it | core has no time and no async, so timeouts and loads are still the host's; residency policy in core; database hosts keep mail in tables anyway |
| C. JavaScript (`lib/`) holds it | simplest to write | every message for an unloaded actor crosses into JavaScript, against ADR 0006; ordering against native mailboxes is hard |
| D. The loader stores each message itself (an outbox) | durable across crashes | a JavaScript call per message; slow; the deadLetter hook already allows it where it's wanted (section 6) |

**What triggers a load:**

| Option | Pros | Cons |
|---|---|---|
| **Unloaded entries and unknown names in a loader's family** (chosen) | virtual actors; restarts need no directory to be rebuilt | a typo in a name spawns or looks up an actor unless the loader says `'not-found'` |
| Unloaded entries only | never creates actors by surprise | after a restart the host must recreate every unloaded entry before any mail |

**When the waiting mailbox is full:**

| Option | Pros | Cons |
|---|---|---|
| **Dead letter `waiting-full`** (chosen) | visible, bounded, and one address cannot fill the system | mail is dropped (counted and logged) |
| RETRY or `queue-full` | nothing dropped | a slow load stalls every sender to that address, and RETRY can reorder a sender's mail |

## Consequences

- Senders need not know whether an actor is resident, and families can be
  virtual.
- Unloading becomes safe for idle actors with timers: they wake for them.
- A restart is a sequence the host controls, with no hold state, but it
  waits for a serialized image format.
- The directory, the scheduler, the metrics and the dead-letter reasons
  grow; the public API gains `setLoader` and `wakeAt`.

## Testing (when implemented)

- **Native tests** of the directory and scheduler: a waiting mailbox
  moves in order to the front of the loaded actor's mailbox; the
  per-address cap; waiting envelopes count against `maxQueuedMessages`.
- **JavaScript, on Node and Bun:**
  - mail from actors and from JavaScript to an unloaded address is
    delivered in order after the load, with `send()` resolving;
  - one loader call per address under concurrent mail;
  - each result kind, the timeout, and a late result being discarded;
  - a wake-up from `ta_session_image_next_deadline`;
  - the graceful-restart sequence within one process (unload all, reject,
    outbox, load back), with a serialized image stubbed until one exists;
  - traces: a loaded actor's first macrostep is in its sender's trace.

## Questions for the user

**Answered 2026-09-25; every suggestion accepted:**

1. **Serialized session images come first,** as a core ADR. Core does not
   prescribe the format: it defines a codec interface, as it does for
   chart definitions (core ADR 0053), and hosts plug codecs in. Replay
   persistence uses the same interface.
2. **A loader's family is virtual:** unknown names call the loader too.
3. **Unloaded actors wake for their own timers** by default.
4. **`ta_actor_load` takes the triggering message's trace parent,** so the
   `LOADED` span stays in the sender's trace.
5. **The defaults stand:** a 5-second `timeout` and `maxWaiting` of 1,000
   per address, both configurable.

The original questions were:

1. **A serialized session image** is needed for restarts across
   processes (section 6). Should that core ADR (a byte format for images,
   with the value codec replay persistence also needs) come before this
   one is built?
2. **Unknown names:** should a loader's family be virtual (first message
   to any name calls the loader), or should only unloaded entries trigger
   it?
3. **Wake-ups:** should unloaded actors wake for their own timers
   (section 4), or sleep until mail arrives?
4. **The `LOADED` span in the sender's trace:** accept the small core
   change to `ta_actor_load`'s params?
5. **Defaults:** `timeout` 5 s and `maxWaiting` 1,000 per address?

## Implementation notes

Implemented 2026-09-25: core `5f0aa7b` (`ta_actor_load` takes a trace
parent) and napi `92474b9`.

**Where it lives.**
- `src/loads.{c,h}` (portable, no Node-API, so it moves to the host kernel):
  - loader families with their `maxWaiting`;
  - one load record per address in flight, with its waiting mailbox;
  - the queue of loads JavaScript has not heard of;
  - a min-heap of wake-ups.
- The scheduler gains `tna_mailbox` and three operations on it: post into a
  waiting mailbox, hand it to the front of an actor's mailbox, and bury it
  as dead letters. Replacement's transfer uses the same splice.
- The router checks for a load in flight first, then for a loader.
- `src/napi_loads.c` hands new loads to `lib/system.js` after each turn and
  takes back the outcome (`completeLoad`); `lib/system.js` has `setLoader`,
  `wakeAt` and the loader runner.

**Where it differs from the text.**
1. **The directory is unchanged.** Section 1 put a third "waiting" state in
   the directory. The directory stays core's adapter, with resident and
   unloaded entries; the waiting state is the load record in `loads.c`,
   keyed by the same interned address.
2. **A load in flight holds the address's mail until it finishes**, even
   after `load()` or the spawn made the actor resident, so mail that
   arrives during `restore` still waits and keeps its order.
3. **The loader runner is not a hook the system holds.** A native reference
   to a function that closes over the `System` would keep the system from
   ever being finalized (`test/system.js` caught it). New loads reach
   `lib/system.js` through the environment's effect handler, as service
   effects do, with the kind `"loads"`.
4. **The timeout runs on JavaScript's timers,** not core's clock, so a
   manual clock does not move it. A result that arrives after the timeout
   is discarded and an image in it destroyed; the timeout's own WARN log
   is the only log.
5. **`detail` on dead letters** comes from `lib/system.js`: the last
   failure per address (the rejection's reason, the error, or the
   timeout), added to the letters of reasons `rejected`, `load-failed` and
   `load-timeout`.
6. **`{ spawn }` at an unloaded address** first releases it
   (`removeUnloaded`): the application's data replaces the image.
7. **A `restore` that throws** finishes the load as `load-failed`: the
   waiting mail becomes dead letters, and the actor stays resident.
8. **`flush()` waits for loads in flight,** so a test or a shutdown sees
   their outcome.
9. **`ta_actor_load` takes the trace parent** (answer 4) of the first
   waiting message; `{ spawn }` runs under it too. A load a wake-up started
   has none.

**Restarts (section 6), after core ADR 0074 was rewritten.** Session
images are process-local: they offload actors from memory within one
process's lifetime, and do not cross processes. So the sequence in section
6 holds within one process (`test/loads.js`, `gracefulRestart`: unload
all, loaders reject into an outbox, loaders load, the outbox is replayed).
After a process exit, the loader rebuilds each actor from the data the
application stored, `{ spawn: definition, binding }`, or replays a log;
the test's second round does that. Steps 4 and 6 do not store or read
images across processes.

**Costs.** Nothing per actor. One record per load in flight, reused through
a free list, and one heap entry per registered wake-up; waiting mail uses
ordinary envelopes. Mail to a resident named actor with no load in flight
pays one empty-map check in the router.

**Metrics and logs.** `tinyactors.loads` (a sum by
`tinyactors.load.outcome`: `loaded`, `spawned`, `not_found`, `rejected`,
`failed`, `timed_out`), `tinyactors.load.duration` (a histogram in seconds,
whose exemplar is the trace of the mail that caused the load),
`tinyactors.messages.waiting` (a gauge), and the dead-letter reasons
`rejected`, `load-failed`, `load-timeout` and `waiting-full`. Failed and
timed-out loads write WARN `tinyactors.load.failed` and
`tinyactors.load.timed_out` with the address, the number of messages
dropped and the detail, under the host logs' rate limit.

**Tests.** `test/native/loads_test.c` (also under AddressSanitizer):
- order across a load, including mail that arrives after the actor is
  resident and mail sent to it directly;
- the per-address cap, and waiting mail counting against
  `maxQueuedMessages`;
- every failure outcome, and a stale or wrong finish;
- a virtual family;
- wake-ups, including a replaced one and one for a resident actor.

`test/loads.js`, on Node and Bun:
- order, and `send()` resolving;
- a second message mid-load;
- each failure with its `detail`;
- a slow load, and a timed-out one whose late image is destroyed;
- `waiting-full`;
- `{ spawn, binding }` for a virtual family;
- a timer waking an unloaded actor, and `removeUnloaded` cancelling it;
- the graceful restart;
- the `LOADED` span and the macrostep in the sender's trace;
- argument checks.

Core's `session_id_test` checks that `LOADED` carries the load's parent.

**Open points.**
1. **Dead letters carry no data.** The `deadLetter` hook gives the target,
   the event and the reason, not the message's data, so an outbox built
   from it cannot replay a refused message as it was.
2. **Cancelling a waiting `send()`** settles its promise but leaves the
   message waiting; it is delivered after the load without its waiter.
3. **Loads reach JavaScript once per turn,** each as its own loader call;
   a loader that wants to batch storage reads has to do so itself.
