// The two systems' tricky cases, each with a warehouse host and a
// storefront host in this process, talking over a real TCP connection on a
// port the system picks, on one SimulatedClock, on both datamodels. Run by
// `mise run examples` (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimulatedClock } from '@tinyactors/node';
import { Storefront } from './storefront.mjs';
import { Warehouse } from './warehouse.mjs';

const CATALOG = { tea: 10, cups: 4, lamp: 1 };

/** A warehouse and a storefront, connected, on one simulated clock. */
async function world(datamodel, { catalog = CATALOG, holdFor = '900s', timing = {}, shopFault, warehouseFault } = {}) {
  const clock = new SimulatedClock();
  const warehouse = new Warehouse({ catalog, holdFor, clock, datamodel, fault: warehouseFault });
  const shop = new Storefront({ clock, datamodel, timing: { replyTimeout: '5s', backoff: '2s', ...timing }, fault: shopFault });
  await shop.connect(await warehouse.listen());
  const w = { clock, warehouse, shop, datamodel };
  await settle(w);
  return w;
}

/** Lets both hosts and the connection settle: each host idle, and every
 * frame written on the connection read on the other side, three rounds in
 * a row. `idle()` waits for one host, not for the bytes between two. */
async function settle({ warehouse, shop }) {
  const start = performance.now();
  for (let quiet = 0; quiet < 3;) {
    if (performance.now() - start > 5_000) throw new Error(`the systems never settled: ${JSON.stringify({ shop: [shop.link.sent, shop.link.received, shop.link.connected], warehouse: [warehouse.link.sent, warehouse.link.received, warehouse.link.connected], outbox: shop.outbox.length, ledger: warehouse.ledger.length })}`);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([warehouse, shop].filter((side) => !side.host.closed).map((side) => side.host.idle()));
    const linked = shop.link.connected && warehouse.link.connected;
    const balanced = !linked || (shop.link.sent === warehouse.link.received && warehouse.link.sent === shop.link.received);
    quiet = balanced ? quiet + 1 : 0;
  }
}

/** Moves the clock `ms` forward, deadline by deadline of either host,
 * settling at each. */
async function advance(w, ms) {
  await settle(w); // what was asked before runs at the time it was asked
  const end = w.clock.now + ms;
  for (;;) {
    const deadlines = [w.warehouse, w.shop].filter((side) => !side.host.closed).map((side) => side.host.nextDeadline).filter((d) => d !== undefined);
    const next = Math.min(...deadlines);
    if (!Number.isFinite(next) || w.clock.now + next > end) break;
    w.clock.increment(Math.max(next, 1));
    await settle(w);
  }
  if (w.clock.now < end) w.clock.increment(end - w.clock.now);
  await settle(w);
}

const events = (shop, cart) => shop.of(cart).map((message) => message.event);

/** The SKUs' levels, every unit accounted for: stock + held + sold is the
 * catalog's. */
async function inventory(warehouse, catalog = CATALOG) {
  const levels = await warehouse.inventory();
  for (const [sku, units] of Object.entries(catalog)) {
    const { stock, held, sold } = levels[sku];
    assert.equal(stock + held + sold, units, `${sku}: ${JSON.stringify(levels[sku])}`);
  }
  return levels;
}

