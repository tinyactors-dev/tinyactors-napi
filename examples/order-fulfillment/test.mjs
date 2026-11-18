// The order chart's tricky cases, each on a SimulatedClock with a gateway
// and a warehouse the test drives one call at a time, on both datamodels;
// then the demo of main.mjs on the real clock. Run by `mise run examples`
// (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimulatedClock } from '@tinyactors/node';
import { run } from './main.mjs';
import { Shop } from './shop.mjs';
import { PaymentGateway, Warehouse } from './world.mjs';

/** A `respond` function whose calls wait until the test answers them. */
function held() {
  const calls = [];
  const respond = (call) => new Promise((resolve, reject) => calls.push({ ...call, resolve, reject }));
  return { calls, respond };
}

const TEA = [{ sku: 'tea', qty: 2, price: 4 }]; // a total of 8

/** A shop on a simulated clock; `payments` and `warehouse` default to
 * answering at once. */
function setup(datamodel, { payments, refunds, warehouse, stock = { tea: 10 } } = {}) {
  const clock = new SimulatedClock();
  const gateway = new PaymentGateway({ respond: payments, refundRespond: refunds });
  const store = new Warehouse({ stock, respond: warehouse });
  const shop = new Shop({ clock, datamodel, gateway, warehouse: store });
  return { clock, gateway, warehouse: store, shop };
}

/** Lets the host and the services' promises settle: a service answers
 * from a promise it starts and does not return to the host (it returns the
 * service at once, so that a cancel reaches it), which `idle()` cannot
 * wait for. */
async function settle(shop) {
  for (let round = 0; round < 4; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    await shop.host.idle();
  }
}

/** Moves the clock `ms` forward, deadline by deadline, settling at each. */
async function advance(clock, shop, ms) {
  const end = clock.now + ms;
  while (shop.host.nextDeadline !== undefined && clock.now + shop.host.nextDeadline <= end) {
    clock.increment(shop.host.nextDeadline);
    await settle(shop);
  }
  if (clock.now < end) clock.increment(end - clock.now);
  await settle(shop);
}

const events = (shop) => shop.outbox.map((message) => message.event);

