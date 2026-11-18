// The demo: the warehouse in a process of its own (warehouse-main.mjs),
// the storefront in this one, on the real clock, over a TCP connection.
// Customers race for the last lamp, cancel, let a hold expire; the
// warehouse goes down in the middle of a checkout and comes back from its
// snapshot; one customer's messages are all delivered twice. At the end
// the warehouse's inventory is checked against the orders placed.
//
//   node examples/inventory-sync/main.mjs [--out <dir>] [--quiet]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { Storefront } from './storefront.mjs';

const CATALOG = { tea: 10, cups: 4, lamp: 1 };
const HOLD_FOR_MS = 1000;
const HERE = new URL('.', import.meta.url);

/** Starts the warehouse process; resolves once it listens, with its port. */
async function startWarehouse(snapshot, say) {
  const child = spawn(process.execPath, [new URL('warehouse-main.mjs', HERE).pathname,
    '--snapshot', snapshot, '--catalog', JSON.stringify(CATALOG), '--hold-for', `${HOLD_FOR_MS}ms`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const records = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const record = JSON.parse(line);
    if (record.log) say(`  warehouse  ${record.log}`);
    if (record.report) {
      const { event, sku, reservation, qty, stock } = record.report;
      say(`  warehouse  ${event} ${qty ?? ''} ${sku}${reservation ? ` (${reservation})` : ''}, ${stock} left`);
    }
    records.push(record);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const next = (key) => new Promise((resolve, reject) => {
    const look = () => {
      const found = records.find((record) => record[key] !== undefined);
      if (found) return resolve(found);
      if (child.exitCode !== null) return reject(new Error(`the warehouse exited (${child.exitCode})`));
      waiters.push(look);
    };
    child.once('exit', () => waiters.length && look());
    look();
  });
  const { port, restored } = await next('port');
  return {
    port,
    restored,
    /** Asks it to go down; resolves with the inventory it had. */
    async stop() {
      child.kill('SIGTERM');
      const { stopped } = await next('stopped');
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
      return stopped;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run({ out = mkdtempSync(join(tmpdir(), 'inventory-sync-')), say = console.log } = {}) {
  const snapshot = join(out, 'warehouse.snapshot');
  let warehouse = await startWarehouse(snapshot, say);
  let crash; // set while the warehouse should go down at carol's second confirm
  const shop = new Storefront({
    timing: { replyTimeout: '1s', backoff: '300ms', maxAttempts: 3 },
    fault: (method, params) => {
      const reservation = params.data?.reservation ?? '';
      if (crash && params.event === 'confirm' && reservation.startsWith('carol/cups/')) {
        crash();
        crash = undefined;
        say('  wire       the warehouse goes down as carol\'s confirm of the cups is sent');
        return 'disconnect';
      }
      return reservation.startsWith('dave/') ? 'duplicate' : 'send';
    },
  });
  const show = (message) => {
    const { event, cart, ...rest } = message;
    say(`  storefront ${cart} ${event} ${JSON.stringify(rest)}`);
  };
  let shown = 0;
  const flush = () => { for (; shown < shop.outbox.length; shown++) show(shop.outbox[shown]); };
  const pause = async (ms) => { await sleep(ms); flush(); };
  await shop.connect(warehouse.port);

  say('1. ann and bob race for the last lamp');
  shop.open('ann');
  shop.open('bob');
  shop.add('ann', 'lamp', 1);
  shop.add('bob', 'lamp', 1);
  await pause(100);
  say('   ann cancels; bob tries again and checks out');
  shop.cancel('ann');
  await pause(100);
  shop.add('bob', 'lamp', 1);
  await pause(100);
  shop.checkout('bob');
  await shop.ending('bob');
  await pause(50);

  say(`2. erin holds tea and walks away: the hold expires after ${HOLD_FOR_MS} ms`);
  shop.open('erin');
  shop.add('erin', 'tea', 3);
  await shop.next((message) => message.cart === 'erin' && message.event === 'line.expired');
  await pause(50);

  say('3. carol checks out tea and cups; the warehouse goes down in the middle');
  const down = new Promise((resolve) => { crash = resolve; });
  shop.open('carol');
  shop.add('carol', 'tea', 2);
  shop.add('carol', 'cups', 1);
  await pause(100);
  shop.checkout('carol');
  await down;
  const before = await warehouse.stop();
  say(`   the warehouse is down (it held ${JSON.stringify(before)}); carol keeps trying to release`);
  await pause(700);
  warehouse = await startWarehouse(snapshot, say);
  say(`   the warehouse is back, restored from its snapshot: ${warehouse.restored}`);
  await shop.connect(warehouse.port);
  await shop.ending('carol');
  await pause(50);

  say('4. every message of dave\'s is delivered twice');
  shop.open('dave');
  shop.add('dave', 'tea', 1);
  shop.add('dave', 'cups', 2);
  await pause(100);
  shop.checkout('dave');
  await shop.ending('dave');
  await pause(50);

  const inventory = await warehouse.stop();
  shop.close();
  const placed = shop.outbox.filter((message) => message.event === 'order.placed');
  const sold = {};
  for (const { lines } of placed) for (const { sku, qty } of lines) sold[sku] = (sold[sku] ?? 0) + qty;
  const problems = [];
  for (const [sku, units] of Object.entries(CATALOG)) {
    const level = inventory[sku];
    if (level.held !== 0) problems.push(`${sku}: ${level.held} still held`);
    if (level.sold !== (sold[sku] ?? 0)) problems.push(`${sku}: ${level.sold} sold, the orders placed ${sold[sku] ?? 0}`);
    if (level.stock + level.sold !== units) problems.push(`${sku}: ${level.stock} + ${level.sold} is not ${units}`);
  }
  say(`orders: ${shop.outbox.filter((message) => message.event.startsWith('order.')).map((message) => `${message.cart} ${message.event.slice(6)}`).join(', ')}`);
  say(`inventory: ${JSON.stringify(inventory)}`);
  say(problems.length === 0 ? 'every unit is accounted for' : `MISMATCH: ${problems.join('; ')}`);
  return { outbox: shop.outbox, inventory, problems };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, quiet: { type: 'boolean' } } });
  const { problems } = await run({ out: values.out, say: values.quiet ? () => {} : console.log });
  process.exitCode = problems.length === 0 ? 0 : 1;
}
