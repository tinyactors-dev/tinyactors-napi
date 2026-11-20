// The application layer (ROADMAP.md, 8.6, items 1 to 9): Actor handles,
// host.actor and host.actors, onDone, onError and onHandlerError, the store
// and the resident bound, Actor.ask, Spawner, and the views' host and
// sender; each over the direct layer's calls, on both datamodels and both
// packages.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Actor, Address, Host, InvalidError, MemoryStore, Spawner, SQLiteStore, StaleError, StateError, TinyactorsError,
} from '@tinyactors/node';
import { CONFIG, ENDER, ENGINE, equal, hostWith, image, named, processor, scxml, status, throws, typeError, WAITER } from './charts.mjs';
import { run, test } from './harness.mjs';
import { runtime } from './runtime.mjs';

/** Ends on `go` with `_event.data` as its donedata. */
const FINISHER = scxml('finisher', `
  <state id="s"><transition event="go" target="done"/></state>
  <final id="done"><donedata><content expr="_event.data"/></donedata></final>`);

/** Answers `q` to `_event.origin` with `answer` and twice its data; stays. */
const ASKED = scxml('asked', `
  <state id="s">
    <transition event="q"><send targetexpr="_event.origin" event="answer"><content expr="_event.data * 2"/></send></transition>
    <transition event="silent"/>
  </state>`);

/** Counts `inc`s; `report` logs the count. */
const COUNTER = scxml('counter', `
  <datamodel><data id="n" expr="0"/></datamodel>
  <state id="s">
    <transition event="inc"><assign location="n" expr="n + 1"/></transition>
    <transition event="report"><log label="n" expr="n"/></transition>
  </state>`);

/** Asks the Spawner at entry for a room, and logs what it was answered. */
const WORKSPACE = (data) => scxml('workspace', `
  <state id="s">
    <onentry><send type="spawn" event="spawn" id="ask-room"><content expr="${data}"/></send></onentry>
    <transition event="spawned"><log label="spawned" expr="JSON.stringify(_event.data) + ' ' + _event.sendid"/></transition>
    <transition event="error.communication"><log label="refused" expr="_event.sendid"/></transition>
    <transition event="error.execution"><log label="execution" expr="''"/></transition>
  </state>`);

/** Logs its name and topic at entry, labelled `label`, and its name at
 * each `hello`, labelled `hello` and the label. */
const ROOM_OF = (label) => scxml('room', `
  <datamodel><data id="topic" expr="'none'"/></datamodel>
  <state id="s">
    <onentry><log label="${label}" expr="_name + ' ' + topic"/></onentry>
    <transition event="hello"><log label="hello ${label}" expr="_name"/></transition>
  </state>`);
const ROOM = ROOM_OF('room');

/** The log lines of a host, by label. */
function logged() {
  const lines = [];
  return { lines, log: (entry) => lines.push([entry.label, entry.text]), of: (label) => lines.filter(([l]) => l === label).map(([, t]) => t) };
}

test('spawn gives an Actor: its id, host and address, immutable, equal by session', async () => {
  const host = hostWith({ waiter: WAITER });
  const actor = host.spawn('waiter', { name: 'w' });
  equal(actor instanceof Actor, true, 'an Actor');
  equal(typeof actor.id, 'bigint', 'its id a session');
  equal(actor.host, host, 'its host');
  equal(host.system, 't', 'the host\'s system');
  equal(actor.address instanceof Address && actor.address.text, `tinyactors://t/#_scxml_${actor.id}`, 'its address');
  equal(Object.isFrozen(actor), true, 'immutable');
  equal(Object.keys(actor).join(), 'id', 'the host is not enumerable');
  equal(String(actor), `Actor(${actor.id})`, 'its text');
  const again = host.actor('w');
  equal(again === actor, false, 'a new Actor where the API returns one');
  equal(again.equals(actor) && actor.equals(again), true, 'equal by session');
  equal(actor.equals(host.spawn('waiter')), false, 'another session');
  equal(actor.equals({ id: actor.id, host }), false, 'not an Actor');
  throws(() => new Actor({}, 1n), typeError, 'an Actor of no Host');
  throws(() => new Actor(host, 0n), typeError, 'session 0');
  equal(new Actor(host, actor.id).equals(actor), true, 'made by hand');
  host.close();
});

