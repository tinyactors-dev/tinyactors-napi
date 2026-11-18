// The application: a building with a bank of elevators. The charts decide
// (charts/car.scxml, charts/door.scxml, charts/dispatcher.scxml); this file
// is the building around them: it starts the dispatcher and the cars, takes
// the passengers' and the operators' inputs, and is the hardware the charts
// drive. Every report the charts send to the hardware (urn:elevator:hw) and
// every decision of the dispatcher (urn:elevator:report) goes through a
// Monitor, which checks the safety and service rules as they happen.
import { readFileSync } from 'node:fs';
import { Host } from '@tinyactors/node';

const chart = (name) => readFileSync(new URL(`./charts/${name}`, import.meta.url), 'utf8');
export const CHARTS = { 'car.scxml': chart('car.scxml'), 'door.scxml': chart('door.scxml'), 'dispatcher.scxml': chart('dispatcher.scxml') };

export const SYSTEM = 'building';

/** The timings of a car, in milliseconds, and its capacity in kg. */
export const DEFAULTS = { floors: 10, cars: 3, travelMs: 1500, doorMs: 1000, dwellMs: 3000, capacity: 630 };

/** The atomic states of an actorState value: `{a: {b: 'x', c: 'y'}}` gives `['x', 'y']`. */
export function leaves(value) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(leaves);
}

/**
 * The hardware's view of the bank, rebuilt from the charts' reports, and
 * the rules it checks on every report. A broken rule is a violation,
 * kept with the time it happened; the charts never see the monitor.
 */
export class Monitor {
  constructor(clock, names) {
    this.clock = clock;
    /** car -> { floor, moving, door, mode, overloaded } */
    this.cars = new Map(names.map((name) => [name, { floor: 0, moving: false, door: 'closed', mode: 'starting', overloaded: false }]));
    /** floor -> { car, since }: the hall calls the dispatcher holds, by its reports */
    this.calls = new Map();
    /** what was served: { floor, car, waited } */
    this.served = [];
    this.violations = [];
    this.counts = { reports: 0, opened: 0, trips: 0, served: 0, assigned: 0, reassigned: 0, waiting: 0, cancelled: 0, refused: 0, duplicate: 0 };
    /** the longest a call waited for its car, from its (last) assignment */
    this.longestWait = 0;
  }

  violation(rule, detail) {
    this.violations.push({ at: this.clock.now, rule, ...detail });
  }

  /** A report of a car or a door controller to the hardware. */
  hardware(event, data) {
    this.counts.reports++;
    const car = this.cars.get(data.car);
    if (!car) return this.violation('unknown car', { event, car: data.car });
    switch (event) {
      case 'door':
        if (data.state === 'opening') {
          this.counts.opened++;
          if (car.moving) this.violation('a door opens while its car moves', { car: data.car, floor: car.floor });
          if (data.floor !== car.floor) this.violation('a door opens at another floor', { car: data.car, floor: data.floor, at: car.floor });
        }
        car.door = data.state;
        break;
      case 'motor':
        if (data.state === 'start') {
          if (car.door !== 'closed') this.violation('a car moves with its door not closed', { car: data.car, door: car.door });
          if (car.moving) this.violation('a motor starts twice', { car: data.car });
          car.moving = true;
          this.counts.trips++;
        } else {
          if (!car.moving) this.violation('a motor stops twice', { car: data.car });
          car.moving = false;
        }
        break;
      case 'position':
        if (!car.moving) this.violation('a car changes floor standing still', { car: data.car });
        if (Math.abs(data.floor - car.floor) !== 1) this.violation('a car skips a floor', { car: data.car, from: car.floor, to: data.floor });
        if (car.door !== 'closed') this.violation('a car moves with its door not closed', { car: data.car, door: car.door });
        car.floor = data.floor;
        break;
      case 'mode':
        car.mode = data.mode;
        if (data.floor !== car.floor) this.violation('a car is not where it says', { car: data.car, floor: data.floor, at: car.floor });
        break;
      case 'overload':
        car.overloaded = data.on;
        break;
      default:
        this.violation('unknown report', { event });
    }
  }

  /** A decision of the dispatcher on a hall call. */
  report(event, data) {
    const now = this.clock.now;
    switch (event) {
      case 'call.assigned':
        if (data.from === null) this.counts.assigned++;
        else this.counts.reassigned++;
        if (this.cars.get(data.car)?.mode !== 'operating') this.violation('a call goes to a car out of service', { floor: data.floor, car: data.car });
        this.calls.set(data.floor, { car: data.car, since: now });
        break;
      case 'call.waiting':
        this.counts.waiting++;
        this.calls.set(data.floor, { car: null, since: now });
        break;
      case 'call.served': {
        this.counts.served++;
        const call = this.calls.get(data.floor);
        if (!call || call.car !== data.car) this.violation('a call served by a car that did not have it', { floor: data.floor, car: data.car });
        if (this.cars.get(data.car).floor !== data.floor) this.violation('a call served from another floor', { floor: data.floor, car: data.car });
        const waited = now - (call?.since ?? now);
        this.longestWait = Math.max(this.longestWait, waited);
        this.served.push({ floor: data.floor, car: data.car, waited });
        this.calls.delete(data.floor);
        break;
      }
      case 'call.cancelled':
        this.counts.cancelled++;
        this.calls.delete(data.floor);
        break;
      case 'call.refused':
        this.counts.refused++;
        break;
      case 'call.duplicate':
        this.counts.duplicate++;
        if (!this.calls.has(data.floor)) this.violation('a call refused as a duplicate of none', { floor: data.floor });
        break;
      default:
        this.violation('unknown report', { event });
    }
  }

