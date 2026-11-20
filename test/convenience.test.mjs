// The convenience layer (docs/plan.xml, p3-promises; the maintainer,
// 2026-11-18): each typed method returns a promise when given no handler,
// `host.<method>(params)`, resolving from onResult, rejecting from onError
// with the same TinyactorsError; given handlers it is the direct call.
import { Host, TinyactorsError, version } from '@tinyactors/node';
import { equal, hostWith, status, until, WAITER } from './charts.mjs';
import { run, test } from './harness.mjs';

const METHODS = ['actorState', 'actorContext', 'actorList', 'actorGet', 'hostStats', 'hostConfig', 'traceConfigure',
  'traceWatch', 'traceUnwatch', 'traceEnd', 'traceSpansDecode'];

/** A host running WAITER as one session `w`, once it has started. */
async function waiting() {
  const host = hostWith({ waiter: WAITER });
  const session = host.spawn(host.chart('waiter'), { name: 'w' });
  await host.idle();
  return { host, session };
}

/** The error `promise` rejects with; throws when it resolves. */
async function rejection(promise, what) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error(`${what}: resolved`);
}

test('every typed method keeps its name and length, a method of Host, no ...Async beside it', () => {
  for (const method of METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(Host.prototype, method);
    equal(typeof descriptor?.value, 'function', `${method}: a method`);
    equal(descriptor.enumerable, false, `${method}: not enumerable, as a class's methods`);
    equal(descriptor.value.name, method, `${method}: its name`);
    equal(descriptor.value.length, 3, `${method}: (params, onResult, onError)`);
  }
  const promised = Object.getOwnPropertyNames(Host.prototype).filter((name) => name.endsWith('Async'));
  equal(promised.join(), '', 'no promise forms of their own');
});

test('each promise resolves with the result its direct method gives', async () => {
  const { host, session } = await waiting();
  const results = await Promise.all([
    host.actorState({ session }),
    host.actorContext({ session }),
    host.actorList(),
    host.actorGet({ session }),
    host.hostStats(),
    host.hostConfig({}),
    host.traceConfigure({ detail: 'summary' }),
    host.traceWatch({ rules: [{ chart: 'waiter' }], seconds: 60 }),
    host.traceSpansDecode({ traces: new Uint8Array() }),
  ]);
  const [state, context, list, actor, stats, config, configure, watch, spans] = results;
  equal(state.value, 's', 'actor.state');
  equal(JSON.stringify(context), '{"variables":{}}', 'actor.context');
  equal(list.sessions.length, 1, 'actor.list: one session');
  equal(list.cursor, null, 'actor.list: every session listed');
  equal(actor.chart, 'waiter', 'actor.get');
  equal(stats.host.actors, 1, 'host.stats');
  equal(config.systemID, 't', 'host.config');
  equal(JSON.stringify(configure), '{}', 'trace.configure');
  equal(typeof watch.id, 'number', 'trace.watch: a watch id');
  equal(JSON.stringify(await host.traceUnwatch({ id: watch.id })), '{}', 'trace.unwatch of the watch');
  equal(spans.spans.length, 0, 'trace.spans.decode of nothing');
  equal(JSON.stringify(state), await new Promise((resolve) => host.actorState({ session }, (r) => resolve(JSON.stringify(r)))),
    'the same result as the direct method\'s');
  host.close();
});

test('a promise rejects with the TinyactorsError onError gets: code, reason, path', async () => {
  const { host } = await waiting();
  const error = await rejection(host.actorGet({ session: 99n }), 'actorGet of no session');
  if (!(error instanceof TinyactorsError)) throw new Error(`a TinyactorsError: ${error}`);
  equal(error.code, -32001, 'code');
  equal(error.reason, 'stale', 'reason');
  equal(error.path, 'params.session', 'path');
  equal(error.status, undefined, 'no status: it is no call\'s');
  const direct = await new Promise((resolve) => host.actorGet({ session: 99n }, () => {}, (e) => resolve(e)));
  equal(`${direct.code} ${direct.reason} ${direct.path} ${direct.message}`, `${error.code} ${error.reason} ${error.path} ${error.message}`,
    'the direct method\'s error');
  const unwatch = await rejection(host.traceUnwatch({ id: 99 }), 'traceUnwatch of no watch');
  equal(unwatch.reason, 'stale', 'trace.unwatch of no watch');
  const end = await rejection(host.traceEnd(), 'traceEnd without telemetry');
  equal(end.reason, 'state', 'trace.end without telemetry');
  const params = await rejection(host.actorList({ limit: 0 }), 'actorList out of range');
  equal(`${params.code} ${params.reason} ${params.path}`, '-32602 range params.limit', 'params checked by core');
  host.close();
});

