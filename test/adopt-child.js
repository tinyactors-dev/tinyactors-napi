'use strict';
// The adopting host of export.test.js, in its own process: reads exported
// actors (base64 JSON on stdin), adopts them into a fresh system with its own
// clock, lets their delayed events fire and prints what the actors hold.
const { createSystem } = require('./binding');
require('./movers'); /* the machine, defined in this process too */

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const blobs = JSON.parse(input);
  let now = 5000;
  const system = createSystem({ id: 'child', clock: () => now });
  const actors = Object.fromEntries(Object.entries(blobs).map(([k, b]) => [k, system.adopt(new Uint8Array(Buffer.from(b, 'base64')))]));
  const view = () => Object.fromEntries(Object.entries(actors).map(([k, a]) => [k, { value: a.getSnapshot().value, context: a.getSnapshot().context }]));
  system.flush();
  now += 69; /* 70 ms were left at export */
  system.flush();
  const before = view();
  now += 1;
  system.flush();
  actors.xstate.send({ type: 'INC' });
  system.flush();
  process.stdout.write(JSON.stringify({ before, after: view(), address: actors.xstate.address, session: actors.scxml.address }));
});
