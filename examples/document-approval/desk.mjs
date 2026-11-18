// The application: an approval desk whose documents are actors of
// charts/document.scxml. The chart decides what a document does; this file
// does the I/O it asks for: notifications to people, and the archive,
// which takes each approved document's metadata as an XML record, parses
// it and stores it as a file.
import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Host, TinyactorsError } from '@tinyactors/node';
import { readRecord } from './xml.mjs';

const DOCUMENT_CHART = readFileSync(new URL('./charts/document.scxml', import.meta.url), 'utf8');

/** The notifications that end a document. */
export const FINAL = new Set(['document.approved', 'document.rejected', 'document.withdrawn']);

export class ApprovalDesk {
  /**
   * @param {object} options
   * @param {string} options.dir where the archive writes its records
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {{ legal?: number, finance?: number, signoff?: number }} [options.slaMs] each stage's SLA
   * @param {number} [options.legalFirstAt] the amount from which finance waits for legal
   * @param {(xml: string) => Promise<void> | void} [options.beforeArchive] called with each
   *   record before it is stored; a test makes the archive fail by throwing here
   */
  constructor({ dir, clock, datamodel, slaMs, legalFirstAt, beforeArchive }) {
    this.dir = dir;
    this.slaMs = slaMs;
    this.legalFirstAt = legalFirstAt;
    this.beforeArchive = beforeArchive;
    mkdirSync(join(dir, 'archive'), { recursive: true });
    /** every notification, in order: `{ event, ...data }` */
    this.outbox = [];
    /** docID -> the record the archive stored, as it parsed it */
    this.records = new Map();
    /** the XML the archive was given, in order, stored or not */
    this.archived = [];
    /** the archive's work still running: `settle()` waits for it */
    this.pending = new Set();
    /** docID -> { promise, resolve } of its final notification */
    this.endings = new Map();
    this.receipts = 0;

    this.host = new Host(
      { systemID: 'approvals', ioProcessors: [{ type: 'urn:approval:notify' }, { type: 'urn:approval:archive' }] },
      {
        clock,
        datamodel,
        ioProcessors: {
          'urn:approval:notify': (host, send) => this.notify(send.event, send.data),
          // The archive is a slow system: the handler is async, so its
          // send stays readable after the await, and answers later. A
          // failure fails the send: the chart gets error.communication and
          // retries.
          'urn:approval:archive': (host, send) => this.track(this.archive(send)),
        },
      },
    );
    this.host.addCharts({ 'document.scxml': DOCUMENT_CHART });
  }

  /** Keeps `promise` in `pending` until it settles, and returns it. */
  track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  notify(event, data) {
    const message = { event, ...data };
    this.outbox.push(message);
    if (FINAL.has(event)) this.endings.get(data.docID)?.resolve(message);
  }

  /** The archive: parses the chart's XML, stores it, answers a receipt. */
  async archive(send) {
    const xml = send.data;
    this.archived.push(xml);
    try {
      await this.beforeArchive?.(xml);
      const record = readRecord(xml);
      await writeFile(join(this.dir, 'archive', `${record.docID}-v${record.version}.xml`), xml);
      this.records.set(record.docID, record);
      send.answer('archived', { receipt: `ARC-${String(++this.receipts).padStart(4, '0')}` });
    } catch {
      send.fail();
    }
  }

  /** A new document, in draft: an actor named by its id. Resolves, through
   * `ending(id)`, with its final notification. */
  create({ id, title, author, amount }) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.endings.set(id, { promise, resolve });
    const params = { docID: id, title, author, amount };
    if (this.slaMs) params.slaMs = { legal: 172800000, finance: 172800000, signoff: 86400000, ...this.slaMs };
    if (this.legalFirstAt !== undefined) params.legalFirstAt = this.legalFirstAt;
    return this.host.spawnChart('document', { name: id, params });
  }

  /** Creates a document and submits it for review. */
  file(document) {
    this.create(document);
    return this.act(document.id, 'submit');
  }

  /** Sends `event` to document `id`: `'sent'`, or `'unknown'` when there is
   * no such document any more (it ended, or never was). Whether the event
   * does anything is the chart's to decide. */
  act(id, event, data) {
    const session = this.host.actorByName(id);
    if (session === undefined) return 'unknown';
    try {
      this.host.send(session, event, data);
    } catch (error) {
      // It ended between the lookup and the send.
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_STALE') return 'unknown';
      throw error;
    }
    return 'sent';
  }

  /** The final notification of document `id`, once it ends. */
  ending(id) {
    return this.endings.get(id)?.promise;
  }

  /** Waits until the host is idle: `host.idle()` waits for the archive
   * handler's promise too. */
  async settle() {
    await this.host.idle();
  }

  close() {
    this.host.close();
  }
}
