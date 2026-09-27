'use strict';

// Answers which declared names exist at runtime, for mise/tasks/check-api-status.
// Input (argv[2]): a JSON file { exports: [name], members: { Interface: [name] } }.
// Output (stdout): the same shape, each name mapped to true when the runtime has it.
// An interface this probe cannot reach an instance of maps to null.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const api = require(root);
const { createSystem, statechart, TinyactorsError } = api;

async function instances() {
  const found = {};
  const system = createSystem({ clock: 'manual' });
  found.System = system;
  const chart = statechart({ family: 'probe', revision: 'v1' }).data('n', 0);
  found.DefinitionBuilder = chart;
  found.StateContainerBuilder = chart;
  chart.state('a', (state) => {
    found.StateBuilder = state;
    state.on('go', (transition) => {
      found.TransitionBuilder = transition;
      found.ActionSequenceBuilder = transition;
      transition.send('out', (send) => {
        found.SendBuilder = send;
      });
    });
    state.invoke((invoke) => {
      found.InvokeBuilder = invoke;
      invoke.type('probe');
      invoke.finalize((actions) => {
        found.ActionBuilder = actions;
      });
    });
  });
  chart.final('z', (state) => {
    state.doneData((done) => {
      found.DoneDataBuilder = done;
    });
  });
  const definition = system.define(statechart({ family: 'probe-run', revision: 'v1' })
    .state('a', (state) => state.entry((entry) => entry.send('later', (send) => send.after(1000)))));
  found.Definition = definition;
  found.DefinitionInspection = definition.inspect();
  const actor = system.spawn(definition, { name: 'probe' });
  found.Actor = actor;
  found.ActorID = actor;
  found.SessionImage = system.capture(actor);
  found.PreparedActor = system.prepareReplacement(actor, definition);
  found.TinyactorsError = new TinyactorsError('probe', 'invalid');
  await system.flush();
  // Records the runtime returns: only their required fields are judged.
  found.ActorInspection = system.inspect(actor);
  found.DelayedSendInspection = found.ActorInspection.delayedSends[0];
  found.SystemStats = system.stats();
  found.MetricsSnapshot = system.metrics();
  return { found, system };
}

(async () => {
  const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { found, system } = await instances();
  // Records, whose optional fields may be absent at runtime without meaning anything.
  const RECORDS = new Set(['ActorInspection', 'DelayedSendInspection', 'SystemStats', 'MetricsSnapshot',
                           'DefinitionInspection']);
  const answer = { exports: {}, members: {} };
  for (const name of request.exports) {
    answer.exports[name] = Object.prototype.hasOwnProperty.call(api, name);
  }
  for (const [kind, names] of Object.entries(request.members)) {
    const instance = found[kind];
    if (instance === undefined) {
      answer.members[kind] = null;
      continue;
    }
    answer.members[kind] = {};
    for (const name of names) {
      answer.members[kind][name] = name in Object(instance);
    }
    if (RECORDS.has(kind)) {
      answer.members[kind].__record = true;
    }
  }
  system.close();
  process.stdout.write(JSON.stringify(answer));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
