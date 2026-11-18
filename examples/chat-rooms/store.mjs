// The blob store: one file per hibernated session in a directory, written
// with node:fs/promises.
//
// A write takes time, and an event can come for a session while its blob is
// still on the way to the disk. So a blob is kept in memory, in `pending`,
// from `put` until its file is written, and `take` answers from there first:
// a wake never reads a file that is not written yet. Writes of one session
// are chained, so an older blob never lands over a newer one, and each goes
// to a temporary file renamed into place, so a crash leaves the old file or
// the new one, never half of one.
//
// A write that fails tells the caller whether the blob was taken meanwhile:
// if not, the caller still holds the only copy and must put the actor back
// (chat.mjs wakes it from that blob); if so, the actor is awake already.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class FileStore {
  /**
   * @param {string} dir the directory of the blobs, made if missing
   * @param {object} [hooks] for tests, each called with the session's key
   *   (its decimal text): `beforeWrite(key)` may throw or reject, which
   *   fails that write; `beforeRead(key)` may delay a read
   */
  constructor(dir, { beforeWrite, beforeRead } = {}) {
    this.dir = dir;
    this.beforeWrite = beforeWrite;
    this.beforeRead = beforeRead;
    /** key -> { blob }: blobs whose file is not written yet */
    this.pending = new Map();
    /** key -> the promise of its last write */
    this.chains = new Map();
    this.ready = mkdir(dir, { recursive: true });
    /** the keys written and read, in order (for tests and the demo's counts) */
    this.written = [];
    this.read = [];
  }

  path(key) {
    return join(this.dir, `${key}.blob`);
  }

  /** Stores `blob` for `session`. Resolves `{ written: true }`, or
   * `{ written: false, taken, error }` when the write failed: `taken` says
   * whether a `take` got the blob from memory meanwhile. Never rejects. */
  put(session, blob) {
    const key = String(session);
    const entry = { blob, taken: false };
    this.pending.set(key, entry);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const write = previous.then(async () => {
      await this.ready;
      await this.beforeWrite?.(key);
      const temporary = `${this.path(key)}.${process.pid}.tmp`;
      await writeFile(temporary, blob);
      await rename(temporary, this.path(key));
      this.written.push(key);
    });
    const done = write.then(
      () => ({ written: true }),
      (error) => ({ written: false, taken: entry.taken, error }),
    );
    // the next write of this session waits for this one, failed or not
    this.chains.set(key, done);
    return done.then((result) => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
      if (this.chains.get(key) === done) this.chains.delete(key);
      return result;
    });
  }

  /** The blob of `session`: from memory while its write is on the way (at
   * once), else from its file (a promise). */
  take(session) {
    const key = String(session);
    const entry = this.pending.get(key);
    if (entry) {
      entry.taken = true;
      this.pending.delete(key);
      return entry.blob;
    }
    return (async () => {
      await this.beforeRead?.(key);
      const blob = await readFile(this.path(key));
      this.read.push(key);
      return blob;
    })();
  }

  /** Resolves when every write started so far has ended. */
  async flush() {
    while (this.chains.size) await Promise.all(this.chains.values());
  }
}
