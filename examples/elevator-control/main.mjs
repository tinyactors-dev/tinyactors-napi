// A bank of three elevators in a ten-floor building, on a SimulatedClock.
//
//   node main.mjs                       a narrated morning: calls, a car
//                                       taken out for maintenance mid-trip,
//                                       an overload, a fire drill
//   node main.mjs --scenarios 1000      that many generated scenarios on
//     [--datamodel native|quickjs|both]   each datamodel, every invariant
//     [--seed 1]                          checked, with counts and timing
import { parseArgs } from 'node:util';
import { SimulatedClock } from '@tinyactors/node';
import { Building } from './building.mjs';
import { playAll } from './scenarios.mjs';

/** Moves `clock` to `until`, deadline by deadline, so every timer fires at its time. */
export async function runUntil(building, clock, until) {
  await building.host.idle();
  while (building.host.nextDeadline !== undefined && clock.now + building.host.nextDeadline <= until) {
    clock.increment(building.host.nextDeadline);
    await building.host.idle();
  }
  if (clock.now < until) {
    clock.increment(until - clock.now);
    await building.host.idle();
  }
}

/** The narrated morning. Returns the monitor, whose violations must be none. */
export async function demo({ print = console.log, datamodel } = {}) {
  const clock = new SimulatedClock();
  const seconds = () => (clock.now / 1000).toFixed(1).padStart(6);
  const building = new Building({ clock, datamodel, trace: (line) => print(`${seconds()}s ${line.slice(line.indexOf(' ') + 1)}`) });
  const say = (text) => print(`${seconds()}s -- ${text}`);
  const script = [
    [0, 'a call at floor 7', () => building.hallCall(7)],
    [500, 'a call at floor 3', () => building.hallCall(3)],
    [3000, 'car-0 is taken out for maintenance on its way up', () => building.maintenance('car-0', true)],
    [20000, 'car-0 is back: it resumes its trip', () => building.maintenance('car-0', false)],
    [26000, 'nine people squeeze into car-1, and someone presses 9', () => { building.weigh('car-1', 760); building.press('car-1', 9); }],
    [40000, 'two step out', () => building.weigh('car-1', 600)],
    [60000, 'the fire alarm', () => building.fireAlarm(true)],
    [62000, 'a call at floor 5, refused during the alarm', () => building.hallCall(5)],
    [90000, 'the alarm is cleared', () => building.fireAlarm(false)],
  ];
  try {
    for (const [at, text, act] of script) {
      await runUntil(building, clock, at);
      say(text);
      act();
    }
    await runUntil(building, clock, 120000);
    for (const car of building.names) say(`${car}: ${(await building.inspect(car)).states.join(', ')}, floor ${building.monitor.cars.get(car).floor}`);
    const { violations } = building.monitor;
    say(violations.length === 0 ? 'no rule was broken' : `${violations.length} rules broken: ${JSON.stringify(violations)}`);
    return building.monitor;
  } finally {
    building.close();
  }
}

/** Plays `count` generated scenarios from `seed` on each datamodel and prints what they did. */
export async function scenarios({ count, seed = 1, datamodels = ['native', 'quickjs'], print = console.log }) {
  const seeds = Array.from({ length: count }, (_, i) => seed + i);
  const results = [];
  for (const datamodel of datamodels) {
    const r = await playAll(seeds, { datamodel });
    results.push({ datamodel, ...r });
    print(`${datamodel}: ${r.scenarios} scenarios: ${r.inputs} inputs, ${r.macrosteps} macrosteps (one per event an actor handled), `
      + `${r.reports} reports, ${r.doors} door controllers invoked, ${r.steps} clock steps, in ${(r.ms / 1000).toFixed(2)} s `
      + `(${Math.round(r.macrosteps / (r.ms / 1000))} macrosteps/s); `
      + `${r.served} calls served, ${r.reassigned} reassigned, the longest wait ${(r.longestWait / 1000).toFixed(1)} s; `
      + `${r.maintenanceChecks} maintenance resumes and ${r.fireChecks} fire recalls checked; `
      + `${r.communicationErrors} error.communication; `
      + `${r.violations.length} violations`);
    for (const v of r.violations.slice(0, 10)) print(`  ${JSON.stringify(v)}`);
  }
  return results;
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { scenarios: { type: 'string' }, datamodel: { type: 'string', default: 'both' }, seed: { type: 'string', default: '1' } } });
  const datamodels = values.datamodel === 'both' ? ['native', 'quickjs'] : [values.datamodel];
  if (values.scenarios) {
    const results = await scenarios({ count: Number(values.scenarios), seed: Number(values.seed), datamodels });
    process.exitCode = results.some((r) => r.violations.length > 0) ? 1 : 0;
  } else {
    for (const datamodel of datamodels.slice(0, 1)) {
      const monitor = await demo({ datamodel });
      process.exitCode = monitor.violations.length > 0 ? 1 : 0;
    }
  }
}
