// The storefront system: one host, systemID "storefront", whose actors are
// the customers' carts of charts/cart.scxml, each named by the cart's id.
// The carts reserve, confirm and release stock at the warehouse's SKU
// actors through the host's transport, over one TCP connection to the
// warehouse, and tell the customer each step through urn:shop:customer.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { Host } from '@tinyactors/node';
import { Link } from './link.mjs';
import { STOREFRONT, WAREHOUSE } from './warehouse.mjs';

const CART_CHART = readFileSync(new URL('./charts/cart.scxml', import.meta.url), 'utf8');

/** The notifications that end an order. */
const ENDINGS = new Set(['order.placed', 'order.failed', 'order.cancelled']);

export class Storefront {
  /** every notification the carts sent, in order: {event, cart, ...} */
  outbox = [];
  /** the carts' `<log>` lines */
  logs = [];
  #waiters = [];

  /**
   * @param {object} options
   * @param {object} [options.timing] the cart's timings: replyTimeout and
   *   backoff (delays, '5s', '200ms') and maxAttempts
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {ConstructorParameters<typeof Link>[0]['fault']} [options.fault]
   * @param {(line: string) => void} [options.trace]
   */
  constructor({ timing = {}, clock, datamodel, fault, trace } = {}) {
    this.timing = timing;
    this.link = new Link({ system: STOREFRONT, peer: WAREHOUSE, fault, trace });
    this.host = new Host({ systemID: STOREFRONT, ioProcessors: [{ type: 'urn:shop:customer' }] }, {
      clock,
      datamodel,
      transport: this.link.transport,
      ioProcessors: { 'urn:shop:customer': (host, send) => this.#notify({ event: send.event, ...send.data }) },
      log: (host, entry) => this.logs.push(`${entry.label}: ${entry.text}`),
    });
    this.host.addCharts({ 'cart.scxml': CART_CHART });
    this.link.host = this.host;
  }

  /** Connects to the warehouse at `port` of 127.0.0.1. Resolves once
   * connected, with a promise that settles when the connection closes. */
  async connect(port) {
    const socket = connect({ host: '127.0.0.1', port });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return { closed: this.link.attach(socket) };
  }

  /** Opens a cart: an actor named `cart`. */
  open(cart) {
    return this.host.spawnChart('cart', { name: cart, params: this.timing });
  }

  add(cart, sku, qty) { return this.#tell(cart, 'add', { sku, qty }); }
  remove(cart, sku) { return this.#tell(cart, 'remove', { sku }); }
  checkout(cart) { return this.#tell(cart, 'checkout'); }
  cancel(cart) { return this.#tell(cart, 'cancel'); }

  /** The notifications of one cart. */
  of(cart) {
    return this.outbox.filter((message) => message.cart === cart);
  }

  /** Resolves with the first notification, sent or to come, for which
   * `test` holds. */
  next(test) {
    const seen = this.outbox.find(test);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.#waiters.push({ test, resolve }));
  }

  /** Resolves with the notification that ended the order of `cart`. */
  ending(cart) {
    return this.next((message) => message.cart === cart && ENDINGS.has(message.event));
  }

  /** Sends the customer's request to the cart; false when there is no such
   * cart any more (its order ended, or it never was). */
  #tell(cart, event, data) {
    const session = this.host.actorByName(cart);
    if (session === undefined) return false;
    this.host.send(session, event, data);
    return true;
  }

  #notify(message) {
    this.outbox.push(message);
    this.#waiters = this.#waiters.filter(({ test, resolve }) => !(test(message) && (resolve(message), true)));
  }

  close() {
    this.link.disconnect();
    if (!this.host.closed) this.host.close();
  }
}
