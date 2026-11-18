// The bank's rules, each on a SimulatedClock on both datamodels: a trip
// and its done event, the In() guards between the regions, maintenance and
// the deep history that resumes it, the door controller invoked and
// cancelled, the dispatcher's reassignments, the overload and the fire
// recall; the monitor caught on two broken charts; then generated
// scenarios with every invariant checked. Run by `mise run examples`
// (`node test.mjs`, `bun test ./test.mjs`).
//
// ELEVATOR_FULL=1 plays 1000 generated scenarios on each datamodel instead
// of 25; ELEVATOR_SCENARIOS=<n> plays n.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimulatedClock } from '@tinyactors/node';
import { Building, CHARTS } from './building.mjs';
import { demo, runUntil } from './main.mjs';
import { generate, play, playAll } from './scenarios.mjs';

const DATAMODELS = ['native', 'quickjs'];
const SCENARIOS = Number(process.env.ELEVATOR_SCENARIOS ?? (process.env.ELEVATOR_FULL ? 1000 : 25));

/** A building on a simulated clock, its reports kept as `[at, car, event, detail]`
 * and `[at, 'dispatcher', event, floor, car?]`. */
function setup(datamodel, spec = {}, charts) {
  const clock = new SimulatedClock();
  const reports = [];
  const building = new Building({
    clock, datamodel, spec, charts,
    trace: (line) => {
      const [at, who, ...rest] = line.split(' ');
      reports.push([Number(at), who, ...rest]);
    },
  });
  const after = async (ms) => runUntil(building, clock, clock.now + ms);
  /** Steps deadline by deadline until `condition()` holds. */
  const until = async (condition) => {
    for (let i = 0; !condition(); i++) {
      assert.ok(i < 1000 && building.host.nextDeadline !== undefined, 'the condition never holds');
      clock.increment(building.host.nextDeadline);
      await building.host.idle();
    }
  };
  const of = (who, event) => reports.filter((r) => r[1] === who && (!event || r[2] === event));
  return { clock, building, reports, after, until, of, monitor: building.monitor };
}

/** The door controllers `car` runs now, by actorGet. */
async function invocations(building, car) {
  return (await building.host.actorGet({ session: building.sessions.get(car) })).invocations;
}

