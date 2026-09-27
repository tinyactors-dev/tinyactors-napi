# ADR 0024: A child chart is a nested definition

**Status:** Accepted and implemented (2026-09-26); see the implementation notes. Applies core ADR 0077. Supersedes ADR 0023 and ADR 0021 point 3. Point 5's resolver sweep is replaced by core ADR 0079: a kept `resolve` is released when core tells napi its definition was freed.
**Date:** 2026-09-26

## Context

ADR 0021 compiled an SCXML child chart when its `<invoke>` ran, and ADR
0023 bounded the cache of "documents" that made repeats cheap. The user
rejected the concept: an inline `<scxml>` is a nested chart definition,
and "document" is a word for the file format, not a runtime thing. Core
ADR 0077 gives definitions what the cache was imitating: registration
answers a live definition with the same identity, and a definition
nothing holds is freed once nothing uses it.

## Decision

1. **Inline children are compiled when their parent is defined.**
   `define(xml, { format: 'scxml' })` walks the new definition's
   `<invoke>`s (`ta_definition_invoke`), and then its children's, as a
   worklist. Each `<invoke>` of the SCXML type with a literal `<content>`,
   or with a literal `src` when `define()` was given `resolve`, is
   compiled, nested in the parent (`ta_definition_nest`), and released by
   napi, so the parent is its only holder. A child that cannot be compiled
   refuses the parent's `define()`: the error names the `<invoke>` by
   index and the line and column in the child's text. The parent is then
   retired, which frees what was nested.
2. **An invoke of a nested child compiles nothing:** core hands the
   invoker the child as `ta_invoke_request.definition`.
3. **Chart text at invoke time** (`<content expr>`, a `srcexpr` fetched
   with the parent's `resolve`, or a literal `<content>` whose `<invoke>`
   has a computed type) is compiled then. If its identity is live, core
   answers that definition. The invoker holds the result only until the
   child is spawned, so the definition lives as long as its children.
4. **An unnamed child's family is `<parent family>/invoke`,** given to the
   import as a family-only identity (core ADR 0077 section 4). A named
   child keeps its name.
5. **Removed:** the cache (`src/documents.{c,h}`), `createSystem`'s
   `childDocuments`, the `tinyactors.invoke.document*` metrics and the
   eviction log. The resolvers kept per definition stay, for children
   compiled at invoke time; the sweep that releases those of freed
   definitions stays too, since core has no "freed" callback.

Charts defined from a builder are not walked. Their children are
definitions already (a definition ID as content or src), and a literal
`src` string in a builder chart is fetched at invoke time as before.

## Consequences

- One mechanism for child charts: definitions, their identity and their
  holds. Inspection and traces show a child as an ordinary definition.
- A broken inline child is reported when the parent is defined, not as an
  `error.execution` at run time.
- A `<content expr>` that builds different text on every invoke compiles
  every time, as before, but nothing accumulates: each definition goes
  with its child.

## Implementation notes

- **Where:** `src/napi_children.{c,h}` (`tna_children_nest`, and the
  invoke-time compile), `src/napi_system.c` (`importDefinition` nests and,
  on a refusal, retires), `src/adapters/invoker.c` (releases a hold taken
  for one invoke after the spawn, through `tna_child_params.release`),
  `src/import.{c,h}` (an optional identity).
- **Walk order:** a chart's own `<invoke>`s first, then its children's.
  Two `<invoke>`s of the same `src` fetch twice; the second compile is
  answered by the first definition.
- **A finished child stays resident while its parent is in the invoking
  state,** so its definition does too; it goes when the parent leaves the
  state and the invocation ends.
- **Repeated `define()` of the same text** (a parent with an inline child,
  2,000 defines after 200 warm-up, Node 22, load 2.6 to 3.4):

  | | Time per define | Core memory per define |
  |---|---|---|
  | Before (duplicate definitions) | 22.4 µs | 5,151 bytes, never freed |
  | After (answered by identity) | 21.8 µs | 0 |

  Decoding and compiling still run before identity answers: the
  fingerprint comes out of the compile (core ADR 0077 section 1).
- **Tests:** `test/invoke.js` covers an inline child compiled once at
  define time and not again on invoke, a second define answering the same
  definition, a broken inline child refused at define time with its
  `<invoke>` and position, `src` children fetched at define time (a
  grandchild too), `<content expr>` text answered by the live definition
  and freed with its last child (checked with `findDefinition`), and 50
  distinct `<content expr>` charts leaving none behind. The W3C IRP suite
  passes 176 of 176 on Node and Bun.
