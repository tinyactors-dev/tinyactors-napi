'use strict';
// A system in a child process, linked to its parent over stdio: length-prefixed
// frames on stdin/stdout (frames.test.js). stdout carries the link, so logs go
// to stderr. Calls the parent's @echo once linked and reports the reply to the
// parent's @inbox; its own @echo answers the parent. Exits when stdin ends.
const { createMachine, createActor, createSystem, createLink, sendTo } = require('../binding');

const system = createSystem({ id: 'kid', logger: (...a) => console.error(...a) });
createActor(
  createMachine({
    id: 'echo',
    on: { PING: { actions: sendTo(({ event }) => event.from, ({ event }) => ({ type: 'PONG', tag: event.tag })) } },
  }),
  { system, systemID: 'echo' },
).start();

const link = createLink(system, {
  name: 'parent',
  pingMs: 0,
  transport: () => ({ readable: process.stdin, writable: process.stdout }),
});
const inbox = link.get('inbox');
const kid = createActor(
  createMachine({
    id: 'kid',
    context: { tags: [] },
    on: {
      CALL: { actions: sendTo(() => link.get('echo'), ({ self }) => ({ type: 'PING', from: self, tag: 'from-kid' })) },
      PONG: { actions: sendTo(() => inbox, ({ event }) => ({ type: 'GOT', tag: event.tag })) },
    },
  }),
  { system },
).start();
let called = false;
link.subscribe((s) => {
  if (s.value === 'open' && !called) {
    called = true;
    kid.send({ type: 'CALL' });
  }
});
process.stdin.on('end', () => process.exit(0));
