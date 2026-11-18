// The world outside the host: a payment gateway whose answers take time
// on the application's clock, and a blob store for hibernated
// subscriptions. Both are the application's, not the library's.

/** A payment gateway. Each customer's card answers `'ok'` or `'declined'`
 * (`cards`, default ok), after `latencyMs(customer)` on the clock it is
 * given; `tick()` answers what is due. A test may also hold every charge
 * (`hold = true`) and answer them itself (`held`). */
export class PaymentGateway {
  /**
   * @param {object} options
   * @param {{ readonly now: number }} options.clock
   * @param {(customer: string) => number} [options.latencyMs]
   */
  constructor({ clock, latencyMs = () => 0 }) {
    this.clock = clock;
    this.latencyMs = latencyMs;
    /** customer -> 'ok' | 'declined' */
    this.cards = new Map();
    /** every charge taken: { customer, invoice, attempt, amount, at } */
    this.ledger = [];
    /** every charge asked for, answered or not */
    this.calls = [];
    /** charges waiting for their time: { due, resolve, call } */
    this.inflight = [];
    this.hold = false;
    /** charges held by a test: { call, answer(result) } */
    this.held = [];
    this.nextCharge = 1;
  }

  /** One charge; resolves with `{ status: 'ok', chargeID, amount }` or
   * `{ status: 'declined', reason }`. */
  charge(call) {
    this.calls.push(call);
    return new Promise((resolve) => {
      const answer = () => resolve(this.answer(call));
      if (this.hold) this.held.push({ call, answer });
      else {
        const due = this.clock.now + this.latencyMs(call.customer);
        if (due <= this.clock.now) queueMicrotask(answer);
        else this.inflight.push({ due, answer });
      }
    });
  }

  answer(call) {
    if ((this.cards.get(call.customer) ?? 'ok') === 'declined') return { status: 'declined', reason: 'card declined' };
    this.ledger.push({ ...call, at: this.clock.now });
    return { status: 'ok', chargeID: `ch_${this.nextCharge++}`, amount: call.amount };
  }

  /** Answers the charges that are due by now. */
  tick() {
    const due = this.inflight.filter((charge) => charge.due <= this.clock.now);
    this.inflight = this.inflight.filter((charge) => charge.due > this.clock.now);
    for (const charge of due) charge.answer();
    return due.length;
  }

  /** The earliest time a charge in flight answers, or undefined. */
  nextDue() {
    const due = this.inflight.reduce((min, charge) => Math.min(min, charge.due), Infinity);
    return due === Infinity ? undefined : due;
  }

  /** What `customer` was charged in all. */
  total(customer) {
    return this.ledger.filter((charge) => charge.customer === customer).reduce((sum, charge) => sum + charge.amount, 0);
  }
}

/** Where hibernated subscriptions wait: one blob per session. In memory
 * here; a real deployment writes them to a database or files, as
 * examples/chat-rooms does. */
export class BlobStore {
  constructor() {
    this.blobs = new Map();
    this.writes = 0;
    this.reads = 0;
  }

  put(session, blob) {
    this.blobs.set(session, blob);
    this.writes++;
  }

  take(session) {
    const blob = this.blobs.get(session);
    if (blob === undefined) throw new Error(`no blob for session ${session}`);
    this.blobs.delete(session);
    this.reads++;
    return blob;
  }

  has(session) {
    return this.blobs.has(session);
  }

  get size() {
    return this.blobs.size;
  }
}