test('host.actor finds a live actor by session, Actor, name and address; StaleError for none', async () => {
  const host = hostWith({ waiter: WAITER, ender: ENDER });
  const actor = host.spawn('waiter', { name: 'a b' });
  for (const which of [actor.id, Number(actor.id), actor, 'a b', actor.address, actor.address.text, Address.fromName('t', 'a b')]) {
    equal(host.actor(which).id, actor.id, `by ${typeof which === 'object' ? which.constructor.name : typeof which}`);
  }
  throws(() => host.actor('nobody'), (error) => {
    if (!(error instanceof StaleError)) throw error;
  }, 'no actor of that name');
  throws(() => host.actor(actor.id + 100n), (error) => {
    if (!(error instanceof StaleError)) throw error;
  }, 'no live session');
  throws(() => host.actor('tinyactors://t/@nobody'), (error) => {
    if (!(error instanceof StaleError)) throw error;
  }, 'an address of no actor');
  throws(() => host.actor('tinyactors://other/@a%20b'), (error) => {
    if (!(error instanceof InvalidError)) throw error;
  }, 'another system\'s address');
  throws(() => host.actor({}), typeError, 'not a session, a name or an address');
  const ender = host.spawn('ender', { name: 'e' });
  ender.send('go');
  await host.idle();
  throws(() => host.actor(ender.id), (error) => {
    if (!(error instanceof StaleError)) throw error;
  }, 'an actor that ended');
  host.close();
  throws(() => host.actor('a b'), (error) => {
    if (!(error instanceof StateError)) throw error;
  }, 'a closed host');
});

test('await host.actors() lists every live actor, or a chart\'s, a page at a time', async () => {
  const host = hostWith({ waiter: WAITER, counter: COUNTER });
  const waiters = Array.from({ length: 600 }, () => host.spawn('waiter'));
  const counters = Array.from({ length: 3 }, () => host.spawn('counter'));
  await host.idle();
  const all = await host.actors();
  equal(all.length, 603, 'every actor, past one page of 512');
  equal(all.every((actor) => actor instanceof Actor && actor.host === host), true, 'Actors of the host');
  const ids = (list) => list.map((actor) => actor.id).sort((a, b) => (a < b ? -1 : 1)).join();
  equal(ids(await host.actors({ chart: 'counter' })), ids(counters), 'the counters');
  equal((await host.actors({ chart: 'waiter' })).length, waiters.length, 'the waiters');
  equal((await host.actors({ chart: 'nothing' })).length, 0, 'a chart nobody runs');
  let refused;
  await host.actors({ chart: 1 }).catch((error) => { refused = error; });
  equal(refused instanceof TypeError, true, 'a chart that is not a name');
  host.close();
});

test('an Actor sends, terminates, and reads its state, context and get; a session param may be an Actor', async () => {
  const { log, of } = logged();
  const host = hostWith({ counter: COUNTER }, { log });
  const actor = host.spawn('counter');
  actor.send('inc');
  host.send(actor, 'inc');
  host.sendMany([{ target: actor, event: 'inc' }]);
  actor.send('report');
  await host.idle();
  equal(of('n').join(), '3', 'three incs, through the Actor, host.send and sendMany');
  equal((await actor.state()).value, 's', 'state');
  equal((await actor.context()).variables.n, 3, 'context');
  equal((await actor.get()).chart, 'counter', 'get');
  equal((await host.actorState({ session: actor })).value, 's', 'a typed method\'s session as an Actor');
  actor.terminate();
  await host.idle();
  throws(() => actor.send('inc'), status('TA_ERROR_STALE'), 'a send to an actor that ended');
  host.close();
});

test('actor.done and onDone: every top-level actor that ends, with its donedata', async () => {
  const done = [];
  const host = hostWith({ finisher: FINISHER, ender: ENDER }, { onDone: (actor, data) => done.push([actor, data]) });
  const first = host.spawn('finisher');
  const second = host.spawn('ender');
  const waited = first.done;
  equal(first.done, waited, 'the same promise while it is awaited');
  first.send('go', { n: 1, list: ['x'] });
  second.send('go');
  equal(JSON.stringify(await waited), '{"n":1,"list":["x"]}', 'actor.done settles with the donedata');
  await host.idle();
  equal(done.length, 2, 'onDone for each');
  const [[actor, data], [other, none]] = done.sort(([a], [b]) => (a.id < b.id ? -1 : 1));
  equal(actor instanceof Actor && actor.equals(first), true, 'onDone gets the Actor');
  equal(JSON.stringify(data), '{"n":1,"list":["x"]}', 'and the donedata');
  equal(other.equals(second) && none, undefined, 'no donedata: undefined');
  let stale;
  await first.done.catch((error) => { stale = error; });
  equal(stale instanceof StaleError, true, 'the done of an actor that ended: StaleError');
  const pending = host.spawn('finisher');
  let settled = false;
  pending.done.then(() => { settled = true; }, () => { settled = true; });
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  equal(settled, false, 'a done pending at close never settles');
});

