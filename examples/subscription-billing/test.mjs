// The migration's tricky cases, each on a SimulatedClock with a gateway
// the test can hold, on both datamodels; then four months of the business
// of main.mjs, rolled out on day 45 and checked. Run by `mise run
// examples` (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimulatedClock } from '@tinyactors/node';
import { Billing } from './billing.mjs';
import { DAY, HOUR, run } from './main.mjs';
import { drive, rollout } from './rollout.mjs';
import { PaymentGateway } from './world.mjs';

/** A billing service on a simulated clock: 30-day cycles, a retry a day,
 * six attempts, three days of grace; release 1 deployed. */
function setup(datamodel) {
  const clock = new SimulatedClock();
  const gateway = new PaymentGateway({ clock });
  const billing = new Billing({
    clock, gateway, datamodel,
    plan: { cycleMs: 30 * DAY, retryMs: DAY, maxRetries: 6, graceMs: 3 * DAY },
    trial: { trialMs: 30 * DAY },
  });
  billing.deploy(1);
  return { clock, gateway, billing };
}

const of = (billing, session, event) => billing.outbox.filter((m) => m.session === session && (event === undefined || m.event === event));
const events = (billing, session) => of(billing, session).map((m) => m.event);
const variables = async (billing, session) => (await billing.host.actorContext({ session })).variables;
const state = async (billing, session) => (await billing.host.actorState({ session })).value;

/** Runs `migration` to its end, waking what it asks for `batch` at a time
 * and moving the clock `stepMs` a round. */
