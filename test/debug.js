'use strict';

// The debug adapter (lib/debug.js; napi ADR 0026), driven by a scripted
// DAP client: every request it implements and every one it refuses, the
// permissions, the audit hook, the live view (one entry stop, then a
// refresh after each macrostep), pokes, breakpoints as tracepoints, the
// console, scopes, modules and sources, and the base protocol's framing.
// The actor is never stopped. Runs on Node and Bun.

const assert = require('node:assert/strict');
const {
  createSystem, statechart, createDebugSession, DAPReader, encodeDAPMessage, TinyactorsError,
} = require('..');
const { core } = require('../lib/native');
const { nativeOf } = require('../lib/system');

const watchdog = setTimeout(() => {
  console.error('debug.js: timed out');
  process.exit(1);
}, 60000);

const turn = () => new Promise((resolve) => setImmediate(resolve));
const ALL = ['send', 'set', 'goto', 'evaluate'];

// A scripted client: requests in order, and every message the session sent.
class Client {
  constructor(system, options) {
    this.messages = [];
    this.audit = [];
    this.seq = 0;
    this.session = createDebugSession(system, {
      audit: (entry) => this.audit.push(entry),
      ...options,
      send: (message) => this.messages.push(message),
    });
  }

  async request(command, args = {}) {
    this.seq += 1;
    const seq = this.seq;
    await this.session.receive({ seq, type: 'request', command, arguments: args });
    const response = this.messages.find((message) => message.type === 'response' && message.request_seq === seq);
    assert.ok(response !== undefined, `${command} was answered`);
    assert.equal(response.command, command);
    return response;
  }

  async ok(command, args) {
    const response = await this.request(command, args);
    assert.ok(response.success, `${command} failed: ${response.message}`);
    return response.body;
  }

  async refused(command, args, pattern) {
    const response = await this.request(command, args);
    assert.equal(response.success, false, `${command} should be refused`);
    assert.equal(response.body.error.format, response.message);
    if (pattern !== undefined) assert.match(response.message, pattern);
    return response.message;
  }

  events(name) {
    return this.messages.filter((message) => message.type === 'event' && message.event === name)
      .map((message) => message.body);
  }

  output() {
    return this.events('output').map((body) => body.output).join('');
  }

  mark() {
    return this.messages.length;
  }

  since(mark, name) {
    return this.messages.slice(mark).filter((message) => message.type === 'event' && message.event === name)
      .map((message) => message.body);
  }

  outputSince(mark) {
    return this.since(mark, 'output').map((body) => body.output).join('');
  }

  async until(predicate, what) {
    for (let tries = 0; tries < 500; tries += 1) {
      if (predicate()) return;
      await turn();
    }
    assert.fail(`timed out waiting for ${what}; the session wrote:\n${this.output()}`);
  }

  // Waits for output since `mark` that matches.
  async wrote(mark, pattern) {
    await this.until(() => pattern.test(this.outputSince(mark)), `output matching ${pattern}`);
  }

  async repl(text) {
    return this.ok('evaluate', { expression: text, context: 'repl' });
  }

  async start(attach) {
    const capabilities = await this.ok('initialize', { clientID: 'test', adapterID: 'tinyactors',
                                                        supportsInvalidatedEvent: true });
    await this.ok('attach', attach);
    await this.ok('configurationDone');
    return capabilities;
  }

  // The session never stops the actor: the entry stop, and one after each
  // continue, are all a client ever hears.
  assertNeverStopped() {
    for (const stop of this.events('stopped')) {
      assert.equal(stop.reason, 'entry', JSON.stringify(stop));
    }
    assert.equal(this.events('continued').length, 0);
  }
}

// A subscription: active --payment.failed--> past_due (counting failures,
// arming a retry and answering the sender), past_due --paid--> active;
// `boom` fails a script; `spin` never ends; `remind` arms a delayed send.
function subscription(revision = 'v1') {
  return statechart({ family: 'subscription', revision })
    .data('failures', 0)
    .data('plan', { name: 'basic', seats: 2 })
    .data('log', [])
    .state('active', (s) =>
      s
        .on('payment.failed', (t) =>
          t.target('past_due').assign('failures', function () { return this.failures + 1; }))
        .on('boom', (t) => t.script(function () { throw new Error('boom'); }))
        .on('spin', (t) => t.target('loop1'))
        .on('remind', (t) => t.send('reminder', (send) => send.id('nudge').after('60s')))
        .on('ping', (t) => t.send('pong', (send) =>
          send.via(({ event }) => event.originType).to(({ event }) => event.origin))))
    .state('past_due', (s) =>
      s
        .entry((e) => e.log('overdue', function () { return this.failures; }))
        .on('paid', (t) => t.target('active'))
        .on('payment.failed', (t) => t.assign('failures', function () { return this.failures + 1; })))
    .state('loop1', (s) =>
      s.entry((e) => e.script(function () { this.log.push('spin'); }).script(function () {}))
        .always((t) => t.target('loop2')))
    .state('loop2', (s) => s.always((t) => t.target('loop1')));
}

async function world(options = {}) {
  const system = createSystem({ clock: 'manual', ...options });
  const definition = system.define(subscription());
  const actor = system.spawn(definition, { name: 'acct_1' });
  await system.flush();
  return { system, definition, actor };
}

// ----------------------------------------------------------------------

async function framing() {
  const messages = [];
  const reader = new DAPReader((message) => messages.push(message));
  const bytes = encodeDAPMessage({ seq: 1, type: 'request', command: 'initialize', arguments: { text: 'grüße' } });
  const header = new TextDecoder().decode(bytes.subarray(0, 20));
  assert.match(header, /^Content-Length: \d+\r\n/);
  const twice = new Uint8Array(bytes.length * 2);
  twice.set(bytes, 0);
  twice.set(bytes, bytes.length);
  reader.push(twice.subarray(0, 7));
  reader.push(twice.subarray(7, bytes.length + 3));
  assert.equal(messages.length, 1);
  reader.push(twice.subarray(bytes.length + 3));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].arguments.text, 'grüße');
  assert.throws(() => new DAPReader(), TinyactorsError);

  // A UTF-8 sequence split across chunks, and a surrogate pair split across
  // string chunks, arrive whole; other header fields are ignored.
  const split = [];
  const splitReader = new DAPReader((message) => split.push(message));
  const emoji = encodeDAPMessage({ seq: 2, type: 'event', event: 'output', body: { output: 'é😀' } });
  const at = emoji.indexOf(0xc3);
  splitReader.push(emoji.subarray(0, at + 1));
  splitReader.push(emoji.subarray(at + 1));
  const text = 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n' +
    new TextDecoder().decode(encodeDAPMessage({ seq: 3, type: 'request', command: '😀' }));
  const cut = text.indexOf('\uD83D') + 1;
  splitReader.push(text.slice(0, cut));
  splitReader.push(text.slice(cut));
  assert.deepEqual(split.map((message) => message.body?.output ?? message.command), ['é😀', '😀']);

  // Each malformed stream throws invalid, and the reader stays broken.
  const utf8 = (text) => new TextEncoder().encode(text);
  const framed = (body, headers = `Content-Length: ${utf8(body).length}`) => utf8(`${headers}\r\n\r\n${body}`);
  const malformed = [
    [framed('{}', 'X: 1'), /no Content-Length/],
    [framed('{"seq":1,"type":"event"}', 'Content-Length: 2\r\nContent-Length: 2'), /two Content-Length/],
    [framed('{}', 'Content-Length: -2'), /not a decimal number/],
    [framed('{}', 'Content-Length: 0x2'), /not a decimal number/],
    [framed('{}', 'Content-Length: 999999999'), /at most/],
    [framed('{}', 'Content-Length 2'), /Name: value/],
    [new Uint8Array([...utf8('Content-Length: 2\r\nX: '), 0xff, ...utf8('\r\n\r\n{}')]), /headers of a message are not UTF-8/],
    [new Uint8Array([...utf8('Content-Length: 1\r\n\r\n'), 0xff]), /body is not UTF-8/],
    [utf8('Content-Length: 2\r\n'.padEnd(9000, 'x')), /no blank line within/],
    [framed('{"seq":'), /not JSON/],
    ...['5', '[]', '"x"', 'null'].map((body) => [framed(body), /not a JSON object/]),
    [framed('{"type":"request"}'), /integer seq/],
    [framed('{"seq":1.5,"type":"request"}'), /integer seq/],
    [framed('{"seq":1,"type":"note"}'), /type is "note"/],
  ];
  for (const [bytes, reason] of malformed) {
    const seen = [];
    const broken = new DAPReader((message) => seen.push(message));
    assert.throws(() => broken.push(bytes), (error) => error instanceof TinyactorsError && error.code === 'invalid' &&
      reason.test(error.message), `${reason}`);
    assert.throws(() => broken.push(encodeDAPMessage({ seq: 9, type: 'event', event: 'x' })),
      (error) => error.code === 'invalid' && /malformed earlier/.test(error.message));
    assert.deepEqual(seen, []);
  }

  // A throwing onMessage is not the stream's fault: the reader stays usable,
  // and the message behind it arrives with the next push().
  const got = [];
  const picky = new DAPReader((message) => {
    if (message.seq === 1) throw new Error('no');
    got.push(message.seq);
  });
  const both = new Uint8Array([...encodeDAPMessage({ seq: 1, type: 'event', event: 'a' }),
    ...encodeDAPMessage({ seq: 2, type: 'event', event: 'b' })]);
  assert.throws(() => picky.push(both), /no/);
  picky.push(new Uint8Array(0));
  assert.deepEqual(got, [2]);
}