test('onHandlerError gets a handler\'s error and its effect; the send is failed as without it', async () => {
  const errors = [];
  const { log, of } = logged();
  const chart = scxml('caller', `
    <state id="s">
      <onentry><send type="urn:out" event="out" id="x1"/></onentry>
      <transition event="error.communication"><log label="failed" expr="_event.sendid"/></transition>
      <transition event="later"><log label="later" expr="'late'"/></transition>
    </state>`);
  const boom = new Error('boom');
  const host = hostWith({ caller: chart }, {
    log,
    ioProcessors: { 'urn:out': processor(() => { throw boom; }) },
    onHandlerError: (error, effect) => errors.push([error, effect.event]), // the view is live in the hook
  });
  host.spawn('caller');
  await host.idle(); // resolves: the hook took the error
  equal(errors.length, 1, 'one error');
  equal(errors[0][0], boom, 'the handler\'s error');
  equal(errors[0][1], 'out', 'its effect, the send\'s view');
  equal(of('failed').join(), 'x1', 'the send was failed');
  // a promise that rejects goes to the hook too, not to unhandledRejection
  const rejected = hostWith({ caller: chart }, {
    ioProcessors: { 'urn:out': processor(async () => { throw boom; }) },
    onHandlerError: (error, effect) => errors.push([error, effect]), // a record: the promise's send
  });
  rejected.spawn('caller');
  await rejected.idle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  equal(errors.length, 2, 'the rejection');
  equal(errors[1][0], boom, 'its reason');
  rejected.close();
  // the hook's own error is the turn's
  const thrower = hostWith({ caller: chart }, {
    ioProcessors: { 'urn:out': processor(() => { throw boom; }) },
    onHandlerError: () => { throw new Error('the hook'); },
  });
  thrower.spawn('caller');
  let caught;
  await thrower.idle().catch((error) => { caught = error; });
  equal(caught?.message, 'the hook', 'idle() rejects with the hook\'s error');
  thrower.close();
  host.close();
});

test('a store and a resident bound: the surplus hibernated after a turn, a WAKE loads, wakes and deletes', async () => {
  const store = new MemoryStore();
  const { log, of } = logged();
  const host = hostWith({ counter: COUNTER }, { store, resident: 3, log });
  const actors = Array.from({ length: 10 }, () => host.spawn('counter'));
  await host.idle();
  equal(store.blobs.size, 7, 'ten actors, three resident, seven in the store');
  const resident = async () => { const { host: stats } = await host.hostStats(); return stats.actors - stats.hibernated; };
  equal(await resident(), 3, 'three in memory');
  for (const actor of actors) actor.send('inc');
  for (const actor of actors) actor.send('report');
  await host.idle();
  equal(of('n').join(), '1,1,1,1,1,1,1,1,1,1', 'every actor woke for its events, in turn');
  equal(await resident(), 3, 'and the bound holds after the turn');
  equal(store.blobs.size, 7, 'the blobs of the hibernated ones only');
  // an actor terminated while hibernated is woken to end, and its blob deleted
  const asleep = actors.find((actor) => store.blobs.has(actor.id));
  asleep.terminate();
  await host.idle();
  equal(store.blobs.has(asleep.id), false, 'its blob is gone');
  throws(() => host.actor(asleep.id), (error) => {
    if (!(error instanceof StaleError)) throw error;
  }, 'and so is the actor');
  host.close();
  throws(() => hostWith({ counter: COUNTER }, { resident: 1 }), typeError, 'resident without a store');
  throws(() => hostWith({ counter: COUNTER }, { store, resident: 0 }), typeError, 'resident 0');
});

