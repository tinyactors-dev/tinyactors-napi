# ADR 0010: Definitions are normalized in JavaScript and built in one arena

**Status:** Superseded by ADR 0013
**Date:** 2026-09-23

## Context

The first addon decoded definition object trees in about 400 lines of C.
For each object it called `napi_get_property_names`, made one UTF-8
`malloc` for every key to reject unknown fields, and freed memory by hand
along each error path. Core already has a description of a chart that does
not depend on how it was written (`ta_scxml_spec`). It also has `ta_tree`
for building one with a single result reported at the end, and a codec
contract for byte formats (tinyactors-core ADR 0053).

## Decision

1. **JavaScript owns authoring and normalization.** The fluent builder
   (`statechart()`) and direct `DefinitionSpec` input are both normalized in
   `index.js` into one plain shape:
   - defaults are filled in;
   - shorthands are expanded (a single target becomes a list);
   - unknown keys and wrong types are rejected with paths such as
     `states[3].transitions[0].target`.
2. **Native decoding is a straight-line translation of that shape into
   `ta_scxml_spec` inside a `ta_tree`.**
   - It still checks each value's type, because it must never crash on bad
     input.
   - It does not list keys, and it does not duplicate the checks JavaScript
     made.
   - All spec memory is released together when the tree is released.
3. **Data models:**
   - A chart that uses no data compiles against core's
     `ta_null_datamodel()` (tinyactors-core ADR 0057).
   - A chart with data uses the JavaScript data model, whose expressions are
     functions (ADR 0011, `docs/design.md`).
4. **Definitions from byte formats** (for example SCXML) go through a
   codec that produces a `ta_scxml_spec` (tinyactors-core ADR 0053). The
   addon does not parse any byte format itself.
5. **Identity is read back from core.** `definition.identity` and
   `inspect()` call `ta_definition_inspect()`. The addon keeps no copy.

## Consequences

- Error messages for malformed specs come from JavaScript, where they can
  name the path.
- The native decoder is short and has one cleanup path.