  /** Checked after every step: no call stays with a car out of service,
   * and none waits longer than `bound` for the car that has it. */
  check(bound) {
    const now = this.clock.now;
    for (const [floor, call] of this.calls) {
      if (call.car === null) {
        if ([...this.cars.values()].some((car) => car.mode === 'operating')) this.violation('a call waits while a car is in service', { floor });
        continue;
      }
      if (this.cars.get(call.car).mode !== 'operating') this.violation('a call stays with a car out of service', { floor, car: call.car });
      if (now - call.since > bound && !call.late) {
        call.late = true;
        this.violation('a call waits past the bound', { floor, car: call.car, waited: now - call.since, bound });
      }
    }
  }
}

/** A building: one host, the dispatcher, `cars` cars and their hardware. */
export class Building {
  /**
   * @param {object} options
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {Partial<typeof DEFAULTS>} [options.spec] floors, cars, timings, capacity
   * @param {(line: string) => void} [options.trace] called with each report, as text
   * @param {Record<string, string>} [options.charts] the charts' texts by file name; a test
   *   gives a broken chart here to see the monitor catch it
   */
  constructor({ clock, datamodel, spec = {}, trace, charts = CHARTS } = {}) {
    this.spec = { ...DEFAULTS, ...spec };
    this.clock = clock ?? { now: 0 };
    this.names = Array.from({ length: this.spec.cars }, (_, i) => `car-${i}`);
    this.monitor = new Monitor(this.clock, this.names);
    this.logs = [];
    this.trace = trace;
    this.host = new Host(
      { systemID: SYSTEM, ioProcessors: [{ type: 'urn:elevator:hw' }, { type: 'urn:elevator:report' }] },
      {
        clock,
        datamodel,
        ioProcessors: {
          'urn:elevator:hw': (host, send) => {
            const { event, data } = send;
            this.trace?.(`${this.clock.now} ${data.car} ${event} ${data.state ?? data.mode ?? data.floor ?? data.on}`);
            this.monitor.hardware(event, data);
          },
          'urn:elevator:report': (host, send) => {
            const { event, data } = send;
            this.trace?.(`${this.clock.now} dispatcher ${event} ${data.floor}${data.car ? ` ${data.car}` : ''}`);
            this.monitor.report(event, data);
          },
        },
        log: (host, entry) => this.logs.push({ at: this.clock.now, label: entry.label, text: entry.text }),
      },
    );
    this.host.addCharts(charts);
    const { floors, travelMs, doorMs, dwellMs, capacity } = this.spec;
    // The dispatcher first: each car tells it when it enters service.
    this.dispatcher = this.host.spawnChart('dispatcher', { name: 'dispatcher', params: { system: SYSTEM, cars: this.names } });
    this.sessions = new Map(this.names.map((car) => [car, this.host.spawnChart('car', {
      name: car,
      params: { car, floors, travelMs, doorMs, dwellMs, capacity, dispatcher: `tinyactors://${SYSTEM}/@dispatcher` },
    })]));
  }

  /** A passenger at `floor` presses the hall button. */
  hallCall(floor) { this.host.send(this.dispatcher, 'hall.call', { floor }); }
  /** A passenger in `car` presses the button for `floor`. */
  press(car, floor) { this.host.send(this.sessions.get(car), 'press', { floor }); }
  /** The load sensor of `car` reads `kg`. */
  weigh(car, kg) { this.host.send(this.sessions.get(car), 'weight', { kg }); }
  /** The door-open button in `car`: the doors open if the car is not moving. */
  openButton(car) { this.host.send(this.sessions.get(car), 'open'); }
  /** Something is in the way of `car`'s closing door. */
  obstruct(car) { this.host.send(this.sessions.get(car), 'obstructed'); }
  /** The maintenance key switch of `car`, turned on or off. */
  maintenance(car, on) { this.host.send(this.sessions.get(car), on ? 'maintenance.start' : 'maintenance.end'); }
  /** The building's fire alarm, raised or cleared, given to the dispatcher. */
  fireAlarm(on) { this.host.send(this.dispatcher, on ? 'fire.alarm' : 'fire.clear'); }

  /** `car`'s active atomic states, sorted, and its variables. */
  async inspect(car) {
    const session = this.sessions.get(car);
    const [{ value }, { variables }] = await Promise.all([
      this.host.actorState({ session }),
      this.host.actorContext({ session }),
    ]);
    return { states: leaves(value).sort(), variables };
  }

  close() { this.host.close(); }
}
