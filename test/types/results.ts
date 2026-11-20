// The types' own cases (tools/typecheck.mjs): what the typed methods
// answer, the config's keys, and the application layer's shapes, checked by
// tsc; each `@ts-expect-error` is a mistake the types must catch.
import {
  type ActorGetResult,
  type EffectiveHostConfig,
  type HostConfig,
  type HostOptions,
  type HostStatsResult,
  type StateValue,
  Actor,
  Address,
  compileDir,
  Host,
  MemoryStore,
  Spawner,
  SQLiteStore,
} from '@tinyactors/node';

const config: HostConfig = {
  system: { maxActors: 10_000, ticksPerSecond: 1000, tracing: true },
  migrateQuantum: 128,
  telemetry: { flushInterval: 5000, resource: { 'service.name': 'types' }, logs: true },
};
// @ts-expect-error the system id is options.system
const withID: HostConfig = { systemID: 'x' };
// @ts-expect-error a key the host does not take
const unknownKey: HostConfig = { maxActors: 4 };
// @ts-expect-error a capacity is a number
const wrongType: HostConfig = { system: { maxActors: '4' } };
const options: HostOptions = {
  system: 'types',
  config,
  ioProcessors: { 'urn:mail': { location: 'mailto:', receive: (send) => send.answer('sent') }, spawn: new Spawner() },
  store: new MemoryStore(),
  resident: 1000,
  onDone: (actor, donedata) => console.log(actor.id, donedata),
  onError: (actor, error) => console.log(actor.address.text, error.status),
  onHandlerError: (error, effect) => console.log(error, effect?.host.system),
};
// @ts-expect-error a processor is an object with receive(send)
const functionProcessor: HostOptions = { system: 'x', ioProcessors: { 'urn:mail': (send: unknown) => send } };
// @ts-expect-error the system is required
const noSystem: HostOptions = { config };

export async function results(host: Host, session: bigint): Promise<void> {
  const { value } = await host.actorState({ session });
  const state: StateValue = value;
  if (typeof state !== 'string') for (const [parent, child] of Object.entries(state)) console.log(parent, child);

  const { variables } = await host.actorContext({ session });
  console.log(variables.total);

  const page = await host.actorList({ limit: 10 });
  const sessions: readonly number[] = page.sessions;
  const cursor: number | null = page.cursor;
  // @ts-expect-error a cursor may be null
  const always: number = page.cursor;

  const actor: ActorGetResult = await host.actorGet({ session });
  const parent: number | null = actor.parent;
  const chart: string = actor.chart;

  const stats: HostStatsResult = await host.hostStats();
  for (const pools of stats.pools) console.log(pools.segment, pools.actors.highWater, pools.slabBytes.capacity);
  // @ts-expect-error pools is an array, one entry per segment
  console.log(stats.pools.actors);
  console.log(stats.host.regionBytes, stats.charts[0]?.errorsExecution);

  const effective: EffectiveHostConfig = await host.hostConfig();
  const rate: number = effective.system.ticksPerSecond;
  const encoder = effective.telemetry?.flushInterval;

  const { id } = await host.traceWatch({ rules: [{ chart: 'order', detail: 'full' }], seconds: 60 });
  await host.traceUnwatch({ id });
  await host.traceConfigure({ detail: 'summary', sample: 0.5, rules: [{ at: 'start', from: ['host'] }] });
  // @ts-expect-error a detail the host does not have
  await host.traceConfigure({ detail: 'everything' });
  // @ts-expect-error traceWatch needs rules
  await host.traceWatch({ seconds: 60 });
  const { spans } = await host.traceSpansDecode({ traces: new Uint8Array() });
  for (const span of spans) console.log(span.trace, span.parent ?? 'root', span.start);

  // @ts-expect-error actorState needs a session
  await host.actorState({});
  // the direct forms take the same params and give the same results
  host.actorGet({ session }, (result) => console.log(result.chart, result.mailbox));
  host.hostStats(undefined, (result) => console.log(result.pools.length), (error) => console.log(error.reason));
  // @ts-expect-error a result is typed: actorGet has no value
  host.actorGet({ session }, (result) => console.log(result.value));

  console.log(sessions, cursor, always, parent, chart, rate, encoder, withID, unknownKey, wrongType);
}

export async function shapes(): Promise<bigint> {
  const compiled = compileDir(new URL('./charts/', 'file:///app/'));
  const host = new Host(compiled, options);
  const again = Host.restore(host.snapshot(), [compiled], options);
  const store = new SQLiteStore(':memory:');
  const order: Actor = host.spawn('order', { name: 'first', params: { total: 0 } });
  const same: Actor = host.actor('first');
  const [event, data] = await order.ask('quote', { items: 2 }, { signal: AbortSignal.timeout(1000) });
  const all: Actor[] = await host.actors({ chart: 'order' });
  const donedata = await order.done;
  host.send(order, 'go');
  await host.actorState({ session: order });
  // @ts-expect-error spawn takes a chart's name or a ChartRef
  host.spawn(7);
  const json: string = Address.fromName('types', 'a').toJSON();
  console.log(json, same.equals(order), event, data, all.length, donedata, store, again, functionProcessor, noSystem);
  return order.id;
}
