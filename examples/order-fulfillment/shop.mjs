// The application: a shop whose orders are actors of charts/order.scxml.
// The chart decides what an order does; this file does the I/O it asks for:
// the payment and shipping services it invokes, the refunds it sends, and
// the notifications it sends to the customer.
import { readFileSync } from 'node:fs';
import { Host, TinyactorsError } from '@tinyactors/node';
import { OutOfStock } from './world.mjs';

const ORDER_CHART = readFileSync(new URL('./charts/order.scxml', import.meta.url), 'utf8');

/** The notifications that end an order. */
const FINAL = new Set(['order.delivered', 'order.cancelled', 'order.failed']);

export class Shop {
  /**
   * @param {object} options
   * @param {import('./world.mjs').PaymentGateway} options.gateway
   * @param {import('./world.mjs').Warehouse} options.warehouse
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {object} [options.timing] the chart's timings, in milliseconds:
   *   paymentTimeoutMs, backoffMs, refundRetryMs; and maxAttempts
   */
  constructor({ gateway, warehouse, clock, datamodel, timing = {} }) {
    this.gateway = gateway;
    this.warehouse = warehouse;
    this.timing = timing;
    /** every notification the orders sent, in order: the customer's outbox */
    this.outbox = [];
    /** the `<log>` lines of the orders */
    this.logs = [];
    /** order id -> { promise, resolve } of its last notification */
    this.endings = new Map();

    this.host = new Host(
      { systemID: 'shop', ioProcessors: [{ type: 'urn:shop:notify' }, { type: 'urn:shop:refunds' }] },
      {
        clock,
        datamodel,
        services: {
          'urn:shop:payment': (host, invocation) => this.payment(invocation),
          'urn:shop:shipping': (host, invocation) => this.shipping(invocation),
        },
        ioProcessors: {
          'urn:shop:notify': (host, send) => this.notify(send.event, send.data),
          // An async handler: its send stays readable after the await. It
          // catches its own failure and fails the send, so the chart gets
          // error.communication and retries, and no error leaves the turn.
          'urn:shop:refunds': async (host, send) => {
            try {
              send.answer('refunded', { amount: await this.gateway.refund(send.data.order) });
            } catch {
              send.fail();
            }
          },
        },
        log: (host, entry) => this.logs.push(entry.text),
      },
    );
    this.host.addCharts({ 'order.scxml': ORDER_CHART });
  }

  /** Places an order: an actor named by the order's id. Resolves, through
   * `ending(id)`, with its last notification. */
  place({ id, items, address }) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.endings.set(id, { promise, resolve });
    return this.host.spawnChart('order', { name: id, params: { order: id, items, address, ...this.timing } });
  }

  /** The customer asks to cancel. Answers `'requested'` when the order is
   * still running (the chart decides whether it can), or `'unknown'` when
   * there is no such order any more: it ended, or never was. */
  cancel(id) {
    const session = this.host.actorByName(id);
    if (session === undefined) return 'unknown';
    try {
      this.host.send(session, 'cancel');
    } catch (error) {
      // the actor ended between the lookup and the send
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_STALE') return 'unknown';
      throw error;
    }
    return 'requested';
  }

  /** The notification that ended order `id`: delivered, cancelled or failed. */
  ending(id) {
    return this.endings.get(id).promise;
  }

  notify(event, data) {
    const message = { event, ...data };
    this.outbox.push(message);
    if (FINAL.has(event)) this.endings.get(data.order)?.resolve(message);
  }

  /** One payment attempt: a charge at the gateway under the order's id as
   * idempotency key. The invocation ends with done (captured), or sends
   * back declined or error; when the chart leaves the attempt (a timeout, a
   * cancel), stop() makes a late answer go nowhere. */
  payment(invocation) {
    const { order, amount, attempt } = invocation.data;
    let stopped = false;
    const answer = (result) => {
      if (stopped || !invocation.running) return;
      if (result.status === 'captured') invocation.done({ chargeID: result.chargeID });
      else if (result.status === 'declined') invocation.sendBack('payment.declined', { reason: result.reason });
      else invocation.sendBack('payment.error', { reason: result.reason });
    };
    this.gateway.charge({ key: order, amount, attempt })
      .then(answer, (error) => answer({ status: 'error', reason: error.message }));
    return { stop() { stopped = true; } };
  }

  /** The shipment, from the reservation to the delivery. A cancel the chart
   * sends is a request: granted while the parcel is in the warehouse,
   * ignored once it is with the carrier (the chart has heard of the
   * hand-over by then, or is about to). */
  shipping(invocation) {
    const { order, items } = invocation.data;
    const warehouse = this.warehouse;
    let ended = false;
    const tell = (event, data) => {
      if (!ended && invocation.running) invocation.sendBack(event, data);
    };
    try {
      warehouse.reserve(order, items);
    } catch (error) {
      if (!(error instanceof OutOfStock)) throw error;
      tell('shipping.outOfStock', { sku: error.sku });
      return {};
    }
    (async () => {
      const trackingID = await warehouse.pickAndHandOver(order);
      if (trackingID === undefined) return; // released: cancelled
      tell('shipping.handedOver', { trackingID });
      await warehouse.delivery(order);
      if (!ended && invocation.running) invocation.done({ trackingID });
    })().catch((error) => tell('shipping.error', { reason: error.message }));
    return {
      receive(host, send) {
        if (send.event === 'cancel' && warehouse.release(order)) tell('shipping.cancelled');
      },
      stop() {
        ended = true;
        warehouse.release(order);
      },
    };
  }

  close() {
    this.host.close();
  }
}
