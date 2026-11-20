// The host's store: one file per hibernated actor in a directory, through
// node:fs/promises. The host calls save when it hibernates an actor past
// its resident bound, load when an event comes for a hibernated one, and
// delete once the actor is back in memory or has ended; each returns a
// promise, which the host follows (and host.idle() waits for).
//
// The host waits for an actor's pending save before it loads it, but a
// delete (after a wake) and the next save of the same actor may overlap,
// so this store runs one session's operations one after another: a delete
// never removes the file of a later save. A save writes a temporary file
// and renames it into place, so a crash leaves the old file or the new
// one, never half of one.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StaleError } from '@tinyactors/node';

export class FileStore {
  /** @param {string} dir the directory of the blobs, made if missing */
  constructor(dir) {
    this.dir = dir;
    this.ready = mkdir(dir, { recursive: true });
    /** session (as a string) -> the promise of its last operation */
    this.chains = new Map();
    /** what was done, for the demo's counts */
    this.counts = { saved: 0, loaded: 0, deleted: 0 };
  }

  path(session) {
    return join(this.dir, `${session}.blob`);
  }

  /** Runs `operation` after the session's earlier ones, failed or not. */
  chained(session, operation) {
    const key = String(session);
    const previous = this.chains.get(key) ?? this.ready;
    const result = previous.then(operation, operation);
    const tail = result.then(() => {}, () => {});
    this.chains.set(key, tail);
    tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return result;
  }

  save(session, blob) {
    return this.chained(session, async () => {
      const temporary = `${this.path(session)}.tmp`;
      await writeFile(temporary, blob);
      await rename(temporary, this.path(session));
      this.counts.saved++;
    });
  }

  load(session) {
    return this.chained(session, async () => {
      try {
        const blob = await readFile(this.path(session));
        this.counts.loaded++;
        return blob;
      } catch (error) {
        if (error.code === 'ENOENT') throw new StaleError(`no blob of actor ${session}`);
        throw error;
      }
    });
  }

  delete(session) {
    return this.chained(session, async () => {
      await rm(this.path(session), { force: true });
      this.counts.deleted++;
    });
  }
}
