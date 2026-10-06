'use strict';
// Actors for the export/adopt tests (export.test.js and the adopting process,
// adopt-child.js): a machine and an SCXML document, each with a delayed event
// whose data must arrive intact in another process.
const { createMachine, fromSCXML, raise, assign } = require('./binding');

const mover = createMachine({
  id: 'mover',
  initial: 'waiting',
  context: { got: null, n: 1 },
  states: {
    waiting: {
      entry: raise({ type: 'LATE', seen: new Map([['k', [1, 2]]]), at: new Date(5) }, { delay: 100 }),
      on: {
        LATE: { target: 'arrived', actions: assign(({ event }) => ({ got: { k: event.seen.get('k'), at: event.at.getTime() } })) },
        INC: { actions: assign(({ context }) => ({ n: context.n + 1 })) },
      },
    },
    arrived: { on: { INC: { actions: assign(({ context }) => ({ n: context.n + 1 })) } } },
  },
});

/* a chart with top-level declarations: its function is re-created where it is adopted */
const moverXML = `<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" datamodel="ecmascript" initial="w">
  <datamodel><data id="got" expr="null"/></datamodel>
  <script>var hits = 0; function hit(v) { hits += 1; return v; }</script>
  <state id="w">
    <onentry><send event="late" delay="100ms"><param name="v" expr="({ list: [1, 2], when: new Date(7) })"/></send></onentry>
    <transition event="late" target="done"><assign location="got" expr="hit(_event.data.v)"/></transition>
  </state>
  <state id="done"/>
</scxml>`;
const scxmlMover = fromSCXML(moverXML, { id: 'scxml-mover' });

module.exports = { mover, scxmlMover, moverXML };
