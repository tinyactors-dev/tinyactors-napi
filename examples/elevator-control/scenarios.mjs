// Generated scenarios: a seeded generator of a building's inputs (hall
// calls, presses, loads, obstructions, maintenance, fire alarms) and a
// runner that plays them on a SimulatedClock, deadline by deadline, and
// checks the bank's invariants as it goes:
//
// - no door opens while its car moves, and no car moves with a door open
//   (the Monitor, on every hardware report);
// - every hall call is served, or given to another car the moment its car
//   leaves service, and none waits past a bound for the car that has it;
// - a fire alarm brings every car to the lobby with its doors open within
//   the time the slowest car needs;
// - a car taken out for maintenance resumes exactly where it was: the
//   same active states in all three regions, floor, direction and calls.
import { SimulatedClock } from '@tinyactors/node';
import { Building } from './building.mjs';

/** A small seeded generator (mulberry32): the same seed, the same scenario. */
export function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

/** One scenario: a building and its inputs, each `{ at, kind, ... }` in time order. */
export function generate(seed) {
  const rng = random(seed);
  const spec = {
    cars: rng.int(2, 4),
    floors: rng.int(4, 12),
    travelMs: rng.pick([800, 1500, 2000]),
    doorMs: rng.pick([500, 1000]),
    dwellMs: rng.pick([1500, 3000]),
    capacity: 630,
  };
  const names = Array.from({ length: spec.cars }, (_, i) => `car-${i}`);
  const duration = rng.int(60, 240) * 1000;
  const events = [];
  const at = () => rng.int(0, duration);
  for (let i = rng.int(duration / 8000, duration / 2500); i > 0; i--) events.push({ at: at(), kind: 'hall', floor: rng.int(0, spec.floors - 1) });
  for (let i = rng.int(duration / 10000, duration / 3000); i > 0; i--) events.push({ at: at(), kind: 'press', car: rng.pick(names), floor: rng.int(0, spec.floors - 1) });
  for (let i = rng.int(0, duration / 15000); i > 0; i--) events.push({ at: at(), kind: 'obstruct', car: rng.pick(names) });
  for (let i = rng.int(0, duration / 20000); i > 0; i--) {
    // A load: people get on; sometimes too many, and some get off again.
    const start = at();
    const car = rng.pick(names);
    const over = rng.chance(0.4);
    events.push({ at: start, kind: 'weight', car, kg: over ? spec.capacity + rng.int(10, 300) : rng.int(70, spec.capacity) });
    events.push({ at: start + rng.int(1000, 15000), kind: 'weight', car, kg: rng.int(0, spec.capacity - 70) });
  }
  for (let i = rng.int(0, 3); i > 0; i--) {
    const start = at();
    events.push({ at: start, kind: 'maintenance', car: rng.pick(names), length: rng.int(1, 60000) });
  }
  if (rng.chance(0.5)) {
    const start = at();
    const recall = 2 * spec.doorMs + (spec.floors - 1) * spec.travelMs;
    // Mostly an alarm long enough to see the whole recall; sometimes one
    // cleared while the cars are still on their way down.
    const length = rng.chance(0.25) ? rng.int(1, recall) : recall + rng.int(1000, 30000);
    events.push({ at: start, kind: 'fire', length });
  }
  events.sort((a, b) => a.at - b.at);
  return { seed, spec, duration, events };
}

/** What a run did, and what it found broken. */
function totals() {
  return { scenarios: 0, inputs: 0, steps: 0, reports: 0, violations: [], maintenanceChecks: 0, fireChecks: 0, served: 0, reassigned: 0, longestWait: 0, boundMs: 0, events: 0, macrosteps: 0, doors: 0, communicationErrors: 0, logs: {} };
}

/**
 * Plays `scenario` on a new building on a SimulatedClock and returns what
 * it saw. Inputs the building would not take at that moment are adapted
 * (a maintenance on a car already out of service is skipped, the last car
 * in service is never taken out, a load is read again when a car comes
 * back to service), so every scenario is a plausible day.
 */