test('a store whose save throws wakes the actor back; one whose methods return promises is awaited', async () => {
  const errors = [];
  const failing = { save() { throw new Error('disk full'); }, load() { throw new Error('never'); }, delete() {} };
  const host = hostWith({ counter: COUNTER }, { store: failing, resident: 1, onHandlerError: (error) => errors.push(error.message) });
  host.spawn('counter');
  host.spawn('counter');
  await host.idle();
  equal(errors[0], 'disk full', 'the save\'s error');
  const { host: stats } = await host.hostStats();
  equal(stats.hibernated, 0, 'the actor was woken back from its blob');
  host.close();
  // asynchronous: save, load and delete return promises
  const blobs = new Map();
  const later = () => new Promise((resolve) => setTimeout(resolve, 1));
  const slow = {
    save: async (session, blob) => { await later(); blobs.set(session, blob); },
    load: async (session) => { await later(); return blobs.get(session); },
    delete: async (session) => { await later(); blobs.delete(session); },
  };
  const { log, of } = logged();
  const other = hostWith({ counter: COUNTER }, { store: slow, resident: 1, log });
  const actors = [other.spawn('counter'), other.spawn('counter'), other.spawn('counter')];
  await other.idle(); // waits for the saves
  equal(blobs.size, 2, 'saved');
  for (const actor of actors) actor.send('report');
  await other.idle(); // waits for the loads
  equal(of('n').join(), '0,0,0', 'loaded and woken from the promises');
  equal(blobs.size, 2, 'the surplus saved again');
  other.close();
});

