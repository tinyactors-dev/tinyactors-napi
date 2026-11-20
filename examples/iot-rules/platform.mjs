// The application: a device platform whose devices are actors of the
// platform's own chart, and whose customers upload alert rules that the
// platform runs for them, untrusted, in the quickjs sandbox.
//
// - The fleet is one host on the native datamodel: charts/device.scxml is
//   the platform's code, trusted. Each device's telemetry goes to the
//   `urn:iot:telemetry` I/O processor, which routes a reading to the rules
//   of the device's customer.
// - Each rule is a host of its own on quickjs, with `maxOps` and
//   `memoryLimit`: one sandbox per rule. The engine's memory limit is the
//   whole engine's, every actor of the host together, so a rule that hoards
//   memory in a variable would make every rule beside it fail its next
//   allocation (test.mjs shows it); in a host of its own it hurts only
//   itself. One actor per device the rule watches holds that device's
//   state (its streak, whether it is firing).
// - A rule may raise alerts through `urn:iot:alert` and do nothing else
//   that leaves its sandbox: a send to another system goes to the rule's
//   transport, which refuses it; an `<invoke>` has no service; a `src`
//   has no resolver.
// - What goes wrong is reported to the customer, in their inbox: compile
//   diagnostics at upload, the rule's error counters (`hostStats`) at
//   each audit, each refused send. A rule that keeps failing, or keeps its
//   host busy, is suspended: its host is closed, which frees everything it
//   held.
import { readFileSync } from 'node:fs';
import { compileCharts, CompileError, Host, StaleError, TinyactorsError } from '@tinyactors/node';
import { chartName, fillTemplate, formatDiagnostic, syntaxError } from './check.mjs';

const DEVICE_CHART = readFileSync(new URL('./charts/device.scxml', import.meta.url), 'utf8');
const RULE_TEMPLATE = readFileSync(new URL('./charts/rule-template.scxml', import.meta.url), 'utf8');

