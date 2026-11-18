// The types' own cases (tools/typecheck.mjs): what the typed methods
// answer, the config's keys, and the convenience layer's shapes, checked by
// tsc; each `@ts-expect-error` is a mistake the types must catch.
import {
  type ActorGetResult,
  type EffectiveHostConfig,
  type HostConfig,
  type HostStatsResult,
  type StateValue,
  Address,
  directoryResolver,
  Host,
} from '@tinyactors/node';

const config: HostConfig = {
  systemID: 'types',
  system: { maxActors: 10_000, ticksPerSecond: 1000, tracing: true },
  ioProcessors: [{ type: 'urn:mail', location: 'mailto:' }],
  migrateQuantum: 128,
  telemetry: { flushInterval: 5000, resource: { 'service.name': 'types' }, logs: true },
};
// @ts-expect-error systemID is required
const noID: HostConfig = { system: {} };
// @ts-expect-error a key the host does not take
const unknownKey: HostConfig = { systemID: 'x', maxActors: 4 };
// @ts-expect-error a capacity is a number
const wrongType: HostConfig = { systemID: 'x', system: { maxActors: '4' } };

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
  host.actorGet({ session }, (h, result) => console.log(result.chart, result.mailbox));
  host.hostStats(undefined, (h, result) => console.log(result.pools.length), (h, error) => console.log(error.reason));
  // @ts-expect-error a result is typed: actorGet has no value
  host.actorGet({ session }, (h, result) => console.log(result.value));

  console.log(sessions, cursor, always, parent, chart, rate, encoder, noID, unknownKey, wrongType);
}

export function shapes(host: Host): bigint {
  const segment: number = host.addCharts({ 'order.scxml': '<scxml/>' }, { resolver: directoryResolver('charts') });
  // @ts-expect-error a text, not a Source
  host.addCharts({ 'order.scxml': { name: 'order.scxml', text: '' } });
  // @ts-expect-error resolver is the only option
  host.addCharts({}, { resolve: () => '' });
  const json: string = Address.fromName('types', 'a').toJSON();
  console.log(segment, json, config);
  return host.spawnChart('order', { name: 'first', params: { total: 0 } });
}