const finish = (billing, migration, { batch = 100, stepMs = 1000, maxResident = Infinity } = {}) =>
  drive(billing, [migration], { batch, stepMs, maxResident }).then(([result]) => result);

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: a subscription moves to release 2 with its invoices and its pending renewal`, async () => {
    const { clock, billing } = setup(datamodel);
    try {
      const ada = billing.subscribe('ada');
      await billing.advance(40 * DAY); // renewed once, at day 30: the next renewal is due at day 60
      assert.deepEqual(of(billing, ada, 'invoice.paid').map((m) => [m.invoice, m.amount, m.version]), [[1, 900, 1]]);

      const segment = billing.deploy(2);
      const migration = billing.migrate({ chart: 'subscription' });
      await billing.settle();
      assert.deepEqual(migration.result, { migration: migration.id, migrated: 1, failed: 0, pending: [] });
      assert.deepEqual(migration.moved, [{ session: ada, segment, chart: 'subscription' }]);
      assert.equal(await billing.releaseOf(ada), 2);
      const vars = await variables(billing, ada);
      assert.equal(vars.invoices, 1);
      assert.equal(vars.paid, 900);
      assert.equal(vars.dunningAttempts, 0);
      assert.equal(vars.upgradedFrom, 1);
      assert.equal(vars.access, 'on', "a variable only release 2 declares gets its initial value");
      assert.equal('failures' in vars, false, "the old name is gone");
      assert.deepEqual(await state(billing, ada), { subscription: 'active' });

      // the renewal armed by release 1 falls due on release 2, on time
      await billing.advance(60 * DAY - clock.now - 1);
      assert.equal(of(billing, ada, 'invoice.paid').length, 1);
      await billing.advance(1);
      assert.deepEqual(of(billing, ada, 'invoice.paid').map((m) => [m.invoice, m.version]), [[1, 1], [2, 2]]);
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: a subscription in dunning keeps its retry timer and gets release 2's grace period`, async () => {
    const { clock, gateway, billing } = setup(datamodel);
    try {
      gateway.cards.set('bob', 'declined');
      const bob = billing.subscribe('bob');
      await billing.advance(30 * DAY + HOUR); // the first renewal failed: past due, the retry at day 31
      assert.deepEqual(events(billing, bob), ['payment.failed']);
      assert.deepEqual(await state(billing, bob), { subscription: 'pastDue' });

      billing.deploy(2);
      const migration = billing.migrate({ session: bob });
      await billing.settle();
      assert.equal(migration.result.migrated, 1);
      // version 1's pastDue is version 2's; its initial child is entered
      // without an onentry, and the upgrade transition starts the grace
      assert.deepEqual(await state(billing, bob), { subscription: { pastDue: 'grace' } });
      assert.equal((await variables(billing, bob)).dunningAttempts, 1, 'failures, renamed');
      assert.deepEqual(of(billing, bob, 'subscription.upgraded').map((m) => m.dunningAttempts), [1]);

      await billing.advance(DAY - HOUR); // day 31: release 1's retry, on release 2
      assert.deepEqual(of(billing, bob, 'payment.failed').map((m) => m.attempt), [1, 2]);
      assert.deepEqual(of(billing, bob, 'access.suspended'), [], 'still in grace');
      await billing.advance(2 * DAY + 2 * HOUR); // day 33, past the grace's three days from the upgrade
      assert.deepEqual(of(billing, bob, 'payment.failed').map((m) => m.attempt), [1, 2, 3, 4]);
      assert.equal(of(billing, bob, 'access.suspended').length, 1);
      assert.deepEqual(await state(billing, bob), { subscription: { pastDue: 'suspended' } });

      gateway.cards.set('bob', 'ok');
      billing.cardUpdated('bob');
      await billing.settle();
      assert.deepEqual(of(billing, bob, 'invoice.paid').map((m) => [m.invoice, m.version]), [[1, 2]]);
      assert.equal((await variables(billing, bob)).access, 'on');
      assert.equal(clock.now < 34 * DAY, true);
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: an actor holding a Date: ${datamodel === 'native' ? 'it stays on release 1, counted as failed, until it can move' : 'it moves, its Date with it'}`, async () => {
    const { billing } = setup(datamodel);
    try {
      const ada = billing.subscribe('ada');
      const bob = billing.subscribe('bob');
      assert.equal(await billing.applyCoupon('ada', 1), 'applied'); // release 1 stamps it with a Date
      await billing.settle();
      const segment = billing.deploy(2);
      const migration = billing.migrate({ chart: 'subscription' });
      await billing.settle();
      if (datamodel === 'native') {
        assert.deepEqual(migration.result, { migration: migration.id, migrated: 1, failed: 1, pending: [] });
        assert.deepEqual(migration.moved, [{ session: bob, segment, chart: 'subscription' }]);
        assert.equal(await billing.releaseOf(ada), 1);
        assert.equal(billing.hibernate(ada), false, 'what a migration cannot write out, hibernation cannot either');

        // it goes on, on release 1: the discounted renewal clears the stamp
        await billing.advance(30 * DAY);
        assert.deepEqual(of(billing, ada, 'invoice.paid').map((m) => [m.amount, m.version]), [[450, 1]]);
        const again = billing.migrate({ session: ada });
        await billing.settle();
        assert.deepEqual(again.result, { migration: again.id, migrated: 1, failed: 0, pending: [] });
        assert.equal((await variables(billing, ada)).couponAppliedMs, null);
      } else {
        assert.deepEqual(migration.result, { migration: migration.id, migrated: 2, failed: 0, pending: [] });
        const stamp = (await variables(billing, ada)).couponAppliedMs;
        assert.equal(typeof stamp, 'number');
        assert.ok(Math.abs(stamp - Date.now()) < 60_000, 'the stamp is the wall clock\'s, as a number');
        await billing.advance(30 * DAY);
        assert.deepEqual(of(billing, ada, 'invoice.paid').map((m) => [m.amount, m.version]), [[450, 2]]);
      }
      assert.equal(await billing.releaseOf(ada), 2);
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: once release 2 is deployed, a coupon for a subscription on release 1 waits for its migration`, async () => {
    const { billing } = setup(datamodel);
    try {
      const ada = billing.subscribe('ada');
      await billing.settle();
      billing.deploy(2);
      assert.equal(await billing.applyCoupon('ada', 2), 'deferred');
      await billing.settle();
      assert.equal((await variables(billing, ada)).couponCycles, 0, 'not sent to release 1');
      const migration = billing.migrate({ session: ada });
      await billing.settle();
      assert.equal(migration.result.migrated, 1);
      const vars = await variables(billing, ada);
      assert.equal(vars.couponCycles, 2, 'sent from the migrated handler');
      assert.equal(typeof vars.couponAppliedMs, 'number');
      assert.equal(await billing.applyCoupon('nobody', 1), 'ended');
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: a payment in flight holds its subscription past the migration's timeout`, async () => {
    const { gateway, billing } = setup(datamodel);
    try {
      const ada = billing.subscribe('ada');
      const bob = billing.subscribe('bob');
      gateway.hold = true;
      await billing.advance(30 * DAY); // both renewals are being charged
      assert.equal(gateway.held.length, 2);

      billing.deploy(2);
      const migration = billing.migrate({ chart: 'subscription', timeout: 60_000 });
      await billing.advance(30_000);
      assert.equal(migration.result, undefined, 'an actor running an invocation waits for it');
      gateway.held.find((charge) => charge.call.customer === 'bob').answer();
      await billing.advance(30_000);
      assert.deepEqual(migration.result, { migration: migration.id, migrated: 1, failed: 0, pending: [ada] });
      assert.deepEqual(migration.moved.map((moved) => moved.session), [bob]);

      // after its timeout the migration takes nothing more: a second one does
      gateway.held.find((charge) => charge.call.customer === 'ada').answer();
      await billing.settle();
      assert.deepEqual(of(billing, ada, 'invoice.paid').map((m) => m.version), [1]);
      assert.deepEqual(of(billing, bob, 'invoice.paid').map((m) => m.version), [1], 'its charge ended on release 1, then it moved');
      assert.equal(await billing.releaseOf(ada), 1);
      const second = billing.migrate({ session: ada });
      await billing.settle();
      assert.equal(second.result.migrated, 1);
      assert.equal(await billing.releaseOf(ada), 2);
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: one chart, then one session: the trials stay on release 1 until moved`, async () => {
    const { clock, billing } = setup(datamodel);
    try {
      const ada = billing.subscribe('ada');
      const tom = billing.startTrial('tom');
      const tim = billing.startTrial('tim');
      await billing.advance(DAY);
      billing.deploy(2);
      const subscriptions = billing.migrate({ chart: 'subscription' });
      await billing.settle();
      assert.deepEqual(subscriptions.moved.map((moved) => moved.session), [ada]);
      assert.equal(await billing.releaseOf(tom), 1);
      billing.extendTrial('tom', 60 * DAY); // release 1 has no extend: dropped
      await billing.settle();
      assert.deepEqual(events(billing, tom), []);

      const one = billing.migrate({ session: tom });
      await billing.settle();
      assert.deepEqual(one.moved.map((moved) => [moved.session, moved.chart]), [[tom, 'trial']]);
      assert.equal(await billing.releaseOf(tim), 1);
      billing.extendTrial('tom', 60 * DAY);
      await billing.settle();
      assert.deepEqual(of(billing, tom, 'trial.extended').map((m) => m.extensions), [1]);

      // tim converts on release 1's timer; its subscription is release 2's
      await billing.advance(30 * DAY - clock.now + 1);
      assert.deepEqual(events(billing, tim), ['trial.converted']);
      assert.equal(await billing.releaseOf(billing.session('sub-tim')), 2);
      assert.equal(billing.session('trial-tom'), tom, 'extended: still on trial');
      const { retired } = await billing.counters();
      assert.equal(retired, 1, 'nothing runs on release 1 any more');
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: hibernated actors hold a migration without wake until its timeout; with wake they are asked for and woken a batch at a time`, async () => {
    const { billing } = setup(datamodel);
    try {
      const sessions = ['a', 'b', 'c', 'd', 'e'].map((customer) => billing.subscribe(customer));
      await billing.settle();
      billing.evict(0);
      assert.equal(billing.store.size, 5);
      billing.deploy(2);

      const cold = billing.migrate({ chart: 'subscription', timeout: 60_000 });
      await billing.advance(60_000);
      assert.deepEqual({ ...cold.result, pending: cold.result.pending.toSorted() },
        { migration: cold.id, migrated: 0, failed: 0, pending: sessions });
      assert.deepEqual(billing.migrationWakes, [], 'no wake was asked for');
      assert.equal(await billing.releaseOf(sessions[0]), 1, 'a hibernated actor answers actorGet');

      const warm = billing.migrate({ chart: 'subscription', wake: true });
      await billing.settle();
      assert.deepEqual(billing.migrationWakes.toSorted((a, b) => Number(a.session - b.session)),
        sessions.map((session) => ({ session, migration: warm.id })));
      // an event for one of them wakes it at once, and the migration takes it
      billing.changePlan('e', 'pro', 2900);
      await billing.settle();
      assert.equal(billing.counts.wokenForEvents, 1);
      assert.deepEqual(warm.moved.map((moved) => moved.session), [sessions[4]]);
      billing.evict(0);

      let mostResident = 0;
      while (warm.result === undefined) {
        billing.wakeForMigrations(2);
        await billing.advance(1000);
        mostResident = Math.max(mostResident, (await billing.counters()).resident);
        billing.evict(0);
      }
      assert.deepEqual(warm.result, { migration: warm.id, migrated: 5, failed: 0, pending: [] });
      assert.equal(mostResident, 2, 'two at a time');
      assert.equal(billing.counts.wokenForMigrations, 4);
      for (const session of sessions) assert.equal(await billing.releaseOf(session), 2);
      assert.deepEqual(of(billing, sessions[4], 'plan.changed').map((m) => m.price), [2900]);
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: events sent while a migration runs are applied once, on the version that takes them`, async () => {
    const { billing } = setup(datamodel);
    try {
      const ada = billing.subscribe('ada');
      await billing.settle();
      billing.deploy(2);
      const migration = billing.migrate({ chart: 'subscription' });
      billing.changePlan('ada', 'pro', 2900);
      billing.changePlan('ada', 'team', 9900);
      await billing.settle();
      assert.equal(migration.result.migrated, 1);
      assert.deepEqual(of(billing, ada, 'plan.changed').map((m) => m.plan), ['pro', 'team']);
      assert.equal((await variables(billing, ada)).price, 9900);
      await billing.advance(30 * DAY);
      assert.deepEqual(of(billing, ada, 'invoice.paid').map((m) => [m.amount, m.version]), [[9900, 2]]);
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: a pause is release 2's: refused on release 1, and it stops the renewals`, async () => {
    const { clock, billing } = setup(datamodel);
    try {
      const ada = billing.subscribe('ada');
      await billing.settle();
      assert.equal(await billing.pause('ada'), false);
      billing.deploy(2);
      await finish(billing, billing.migrate());
      assert.equal(await billing.pause('ada'), true);
      await billing.settle();
      assert.deepEqual(await state(billing, ada), { subscription: 'paused' });
      await billing.advance(90 * DAY);
      assert.deepEqual(of(billing, ada, 'invoice.paid'), [], 'release 1\'s renewal was cancelled by the pause');
      billing.resume('ada');
      const resumed = clock.now;
      await billing.advance(30 * DAY);
      assert.deepEqual(of(billing, ada, 'invoice.paid').map((m) => [m.invoice, m.version]), [[1, 2]]);
      assert.equal(clock.now - resumed, 30 * DAY);
    } finally {
      billing.close();
    }
  });

  test(`${datamodel}: the rollout of main.mjs: four months of business, release 2 on day 45, nothing left behind`, async () => {
    const result = await run({ customers: 60, trials: 12, maxResident: 15, datamodel });
    try {
      assert.deepEqual(result.problems, []);
      const { report } = result;
      assert.equal(report.canary.release, 2);
      assert.equal(report.aborted, undefined);
      assert.deepEqual(report.migrations.map((m) => m.chart), ['subscription', 'trial']);
      for (const migration of report.migrations) assert.equal(migration.moved, migration.result.migrated);
      assert.ok(result.v2Invoices > 0);
      assert.equal(result.after.retired, 1);
      assert.ok(result.counts.wokenForMigrations > 0, 'hibernated actors were woken for the rollout');
    } finally {
      result.close();
    }
  });
}

test('a rollout refuses a chart the host does not have, before it migrates anything', async () => {
  const { billing } = setup('native');
  try {
    const ada = billing.subscribe('ada');
    await billing.settle();
    await assert.rejects(rollout(billing, { release: 2, charts: ['subscriptions'], stepMs: 1000 }), { status: 'TA_ERROR_INVALID' });
    assert.equal(billing.migrations.size, 0);
    // host.migrate itself refuses the name too
    assert.throws(() => billing.migrate({ chart: 'subscriptions' }), { status: 'TA_ERROR_INVALID' });
    assert.equal(await billing.releaseOf(ada), 1);
  } finally {
    billing.close();
  }
});

test('native: a canary that cannot move stops the rollout before the charts', async () => {
  const { billing } = setup('native');
  try {
    billing.subscribe('ada');
    const bob = billing.subscribe('bob');
    await billing.applyCoupon('ada', 1);
    await billing.settle();
    const lines = [];
    const report = await rollout(billing, { release: 2, charts: ['subscription'], canary: 'sub-ada', stepMs: 1000, log: (line) => lines.push(line) });
    assert.equal(report.aborted, 'the canary sub-ada did not move');
    assert.deepEqual(report.canary.result.failed, 1);
    assert.deepEqual(report.migrations, []);
    assert.equal(await billing.releaseOf(bob), 1);
    assert.match(lines.at(-1), /stopped/);
  } finally {
    billing.close();
  }
});
