// The approval workflow's tricky cases on a SimulatedClock, on both
// datamodels: parallel reviews and the In() guard, changes requested and
// the history that returns each reviewer to where they were, an SLA breach
// paused and resumed through deep history, a failing archive, a withdrawal
// from deep inside the review; the admin view as functions and over HTTP;
// then the day of main.mjs on the real clock. Run by `mise run examples`
// (`node test.mjs`, `bun test ./test.mjs`).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SimulatedClock } from '@tinyactors/node';
import { describe, documentByID, documents, formatTable, leaves, serveAdmin } from './admin.mjs';
import { ApprovalDesk } from './desk.mjs';
import { run } from './main.mjs';
import { parseXML, readRecord } from './xml.mjs';

const HOUR = 3_600_000;
const SLA = { legal: 48 * HOUR, finance: 48 * HOUR, signoff: 24 * HOUR };

/** A desk on a simulated clock, writing to a new temporary directory. */
function setup(datamodel, options = {}) {
  const clock = new SimulatedClock();
  const dir = mkdtempSync(join(tmpdir(), 'document-approval-test-'));
  const desk = new ApprovalDesk({ dir, clock, datamodel, ...options });
  const close = () => { desk.close(); rmSync(dir, { recursive: true, force: true }); };
  return { clock, desk, dir, close };
}

/** The active atomic states of document `id`, joined: `'legalApproved financeReviewing'`. */
async function active(desk, id) {
  const doc = await documentByID(desk.host, id);
  return doc ? doc.active.join(' ') : 'ended';
}

const variables = async (desk, id) => (await documentByID(desk.host, id))?.variables;
const events = (desk) => desk.outbox.map((m) => m.event);

/** Sends each `[event, data]` to `id`, settling after each. */
async function steps(desk, id, ...list) {
  for (const [event, data] of list) {
    assert.equal(desk.act(id, event, data), 'sent', `${event} reaches ${id}`);
    await desk.settle();
  }
}

/** Moves the clock `ms` forward, settling after. */
async function advance(clock, desk, ms) {
  clock.increment(ms);
  await desk.settle();
}

const claimBoth = [['legal.claim', { reviewer: 'lee' }], ['finance.claim', { reviewer: 'fay' }]];

test('the XML reader reads the record, its entities and its errors', () => {
  const record = readRecord(`<?xml version="1.0"?>
<document id="D&amp;1" version="2"><title>A &lt;b&gt; &#233;&#x20AC;</title><!-- note -->
  <amount currency="EUR">10</amount><approval stage="legal" by="lee">ok</approval><escalation stage="finance" version="1"/>
</document>`);
  assert.deepEqual(record, {
    docID: 'D&1', version: 2, title: 'A <b> é€', author: '', amount: 10, currency: 'EUR',
    approvals: { legal: { by: 'lee', note: 'ok' } }, changes: [], escalations: [{ stage: 'finance', version: 1 }],
  });
  assert.throws(() => parseXML('<a><b></a>'), /mismatched/);
  assert.throws(() => parseXML('<a x="1" x="2"/>'), /attribute x twice/);
  assert.throws(() => parseXML('<a>&nope;</a>'), /unknown entity/);
  assert.throws(() => readRecord('<receipt/>'), /expected <document>/);
  assert.deepEqual(leaves({ a: { p: { r1: 'x', r2: { q: 'y' } } } }), ['x', 'y']);
});

