'use strict';

// ActorID/Actor view (ADR 0002). An actor is named by its slot and
// generation, two small integers. A view holds its system and those two
// numbers and nothing else: it has no native resource and no finalizer, and
// every question about the actor is asked of core through the system. A view
// of a destroyed actor is harmless: its calls fail with `not-found`.
//
// The pump makes views natively for the actors it passes to hooks, so the
// class is registered with the addon once (setupActor).

const native = require('./native');

class ActorID {
  constructor(system, slot, generation) {
    this.system = system;
    this.slot = slot;
    this.generation = generation;
  }

  /** Equality is by value (ADR 0002 point 5). */
  equals(other) {
    return (
      other instanceof ActorID &&
      other.system === this.system &&
      other.slot === this.slot &&
      other.generation === this.generation
    );
  }

  /** Queue an event for this actor (System.post). */
  post(event, data, options) {
    this.system.post(this, event, data, options);
  }

  /** Queue an event for this actor and await its macrostep (System.send). */
  send(event, data, options) {
    return this.system.send(this, event, data, options);
  }

  /** A snapshot of core's view of this actor. */
  inspect() {
    return this.system.inspect(this);
  }

  /** True when no resident actor has this ID any more. */
  get destroyed() {
    return !this.system.exists(this);
  }

  /** The actor's live data-model root, shared, not copied; undefined under the null data model. */
  data() {
    return this.system.inspect(this).data;
  }

  /** Capture this actor in memory (System.capture). */
  capture() {
    return this.system.capture(this);
  }

  /** Offload this stable named actor from memory (System.unload, core ADR 0074). */
  unload() {
    this.system.unload(this);
  }

  /** Prepare a fresh unpublished actor of `definition` to replace this one (System.prepareReplacement). */
  prepareReplacement(definition, options) {
    return this.system.prepareReplacement(this, definition, options);
  }

  /** Terminate this actor. Invoked children are not destroyed implicitly. */
  destroy() {
    this.system.destroy(this);
  }

  [Symbol.dispose]() {
    if (!this.system.closed && !this.destroyed) {
      this.destroy();
    }
  }
}

native.setupActor(ActorID);

module.exports = { ActorID };
