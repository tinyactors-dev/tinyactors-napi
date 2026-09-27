# ADR 0021: An invoked SCXML document is imported in the invoke

**Status:** Accepted and implemented (2026-09-25); see the implementation notes. Refines ADR 0019 (SCXML import) and the in-system SCXML invoker of ROADMAP step 13 (`src/adapters/invoker.h`). Point 3 (the cache of imported children) is refined by ADR 0023: a bounded LRU keyed by a hash, whose evictions retire definitions, and resolvers released when their definition is freed. Point 3 is superseded by ADR 0024 and core ADR 0077: a child chart is a nested definition, compiled when its parent is defined or, for text at invoke time, reused by identity and freed with its children. Point 6 is refined by ADR 0025: a quarantined child's parent gets `error.communication.invoke.<id>.quarantined`, and the invocation stays active.
**Date:** 2026-09-25

## Context

napi already has an in-system SCXML invoker (`src/adapters/invoker.c`).
It spawns the child in the same system with core's parent link
(`ta_actor_spawn` with `parent = {actor, invoke_id}`), so core routes
`#_<invokeid>`, `#_parent`, autoforwarding, `<finalize>` and
`done.invoke.<id>` itself. The child is an ordinary actor in napi's
scheduler: the same budgets, the same fairness, the same microstep limit
(core ADR 0075), the same fault path. Cancelling the invoke destroys the
child.

But the child must be a **registered definition**, named by the invoke's
`<content expr>` or `src` as a definition ID. That covers builder charts
(`invoke.content(definition)`). It does not cover SCXML documents, where
the child is:

- a literal `<content>` holding an `<scxml>` document. Core does not
  import literal content; the invoker receives it as bytes
  (`ta_invoke_request.content`, core ADR 0053);
- a `src` or `srcexpr` naming a document, for example
  `src="file:test239sub1.scxml"`.

27 of the 29 known failures in the W3C IRP suite against the addon
(`test/irp/expected-failures.json`) are this gap.

Two constraints shape the design:

- **The invoker runs inside a core call** (`ta_actor_resume` of the
  parent). JavaScript called from there may not call core back (ADR 0013,
  the `reentrant` guard), so the child cannot be defined with `define()`.
  Core itself allows a definition to be imported during a resume: the test
  host's invoker does it.
- **Importing calls JavaScript only at the leaves:** a registered data
  model's `compile` (ADR 0019) and a `resolve(src)` function. Neither calls
  core.

## Decision

1. **The invoker imports the child's document itself, in C, inside the
   invoke.** It calls napi's portable import (`src/import.c`,
   `tna_import_scxml`) with the system's data-model choices, so the child's
   `datamodel` attribute picks among `null`, `javascript` and the data
   models `registerDatamodel()` registered, as a top-level document does.
   A refusal fails the invoke: core raises
   `error.execution` in the parent (SCXML 6.4), and the fault carries the
   import's message and position.

2. **Where the document comes from**, in this order:
   - `<content expr>` or `src` whose value is a definition ID: that
     definition, as today (builder charts);
   - a literal `<content>`: its bytes;
   - `src` or `srcexpr` whose value is a string: the bytes the **parent's
     definition's** `resolve(src)` returns. `define(xml, { format: 'scxml',
     resolve })` keeps `resolve` with the definition it defines, and a
     child imported through it inherits it, so a grandchild's `src` and a
     child's own `<data src>` resolve the same way. A definition without a
     resolver refuses a string `src`.

3. **Definitions are cached per system by document bytes.** The same
   `<content>` or the same resolved `src` compiles once, however often it
   is invoked. The cache lives as long as the system; it holds the bytes
   it was keyed by, so a match is exact. A child definition is an ordinary
   registered definition, visible to inspection and to `findDefinition`.

4. **`<param>` and `namelist` become the child's binding**, as today: the
   data model's aggregate of the values, passed to `ta_actor_spawn` as the
   data-model binding, so a bound name skips its `<data>` initializer.

5. **Addressing stays core's.** The child reaches its parent as
   `#_parent`, the parent reaches the child as `#_<invokeid>`, and the
   child's `_ioprocessors` location is its own `#_scxml_<sessionid>`
   (core ADR 0068). Children are **not** named in napi's directory: they
   are reachable only through their parent, or by their session ID.

