// A busy second at the gateway, on the real clock: a few clients log in and
// fire requests faster than their plans allow, at an upstream that is slow,
// sometimes too slow, and sometimes drops the connection. Half of the
// requests carry a traceparent of their caller's. At the end every client
// logs out, the gateway closes, and the collector has the traces and logs.
//
//   node examples/http-gateway/main.mjs [--clients N] [--requests R] [--seed S]
//
// It prints how the requests ended, per client, and what the collector got.
import { parseArgs } from 'node:util';
import { Gateway } from './gateway.mjs';
import { Collector, Upstream } from './world.mjs';

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
const hex = (next, bytes) => Array.from({ length: bytes }, () => Math.floor(next() * 256).toString(16).padStart(2, '0')).join('');

// the plans of gateway.mjs, a hundred times faster, so the demo takes a second
const PLANS = {
  free: { burst: 3, refillMs: 20, maxInFlight: 1, upstreamTimeoutMs: 120, idleMs: 5000 },
  pro: { burst: 10, refillMs: 5, maxInFlight: 4, upstreamTimeoutMs: 120, idleMs: 5000 },
};

/** Runs `clients` clients of `requests` requests each; answers every
 * response, the collector and the sessions that closed. */
export async function run({ clients = 4, requests = 50, seed = 1 } = {}) {
  const next = random(seed);
  const upstream = new Upstream({
    // 80 % answered in 5 to 40 ms, 8 % too slow, 7 % dropped, 5 % not found
    respond: async (call) => {
      const roll = next();
      if (roll < 0.07) return 'drop';
      await sleep(roll < 0.15 ? 200 : 5 + next() * 35);
      if (roll > 0.95) return { status: 404, body: { error: 'no such item' } };
      return { status: 200, body: { path: call.path, client: call.client } };
    },
  });
  const collector = new Collector();
  const keys = {};
  for (let n = 0; n < clients; n++) keys[`key-${n}`] = { client: `client-${n}`, plan: n % 2 === 0 ? 'free' : 'pro' };
  const gateway = new Gateway({
    upstream: await upstream.listen(), collector: await collector.listen(), keys, plans: PLANS,
  });
  const url = await gateway.listen();

  const results = [];
  const client = async (n) => {
    const login = await (await fetch(`${url}/sessions`, { method: 'POST', headers: { 'x-api-key': `key-${n}` } })).json();
    const calls = [];
    for (let r = 0; r < requests; r++) {
      const trace = next() < 0.5 ? hex(next, 16) : undefined;
      const headers = { authorization: `Bearer ${login.token}` };
      if (trace) headers.traceparent = `00-${trace}-${hex(next, 8)}-01`;
      const method = next() < 0.8 ? 'GET' : 'POST';
      const path = `/api/items/${Math.floor(next() * 100)}`;
      calls.push(fetch(`${url}${path}`, { method, headers, body: method === 'POST' ? '{}' : undefined }).then(async (response) => {
        await response.arrayBuffer();
        results.push({
          client: n, method, path, status: response.status, traced: trace !== undefined, trace,
          traceresponse: response.headers.get('traceresponse')?.split('-')[1],
        });
      }));
      await sleep(next() * 15);
    }
    await Promise.all(calls);
    await fetch(`${url}/sessions/current`, { method: 'DELETE', headers: { authorization: `Bearer ${login.token}` } });
  };
  await Promise.all(Array.from({ length: clients }, (_, n) => client(n)));
  await gateway.close();
  await upstream.close();
  await collector.close();
  return { results, collector, closed: gateway.closed, logs: gateway.logs, exportFailures: gateway.exportFailures };
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { clients: { type: 'string', default: '4' }, requests: { type: 'string', default: '50' }, seed: { type: 'string', default: '1' } } });
  const started = Date.now();
  const { results, collector, closed, logs, exportFailures } = await run({
    clients: Number(values.clients), requests: Number(values.requests), seed: Number(values.seed),
  });
  const clients = [...new Set(results.map((r) => r.client))].sort((a, b) => a - b);
  for (const n of clients) {
    const counts = {};
    for (const r of results.filter((r) => r.client === n)) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const plan = n % 2 === 0 ? 'free' : 'pro ';
    console.log(`client-${n} (${plan})  ${Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join('  ')}`);
  }
  const traced = results.filter((r) => r.traced);
  console.log(`\n${results.length} requests in ${Date.now() - started} ms; ${traced.length} traced, ` +
    `${traced.filter((r) => r.traceresponse === r.trace).length} answered in their caller's trace`);
  console.log(`${logs.filter((l) => l.startsWith('retry')).length} GETs retried, ${logs.filter((l) => l.startsWith('timeout')).length} upstream timeouts, ` +
    `${logs.filter((l) => l.startsWith('late')).length} late answers dropped`);
  console.log(`sessions closed: ${closed.map((c) => `${c.reason} after ${c.requests} requests, ${c.limited} limited`).join('; ')}`);
  console.log(`collector: ${collector.bodies('traces').length} traces requests, ${collector.bodies('logs').length} logs requests, ${exportFailures} failed exports`);
}
