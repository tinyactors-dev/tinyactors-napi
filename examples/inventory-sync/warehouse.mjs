// The warehouse system: one host, systemID "warehouse", whose actors are
// the SKUs of charts/sku.scxml, each named "sku-<id>". It listens on a TCP
// port for the storefront and answers through its transport over the same
// connection. Going down for maintenance, it stops listening, drops the
// connection, waits for its host to be idle and keeps a snapshot; coming
// back, it is restored from that snapshot (holds, sales and their expiry
// timers included) and listens again.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { Host } from '@tinyactors/node';
import { Link } from './link.mjs';

const SKU_CHART = readFileSync(new URL('./charts/sku.scxml', import.meta.url), 'utf8');

export const WAREHOUSE = 'warehouse';
export const STOREFRONT = 'storefront';

/** The host's config: the same for `new Host` and `Host.restore`. */
const CONFIG = { systemID: WAREHOUSE, ioProcessors: [{ type: 'urn:warehouse:stock' }] };

export class Warehouse {
  /** every stock change the SKUs reported, in order: {event, sku, reservation, qty, stock} */
  ledger = [];
  /** the SKUs' `<log>` lines (duplicates seen, answers undelivered) */
  logs = [];

  /**
   * @param {object} options
   * @param {{[sku: string]: number}} [options.catalog] the units of each SKU, for a new warehouse
   * @param {string} [options.holdFor] how long a hold lasts, a delay in seconds or milliseconds ('900s', '500ms')
   * @param {Uint8Array} [options.snapshot] a warehouse to restore instead
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {ConstructorParameters<typeof Link>[0]['fault']} [options.fault]
   * @param {(line: string) => void} [options.trace]
   * @param {(entry: object) => void} [options.onReport] called with each entry of the ledger
   * @param {(line: string) => void} [options.onLog] called with each line of the logs
   */
  constructor({ catalog = {}, holdFor = '900s', snapshot, clock, datamodel, fault, trace, onReport = () => {}, onLog = () => {} } = {}) {
    this.link = new Link({ system: WAREHOUSE, peer: STOREFRONT, fault, trace });
    const options = {
      clock,
      datamodel,
      transport: this.link.transport,
      ioProcessors: {
        'urn:warehouse:stock': (host, send) => {
          const entry = { event: send.event, ...send.data };
          this.ledger.push(entry);
          onReport(entry);
        },
      },
      log: (host, entry) => {
        const line = `${entry.label}: ${entry.text}`;
        this.logs.push(line);
        onLog(line);
      },
    };
    if (snapshot !== undefined) {
      this.host = Host.restore(snapshot, CONFIG, options);
    } else {
      this.host = new Host(CONFIG, options);
      this.host.addCharts({ 'sku.scxml': SKU_CHART });
      for (const [sku, stock] of Object.entries(catalog)) {
        this.host.spawnChart('sku', { name: `sku-${sku}`, params: { sku, stock, holdFor } });
      }
    }
    this.link.host = this.host;
  }

  /** Listens for the storefront on `port` (0: any free one) of 127.0.0.1;
   * resolves with the port. */
  listen(port = 0) {
    this.server = createServer((socket) => this.link.attach(socket));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  /** Goes down: no more connections, the storefront's dropped, and the
   * host, once idle, snapshotted and closed. Resolves with the snapshot,
   * which `new Warehouse({ snapshot })` brings back. */
  async stop() {
    this.server?.close();
    this.link.disconnect();
    await this.host.idle();
    const snapshot = this.host.snapshot();
    this.host.close();
    return snapshot;
  }

  /** Adds `qty` units of `sku`. */
  restock(sku, qty) {
    this.host.send(`tinyactors://${WAREHOUSE}/@sku-${sku}`, 'restock', { qty });
  }

  /** What each SKU has, read from its actor with the typed methods:
   * {sku: {stock, held, sold}}. */
  async inventory() {
    const levels = {};
    const sum = (map) => Object.values(map).reduce((total, entry) => total + (typeof entry === 'number' ? entry : entry.qty), 0);
    let cursor;
    do {
      const page = await this.host.actorList(cursor === undefined ? {} : { cursor });
      for (const session of page.sessions) {
        const { variables } = await this.host.actorContext({ session });
        levels[variables.sku] = { stock: variables.stock, held: sum(variables.holds), sold: sum(variables.sold) };
      }
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return levels;
  }

  close() {
    this.server?.close();
    this.link.disconnect();
    if (!this.host.closed) this.host.close();
  }
}