function close(w) {
  w.shop.close();
  w.warehouse.close();
}

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: a cart reserves, checks out and confirms each line`, async () => {
    const w = await world(datamodel);
    try {
      w.shop.open('ann');
      w.shop.add('ann', 'tea', 2);
      w.shop.add('ann', 'cups', 1);
      await settle(w);
      assert.deepEqual(events(w.shop, 'ann'), ['line.reserved', 'line.reserved']);
      assert.deepEqual((await inventory(w.warehouse)).tea, { stock: 8, held: 2, sold: 0 });

      w.shop.checkout('ann');
      await settle(w);
      assert.deepEqual(await w.shop.ending('ann'), {
        event: 'order.placed', cart: 'ann', attempt: 1, lines: [{ sku: 'tea', qty: 2 }, { sku: 'cups', qty: 1 }],
      });
      const levels = await inventory(w.warehouse);
      assert.deepEqual(levels.tea, { stock: 8, held: 0, sold: 2 });
      assert.deepEqual(levels.cups, { stock: 3, held: 0, sold: 1 });
      assert.equal(w.shop.host.actorByName('ann'), undefined, 'the cart ended with its order');
      assert.equal(w.shop.host.nextDeadline, undefined, 'no timer is left');
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: two carts race for the last unit; one gets it, and a cancel gives it to the other`, async () => {
    const w = await world(datamodel);
    try {
      w.shop.open('ann');
      w.shop.open('bob');
      w.shop.add('ann', 'lamp', 1); // the same turn, the same SKU actor: one wins
      w.shop.add('bob', 'lamp', 1);
      await settle(w);
      assert.deepEqual(events(w.shop, 'ann'), ['line.reserved']);
      assert.deepEqual(w.shop.of('bob'), [{ event: 'line.refused', cart: 'bob', sku: 'lamp', reason: 'out of stock', available: 0 }]);

      w.shop.cancel('ann');
      await settle(w);
      assert.equal((await w.shop.ending('ann')).event, 'order.cancelled');
      assert.deepEqual((await inventory(w.warehouse)).lamp, { stock: 1, held: 0, sold: 0 });

      w.shop.add('bob', 'lamp', 1);
      w.shop.checkout('bob');
      await settle(w);
      // the checkout came before the reservation was answered: refused, the line goes on
      assert.deepEqual(events(w.shop, 'bob').slice(1), ['checkout.refused', 'line.reserved']);
      w.shop.checkout('bob');
      await settle(w);
      assert.equal((await w.shop.ending('bob')).event, 'order.placed');
      assert.deepEqual((await inventory(w.warehouse)).lamp, { stock: 0, held: 0, sold: 1 });
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: a hold expires through the warehouse's delayed send, and the cart drops the line`, async () => {
    const w = await world(datamodel, { holdFor: '60s' });
    try {
      w.shop.open('ann');
      w.shop.add('ann', 'tea', 3);
      await advance(w, 59_000);
      assert.deepEqual((await inventory(w.warehouse)).tea, { stock: 7, held: 3, sold: 0 });
      await advance(w, 2_000);
      assert.deepEqual(events(w.shop, 'ann'), ['line.reserved', 'line.expired']);
      assert.deepEqual((await inventory(w.warehouse)).tea, { stock: 10, held: 0, sold: 0 });
      assert.deepEqual(w.warehouse.ledger.map((entry) => entry.event), ['held', 'expired']);
      w.shop.checkout('ann');
      await settle(w);
      assert.equal(w.shop.of('ann').at(-1).reason, 'the cart is empty');
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: a lost expiry notice: the confirm is refused, the other lines released, the order failed`, async () => {
    const w = await world(datamodel, {
      holdFor: '60s',
      warehouseFault: (method, params) => (params.event === 'expired' ? 'drop' : 'send'),
    });
    try {
      w.shop.open('ann');
      w.shop.add('ann', 'tea', 2);
      await advance(w, 30_000);
      w.shop.add('ann', 'cups', 2);
      await advance(w, 31_000); // tea's hold expired at 60 s; the cart was never told
      assert.deepEqual(events(w.shop, 'ann'), ['line.reserved', 'line.reserved']);

      w.shop.checkout('ann');
      await settle(w);
      const ending = await w.shop.ending('ann');
      assert.deepEqual(ending, { event: 'order.failed', cart: 'ann', reason: 'reservation expired: tea', attempt: 1 });
      const levels = await inventory(w.warehouse);
      assert.deepEqual(levels.tea, { stock: 10, held: 0, sold: 0 });
      assert.deepEqual(levels.cups, { stock: 4, held: 0, sold: 0 }, 'compensation released the cups');
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: the warehouse goes down mid-checkout: error.communication, compensation, and a retry once it is back`, async () => {
    let down = false;
    const w = await world(datamodel, {
      // the second confirm finds the connection gone
      shopFault: (method, params) => (params.event === 'confirm' && params.data.reservation.includes('/cups/') && !down ? (down = true, 'disconnect') : 'send'),
    });
    try {
      w.shop.open('ann');
      w.shop.add('ann', 'tea', 2);
      w.shop.add('ann', 'cups', 1);
      await settle(w);
      w.shop.checkout('ann');
      await settle(w);
      assert.deepEqual(events(w.shop, 'ann'), ['line.reserved', 'line.reserved', 'line.confirmed', 'compensating']);
      assert.equal(w.shop.of('ann').at(-1).reason, 'the warehouse cannot be reached');

      // the warehouse is down: it went down holding the sale of tea and the hold of cups
      const snapshot = await w.warehouse.stop();
      await advance(w, 10_000); // the cart retries its releases every 2 s, each failed at once
      assert.equal(events(w.shop, 'ann').at(-1), 'compensating');
      assert.ok(events(w.shop, 'ann').filter((event) => event === 'compensating').length >= 4);

      // it comes back, restored
      w.warehouse = new Warehouse({ snapshot, clock: w.clock, datamodel });
      await w.shop.connect(await w.warehouse.listen());
      await advance(w, 10_000);
      assert.deepEqual(await w.shop.ending('ann'), {
        event: 'order.placed', cart: 'ann', attempt: 2, lines: [{ sku: 'tea', qty: 2 }, { sku: 'cups', qty: 1 }],
      });
      assert.deepEqual(w.warehouse.ledger.map((entry) => `${entry.event} ${entry.sku}`),
        ['returned tea', 'released cups', 'held tea', 'held cups', 'sold tea', 'sold cups']);
      const levels = await inventory(w.warehouse);
      assert.deepEqual(levels.tea, { stock: 8, held: 0, sold: 2 });
      assert.deepEqual(levels.cups, { stock: 3, held: 0, sold: 1 });
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: with no attempts left, the order fails once everything it held is given back`, async () => {
    let down = false;
    const w = await world(datamodel, {
      timing: { maxAttempts: 1 },
      shopFault: (method, params) => (params.event === 'confirm' && !down ? (down = true, 'disconnect') : 'send'),
    });
    try {
      w.shop.open('ann');
      w.shop.add('ann', 'tea', 2);
      await settle(w);
      w.shop.checkout('ann');
      await settle(w);
      const snapshot = await w.warehouse.stop();
      await advance(w, 5_000);
      w.warehouse = new Warehouse({ snapshot, clock: w.clock, datamodel });
      await w.shop.connect(await w.warehouse.listen());
      await advance(w, 5_000);
      assert.deepEqual(await w.shop.ending('ann'), { event: 'order.failed', cart: 'ann', reason: 'the warehouse cannot be reached', attempt: 1 });
      assert.deepEqual((await inventory(w.warehouse)).tea, { stock: 10, held: 0, sold: 0 });
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: every message duplicated, both ways: each request counts once`, async () => {
    const duplicate = (method) => (method === 'message.send' ? 'duplicate' : 'send');
    const w = await world(datamodel, { shopFault: duplicate, warehouseFault: duplicate });
    try {
      w.shop.open('ann');
      w.shop.open('bob');
      w.shop.add('ann', 'tea', 2);
      w.shop.add('ann', 'cups', 1);
      w.shop.add('bob', 'lamp', 1);
      await settle(w);
      w.shop.checkout('ann');
      w.shop.cancel('bob');
      await settle(w);
      assert.equal((await w.shop.ending('ann')).event, 'order.placed');
      assert.equal((await w.shop.ending('bob')).event, 'order.cancelled');
      assert.equal(w.shop.outbox.filter((message) => message.event.startsWith('order.')).length, 2, 'one ending each');
      const levels = await inventory(w.warehouse);
      assert.deepEqual(levels.tea, { stock: 8, held: 0, sold: 2 });
      assert.deepEqual(levels.cups, { stock: 3, held: 0, sold: 1 });
      assert.deepEqual(levels.lamp, { stock: 1, held: 0, sold: 0 });
      assert.ok(w.warehouse.logs.some((line) => line.startsWith('duplicate: reserve')), w.warehouse.logs.join('\n'));
      assert.ok(w.warehouse.logs.some((line) => line.startsWith('duplicate: confirm')), w.warehouse.logs.join('\n'));
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: a reserve for a SKU the warehouse lacks is failed back over the wire`, async () => {
    const w = await world(datamodel);
    try {
      w.shop.open('ann');
      w.shop.add('ann', 'unicorn', 1);
      await settle(w);
      assert.deepEqual(w.shop.of('ann'), [{ event: 'line.failed', cart: 'ann', sku: 'unicorn', reason: 'not delivered to the warehouse' }]);
    } finally {
      close(w);
    }
  });

  test(`${datamodel}: a reservation answered after its line timed out is released`, async () => {
    let held = [];
    const w = await world(datamodel, {
      // the warehouse's answers to ann are held back, then let go late
      warehouseFault: (method, params) => (params.event === 'reserved' && held !== null ? (held.push(params), 'drop') : 'send'),
    });
    try {
      w.shop.open('ann');
      w.shop.add('ann', 'tea', 2);
      await advance(w, 6_000);
      assert.deepEqual(w.shop.of('ann'), [{ event: 'line.failed', cart: 'ann', sku: 'tea', reason: 'the warehouse did not answer' }]);
      assert.deepEqual((await inventory(w.warehouse)).tea, { stock: 10, held: 0, sold: 0 }, 'released on the timeout');
      // the late answer finds no line
      const late = held;
      held = null;
      for (const params of late) w.shop.host.send(params);
      await settle(w);
      assert.deepEqual((await inventory(w.warehouse)).tea, { stock: 10, held: 0, sold: 0 });
      assert.equal(w.shop.of('ann').length, 1);
    } finally {
      close(w);
    }
  });
}

test('the demo: the warehouse in a process of its own, killed and restored, every unit accounted for', () => {
  const out = mkdtempSync(join(tmpdir(), 'inventory-sync-test-'));
  try {
    const demo = spawnSync(process.execPath, [new URL('main.mjs', import.meta.url).pathname, '--out', out], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(demo.status, 0, demo.stdout + demo.stderr);
    assert.match(demo.stdout, /orders: ann cancelled, bob placed, carol placed, dave placed/);
    assert.match(demo.stdout, /restored from its snapshot: true/);
    assert.match(demo.stdout, /every unit is accounted for/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
