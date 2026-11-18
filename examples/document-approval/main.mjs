// A day at the approval desk on the real clock. Authors file documents;
// legal and finance reviewers, sign-off directors and a manager work
// through them. The people are bots that read their work queue from the
// admin view (admin.mjs, the typed methods) every tick, and act on what
// they see: claim, approve, request changes, reject, resubmit, resume.
// The SLAs are short, so some stages are breached and escalated. Midway the
// admin endpoint is read over HTTP and printed; at the end every approved
// document's archived XML is read back from disk and checked.
//
//   node examples/document-approval/main.mjs [--documents N] [--seed S]
//        [--datamodel native|quickjs] [--sla-ms MS] [--tick-ms MS] [--out DIR]
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { documents, formatTable, serveAdmin } from './admin.mjs';
import { ApprovalDesk, FINAL } from './desk.mjs';
import { readRecord } from './xml.mjs';

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
const TITLES = ['Vendor contract', 'Office lease', 'Marketing budget', 'Data processing agreement', 'Hiring plan',
  'Cloud renewal', 'Travel policy', 'Partnership MoU'];
const PEOPLE = { legal: ['lee', 'lou'], finance: ['fay', 'fred'], signoff: ['dana'], author: ['ada', 'bob', 'cy'] };

/**
 * Runs the day. Resolves with what happened: each document's ending, the
 * admin view read midway, and the problems the final check found (none
 * expected).
 */
export async function run({ documents: count = 12, seed = 1, datamodel = 'native', slaMs = 300, tickMs = 30,
  out, quiet = false } = {}) {
  const dir = out ?? mkdtempSync(join(tmpdir(), 'document-approval-'));
  const rand = random(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const say = quiet ? () => {} : (...args) => console.log(...args);
  const desk = new ApprovalDesk({ dir, datamodel, slaMs: { legal: slaMs, finance: slaMs, signoff: slaMs } });
  const server = await serveAdmin(desk.host);
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  say(`admin view on http://127.0.0.1:${port}/documents`);

  const ids = [];
  for (let i = 1; i <= count; i++) {
    const id = `DOC-${String(i).padStart(3, '0')}`;
    ids.push(id);
    // Every third document is large enough that finance waits for legal.
    desk.file({ id, title: pick(TITLES), author: pick(PEOPLE.author), amount: i % 3 === 0 ? 25000 : 2000 + 500 * i });
  }

  // Each tick, every person looks at the queue and acts on some of it.
  const act = (id, event, data) => desk.act(id, event, data);
  const work = (doc) => {
    const { docID: id } = doc.variables;
    for (const state of doc.active) {
      const roll = rand();
      switch (state) {
        case 'legalQueued': if (roll < 0.5) act(id, 'legal.claim', { reviewer: pick(PEOPLE.legal) }); break;
        case 'financeQueued': if (roll < 0.5) act(id, 'finance.claim', { reviewer: pick(PEOPLE.finance) }); break;
        case 'legalReviewing':
        case 'financeReviewing': {
          const stage = state === 'legalReviewing' ? 'legal' : 'finance';
          if (roll < 0.1) act(id, `${stage}.approve`, { note: 'looks good' });
          else if (roll < 0.13) act(id, `${stage}.changes`, { note: `${stage} wants changes` });
          else if (roll < 0.135) act(id, `${stage}.reject`, { note: `${stage} says no` });
          break;
        }
        case 'revising': if (roll < 0.3) act(id, 'resubmit', { material: rand() < 0.3 }); break;
        case 'signoff':
          if (roll < 0.3) act(id, 'signoff.approve', { by: pick(PEOPLE.signoff) });
          else if (roll < 0.32) act(id, 'signoff.reject', { by: pick(PEOPLE.signoff), note: 'not this year' });
          break;
        case 'escalated': if (roll < 0.2) act(id, 'resume', rand() < 0.5 ? { reviewer: 'max' } : undefined); break;
      }
    }
  };

  let midway;
  const started = Date.now();
  for (let tick = 0; ; tick++) {
    const queue = await documents(desk.host);
    if (queue.length === 0) break;
    if (midway === undefined && desk.outbox.filter((m) => FINAL.has(m.event)).length >= count / 2) {
      const response = await fetch(`http://127.0.0.1:${port}/documents`);
      midway = await response.json();
      say(`\nthe admin view midway, ${Date.now() - started} ms in (GET /documents):\n${formatTable(midway)}\n`);
    }
    for (const doc of queue) work(doc);
    if (Date.now() - started > 60_000) throw new Error('the day did not end in a minute');
    await sleep(tickMs);
  }
  await desk.settle();
  server.close();

  // What the chart told people, and what the archive holds on disk.
  const endings = await Promise.all(ids.map((id) => desk.ending(id)));
  const files = readdirSync(join(dir, 'archive')).sort();
  const onDisk = new Map(files.map((file) => {
    const record = readRecord(readFileSync(join(dir, 'archive', file), 'utf8'));
    return [record.docID, record];
  }));
  const problems = [];
  for (const ending of endings) {
    const record = onDisk.get(ending.docID);
    if (ending.event === 'document.approved') {
      if (!record) { problems.push(`${ending.docID}: approved but not archived`); continue; }
      for (const stage of ['legal', 'finance', 'signoff']) {
        if (!record.approvals[stage]) problems.push(`${ending.docID}: archived without the ${stage} approval`);
      }
      if (record.version !== ending.version) problems.push(`${ending.docID}: archived v${record.version}, approved v${ending.version}`);
    } else if (record) {
      problems.push(`${ending.docID}: ${ending.event} but archived`);
    }
  }
  const refused = desk.outbox.filter((m) => m.event === 'verdict.refused').length;
  const breaches = desk.outbox.filter((m) => m.event === 'sla.breached').length;
  const changes = desk.outbox.filter((m) => m.event === 'changes.requested').length;

  for (const ending of endings) {
    const record = onDisk.get(ending.docID);
    const how = ending.event === 'document.approved'
      ? `approved v${ending.version}, receipt ${ending.receipt}, ${record?.changes.length ?? 0} change requests, ${record?.escalations.length ?? 0} escalations`
      : ending.event === 'document.rejected' ? `rejected by ${ending.outcome?.stage} (${ending.outcome?.by})` : 'withdrawn';
    say(`${ending.docID}: ${how}`);
  }
  say(`\n${endings.filter((e) => e.event === 'document.approved').length} approved, `
    + `${endings.filter((e) => e.event === 'document.rejected').length} rejected; `
    + `${changes} change requests, ${breaches} SLA breaches, ${refused} verdicts refused; `
    + `${files.length} records in ${join(dir, 'archive')}`);
  say(problems.length === 0 ? 'every approved document is archived with its three approvals' : `problems:\n  ${problems.join('\n  ')}`);
  desk.close();
  return { endings, midway, problems, breaches, refused, changes, dir };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      documents: { type: 'string', default: '12' },
      seed: { type: 'string', default: '1' },
      datamodel: { type: 'string', default: 'native' },
      'sla-ms': { type: 'string', default: '300' },
      'tick-ms': { type: 'string', default: '30' },
      out: { type: 'string' },
    },
  });
  const datamodel = values.datamodel === 'quickjs' ? 'quickjs' : 'native';
  const result = await run({
    documents: Number(values.documents), seed: Number(values.seed), datamodel,
    slaMs: Number(values['sla-ms']), tickMs: Number(values['tick-ms']), out: values.out,
  });
  process.exitCode = result.problems.length === 0 ? 0 : 1;
}
