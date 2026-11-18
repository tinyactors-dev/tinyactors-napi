// What the gates share (tools/stress.mjs, tools/migration.mjs,
// tools/snapshot.mjs; as
// tinyactors-cpython/tools/stress.py shares its Store with migration.py):
// the batch size, a seeded generator and the store of hibernated actors'
// blobs, each runtime's own SQLite.

export const BATCH = 256;

/** A gate's Host options for `datamodel`: on quickjs, no memory limit. A
 * gate measures what a population costs, so the engine's heap is what it
 * reads, not what it bounds: its full runs keep far more resident than
 * quickjs's default limit (1 GiB) is sized for. */
export function engine(datamodel) {
  return datamodel === 'quickjs' ? { datamodel, quickjs: { memoryLimit: Number.MAX_SAFE_INTEGER } } : { datamodel };
}

// A seeded generator (mulberry32), so a run is the same run again.
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The hibernated actors' blobs: one SQLite row per session, written in
// transactions of 4096. A store opened on a copy's file finds its rows.
export class Store {
  static async open(file) {
    if (globalThis.Bun) {
      const { Database } = await import('bun:sqlite');
      const db = new Database(file);
      return new Store({ exec: (sql) => db.run(sql), prepare: (sql) => db.prepare(sql) });
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    return new Store({ exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) });
  }

  constructor(db) {
    this.db = db;
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=OFF');
    db.exec('CREATE TABLE IF NOT EXISTS blobs (session INTEGER PRIMARY KEY, blob BLOB NOT NULL)');
    this.insert = db.prepare('INSERT OR REPLACE INTO blobs VALUES (?, ?)');
    this.select = db.prepare('SELECT blob FROM blobs WHERE session = ?');
    this.pending = [];
    this.puts = 0;
    this.gets = 0;
  }

  put(session, blob) {
    this.pending.push([session, blob]);
    this.puts++;
    if (this.pending.length >= 4096) this.flush();
  }

  flush() {
    if (this.pending.length === 0) return;
    this.db.exec('BEGIN');
    for (const [session, blob] of this.pending) this.insert.run(session, blob);
    this.db.exec('COMMIT');
    this.pending.length = 0;
  }

  // A copy of every row in `file` (VACUUM INTO), for another host's store.
  copyTo(file) {
    this.flush();
    this.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  }

  // Every row, [session, blob], one at a time.
  *rows() {
    this.flush();
    for (const row of this.db.prepare('SELECT session, blob FROM blobs').iterate()) yield [row.session, row.blob];
  }

  get(session) {
    this.flush(); // a wake can come before a put settled: read your own writes
    this.gets++;
    return this.select.get(session).blob;
  }
}
