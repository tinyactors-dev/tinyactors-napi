// The world outside the host: a payment gateway and a warehouse. They stand
// in for a payment provider's API and a warehouse system, so the example
// runs without a network. Each asks a `respond` function how a call ends
// (an answer, an error, a delay, never), which is how main.mjs gives them
// latency and failures and how the test drives them one call at a time.

/** A payment provider: charges under an idempotency key, and reverses. */
export class PaymentGateway {
  /**
   * @param {{ respond?: (call: object) => any, refundRespond?: (call: object) => any }} [options]
   *   `respond(call)` says how a charge ends, now or as a promise:
   *   `'captured'`, `'declined'`, `'error'`, or `{ result, lost: true }`
   *   for a charge the gateway made whose answer never reaches the caller.
   *   `refundRespond(call)` may throw or reject: the refund did not happen.
   */
  constructor({ respond = () => 'captured', refundRespond = () => undefined } = {}) {
    this.respond = respond;
    this.refundRespond = refundRespond;
    /** key -> { amount, status: 'captured' | 'reversed', chargeID } */
    this.charges = new Map();
    /** every charge call that reached the gateway, in order */
    this.calls = [];
    this.refunds = [];
    this.next = 1;
  }

  /** Charges `amount` under `key`. A key already captured answers the same
   * charge again: a retry never charges twice. */
  async charge({ key, amount, attempt }) {
    const known = this.charges.get(key);
    if (known?.status === 'captured') return { status: 'captured', chargeID: known.chargeID };
    if (known?.status === 'reversed') return { status: 'declined', reason: 'the charge was reversed' };
    const call = { key, amount, attempt };
    this.calls.push(call);
    let answer = await this.respond(call);
    const lost = typeof answer === 'object' && answer.lost;
    if (typeof answer === 'object') answer = answer.result;
    let result;
    const now = this.charges.get(key);
    if (answer === 'captured') {
      // a reversal that came first wins: the gateway voids the authorization
      if (now?.status === 'reversed') result = { status: 'declined', reason: 'the charge was reversed' };
      // another attempt under the same key captured meanwhile: the same charge
      else if (now?.status === 'captured') result = { status: 'captured', chargeID: now.chargeID };
      else {
        const chargeID = `ch_${this.next++}`;
        this.charges.set(key, { amount, status: 'captured', chargeID });
        result = { status: 'captured', chargeID };
      }
    } else if (answer === 'declined') result = { status: 'declined', reason: 'insufficient funds' };
    else result = { status: 'error', reason: 'gateway unavailable' };
    if (lost) return new Promise(() => {}); // the response is lost on the way back
    return result;
  }

  /** Reverses whatever `key` captured (a refund) and voids what is still in
   * flight; answers the amount given back. */
  async refund(key) {
    const call = { key };
    this.refunds.push(call);
    await this.refundRespond(call);
    const known = this.charges.get(key);
    const amount = known?.status === 'captured' ? known.amount : 0;
    this.charges.set(key, { ...known, amount: 0, status: 'reversed' });
    return amount;
  }

  /** What the customer of `key` has paid, net. */
  net(key) {
    const known = this.charges.get(key);
    return known?.status === 'captured' ? known.amount : 0;
  }
}

export class OutOfStock extends Error {
  constructor(sku) {
    super(`out of stock: ${sku}`);
    this.sku = sku;
  }
}

/** A warehouse: reserves stock, picks, hands parcels to a carrier, and
 * reports delivery. */
export class Warehouse {
  /**
   * @param {{ stock: Record<string, number>, respond?: (step: { step: string, order: string }) => any }} options
   *   `respond({ step, order })` says when the step `'pick'` or `'deliver'`
   *   of `order` completes: now, or when its promise resolves.
   */
  constructor({ stock, respond = () => undefined }) {
    this.stock = { ...stock };
    this.respond = respond;
    /** order -> { items, state: 'reserved' | 'released' | 'handedOver' | 'delivered', trackingID } */
    this.shipments = new Map();
    this.next = 1;
  }

  /** Reserves the items of `order`, or throws `OutOfStock` naming the first
   * one short. */
  reserve(order, items) {
    for (const { sku, qty } of items) if ((this.stock[sku] ?? 0) < qty) throw new OutOfStock(sku);
    for (const { sku, qty } of items) this.stock[sku] -= qty;
    this.shipments.set(order, { items, state: 'reserved' });
  }

  /** Puts the reserved items of `order` back on the shelf, unless the parcel
   * already left; answers whether it did. */
  release(order) {
    const shipment = this.shipments.get(order);
    if (shipment?.state !== 'reserved') return false;
    for (const { sku, qty } of shipment.items) this.stock[sku] += qty;
    shipment.state = 'released';
    return true;
  }

  /** Waits for the pick, then hands the parcel to the carrier, unless it was
   * released meanwhile; answers the tracking id, or undefined. */
  async pickAndHandOver(order) {
    await this.respond({ step: 'pick', order });
    const shipment = this.shipments.get(order);
    if (shipment?.state !== 'reserved') return undefined;
    shipment.state = 'handedOver';
    shipment.trackingID = `TRK-${String(this.next++).padStart(4, '0')}`;
    return shipment.trackingID;
  }

  /** Resolves when the carrier delivered the parcel of `order`. */
  async delivery(order) {
    await this.respond({ step: 'deliver', order });
    this.shipments.get(order).state = 'delivered';
  }
}
