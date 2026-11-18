// The Host and its memory (docs/plan.xml, p1-host): creation from a config
// and options, a refused config as core's error, close twice, the dispose
// symbols, the type tag, and a dropped host whose handlers close over it
// collected with its memory freed. The inputs (p1-compile): addImage,
// chart, spawn, send in both shapes, fail, sendMany, terminate,
// actorByName, each with its refusals, and TA_EFFECT_REQUEST answered in C.
import { Host, TinyactorsError } from '@tinyactors/node';
import { CONFIG, ENDER, ENGINE, WAITER, hostWith, image, scxml, status, until } from './charts.mjs';
import { collect, run, test } from './harness.mjs';
import { wasm } from './runtime.mjs';

const QUICKJS = { datamodel: 'quickjs' };


function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: ${actual}, expected ${expected}`);
}

function throws(body, check, what) {
  try {
    body();
  } catch (error) {
    check(error);
    return;
  }
  throw new Error(`${what}: not refused`);
}

test('a host reads ticksPerSecond from its effective config', () => {
  const host = new Host({ systemID: 't', system: { ticksPerSecond: 1000 } }, ENGINE);
  equal(host.ticksPerSecond, 1000, 'ticksPerSecond');
  equal(host.closed, false, 'closed');
  host.close();
  const defaults = new Host({ systemID: 't' }, ENGINE);
  equal(defaults.ticksPerSecond, 1e9, 'the default rate, core\'s');
  defaults.close();
});

test('a refused config throws core\'s error', () => {
  throws(() => new Host({ systemID: 't', x: 1 }, ENGINE), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
    equal(error.code, -32602, 'code');
    equal(error.reason, 'unknown', 'reason');
    equal(error.path, 'x', 'path');
    equal(error.status, 'TA_ERROR_INVALID', 'status');
  }, 'an unknown key');
  throws(() => new Host('not a map', ENGINE), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'a config that is not a map');
});

test('a host that names no datamodel gets the native one', async () => {
  // The native datamodel is the application's engine (V8 or
  // JavaScriptCore, with WebAssembly); quickjs has none.
  const chart = scxml('out', `
    <state id="s"><onentry><send event="out" type="urn:out" target="x"><content expr="typeof WebAssembly"/></send></onentry></state>`);
  const seen = {};
  for (const options of [undefined, {}, { datamodel: 'native' }, QUICKJS]) {
    const host = new Host({ systemID: 't', ioProcessors: [{ type: 'urn:out' }] }, {
      ...options,
      ioProcessors: { 'urn:out': (h, send) => { seen[options?.datamodel ?? String(options)] = send.data; } },
    });
    host.addImage(image({ out: chart }));
    host.spawn(host.chart('out'));
    await host.idle();
    host.close();
  }
  equal(JSON.stringify(seen), JSON.stringify({ undefined: 'object', '[object Object]': 'object', native: 'object', quickjs: 'undefined' }), 'which datamodel ran');
});

test('quickjsHeapBytes is the quickjs engine\'s heap; undefined on a native host and once closed', async () => {
  const chart = scxml('hog', `
    <datamodel><data id="kept" expr="[]"/></datamodel>
    <state id="s"><transition event="grow"><script>for (let i = 0; i &lt; 20000; i++) kept.push({ i })</script></transition></state>`);
  const native = new Host(CONFIG, { datamodel: 'native' });
  equal(native.quickjsHeapBytes, undefined, 'a native host');
  native.close();
  const host = new Host(CONFIG, QUICKJS);
  host.addImage(image({ hog: chart }));
  const session = host.spawn(host.chart('hog'));
  await host.idle();
  const before = host.quickjsHeapBytes;
  if (!(typeof before === 'number' && before > 0)) throw new Error(`a quickjs host's heap reads ${before}`);
  host.send(session, 'grow');
  await host.idle();
  const after = host.quickjsHeapBytes;
  if (!(after > before + 20000 * 16)) throw new Error(`20,000 objects kept: the heap went from ${before} to ${after} bytes`);
  host.close();
  equal(host.quickjsHeapBytes, undefined, 'a closed host');
});