async function options() {
  const system = createSystem({ clock: 'manual' });
  const send = () => {};
  assert.throws(() => createDebugSession(system, { allow: ['everything'], send }), /allow/);
  assert.throws(() => createDebugSession(system, { allow: ['hold'], send }), /allow/);
  assert.throws(() => createDebugSession(system, {}), /send/);
  assert.throws(() => createDebugSession(system, { send, audit: 1 }), /audit/);
  assert.throws(() => createDebugSession({}, { send }), /System/);
  const session = createDebugSession(system, { allow: ['evaluate'], send });
  assert.deepEqual(session.allow, ['evaluate']);
  assert.equal(session.attached, false);
  assert.deepEqual(createDebugSession(system, { send }).allow, [], 'no permission: watch only');
  system.close();
}

// initialize, the capabilities, attach and its refusals, the entry stop,
// and the requests a live actor has no use for.
async function session() {
  const { system, actor } = await world();
  const client = new Client(system, { allow: ALL });
  const capabilities = await client.ok('initialize', { clientID: 'test' });
  assert.deepEqual(client.events('initialized'), [undefined]);
  assert.equal(capabilities.supportsConfigurationDoneRequest, true);
  assert.equal(capabilities.supportsFunctionBreakpoints, true);
  assert.equal(capabilities.supportsDataBreakpoints, true);
  assert.equal(capabilities.supportTerminateDebuggee, false);
  assert.equal(capabilities.supportsLogPoints, true);
  assert.equal(capabilities.supportsBreakpointLocationsRequest, true);
  assert.equal(capabilities.supportsGotoTargetsRequest, true, 'goto is a poke');
  for (const never of ['supportsStepBack', 'supportsRestartFrame', 'supportsRestartRequest',
                       'supportsSteppingGranularity', 'supportsExceptionInfoRequest', 'supportsDisassembleRequest']) {
    assert.equal(capabilities[never], undefined, never);
  }
  assert.deepEqual(capabilities.exceptionBreakpointFilters.map((filter) => filter.filter),
                   ['error.execution', 'error.communication', 'error.platform', 'ignored', 'stopped', 'runaway']);

  await client.refused('launch', {}, /attach/);
  await client.refused('stackTrace', { threadId: 1 }, /attach/);
  await client.refused('attach', {}, /address/);
  await client.refused('attach', { address: 'nope' }, /address/);
  await client.refused('attach', { address: 'subscription/nobody' }, /no resident actor/);
  await client.refused('attach', { address: 'subscription/acct_1', allow: 'send' }, /list of permissions/);
  await client.refused('attach', { actor: { slot: 999, generation: 1 } }, /no resident actor/);
  await client.refused('attach', { sessionID: 'x' }, /session ID/);

  await client.ok('attach', { address: '#_actor_subscription/acct_1' });
  await client.refused('attach', { address: 'subscription/acct_1' }, /already attached/);
  await client.ok('configurationDone');
  const [process] = client.events('process');
  assert.deepEqual(process, { name: 'subscription/acct_1', startMethod: 'attach', isLocalProcess: true });
  assert.match(client.output(), /attached to subscription\/acct_1 \(session \d+\), watched live and never paused; allowed: send, set, goto, evaluate/);
  // One stop, so the client shows the stack and the variables.
  const [entry] = client.events('stopped');
  // The attach stop takes the focus, so the client selects the top frame and
  // shows its variables; the refreshes after macrosteps keep it (liveView).
  assert.deepEqual(entry, { reason: 'entry', threadId: 1, allThreadsStopped: false, preserveFocusHint: false,
                            description: 'watched live, never paused: the view follows each macrostep' });
  const { threads } = await client.ok('threads');
  assert.deepEqual(threads, [{ id: 1, name: 'subscription/acct_1 · active' }]);
  assert.equal(client.audit[0].type, 'attach');
  assert.deepEqual(client.audit[0].allow, ALL);
  assert.equal(client.audit[0].actor, 'subscription/acct_1');

  // Nothing stops the actor, so nothing steps it or goes back.
  for (const [command, pattern] of [
    ['pause', /never stopped/], ['next', /never stopped/], ['stepIn', /never stopped/], ['stepOut', /never stopped/],
    ['stepBack', /no past/], ['reverseContinue', /no past/], ['restartFrame', /no past/],
    ['restart', /attach again/], ['exceptionInfo', /never stops for an exception/],
    ['cancel', /nothing to cancel/], ['stepInTargets', /one way in/],
    ['terminateThreads', /destroy an actor/], ['setInstructionBreakpoints', /no instructions/],
    ['locations', /source/], ['readMemory', /memory/], ['writeMemory', /memory/], ['disassemble', /instructions/],
    ['runInTerminal', /not supported/],
  ]) {
    await client.refused(command, { threadId: 1 }, pattern);
  }
  // continue changes nothing, and the client hears the actor stopped again.
  const mark = client.mark();
  assert.deepEqual(await client.ok('continue', { threadId: 1 }), { allThreadsContinued: false });
  assert.equal(client.since(mark, 'stopped').length, 1);
  assert.match(client.outputSince(mark), /continue changes nothing/);
  assert.equal(actor.inspect().scheduling, 'idle');

  const lines = await client.ok('setBreakpoints', { source: { path: 'elsewhere.js' }, breakpoints: [{ line: 3 }] });
  assert.equal(lines.breakpoints[0].verified, false);
  assert.match(lines.breakpoints[0].message, /no state, transition or action/);
  assert.deepEqual((await client.ok('breakpointLocations', { source: { path: 'elsewhere.js' }, line: 1 })).breakpoints, []);

  // Attach by actor ID and by session ID.
  const other = new Client(system, {});
  await other.start({ actor: { slot: actor.slot, generation: actor.generation } });
  assert.match(other.output(), /attached to actor \d+:\d+ .*; watch only/);
  await other.ok('disconnect');
  const third = new Client(system, {});
  await third.start({ sessionID: String(actor.inspect().sessionID) });
  await third.ok('terminate');
  assert.equal(third.events('terminated').length, 1);
  assert.equal(third.session.attached, false);
  assert.deepEqual(third.audit.map((entry) => entry.type), ['attach', 'detach']);

  await client.ok('disconnect', { terminateDebuggee: true });
  assert.equal(system.exists(actor), true, 'the actor is never destroyed');
  assert.equal(client.audit.at(-1).type, 'detach');
  client.assertNeverStopped();
  client.session.close();
  system.close();
}

