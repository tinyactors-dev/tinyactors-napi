# ADR 0006: The addon routes actor-to-actor events

**Status:** Accepted; named addresses use tinyactors-core ADR 0065 (proposed) Point 4 refined by ADR 0022: mail a chart sends to a target that does not exist raises `error.communication` in the sender instead of becoming a dead letter.
**Date:** 2026-09-23

## Context

Core hands every event between sessions to the host's external-event router
(tinyactors-core ADR 0040). The first addon never installed a router. Every
`<send>` between actors therefore became a communication error, so every
message in the system had to come from JavaScript.

## Decision

1. **Every system installs a router when it is created.** `submit`
   resolves the destination:
   - a runtime ID is used as it is;
   - a named address is resolved through the addon's actor directory.

   The router then copies the borrowed delivery into a reused envelope and
   appends it to the target's mailbox (ADR 0005). It returns
   `TA_EXTERNAL_EVENT_ACCEPTED`. Data is shared by retain, not cloned
   (tinyactors-core ADR 0050).
   - Named addresses are core's reference-counted `ta_address` handles
     (tinyactors-core ADR 0065). The router resolves the destination at
     once and keeps only the event, with `ta_event_retain()`, which
     retains the origin and the data. It copies no strings and never
     allocates. The envelope holds those references and releases them
     after delivery.
   - This also keeps a named origin valid after its sender is destroyed.
     Today's `ta_external_delivery_clone()` copies only the destination, so
     an envelope that waits while its sender is destroyed would hold
     borrowed origin strings that have been freed. With the default
     `finished: "destroy"` (ADR 0012), that case is common.
   - A named origin stays a name, so a reply still follows the directory
     (tinyactors-core ADR 0022) even when the actor is replaced.
   - The addon has no address table of its own. Core's handles are already
     interned.
2. **The router never delivers directly and never re-enters the
   interpreter.** Mail sent during a macrostep is delivered in a later
   step of the pump.
3. **Retry is only for resource limits.** `TA_EXTERNAL_EVENT_RETRY` is
   returned only when a backpressure limit (ADR 0005) or an allocation
   stops the router from accepting. Core keeps the delivery and offers it
   again.
4. **An unknown or finished destination is not a router error.** The
   delivery is accepted, and it becomes a dead letter:
   - a named address with no directory entry, or a runtime ID whose
     generation does not match the scheduling table, is recorded as a dead
     letter at once (ADR 0005). A named one keeps a reference to its
     address, and the `deadLetter` record names it as `{ family, name }`;
   - a named address whose entry is unloaded is a dead letter with reason
     `unloaded`. `load()` brings the actor back; mail is not held for it,
     and nothing loads it on demand (an open follow-up in ROADMAP.md);
   - a finished target is found when its mailbox is delivered.

   This keeps routing O(1) and gives messages the same order whether their
   target lives or dies in between.
5. **The addon provides an in-memory actor directory**
   (`ta_system_set_actor_directory`) for named actors. Its callbacks receive
   `ta_address` handles (tinyactors-core ADR 0065), and equal addresses are
   the same handle. So it is a hash map keyed by the handle's pointer, with
   no string hashing, and each entry holds a reference to its handle.
   Persistent directories are a later layer.

## Consequences

- Actor-to-actor traffic stays in native code from end to end. JavaScript
  is involved only in data-model callbacks (ADR 0011) and in hooks the
  application registers.
- Mail from JavaScript and mail between actors uses one queue topology,
  with one ordering and backpressure policy.
- Actor-to-actor traffic between named actors copies no strings. Core's
  address table grows with the number of distinct live addresses, and an
  address is freed when its last reference is released.
- Close uninstalls the router and the directory, and gives back every
  address reference the addon holds (envelopes, directory entries), before
  `ta_system_destroy()`, because core frees its address records at the end
  of that call.
- `System.post()` to an address interns it, which is a core call, so it is
  refused (`reentrant`) from inside a core call. Posting to an `ActorId`
  stays allowed there.
