# ADR 0004: Event names are interned once

**Status:** Accepted
**Date:** 2026-09-23

## Context

Core identifies events by `ta_event_name_id`, which is interned from a list
of atoms (tinyactors-core ADR 0007). The first addon repeated all of this on
every `post()`:
- converted the JavaScript string to a `malloc`ed UTF-8 copy;
- allocated an atom array;
- interned each dotted segment;
- interned the name.

That cost was paid per message, and did not depend on how many distinct
names the application uses.

## Decision

1. **JavaScript keeps a per-system `Map<string, number>` from event-name
   text to `ta_event_name_id`.** A cache miss makes a single native call
   that interns the name and returns the ID. Names are never un-interned,
   because core interning is monotonic, so the cache never needs
   invalidation.
2. **Native post paths take the numeric ID, not the string.** The string
   form exists only in the JavaScript API.
3. **Names that come back from core** (in inspections and in events passed
   to callbacks) are formatted once per ID with `ta_event_name_format()`
   and cached in the reverse direction.
4. Name validation (empty segments, too many segments) happens once, at
   interning.

## Consequences

- Posting an event whose name was seen before does no string work at all.
- The cache grows with the number of distinct event names, which is bounded
  by the application, not by traffic. An application that builds unbounded
  dynamic names grows core's intern table in the same way. That is a core
  property, not an addon one.
