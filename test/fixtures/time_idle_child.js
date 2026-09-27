'use strict';

// Run by test/time.js: a realtime system whose only pending work is a send
// an hour away. Its timer is unreferenced (ADR 0007 point 3), so the process
// must exit as soon as this script is done, without closing the system.

const { createSystem, statechart } = require('../..');

(async () => {
  const system = createSystem();
  const actor = system.spawn(system.define(
    statechart({ family: 'later', revision: 'v1' })
      .state('wait', (s) => s.entry((a) => a.send('tick', (m) => m.after(3_600_000))))));
  await system.flush();
  const [send] = actor.inspect().delayedSends;
  console.log(`armed ${send.event} due ${send.due}`);
})();
