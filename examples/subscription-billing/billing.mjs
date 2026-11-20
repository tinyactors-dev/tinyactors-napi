// The application: a billing service whose subscriptions and free trials
// are actors of charts/subscription-v*.scxml and charts/trial-v*.scxml.
// The charts decide when to renew, how to dun, what a pause or a coupon
// does; this file does their I/O (the payment service they invoke, the
// notifications they send), keeps at most `maxResident` subscriptions in
// memory and the rest hibernated in a BlobStore (the host's store and
// resident bound), and deploys and migrates chart versions while all of it
// runs.
import { readFileSync } from 'node:fs';
import { compileCharts, Host, StaleError, TinyactorsError } from '@tinyactors/node';
import { BlobStore } from './world.mjs';

const chart = (file) => readFileSync(new URL(`./charts/${file}`, import.meta.url), 'utf8');

/** Each release of the charts: one image per version, both charts in it. */
export const RELEASES = {
  1: { 'subscription-v1.scxml': chart('subscription-v1.scxml'), 'trial-v1.scxml': chart('trial-v1.scxml') },
  2: { 'subscription-v2.scxml': chart('subscription-v2.scxml'), 'trial-v2.scxml': chart('trial-v2.scxml') },
};

/** The notifications after which an actor has ended. */
const FINAL = new Set(['subscription.cancelled', 'trial.converted', 'trial.cancelled']);

export class Billing {
  /**
   * @param {object} options
   * @param {import('@tinyactors/node').SimulatedClock} options.clock
   * @param {import('./world.mjs').PaymentGateway} options.gateway
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {object} [options.plan] the subscription chart's settings for
   *   every new subscription: cycleMs, retryMs, maxRetries, graceMs
   * @param {object} [options.trial] the trial chart's: trialMs
   */
  constructor({ clock, gateway, datamodel, plan = {}, trial = {}, maxResident }) {
    this.clock = clock;
    this.gateway = gateway;
    this.planSettings = plan;
    this.trialSettings = trial;
    this.store = new BlobStore();
    /** every notification, in order: { session, event, ...data } */
    this.outbox = [];
    /** segment -> release, as deploy() added them */
    this.releases = new Map();
    /** session -> the event a migration's move releases (applyCoupon) */
    this.deferred = new Map();
    /** migration id -> { id, options, moved, result, done } */
    this.migrations = new Map();
    /** bumped by everything that reaches the application, for settle() */
    this.activity = 0;
    this.counts = { hibernated: 0, woken: 0 };
    this.failure = undefined;

    // The host keeps at most maxResident actors in memory: after a turn it
    // hibernates the coldest past the bound into the store, and loads an
    // actor back when an event, a due renewal or a migration comes for it
    // (a migration's, as room allows: so a rollout moves a hibernated
    // population maxResident at a time).
    const store = {
      save: (session, blob) => {
        this.activity++;
        this.counts.hibernated++;
        this.store.put(session, blob);
      },
      load: (session) => {
        this.activity++;
        this.counts.woken++;
        return this.store.take(session);
      },
      delete: () => {}, // take() removed it
    };
    this.host = new Host([], {
      system: 'billing',
      clock,
      datamodel,
      store,
      ...(maxResident !== undefined && maxResident !== Infinity && { resident: maxResident }),
      services: { 'urn:billing:payments': (invocation) => this.payment(invocation) },
      ioProcessors: {
        'urn:billing:notify': { receive: (send) => this.notify(send.session, send.event, send.data) },
      },
      migrated: (moved) => this.moved(moved),
      migrationDone: (result) => this.finished(result),
    });
  }

  // --- deploys and migrations ------------------------------------------

  /** Adds a release's charts to the host: new subscriptions and trials are
   * of it from now on, running ones stay on theirs until a migration.
   * Returns the segment. */
  deploy(release) {
    const compiled = compileCharts(Object.entries(RELEASES[release]).map(([name, text]) => ({ name, text })));
    const segment = this.host.addImage(compiled.image);
    compiled.close();
    this.releases.set(segment, release);
    return segment;
  }