// The live view: every macrostep of the actor, a poke's included, is a
// summary in the console and an `invalidated` event, after which the
// stack and the scopes show where the actor is now. The application's own
// trace sink still gets every turn.
async function liveView() {
  const { system, actor } = await world();
  const applicationTurns = [];
  system.setTraceSink((traces) => applicationTurns.push(traces.length), { detail: 'summary', values: true });
  const client = new Client(system, { allow: ALL });
  await client.start({ address: { family: 'subscription', name: 'acct_1' } });
  let { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  assert.equal(stackFrames[0].name, 'idle in active');
  const before = stackFrames[0].id;

  let mark = client.mark();
  await actor.send('payment.failed', { attempt: 3 });
  await client.until(() => client.since(mark, 'invalidated').length > 0, 'an invalidated event');
  // The refresh: a stop that keeps the focus (the stack is read again, and
  // the Debug Console keeps the keyboard), then the variables. Never a stacks
  // invalidation: VS Code answers one by replaying the attach stop, which
  // takes the focus.
  assert.deepEqual(client.since(mark, 'invalidated')[0], { areas: ['variables'] });
  const refresh = client.since(mark, 'stopped');
  assert.equal(refresh.length, 1, JSON.stringify(refresh));
  assert.equal(refresh[0].preserveFocusHint, true, 'a refresh keeps the focus');
  const summary = client.since(mark, 'output').map((body) => body.output)
    .find((output) => output.startsWith('subscription/acct_1 macrostep'));
  assert.match(summary, /^subscription\/acct_1 macrostep \d+: payment\.failed \{"attempt":3\}\n  active → past_due on payment\.failed\n    assign failures = 1\n  now in past_due\n$/,
               'a macrostep\'s summary is one output');
  assert.match(client.output(), /overdue: 1/, '<log> records are stdout');
  // A frame names only the thread and its depth: a request a client made
  // with the frame it had before the refresh still answers, with what is
  // true now, and the refreshed stack gives the frame the same ID.
  const stale = await client.ok('scopes', { frameId: before });
  assert.ok(stale.scopes.some((scope) => scope.name === 'Data model'), JSON.stringify(stale.scopes));
  ({ stackFrames } = await client.ok('stackTrace', { threadId: 1 }));
  assert.equal(stackFrames[0].name, 'idle in past_due', 'the stack shows where it is now');
  assert.equal(stackFrames[0].id, before, 'a frame keeps its ID across macrosteps');

  // A poke's macrostep shows the same way.
  mark = client.mark();
  assert.equal((await client.repl('send paid')).result, 'sent paid to subscription/acct_1');
  await client.until(() => client.since(mark, 'invalidated').length > 0, 'the poke\'s macrostep');
  assert.match(client.outputSince(mark), /past_due → active on paid/);
  ({ stackFrames } = await client.ok('stackTrace', { threadId: 1 }));
  assert.equal(stackFrames[0].name, 'idle in active');
  const { scopes } = await client.ok('scopes', { frameId: stackFrames[0].id });
  const event = scopes.find((scope) => scope.name === 'Event');
  const fields = (await client.ok('variables', { variablesReference: event.variablesReference })).variables;
  assert.ok(fields.some((variable) => variable.name === 'name' && variable.value === '"paid"'), JSON.stringify(fields));
  assert.ok(applicationTurns.length > 0, 'the application\'s sink still gets its turns');

  // A client that did not say it takes invalidated events hears none.
  const plain = new Client(system, {});
  await plain.ok('initialize', { clientID: 'plain' });
  await plain.ok('attach', { address: 'subscription/acct_1' });
  actor.post('payment.failed');
  await plain.until(() => /now in past_due/.test(plain.output()), 'the summary');
  assert.equal(plain.events('invalidated').length, 0);
  await plain.until(() => plain.events('stopped').length >= 2, 'the refresh stop');
  assert.equal(plain.events('stopped').at(-1).preserveFocusHint, true, 'it still hears the stack refresh');
  await plain.ok('disconnect');
  client.assertNeverStopped();
  // Only the attach stop took the focus: every refresh kept it.
  assert.deepEqual(client.events('stopped').map((stop) => stop.preserveFocusHint).filter((hint) => hint === false), [false]);
  await client.ok('disconnect');
  system.close();
}

// Breakpoints are tracepoints: where one would have stopped, the console
// says so, and the actor runs on.
async function breakpoints() {
  const { system, actor } = await world();
  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'subscription/acct_1' });

  // Entry, with a condition and a hit condition, and on:.
  const set = await client.ok('setFunctionBreakpoints', { breakpoints: [
    { name: 'past_due', condition: 'failures >= 1', hitCondition: '1' },
    { name: 'on:paid' },
    { name: 'nowhere' },
  ] });
  assert.equal(set.breakpoints[0].verified, true);
  assert.deepEqual(set.breakpoints[2], { id: set.breakpoints[2].id, verified: false,
                                         message: 'nowhere is not a state of the chart' });
  let mark = client.mark();
  assert.equal((await actor.send('payment.failed', { attempt: 1 })).status, 'stable');
  await client.wrote(mark, /would have stopped after macrostep \d+: entered past_due\n/);
  mark = client.mark();
  actor.post('paid');
  await client.wrote(mark, /would have stopped after macrostep \d+: took paid\n/);
  assert.deepEqual(actor.inspect().activeStates, ['active']);

  // A transition by its name, and exit.
  await client.ok('setFunctionBreakpoints', { breakpoints: [{ name: 'active -> past_due' }, { name: 'exit:past_due' }] });
  mark = client.mark();
  actor.post('payment.failed');
  actor.post('paid');
  await client.wrote(mark, /would have stopped after macrostep \d+: active → past_due[^\n]*\n[^]*exited past_due/);
  await client.ok('setFunctionBreakpoints', { breakpoints: [] });

  // An exception.
  await client.refused('setExceptionBreakpoints', { filters: ['bogus'] }, /unknown exception filter/);
  await client.ok('setExceptionBreakpoints', { filters: ['error.execution'] });
  mark = client.mark();
  actor.post('boom');
  await client.wrote(mark, /would have stopped after macrostep \d+: error\.execution: <script> in active on boom: Error: boom\n/);
  await client.refused('exceptionInfo', { threadId: 1 }, /never stops for an exception/);
  await client.ok('setExceptionBreakpoints', { filters: [] });

  // A data breakpoint, from the Variables pane and by name.
  const { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  const { scopes } = await client.ok('scopes', { frameId: stackFrames[0].id });
  const data = scopes.find((scope) => scope.name === 'Data model');
  const described = await client.ok('dataBreakpointInfo', { variablesReference: data.variablesReference, name: 'failures' });
  assert.equal(described.dataId, 'subscription/acct_1 ["failures"]');
  assert.deepEqual(described.accessTypes, ['write']);
  const byName = await client.ok('dataBreakpointInfo', { name: '.plan.seats' });
  assert.equal(byName.dataId, 'subscription/acct_1 ["plan","seats"]');
  assert.equal((await client.ok('dataBreakpointInfo', { name: 'a + b' })).dataId, null);
  const watched = await client.ok('setDataBreakpoints', { breakpoints: [
    { dataId: described.dataId }, { dataId: 'nobody ["x"]' }, { dataId: described.dataId, accessType: 'read' },
    { dataId: 'x' },
  ] });
  assert.deepEqual(watched.breakpoints.map((entry) => entry.verified), [true, false, false, false]);
  mark = client.mark();
  actor.post('payment.failed');
  await client.wrote(mark, /would have stopped after macrostep \d+: failures = 3\n/);
  await client.ok('setDataBreakpoints', { breakpoints: [] });
  await system.flush();
  assert.equal(actor.inspect().scheduling, 'idle', 'nothing holds it');
  client.assertNeverStopped();
  await client.ok('disconnect');
  system.close();
}

