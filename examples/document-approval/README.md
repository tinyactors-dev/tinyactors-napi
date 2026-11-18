# Document approval

An approval desk whose documents are actors. A document goes from its
author through legal and finance review, at the same time, to a sign-off,
and then to an archive that keeps its record as XML. Each document is one
actor of [`charts/document.scxml`](charts/document.scxml), and the rules
that make approval workflows hard to get right are written there as
states:

- **Two reviews in parallel.** Legal and finance each claim the document,
  then approve it, request changes or reject it, each at their own pace.
  The review is done when both have approved, and only then does the
  document go to sign-off.
- **An order between them, for large amounts.** At 10,000 or more, finance
  may approve only after legal has. A finance approval that comes first is
  refused, and the reviewer is told why; it does not count.
- **Changes requested.** Either reviewer may send the document back to its
  author. A resubmission returns each reviewer to where they were: a
  reviewer who had approved stays approved, and the one who asked for the
  change finds it in their hands again, with the same reviewer. A
  *material* change restarts the review from the queues, and the earlier
  approvals no longer count.
- **An SLA per stage.** Legal and finance have 48 hours each, sign-off 24.
  A stage that runs past its SLA pauses the whole document: it is
  escalated to a manager, and verdicts that come in meanwhile are refused
  and their senders told. When the manager resumes it, perhaps giving the
  stage to another reviewer, the document is back exactly where it was,
  both reviews included, and the stage starts a new SLA.
- **Withdrawal** by the author ends the document from any stage, with
  every timer it had.
- **An archive that can fail.** The approved document's metadata goes to
  the archive as XML; a failed attempt is retried every second, and the
  document is approved only once its record is stored.

`main.mjs` checks at the end of a run that every approved document is in
the archive with its legal, finance and sign-off approvals, at the
version that was approved, and that no other document is.

## What is where

| File | What it holds |
|---|---|
| [`charts/document.scxml`](charts/document.scxml) | the document: the parallel review, the histories, the SLAs, the escalation, the archive's retries, and the helpers that write its XML |
| [`desk.mjs`](desk.mjs) | the application: the host, the notification and archive I/O processors, filing documents and acting on them |
| [`admin.mjs`](admin.mjs) | the admin view: every document's states and variables, as functions, as a table and as an HTTP endpoint |
| [`xml.mjs`](xml.mjs) | a small XML reader for the archive's records |
| [`main.mjs`](main.mjs) | a day at the desk on the real clock: bots that read their queue from the admin view and act on it |
| [`test.mjs`](test.mjs) | each rule above on a `SimulatedClock`, on both datamodels, the admin view, and the day of `main.mjs` |

## The tinyactors features it uses, and why

- **`<parallel>` with a final state per region, and `<donedata>`:** the
  two reviews are regions of the parallel state `review`, so each moves on
  its own and an event goes to both. A region's final state
  (`legalApproved`) carries the approval as `<donedata>`, which arrives
  with `done.state.legal`; when both regions are final, `done.state.review`
  moves the document to sign-off.
- **`In()` guards:** finance's approval of a large amount is guarded by
  `In('legalApproved')`, the other region's state, and a second transition
  on the same event refuses it.
- **History states:** each region has a shallow `<history>`. "Request
  changes" leaves the review for `revising`, and the resubmission targets
  both histories at once (`target="legalWasAt financeWasAt"`), so each
  region comes back to the state it left.
- **Deep history:** the escalation leaves `active` for `escalated`, and
  `resume` targets `active`'s deep `<history>`, which re-enters every
  state that was active below it: the parallel review with both regions'
  states, or `revising`, or `signoff`.
- **Delayed sends and `<cancel>`:** an SLA is a `<send delayexpr>` in a
  stage's `<onentry>`, cancelled in its `<onexit>`, and in the region's
  final state, which does not leave the region. Leaving a stage for any
  reason (an escalation, a change request, a withdrawal) cancels its
  timer, and coming back arms a new one.
- **`<script>` declarations:** the chart's helpers are `function`s
  declared in a chart-level `<script>`: `ms()` turns the SLA's
  milliseconds into a delay, `legalFirst()` holds the threshold rule, and
  `metadataXML()` writes the archive's record, escaping what it puts in.
  A chart that declares functions gives each actor a `vm` context of its
  own (about 143 KB on Node.js, 60 KB on Bun), which a desk of documents
  can afford; they declare with `var` and `function`, so the documents
  could still be hibernated.
- **XML in sends:** the archive I/O processor gets `<content
  expr="metadataXML()"/>`, the record as XML text, which the application
  parses (`xml.mjs`) and stores as a file. Inline XML `<content>` is
  static, so it cannot hold a document's values; and inline XML sent to
  the application differs between the datamodels (below, "Surprises").
