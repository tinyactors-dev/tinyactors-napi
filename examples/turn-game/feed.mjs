// The spectator feed: what the matches publish through the
// urn:game:spectators I/O processor, as spectators (and the clients, who
// learn whose turn it is from it) see it. It lives outside the game
// server, so it outlives a crash: what it published stays published.
//
// Each frame has a key, its match and its number (`match-3#7`), and each
// result one (`match-3#result`). A message whose key was published with
// the same content is a duplicate (a restore published it again) and is
// dropped. One with the same key and other content is a rewind: the
// server lost what it had published, and history went another way. A
// frame marked `resync` is always passed on: a match publishes its
// current frame again after a recovery, so a client whose move was lost
// in the crash sees that it is still its turn.

export class SpectatorFeed {
  constructor() {
    /** key -> the JSON of what was published under it */
    this.published = new Map();
    /** every message passed on, in order */
    this.messages = [];
    this.duplicates = 0;
    /** { key, before, after } for each key published again with other content */
    this.rewinds = [];
    this.listeners = new Set();
  }

  /** Calls `listener(message)` for each message passed on; returns the
   * function that unsubscribes it. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message) {
    const key = message.event === 'frame' ? `${message.match}#${message.frame}`
      : message.event === 'result' ? `${message.match}#result` : undefined;
    if (key !== undefined) {
      const { resync, ...content } = message;
      const text = JSON.stringify(content);
      const before = this.published.get(key);
      if (before === text && !resync) {
        this.duplicates++;
        return;
      }
      if (before !== undefined && before !== text) this.rewinds.push({ key, before: JSON.parse(before), after: content });
      this.published.set(key, text);
    }
    this.messages.push(message);
    for (const listener of this.listeners) listener(message);
  }

  /** The last result published for each match. */
  results() {
    const results = new Map();
    for (const message of this.messages) if (message.event === 'result') results.set(message.match, message);
    return results;
  }
}