// The console's pokes: send and replies, goto, abandon, cancel, replace.
async function console() {
  const { system, actor } = await world();
  system.define(subscription('v2'));
  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'subscription/acct_1' });

  assert.match((await client.repl('help')).result, /send <event> \[json\]/);
  assert.doesNotMatch((await client.repl('help')).result, /fork|clock/);
  assert.match((await client.repl('send ping')).result, /sent ping to subscription\/acct_1/);
  await system.flush();
  assert.match(client.output(), /subscription\/acct_1 replied pong/);
  await client.refused('evaluate', { expression: 'send', context: 'repl' }, /send <event>/);
  await client.refused('evaluate', { expression: 'send x {nope', context: 'repl' }, /not JSON/);

  // Until the pump takes it, a poke waits in the mailbox, marked as the
  // console's; the Queues scope shows it.
  assert.equal((await client.repl('send payment.failed {"attempt": 9}')).result, 'sent payment.failed to subscription/acct_1');
  const { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  assert.equal(stackFrames[0].name, 'idle in active (1 message waiting)');
  const { scopes } = await client.ok('scopes', { frameId: stackFrames[0].id });
  const queues = scopes.find((scope) => scope.name === 'Queues');
  const queued = await client.ok('variables', { variablesReference: queues.variablesReference });
  const mailbox = queued.variables.find((variable) => variable.name === 'mailbox');
  const [message] = (await client.ok('variables', { variablesReference: mailbox.variablesReference })).variables;
  const fields = await client.ok('variables', { variablesReference: message.variablesReference });
  assert.deepEqual(Object.fromEntries(fields.variables.map((variable) => [variable.name, variable.value])),
                   { event: '"payment.failed"', data: '{"attempt":9}', from: '"this console"' });
  await system.flush();
  assert.equal(actor.inspect().data.failures, 1);

  // goto: an operator transition queued behind the mail.
  assert.equal((await client.repl('goto active from past_due')).result,
               'subscription/acct_1: goto active from past_due queued');
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['active']);
  assert.match(client.output(), /goto: exited past_due, entered active/);
  await client.refused('evaluate', { expression: 'goto nowhere', context: 'repl' }, /not a state/);
  await client.refused('evaluate', { expression: 'goto', context: 'repl' }, /goto <state/);
  // The DAP goto request, from gotoTargets, is the same poke.
  const { targets } = await client.ok('gotoTargets', { source: { path: 'x' }, line: 1 });
  assert.deepEqual(targets.map((target) => target.label), ['active', 'past_due', 'loop1', 'loop2']);
  let mark = client.mark();
  await client.ok('goto', { threadId: 1, targetId: targets[1].id });
  assert.match(client.outputSince(mark), /subscription\/acct_1: goto past_due queued/);
  await system.flush();
  assert.deepEqual(actor.inspect().activeStates, ['past_due']);
  // Its macrostep refreshes the view like any other; nothing stops.
  assert.ok(client.since(mark, 'stopped').every((stop) => stop.reason === 'entry' && stop.preserveFocusHint === true),
            'a goto stops nothing');
  await client.refused('goto', { threadId: 1, targetId: 999 }, /gotoTargets/);
  actor.post('paid');
  await system.flush();

  // cancel withdraws a delayed send by the ID the Timers scope shows.
  actor.post('remind');
  await system.flush();
  assert.equal(actor.inspect().delayedSendCount, 1);
  assert.match((await client.repl('cancel nudge')).result, /withdrew send nudge/);
  assert.equal(actor.inspect().delayedSendCount, 0);
  await client.refused('evaluate', { expression: 'cancel nudge', context: 'repl' }, /no pending send/);

  // abandon: a macrostep that never ends. The system's budgets pause it
  // between microsteps, where core abandons it.
  await client.refused('evaluate', { expression: 'abandon', context: 'repl' }, /no macrostep to abandon/);
  const runaway = actor.send('spin');
  for (let index = 0; index < 5; index += 1) await turn();
  const frames = await client.ok('stackTrace', { threadId: 1 });
  assert.ok(frames.stackFrames.some((frame) => /^macrostep \d+ on spin$/.test(frame.name)), JSON.stringify(frames));
  assert.match((await client.repl('abandon')).result, /abandoned macrostep \d+/);
  await assert.rejects(runaway, (error) => error.code === 'abandoned');
  assert.ok(client.audit.some((entry) => entry.operation === 'abandon'));
  await system.flush();
  assert.equal(actor.inspect().macrostepInProgress, false);

  // Inside a microstep, where an action budget of 1 keeps this loop, core
  // refuses, and abandon says to try again.
  const tight = createSystem({ clock: 'manual', scheduling: { actionBudget: 1 } });
  const spinner = tight.spawn(tight.define(subscription()), { name: 'acct_3' });
  await tight.flush();
  const tightClient = new Client(tight, { allow: ALL });
  await tightClient.start({ address: 'subscription/acct_3' });
  const stuck = spinner.send('spin');
  for (let index = 0; index < 5; index += 1) await turn();
  await tightClient.refused('evaluate', { expression: 'abandon', context: 'repl' }, /inside a microstep; try again/);
  await tightClient.ok('disconnect');
  tight.close();
  await assert.rejects(stuck, (error) => error.code === 'closed');

  // replace follows the address to the new revision.
  assert.match((await client.repl('replace v2')).result, /now runs v2 from its initial state, with its data/);
  const replaced = system.findActor({ family: 'subscription', name: 'acct_1' });
  assert.equal(replaced.inspect().definition.revision, 'v2');
  assert.equal(replaced.inspect().data.failures, 1);
  assert.match((await client.ok('threads')).threads[0].name, /subscription\/acct_1/);
  await client.refused('evaluate', { expression: 'replace v9', context: 'repl' }, /no registered/);
  client.assertNeverStopped();
  await client.ok('disconnect');
  system.close();
}

// Permissions: each poke needs its own; with none the session only
// watches; expressions need `evaluate`, and without it the Variables pane
// and the console commands still work.
async function permissions() {
  const { system } = await world();
  const client = new Client(system, { allow: ['send'] });
  await client.start({ address: 'subscription/acct_1' });
  await client.refused('evaluate', { expression: 'goto past_due', context: 'repl' }, /"goto" permission/);
  await client.refused('evaluate', { expression: 'abandon', context: 'repl' }, /"goto" permission/);
  await client.refused('evaluate', { expression: 'failures', context: 'repl' }, /"evaluate" permission/);
  await client.refused('evaluate', { expression: 'failures', context: 'hover' }, /"evaluate" permission/);
  await client.refused('evaluate', { expression: 'failures', context: 'watch' }, /runs code in the process/);
  const { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  const { scopes } = await client.ok('scopes', { frameId: stackFrames[0].id });
  const data = scopes.find((scope) => scope.name === 'Data model');
  const { variables } = await client.ok('variables', { variablesReference: data.variablesReference });
  assert.deepEqual(variables.map((variable) => variable.name), ['failures', 'plan', 'log']);
  await client.refused('setVariable', { variablesReference: data.variablesReference, name: 'failures', value: '5' },
                       /"set"/);
  const conditioned = await client.ok('setFunctionBreakpoints', { breakpoints: [{ name: 'past_due', condition: 'true' }] });
  assert.match(conditioned.breakpoints[0].message, /"evaluate" permission/);
  assert.match((await client.repl('send paid')).result, /sent paid/);
  await client.ok('disconnect');

  // A session may ask for less than it was given, never more.
  const narrow = new Client(system, { allow: ['goto'] });
  await narrow.start({ address: 'subscription/acct_1', allow: ['goto', 'send', 'evaluate'] });
  assert.match(narrow.output(), /allowed: goto\n/);
  await narrow.refused('evaluate', { expression: 'send paid', context: 'repl' }, /"send" permission/);
  await narrow.ok('disconnect');
  // With none, it watches.
  const watcher = new Client(system, { allow: ALL });
  await watcher.start({ address: 'subscription/acct_1', allow: [] });
  assert.match(watcher.output(), /; watch only\n/);
  for (const line of ['send paid', 'goto active', 'abandon', 'cancel nudge', 'replace v1']) {
    await watcher.refused('evaluate', { expression: line, context: 'repl' }, /changes the actor, and this session only watches it/);
  }
  await watcher.refused('setVariable', { variablesReference: 1, name: 'failures', value: '5' }, /only watches it/);
  await watcher.ok('disconnect');
  system.close();
}

// The audit hook hears everything first; one that throws refuses it.
async function audit() {
  const { system, actor } = await world();
  let refuse = false;
  const entries = [];
  const client = new Client(system, {
    allow: ALL,
    audit: (entry) => {
      entries.push(entry);
      if (refuse && entry.type === 'mutation') throw new Error('not during a freeze');
    },
  });
  await client.start({ address: 'subscription/acct_1' });
  await client.repl('failures + 1');
  await client.ok('evaluate', { expression: 'plan.seats', context: 'hover' });
  refuse = true;
  await client.refused('evaluate', { expression: 'send paid', context: 'repl' },
                       /audit hook refused it: not during a freeze/);
  await system.flush();
  assert.equal(system.mailbox(actor).length, 0);
  refuse = false;
  const types = entries.map((entry) => `${entry.type}${entry.operation ? `:${entry.operation}` : ''}`);
  assert.deepEqual(types, ['attach', 'command', 'evaluate', 'command', 'mutation:send']);
  assert.deepEqual(entries[2], { type: 'evaluate', context: 'hover', expression: 'plan.seats', time: entries[2].time,
                                  session: client.session.id, actor: 'subscription/acct_1',
                                  sessionID: String(actor.inspect().sessionID) });
  // A refusing attach hook refuses the attach.
  const shut = new Client(system, { allow: ALL, audit: () => { throw new Error('closed for maintenance'); } });
  await shut.ok('initialize');
  await shut.refused('attach', { address: 'subscription/acct_1' }, /closed for maintenance/);
  assert.equal(shut.session.attached, false);
  await client.ok('disconnect');
  assert.equal(entries.at(-1).type, 'detach');
  system.close();
}

// Threads with an invoked child, stack frames inside a macrostep, the
// scopes, evaluate, setVariable and setExpression, completions.
async function state() {
  const system = createSystem({ clock: 'manual', scheduling: { actionBudget: 1 } });
  const child = system.define(statechart({ family: 'worker', revision: 'v1' }).data('jobs', 3).state('working'));
  const parent = system.define(subscription().state('supervising', (s) =>
    s.invoke((i) => i.type('scxml').id('kid').content(child))));
  const actor = system.spawn(parent, { name: 'acct_4' });
  await system.flush();
  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'subscription/acct_4' });

  // Scopes of the idle actor.
  let { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  assert.equal(stackFrames[0].name, 'idle in active');
  let { scopes } = await client.ok('scopes', { frameId: stackFrames[0].id });
  assert.deepEqual(scopes.map((scope) => scope.name),
                   ['Data model', 'Event', 'Configuration', 'Queues', 'Timers', 'Invocations', 'System']);
  const read = async (name) => {
    const scope = scopes.find((entry) => entry.name === name);
    return (await client.ok('variables', { variablesReference: scope.variablesReference })).variables;
  };
  const dataModel = await read('Data model');
  const plan = dataModel.find((variable) => variable.name === 'plan');
  assert.equal(plan.evaluateName, '.plan');
  assert.equal(plan.namedVariables, 2);
  const planned = await client.ok('variables', { variablesReference: plan.variablesReference });
  assert.deepEqual(planned.variables.map((variable) => [variable.name, variable.value]),
                   [['name', '"basic"'], ['seats', '2']]);
  assert.deepEqual((await read('Configuration')).map((variable) => variable.name), ['active']);
  const system_ = Object.fromEntries((await read('System')).map((variable) => [variable.name, variable.value]));
  assert.equal(system_._sessionid, JSON.stringify(String(actor.inspect().sessionID)));
  assert.equal(system_.scheduling, '"idle"');
  await client.refused('setVariable', { variablesReference: scopes[6].variablesReference, name: 'now', value: '1' },
                       /only the Data model/);

  // setVariable writes the live data; a non-JSON value is an expression.
  const written = await client.ok('setVariable', { variablesReference: plan.variablesReference, name: 'seats', value: '5' });
  assert.equal(written.value, '5');
  assert.equal(actor.inspect().data.plan.seats, 5);
  await client.ok('setVariable', { variablesReference: plan.variablesReference, name: 'name',
                                   value: 'plan.name.toUpperCase()' });
  assert.equal(actor.inspect().data.plan.name, 'BASIC');
  const expression = await client.ok('setExpression', { expression: '.plan.seats', value: 'plan.seats * 2' });
  assert.equal(expression.value, '10');
  assert.equal(actor.inspect().data.plan.seats, 10);

  // evaluate in its contexts.
  assert.equal((await client.ok('evaluate', { expression: '.plan.seats + 1', context: 'watch' })).result, '11');
  assert.equal((await client.ok('evaluate', { expression: 'inState("active")', context: 'hover' })).result, 'true');
  assert.equal((await client.ok('evaluate', { expression: 'plan', context: 'clipboard' })).result,
               JSON.stringify({ name: 'BASIC', seats: 10 }, null, 2));
  const presented = await client.ok('evaluate', { expression: 'plan', context: 'variables' });
  assert.equal(presented.namedVariables, 2);
  await client.refused('evaluate', { expression: 'nope(', context: 'watch' }, /does not parse/);
  await client.refused('evaluate', { expression: 'undefinedThing.x', context: 'watch' }, /threw/);

  // completions: event names, states, send IDs, commands, data locations.
  const complete = async (text) =>
    (await client.ok('completions', { text, column: text.length + 1 })).targets.map((target) => target.label);
  assert.deepEqual(await complete('send pa'), ['paid', 'payment.failed']);
  assert.deepEqual(await complete('goto loop1 lo'), ['loop1', 'loop2']);
  assert.deepEqual(await complete('ab'), ['abandon']);
  assert.deepEqual(await complete('.pl'), ['plan']);
  assert.deepEqual(await complete('plan.s'), ['seats']);
  const [target] = (await client.ok('completions', { text: 'send pai', column: 9 })).targets;
  assert.equal(target.start, 6);
  assert.equal(target.length, 3);

  // An invoked child is a thread of its own.
  await client.repl('goto supervising');
  await system.flush();
  let { threads } = await client.ok('threads');
  assert.equal(threads.length, 2);
  assert.equal(threads[1].name, 'subscription/acct_4 invocation kid · working', 'named by its <invoke id>');
  assert.equal(client.events('thread').filter((event) => event.reason === 'started').length, 1);
  const invocations = await (async () => {
    ({ stackFrames } = await client.ok('stackTrace', { threadId: 1 }));
    ({ scopes } = await client.ok('scopes', { frameId: stackFrames[0].id }));
    return read('Invocations');
  })();
  const invocation = await client.ok('variables', { variablesReference: invocations[0].variablesReference });
  const thread = invocation.variables.find((variable) => variable.name === 'thread');
  assert.equal(invocations[0].name, 'kid');
  assert.equal(thread.value, '"2 subscription/acct_4 invocation kid"');
  const kid = await client.ok('stackTrace', { threadId: threads[1].id });
  assert.equal(kid.stackFrames[0].name, 'idle in working');
  await client.repl('goto active');
  await system.flush();
  ({ threads } = await client.ok('threads'));
  assert.equal(threads.length, 1);
  assert.equal(client.events('thread').filter((event) => event.reason === 'exited').length, 1);

  // Frames inside a paused macrostep: the unit it runs next. Sent from the
  // console, so the Event scope shows the console as its origin.
  await client.repl('send spin');
  for (let index = 0; index < 4; index += 1) await turn();
  ({ stackFrames } = await client.ok('stackTrace', { threadId: 1 }));
  const names = stackFrames.map((frame) => frame.name);
  assert.match(names.join(' | '), /(script \d|selecting transitions).* \| macrostep \d+ on spin/);
  const partial = await client.ok('stackTrace', { threadId: 1, startFrame: 1, levels: 1 });
  assert.equal(partial.stackFrames.length, 1);
  assert.equal(partial.totalFrames, stackFrames.length);
  ({ scopes } = await client.ok('scopes', { frameId: stackFrames[0].id }));
  const event = Object.fromEntries((await read('Event')).map((variable) => [variable.name, variable.value]));
  assert.equal(event.name, '"spin"');
  assert.match(event.origin, /^"debug:\/\/session\/\d+"$/, 'origin is the URI a reply goes to');
  assert.equal(event.origintype, '"debug"');
  await client.refused('scopes', { frameId: 9999 }, /not valid/);
  await client.refused('variables', { variablesReference: 9999 }, /not valid/);
  await client.refused('stackTrace', { threadId: 42 }, /no thread 42/);
  await client.ok('disconnect');
  system.close();
}