- **I/O processors:** `urn:approval:notify` tells people what happened
  (a review started, changes requested, an SLA breached, a verdict
  refused, the outcome); `urn:approval:archive` is `async`, so its send
  stays readable while it writes the file, and it calls `send.fail()` when
  the archive is down, which the chart turns into a retry.
- **Named actors:** a document is spawned with its id as its name, so the
  desk finds it with `host.actorByName`, and a document that ended is not
  found.
- **The typed methods, as promises** (no handler given), in `admin.mjs`:
  `actorList` pages through the sessions, and for each one
  `actorGet` (its chart, its mailbox, and its pending delayed sends,
  from which `slaDue` reads when each stage's SLA is due), `actorState`
  (its active states, and where each history state would return) and
  `actorContext` (its variables). `documents(host)`
  returns them all, `formatTable` prints them, and `serveAdmin(host)`
  serves `GET /documents`, `GET /documents/<id>` and `GET /stats`
  (`hostStats`) on a port of its own (0: a free one). The bots of
  `main.mjs` read their work queue from the same view.
- **A `SimulatedClock`** in the test, so 48-hour SLAs take no time.
- **Both datamodels:** the test runs every case on the native datamodel
  and on quickjs; `main.mjs --datamodel quickjs` runs the day on quickjs.

## What an admin can see, and what not

The admin view shows, for each live document: its session, its chart, how
many events wait in its mailbox, its active states (as a state value and
as the list of atomic states, so a document in review shows one state per
region), where each of its history states would return (`history`: in
`revising`, `legalWasAt` and `financeWasAt` say where a resubmission
takes each reviewer; in `escalated`, `resumePoint` where a resume goes),
when each running stage's SLA is due (`slaDue`, a time of `host.now()`'s
clock, read from `actorGet`'s pending delayed sends: the table's "SLA
due" column says how long is left), and every `<data>` variable with its
value: the reviewers, the approvals so far, the change requests, the
escalations, the version. The chart still keeps `pausedStage` in a
variable, which names the stage that was breached in one word.

It cannot see:

- **What is in the mailbox**, beyond the count, and the event the actor
  handled last (`_event`).
- **Anything but `<data>`:** the functions and `var`s the chart's scripts
  declare are not variables to `actorContext`.
- **A new document's data before its first turn:** an actor asked about
  before it first runs reads `undefined` for every variable, its spawn
  params included, since they are bound when it starts.
- **Ended documents:** an actor that reached a final state is gone; the
  outcome is in the notifications and the archive, which are the
  application's. A document that ends between `actorList` and the calls
  about it is refused as stale, and the view leaves it out.
- **One moment across pages:** each page and its documents are read
  together, but a later page is read after the host ran again.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/document-approval/main.mjs              # or: bun examples/document-approval/main.mjs
node examples/document-approval/main.mjs --documents 30 --seed 7 --datamodel quickjs --sla-ms 200 --out /tmp/desk
```

It prints the admin endpoint's address, the admin view read over HTTP
when half the documents have ended, one line per document with how it
ended, and a summary with the archive's check. The archive's records go
to `archive/` in `--out`, or in a new temporary directory.

## Test it

```sh
mise run examples document-approval     # under node and bun
node examples/document-approval/test.mjs
bun test ./examples/document-approval/test.mjs
```

The cases run on a `SimulatedClock` on both datamodels, and the last runs
`main.mjs`'s day on the real clock with a few documents. All of it takes
about a second and a half.

## Surprises

Every example's surprises, and what became of each, are in
[docs/surprises.md](../../docs/surprises.md), generated from the log.

Recorded in [`docs/log.xml`](../../docs/log.xml):

- `l-p4-examples-approval-done-early`: a resubmission that returns legal
  to its final state through history raised `done.state.review` while
  finance was still being entered. Fixed in core: the guard is gone.
- `l-p4-examples-approval-xml-content`: inline XML `<content>` sent to an
  I/O processor was an `XMLNode` on the native datamodel and could not be
  read on quickjs (`TA_ERROR_INVALID`). Fixed in the binding and in core:
  both datamodels give its XML text. The chart still writes its record,
  which holds the document's variables, as text.
- `l-p4-examples-approval-context-null`: `actorContext` read `null` for
  an `undefined` variable, and for every variable before the first turn.
  Fixed in core: an `undefined` variable reads `undefined`, apart from
  `null`; before the first turn every variable is `undefined`, since an
  actor's data and its spawn params are bound when it first runs.
- `l-p4-examples-approval-hidden-timers`: no method shows an actor's
  pending delayed sends or its history states.
