// What the game server keeps on disk, in one directory: the last
// checkpoint (a snapshot of the host, and the journal sequence number it
// holds everything up to) and the journal of the clients' inputs since.
//
// A checkpoint is written to a temporary file and renamed over the last
// one, so a crash leaves the old checkpoint or the new one, never half of
// one. The journal is appended to, one JSON line per input, before the
// input reaches the host (a write-ahead log); a line torn by a crash is
// the last one, and is skipped.
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  /**
   * @param {string} dir the directory, which exists
   * @param {{ sync?: boolean }} [options] `sync`: fsync each checkpoint and
   *   journal line, so they survive the machine's crash too, not only the
   *   process's (off by default: a killed process loses nothing the kernel
   *   has, and the test and the demo kill processes)
   */
  constructor(dir, { sync = false } = {}) {
    this.dir = dir;
    this.sync = sync;
    this.checkpointPath = join(dir, 'checkpoint.bin');
    this.journalPath = join(dir, 'journal.jsonl');
  }

  /** Writes `{ seq, datamodel, snapshot }` as the checkpoint: a 4-byte length, the
   * header as JSON, then the snapshot's bytes. */
  writeCheckpoint({ seq, datamodel, snapshot }) {
    const header = Buffer.from(JSON.stringify({ seq, datamodel, bytes: snapshot.length }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const temporary = `${this.checkpointPath}.tmp`;
    const fd = openSync(temporary, 'w');
    try {
      writeSync(fd, length);
      writeSync(fd, header);
      writeSync(fd, snapshot);
      if (this.sync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.checkpointPath);
  }

  /** The last checkpoint, `{ seq, datamodel, snapshot }`, or undefined. */
  readCheckpoint() {
    if (!existsSync(this.checkpointPath)) return undefined;
    const file = readFileSync(this.checkpointPath);
    const length = file.readUInt32BE(0);
    const header = JSON.parse(file.subarray(4, 4 + length).toString());
    const snapshot = file.subarray(4 + length);
    if (snapshot.length !== header.bytes) throw new Error(`${this.checkpointPath}: ${snapshot.length} bytes of snapshot, the header says ${header.bytes}`);
    return { ...header, snapshot };
  }

  /** Appends one input to the journal. */
  append(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    if (!this.sync) return appendFileSync(this.journalPath, line);
    const fd = openSync(this.journalPath, 'a');
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** The journal's inputs after sequence number `seq`, in order. */
  journal(seq) {
    if (!existsSync(this.journalPath)) return [];
    const entries = [];
    for (const line of readFileSync(this.journalPath, 'utf8').split('\n')) {
      if (line === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        break; // torn by a crash: the last line
      }
    }
    return entries.filter((entry) => entry.seq > seq);
  }

  /** Empties the journal: a checkpoint holds everything in it. */
  truncateJournal() {
    writeFileSync(this.journalPath, '');
  }
}
