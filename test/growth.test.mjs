// Pools that fill during a run (docs/log.xml, l-p4-examples-chat-events-crash):
// actors' own sends, raises and invokes outgrow the default config, and the
// host grows its pools between runs. The process crashed in ta_host_run when
// 200 actors each sent one event at entry to one named actor; each case
// here ends idle with every event delivered.
import { equal, hostWith, scxml } from './charts.mjs';
import { run, test } from './harness.mjs';

/** Logs each `hello` it gets. */
const sink = scxml('sink', `
  <state id="s"><transition event="hello"><log label="got" expr="'hello'"/></transition></state>`);

/** One send at entry to the named sink. */
const src = scxml('src', `
  <state id="s"><onentry><send event="hello" target="tinyactors://t/@sink"/></onentry></state>`);

/** 1000 sends to the sink from one <foreach>. */
const fanout = scxml('fanout', `
  <datamodel><data id="items" expr="Array.from({ length: 1000 }, (_, i) => i)"/></datamodel>
  <state id="s"><onentry>
    <foreach array="items" item="i"><send event="hello" target="tinyactors://t/@sink"/></foreach>
  </onentry></state>`);

/** An SCXML child invoked at entry, done at once: its done.invoke is logged. */
const parent = scxml('parent', `
  <state id="s">
    <invoke type="scxml"><content>
      <scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" initial="f"><final id="f"/></scxml>
    </content></invoke>
    <transition event="done.invoke"><log label="got" expr="'hello'"/></transition>
  </state>`);

/** A host of the four charts on the default config, the lines it logged
 * 'hello', and the sink spawned. */
function world() {
  const got = [];
  const host = hostWith({ sink, src, fanout, parent }, { log: (h, entry) => { if (entry.label === 'got') got.push(entry.text); } });
  host.spawnChart('sink', { name: 'sink' });
  return { host, got };
}

test('200 actors that each send one event at entry to one actor', async () => {
  const { host, got } = world();
  for (let i = 0; i < 200; i++) host.spawnChart('src');
  await host.idle();
  equal(got.length, 200, 'events delivered');
  host.close();
});

test('2000 actors that each send one event at entry to one actor', async () => {
  const { host, got } = world();
  for (let i = 0; i < 2000; i++) host.spawnChart('src');
  await host.idle();
  equal(got.length, 2000, 'events delivered');
  host.close();
});

test('1000 sends from one <foreach>', async () => {
  const { host, got } = world();
  host.spawnChart('fanout');
  await host.idle();
  equal(got.length, 1000, 'events delivered');
  host.close();
});

test('300 invokes at entry, each with its done.invoke', async () => {
  const { host, got } = world();
  for (let i = 0; i < 300; i++) host.spawnChart('parent');
  await host.idle();
  equal(got.length, 300, 'done events delivered');
  host.close();
});

await run();