export async function play(scenario, { datamodel = 'native', charts } = {}) {
  const { spec, duration } = scenario;
  const clock = new SimulatedClock();
  const building = new Building({ clock, datamodel, spec, charts });
  const { host, monitor, names } = building;
  const queue = scenario.events.map((event) => ({ ...event }));
  const result = totals();
  result.scenarios = 1;

  // The bound for a hall call, from its (last) assignment: two sweeps of
  // the shaft, a door cycle at every floor of both and one more, and the
  // time this scenario holds doors open (obstructions, overloads).
  const cycle = 2 * spec.doorMs + spec.dwellMs;
  const holds = scenario.events.filter((e) => e.kind === 'obstruct').length * cycle
    + scenario.events.filter((e) => e.kind === 'weight' && e.kg > spec.capacity).length * (15000 + cycle);
  const bound = 2 * (spec.floors - 1) * spec.travelMs + (2 * spec.floors + 1) * cycle + holds;
  result.boundMs = bound;
  const recallBound = 2 * spec.doorMs + (spec.floors - 1) * spec.travelMs;

  const loads = new Map(names.map((car) => [car, { want: 0, sent: 0 }]));
  const maintenance = new Map(); // car -> what it was when it went out, or null once void
  let fire = null; // { at, checked }
  const insert = (event) => {
    const i = queue.findIndex((e) => e.at > event.at);
    queue.splice(i < 0 ? queue.length : i, 0, event);
  };
  const operating = () => names.filter((car) => monitor.cars.get(car).mode === 'operating');
  const settle = async () => {
    await host.idle();
    monitor.check(bound);
  };

  const apply = async (event) => {
    result.inputs++;
    switch (event.kind) {
      case 'hall': building.hallCall(event.floor); break;
      case 'press': building.press(event.car, event.floor); break;
      case 'obstruct': building.obstruct(event.car); break;
      case 'weight': loads.get(event.car).want = event.kg; break;
      case 'maintenance': {
        const others = operating().filter((car) => car !== event.car);
        if (fire || maintenance.has(event.car) || monitor.cars.get(event.car).mode !== 'operating' || others.length === 0) break;
        maintenance.set(event.car, await building.inspect(event.car));
        building.maintenance(event.car, true);
        insert({ at: event.at + event.length, kind: 'maintenance.end', car: event.car });
        break;
      }
      case 'maintenance.end': {
        const before = maintenance.get(event.car);
        maintenance.delete(event.car);
        building.maintenance(event.car, false);
        await settle();
        if (!before) break; // a fire alarm took the car out of maintenance
        const after = await building.inspect(event.car);
        result.maintenanceChecks++;
        // Re-entering `stopped` serves its floor again: a call for that
        // floor made while the doors were open is served by the reopening.
        const calls = (v) => v.carCalls.filter((f) => f !== v.floor).sort((a, b) => a - b);
        const same = after.states.join(' ') === before.states.join(' ')
          && after.variables.floor === before.variables.floor
          && after.variables.dir === before.variables.dir
          && JSON.stringify(calls(after.variables)) === JSON.stringify(calls(before.variables));
        if (!same) {
          monitor.violation('maintenance does not resume where the car was', {
            car: event.car, before: before.states.join(' '), after: after.states.join(' '),
            floors: `${before.variables.floor} -> ${after.variables.floor}`,
          });
        }
        break;
      }
      case 'fire':
        if (fire) break;
        building.fireAlarm(true);
        fire = { at: event.at };
        for (const car of maintenance.keys()) maintenance.set(car, null);
        insert({ at: event.at + recallBound, kind: 'fire.check' });
        insert({ at: event.at + event.length, kind: 'fire.clear' });
        break;
      case 'fire.check': {
        if (!fire) break;
        result.fireChecks++;
        for (const car of names) {
          const c = monitor.cars.get(car);
          if (c.mode !== 'fire' || c.floor !== 0 || c.door !== 'open' || c.moving) {
            monitor.violation('the fire recall leaves a car away from the lobby or closed', { car, mode: c.mode, floor: c.floor, door: c.door, moving: c.moving });
          }
        }
        break;
      }
      case 'fire.clear':
        building.fireAlarm(false);
        fire = null;
        break;
      default:
        throw new Error(`unknown input ${event.kind}`);
    }
  };

  try {
    await settle();
    // Inputs until the scenario's end, then the clock alone until nothing
    // is left to do, with a horizon past which a car is stuck.
    const horizon = duration + 60000 + bound;
    for (;;) {
      const deadline = host.nextDeadline === undefined ? Infinity : clock.now + host.nextDeadline;
      const next = Math.min(queue[0]?.at ?? Infinity, deadline);
      if (next === Infinity || next > horizon) break;
      if (next > clock.now) clock.increment(next - clock.now);
      result.steps++;
      await settle();
      while (queue.length > 0 && queue[0].at <= clock.now) await apply(queue.shift());
      await settle();
      // The load sensor reads again when a car is back in service: a car
      // ignores it in maintenance and during a fire recall.
      for (const car of operating()) {
        const load = loads.get(car);
        if (load.sent !== load.want) {
          building.weigh(car, load.want);
          load.sent = load.want;
        }
      }
      for (const car of names) if (monitor.cars.get(car).mode !== 'operating') loads.get(car).sent = -1;
      await settle();
    }

    // The end of the day: every call served, every car at rest.
    if (host.nextDeadline !== undefined) monitor.violation('the bank never comes to rest', { deadline: host.nextDeadline });
    for (const [floor, call] of monitor.calls) monitor.violation('a hall call is never served', { floor, car: call.car });
    for (const car of names) {
      const c = monitor.cars.get(car);
      if (c.moving || c.door !== 'closed' || c.mode !== 'operating') monitor.violation('a car does not end at rest', { car, ...c });
    }
    // The host's own counters: the macrosteps the charts ran, the door
    // controllers invoked, and the errors raised in any chart.
    const { charts } = await host.hostStats();
    for (const chart of charts) {
      result.macrosteps += chart.macrosteps;
      result.communicationErrors += chart.errorsCommunication;
      if (chart.name === 'door') result.doors += chart.spawned;
      if (chart.errorsExecution > 0) monitor.violation('a chart raised error.execution', { chart: chart.name, count: chart.errorsExecution });
    }
    for (const entry of building.logs) {
      if (entry.label === 'error') monitor.violation('a chart logged an error', entry);
      else result.logs[entry.label] = (result.logs[entry.label] ?? 0) + 1;
    }
  } finally {
    building.close();
  }

  result.reports = monitor.counts.reports;
  result.served = monitor.counts.served;
  result.reassigned = monitor.counts.reassigned;
  result.longestWait = monitor.longestWait;
  result.events = result.inputs + monitor.counts.reports;
  result.violations = monitor.violations.map((v) => ({ seed: scenario.seed, datamodel, ...v }));
  return result;
}

/** Plays the scenarios of `seeds` on `datamodel` and sums what they saw. */
export async function playAll(seeds, { datamodel = 'native', charts } = {}) {
  const sum = totals();
  const started = performance.now();
  for (const seed of seeds) {
    const r = await play(generate(seed), { datamodel, charts });
    for (const key of ['scenarios', 'inputs', 'steps', 'reports', 'maintenanceChecks', 'fireChecks', 'served', 'reassigned', 'events', 'macrosteps', 'doors', 'communicationErrors']) sum[key] += r[key];
    sum.longestWait = Math.max(sum.longestWait, r.longestWait);
    sum.boundMs = Math.max(sum.boundMs, r.boundMs);
    sum.violations.push(...r.violations);
    for (const [label, n] of Object.entries(r.logs)) sum.logs[label] = (sum.logs[label] ?? 0) + n;
  }
  sum.ms = performance.now() - started;
  return sum;
}