test('options are checked', () => {
  const typeError = (error) => {
    if (!(error instanceof TypeError)) throw error;
  };
  const config = { systemID: 't', ioProcessors: [{ type: 'urn:x' }] };
  throws(() => new Host(config, { ...ENGINE, bogus: 1 }), typeError, 'an unknown option');
  throws(() => new Host(config, { datamodel: 'v8' }), typeError, 'an unknown datamodel');
  throws(() => new Host(config, { ...ENGINE, log: 1 }), typeError, 'a handler that is not a function');
  throws(() => new Host(config, { ...ENGINE, ioProcessors: { 'urn:nope': () => {} } }), typeError,
    'a type the config lacks');
  throws(() => new Host(config, { ...ENGINE, ioProcessors: { 'urn:x': 1 } }), typeError, 'a processor not a function');
  throws(() => new Host(config, { datamodel: 'native', quickjs: {} }), typeError, 'quickjs limits on a native host');
  throws(() => new Host(config, { quickjs: {} }), typeError, 'quickjs limits on a host of the default datamodel');
  throws(() => new Host(config, { ...QUICKJS, quickjs: { maxOps: -1 } }), typeError, 'a negative maxOps');
  throws(() => new Host(config, { ...QUICKJS, quickjs: { realm: 'shared' } }), typeError, 'an unknown realm');
  throws(() => new Host(config, { ...QUICKJS, quickjs: { heap: 1 } }), typeError, 'an unknown quickjs option');
  throws(() => Host(config, ENGINE), typeError, 'a call without new');
  const host = new Host(config, {
    ...QUICKJS,
    ioProcessors: { 'urn:x': () => {} },
    quickjs: { maxOps: 1000, memoryLimit: 1 << 26, stackLimit: 1 << 20, realm: 'isolated' },
  });
  host.close();
});

test('close twice, and the dispose symbols', async () => {
  const host = new Host({ systemID: 't' }, ENGINE);
  host.close();
  host.close();
  equal(host.closed, true, 'closed');
  equal(host.ticksPerSecond, 1e9, 'ticksPerSecond after close');
  const disposed = new Host({ systemID: 't' }, ENGINE);
  disposed[Symbol.dispose]();
  equal(disposed.closed, true, 'closed by Symbol.dispose');
  disposed[Symbol.dispose]();
  const awaited = new Host({ systemID: 't' }, ENGINE);
  const promise = awaited[Symbol.asyncDispose]();
  if (!(promise instanceof Promise)) throw new Error('asyncDispose gave no promise');
  equal(await promise, undefined, 'asyncDispose\'s value');
  equal(awaited.closed, true, 'closed by Symbol.asyncDispose');
});

test('the handlers are the wrapper\'s, under a symbol, and go at close', () => {
  const log = () => {};
  const host = new Host({ systemID: 't' }, { ...ENGINE, log });
  equal(Object.keys(host).length, 0, 'enumerable own keys');
  const [key] = Object.getOwnPropertySymbols(host);
  equal(host[key].log, log, 'the log handler');
  host.close();
  equal(host[key], undefined, 'the handlers after close');
});

test('a method on another object is refused by the type tag', () => {
  const close = Host.prototype.close;
  for (const self of [{}, Object.create(Host.prototype), new Error('x')]) {
    throws(() => close.call(self), (error) => {
      if (!(error instanceof TypeError)) throw error;
    }, 'close on another object');
  }
  const getter = Object.getOwnPropertyDescriptor(Host.prototype, 'closed').get;
  throws(() => getter.call({}), (error) => {
    if (!(error instanceof TypeError)) throw error;
  }, 'closed on another object');
});

/** 50 hosts whose handlers close over them, dropped; how many were made. */
function dropHosts(registry) {
  for (let i = 0; i < 50; i++) {
    const box = {};
    const host = new Host({ systemID: 't' }, {
      ...ENGINE,
      log: () => box.host, // handler -> box -> host -> handlers -> handler
      ioProcessors: {},
    });
    box.host = host;
    registry.register(host, i);
  }
}

test('a dropped host whose handlers close over it is collected and frees its memory', async () => {
  await collect();
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  if (wasm) {
    // @tinyactors/wasm: linear memory never shrinks (docs/browser.md,
    // "Memory"), so a freed host shows as memory the next hosts reuse: 50
    // more after the collection leave the module's memory where it was
    const { instance } = await import('../wasm/lib/state.mjs');
    const memory = () => instance().bytes().byteLength;
    dropHosts(registry);
    await collect();
    equal(collected, 50, 'hosts collected');
    const peak = memory();
    await new Promise((resolve) => setTimeout(() => {
      dropHosts(registry); // from a task of its own: bun's collector scans the stack
      resolve();
    }, 0));
    for (let i = 0; i < 5 && collected < 100; i++) await collect(); // bun's conservative scan may keep one a while
    equal(collected, 100, 'hosts collected again');
    equal(memory(), peak, 'linear memory after 50 more hosts, the first ones freed');
    return;
  }
  const before = process.memoryUsage().external;
  dropHosts(registry);
  const during = process.memoryUsage().external;
  await collect();
  equal(collected, 50, 'hosts collected');
  // The host's blocks are reported with napi_adjust_external_memory. Bun
  // counts them in memoryUsage().external; node 22 does not show them
  // there (its own counter returns to where it was: log entry
  // l-p1-host-node-external), so the memory check is made where it shows.
  if (during - before > 50 * 1024) {
    const after = process.memoryUsage().external;
    if (after - before > (during - before) / 10) {
      throw new Error(`external memory: ${before} before, ${during} with the hosts, ${after} after`);
    }
  }
});