for (const datamodel of DATAMODELS) {
  test(`${datamodel}: a hall call: the cheapest car goes floor by floor, the trip completes, the doors cycle`, async () => {
    const { building, after, of, monitor } = setup(datamodel, { cars: 2 });
    try {
      await after(0);
      building.hallCall(3);
      await after(4500);
      // car-0 and car-1 both stand at 0; the tie goes to the first.
      assert.deepEqual(of('dispatcher').map((r) => r.slice(2)), [['call.assigned', '3', 'car-0'], ['call.served', '3', 'car-0']]);
      assert.deepEqual(of('car-0', 'position').map((r) => [r[0], r[3]]), [[1500, '1'], [3000, '2'], [4500, '3']]);
      // done.state.moving: the trip completed, the car stopped and opened.
      assert.deepEqual(of('car-0', 'motor').map((r) => r[3]), ['start', 'stop']);
      assert.deepEqual((await building.inspect('car-0')).states, ['cycling', 'normal', 'stopped']);
      assert.equal(await invocations(building, 'car-0'), 1, 'the door controller runs');
      await after(1000 + 3000 + 1000);
      assert.deepEqual(of('car-0', 'door').map((r) => [r[0], r[3]]), [[4500, 'opening'], [5500, 'open'], [8500, 'closing'], [9500, 'closed']]);
      // done.invoke.door: back to closed, and the car to idle.
      assert.deepEqual((await building.inspect('car-0')).states, ['closed', 'idle', 'normal']);
      assert.equal(await invocations(building, 'car-0'), 0);
      assert.equal(of('car-1').length, 1, 'car-1 only entered service');
      assert.deepEqual(monitor.violations, []);
    } finally {
      building.close();
    }
  });

  test(`${datamodel}: In(): the open button opens the doors of a standing car, never of a moving one`, async () => {
    const { building, after, of, monitor } = setup(datamodel, { cars: 1 });
    try {
      await after(0);
      building.press('car-0', 4);
      await after(2000);
      building.openButton('car-0');
      await after(1000);
      assert.equal(of('car-0', 'door').length, 0, 'no door moves while the car does');
      assert.deepEqual((await building.inspect('car-0')).states, ['closed', 'normal', 'travelling']);
      await after(3000 + 5000);
      assert.equal(monitor.cars.get('car-0').door, 'closed');
      assert.equal(monitor.cars.get('car-0').floor, 4);
      const before = of('car-0', 'door').length;
      building.openButton('car-0');
      await after(0);
      assert.deepEqual(of('car-0', 'door').slice(before).map((r) => r[3]), ['opening']);
      // While its doors are open the car does not leave for a new call.
      building.press('car-0', 0);
      await after(4500);
      assert.equal(monitor.cars.get('car-0').moving, false);
      await after(1000);
      assert.equal(monitor.cars.get('car-0').moving, true);
      assert.deepEqual(monitor.violations, []);
    } finally {
      building.close();
    }
  });

  test(`${datamodel}: deep history: a car taken out mid-trip resumes the trip, in the same direction`, async () => {
    const { building, after, of, monitor } = setup(datamodel, { cars: 2 });
    try {
      await after(0);
      building.press('car-0', 6);
      await after(3700); // past floor 2, on its way to 3
      const before = await building.inspect('car-0');
      assert.deepEqual(before.states, ['closed', 'normal', 'travelling']);
      building.maintenance('car-0', true);
      await after(60000);
      assert.deepEqual((await building.inspect('car-0')).states, ['maintenance']);
      assert.deepEqual(of('car-0', 'motor').map((r) => r[3]), ['start', 'stop']);
      assert.equal(monitor.cars.get('car-0').floor, 2, 'its travel timer was cancelled');
      building.press('car-0', 1); // its buttons are off in maintenance
      building.maintenance('car-0', false);
      await after(0);
      const resumed = await building.inspect('car-0');
      assert.deepEqual(resumed.states, before.states);
      assert.equal(resumed.variables.dir, 1);
      assert.deepEqual(resumed.variables.carCalls, [6]);
      await after(4 * 1500);
      assert.deepEqual(of('car-0', 'position').map((r) => r[3]), ['1', '2', '3', '4', '5', '6']);
      assert.deepEqual(monitor.violations, []);
    } finally {
      building.close();
    }
  });

  test(`${datamodel}: deep history: maintenance with the doors open cancels the door controller; the resume opens them again`, async () => {
    const { building, after, of, monitor } = setup(datamodel, { cars: 2 });
    try {
      await after(0);
      building.press('car-0', 0);
      await after(1500);
      assert.equal(monitor.cars.get('car-0').door, 'open');
      assert.equal(await invocations(building, 'car-0'), 1);
      const before = await building.inspect('car-0');
      building.maintenance('car-0', true);
      await after(0);
      assert.equal(await invocations(building, 'car-0'), 0, 'leaving cycling cancelled its controller');
      const doors = of('car-0', 'door').length;
      await after(30000);
      assert.equal(of('car-0', 'door').length, doors, "the cancelled controller's timers went with it");
      building.maintenance('car-0', false);
      await after(0);
      assert.deepEqual((await building.inspect('car-0')).states, before.states);
      assert.deepEqual(before.states, ['cycling', 'normal', 'stopped']);
      assert.equal(await invocations(building, 'car-0'), 1, 'a new controller');
      await after(5000);
      assert.deepEqual(of('car-0', 'door').slice(doors).map((r) => r[3]), ['opening', 'open', 'closing', 'closed']);
      assert.deepEqual((await building.inspect('car-0')).states, ['closed', 'idle', 'normal']);
      assert.deepEqual(monitor.violations, []);
    } finally {
      building.close();
    }
  });

  test(`${datamodel}: the dispatcher gives a car's calls to another when it leaves service, and keeps one no car can take`, async () => {
    const { building, after, of, monitor } = setup(datamodel, { cars: 2 });
    try {
      await after(0);
      building.hallCall(5);
      await after(1000);
      building.maintenance('car-0', true);
      await after(0);
      assert.deepEqual(of('dispatcher').map((r) => r.slice(2)), [['call.assigned', '5', 'car-0'], ['call.assigned', '5', 'car-1']]);
      await after(5 * 1500);
      assert.deepEqual(of('dispatcher').at(-1).slice(2), ['call.served', '5', 'car-1']);
      building.maintenance('car-1', true);
      await after(0);
      building.hallCall(2);
      await after(10000);
      assert.deepEqual(of('dispatcher').at(-1).slice(2), ['call.waiting', '2']);
      building.maintenance('car-0', false);
      await after(0);
      assert.deepEqual(of('dispatcher').at(-1).slice(2), ['call.assigned', '2', 'car-0']);
      await after(4 * 1500);
      assert.deepEqual(of('dispatcher').at(-1).slice(2), ['call.served', '2', 'car-0']);
      assert.equal(monitor.counts.reassigned, 1, 'the call at 5; the waiting one is assigned, not reassigned');
      assert.deepEqual(monitor.violations, []);
    } finally {
      building.close();
    }
  });

  test(`${datamodel}: an overloaded car holds its doors open and stays; it leaves once lighter`, async () => {
    const { building, after, until, of, monitor } = setup(datamodel, { cars: 1 });
    try {
      await after(0);
      building.weigh('car-0', 700);
      building.press('car-0', 5);
      await after(30000);
      assert.equal(monitor.cars.get('car-0').door, 'open');
      assert.equal(of('car-0', 'motor').length, 0);
      assert.deepEqual((await building.inspect('car-0')).states, ['cycling', 'idle', 'overloaded']);
      building.weigh('car-0', 400);
      await after(3000 + 1000);
      assert.equal(monitor.cars.get('car-0').door, 'closed');
      assert.equal(monitor.cars.get('car-0').moving, true);
      // Overloaded while the doors close: they open again.
      await until(() => monitor.cars.get('car-0').door === 'closing');
      assert.equal(monitor.cars.get('car-0').floor, 5);
      building.weigh('car-0', 900);
      await after(0);
      assert.equal(monitor.cars.get('car-0').door, 'opening', 'the hold reopens a closing door at once');
      await after(1000);
      assert.equal(monitor.cars.get('car-0').door, 'open');
      assert.deepEqual(monitor.violations, []);
    } finally {
      building.close();
    }
  });

  test(`${datamodel}: the fire alarm brings every car to the lobby with its doors open; the clear closes them`, async () => {
    const { building, after, of, monitor } = setup(datamodel, { cars: 3 });
    try {
      await after(0);
      building.press('car-1', 7);
      building.press('car-2', 4);
      await after(7 * 1500 + 1500); // car-2 stands at 4, doors open; car-1 arrives at 7
      building.hallCall(6);
      await after(0);
      building.fireAlarm(true);
      await after(0);
      assert.deepEqual(of('dispatcher').slice(-1).map((r) => r.slice(2)), [['call.cancelled', '6']]);
      await after(2 * 1000 + 9 * 1500);
      for (const car of building.names) {
        assert.deepEqual({ ...monitor.cars.get(car), overloaded: undefined }, { floor: 0, moving: false, door: 'open', mode: 'fire', overloaded: undefined }, car);
        assert.deepEqual((await building.inspect(car)).states, ['fireLobby']);
      }
      building.hallCall(3);
      await after(0);
      assert.deepEqual(of('dispatcher').at(-1).slice(2), ['call.refused', '3']);
      building.fireAlarm(false);
      await after(1000);
      for (const car of building.names) {
        assert.equal(monitor.cars.get(car).door, 'closed', car);
        assert.deepEqual((await building.inspect(car)).states, ['closed', 'idle', 'normal']);
      }
      assert.deepEqual(monitor.violations, []);
    } finally {
      building.close();
    }
  });

  test(`${datamodel}: ${SCENARIOS} generated scenarios keep every invariant`, async () => {
    const seeds = Array.from({ length: SCENARIOS }, (_, i) => i + 1);
    const r = await playAll(seeds, { datamodel });
    console.log(`${datamodel}: ${r.scenarios} scenarios, ${r.inputs} inputs, ${r.macrosteps} macrosteps, ${r.reports} reports, ${r.steps} steps, `
      + `${r.served} served, ${r.reassigned} reassigned, ${r.maintenanceChecks} resumes, ${r.fireChecks} recalls, in ${Math.round(r.ms)} ms`);
    assert.deepEqual(r.violations, []);
    assert.ok(r.maintenanceChecks > 0 && r.fireChecks > 0 && r.reassigned > 0 && r.logs.reopened > 0, 'the scenarios reach every rule');
  });
}

