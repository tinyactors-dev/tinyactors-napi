// Type-checked with `tsc -p test` (no emit). Exercises the typings of the
// public API, including negative cases via @ts-expect-error.
import {
  createMachine, createActor, setup, assign, raise, sendTo, sendParent, log, cancel,
  stateIn, and, or, not, fromSCXML, compileSystem, loadImage, type SystemImage, type Snapshot, type ContextFrom, type EventFrom,
} from '..';

type Ctx = { count: number; name: string };
type Ev = { type: 'INC'; by: number } | { type: 'RESET' } | { type: 'RENAME'; name: string };

const counter = createMachine({
  id: 'counter',
  types: {} as { context: Ctx; events: Ev; input: { start: number }; output: number },
  context: ({ input }) => ({ count: input.start, name: 'c' }),
  initial: 'active',
  states: {
    active: {
      on: {
        INC: {
          guard: ({ event }) => event.by > 0, // event narrowed to INC
          actions: assign({ count: ({ context, event }) => context.count + event.by }),
        },
        RESET: { actions: [assign({ count: 0 }), log('reset'), raise({ type: 'RENAME', name: 'zero' })] },
        RENAME: { actions: assign(({ event }) => ({ name: event.name })) },
        '*': { actions: ({ context }) => void context.count },
      },
      after: { 1000: 'idle', slow: { target: 'idle', guard: stateIn('active') } },
    },
    idle: { type: 'final', output: ({ context }: { context: Ctx }) => context.count },
  },
  output: ({ context }) => context.count,
});

const actor = createActor(counter, { input: { start: 1 }, logger: console.log });
actor.start();
actor.send({ type: 'INC', by: 2 });
actor.send({ type: 'RESET' });
// @ts-expect-error unknown event type
actor.send({ type: 'NOPE' });
// @ts-expect-error missing payload
actor.send({ type: 'INC' });

const snap: Snapshot<Ctx, number> = actor.getSnapshot();
const n: number = snap.context.count;
const out: number | undefined = snap.output;
const isActive: boolean = snap.matches('active') && snap.hasTag('t');
void n, out, isActive;

type C = ContextFrom<typeof counter>;
type E = EventFrom<typeof counter>;
const c: C = { count: 1, name: 'x' };
const e: E = { type: 'RENAME', name: 'y' };
void c, e;

// @ts-expect-error context field must be a number
assign<Ctx>({ count: 'nope' });

const sub = actor.subscribe({ next: (s) => s.context.name.toUpperCase(), complete: () => {} });
sub.unsubscribe();
actor.subscribe((s) => s.value);
actor.stop();

const child = createMachine({ initial: 'a', states: { a: { entry: sendParent({ type: 'HELLO' }) } } });

const machine = setup({
  actions: { track: ({ context }, params: { tag: string }) => void [context, params.tag] },
  guards: { ok: () => true },
  delays: { soon: 10 },
  actors: { child },
}).createMachine({
  initial: 'a',
  states: {
    a: {
      invoke: { src: 'child', id: 'kid', input: { x: 1 }, onDone: 'b' },
      on: {
        HELLO: {
          guard: and(['ok', not(or([stateIn('#b'), { type: 'ok' }]))]),
          actions: [{ type: 'track', params: { tag: 't' } }, sendTo('kid', { type: 'PING' }), cancel('x')],
        },
      },
      after: { soon: 'b' },
    },
    b: { id: 'b' },
  },
});
const scxml: string = machine.provide({ guards: { ok: () => false } }).toSCXML();
void scxml;

// systems: explicit system, systemID lookup, sendTo an actor reference
import { createSystem, type System, type SystemRef } from '..';
const system: System = createSystem();
const pongerRef = createActor(counter, { input: { start: 0 }, system, systemID: 'ponger' }).start();
const sys: SystemRef = system;
void sys.get('ponger');
sendTo(pongerRef, { type: 'INC', by: 1 });
sendTo(({ system }) => system.get('ponger'), { type: 'RESET' });
// @ts-expect-error targets are ids, actors or functions
sendTo(42, { type: 'RESET' });
const sizes: number[] = system.stats().map((s) => s.sessions);
void sizes;

