// A day at the shop, on the real clock, in about a second: orders placed at
// once, a payment gateway that is slow, flaky and sometimes loses its
// answers, a warehouse with limited stock, and customers who cancel at
// random moments. At the end every order has ended, and the gateway's
// ledger is reconciled against the outcomes: a delivered order was charged
// its total exactly once, any other order nothing.
//
//   node examples/order-fulfillment/main.mjs [--orders N] [--seed S] [--out DIR]
//
// The customer notifications are written to DIR/outbox.jsonl (default: a
// new temporary directory).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Shop } from './shop.mjs';
import { PaymentGateway, Warehouse } from './world.mjs';

/** A small seeded generator (mulberry32), so a run can be repeated. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CATALOGUE = [
  { sku: 'tea', price: 4 }, { sku: 'mug', price: 9 }, { sku: 'kettle', price: 35 }, { sku: 'honey', price: 7 },
];

/** Runs `orders` orders and answers what happened. */
export async function run({ orders = 40, seed = 1, out } = {}) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const gateway = new PaymentGateway({
    // 65 % captured, 10 % never answered, 10 % captured but the answer is
    // lost, 10 % a gateway error, 5 % declined; 10 to 60 ms each
    respond: async () => {
      const roll = next();
      await sleep(10 + next() * 50);
      if (roll < 0.65) return 'captured';
      if (roll < 0.75) return new Promise(() => {});
      if (roll < 0.85) return { result: 'captured', lost: true };
      if (roll < 0.95) return 'error';
      return 'declined';
    },
    // one refund in five fails at first
    refundRespond: async () => {
      await sleep(5);
      if (next() < 0.2) throw new Error('refund service unavailable');
    },
  });
  const warehouse = new Warehouse({
    stock: { tea: 40, mug: 30, kettle: 6, honey: 30 },
    respond: ({ step }) => sleep(step === 'pick' ? 20 + next() * 60 : 30 + next() * 30),
  });
  const shop = new Shop({
    gateway, warehouse,
    timing: { paymentTimeoutMs: 150, backoffMs: 20, refundRetryMs: 50, maxAttempts: 3 },
  });

  const placed = [];
  for (let n = 1; n <= orders; n++) {
    const items = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({ ...pick(CATALOGUE), qty: 1 + Math.floor(next() * 2) }));
    const order = { id: `A-${String(n).padStart(3, '0')}`, items, address: `${n} Main Street` };
    shop.place(order);
    placed.push({ ...order, total: items.reduce((sum, item) => sum + item.price * item.qty, 0) });
  }
  // a fifth of the customers change their minds, at any moment
  const cancels = [];
  for (const order of placed) {
    if (next() < 0.2) cancels.push(sleep(next() * 400).then(() => ({ id: order.id, answer: shop.cancel(order.id) })));
  }

  const endings = await Promise.all(placed.map((order) => shop.ending(order.id)));
  const cancelAnswers = await Promise.all(cancels);
  shop.close();

  const results = placed.map((order, i) => ({ ...order, ending: endings[i], net: gateway.net(order.id) }));
  const wrong = results.filter((r) => r.net !== (r.ending.event === 'order.delivered' ? r.total : 0));
  const dir = out ?? mkdtempSync(join(tmpdir(), 'order-fulfillment-'));
  writeFileSync(join(dir, 'outbox.jsonl'), shop.outbox.map((message) => JSON.stringify(message)).join('\n') + '\n');
  return { results, wrong, cancelAnswers, gateway, warehouse, outbox: shop.outbox, logs: shop.logs, dir };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { orders: { type: 'string', default: '40' }, seed: { type: 'string', default: '1' }, out: { type: 'string' } } });
  const started = Date.now();
  const { results, wrong, cancelAnswers, gateway, logs, dir } = await run({ orders: Number(values.orders), seed: Number(values.seed), out: values.out });
  for (const r of results) {
    const { event, reason, refunded, trackingID } = r.ending;
    const detail = event === 'order.delivered' ? trackingID : `${reason}${refunded ? `, refunded ${refunded}` : ''}`;
    console.log(`${r.id}  total ${String(r.total).padStart(3)}  charged ${String(r.net).padStart(3)}  ${event.slice(6).padEnd(9)} ${detail}`);
  }
  const count = (event) => results.filter((r) => r.ending.event === event).length;
  console.log(`\n${results.length} orders in ${Date.now() - started} ms: ${count('order.delivered')} delivered, ` +
    `${count('order.cancelled')} cancelled, ${count('order.failed')} failed`);
  console.log(`${gateway.calls.length} charge calls, ${logs.filter((l) => l.includes('attempt')).length} payment retries, ` +
    `${logs.filter((l) => l.includes('refund failed')).length} refund retries, ` +
    `${cancelAnswers.filter((c) => c.answer === 'unknown').length} of ${cancelAnswers.length} cancels too late (the order had ended)`);
  console.log(`ledger: ${wrong.length === 0 ? 'every order charged exactly what it shipped' : `${wrong.length} orders WRONG`}`);
  console.log(`outbox: ${join(dir, 'outbox.jsonl')}`);
  process.exitCode = wrong.length === 0 ? 0 : 1;
}