// A renewal, written one builder call per statement, so each element's
// source span (core ADR 0085) is its own line on every engine.
function renewal() {
  const chart = statechart({ family: 'renewal', revision: 'v1' });
  chart.data('renewals', 0);
  chart.data('notes', []);
  chart.state('active', (s) => {
    s.entry((e) => {
      e.send('renew', (send) => send.id('renewal').after('30s'));
    });
    s.on('renew', (t) => {
      t.target('renewing');
    });
    s.on('webhook', (t) => {
      t.send('notify', (send) => send.via('http').to('https://example.test/hook'));
    });
  });
  chart.state('renewing', (s) => {
    s.entry((e) => {
      e.script(function () { this.notes.push('start'); });
      e.assign('renewals', function () { return this.renewals + 1; });
      e.script(function () { this.notes.push('done'); });
    });
    s.always((t) => {
      t.target('active');
    });
  });
  return chart;
}

// The ID of the action of `kind` whose index in its block is `index`.
function actionID(system, definition, kind, index) {
  const count = core.definition_inspect(nativeOf(system), definition.id).action_count;
  for (let id = 0; id < count; id += 1) {
    const info = core.definition_action(nativeOf(system), definition.id, id);
    if (info.kind === kind && info.index === index) return id;
  }
  return undefined;
}

// The line statechart() recorded for a state (core ADR 0085).
function stateLine(system, definition, name) {
  return definition.sourceOf('state', core.definition_find_state(nativeOf(system), definition.id, name)).line;
}

