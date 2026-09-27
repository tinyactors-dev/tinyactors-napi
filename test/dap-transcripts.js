'use strict';

// Plays the shared DAP transcripts (tinyactors-test/dap/README.md) against
// napi's debug adapter: for each transcript, a System with one actor of its
// chart, a debug session attached to it with every permission, then its
// steps. The test host's
// ruby/dap_transcripts.rb plays the same transcripts against its adapter.
// Runs on Node and Bun.
//
//   node test/dap-transcripts.js                # every transcript
//   node test/dap-transcripts.js stepping goto  # these, by file name
//   DAP_TRACE=1 node test/dap-transcripts.js    # and print every message

const fs = require('node:fs');
const path = require('node:path');
const { createSystem, statechart, createDebugSession } = require('..');

const DIRECTORY = path.join(__dirname, '../../tinyactors-test/dap');
// The name of this host in a transcript's `only`, and of its form of an
// expression in `$expr`.
const HOST = 'napi';
const EXPRESSION_FORM = 'js';
// The name of the one actor of each transcript.
const ACTOR = 'a1';
// Event-loop turns a step waits for the events it expects.
const MOST_TURNS = 5000;
const trace = process.env.DAP_TRACE !== undefined;

const watchdog = setTimeout(() => {
  console.error('dap-transcripts.js: timed out');
  process.exit(1);
}, 120000);

const turn = () => new Promise((resolve) => setImmediate(resolve));

// A step whose messages did not match.
class Mismatch extends Error {}

const text = (value) => JSON.stringify(value) ?? 'nothing';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const special = (value) => isObject(value) && Object.keys(value).length === 1 && Object.keys(value)[0].startsWith('$');

function failAt(where, wanted, actual) {
  throw new Mismatch(`at ${where === '' ? 'the top' : where}: expected ${wanted}, got ${text(actual)}`);
}

// Structural matching of what a transcript expects against what the
// adapter sent (tinyactors-test/dap/README.md, "Matching"). Answers the
// bindings with what the match captured, or throws Mismatch.
function match(expected, actual, bindings, where = '') {
  if (special(expected)) return matchSpecial(expected, actual, bindings, where);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) failAt(where, `${expected.length} elements`, actual);
    return elements(expected, actual, bindings, where);
  }
  if (isObject(expected)) {
    if (!isObject(actual)) failAt(where, 'an object', actual);
    let bound = bindings;
    for (const [key, value] of Object.entries(expected)) {
      const at = `${where}.${key}`;
      if (special(value) && Object.hasOwn(value, '$absent')) {
        if (Object.hasOwn(actual, key)) failAt(at, 'nothing', actual[key]);
      } else {
        if (!Object.hasOwn(actual, key)) failAt(at, text(value), undefined);
        bound = match(value, actual[key], bound, at);
      }
    }
    return bound;
  }
  if (expected !== actual) failAt(where, text(expected), actual);
  return bindings;
}

function matchSpecial(expected, actual, bindings, where) {
  const [[key, argument]] = Object.entries(expected);
  switch (key) {
    case '$any': return bindings;
    case '$capture': return { ...bindings, [argument]: actual };
    case '$var':
      if (!Object.hasOwn(bindings, argument)) failAt(where, `no variable ${argument}`, actual);
      return match(bindings[argument], actual, bindings, where);
    case '$expr': return match(argument[EXPRESSION_FORM], actual, bindings, where);
    case '$text': {
      const wanted = argument.replace(/\{(\w+)\}/g, (whole, name) => {
        if (!Object.hasOwn(bindings, name)) failAt(where, `no variable ${name}`, actual);
        return String(bindings[name]);
      });
      if (actual !== wanted) failAt(where, text(wanted), actual);
      return bindings;
    }
    case '$contains':
      if (typeof actual !== 'string' || !actual.includes(argument)) failAt(where, `a string containing ${text(argument)}`, actual);
      return bindings;
    case '$prefix':
      if (typeof argument === 'string') {
        if (typeof actual !== 'string' || !actual.startsWith(argument)) failAt(where, `a string starting with ${text(argument)}`, actual);
        return bindings;
      }
      if (!Array.isArray(actual) || actual.length < argument.length) failAt(where, `at least ${argument.length} elements`, actual);
      return elements(argument, actual.slice(0, argument.length), bindings, where);
    case '$some':
      if (!Array.isArray(actual)) failAt(where, 'an array', actual);
      for (const element of actual) {
        try {
          return match(argument, element, bindings, where);
        } catch (error) {
          if (!(error instanceof Mismatch)) throw error;
        }
      }
      return failAt(where, `an element matching ${text(argument)}`, actual);
    default: throw new Error(`unknown matcher ${key} at ${where}`);
  }
}