  /** Starts a migration (`host.migrate`'s options) and returns its
   * record, whose `done` resolves with the result. */
  migrate(options = {}) {
    const id = this.host.migrate(options);
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const record = { id, options, moved: [], result: undefined, done, resolve };
    this.migrations.set(id, record);
    return record;
  }

  /** The `migrated` handler: the view is valid while the handler runs, so
   * keep what it says. */
  moved(moved) {
    const { session, segment, chart } = moved;
    this.migrations.get(moved.migration)?.moved.push({ session, segment, chart });
    const waiting = this.deferred.get(session);
    if (waiting !== undefined) {
      this.deferred.delete(session);
      this.sendIfLive(session, waiting.event, waiting.data);
    }
  }

  finished(result) {
    const record = this.migrations.get(result.migration);
    record.result = { migration: result.migration, migrated: result.migrated, failed: result.failed.length, pending: [...result.pending] };
    record.resolve(record.result);
  }

  /** The release `session` runs on, read from the host: 1, 2, or
   * undefined for a session that has ended. */
  async releaseOf(session) {
    try {
      const { segment } = await this.host.actorGet({ session });
      return this.releases.get(segment);
    } catch (error) {
      if (error instanceof TinyactorsError) return undefined;
      throw error;
    }
  }

  /** Every live actor by chart and release, from the host:
   * { subscription: { 1: [sessions], 2: [...] }, trial: {...} }. */
  async inventory() {
    const result = {};
    let cursor;
    do {
      const page = await this.host.actorList(cursor === undefined ? { limit: 512 } : { cursor, limit: 512 });
      const actors = await Promise.all(page.sessions.map((session) => this.host.actorGet({ session })));
      for (const actor of actors) {
        const release = this.releases.get(actor.segment);
        ((result[actor.chart] ??= {})[release] ??= []).push(BigInt(actor.session));
      }
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return result;
  }

  // --- customers -------------------------------------------------------

  /** A new subscription, named `sub-<customer>`, of the newest release. */
  subscribe(customer, { plan = 'basic', price = 900 } = {}) {
    return this.host.spawn('subscription', {
      name: `sub-${customer}`, params: { customer, plan, price, ...this.planSettings },
    }).id;
  }

  /** A free trial, named `trial-<customer>`; it becomes a subscription
   * when it ends. */
  startTrial(customer, { plan = 'basic', price = 900 } = {}) {
    return this.host.spawn('trial', {
      name: `trial-${customer}`, params: { customer, plan, price, ...this.trialSettings },
    }).id;
  }

  changePlan(customer, plan, price) { this.input(`sub-${customer}`, 'change', { plan, price }); }
  cardUpdated(customer) { this.input(`sub-${customer}`, 'card.updated'); }
  resume(customer) { this.input(`sub-${customer}`, 'resume'); }

  /** Applies a coupon of `cycles` discounted renewals. Release 1 stamps a
   * coupon with a Date, which keeps its subscription from migrating on
   * the native datamodel; so once a newer release is deployed, a coupon
   * for a subscription still on an older one waits here and is sent when
   * a migration moves it. Answers 'applied', 'deferred' or 'ended'. */
  async applyCoupon(customer, cycles) {
    const session = this.session(`sub-${customer}`);
    if (session === undefined) return 'ended';
    const release = this.releases.size > 1 ? await this.releaseOf(session) : this.newest();
    if (release === undefined) return 'ended';
    if (release < this.newest()) {
      this.deferred.set(session, { event: 'coupon', data: { cycles } });
      return 'deferred';
    }
    return this.sendIfLive(session, 'coupon', { cycles }) ? 'applied' : 'ended';
  }

  /** The newest release deployed. */
  newest() {
    return Math.max(...this.releases.values());
  }

  /** host.send, answering false when the session ended meanwhile. */
  sendIfLive(session, event, data) {
    try {
      this.host.send(session, event, data);
      return true;
    } catch (error) {
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_STALE') return false;
      throw error;
    }
  }

  /** Pauses a subscription; answers false when it is still on release 1,
   * which has no paused state (an event no transition takes is dropped
   * without a word, so the application asks the host first). */
  async pause(customer) {
    const session = this.session(`sub-${customer}`);
    const release = session === undefined ? undefined : await this.releaseOf(session);
    if (release === undefined || release < 2) return false;
    return this.sendIfLive(session, 'pause');
  }
  cancel(customer) { this.input(`sub-${customer}`, 'cancel'); }
  extendTrial(customer, ms) { this.input(`trial-${customer}`, 'extend', { ms }); }

  /** The session of a customer's subscription (or `trial-` actor), or
   * undefined once it ended. */
  session(name) {
    try {
      return this.host.actor(name).id;
    } catch (error) {
      if (error instanceof StaleError) return undefined;
      throw error;
    }
  }

  /** An event for a named actor, which may be hibernated: the host keeps
   * it in the actor's queue and loads the actor from the store. */
  input(name, event, data) {
    this.host.actor(name).send(event, data); // a StaleError for no such actor
  }

  notify(session, event, data) {
    this.activity++;
    this.outbox.push({ session, event, ...data });
    // a trial that ends converts: a subscription of the newest release
    if (event === 'trial.converted') this.subscribe(data.customer, { plan: data.plan, price: data.price });
  }

  /** The payment service a renewal invokes: one charge at the gateway.
   * The invocation ends with done (paid) or sends back payment.declined. */
  payment(invocation) {
    const { customer, amount, invoice, attempt } = invocation.data;
    this.track(this.gateway.charge({ customer, amount, invoice, attempt }).then((result) => {
      this.activity++;
      if (!invocation.running) return; // cancelled meanwhile
      if (result.status === 'ok') invocation.done({ chargeID: result.chargeID, amount: result.amount });
      else invocation.sendBack('payment.declined', { reason: result.reason });
    }));
    return {};
  }

  // --- time ------------------------------------------------------------

  /** Keeps the first error of a promise nobody awaits, for settle(). */
  track(promise) {
    promise.catch((error) => { this.failure ??= error; });
  }

  /** Waits until the host is idle and the gateway's answers that are due
   * have reached it: the payment service answers from a promise it starts
   * and does not return to the host (it returns the service at once, so
   * that a cancel reaches it), which `host.idle()` cannot wait for, so
   * this turns until a round sees no new activity. Charges still waiting for
   * their time on the clock are not waited for. */
  async settle() {
    let seen;
    do {
      seen = this.activity;
      await this.host.idle();
      await new Promise((resolve) => setImmediate(resolve));
    } while (seen !== this.activity);
    await this.host.idle();
    if (this.failure) throw this.failure;
  }

  /** Moves the clock `ms` forward, stopping at every deadline of the host
   * and every answer of the gateway on the way, and settling at each. */
  async advance(ms) {
    const end = this.clock.now + ms;
    for (;;) {
      await this.settle();
      const deadline = this.host.nextDeadline === undefined ? Infinity : this.clock.now + this.host.nextDeadline;
      const next = Math.min(deadline, this.gateway.nextDue() ?? Infinity);
      if (next > end) break;
      this.clock.increment(Math.max(0, next - this.clock.now));
      this.gateway.tick();
    }
    if (this.clock.now < end) this.clock.increment(end - this.clock.now);
    this.gateway.tick();
    await this.settle();
  }

  /** Resident and hibernated actors, as the host counts them. */
  async counters() {
    const { host } = await this.host.hostStats();
    return { actors: host.actors, hibernated: host.hibernated, resident: host.actors - host.hibernated, segments: host.segments, retired: host.retired };
  }

  close() {
    this.host.close();
  }
}