test('the scenarios are the same for the same seed, and so is what both datamodels make of them', async () => {
  assert.deepEqual(generate(7), generate(7));
  assert.notDeepEqual(generate(7), generate(8));
  const [native, quickjs] = await Promise.all(DATAMODELS.map((datamodel) => play(generate(7), { datamodel })));
  assert.deepEqual({ ...native, logs: undefined }, { ...quickjs, logs: undefined });
});

test('the monitor catches a car that leaves with its doors open', async () => {
  // The departure without its guards on the other regions.
  const car = CHARTS['car.scxml'].replace(
    "carCalls.length + hallCalls.length &gt; 0 &amp;&amp; In('closed') &amp;&amp; !In('overloaded')",
    'carCalls.length + hallCalls.length &gt; 0',
  );
  assert.notEqual(car, CHARTS['car.scxml']);
  const { building, after, monitor } = setup('native', { cars: 1 }, { ...CHARTS, 'car.scxml': car });
  try {
    await after(0);
    building.weigh('car-0', 700);
    await after(500);
    building.press('car-0', 3);
    await after(0);
    assert.deepEqual(monitor.violations.map((v) => v.rule), ['a car moves with its door not closed']);
  } finally {
    building.close();
  }
});

test("the scenarios catch a trip's direction chosen in moving's onentry, which the history runs again", async () => {
  const car = CHARTS['car.scxml']
    .replace(`target="moving">
              <assign location="dir" expr="ahead(carCalls.concat(hallCalls), floor, dir) ? dir : -dir"/>
            </transition>`, 'target="moving"/>')
    .replace(`<state id="moving" initial="travelling">
            <onentry>`, `<state id="moving" initial="travelling">
            <onentry>
              <assign location="dir" expr="ahead(carCalls.concat(hallCalls), floor, dir) ? dir : -dir"/>`);
  assert.equal(car.split('location="dir"').length, 2, 'the assignment moved');
  // Seed 15 takes a car out mid-trip toward a hall call it then gives up.
  const r = await play(generate(15), { charts: { ...CHARTS, 'car.scxml': car } });
  assert.ok(r.violations.some((v) => v.rule === 'maintenance does not resume where the car was'), JSON.stringify(r.violations));
});

test('the morning of main.mjs breaks no rule', async () => {
  const lines = [];
  const monitor = await demo({ print: (line) => lines.push(line) });
  assert.deepEqual(monitor.violations, []);
  assert.ok(lines.some((line) => line.includes('car-0 is back: it resumes its trip')));
  assert.match(lines.at(-1), /no rule was broken/);
});
