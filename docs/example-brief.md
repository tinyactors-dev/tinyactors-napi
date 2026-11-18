# Brief for an example application (step p4-examples)

You build one real application in `tinyactors-napi/examples/<name>/`.

- **Domain logic** lives in SCXML charts on the Node binding.
- **The application owns its I/O:** HTTP, files, timers it needs, stores.

First read `docs/step-brief.md` and follow it: rules, environment, committing and pushing often, logging through planxml, the report format.

Use the library the way a JavaScript developer meeting it for the first time would:

- **Start from `README.md` and `docs/guide/`.** Use `index.d.ts` as the reference.
- **Read the source only after the docs fail you.** When that happens, it is a surprise.

## What the example is

- A plausible application with real domain rules and their tricky cases (races, timeouts, retries, partial failure, restarts), not a toy.
- It imports `tinyactors` the way a user would. The package resolves in this repo; follow `examples/remote-python` for how an example finds the binding.
- It runs with one command, `node examples/<name>/main.mjs` or as its README says.
- `examples/<name>/README.md` says:
  - what the application does;
  - which tinyactors features it uses, and why each one fits;
  - how to run it and how to test it.
- A test, `examples/<name>/test.mjs`, uses `node:test`. It is run by `mise run examples` (create the task if it does not exist yet; `mise run test` runs it) under node and bun.
  - It is fast: a few seconds.
  - It has no fixed ports, and writes only to a temporary directory.
  - Prefer a `SimulatedClock` for time.
- **Use only Node's standard library.** No npm dependencies other than `tinyactors`.

## Surprises are the point

Record every surprise in `docs/log.xml` as `kind="surprise"`, with `example="<name>"`. A surprise is any of:

- behaviour that differed from what the docs, the types or a reasonable JavaScript programmer expected;
- a missing API;
- a confusing error;
- a bug;
- a docs gap;
- an awkward shape.

Each surprise says what you did, what you expected, what happened, and the evidence (the file and line, or the output).

Do not fix the library yourself. Work around the surprise in the example, mark the workaround in a comment that names the log id, and leave the fix to p4-surprises. The exception is a broken example in the docs: fix that.

## Before you finish

- Run `mise run test` in `tinyactors-napi`, and `mise run check-acronyms` at the root.
- Commit only your own paths (`git commit -- <paths>`). Push.
- Report in 25 lines or fewer:
  - what the app does;
  - which features it exercises;
  - the surprises, by id, each in one line.

## The ten applications

Built one at a time, in this order. The coordinator chose them so that, between them, they cover every feature.

1. **order-fulfillment:** orders with payment and shipping as invoked services. Covers cancellation mid-flight, and payment timeouts and retries with delayed sends. Tested on a `SimulatedClock`.
2. **http-gateway:** a rate-limited HTTP API (`node:http`) whose sessions are actors. An async I/O processor answers requests. The traceparent comes from the request headers. Traces and logs go to a fake OTLP collector.
3. **chat-rooms:** many rooms and users as actors. Under load, a sweep hibernates them to a file store, and a message wakes them. The resident set stays bounded.
4. **subscription-billing:** a live population of subscriptions migrated from chart v1 to v2 (a new plan state, a renamed variable) while events flow. `migrated` and `migrationDone` are observed.
5. **turn-game:** a turn-based game server, snapshotted to disk and restored after a simulated crash. Timers and running services carry across the restore.
6. **iot-rules:** a device fleet with user-written alert rules on the quickjs datamodel. Covers memory and op limits; errors from bad rules are reported and do not crash the host.
7. **document-approval:** a multi-stage approval workflow with parallel reviewers, history states, XML content in sends and script declarations. An admin view is built on the typed methods (`actorList`, `actorState`, `actorContext`).
8. **inventory-sync:** two Node systems, a warehouse and a storefront, over the transport. Covers reservations across systems, a peer going down, `error.communication` and compensation.
9. **job-scheduler:** recurring and one-shot jobs on the real clock, with delayed sends and cancel. Covers idle and liveness, a graceful close with work pending, and errors from jobs surfacing.
10. **elevator-control:** a bank of elevators. Covers parallel states, `In()`, done events, deep history after maintenance mode and invoked child charts. Exhaustive scenarios run on a `SimulatedClock`.