/** The ids of customers, devices and rules: they become system ids and actor
 * names, so the platform keeps them plain. */
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The sandbox's limits for a rule. `maxOps` counts the engine's interrupt
 * checks, not time: on the machine the README names, 200 of them stop a
 * `while (true) {}` after about 5 ms and the slowest loop the README
 * measured after about 50 ms; the engine's default, a million, lets them
 * run 26 seconds and minutes. A rule's condition needs a tiny fraction of
 * one check. 8 MB of engine memory is room for a rule over a few
 * thousand devices, unless its scripts declare names (README, "What a rule
 * costs"). The quickjs guide's "within milliseconds" for 10,000 checks
 * is two orders of magnitude off (docs/log.xml, l-p4-examples-iot-maxops-time),
 * so the platform measured its own (measure.mjs, holdTimes). */
export const SANDBOX = { maxOps: 200, memoryLimit: 8 * 1024 * 1024 };

/** The process's CPU time so far, user and system, in ms. */
const cpuTime = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Platform {
  /**
   * @param {object} [options]
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock] one clock for every host
   * @param {{ maxOps?: number, memoryLimit?: number }} [options.sandbox] each rule's limits
   * @param {number} [options.maxErrors] errors after which a rule is suspended
   * @param {number} [options.fuelBudget] fuel a rule may use per millisecond
   *   of the process's CPU time, measured over at least `fuelWindow` ms of it
   * @param {number} [options.fuelWindow] the process's CPU time, in ms, an
   *   audit's measure of fuel spans at least
   * @param {number} [options.maxUploadBytes] the largest chart a customer may upload
   * @param {number} [options.maxLogs] `<log>` lines a rule may send to its customer
   */
  constructor({ clock, sandbox = SANDBOX, maxErrors = 3, fuelBudget = 700, fuelWindow = 10, maxUploadBytes = 64 * 1024, maxLogs = 20 } = {}) {
    Object.assign(this, { clock, sandbox, maxErrors, fuelBudget, fuelWindow, maxUploadBytes, maxLogs });
    /** customer id -> { id, inbox: report[], rules: Map<rule id, rule> } */
    this.customers = new Map();
    /** device id -> { id, customer, session } */
    this.devices = new Map();
    const compiled = compileCharts([{ name: 'device.scxml', text: DEVICE_CHART }]);
    this.fleet = new Host(compiled, {
      system: 'fleet', clock, ioProcessors: { 'urn:iot:telemetry': { receive: (send) => this.#telemetry(send.event, send.data) } },
    });
    compiled.close();
  }

  addCustomer(id) {
    if (!ID.test(id)) throw new TypeError(`not a customer id: ${id}`);
    this.customers.set(id, { id, inbox: [], rules: new Map() });
  }

  /** A device of `customer`'s; its readings go to that customer's rules. */
  addDevice({ id, customer, deadband = 0, silenceAfter = '30s' }) {
    if (!ID.test(id)) throw new TypeError(`not a device id: ${id}`);
    if (!this.customers.has(customer)) throw new TypeError(`no customer ${customer}`);
    const session = this.fleet.spawn('device', { name: id, params: { deviceID: id, customer, deadband, silenceAfter } });
    this.devices.set(id, { id, customer, session });
  }

  /** A sample from a device's sensor. */
  sample(device, metric, value) {
    this.fleet.send(this.devices.get(device).session, 'sample', { metric, value });
  }

  /** What the customer's rules and devices told them, oldest first. */
  inbox(customer) {
    return this.customers.get(customer).inbox;
  }

  /** A rule written as a condition and a message, filled into the
   * template. Answers `{ ok: true }`, or `{ ok: false, diagnostics }` when
   * the rule is refused (also reported to the inbox). */
  addRule(customer, { id, when, message = `'${id}'`, sustain = 1, devices = '*' }) {
    const owner = this.customers.get(customer);
    const refused = (diagnostics) => this.#refuse(owner, id, diagnostics);
    if (!ID.test(id)) return refused([`not a rule id: ${JSON.stringify(id)}`]);
    if (!Number.isInteger(sustain) || sustain < 1 || sustain > 100) return refused([`sustain: a whole number from 1 to 100, not ${sustain}`]);
    const diagnostics = [];
    for (const [field, source] of [['when', when], ['message', message]]) {
      if (typeof source !== 'string' || source.length > 4096) diagnostics.push(`${field}: a string of at most 4096 characters`);
      else {
        const error = syntaxError(source);
        if (error) diagnostics.push(`${field}:1:1: error: SyntaxError: ${error}`);
      }
    }
    if (diagnostics.length) return refused(diagnostics);
    return this.#install(owner, { id, file: `${id}.scxml`, text: fillTemplate(RULE_TEMPLATE, { id, when, message }), devices, sustain });
  }

  /** A rule the customer wrote as a whole chart. Its `<scxml name>` is the
   * rule's id. */
  uploadChart(customer, { file, text, devices = '*' }) {
    const owner = this.customers.get(customer);
    if (typeof text !== 'string' || Buffer.byteLength(text) > this.maxUploadBytes) {
      return this.#refuse(owner, file, [`${file}: at most ${this.maxUploadBytes} bytes`]);
    }
    const id = chartName(text);
    if (!id || !ID.test(id)) return this.#refuse(owner, file, [`${file}: the <scxml> element needs a name of letters, digits and dashes`]);
    if (!/\sdatamodel\s*=\s*["']ecmascript["']/.test(text)) {
      // a chart without it gets SCXML's null datamodel, which evaluates nothing
      return this.#refuse(owner, id, [`${file}: the <scxml> element needs datamodel="ecmascript"`]);
    }
    return this.#install(owner, { id, file, text, devices });
  }

  #refuse(owner, rule, diagnostics) {
    owner.inbox.push({ type: 'rule.rejected', rule, diagnostics });
    return { ok: false, diagnostics };
  }

  #install(owner, { id, file, text, devices, sustain }) {
    if (owner.rules.has(id)) return this.#refuse(owner, id, [`a rule named ${id} exists`]);
    let compiled;
    try {
      // no resolver: a `src` is a compile error; warningsAsErrors: a syntax
      // error in the chart's JavaScript, which compileCharts parses, too
      compiled = compileCharts([{ name: file, text }], { warningsAsErrors: true });
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      return this.#refuse(owner, id, error.diagnostics.filter((d) => d.severity === 'error').map(formatDiagnostic));
    }
    const rule = {
      id, customer: owner.id, devices: devices === '*' ? '*' : new Set(devices), sustain,
      status: 'active', reason: undefined, logs: 0,
      /** session -> device, for the reports */
      sessions: new Map(),
      /** the counters at the last audit */
      seen: { errorsExecution: 0, errorsCommunication: 0, fuel: 0 },
      /** the fuel and the process's CPU time (ms) where the current measure began */
      window: { fuel: 0, cpu: cpuTime() },
    };
    rule.host = new Host(compiled, {
        system: `rule-${owner.id}-${id}`,
        clock: this.clock,
        datamodel: 'quickjs',
        quickjs: this.sandbox,
        ioProcessors: {
          // the customer's alert channel; whatever `target` the rule names,
          // the alert goes to its own customer
          'urn:iot:alert': { receive: (send) => owner.inbox.push({
            type: 'alert', rule: id, device: rule.sessions.get(send.session), event: send.event, data: send.data,
          }) },
        },
        // every send to another system: the fleet's devices, another
        // customer's rules, another of this customer's
        transport: (send) => {
          this.#violation(rule, `sent ${send.event} to ${send.target}`, rule.sessions.get(send.session));
          send.fail();
        },
        log: (entry) => {
          if (++rule.logs <= this.maxLogs) owner.inbox.push({ type: 'rule.log', rule: id, device: rule.sessions.get(entry.session), text: entry.text });
        },
      });
    compiled.close();
    owner.rules.set(id, rule);
    owner.inbox.push({ type: 'rule.installed', rule: id, warnings: compiled.diagnostics.map(formatDiagnostic) });
    return { ok: true };
  }

  /** The fleet's telemetry: readings go to the rules of the device's
   * customer, the device's own news to the customer. */
  #telemetry(event, data) {
    const owner = this.customers.get(data.customer);
    if (event !== 'reading') {
      owner.inbox.push({ type: event, device: data.device, ...(data.sample !== undefined ? { sample: data.sample } : {}) });
      return;
    }
    const reading = { device: data.device, metric: data.metric, value: data.value, seq: data.seq };
    for (const rule of owner.rules.values()) {
      if (rule.status !== 'active' || (rule.devices !== '*' && !rule.devices.has(reading.device))) continue;
      try {
        let actor;
        try {
          actor = rule.host.actor(reading.device);
        } catch (error) {
          if (!(error instanceof StaleError)) throw error;
          actor = rule.host.spawn(rule.id, {
            name: reading.device, params: { device: reading.device, ...(rule.sustain ? { sustain: rule.sustain } : {}) },
          });
          rule.sessions.set(actor.id, reading.device);
        }
        actor.send('reading', reading);
      } catch (error) {
        // the rule's actor for this device ended (a <final>, which a
        // customer's chart may reach): it is spawned again at the next
        // reading
        if (!(error instanceof TinyactorsError)) throw error;
        this.#violation(rule, `could not take a reading: ${error.message}`, reading.device);
      }
    }
  }

  #violation(rule, what, device) {
    this.customers.get(rule.customer).inbox.push({ type: 'rule.violation', rule: rule.id, ...(device ? { device } : {}), what });
  }

  #suspend(rule, reason) {
    rule.status = 'suspended';
    rule.reason = reason;
    rule.host.close(); // frees the engine, its memory and every actor of the rule
    this.customers.get(rule.customer).inbox.push({ type: 'rule.suspended', rule: rule.id, reason });
  }

  /** Reads each active rule's counters and reports what changed since the
   * last audit: its errors, and the fuel it used. A rule over `maxErrors`
   * in all, or over `fuelBudget` fuel a millisecond of the process's CPU
   * time (over at least `fuelWindow` ms of it), is suspended. The
   * counters answer even while a rule keeps its host busy. */
  async audit() {
    for (const owner of this.customers.values()) {
      for (const rule of owner.rules.values()) {
        if (rule.status !== 'active') continue;
        let stats;
        try {
          stats = await rule.host.hostStats();
        } catch (error) {
          if (rule.status !== 'active') continue; // suspended while we waited
          throw error;
        }
        if (rule.status !== 'active') continue;
        const now = { errorsExecution: 0, errorsCommunication: 0, fuel: 0 };
        for (const chart of stats.charts) for (const key of Object.keys(now)) now[key] += chart[key];
        // two audits may overlap (a timer's and a settle's): counters only grow
        for (const key of Object.keys(now)) now[key] = Math.max(now[key], rule.seen[key]);
        for (const [key, error] of [['errorsExecution', 'error.execution'], ['errorsCommunication', 'error.communication']]) {
          const count = now[key] - rule.seen[key];
          if (count > 0) owner.inbox.push({ type: 'rule.error', rule: rule.id, error, count });
        }
        rule.seen = now;
        // fuel per ms of the process's CPU time, not of the wall clock: a
        // process that shares its CPUs gets less of both, and a rule that
        // keeps its host busy takes most of the process's either way
        const cpu = cpuTime();
        const spent = cpu - rule.window.cpu;
        let rate = 0;
        if (spent >= this.fuelWindow) {
          rate = Math.round((now.fuel - rule.window.fuel) / spent);
          rule.window = { fuel: now.fuel, cpu };
        }
        const errors = now.errorsExecution + now.errorsCommunication;
        if (errors >= this.maxErrors) this.#suspend(rule, `${errors} errors`);
        else if (rate > this.fuelBudget) this.#suspend(rule, `busy: ${rate} fuel a millisecond of the process's CPU time, over its budget of ${this.fuelBudget}`);
      }
    }
  }

  /** Lets every host run what its inputs and timers started, then audits.
   * A rule that keeps its host busy never lets its host be idle, so each
   * wait is bounded (`patience` ms of real time), and the audit then finds
   * the rule over its budget. */
  async settle({ rounds = 3, patience = 50 } = {}) {
    for (let round = 0; round < rounds; round++) {
      await nextTick();
      const hosts = [this.fleet];
      for (const owner of this.customers.values()) {
        for (const rule of owner.rules.values()) if (rule.status === 'active') hosts.push(rule.host);
      }
      // an audit between (main.mjs runs them on a timer) may suspend a rule,
      // which closes its host: its idle() rejects then, and that is no news
      const idle = (host) => host.idle().catch((error) => { if (!host.closed) throw error; });
      await Promise.all(hosts.map((host) => Promise.race([idle(host), sleep(patience)])));
      await this.audit();
    }
  }

  /** What a rule costs, from its host's counters: its devices (one actor
   * each), its region and the bytes its actors use in it. */
  async cost(customer, id) {
    const rule = this.customers.get(customer).rules.get(id);
    const stats = await rule.host.hostStats();
    const pool = stats.pools[0];
    return {
      devices: stats.host.actors,
      regionBytes: stats.host.regionBytes,
      slabBytesUsed: pool.slabBytes.used,
      fuel: stats.charts.reduce((sum, chart) => sum + chart.fuel, 0),
    };
  }

  close() {
    for (const owner of this.customers.values()) {
      for (const rule of owner.rules.values()) if (rule.status === 'active') { rule.status = 'closed'; rule.host.close(); }
    }
    this.fleet.close();
  }
}
