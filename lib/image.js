'use strict';

// Session images (ROADMAP step 14; core ADRs 0013, 0038, 0051, 0052). A
// SessionImage wraps core's ta_session_image handle, captured in memory. The
// handle's finalizer calls ta_session_image_destroy (ADR 0013 point 5), and
// close() destroys every image still alive, so an image never outlives its
// system (ADR 0012). Values the image holds (queued events, delayed-send
// data) are value boxes (ADR 0011) and are released with it.
//
// Core's image does not hold the data-model root: load() and reconstruct()
// bind one. The image keeps the root the actor had when it was captured, and
// load() and reconstruct() use it unless given another binding. It is the
// same object, not a copy: reconstructing an image of an actor that still
// runs shares that actor's data unless a binding is passed.

const native = require('./native');
const { TinyactorsError } = require('./errors');

const { core } = native;

let handleOfImage;

class SessionImage {
  #handle;
  #destroyed = false;

  static {
    handleOfImage = (image) => image.#handle;
  }

  constructor(system, handle, info) {
    this.origin = system;
    this.#handle = handle;
    /** The actor at capture; its ID goes stale once it is unloaded (core ADR 0066). */
    this.actor = info.actor;
    /** Stable across unload and load (core ADR 0066). */
    this.sessionID = info.sessionID;
    this.definition = info.definition;
    if (info.address !== undefined) {
      this.address = info.address;
    }
    /** The data-model root at capture, or undefined under the null data model. */
    this.data = info.data;
  }

  /** The earliest pending delayed send's due time, or undefined when none is pending. */
  get nextDeadline() {
    if (this.destroyed) {
      return undefined;
    }
    try {
      return core.session_image_next_deadline(this.#handle);
    } catch (error) {
      if (error instanceof TinyactorsError && error.code === 'not-found') {
        return undefined;
      }
      throw error;
    }
  }

  /** True once destroy() ran or the origin system closed. */
  get destroyed() {
    return this.#destroyed || this.origin.closed;
  }

  /** Release the image and the values it holds. Idempotent. */
  destroy() {
    if (!this.destroyed) {
      core.session_image_destroy(this.#handle);
    }
    this.#destroyed = true;
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

// The core handle of a live image of `system` (load, unload, reconstruct).
function handleOf(image, system, caller) {
  if (!(image instanceof SessionImage) || image.origin !== system) {
    throw new TinyactorsError(`${caller}: expected a SessionImage captured in this system`, 'invalid');
  }
  if (image.destroyed) {
    throw new TinyactorsError(`${caller}: the image was destroyed`, 'invalid');
  }
  return handleOfImage(image);
}

module.exports = { SessionImage, handleOf };
