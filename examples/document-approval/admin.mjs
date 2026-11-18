// The admin view: every document's active states, where its history
// states would return, when each stage's SLA is due, and its variables,
// read from the running host with the typed methods actorList, actorGet,
// actorState and actorContext. As a function (`documents`, `describe`),
// as text for a terminal (`formatTable`), and as an HTTP endpoint
// (`serveAdmin`).
import { createServer } from 'node:http';
import { TinyactorsError } from '@tinyactors/node';

/** The atomic states of a state value: `{"a": {"p": {"r1": "x", "r2": "y"}}}`
 * gives `['x', 'y']`. */
export function leaves(value) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(leaves);
}

/** The SLAs running of a document, from its pending delayed sends
 * (actorGet's `timers`): each stage's timer is the send with id
 * `<stage>SLA` (charts/document.scxml), due at a time of `host.now()`'s
 * clock. `{ legal: 172800000 }` is legal's SLA, due at 48 h. */
export function slaDue(timers) {
  const due = {};
  for (const timer of timers) {
    const stage = /^(\w+)SLA$/.exec(timer.sendid ?? '')?.[1];
    if (stage) due[stage] = timer.due;
  }
  return due;
}

/** One actor as the admin sees it, or `undefined` when it ended before the
 * host answered (between `actorList` and these calls, say). */
export async function describe(host, session) {
  try {
    const [actor, state, context] = await Promise.all([
      host.actorGet({ session }),
      host.actorState({ session }),
      host.actorContext({ session }),
    ]);
    return {
      session: actor.session,
      chart: actor.chart,
      mailbox: actor.mailbox,
      state: state.value,
      active: leaves(state.value),
      // where each history state would return: a resume (resumePoint) or a resubmission (legalWasAt, financeWasAt)
      history: state.history,
      slaDue: slaDue(actor.timers),
      now: host.now(),
      variables: context.variables,
    };
  } catch (error) {
    if (error instanceof TinyactorsError && error.reason === 'stale') return undefined;
    throw error;
  }
}

/** Every live actor of chart `document`, a page of `limit` at a time. */
export async function documents(host, { limit = 64 } = {}) {
  const found = [];
  let cursor = 0;
  do {
    const page = await host.actorList({ cursor, limit });
    const described = await Promise.all(page.sessions.map((session) => describe(host, session)));
    for (const actor of described) if (actor?.chart === 'document') found.push(actor);
    cursor = page.cursor;
  } while (cursor !== null);
  return found;
}

/** Document `id`, found by its name, or `undefined`. */
export async function documentByID(host, id) {
  const session = host.actorByName(id);
  return session === undefined ? undefined : describe(host, session);
}

/** Milliseconds as hours, or seconds below one: `172800000` is `48h`. */
function hours(ms) {
  return ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)}h` : `${+(ms / 1000).toFixed(1)}s`;
}

/** A row per document for a terminal. */
export function formatTable(docs) {
  const rows = docs.map((d) => {
    const v = d.variables;
    const who = [v.legalReviewer && `legal ${v.legalReviewer}`, v.financeReviewer && `finance ${v.financeReviewer}`]
      .filter(Boolean).join(', ');
    const sla = Object.entries(d.slaDue).map(([stage, due]) => `${stage} in ${hours(due - d.now)}`).join(', ');
    return [String(v.docID), `v${v.version}`, String(v.amount), d.active.join(' + '), who || '-',
      Object.keys(v.approvals ?? {}).join(',') || '-', String(v.escalations?.length ?? 0), sla || '-'];
  });
  const head = ['document', 'ver', 'amount', 'active states', 'reviewers', 'approved by', 'escalations', 'SLA due'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [head, ...rows].map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body, null, 2));
};

/**
 * The admin endpoint: `GET /documents` lists every document, `GET
 * /documents/<id>` gives one, `GET /stats` the host's counters per chart.
 * Listens on `port` (0: a free one); resolves with the server.
 */
export function serveAdmin(host, { port = 0, hostname = '127.0.0.1' } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://admin');
      if (request.method !== 'GET') return json(response, 405, { error: 'GET only' });
      if (url.pathname === '/documents') return json(response, 200, await documents(host));
      const match = /^\/documents\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const doc = await documentByID(host, decodeURIComponent(match[1]));
        return doc ? json(response, 200, doc) : json(response, 404, { error: 'no such document: it ended, or never was' });
      }
      if (url.pathname === '/stats') return json(response, 200, (await host.hostStats()).charts);
      return json(response, 404, { error: 'not found' });
    } catch (error) {
      return json(response, 500, { error: String(error) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => resolve(server));
  });
}