function elements(expected, actual, bindings, where) {
  return expected.reduce((bound, value, index) => match(value, actual[index], bound, `${where}[${index}]`), bindings);
}

// A request's arguments with `$var` and `$expr` replaced.
function substitute(value, bindings) {
  if (special(value) && Object.hasOwn(value, '$var')) {
    if (!Object.hasOwn(bindings, value.$var)) throw new Mismatch(`no variable ${value.$var}`);
    return bindings[value.$var];
  }
  if (special(value) && Object.hasOwn(value, '$expr')) return value.$expr[EXPRESSION_FORM];
  if (Array.isArray(value)) return value.map((inner) => substitute(inner, bindings));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, substitute(inner, bindings)]));
  return value;
}

// One transcript played against a fresh System and session.
class Transcript {
  constructor(file) {
    this.name = path.basename(file, '.json');
    this.spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  get skipReason() {
    const { only, why } = this.spec;
    return only !== undefined && only !== HOST ? `only for ${only}: ${why}` : undefined;
  }

  async play() {
    const chart = require(path.join(DIRECTORY, 'charts', `${this.spec.chart}.js`));
    this.system = createSystem({ clock: 'manual' });
    this.system.spawn(this.system.define(chart(statechart)), { name: ACTOR });
    await this.system.flush();
    this.pending = [];
    this.responses = new Map();
    this.seq = 0;
    this.bindings = {};
    this.initialized = false;
    this.session = createDebugSession(this.system, {
      allow: ['send', 'set', 'goto', 'evaluate'],
      send: (message) => {
        if (trace) process.stderr.write(`<- ${JSON.stringify(message)}\n`);
        if (message.type === 'event') this.pending.push(message);
        else if (message.type === 'response') this.responses.set(message.request_seq, message);
      },
    });
    try {
      for (const [index, step] of this.spec.steps.entries()) {
        try {
          await this.step(step);
        } catch (error) {
          if (error instanceof Mismatch) error.message = `step ${index + 1} (${describe(step)}): ${error.message}`;
          throw error;
        }
      }
    } finally {
      this.session.close();
      this.system.close();
    }
  }

  async step(step) {
    if (Object.hasOwn(step, 'start')) await this.start();
    else if (Object.hasOwn(step, 'request')) await this.request(step);
    else if (Object.hasOwn(step, 'events')) await this.expectEvents(step.events);
    else if (Object.hasOwn(step, 'event')) await this.expectEvents([step]);
    else throw new Error(`${this.name}: a step is start, request, event or events: ${text(step)}`);
  }

  async send(command, args) {
    this.seq += 1;
    const seq = this.seq;
    const message = { seq, type: 'request', command, arguments: args };
    if (trace) process.stderr.write(`-> ${JSON.stringify(message)}\n`);
    await this.session.receive(message);
    const response = this.responses.get(seq);
    if (response === undefined) throw new Mismatch(`${command} was not answered`);
    this.responses.delete(seq);
    return response;
  }

  // The session start of this host: attach to the actor, which the session
  // reports stopped once, on entry, and never stops (napi ADR 0026).
  // `thread` is its thread.
  async start() {
    if (!this.initialized) {
      await this.send('initialize', { adapterID: 'tinyactors', linesStartAt1: true, columnsStartAt1: true,
                                      supportsInvalidatedEvent: true });
      this.initialized = true;
    }
    const attached = await this.send('attach', { address: `${this.spec.chart}/${ACTOR}` });
    if (!attached.success) throw new Mismatch(`attach failed: ${attached.message}`);
    await this.send('configurationDone', {});
    await this.expectEvents([{ event: 'stopped', body: { reason: 'entry', threadId: { $capture: 'thread' } } }]);
    const { threads } = (await this.send('threads', {})).body;
    this.bindings.title = threads.find((thread) => thread.id === this.bindings.thread).name.split(' · ')[0];
  }

  async request(step) {
    const command = step.request;
    if (command === 'initialize') this.initialized = true;
    const response = await this.send(command, substitute(step.arguments ?? {}, this.bindings));
    this.bindings = match({ success: true, ...step.response }, response, this.bindings, 'response');
  }

  // Waits until each expected event has a distinct pending event of its
  // name that matches, then takes those and every earlier pending event of
  // the same names.
  async expectEvents(expected) {
    let found;
    for (let turns = 0; (found = this.assign(expected)) === undefined; turns += 1) {
      if (turns >= MOST_TURNS) throw new Mismatch(this.missing(expected));
      await turn();
    }
    const [events, bindings] = found;
    this.bindings = bindings;
    const last = new Map();
    for (const event of events) {
      last.set(event.event, Math.max(last.get(event.event) ?? -1, this.pending.indexOf(event)));
    }
    this.pending = this.pending.filter((event, index) => !(last.has(event.event) && index <= last.get(event.event)));
  }

  // The first pending event for each expectation, in order, or undefined.
  assign(expected) {
    const taken = [];
    let bindings = this.bindings;
    for (const expectation of expected) {
      const found = this.pending.find((event) => {
        if (event.event !== expectation.event || taken.includes(event)) return false;
        try {
          bindings = match(expectation.body ?? {}, event.body ?? {}, bindings, `${expectation.event} event`);
          return true;
        } catch (error) {
          if (error instanceof Mismatch) return false;
          throw error;
        }
      });
      if (found === undefined) return undefined;
      taken.push(found);
    }
    return [taken, bindings];
  }

  missing(expected) {
    const lines = expected.map(({ event, body }) => {
      const bodies = this.pending.filter((pending) => pending.event === event).map((pending) => text(pending.body));
      return `  expected ${event} ${text(body ?? {})}; pending ${event} events: ${bodies.length === 0 ? 'none' : bodies.join(', ')}`;
    });
    return `timed out waiting for events\n${lines.join('\n')}`;
  }
}

function describe(step) {
  if (Object.hasOwn(step, 'start')) return 'start';
  if (Object.hasOwn(step, 'request')) return step.request;
  return (step.events ?? [step]).map((event) => event.event).join(', ');
}

(async () => {
  const wanted = process.argv.slice(2);
  const files = fs.readdirSync(path.join(DIRECTORY, 'transcripts')).filter((file) => file.endsWith('.json')).sort()
    .filter((file) => wanted.length === 0 || wanted.includes(path.basename(file, '.json')));
  if (files.length === 0) throw new Error('no transcripts');
  const failures = [];
  for (const file of files) {
    const transcript = new Transcript(path.join(DIRECTORY, 'transcripts', file));
    const reason = transcript.skipReason;
    if (reason !== undefined) {
      process.stdout.write(`  skip ${transcript.name}: ${reason}\n`);
      continue;
    }
    try {
      await transcript.play();
      process.stdout.write(`  ok   ${transcript.name}\n`);
    } catch (error) {
      failures.push(transcript.name);
      process.stdout.write(`  FAIL ${transcript.name}: ${error instanceof Mismatch ? error.message : error?.stack ?? error}\n`);
    }
  }
  clearTimeout(watchdog);
  if (failures.length > 0) {
    process.stdout.write(`dap-transcripts.js failed: ${failures.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`dap-transcripts.js passed (${files.length})\n`);
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
