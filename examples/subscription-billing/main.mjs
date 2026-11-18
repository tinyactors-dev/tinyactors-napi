// Four months of a subscription business on a SimulatedClock, in under a
// second: customers sign up (some through a free trial), renew every
// thirty days, change plans, apply coupons, and some cards decline. Most
// subscriptions are hibernated between their events. On day 45 release 2
// of the charts is rolled out while all of this goes on; on day 120 the
// operator moves the stragglers. At the end every charge is reconciled
// against the invoices the subscriptions sent, and no actor is left on
// release 1.
//
//   node examples/subscription-billing/main.mjs [--customers N] [--trials N] [--seed S]
//     [--resident N] [--datamodel native|quickjs]
import { parseArgs } from 'node:util';
import { SimulatedClock } from '@tinyactors/node';
import { Billing } from './billing.mjs';
import { retry, rollout } from './rollout.mjs';
import { PaymentGateway } from './world.mjs';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const PLANS = [{ plan: 'basic', price: 900 }, { plan: 'pro', price: 2900 }, { plan: 'team', price: 9900 }];

/** A small seeded generator (mulberry32), so a run can be repeated. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs the business and answers what happened, with the checks. */
export async function run({ customers = 200, trials = 40, seed = 1, maxResident = 40, datamodel, log = () => {} } = {}) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const clock = new SimulatedClock();
  // some banks answer three days later: their renewals may be in flight
  // when the rollout reaches them
  const slow = new Set();
  const gateway = new PaymentGateway({ clock, latencyMs: (customer) => (slow.has(customer) ? 3 * DAY : 0) });
  const billing = new Billing({
    clock, gateway, datamodel,
    plan: { cycleMs: 30 * DAY, retryMs: 2 * DAY, maxRetries: 4, graceMs: 3 * DAY },
    trial: { trialMs: 30 * DAY },
  });
  const coupons = new Set();
  const lapsing = new Set(); // cards that decline until the customer updates them
  const names = [];
  billing.deploy(1);

  // signups over the first thirty days
  const signups = [];
  for (let n = 1; n <= customers + trials; n++) {
    signups.push({ at: Math.floor(next() * 30 * DAY), customer: `c${String(n).padStart(4, '0')}`, trial: n > customers });
  }
  signups.sort((a, b) => a.at - b.at);

  /** What customers do in a moment: change plans, apply coupons, update
   * cards, pause and resume. */
  const business = () => {
    if (names.length === 0) return;
    const customer = pick(names);
    if (billing.session(`sub-${customer}`) === undefined) return;
    const roll = next();
    if (roll < 0.1) {
      const { plan, price } = pick(PLANS);
      billing.changePlan(customer, plan, price);
    } else if (roll < 0.12 && !coupons.has(customer)) {
      coupons.add(customer);
      billing.track(billing.applyCoupon(customer, 2));
    } else if (roll < 0.2 && lapsing.has(customer)) {
      lapsing.delete(customer);
      gateway.cards.set(customer, 'ok');
      billing.cardUpdated(customer);
    }
  };

  const day = () => Math.floor(clock.now / DAY);
  const sign = (signup) => {
    const { customer } = signup;
    names.push(customer);
    if (next() < 0.15) slow.add(customer);
    const card = next();
    if (card < 0.05) gateway.cards.set(customer, 'declined'); // never pays
    else if (card < 0.15) { gateway.cards.set(customer, 'declined'); lapsing.add(customer); }
    if (signup.trial) billing.startTrial(customer, pick(PLANS));
    else billing.subscribe(customer, pick(PLANS));
  };

  /** Runs the business until `until`, an hour at a time. */
  const live = async (until) => {
    while (clock.now < until) {
      while (signups.length > 0 && signups[0].at <= clock.now) sign(signups.shift());
      for (let i = 0; i < Math.max(1, names.length / 200); i++) business();
      await billing.advance(Math.min(HOUR, until - clock.now));
      billing.evict(maxResident);
    }
  };

  await live(45 * DAY);
  const before = await billing.counters();
  log(`day ${day()}: ${before.actors} actors, ${before.resident} in memory, ${before.hibernated} hibernated`);

  // the rollout, while customers go on
  const canary = names.find((customer) => billing.session(`sub-${customer}`) !== undefined && !coupons.has(customer));
  const report = await rollout(billing, {
    release: 2, charts: ['subscription', 'trial'], canary: `sub-${canary}`,
    // six hours of ten-minute rounds: enough wakes a round to reach
    // every hibernated actor before the timeout
    timeoutMs: 6 * HOUR, batch: Math.max(20, Math.ceil(before.actors / 30)), stepMs: 10 * MINUTE, maxResident,
    during: business, log: (line) => log(`day ${day()}: ${line}`),
  });

  // three months on release 2: pauses are new
  const paused = [];
  for (const customer of names.slice(0, 10)) if (await billing.pause(customer)) paused.push(customer);
  await live(60 * DAY);
  for (const customer of paused) if (billing.session(`sub-${customer}`) !== undefined) billing.resume(customer);
  await live(120 * DAY);

  // the second pass: the stragglers' payments have answered and most
  // coupons have run out; one applied since runs two more cycles, so the
  // operator comes back a month later for what is left
  const atRollout = report.leftBehind.subscription.length + report.leftBehind.trial.length;
  const retried = [];
  for (let pass = 1; pass <= 3; pass++) {
    const old = await billing.inventory();
    const still = [...(old.subscription?.[1] ?? []), ...(old.trial?.[1] ?? [])];
    if (still.length === 0) break;
    const results = await retry(billing, still, { stepMs: 10 * MINUTE, maxResident, during: business });
    retried.push(...results);
    log(`day ${day()}: pass ${pass}: retried the ${still.length} still on release 1 (${atRollout} after the rollout): ` +
      `${results.filter((r) => r.migrated === 1).length} moved, ${results.filter((r) => r.failed === 1).length} failed`);
    await live(clock.now + (results.some((r) => r.failed === 1) ? 31 * DAY : DAY));
  }

  // --- the checks ----------------------------------------------------
  const inventory = await billing.inventory();
  const after = await billing.counters();
  const problems = [];
  const invoicesOf = new Map();
  for (const message of billing.outbox) {
    if (message.event !== 'invoice.paid') continue;
    const list = invoicesOf.get(message.customer) ?? [];
    list.push(message);
    invoicesOf.set(message.customer, list);
  }
  for (const customer of names) {
    const invoices = invoicesOf.get(customer) ?? [];
    const billed = invoices.reduce((sum, invoice) => sum + invoice.amount, 0);
    if (billed !== gateway.total(customer)) problems.push(`${customer}: invoiced ${billed}, charged ${gateway.total(customer)}`);
    invoices.forEach((invoice, i) => {
      if (invoice.invoice !== i + 1) problems.push(`${customer}: invoice ${invoice.invoice} where ${i + 1} was due`);
    });
  }
  const onOld = [...(inventory.subscription?.[1] ?? []), ...(inventory.trial?.[1] ?? [])];
  if (onOld.length > 0) problems.push(`${onOld.length} actors still on release 1`);
  if (after.retired < 1) problems.push('release 1\'s segment was not retired');
  const migrations = [...billing.migrations.values()];
  const moved = migrations.reduce((sum, m) => sum + m.moved.length, 0);
  if (moved !== migrations.reduce((sum, m) => sum + m.result.migrated, 0)) problems.push('migrated events and results disagree');
  const count = (event) => billing.outbox.filter((message) => message.event === event).length;
  return {
    report, retried, before, after, inventory, problems, moved, paused, days: day(),
    invoices: count('invoice.paid'),
    v2Invoices: billing.outbox.filter((message) => message.event === 'invoice.paid' && message.version === 2).length,
    upgraded: count('subscription.upgraded'), failedPayments: count('payment.failed'),
    suspended: count('access.suspended'), cancelled: count('subscription.cancelled'),
    converted: count('trial.converted'), counts: billing.counts, store: billing.store,
    close: () => billing.close(),
  };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      customers: { type: 'string', default: '200' }, trials: { type: 'string', default: '40' },
      seed: { type: 'string', default: '1' }, resident: { type: 'string', default: '40' },
      datamodel: { type: 'string', default: 'native' },
    },
  });
  const wall = Date.now();
  const result = await run({
    customers: Number(values.customers), trials: Number(values.trials), seed: Number(values.seed),
    maxResident: Number(values.resident), datamodel: values.datamodel, log: console.log,
  });
  result.close();
  const { report, before, after, counts, store } = result;
  console.log(`\n${result.days} days in ${Date.now() - wall} ms on the ${values.datamodel} datamodel`);
  console.log(`rollout: canary ${report.canary?.name} on release ${report.canary?.release}; ` +
    report.migrations.map((m) => `${m.chart} ${m.result.migrated} moved, ${m.result.failed} failed, ${m.result.pending.length} pending`).join('; '));
  console.log(`${result.moved} migrated events in all, ${result.upgraded} upgrades seen by the charts; ${result.paused.length} paused on release 2`);
  console.log(`${result.invoices} invoices paid (${result.v2Invoices} by release 2), ${result.failedPayments} failed payments, ` +
    `${result.suspended} suspensions after a grace period, ${result.cancelled} cancelled, ${result.converted} trials converted`);
  console.log(`memory: ${before.resident} of ${before.actors} in memory before the rollout, ${after.resident} of ${after.actors} at the end; ` +
    `${counts.hibernated} hibernations, ${counts.wokenForEvents} wakes for events, ${counts.wokenForMigrations} for migrations; ${store.size} blobs stored`);
  console.log(`segments: ${after.segments} live, ${after.retired} retired`);
  console.log(result.problems.length === 0 ? 'every charge invoiced once, every invoice numbered in order, nothing left on release 1'
    : `PROBLEMS:\n  ${result.problems.join('\n  ')}`);
  process.exitCode = result.problems.length === 0 ? 0 : 1;
}