// Source spans (core ADR 0085): frames have lines, a line breakpoint
// stands for the element on its line and traces it, logpoints write, and
// breakpoints set before attaching are placed once the chart is known.
async function sources() {
  const system = createSystem({ clock: 'manual' });
  const definition = system.define(renewal());
  const actor = system.spawn(definition, { name: 'r1' });
  await system.flush();
  const renewing = stateLine(system, definition, 'renewing');
  const assign = definition.sourceOf('action', actionID(system, definition, 'assign', 1)).line;
  const client = new Client(system, { allow: ALL });
  await client.ok('initialize', { clientID: 'test' });
  // Set before attaching: unverified until the chart is known.
  const early = await client.ok('setBreakpoints', { source: { path: __filename }, breakpoints: [{ line: renewing }] });
  assert.equal(early.breakpoints[0].verified, false);
  assert.match(early.breakpoints[0].message, /attach first/);
  await client.ok('attach', { address: 'renewal/r1' });
  await client.ok('configurationDone');
  const [placed] = client.events('breakpoint');
  assert.deepEqual(placed, { reason: 'changed', breakpoint: { id: early.breakpoints[0].id, verified: true, line: renewing,
                                                               column: placed.breakpoint.column,
                                                               source: { name: 'debug.js', path: __filename } } });

  // A frame of an actor at rest names its state's line.
  const { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  assert.equal(stackFrames[0].source.path, __filename);
  assert.equal(stackFrames[0].line, stateLine(system, definition, 'active'));

  // Lines: locations, a line between elements snaps to the next one, and a
  // logpoint.
  const locations = await client.ok('breakpointLocations',
                                    { source: { path: __filename }, line: renewing, endLine: assign });
  assert.ok(locations.breakpoints.some((entry) => entry.line === renewing));
  assert.ok(locations.breakpoints.some((entry) => entry.line === assign));
  const set = await client.ok('setBreakpoints', { source: { path: __filename }, breakpoints: [
    { line: renewing }, { line: assign, logMessage: 'renewals is {renewals}' }, { line: 1 },
  ] });
  assert.equal(set.breakpoints[0].line, renewing);
  assert.equal(set.breakpoints[1].line, assign);
  assert.ok(set.breakpoints[2].verified && set.breakpoints[2].line > 1, 'line 1 snaps to the first element after it');
  await client.ok('setBreakpoints', { source: { path: __filename }, breakpoints: [
    { line: renewing }, { line: assign, logMessage: 'renewals is {renewals}' },
  ] });
  const mark = client.mark();
  actor.post('renew');
  await client.wrote(mark, /would have stopped after macrostep \d+: line \d+ \(state renewing\)\n/);
  assert.match(client.outputSince(mark), /renewals is 1\n/, 'the logpoint wrote, with its expression evaluated');

  // goto targets on a line.
  const { targets } = await client.ok('gotoTargets', { source: { path: __filename }, line: renewing });
  assert.deepEqual(targets.map((target) => [target.label, target.line]), [['renewing', renewing]]);
  await client.ok('setBreakpoints', { source: { path: __filename }, breakpoints: [] });
  client.assertNeverStopped();
  await client.ok('disconnect');
  system.close();
}

// A chart with no JavaScript in it, built in two places: defining it again
// is answered by its definition (core ADR 0077), which then says where the
// chart is written now (core ADR 0085), and a line breakpoint is placed
// again against those lines.
function plainChartHere() {
  const chart = statechart({ family: 'moved', revision: 'v1' });
  chart.state('a', (s) => s.on('go', (t) => t.target('b')));
  chart.state('b');
  return chart;
}

function plainChartThere() {
  const chart = statechart({ family: 'moved', revision: 'v1' });
  chart.state('a', (s) => s.on('go', (t) => t.target('b')));
  chart.state('b');
  return chart;
}

async function movedLines() {
  const system = createSystem({ clock: 'manual' });
  const definition = system.define(plainChartHere());
  system.spawn(definition, { name: 'm1' });
  await system.flush();
  const here = stateLine(system, definition, 'b');
  const client = new Client(system, { allow: ALL });
  await client.ok('initialize', { clientID: 'test' });
  await client.ok('attach', { address: 'moved/m1' });
  await client.ok('configurationDone');
  const set = await client.ok('setBreakpoints', { source: { path: __filename }, breakpoints: [{ line: here }] });
  assert.equal(set.breakpoints[0].line, here);
  const mark = client.mark();
  const again = system.define(plainChartThere());
  assert.equal(again.id, definition.id, 'the same definition answers');
  const there = stateLine(system, again, 'a');
  assert.ok(there > here, 'its spans moved to where it was built now');
  const [changed] = client.since(mark, 'breakpoint');
  assert.equal(changed.reason, 'changed');
  assert.equal(changed.breakpoint.id, set.breakpoints[0].id);
  assert.equal(changed.breakpoint.line, there, 'the line snaps to the next element of the chart as it is now');
  await client.ok('setBreakpoints', { source: { path: __filename }, breakpoints: [] });
  await client.ok('disconnect');
  system.close();
}

// A runaway (core ADR 0075): the addon quarantines the actor, the console
// says what can be done, and with the `runaway` filter a tracepoint's line
// says it would have stopped. `abandon` ends the macrostep and `goto` moves
// it out of the loop.
async function runaway() {
  const system = createSystem({ clock: 'manual', scheduling: { microstepLimit: 50 } });
  const chart = statechart({ family: 'spinner', revision: 'v1' });
  chart.state('idle', (s) => s.on('go', (t) => t.target('spin')));
  chart.state('spin', (s) => s.always((t) => t.target('spin')));
  const actor = system.spawn(system.define(chart), { name: 's1' });
  await system.flush();
  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'spinner/s1' });
  await client.ok('setExceptionBreakpoints', { filters: ['runaway'] });
  const mark = client.mark();
  actor.post('go');
  await client.wrote(mark, /would have stopped: a macrostep ran its microstep limit\n/);
  assert.match(client.outputSince(mark), /quarantined as a runaway/);
  assert.equal(system.inspect(actor).scheduling, 'quarantined');
  await client.repl('abandon');
  assert.equal(system.inspect(actor).macrostepInProgress, false);
  await client.repl('goto idle');
  await client.ok('setExceptionBreakpoints', { filters: [] });
  system.release(actor);
  await system.flush();
  assert.deepEqual(system.inspect(actor).activeStates, ['idle'], 'the jump was taken after the release');
  client.assertNeverStopped();
  await client.ok('disconnect');
  system.close();
}

// Mail the attached actor will never take, and <send>s of its that could
// not be delivered, are `important` output while it is attached; the
// application's deadLetter hook hears every dead letter as before.
async function lostMail() {
  const letters = [];
  const system = createSystem({
    clock: 'manual',
    deadLetter: (letter) => letters.push(letter),
    io: { bad: { send() { throw new Error('the socket is closed'); } } },
  });
  const chart = statechart({ family: 'mailer', revision: 'v1' })
    .state('idle', (s) => s
      .on('lost', (t) => t.send('hello', (send) => send.to('#_actor_nobody/x')))
      .on('late', (t) => t.send('ping', (send) => send.to('#_actor_nobody/y').after(10)))
      .on('broken', (t) => t.send('frame', (send) => send.via('bad').to('ws://peer'))))
    .state('busy');
  const definition = system.define(chart);
  const actor = system.spawn(definition, { name: 'm1' });
  await system.flush();
  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'mailer/m1' });

  // An operator transition from a state that is not active is refused: a
  // dead letter for the attached actor.
  let mark = client.mark();
  system.post(actor, 'jump', undefined, { transition: { targets: ['idle'], source: 'busy' } });
  await client.wrote(mark, /mailer\/m1: jump became a dead letter: refused\n/);
  assert.equal(client.since(mark, 'output').find((body) => /dead letter/.test(body.output)).category, 'important');
  assert.deepEqual(letters.map(({ event, reason }) => [event, reason]), [['jump', 'refused']],
                   'the application\'s hook hears it as before');

  mark = client.mark();
  actor.post('lost');
  await client.wrote(mark, /mailer\/m1: <send> in idle on lost could not be delivered; it raised error\.communication\n/);
  mark = client.mark();
  actor.post('late');
  await system.flush();
  await system.advanceBy(20);
  await client.wrote(mark, /mailer\/m1: a delayed <send> from macrostep \d+, when it was due, could not be delivered; it raised error\.communication\n/);
  mark = client.mark();
  actor.post('broken');
  await client.wrote(mark, /mailer\/m1: the <send> of frame through bad to ws:\/\/peer failed: the socket is closed\n/);
  await system.flush();

  // Another actor's lost mail is not the attached actor's.
  const other = system.spawn(definition, { name: 'm2' });
  await system.flush();
  mark = client.mark();
  system.post(other, 'jump', undefined, { transition: { targets: ['idle'], source: 'busy' } });
  other.post('lost');
  await system.flush();
  assert.doesNotMatch(client.outputSince(mark), /mailer\/m2|dead letter|could not be delivered/);

  // After the session detaches it writes nothing more.
  await client.ok('disconnect');
  mark = client.mark();
  system.post(actor, 'jump', undefined, { transition: { targets: ['idle'], source: 'busy' } });
  actor.post('lost');
  actor.post('broken');
  await system.flush();
  assert.equal(client.since(mark, 'output').length, 0, 'nothing after the detach');
  assert.equal(letters.filter((letter) => letter.event === 'jump').length, 3, 'the application still hears every one');
  system.close();
}

// Modules and sources: every registered revision, retired ones included.
async function catalog() {
  const { system, definition } = await world();
  const client = new Client(system, {});
  await client.start({ address: 'subscription/acct_1' });
  let { modules, totalModules } = await client.ok('modules', { startModule: 0, moduleCount: 10 });
  assert.equal(totalModules, 1);
  assert.deepEqual(modules[0], { id: String(definition.id), name: 'subscription', version: 'v1' });
  const next = system.define(subscription('v2'));
  const { sources } = await client.ok('loadedSources');
  assert.deepEqual(sources.map((source) => source.name), ['subscription v1.json', 'subscription v2.json', 'debug.js']);
  assert.equal(sources[2].path, __filename, 'the file statechart() recorded (core ADR 0085)');
  await client.refused('source', { source: { path: __filename } }, /the client reads itself/);
  assert.ok(client.events('module').some((event) => event.reason === 'new' && event.module.version === 'v2'));
  assert.ok(client.events('loadedSource').length >= 2);
  const text = await client.ok('source', { sourceReference: sources[0].sourceReference });
  assert.equal(text.mimeType, 'application/json');
  const exported = JSON.parse(text.content);
  assert.deepEqual(exported.states.map((state) => state.id), ['active', 'past_due', 'loop1', 'loop2']);
  assert.match(text.content, /this\.failures \+ 1/, 'functions are shown as their source');
  await client.refused('source', { sourceReference: 99 }, /no such source/);
  next.retire();
  ({ modules } = await client.ok('modules'));
  assert.equal(modules.length, 1, 'a retired revision no actor runs is freed');
  assert.ok(client.events('module').some((event) => event.reason === 'removed'));
  await client.ok('disconnect');
  system.close();
}