test('one 2 MB send leaves the host arena under its cap', async () => {
  // A call's scratch is its arena's, a mark per call; when the outermost
  // call releases an arena that keeps more than its cap (256 KB for a
  // host's, 64 KB for the environment's), its chunks go back. A send to
  // quickjs writes its data as CBOR there: without the cap one send of
  // 2 MB kept about 6.4 MB for the host's life. Neither runtime shows the
  // addon's blocks in a counter that stays (log entry
  // l-p1-host-node-external), so the test reads the resident set over 16
  // hosts: about 100 MB more without the cap, at most 21 MB with it
  // (docs/allocation.md, finding 7). @tinyactors/wasm's blocks are in its
  // linear memory, which never shrinks, so there the test reads its size
  // (the resident set is that memory's pages as they are touched, and the
  // engine's heap beside it). The first host's large send is made before
  // the reading: the linear memory grows once to the peak of one such send
  // (about 46 MB with quickjs's copy of the value) and keeps it, reused by
  // every later block, so the 15 hosts after it show what each keeps, in
  // both packages (without the cap about 15 times 6.4 MB).
  const big = Array.from({ length: 200_000 }, (_, i) => `item${i}`);
  const CHART = scxml('big', `
  <datamodel><data id="d" expr="0"/></datamodel>
  <state id="s"><transition event="x"><assign location="d" expr="_event.data.length"/></transition></state>`);
  const bytes = image({ big: CHART });
  const hosts = [];
  for (let i = 0; i < 16; i++) {
    const host = new Host(CONFIG, QUICKJS);
    host.addImage(bytes);
    const session = host.spawn(host.chart('big'));
    host.send(session, 'x', [1]);
    await host.idle();
    hosts.push({ host, session });
  }
  const sendBig = async ({ host, session }) => {
    host.send(session, 'x', big);
    await host.idle();
    host.send(session, 'x', [1]); // _event lets the large value go
    await host.idle();
  };
  let kept = () => process.memoryUsage.rss();
  if (wasm) {
    const { instance } = await import('../wasm/lib/state.mjs');
    kept = () => instance().bytes().byteLength;
  }
  await sendBig(hosts[0]);
  await collect();
  const before = kept();
  for (const entry of hosts.slice(1)) await sendBig(entry);
  await collect();
  const grown = kept() - before;
  for (const { host } of hosts) host.close();
  if (grown > 50e6) throw new Error(`15 sends of 2 MB after the first kept ${(grown / 1e6).toFixed(1)} MB ${wasm ? 'more linear memory' : 'resident'}`);
});

// ---- inputs ----------------------------------------------------------------

const typeError = (error) => {
  if (!(error instanceof TypeError)) throw error;
};
const gone = (host, name) => until(() => host.actorByName(name) === undefined);

test('addImage takes a Uint8Array, a Buffer or an ArrayBuffer, and returns the segment', () => {
  const bytes = image({ waiter: WAITER });
  const host = new Host({ systemID: 't' }, ENGINE);
  equal(host.addImage(bytes), 0, 'a Buffer');
  equal(host.addImage(new Uint8Array(bytes)), 1, 'a Uint8Array');
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  equal(host.addImage(buffer), 2, 'an ArrayBuffer');
  bytes.fill(0); // the host copied them
  equal(host.chart('waiter').segment, 2, 'the newest segment runs the chart');
  throws(() => host.addImage(new Uint8Array([1, 2, 3])), status('TA_ERROR_INVALID'), 'bytes that are no image');
  for (const value of [undefined, 'image', [1, 2], new Uint16Array(4), new DataView(buffer)]) {
    throws(() => host.addImage(value), typeError, `addImage(${Object.prototype.toString.call(value)})`);
  }
  host.close();
});

test('chart gives a frozen reference; an unknown name is refused', () => {
  const host = hostWith({ waiter: WAITER, ender: ENDER });
  const ref = host.chart('ender');
  equal(Object.isFrozen(ref), true, 'frozen');
  equal(ref.segment, 0, 'segment');
  equal(ref.chart, 1, 'chart');
  throws(() => host.chart('missing'), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'an unknown chart');
  throws(() => host.chart(1), typeError, 'a name that is not a string');
  host.close();
});