test('a rejection is the caller\'s: idle() resolves, the turn throws nothing', async () => {
  const { host } = await waiting();
  const rejected = rejection(host.actorState({ session: 99n }), 'actorState of no session');
  await host.idle(); // an error with no handler would reject this
  equal((await rejected).reason, 'stale', 'the promise has it');
  host.close();
});

test('a rejection with no catch is an unhandled rejection, not an uncaught throw from the turn', async () => {
  const { host } = await waiting();
  const unhandled = [];
  const uncaught = [];
  const onUnhandled = (reason, promise) => unhandled.push({ reason, promise });
  const onUncaught = (error) => uncaught.push(error);
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);
  try {
    const promise = host.actorGet({ session: 99n }); // no catch
    await host.idle();
    await until(() => unhandled.length > 0, 2000);
    equal(unhandled.length, 1, 'one unhandled rejection');
    equal(unhandled[0].promise, promise, 'of the promise');
    if (!(unhandled[0].reason instanceof TinyactorsError)) throw new Error(`its reason a TinyactorsError: ${unhandled[0].reason}`);
    equal(unhandled[0].reason.reason, 'stale', 'the reply\'s error');
    equal(uncaught.length, 0, 'nothing thrown from the turn');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    process.off('uncaughtException', onUncaught);
    host.close();
  }
});

test('a refusal at the call rejects: a closed host, another object', async () => {
  const { host, session } = await waiting();
  host.close();
  const closed = await rejection(host.actorState({ session }), 'a closed host');
  status('TA_ERROR_STATE')(closed);
  const other = await rejection(Host.prototype.hostStats.call({}), 'another object');
  if (!(other instanceof TypeError)) throw new Error(`a TypeError: ${other}`);
});

test('a continuation runs after the turn, and may call the host again', async () => {
  const { host, session } = await waiting();
  const seen = [];
  const answered = host.actorGet({ session }).then(async (actor) => {
    seen.push(`got ${actor.chart}`);
    host.send(session, 'go');
    const state = await host.actorState({ session });
    seen.push(`state ${JSON.stringify(state.value)}`);
  });
  seen.push('asked');
  await answered;
  equal(seen.join(), 'asked,got waiter,state "s"', 'in order, each from a later turn');
  host.close();
});

test('with handlers the call is the direct one: it returns nothing and answers the handler', async () => {
  const { host } = await waiting();
  let got;
  equal(host.hostStats(undefined, (result) => (got = result)), undefined, 'returns nothing');
  equal(host.hostStats(undefined, (result) => {}, null), undefined, 'a null onError is none');
  await host.idle();
  equal(got.host.actors, 1, 'answered to the handler');
  let threw;
  try { host.hostStats(undefined, undefined, () => {}); } catch (error) { threw = error; }
  if (!(threw instanceof TypeError)) throw new Error('an onError without an onResult is a TypeError');
  try { host.hostStats(undefined, 'not a function'); threw = undefined; } catch (error) { threw = error; }
  if (!(threw instanceof TypeError)) throw new Error('an onResult that is no function is a TypeError');
  const promise = host.hostStats(undefined, undefined, null);
  if (!(promise instanceof Promise)) throw new Error('no handler at all: a promise');
  equal((await promise).host.actors, 1, 'its result');
  host.close();
});

test('a method pending at close never settles', async () => {
  const { host } = await waiting();
  let settled = false;
  host.hostStats().then(() => (settled = true), () => (settled = true));
  host.close();
  await until(() => false, 20);
  equal(settled, false, 'its handlers were dropped');
});

test('version is the package\'s, and its package.json can be imported by name', async () => {
  equal(typeof version, 'string', 'a string');
  equal(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version), true, `a semantic version: ${version}`);
  if (globalThis.process?.versions?.node === undefined) return; // a page resolves no package.json by name
  const { default: packageJSON } = await import('@tinyactors/node/package.json', { with: { type: 'json' } });
  equal(version, packageJSON.version, 'the package.json the package resolves to');
});

await run();