// SCXML documents (napi ADR 0026): a named one is shown in its file, on
// its author's lines; an unnamed one as a virtual source, the SCXML the
// codec writes from the definition, which the client reads by
// sourceReference and sets breakpoints in.
const SCXML_NS = 'xmlns="http://www.w3.org/2005/07/scxml" version="1.0"';
const order = (family) => `<scxml ${SCXML_NS} name="${family}">

  <state id="open">
    <transition event="ship" target="shipped">
      <raise event="notify"/>
    </transition>
  </state>

  <state id="shipped"/>
</scxml>`;

// The line of `text` holding `needle`, counting from 1.
const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

async function scxmlSources() {
  const system = createSystem({ clock: 'manual' });
  const path = '/charts/order.scxml';
  const named = order('named');
  system.spawn(system.define(named, { format: 'scxml', name: path }), { name: 'o1' });
  const unnamed = system.spawn(system.define(order('unnamed'), { format: 'scxml' }), { name: 'o2' });
  await system.flush();

  // A named document: frames and verified breakpoints on the author's lines.
  let client = new Client(system, { allow: ALL });
  await client.start({ address: 'named/o1' });
  let { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  assert.deepEqual([stackFrames[0].source, stackFrames[0].line],
                   [{ name: 'order.scxml', path }, lineOf(named, '<state id="open"')]);
  const set = await client.ok('setBreakpoints', { source: { path }, breakpoints: [
    { line: lineOf(named, '<raise') }, { line: lineOf(named, '<state id="shipped"') - 1 },
  ] });
  assert.deepEqual(set.breakpoints.map((breakpoint) => [breakpoint.verified, breakpoint.line]),
                   [[true, lineOf(named, '<raise')], [true, lineOf(named, '<state id="shipped"')]]);
  assert.ok((await client.ok('loadedSources')).sources.some((source) => source.path === path));
  await client.ok('disconnect');

  // An unnamed one: a virtual source whose text holds each frame's element.
  client = new Client(system, { allow: ALL });
  await client.start({ address: 'unnamed/o2' });
  ({ stackFrames } = await client.ok('stackTrace', { threadId: 1 }));
  const [frame] = stackFrames;
  assert.equal(frame.source.path, undefined);
  assert.ok(frame.source.sourceReference > 0, JSON.stringify(frame.source));
  assert.equal(frame.source.name, 'unnamed.scxml');
  const { content, mimeType } = await client.ok('source', { source: frame.source,
                                                            sourceReference: frame.source.sourceReference });
  assert.equal(mimeType, 'application/scxml+xml');
  const written = content.split('\n');
  assert.match(written[frame.line - 1], /<state id="open"/, 'the frame is on its state\'s line in the text');
  assert.equal(frame.column, written[frame.line - 1].indexOf('<') + 1);
  assert.ok((await client.ok('loadedSources')).sources.some((source) =>
    source.sourceReference === frame.source.sourceReference));

  // Breakpoints, locations and goto targets on its lines.
  const virtual = { name: frame.source.name, sourceReference: frame.source.sourceReference };
  const raise = lineOf(content, '<raise');
  const { breakpoints } = await client.ok('setBreakpoints', { source: virtual, breakpoints: [{ line: raise }] });
  assert.deepEqual([breakpoints[0].verified, breakpoints[0].line, breakpoints[0].source],
                   [true, raise, { ...virtual, origin: frame.source.origin }]);
  const locations = await client.ok('breakpointLocations', { source: virtual, line: 1, endLine: written.length });
  assert.deepEqual(locations.breakpoints.map((entry) => entry.line),
                   ['<state id="open"', '<transition', '<raise', '<state id="shipped"']
                     .map((needle) => lineOf(content, needle)));
  const { targets } = await client.ok('gotoTargets', { source: virtual, line: lineOf(content, '<state id="shipped"') });
  assert.deepEqual(targets.map((target) => [target.label, target.line]),
                   [['shipped', lineOf(content, '<state id="shipped"')]]);
  const mark = client.mark();
  unnamed.post('ship');
  await client.wrote(mark, /would have stopped after macrostep \d+: line \d+ \(action raise 1\)\n/);
  // After the macrostep the actor is at rest in the state it entered.
  ({ stackFrames } = await client.ok('stackTrace', { threadId: 1 }));
  assert.deepEqual([stackFrames[0].source.sourceReference, stackFrames[0].line],
                   [virtual.sourceReference, lineOf(content, '<state id="shipped"')]);
  await client.ok('setBreakpoints', { source: virtual, breakpoints: [] });
  await client.ok('disconnect');
  await client.refused('source', { sourceReference: virtual.sourceReference }, /attach first|no such source/);
  system.close();
}

// Child documents (napi ADRs 0021 and 0024): a child fetched by src is in
// the file its src names; a child inline in <content> counts its lines
// from the start of its content, so it is a virtual source and not its
// parent's file, as is a child fetched from a URI that is not a file.
async function scxmlChildren() {
  const system = createSystem({ clock: 'manual' });
  const child = (family) => `<scxml ${SCXML_NS} name="${family}">
  <state id="${family}_running"/>
</scxml>`;
  const files = { 'charts/fetched.scxml': child('fetched'), 'https://charts.test/remote.scxml': child('remote') };
  const parent = `<scxml ${SCXML_NS} name="parent">
  <state id="p">
    <invoke id="inline" type="scxml"><content>${child('inline')}</content></invoke>
    <invoke id="fetched" type="scxml" src="charts/fetched.scxml"/>
    <invoke id="remote" type="scxml" src="https://charts.test/remote.scxml"/>
  </state>
</scxml>`;
  system.spawn(system.define(parent, { format: 'scxml', name: '/charts/parent.scxml', resolve: (src) => files[src] }),
               { name: 'p1' });
  await system.flush();
  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'parent/p1' });
  // The inline child runs as a thread of its own, on the lines of its
  // virtual source.
  const { threads } = await client.ok('threads');
  const thread = threads.find((entry) => entry.name.includes('invocation inline '));
  assert.ok(thread !== undefined, JSON.stringify(threads));
  const [frame] = (await client.ok('stackTrace', { threadId: thread.id })).stackFrames;
  assert.deepEqual([frame.source.path, frame.source.name], [undefined, 'inline.scxml'],
                   'an inline child is not shown in its parent\'s file');
  const inline = await client.ok('source', { sourceReference: frame.source.sourceReference });
  assert.match(inline.content.split('\n')[frame.line - 1], /<state id="inline_running"/);
  // Every chart the system holds is a loaded source: the fetched child in
  // the file its src names, the remote one as SCXML written from it.
  const { sources } = await client.ok('loadedSources');
  assert.ok(sources.some((source) => source.path === 'charts/fetched.scxml'), JSON.stringify(sources));
  assert.ok(sources.some((source) => source.path === '/charts/parent.scxml'));
  const remote = sources.find((source) => source.name === 'remote.scxml');
  assert.ok(remote?.sourceReference > 0, JSON.stringify(sources));
  assert.match((await client.ok('source', { source: remote })).content, /<state id="remote_running"/);
  await client.ok('disconnect');
  system.close();
}

// The session ends when the attached actor goes; closing the transport
// detaches.
async function ending() {
  const { system, actor } = await world();
  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'subscription/acct_1' });
  actor.destroy();
  await client.ok('threads');
  assert.equal(client.events('terminated').length, 1);
  assert.match(client.output(), /is gone; the debug session ended/);
  assert.equal(client.session.attached, false);
  await client.refused('stackTrace', { threadId: 1 }, /attach/);

  const again = system.spawn(system.findDefinition({ family: 'subscription', revision: 'v1' }), { name: 'acct_1' });
  await system.flush();
  const second = new Client(system, { allow: ALL });
  await second.start({ address: 'subscription/acct_1' });
  second.session.close();
  second.session.close();
  again.post('payment.failed');
  await system.flush();
  assert.equal(again.inspect().data.failures, 1);
  assert.equal(second.audit.at(-1).reason, 'the connection closed');
  const count = second.messages.length;
  await second.session.receive({ seq: 99, type: 'request', command: 'threads' });
  assert.equal(second.messages.length, count, 'a closed session answers nothing');
  system.close();
}