// hibernation: stores may be synchronous or asynchronous
import { createMemoryStore, type HibernationStore } from '..';
const asyncStore: HibernationStore = {
  get: async (key: string) => new Uint8Array(key.length),
  set: async () => {},
  delete: () => {},
};
const sleepy = createSystem({ id: 'sleepy', hibernation: { store: asyncStore, sweepMs: 10_000 } });
createSystem({ hibernation: { store: createMemoryStore() } });
const unloaded: number = sleepy.hibernate();
const asleep: boolean = pongerRef.hibernated;
void unloaded, asleep;
// @ts-expect-error the store must return bytes
createSystem({ hibernation: { store: { get: () => 'text', set: () => {}, delete: () => {} } } });

// links: the link is an actor whose value is the connection status
import { createLink, serveLinks, type Link, type LinkStatus, type ActorRef } from '..';
const link: Link = createLink(system, { url: 'ws://localhost:1/link', name: 'server' });
link.subscribe((s) => {
  const status: LinkStatus = s.value as LinkStatus;
  const rtt: number | null = s.context.rtt;
  void status, rtt;
});
const remoteLobby: ActorRef = link.get('lobby');
remoteLobby.send({ type: 'JOIN' });
sendTo(remoteLobby, { type: 'JOIN' });
const replying = createMachine({
  id: 'replying',
  on: { PING: { actions: sendTo(({ self }) => self, { type: 'PONG' }) } },
});
void replying;
const server = serveLinks(system, { port: 0 });
void server.connections(), server.close();
link.close();

// links over byte streams: TCP, any duplex (a child process's stdio), the frame codec
import { encodeFrame, FrameDecoder } from '..';
type Listener = (...args: any[]) => void;
declare const pipe: { on(e: string, f: Listener): void; off(e: string, f: Listener): void; once(e: string, f: Listener): void; write(c: Uint8Array): boolean; end(): void };
createLink(system, { tcp: { host: 'db-1', port: 7000 }, name: 'db', maxFrame: 4096 });
createLink(system, { name: 'parent', transport: () => ({ readable: pipe, writable: pipe }) });
createLink(system, { name: 'socket', transport: () => pipe });
const streams = serveLinks(system, { maxFrame: 4096, accept: (on) => on({ readable: pipe, writable: pipe }) });
const tcpPort: number | undefined = serveLinks(system, { tcp: { port: 0 } }).port;
void streams, tcpPort;
for (const f of new FrameDecoder({ maxFrame: 1024 }).push(encodeFrame('{"t":"ping","at":1}'))) {
  if (typeof f === 'string') JSON.parse(f);
  else {
    const why: 'malformed' = f.reason;
    void why, f.length, f.detail;
  }
}
// @ts-expect-error a byte stream needs write()
createLink(system, { transport: () => ({ readable: pipe, writable: {} }) });

// hot reload and live migration
import { type Migration, type MigrationResult } from '..';
const version: number = system.reload(replying);
const m: Migration = system.migrate(replying, { wake: false, timeoutMs: 1000 });
const movedNow: number = m.migrated.length + m.pending.length;
m.done.then((r: MigrationResult) => {
  const left: (string | undefined)[] = r.pending.map((a) => a.address);
  void left, r.migrated, r.failed;
});
void version, movedNow;
// @ts-expect-error timeoutMs is a number
system.migrate(undefined, { timeoutMs: 'soon' });

// SCXML documents
{
  const doc = fromSCXML<{ count: number }>('<scxml xmlns="http://www.w3.org/2005/07/scxml" datamodel="ecmascript"/>', {
    documents: { 'child.scxml': '<scxml/>' },
  });
  const a = createActor(doc, { input: { count: 2 } }).start();
  const n: number = a.getSnapshot().context.count;
  a.send({ type: 'inc', by: 2 });
  a.send({ type: 'go', data: [1, 2] });
  // @ts-expect-error input overrides declared <data> only
  createActor(doc, { input: { other: 1 } });
  void n;
}

// system images, snapshots, batches
{
  const image = compileSystem('<system/>', { files: { 'a.scxml': '<scxml/>' } });
  const again: SystemImage = loadImage(image.bytes);
  const sys = createSystem({ restore: new Uint8Array(), machines: [counter] });
  const booted = sys.boot(again);
  const first: number = again.actors[0].chart;
  sys.sendMany([[booted.server, { type: 'go' }], [booted.client, 'ping']]);
  const bytes: Uint8Array = sys.snapshot();
  createActor(again.chart('pinger')).start();
  // @ts-expect-error restore takes bytes
  createSystem({ restore: 'snapshot' });
  void first;
  void bytes;
}