test('SQLiteStore keeps the blobs in the runtime\'s SQLite', async () => {
  if (runtime === 'browser') return; // a page has no SQLite: the wasm package refuses it there
  const directory = mkdtempSync(join(tmpdir(), 'tinyactors-sqlite-'));
  try {
    const store = new SQLiteStore(join(directory, 'blobs.db'));
    const { log, of } = logged();
    const host = hostWith({ counter: COUNTER }, { store, resident: 2, log });
    const actors = Array.from({ length: 5 }, () => host.spawn('counter'));
    await host.idle();
    const rows = () => store.database.prepare('SELECT COUNT(*) AS n FROM tinyactors_blobs').get().n;
    equal(Number(rows()), 3, 'three rows');
    for (const actor of actors) actor.send('inc');
    for (const actor of actors) actor.send('report');
    await host.idle();
    equal(of('n').join(), '1,1,1,1,1', 'every actor came back');
    host.close();
    store.save((1n << 64n) - 1n, new Uint8Array([1, 2]));
    equal(Array.from(store.load((1n << 64n) - 1n)).join(), '1,2', 'a session past 2^63');
    store.delete((1n << 64n) - 1n);
    throws(() => store.load(7n), (error) => {
      if (!(error instanceof StaleError)) throw error;
    }, 'no blob');
    store.close();
    throws(() => new SQLiteStore(7), typeError, 'not a path');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ask: the reply to _event.origin settles the promise with [event, data], past the application\'s transport', async () => {
  const sent = [];
  const host = hostWith({ asked: ASKED }, { transport: (send) => sent.push(send.target.text) });
  const actor = host.spawn('asked');
  equal(JSON.stringify(await actor.ask('q', 21)), '["answer",42]', 'the reply');
  equal(sent.length, 0, 'the transport saw nothing');
  const both = await Promise.all([actor.ask('q', 1), actor.ask('q', 2)]);
  equal(JSON.stringify(both), '[["answer",2],["answer",4]]', 'each ask its own reply');
  // a signal aborts it: the row goes, and a late reply is dropped
  const controller = new AbortController();
  const silent = actor.ask('silent', undefined, { signal: controller.signal });
  controller.abort(new Error('gave up'));
  let reason;
  await silent.catch((error) => { reason = error; });
  equal(reason?.message, 'gave up', 'rejected with the signal\'s reason');
  let aborted;
  await actor.ask('q', 1, { signal: controller.signal }).catch((error) => { aborted = error; });
  equal(aborted?.message, 'gave up', 'an aborted signal refuses at once');
  // a reply to an address the binding never handed out is dropped
  host.send(actor, 'q', 5, { origin: 'tinyactors://tinyactors-ask/@123456789' });
  await host.idle();
  equal(sent.length, 0, 'a stale handle: dropped');
  let refused;
  await actor.ask(7).catch((error) => { refused = error; });
  equal(refused instanceof TypeError, true, 'an event that is not a string');
  const gone = host.spawn('asked');
  gone.terminate();
  await host.idle();
  let stale;
  await gone.ask('q', 1).catch((error) => { stale = error; });
  equal(stale instanceof StaleError, true, 'an actor that ended: refused at the call');
  const pending = actor.ask('silent');
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  equal(settled, false, 'an ask pending at close never settles');
});

test('Spawner: a chart spawns through it, answered spawned {name, address} with its sendid, or error.communication', async () => {
  const { log, of } = logged();
  const host = new Host(image({ workspace: WORKSPACE("({ chart: 'room', name: 'lobby', params: { topic: 'news' } })"), room: ROOM }), {
    ...CONFIG, ...ENGINE, log, ioProcessors: { spawn: new Spawner() },
  });
  host.spawn('workspace');
  await host.idle();
  const lobby = host.actor('lobby');
  equal(of('room').join(), 'lobby news', 'the room ran its params');
  equal(of('spawned').join(), `{"name":"lobby","address":"${lobby.address.text}"} ask-room`, 'the answer, its sendid');
  host.close();
  const bad = new Host(image({ workspace: WORKSPACE("({ chart: 'nothing' })"), room: ROOM }), {
    ...CONFIG, ...ENGINE, log, ioProcessors: { spawn: new Spawner() },
  });
  bad.spawn('workspace');
  await bad.idle();
  equal(of('refused').join(), 'ask-room', 'a chart the host does not have: error.communication with its sendid');
  bad.close();
  const shapeless = new Host(image({ workspace: WORKSPACE("'room'"), room: ROOM }), {
    ...CONFIG, ...ENGINE, log, ioProcessors: { spawn: new Spawner() },
  });
  shapeless.spawn('workspace');
  await shapeless.idle();
  equal(of('refused').length, 2, 'data of another shape: refused');
  shapeless.close();
  const undeclared = new Host(image({ workspace: WORKSPACE("({ chart: 'room' })"), room: ROOM }), { ...CONFIG, ...ENGINE, log });
  undeclared.spawn('workspace');
  await undeclared.idle();
  equal(of('execution').length, 1, 'no processor of that type: error.execution, as SCXML has it');
  undeclared.close();
});

test('Spawner: a spawn after a deploy runs the new version under the name; the old actor keeps its session', async () => {
  const { log, of } = logged();
  const host = new Host(image({ workspace: WORKSPACE("({ chart: 'room', name: 'lobby', params: { topic: 'news' } })"), room: ROOM }), {
    ...CONFIG, ...ENGINE, log, ioProcessors: { spawn: new Spawner() },
  });
  host.spawn('workspace');
  await host.idle();
  const old = host.actor('lobby');
  host.addImage(image({ room: ROOM_OF('room2') })); // the deploy
  host.spawn('workspace'); // a workspace asks for the lobby again
  await host.idle();
  const lobby = host.actor('lobby');
  equal(lobby.equals(old), false, 'the name finds the new actor: newest version first');
  equal(of('room2').join(), 'lobby news', 'the new version ran');
  equal(of('spawned')[1], `{"name":"lobby","address":"${lobby.address.text}"} ask-room`, 'answered with the new actor');
  old.send('hello');
  lobby.send('hello');
  await host.idle();
  equal(of('hello room').join(), 'lobby', 'the old actor answers at its session address, on its version');
  equal(of('hello room2').join(), 'lobby', 'the new one on the new version');
  host.close();
});

test('a view and a record have their host; send.sender is the sending Actor', async () => {
  const seen = [];
  const chart = scxml('teller', `
    <state id="s"><onentry><log label="hi" expr="'x'"/><send type="urn:out" event="out"/></onentry>
      <invoke type="urn:svc" src="here"/></state>`);
  const host = hostWith({ teller: chart }, {
    log: (entry) => seen.push(['log', entry.host]),
    ioProcessors: { 'urn:out': processor((send) => seen.push(['send', send.host, send.sender])) },
    services: { 'urn:svc': (invocation) => (seen.push(['invocation', invocation.host]), {}) },
  });
  const actor = host.spawn('teller');
  await host.idle();
  equal(seen.length, 3, 'three effects');
  equal(seen.every(([, of]) => of === host), true, 'each has the host');
  const [, , sender] = seen.find(([kind]) => kind === 'send');
  equal(sender instanceof Actor && sender.equals(actor), true, 'the sender');
  host.close();
  equal(seen[0][1].closed, true, 'a view\'s host after close: the closed host');
});

test('the options are the API\'s: removed ones refused, config never holds the system id or the processors', () => {
  for (const option of ['wake', 'systemID']) {
    throws(() => new Host([], { ...CONFIG, [option]: () => {} }), typeError, `${option}`);
  }
  throws(() => new Host([], { ...CONFIG, config: { systemID: 't' } }), typeError, 'config.systemID');
  throws(() => new Host([], { ...CONFIG, ioProcessors: { x: () => {} } }), typeError, 'a processor that is a function');
  throws(() => new Host([], { system: 'tinyactors-ask' }), (error) => {
    if (!(error instanceof TinyactorsError) || error.status !== 'TA_ERROR_INVALID') throw error;
  }, 'the system id ask() reserves');
  equal(named(new Host([], CONFIG), 'x'), undefined, 'a host of no chart');
});

await run();