// What a session evaluates on its own, and what evaluates before it
// changes something, obeys the permissions the attach has now and the audit
// hook: a condition set before a watch-only attach never runs, conditions
// and logpoint parts are audited at each hit, setVariable and setExpression
// are audited before their JavaScript runs, and exception breakpoints are
// audited like the others.
async function guardedEvaluations() {
  const system = createSystem({ clock: 'manual' });
  const definition = system.define(renewal());
  const actor = system.spawn(definition, { name: 'r1' });
  await system.flush();
  const renewing = stateLine(system, definition, 'renewing');
  const assign = definition.sourceOf('action', actionID(system, definition, 'assign', 1)).line;
  const effect = '(globalThis.conditionRan = (globalThis.conditionRan ?? 0) + 1) > 0';

  // Set while the session may evaluate, then attached watch-only: the
  // conditions are unverified and never run.
  const watcher = new Client(system, { allow: ALL });
  await watcher.ok('initialize', { clientID: 'test' });
  const early = await watcher.ok('setFunctionBreakpoints', { breakpoints: [{ name: 'renewing', condition: effect }] });
  assert.equal(early.breakpoints[0].verified, true);
  const line = await watcher.ok('setBreakpoints', { source: { path: __filename },
                                                    breakpoints: [{ line: renewing, condition: effect }] });
  await watcher.ok('attach', { address: 'renewal/r1', allow: [] });
  await watcher.ok('configurationDone');
  const changed = new Map(watcher.events('breakpoint').map(({ breakpoint }) => [breakpoint.id, breakpoint]));
  for (const id of [early.breakpoints[0].id, line.breakpoints[0].id]) {
    assert.equal(changed.get(id).verified, false, `breakpoint ${id} is unverified`);
    assert.match(changed.get(id).message, /"evaluate" permission/);
  }
  let mark = watcher.mark();
  await actor.send('renew');
  await system.flush();
  assert.equal(globalThis.conditionRan, undefined, 'no condition ran');
  assert.doesNotMatch(watcher.outputSince(mark), /would have stopped/);
  assert.ok(!watcher.audit.some((entry) => entry.type === 'evaluate'), 'nothing was evaluated');
  await watcher.ok('disconnect');

  // Conditions and logpoint parts are audited at each hit; refused, a
  // condition does not fire and a part is written as <refused>.
  let refuse = false;
  const client = new Client(system, {
    allow: ALL,
    audit: (entry) => {
      client.audit.push(entry);
      if (refuse && entry.type === 'evaluate') throw new Error('no code today');
    },
  });
  await client.start({ address: 'renewal/r1' });
  await client.ok('setFunctionBreakpoints', { breakpoints: [{ name: 'renewing', condition: 'renewals >= 0' }] });
  await client.ok('setBreakpoints', { source: { path: __filename },
                                      breakpoints: [{ line: assign, logMessage: 'renewals is {renewals}' }] });
  mark = client.mark();
  let audited = client.audit.length;
  await actor.send('renew');
  await client.wrote(mark, /would have stopped after macrostep \d+: entered renewing\n/);
  assert.match(client.outputSince(mark), /renewals is \d+\n/);
  assert.deepEqual(client.audit.slice(audited).filter((entry) => entry.type === 'evaluate')
    .map(({ context, expression }) => `${context}: ${expression}`).sort(),
  ['condition: renewals >= 0', 'logpoint: renewals']);
  refuse = true;
  mark = client.mark();
  await actor.send('renew');
  await client.wrote(mark, /renewals is <refused>\n/);
  assert.doesNotMatch(client.outputSince(mark), /would have stopped/);
  assert.match(client.outputSince(mark), /the audit hook refused the condition of breakpoint \d+: no code today/);

  // setVariable and setExpression: the audit hook hears the expression
  // before it runs, and refusing it leaves no side effect.
  const { stackFrames } = await client.ok('stackTrace', { threadId: 1 });
  const { scopes } = await client.ok('scopes', { frameId: stackFrames[0].id });
  const data = scopes.find((scope) => scope.name === 'Data model');
  await client.refused('setVariable', { variablesReference: data.variablesReference, name: 'renewals',
                                        value: '(globalThis.setRan = true, 7)' }, /audit hook refused it: no code today/);
  await client.refused('setExpression', { frameId: stackFrames[0].id, expression: 'renewals',
                                          value: '(globalThis.setRan = true, 7)' }, /audit hook refused it: no code today/);
  assert.equal(globalThis.setRan, undefined, 'the refused expressions did not run');
  assert.notEqual(actor.data().renewals, 7);
  refuse = false;
  audited = client.audit.length;
  await client.ok('setVariable', { variablesReference: data.variablesReference, name: 'renewals', value: '3 + 4' });
  assert.deepEqual(client.audit.slice(audited).map((entry) => `${entry.type}:${entry.context ?? entry.operation}`),
                   ['evaluate:setVariable', 'mutation:set']);
  assert.equal(actor.data().renewals, 7);

  // Exception breakpoints are breakpoint changes the hook hears, and can refuse.
  audited = client.audit.length;
  await client.ok('setExceptionBreakpoints', { filters: ['runaway'] });
  assert.deepEqual(client.audit.slice(audited).map(({ type, kind, filters }) => ({ type, kind, filters })),
                   [{ type: 'breakpoints', kind: 'exception', filters: ['runaway'] }]);
  const shut = new Client(system, { allow: ALL, audit: (entry) => {
    if (entry.type === 'breakpoints') throw new Error('frozen');
  } });
  await shut.start({ address: 'renewal/r1' });
  await shut.refused('setExceptionBreakpoints', { filters: ['runaway'] }, /audit hook refused it: frozen/);
  await shut.ok('disconnect');
  await client.ok('disconnect');
  system.close();
}

// An invocation's serviceHandle names its in-system child by runtime ID,
// not session ID, and the debugger resolves the child from it. Here slots
// were reused before the parent started, and another actor of the child's
// chart runs beside it with other data: the child thread and the
// Invocations scope show the invoked child.
async function invokedChildByRuntimeID() {
  const system = createSystem({ clock: 'manual' });
  const filler = system.define(statechart({ family: 'filler', revision: 'v1' }).state('idle'));
  for (let index = 0; index < 3; index += 1) system.spawn(filler).destroy();
  const child = system.define(statechart({ family: 'worker', revision: 'v1' }).data('jobs', 3).state('working'));
  const parent = system.define(statechart({ family: 'boss', revision: 'v1' })
    .state('supervising', (s) => s.invoke((i) => i.type('scxml').id('kid').content(child))));
  const actor = system.spawn(parent, { name: 'b1' });
  await system.flush();
  const [invocation] = actor.inspect().invocations;
  const handle = invocation.serviceHandle;
  const invoked = { slot: Number(handle & 0xffffffffn), generation: Number(handle >> 32n) };
  const kid = [...system.actors()].find((view) => view.actor.slot === invoked.slot).actor;
  assert.equal(kid.generation, invoked.generation);
  system.spawn(child, { binding: { jobs: 99 } });
  await system.flush();

  const client = new Client(system, { allow: ALL });
  await client.start({ address: 'boss/b1' });
  const { threads } = await client.ok('threads');
  assert.deepEqual(threads.map((thread) => thread.name),
                   ['boss/b1 · supervising', 'boss/b1 invocation kid · working']);
  const { stackFrames } = await client.ok('stackTrace', { threadId: threads[1].id });
  const { scopes } = await client.ok('scopes', { frameId: stackFrames[0].id });
  const read = async (id, name) => {
    const scope = (await client.ok('scopes', { frameId: id })).scopes.find((entry) => entry.name === name);
    return (await client.ok('variables', { variablesReference: scope.variablesReference })).variables;
  };
  assert.ok(scopes.length > 0);
  const jobs = (await read(stackFrames[0].id, 'Data model')).find((variable) => variable.name === 'jobs');
  assert.equal(jobs.value, '3', 'the child thread is the invoked child');
  const [entry] = await read((await client.ok('stackTrace', { threadId: threads[0].id })).stackFrames[0].id,
                             'Invocations');
  const fields = await client.ok('variables', { variablesReference: entry.variablesReference });
  assert.equal(fields.variables.find((variable) => variable.name === 'thread').value,
               `"${threads[1].id} boss/b1 invocation kid"`);
  await client.ok('disconnect');
  system.close();
}

(async () => {
  await framing();
  await options();
  await session();
  await liveView();
  await breakpoints();
  await console();
  await permissions();
  await audit();
  await guardedEvaluations();
  await state();
  await catalog();
  await sources();
  await movedLines();
  await scxmlSources();
  await scxmlChildren();
  await invokedChildByRuntimeID();
  await runaway();
  await lostMail();
  await ending();
  clearTimeout(watchdog);
  process.stdout.write('debug.js passed\n');
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