for (const datamodel of ['native', 'quickjs']) {
  test(`${datamodel}: both reviews run at once; their done data reaches the chart; sign-off archives the metadata as XML`, async () => {
    const { desk, dir, close } = setup(datamodel);
    try {
      desk.file({ id: 'D1', title: 'Office lease & parking <2027>', author: 'ada', amount: 4000 });
      await desk.settle();
      assert.equal(await active(desk, 'D1'), 'legalQueued financeQueued');
      await steps(desk, 'D1', ...claimBoth, ['finance.approve', { note: 'within budget' }]);
      assert.equal(await active(desk, 'D1'), 'legalReviewing financeApproved', 'finance may approve first below the threshold');
      await steps(desk, 'D1', ['legal.approve', { note: 'standard terms' }]);
      assert.equal(await active(desk, 'D1'), 'signoff', 'both regions final: done.state.review');
      const { approvals } = await variables(desk, 'D1');
      assert.deepEqual(approvals, {
        legal: { by: 'lee', note: 'standard terms', version: 1 },
        finance: { by: 'fay', note: 'within budget', version: 1 },
      }, "each region's <donedata> is in done.state.<region>");

      await steps(desk, 'D1', ['signoff.approve', { by: 'dana' }]);
      assert.equal(await active(desk, 'D1'), 'ended');
      const ending = await desk.ending('D1');
      assert.deepEqual(ending, { event: 'document.approved', docID: 'D1', version: 1, receipt: 'ARC-0001' });
      assert.deepEqual(events(desk), ['review.started', 'signoff.requested', 'document.approved']);

      assert.equal(desk.archived.length, 1);
      assert.match(desk.archived[0], /<title>Office lease &amp; parking &lt;2027&gt;<\/title>/);
      assert.deepEqual(readdirSync(join(dir, 'archive')), ['D1-v1.xml']);
      const record = readRecord(readFileSync(join(dir, 'archive', 'D1-v1.xml'), 'utf8'));
      assert.equal(record.title, 'Office lease & parking <2027>');
      assert.deepEqual(record.approvals, {
        legal: { by: 'lee', note: 'standard terms' }, finance: { by: 'fay', note: 'within budget' }, signoff: { by: 'dana', note: '' },
      });
      assert.equal(desk.host.nextDeadline, undefined, 'every SLA timer was cancelled');
    } finally {
      close();
    }
  });

  test(`${datamodel}: a large amount: finance's approval before legal's is refused (In() guard), and accepted after`, async () => {
    const { desk, close } = setup(datamodel);
    try {
      desk.file({ id: 'BIG', title: 'Acquisition', author: 'bob', amount: 250000 });
      await desk.settle();
      await steps(desk, 'BIG', ...claimBoth, ['finance.approve', { note: 'early' }]);
      assert.equal(await active(desk, 'BIG'), 'legalReviewing financeReviewing');
      assert.deepEqual(desk.outbox.at(-1), {
        event: 'verdict.refused', docID: 'BIG', to: 'fay', reason: 'legal approves first at 10000 or more',
      });
      await steps(desk, 'BIG', ['legal.approve', {}], ['finance.approve', { note: 'now' }]);
      assert.equal(await active(desk, 'BIG'), 'signoff');
      assert.equal((await variables(desk, 'BIG')).approvals.finance.note, 'now');
    } finally {
      close();
    }
  });

  test(`${datamodel}: changes requested: a resubmission returns each reviewer to where they were (history)`, async () => {
    const { desk, close } = setup(datamodel);
    try {
      desk.file({ id: 'D2', title: 'Vendor contract', author: 'cy', amount: 3000 });
      await desk.settle();
      await steps(desk, 'D2', ...claimBoth, ['legal.approve', { note: 'fine' }], ['finance.changes', { note: 'split the invoice' }]);
      assert.equal(await active(desk, 'D2'), 'revising');
      assert.deepEqual(desk.outbox.at(-1), {
        event: 'changes.requested', docID: 'D2', to: 'cy',
        request: { stage: 'finance', by: 'fay', note: 'split the invoice', version: 1 },
      });
      // The review's regions are not active, so a verdict now matches
      // nothing and is dropped.
      await steps(desk, 'D2', ['finance.approve', {}]);
      assert.equal(await active(desk, 'D2'), 'revising');

      await steps(desk, 'D2', ['resubmit', { material: false }]);
      assert.equal(await active(desk, 'D2'), 'legalApproved financeReviewing', 'legal keeps its approval, finance its reviewer');
      const v = await variables(desk, 'D2');
      assert.equal(v.version, 2);
      assert.equal(v.financeReviewer, 'fay');
      assert.deepEqual(v.approvals.legal, { by: 'lee', note: 'fine', version: 1 }, 'the approval kept as first given');

      await steps(desk, 'D2', ['finance.approve', { note: 'ok now' }], ['signoff.approve', { by: 'dana' }]);
      const record = desk.records.get('D2');
      assert.equal(record.version, 2);
      assert.deepEqual(record.changes, [{ stage: 'finance', by: 'fay', version: 1, note: 'split the invoice' }]);
    } finally {
      close();
    }
  });

  test(`${datamodel}: a material change restarts the review from the queues`, async () => {
    const { desk, close } = setup(datamodel);
    try {
      desk.file({ id: 'D3', title: 'Hiring plan', author: 'ada', amount: 3000 });
      await desk.settle();
      await steps(desk, 'D3', ...claimBoth, ['legal.approve', {}], ['finance.changes', { note: 'new headcount' }],
        ['resubmit', { material: true }]);
      assert.equal(await active(desk, 'D3'), 'legalQueued financeQueued');
      const v = await variables(desk, 'D3');
      assert.deepEqual([v.version, v.approvals, v.legalReviewer, v.financeReviewer], [2, {}, null, null]);
    } finally {
      close();
    }
  });

  test(`${datamodel}: an SLA breach pauses the document; verdicts are refused; resume returns it exactly (deep history) with a new SLA`, async () => {
    const { clock, desk, close } = setup(datamodel);
    try {
      desk.file({ id: 'D4', title: 'Cloud renewal', author: 'bob', amount: 5000 });
      await desk.settle();
      assert.equal(desk.host.nextDeadline, SLA.legal, 'both stages armed their SLA');
      await steps(desk, 'D4', ...claimBoth);
      await advance(clock, desk, 10 * HOUR);
      await steps(desk, 'D4', ['legal.approve', { note: 'ok' }]);
      // Legal's timer went with its approval; finance's is still due at 48 h.
      assert.equal(desk.host.nextDeadline, SLA.finance - 10 * HOUR);
      await advance(clock, desk, SLA.finance - 10 * HOUR);
      assert.equal(await active(desk, 'D4'), 'escalated');
      assert.deepEqual(desk.outbox.at(-1), { event: 'sla.breached', docID: 'D4', stage: 'finance', reviewer: 'fay' });
      assert.equal(desk.host.nextDeadline, undefined, 'a paused document has no SLA running');

      await steps(desk, 'D4', ['finance.approve', {}]);
      assert.deepEqual(desk.outbox.at(-1), {
        event: 'verdict.refused', docID: 'D4', refused: 'finance.approve', reason: 'paused: the finance SLA was breached',
      });

      await advance(clock, desk, 5 * HOUR);
      await steps(desk, 'D4', ['resume', { reviewer: 'fred' }]);
      assert.equal(await active(desk, 'D4'), 'legalApproved financeReviewing', 'both regions back where they were');
      const v = await variables(desk, 'D4');
      assert.equal(v.financeReviewer, 'fred', 'the manager reassigned the stage');
      assert.deepEqual(v.escalations, [{ stage: 'finance', version: 1 }]);
      assert.equal(desk.host.nextDeadline, SLA.finance, 'the stage starts a new SLA');

      // Sign-off has its own SLA, and its breach resumes to sign-off.
      await steps(desk, 'D4', ['finance.approve', {}]);
      assert.equal(await active(desk, 'D4'), 'signoff');
      assert.equal(desk.host.nextDeadline, SLA.signoff);
      await advance(clock, desk, SLA.signoff);
      assert.equal(await active(desk, 'D4'), 'escalated');
      await steps(desk, 'D4', ['resume'], ['signoff.approve', { by: 'dana' }]);
      assert.equal((await desk.ending('D4')).event, 'document.approved');
      assert.deepEqual(desk.records.get('D4').escalations, [{ stage: 'finance', version: 1 }, { stage: 'signoff', version: 1 }]);
    } finally {
      close();
    }
  });

  test(`${datamodel}: an archive that fails is retried every second; the record is stored once`, async () => {
    let failures = 2;
    const { clock, desk, dir, close } = setup(datamodel, {
      beforeArchive: () => { if (failures-- > 0) throw new Error('archive unavailable'); },
    });
    try {
      desk.file({ id: 'D5', title: 'Travel policy', author: 'cy', amount: 100 });
      await desk.settle();
      await steps(desk, 'D5', ...claimBoth, ['legal.approve', {}], ['finance.approve', {}], ['signoff.approve', { by: 'dana' }]);
      assert.equal(await active(desk, 'D5'), 'archiveRetry');
      await advance(clock, desk, 1000);
      assert.equal(await active(desk, 'D5'), 'archiveRetry');
      await advance(clock, desk, 1000);
      assert.equal(await active(desk, 'D5'), 'ended');
      assert.equal(desk.archived.length, 3, 'three attempts');
      assert.deepEqual(readdirSync(join(dir, 'archive')), ['D5-v1.xml']);
      assert.equal((await desk.ending('D5')).receipt, 'ARC-0001');
    } finally {
      close();
    }
  });

  test(`${datamodel}: a withdrawal from deep inside the review ends the document and its timers`, async () => {
    const { desk, close } = setup(datamodel);
    try {
      desk.file({ id: 'D6', title: 'Partnership MoU', author: 'ada', amount: 100 });
      await desk.settle();
      await steps(desk, 'D6', ...claimBoth, ['legal.approve', {}], ['withdraw']);
      assert.equal(await active(desk, 'D6'), 'ended');
      assert.equal((await desk.ending('D6')).event, 'document.withdrawn');
      assert.equal(desk.host.nextDeadline, undefined);
      assert.equal(desk.act('D6', 'resubmit'), 'unknown');
    } finally {
      close();
    }
  });

  test(`${datamodel}: the admin view lists every document's states and variables, skips one that ended, and serves them over HTTP`, async () => {
    const { desk, close } = setup(datamodel);
    const server = await serveAdmin(desk.host);
    try {
      for (const [id, amount] of [['A', 100], ['B', 20000], ['C', 300]]) desk.file({ id, title: `doc ${id}`, author: 'ada', amount });
      await desk.settle();
      await steps(desk, 'A', ...claimBoth, ['legal.approve', {}]);
      await steps(desk, 'B', ['legal.claim', { reviewer: 'lou' }], ['legal.changes', { note: 'clause 4' }]);

      const docs = await documents(desk.host, { limit: 2 }); // two pages
      assert.deepEqual(docs.map((d) => [d.variables.docID, d.active.join(' ')]), [
        ['A', 'legalApproved financeReviewing'], ['B', 'revising'], ['C', 'legalQueued financeQueued'],
      ]);
      const a = docs[0];
      assert.equal(a.chart, 'document');
      assert.equal(a.mailbox, 0);
      assert.deepEqual(a.state, { inFlight: { active: { review: { legal: 'legalApproved', finance: 'financeReviewing' } } } });
      assert.match(formatTable(docs), /^A +v1 +100 +legalApproved \+ financeReviewing +legal lee, finance fay +legal +0 +finance in 48h$/m);
      // when each running SLA is due (actorGet's pending sends), and where the histories would return
      assert.deepEqual(a.slaDue, { finance: a.now + SLA.finance });
      assert.deepEqual(docs[1].slaDue, {}, 'B is revising: no SLA runs');
      assert.deepEqual(docs[1].history, { legalWasAt: { legal: 'legalReviewing' }, financeWasAt: { finance: 'financeQueued' } });

      // C ends after it was listed: describing it finds it stale.
      const session = docs[2].session;
      await steps(desk, 'C', ['withdraw']);
      assert.equal(await describe(desk.host, session), undefined);

      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const base = `http://127.0.0.1:${port}`;
      const list = await (await fetch(`${base}/documents`)).json();
      assert.deepEqual(list.map((d) => d.variables.docID), ['A', 'B']);
      const one = await fetch(`${base}/documents/B`);
      assert.equal(one.status, 200);
      const b = await one.json();
      assert.deepEqual(b.variables.changeRequests, [{ stage: 'legal', by: 'lou', note: 'clause 4', version: 1 }]);
      assert.equal((await fetch(`${base}/documents/C`)).status, 404, 'an ended document is gone');
      const stats = await (await fetch(`${base}/stats`)).json();
      assert.deepEqual(stats.map((c) => [c.name, c.spawned, c.ended]), [['document', 3, 1]]);
    } finally {
      server.close();
      close();
    }
  });

  test(`${datamodel}: the day of main.mjs ends every document, and archives each approved one with its three approvals`, async () => {
    const out = mkdtempSync(join(tmpdir(), 'document-approval-main-'));
    try {
      const result = await run({ documents: 8, seed: 3, datamodel, slaMs: 120, tickMs: 10, out, quiet: true });
      assert.deepEqual(result.problems, []);
      assert.equal(result.endings.length, 8);
      assert.ok(result.midway.length > 0, 'the admin view was read midway over HTTP');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}
