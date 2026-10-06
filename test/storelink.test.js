'use strict';
// Store links against the orb's PostgreSQL (mise run pg:start): a Node
// system and a database of actors exchange envelopes through SQL
// (tinyactors.deliver / claim_for / ack / deliver_error), with any client —
// here tools/pgwire.mjs. Skipped when PostgreSQL is not running.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMachine, createActor, createSystem, createLink, createStoreLink, serveLinks, assign, sendTo } = require('./binding');

const PORT = Number(process.env.TA_PG_PORT || 54320);
const DB = 'tinyactors_storelink';
const pgwire = () => import(path.join(__dirname, '../../../tools/pgwire.mjs'));

const until = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/* a fresh database with the extension, system id "vault" */
async function freshDatabase(pg) {
  const admin = await pg.connect({ port: PORT, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.query(`ALTER DATABASE ${DB} SET tinyactors.system_id = 'vault'`);
  await admin.end();
  const db = await pg.connect({ port: PORT, database: DB });
  await db.query('CREATE EXTENSION tinyactors');
  await db.query(`SELECT tinyactors.define('counter', $1)`, [
    `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" name="counter" initial="on">
       <datamodel><data id="n" expr="0"/><data id="lost" expr="0"/></datamodel>
       <state id="on">
         <transition event="add">
           <assign location="n" expr="n + _event.data.amount"/>
           <send event="total" targetexpr="_event.origin"><param name="n" expr="n"/><param name="tag" expr="_event.data.tag"/></send>
         </transition>
         <transition event="tell">
           <send event="note" targetexpr="_event.data.to"><param name="text" expr="_event.data.text"/></send>
         </transition>
         <transition event="error.communication"><assign location="lost" expr="lost + 1"/></transition>
       </state>
     </scxml>`,
  ]);
  await db.query(`SELECT tinyactors.spawn('counter', '{}', 'counter')`);
  return db;
}

/* counts totals and notes; error.communication too */
const client = createMachine({
  id: 'client',
  context: { totals: [], notes: [], errors: 0 },
  on: {
    ADD: { actions: sendTo(({ event }) => event.to, ({ event }) => ({ type: 'add', amount: event.amount, tag: event.tag })) },
    // from an SCXML document, <param>s arrive as event.data
    total: { actions: assign({ totals: ({ context, event }) => [...context.totals, [event.data.tag, event.data.n]] }) },
    note: { actions: assign({ notes: ({ context, event }) => [...context.notes, event.data.text] }) },
    'error.communication': { actions: assign({ errors: ({ context }) => context.errors + 1 }) },
  },
});

test('store link: envelopes in and out of PostgreSQL, errors both ways, relaying to a browser', async (t) => {
  const pg = await pgwire();
  if (!(await pg.available({ port: PORT }))) return t.skip('PostgreSQL is not running (mise run pg:start)');
  const db = await freshDatabase(pg);
  const q1 = await pg.connect({ port: PORT, database: DB });
  const q2 = await pg.connect({ port: PORT, database: DB });

  const web = createSystem({ id: 'web' });
  const store = createStoreLink(web, { query: q1.query, listen: q2.listen, pollMs: 0 });
  await store.ready;
  assert.equal(store.id, 'vault');
  const counter = web.ref('tinyactors://vault/@counter');

  // Node -> PostgreSQL actor -> reply back (via the outbox, claimed on NOTIFY)
  const c = createActor(client, { system: web }).start();
  c.send({ type: 'ADD', to: counter, amount: 5, tag: 'a' });
  c.send({ type: 'ADD', to: counter, amount: 2, tag: 'b' });
  await until(() => c.getSnapshot().context.totals.length === 2);
  assert.deepEqual(c.getSnapshot().context.totals, [['a', 5], ['b', 7]], 'in order, processed in PostgreSQL');
  const [row] = await db.query(`SELECT datamodel->>'n' AS n FROM tinyactors.actors WHERE name = 'counter'`);
  assert.equal(row.n, '7');

  // a repeated envelope (same msgid, e.g. a retry) is processed once
  const env = { target: 'tinyactors://vault/@counter', name: 'add', data: { amount: 100, tag: 'dup' }, origin: c.address, msgid: `${c.address}/retry-1` };
  web.deliver(env);
  web.deliver(env);
  await store.flush();
  await until(() => c.getSnapshot().context.totals.length === 3);
  const [row2] = await db.query(`SELECT datamodel->>'n' AS n FROM tinyactors.actors WHERE name = 'counter'`);
  assert.equal(row2.n, '107', 'the dedup window dropped the repeat');

  // a name the database does not have: error.communication in the Node sender
  c.send({ type: 'ADD', to: web.ref('tinyactors://vault/@nobody'), amount: 1, tag: 'x' });
  await until(() => c.getSnapshot().context.errors === 1);

  // the database sends to a Node session that does not exist: error.communication there
  await db.query(`SELECT tinyactors.send('counter', 'tell', '{"to": "tinyactors://web/#_scxml_987654", "text": "?"}')`);
  await until(async () => (await db.query(`SELECT datamodel->>'lost' AS l FROM tinyactors.actors WHERE name = 'counter'`))[0].l === '1');

  // browser -> (link) -> web -> (store link) -> PostgreSQL, and the reply straight back to the browser
  const served = serveLinks(web, { port: 0, exports: ['*'], announce: true });
  await until(() => served.port);
  const browser = createSystem({ id: 'tab-1' });
  const link = createLink(browser, { url: `ws://127.0.0.1:${served.port}/link`, name: 'web', pingMs: 0 });
  await until(() => link.getSnapshot().value === 'open');
  const b = createActor(client, { system: browser }).start();
  // web announced the browser to the database (tinyactors.hello), so its envelopes come to web
  await until(async () => (await db.query(`SELECT reach FROM tinyactors.peers WHERE id = 'web'`))[0]?.reach === '{tab-1}');
  // the browser asks a web actor; it forwards to the counter in PostgreSQL with the browser as origin
  const forward = createMachine({
    id: 'forward',
    on: { add: { actions: sendTo(() => counter, ({ event }) => ({ type: 'add', amount: event.amount, tag: event.tag })) } },
  });
  createActor(forward, { system: web, systemID: 'forward' }).start();
  // the database replies to the origin: the forwarder (web), so ask it to tell the browser instead
  await db.query(`SELECT tinyactors.send('counter', 'tell', $1::jsonb)`, [JSON.stringify({ to: b.address, text: 'hello from postgres' })]);
  await until(() => b.getSnapshot().context.notes.length === 1);
  assert.deepEqual(b.getSnapshot().context.notes, ['hello from postgres']);
  // and the full round trip: browser -> web (forward) -> PostgreSQL -> web (forward gets the total)
  b.send({ type: 'ADD', to: link.get('forward'), amount: 3, tag: 'via-web' });
  await until(async () => (await db.query(`SELECT datamodel->>'n' AS n FROM tinyactors.actors WHERE name = 'counter'`))[0].n === '110');

  const st = store.status();
  assert.equal(st.state, 'open');
  assert.equal(st.pending, 0);
  link.close();
  browser.stop();
  await served.close();
  await store.close();
  web.stop();
  await q1.end();
  await q2.end();
  await db.end();
});