6. **Lifecycle:**
   - cancellation when the invoking state exits destroys the child (core
     cancels the invoke; napi's `cancel` destroys it and dead-letters its
     mailbox with reason `destroyed`);
   - `done.invoke.<id>`, `<donedata>`, `<finalize>` and autoforwarding are
     core's (core ADRs 0015 and 0016);
   - destroying the parent cancels its invokes, so its children are
     destroyed with it;
   - a child that faults or is quarantined (including by the runaway
     limit) is an ordinary faulted actor: the parent is not told, as SCXML
     has no event for it. Destroying it, or releasing it, is the host's
     call;
   - an unloaded or offloaded parent loses its invocations (core ADR
     0038): its children are cancelled and the parent gets
     `error.communication.invoke.<id>.unavailable` when it is loaded.
     Invoked children themselves are not unloaded or offloaded (core ADR
     0074).

7. **Observability:** the child's bootstrap runs under the invoking step's
   trace parent (already the case), so its macrosteps stay in the parent's
   trace. Invocations started and ended are already counted (core ADR
   0072).

## Alternatives

- **Import in JavaScript, after the turn.** The invoker would answer at
  once and queue an effect; `lib/` would `define()` the child and spawn it
  with a parent link. It avoids importing inside a core call, but the
  child would start a turn late, `<cancel>` and autoforward would have to
  handle an invoke whose child does not exist yet, and `lib/` would need a
  new core entry point to spawn with a parent link.
- **A system-wide resolver** (`createSystem({ resolve })`) instead of one
  per definition. Simpler, but two documents defined with different
  resolvers could not both invoke by `src`.
- **Name children in the directory.** It would make them addressable from
  outside, which SCXML does not ask for and which would make their names a
  second identity to keep in step with their parent.

## Consequences

- SCXML documents that invoke SCXML children run in the addon, and the
  IRP suite's invoke tests can pass.
- `resolve` outlives `define()`: napi keeps a reference to it per
  definition, released at close.
- An import runs inside a parent's resume. A large child document makes
  that resume slower once; the cache makes later invokes cheap.

## Testing

- **JavaScript, Node and Bun:** parent and child exchange events both
  ways; cancellation when the invoking state exits; `done.invoke` with
  `<donedata>`; `<finalize>`; autoforward; a nested child (grandchild);
  destroying the parent; a child that faults; `src` through `resolve`,
  inherited by the child; the cache (one definition for many invokes); a
  refused child document raises `error.execution` in the parent.
- **IRP:** every invoke test that passes leaves
  `test/irp/expected-failures.json`.

## Implementation notes

- **Where it lives.** `src/napi_children.{c,h}` (Node-API, listed in
  `NODE_API_SOURCES`) answers the invoker's question through
  `system->child_definition`, which replaces the old `resolve_child`. It
  keeps `define()`'s `resolve` per definition (a `napi_ref`, released at
  close) and the cache of imported children (the document bytes, compared
  exactly). The portable invoker (`src/adapters/invoker.c`) is unchanged
  apart from asking through the new hook and passing the binding it gets.
  The shared `resolve(src)` adapter moved from `napi_system.c` to
  `napi_children.c`.
- **Where a document comes from, in order:** a definition ID in
  `<content expr>` or `src`; a string from `<content expr>` (the document
  text); a literal `<content>` (bytes); a `src` string through the parent's
  resolver. The parent's definition is read with `ta_actor_inspect`.
- **The binding is filtered (SCXML 6.4).** `<param>` and `namelist` values
  reach the child only for names it declares as top-level `<data>`, read
  from `ta_definition_export`, as the test host does. Builder charts that
  invoke a registered definition get the same rule.
- **What JavaScript throws** inside the invoke (`resolve` or a registered
  data model's `compile`) is cleared and becomes the invoke's fault
  message; a child definition imported just before the throw is retired.
- **Tests:** `test/invoke.js` (Node and Bun) covers the exchange both
  ways, cancellation on exit, `<donedata>`, `<finalize>`, autoforward, a
  grandchild, destroying the root, a runaway child, `src` inherited by the
  child, the cache (no compile on a second parent), the binding filter,
  and refused documents. `test/irp/run.js` resolves an invoke's
  `src="file:<name>.scxml"` to the test's sibling document.
- **IRP:** 147 passed before, 174 after, of 176 run (24 skipped), on Node
  and Bun. The 2 left are tests 496 and 521, which need the routing
  decision this ADR leaves out.

