'use strict';

// The debug console: what a client sends as `evaluate` with context
// `repl`, and the completions it offers there.
//
//   send <event> [json]            deliver through the actor's mailbox, with the console as origin
//   goto <state…> [from <state>]   an operator transition (core ADR 0082)
//   abandon                        abandon a macrostep that never ends (core ADR 0082)
//   cancel <send ID>               withdraw one pending delayed send (core ADR 0084)
//   replace <revision>             hot-replace the actor with another revision of its family
//   <expression>                   JavaScript over the data model (lib/debug/expressions)
//
// The console is a sender an actor can answer (core ADR 0068): the adapter
// registers an I/O processor of type `debug` once per system and opens one
// scope per session, so a chart's reply to `event.origin` reaches the
// session that sent the message.

const { TinyactorsError } = require('../errors');
const { locations } = require('./expressions');

const TYPE = 'debug';
const COMMANDS = ['send', 'goto', 'abandon', 'cancel', 'replace', 'help'];

const HELP = [
  'send <event> [json]            deliver an event, queued behind the actor\'s mail; replies show here',
  'goto <state…> [from <state>]   an operator transition: exits, entries and history as a transition\'s',
  'abandon                        abandon a macrostep that never ends; the actor keeps its last configuration',
  'cancel <send ID>               withdraw a pending delayed send, by the ID the Timers scope shows',
  'replace <revision>             replace the actor with another registered revision of its family',
  '<expression>                   JavaScript over the data model: `failures`, `.items[0]`, `inState("busy")`',
];

/**
 * Splits a console line into a command and its arguments, or answers
 * { command: 'expression', text } for anything else.
 */
function parse(line) {
  const text = String(line).trim();
  const [word, ...rest] = text.split(/\s+/);
  const tail = text.slice(word.length).trim();
  switch (word) {
    case 'send': {
      if (rest.length === 0) throw new TinyactorsError('send <event> [json]', 'invalid');
      const event = rest[0];
      const json = tail.slice(event.length).trim();
      let data;
      if (json !== '') {
        try {
          data = JSON.parse(json);
        } catch (error) {
          throw new TinyactorsError(`the event data is not JSON: ${error.message}`, 'invalid');
        }
      }
      return { command: 'send', event, data };
    }
    case 'goto': {
      const at = rest.indexOf('from');
      const targets = at < 0 ? rest : rest.slice(0, at);
      const from = at < 0 ? undefined : rest[at + 1];
      if (targets.length === 0 || (at >= 0 && (from === undefined || rest.length > at + 2))) {
        throw new TinyactorsError('goto <state…> [from <state>]', 'invalid');
      }
      return { command: 'goto', targets, from };
    }
    case 'abandon':
    case 'help':
      return { command: word };
    case 'cancel':
      if (rest.length !== 1) throw new TinyactorsError('cancel <send ID>: the ID the Timers scope shows', 'invalid');
      return { command: 'cancel', id: rest[0] };
    case 'replace':
      if (rest.length !== 1) {
        throw new TinyactorsError('replace <revision>: a registered revision of the actor\'s family', 'invalid');
      }
      return { command: 'replace', revision: rest[0] };
    default:
      return { command: 'expression', text };
  }
}

/**
 * Completion targets for `text` with the cursor at `column` (0-based).
 * `context` gives events(), states(), sendIDs() and data() of the actor.
 */
function completions(text, column, context) {
  const before = String(text).slice(0, column);
  const target = (label, start, type) => ({ label, text: label, start, length: column - start, type });
  let match = /^\s*send\s+(\S*)$/.exec(before);
  if (match !== null) {
    const prefix = match[1];
    return context.events().filter((name) => name.startsWith(prefix))
      .map((name) => target(name, column - prefix.length, 'event'));
  }
  match = /^\s*goto\s+(?:\S+\s+)*(\S*)$/.exec(before);
  if (match !== null) {
    const prefix = match[1];
    return context.states().filter((name) => name.startsWith(prefix))
      .map((name) => target(name, column - prefix.length, 'value'));
  }
  match = /^\s*cancel\s+(\S*)$/.exec(before);
  if (match !== null) {
    const prefix = match[1];
    return context.sendIDs().filter((id) => id.startsWith(prefix))
      .map((id) => target(id, column - prefix.length, 'value'));
  }
  match = /^\s*(\w*)$/.exec(before);
  if (match !== null && match[1] !== '') {
    const words = COMMANDS.filter((word) => word.startsWith(match[1]));
    if (words.length > 0) return words.map((word) => target(word, column - match[1].length, 'keyword'));
  }
  return locations(before, context.data()).map(({ label, start }) => target(label, start, 'property'));
}

// One `debug` I/O processor per system; replies find their session by the
// scope URI they are sent to.
const registries = new WeakMap();

/**
 * Registers the `debug` I/O processor on `system` (once), opens a scope
 * for `uri`, and routes replies sent to it to `onReply(request)`. Answers
 * { scope, close() }.
 */
function openConsole(system, uri, onReply) {
  let registry = registries.get(system);
  if (registry === undefined) {
    registry = new Map();
    registries.set(system, registry);
    system.registerIO(TYPE, {
      send(request) {
        const listener = registry.get(String(request.target));
        if (listener === undefined) {
          throw new TinyactorsError(`no debug session listens at ${request.target}`, 'not-found');
        }
        listener(request);
      },
    });
  }
  const scope = system.openScope(TYPE, uri);
  registry.set(uri, onReply);
  return {
    scope,
    close() {
      registry.delete(uri);
      if (!system.closed) system.closeScope(scope);
    },
  };
}

module.exports = { parse, completions, openConsole, HELP, TYPE };