test('spawn: a session, its name, its params, its options', async () => {
  const counter = scxml('counter', `
    <datamodel><data id="x"/></datamodel>
    <state id="s"><transition event="go" cond="x === 7" target="done"/></state>
    <final id="done"/>`);
  const host = hostWith({ counter, waiter: WAITER });
  const session = host.spawn(host.chart('counter'), { name: 'a', params: { x: 7 }, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
  equal(typeof session, 'bigint', 'a bigint');
  equal(host.actorByName('a'), session, 'by name');
  host.send(session, 'go');
  if (!(await gone(host, 'a'))) throw new Error('the params did not reach the actor');
  const other = host.spawn(host.chart('waiter'), { traceparent: 'not w3c' }); // a new trace
  if (other <= session) throw new Error('sessions grow');
  host.spawn(host.chart('waiter'));
  host.spawn(host.chart('waiter'), {});
  throws(() => host.spawn(host.chart('waiter'), { nam: 'a' }), typeError, 'an unknown option');
  throws(() => host.spawn(host.chart('waiter'), 'a'), typeError, 'options that are not an object');
  throws(() => host.spawn(host.chart('waiter'), { name: 1 }), typeError, 'a name that is not a string');
  throws(() => host.spawn(host.chart('waiter'), { params: () => 1 }), status('TA_ERROR_UNSUPPORTED'), 'params outside the value table');
  for (const ref of [undefined, 'waiter', {}, { segment: 0 }, { segment: -1, chart: 0 }, { segment: 0, chart: 0.5 }]) {
    throws(() => host.spawn(ref), typeError, `spawn(${JSON.stringify(ref)})`);
  }
  throws(() => host.spawn({ segment: 0, chart: 9 }), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'a chart the segment does not have');
  host.close();
});

test('params for a chart whose datamodel takes no data are refused', () => {
  const host = hostWith({ empty: scxml('empty', '<state id="s"/>', { datamodel: 'null' }) });
  host.spawn(host.chart('empty'));
  throws(() => host.spawn(host.chart('empty'), { params: { x: 1 } }), typeError, 'params for the null datamodel');
  host.close();
});

test('send: a session or a local address, data, options, and the message shape', async () => {
  const host = hostWith({ waiter: WAITER });
  const ref = host.chart('waiter');
  const first = host.spawn(ref, { name: 'first' });
  host.send(first, 'go', { n: 1 }, { sendid: 'id-1', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
  if (!(await gone(host, 'first'))) throw new Error('a send to a session');
  const second = host.spawn(ref, { name: 'second' });
  host.send(`tinyactors://t/#_scxml_${second}`, 'go', { n: 1 });
  if (!(await gone(host, 'second'))) throw new Error('a send to a session\'s address');
  host.spawn(ref, { name: 'third' });
  host.send('tinyactors://t/@third', 'go', { n: 1 }, { origin: 'tinyactors://other/@x' });
  if (!(await gone(host, 'third'))) throw new Error('a send to a name\'s address');
  const fourth = host.spawn(ref, { name: 'fourth' });
  host.send({ target: fourth, event: 'go', data: { n: 1 }, sendid: 's', origin: undefined, traceparent: undefined, later: 1 });
  if (!(await gone(host, 'fourth'))) throw new Error('send(message)');
  host.close();
});

test('send refuses what it cannot take, and keeps nothing of it', () => {
  const host = hostWith({ waiter: WAITER });
  const session = host.spawn(host.chart('waiter'), { name: 'w' });
  throws(() => host.send(2 ** 53, 'go'), typeError, 'a session as a number past 2^53-1');
  throws(() => host.send(Number(session) + 0.5, 'go'), typeError, 'a session as a fraction');
  throws(() => host.send(-1n, 'go'), typeError, 'a negative session');
  throws(() => host.send(0n, 'go'), typeError, 'session 0, core\'s none');
  throws(() => host.send(1n << 64n, 'go'), typeError, 'a session past 64 bits');
  throws(() => host.send(session, 1), typeError, 'an event that is not a string');
  throws(() => host.send(session, 'go', undefined, { sendID: 'x' }), typeError, 'an unknown option');
  throws(() => host.send(session, 'go', undefined, { sendid: 1 }), typeError, 'a sendid that is not a string');
  throws(() => host.send(session, 'go', new Date()), status('TA_ERROR_UNSUPPORTED'), 'data outside the value table');
  throws(() => host.send(session, 'go', Symbol('s')), status('TA_ERROR_UNSUPPORTED'), 'a symbol');
  throws(() => host.send(session, 'go', { nested: Symbol('s') }), status('TA_ERROR_UNSUPPORTED'), 'a symbol inside a value');
  throws(() => host.send(session, '\uD800'), status('TA_ERROR_INVALID'), 'a lone surrogate');
  throws(() => host.send(session + 100n, 'go', { n: 1 }), status('TA_ERROR_STALE'), 'data for no session');
  throws(() => host.send(session + 100n, 'go'), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'no session');
  throws(() => host.send('tinyactors://t/@nobody', 'go'), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'an address of no actor');
  throws(() => host.send({ event: 'go' }), typeError, 'a message without a target');
  throws(() => host.send({ target: session }), typeError, 'a message without an event');
  equal(host.actorByName('w'), session, 'the actor waits on');
  host.close();
});

test('fail gives the sender error.communication', async () => {
  const sender = scxml('sender', `
    <state id="s"><transition event="error.communication" cond="_event.sendid === 'out-1'" target="done"/></state>
    <final id="done"/>`);
  const host = hostWith({ sender });
  const session = host.spawn(host.chart('sender'), { name: 'sender' });
  host.fail(session, 'out-1');
  if (!(await gone(host, 'sender'))) throw new Error('error.communication with the sendid');
  host.spawn(host.chart('sender'), { name: 'again' });
  host.fail('tinyactors://t/@again'); // no sendid: the condition does not hold
  host.fail('tinyactors://t/@again', 'out-1');
  if (!(await gone(host, 'again'))) throw new Error('fail by address');
  throws(() => host.fail(1.5, 'x'), typeError, 'a target that is not a session');
  host.close();
});

test('sendMany returns the accepted prefix, in slices', async () => {
  const host = hostWith({ waiter: WAITER });
  const ref = host.chart('waiter');
  const sessions = [];
  for (let i = 0; i < 300; i++) sessions.push(host.spawn(ref, { name: `w${i}` }));
  const accepted = host.sendMany(sessions.map((target) => ({ target, event: 'go', data: { n: 1 } })));
  if (!Number.isInteger(accepted) || accepted < 1 || accepted > 300) throw new Error(`accepted ${accepted}`);
  if (!(await until(() => host.actorByName(`w${accepted - 1}`) === undefined))) throw new Error('the accepted ones did not run');
  equal(host.sendMany([]), 0, 'none');
  throws(() => host.sendMany({ target: sessions[0], event: 'go' }), typeError, 'not an array');
  throws(() => host.sendMany([{ target: sessions[0], event: 'go' }, { event: 'go' }]), typeError, 'an item without a target');
  throws(() => host.sendMany([1]), typeError, 'an item that is not a message');
  host.close();
});

test('terminate ends an actor; a session that is gone is refused', async () => {
  const host = hostWith({ waiter: WAITER });
  const session = host.spawn(host.chart('waiter'), { name: 'w' });
  host.terminate(session);
  if (!(await gone(host, 'w'))) throw new Error('terminated');
  throws(() => host.terminate(session), (error) => {
    if (!(error instanceof TinyactorsError)) throw error;
  }, 'terminate again');
  throws(() => host.terminate(1.5), typeError, 'a session that is not an integer');
  equal(host.actorByName('nobody'), undefined, 'no actor of that name');
  throws(() => host.actorByName(1n), typeError, 'a name that is not a string');
  host.close();
});

test('every input of a closed host is refused', () => {
  const host = hostWith({ waiter: WAITER });
  const ref = host.chart('waiter');
  host.close();
  for (const [name, call] of Object.entries({
    addImage: () => host.addImage(new Uint8Array(1)),
    chart: () => host.chart('waiter'),
    boot: () => host.boot(0),
    spawn: () => host.spawn(ref),
    send: () => host.send(1n, 'go'),
    fail: () => host.fail(1n),
    sendMany: () => host.sendMany([]),
    terminate: () => host.terminate(1n),
    actorByName: () => host.actorByName('w'),
  })) throws(call, status('TA_ERROR_STATE'), name);
});

test('a run-time fetch (TA_EFFECT_REQUEST) is answered in C: the parent gets error.execution', async () => {
  const parent = scxml('parent', `
    <state id="s">
      <invoke type="scxml" srcexpr="'missing.scxml'"/>
      <transition event="error.execution" target="done"/>
    </state>
    <final id="done"/>`);
  const host = hostWith({ parent });
  host.spawn(host.chart('parent'), { name: 'parent' });
  if (!(await gone(host, 'parent'))) throw new Error('no error.execution for the fetch');
  host.close();
});

await run();