/** The state the order's actor is in. */
async function state(shop, id) {
  const { value } = await shop.host.actorState({ session: shop.host.actorByName(id) });
  return JSON.stringify(value);
}

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: an order is paid, shipped and delivered, and charged once`, async () => {
    const { shop, gateway, warehouse } = setup(datamodel);
    try {
      shop.place({ id: 'A', items: TEA, address: '1 Main Street' });
      await settle(shop);
      assert.deepEqual(events(shop), ['order.paid', 'order.shipped', 'order.delivered']);
      assert.deepEqual(await shop.ending('A'), { event: 'order.delivered', order: 'A', trackingID: 'TRK-0001' });
      assert.equal(gateway.net('A'), 8);
      assert.equal(warehouse.stock.tea, 8);
      assert.equal(shop.host.actorByName('A'), undefined, 'a final state ends the actor');
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: a payment that does not answer in time is retried after a backoff; its late answer charges nothing more`, async () => {
    const payments = held();
    const { shop, gateway, clock } = setup(datamodel, { payments: payments.respond });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      assert.equal(payments.calls.length, 1);
      assert.equal(await state(shop, 'A'), '{"payment":"charging"}');

      await advance(clock, shop, 9_999);
      assert.equal(payments.calls.length, 1, 'no retry before the timeout');
      await advance(clock, shop, 1);
      assert.deepEqual(shop.logs, ['A: attempt 1 payment.timeout']);
      assert.equal(await state(shop, 'A'), '{"payment":"backoff"}');

      await advance(clock, shop, 1_000);
      assert.equal(payments.calls.length, 2, 'the retry, after a backoff of 1 s');
      assert.equal(payments.calls[1].key, 'A', 'under the same idempotency key');
      payments.calls[1].resolve('captured');
      await settle(shop);
      assert.deepEqual(shop.outbox[0], { event: 'order.paid', order: 'A', amount: 8, attempts: 2 });

      payments.calls[0].resolve('captured'); // the first attempt's answer, too late
      await settle(shop);
      assert.equal(gateway.net('A'), 8);
      assert.deepEqual(events(shop), ['order.paid', 'order.shipped', 'order.delivered']);
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: a charge whose answer is lost is found again by the retry, not charged twice`, async () => {
    const payments = held();
    const { shop, gateway, clock } = setup(datamodel, { payments: payments.respond });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      payments.calls[0].resolve({ result: 'captured', lost: true });
      await settle(shop);
      assert.equal(gateway.net('A'), 8, 'the gateway charged');
      assert.deepEqual(events(shop), [], 'but the order never heard');

      await advance(clock, shop, 11_000); // the timeout, then the backoff
      assert.equal(payments.calls.length, 1, 'the retry was answered from the idempotency key');
      assert.deepEqual(events(shop), ['order.paid', 'order.shipped', 'order.delivered']);
      assert.equal(gateway.net('A'), 8);
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: three attempts without an answer fail the order, after backoffs of 1 s and 2 s`, async () => {
    const payments = held();
    const { shop, gateway, clock } = setup(datamodel, { payments: payments.respond });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      await advance(clock, shop, 32_999);
      assert.equal(payments.calls.length, 3);
      assert.equal(await state(shop, 'A'), '{"payment":"charging"}');
      await advance(clock, shop, 1);
      assert.deepEqual(shop.logs, ['A: attempt 1 payment.timeout', 'A: attempt 2 payment.timeout']);
      assert.deepEqual(await shop.ending('A'), { event: 'order.failed', order: 'A', reason: 'no payment after 3 attempts', refunded: 0 });
      assert.deepEqual(gateway.refunds, [{ key: 'A' }], 'an attempt may have charged: refunded anyway');

      payments.calls[2].resolve('captured'); // the gateway gets there at last
      await settle(shop);
      assert.equal(gateway.net('A'), 0, 'the refund voided it');
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: a gateway error is retried like a timeout; a decline is not`, async () => {
    const answers = ['error', 'declined'];
    const { shop, gateway, clock } = setup(datamodel, { payments: () => answers.shift() });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      assert.deepEqual(shop.logs, ['A: attempt 1 payment.error']);
      await advance(clock, shop, 1_000);
      assert.deepEqual(await shop.ending('A'), { event: 'order.failed', order: 'A', reason: 'payment declined: insufficient funds', refunded: 0 });
      assert.equal(gateway.calls.length, 2);
      assert.deepEqual(gateway.refunds, [], 'nothing was charged: nothing to refund');
      assert.equal(shop.host.nextDeadline, undefined, 'no timer is left');
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: a cancel during the payment refunds what may be in flight, and a late capture is voided`, async () => {
    const payments = held();
    const { shop, gateway } = setup(datamodel, { payments: payments.respond });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      assert.equal(shop.cancel('A'), 'requested');
      await settle(shop);
      assert.deepEqual(await shop.ending('A'), {
        event: 'order.cancelled', order: 'A', reason: 'cancelled by the customer during payment', refunded: 0,
      });
      assert.equal(shop.host.nextDeadline, undefined, 'the payment timeout was cancelled with the attempt');

      payments.calls[0].resolve('captured');
      await settle(shop);
      assert.equal(gateway.net('A'), 0);
      assert.deepEqual(events(shop), ['order.cancelled']);
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: a cancel before the hand-over releases the stock and refunds the charge`, async () => {
    const steps = held();
    const { shop, gateway, warehouse } = setup(datamodel, { warehouse: steps.respond });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      assert.equal(await state(shop, 'A'), '{"fulfilment":"picking"}');
      assert.equal(warehouse.stock.tea, 8, 'reserved');

      assert.equal(shop.cancel('A'), 'requested');
      await settle(shop);
      assert.deepEqual(await shop.ending('A'), {
        event: 'order.cancelled', order: 'A', reason: 'cancelled by the customer before shipping', refunded: 8,
      });
      assert.equal(warehouse.stock.tea, 10, 'released');

      steps.calls[0].resolve(); // the pick finishes, for an order that is gone
      await settle(shop);
      assert.equal(warehouse.shipments.get('A').state, 'released', 'nothing was handed over');
      assert.equal(gateway.net('A'), 0);
      assert.deepEqual(events(shop), ['order.paid', 'order.cancelled']);
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: a cancel that loses the race with the hand-over is refused, and the order ships`, async () => {
    const steps = held();
    const { shop, gateway } = setup(datamodel, { warehouse: steps.respond });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      // both in the same tick: the cancel reaches the chart first, the
      // hand-over reaches the warehouse first
      assert.equal(shop.cancel('A'), 'requested');
      steps.calls[0].resolve();
      await settle(shop);
      assert.equal(await state(shop, 'A'), '{"fulfilment":"handedOver"}');
      assert.deepEqual(shop.outbox.slice(1), [
        { event: 'order.cancelRefused', order: 'A', reason: 'the parcel was handed to the carrier first' },
        { event: 'order.shipped', order: 'A', trackingID: 'TRK-0001' },
      ]);

      assert.equal(shop.cancel('A'), 'requested'); // once more, with the carrier
      await settle(shop);
      assert.deepEqual(shop.outbox.at(-1), { event: 'order.cancelRefused', order: 'A', reason: 'the parcel is with the carrier' });

      steps.calls[1].resolve(); // delivered
      await settle(shop);
      assert.equal((await shop.ending('A')).event, 'order.delivered');
      assert.equal(gateway.net('A'), 8);
      assert.equal(shop.cancel('A'), 'unknown', 'the order has ended');
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: out of stock after the payment refunds, retrying a refund that fails`, async () => {
    let refundCalls = 0;
    const refunds = () => { if (refundCalls++ === 0) throw new Error('refund service unavailable'); };
    const { shop, gateway, clock } = setup(datamodel, { refunds, stock: { tea: 1 } });
    try {
      shop.place({ id: 'A', items: TEA });
      await settle(shop);
      assert.deepEqual(shop.logs, ['A: refund failed, retrying']);
      assert.equal(gateway.net('A'), 8, 'not refunded yet');
      await advance(clock, shop, 5_000);
      assert.deepEqual(await shop.ending('A'), { event: 'order.failed', order: 'A', reason: 'out of stock: tea', refunded: 8 });
      assert.equal(gateway.net('A'), 0);
      assert.equal(refundCalls, 2);
    } finally {
      shop.close();
    }
  });

  test(`${datamodel}: an order without items fails before any payment`, async () => {
    const { shop, gateway } = setup(datamodel);
    try {
      shop.place({ id: 'A', items: [] });
      await settle(shop);
      assert.deepEqual(await shop.ending('A'), { event: 'order.failed', order: 'A', reason: 'the order has no items', refunded: 0 });
      assert.equal(gateway.calls.length, 0);
      assert.equal(shop.cancel('B'), 'unknown');
    } finally {
      shop.close();
    }
  });
}

test('the demo on the real clock: every order ends, and the ledger reconciles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'order-fulfillment-test-'));
  try {
    const { results, wrong, outbox } = await run({ orders: 30, seed: 3, out: dir });
    assert.equal(results.length, 30);
    assert.deepEqual(wrong, []);
    const kinds = new Set(results.map((r) => r.ending.event));
    assert.ok(kinds.has('order.delivered') && kinds.has('order.failed'), [...kinds].join());
    const written = readFileSync(join(dir, 'outbox.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(written, outbox);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
