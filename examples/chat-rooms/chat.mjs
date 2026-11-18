// The application: a chat service whose rooms and users are actors of
// charts/room.scxml and charts/user.scxml. The charts decide who may join,
// post and read; this file does the I/O they ask for (pushes to the users'
// connections, digest emails, answers to the application's reads) and keeps
// the resident set bounded: a sweep hibernates the cold actors into a
// FileStore, and the host's wake handler brings one back when a message
// comes for it.
import { readFileSync } from 'node:fs';
import { Host, TinyactorsError } from '@tinyactors/node';
import { FileStore } from './store.mjs';

const CHARTS = Object.fromEntries(['room.scxml', 'user.scxml'].map(
  (name) => [name, readFileSync(new URL(`./charts/${name}`, import.meta.url), 'utf8')]));

export class Chat {
  /**
   * @param {object} options
   * @param {string} options.dir the store's directory
   * @param {number} [options.maxResident] actors kept in memory after an
   *   eviction, at most
   * @param {number} [options.actors] actors expected, to size the host
   * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
   * @param {'native' | 'quickjs'} [options.datamodel]
   * @param {object} [options.storeHooks] FileStore's test hooks
   * @param {object} [options.user] the user chart's settings:
   *   inboxLimit, digestDelayMs
   * @param {object} [options.room] the room chart's settings:
   *   capacity, historyLimit, maxLength
   */
  constructor({ dir, maxResident = 1000, actors = 4096, clock, datamodel, storeHooks, user = {}, room = {} }) {
    this.maxResident = maxResident;
    this.userSettings = user;
    this.roomSettings = room;
    this.store = new FileStore(dir, storeHooks);
    /** user name -> connection ({ send(frame) }) */
    this.connections = new Map();
    /** digest emails, in order */
    this.mail = [];
    /** request id -> resolve, for the reads of rooms */
    this.requests = new Map();
    this.nextRequest = 1;
    /** resident sessions, least recently used first */
    this.resident = new Map();
    /** the promises of wakes and writes on the way, for settle() */
    this.inflight = new Set();
    this.counts = { hibernated: 0, woken: 0, wokenFromMemory: 0, writeFailures: 0, notAtRest: 0 };
    /** session -> how many wakes the host asked for (tests read it) */
    this.wakes = new Map();
    /** the first error a wake or a write met; settle() throws it */
    this.failure = undefined;

    // Sized for the population up front: every actor has a slot,
    // hibernated or not, and its delayed digest. The pools of events and
    // of variables and strings grow when a burst fills them.
    this.host = new Host(
      {
        systemID: 'chat',
        ioProcessors: [{ type: 'urn:chat:client' }, { type: 'urn:chat:mail' }, { type: 'urn:chat:reply' }],
        system: {
          maxActors: actors + 256, maxTimers: actors + 256,
        },
      },
      {
        clock,
        datamodel,
        wake: (host, session) => this.wake(session),
        ioProcessors: {
          'urn:chat:client': (host, send) => this.push(send.target, send.event, send.data),
          'urn:chat:mail': (host, send) => { this.mail.push({ user: send.target, ...send.data }); },
          'urn:chat:reply': (host, send) => {
            const { request, ...result } = send.data;
            this.requests.get(request)?.(result);
            this.requests.delete(request);
          },
        },
      },
    );
    this.host.addCharts(CHARTS);
  }

  // --- the users' side ---------------------------------------------------

  /** Makes a user's actor (named `user-<name>`). */
  register(name) {
    return this.spawn('user', `user-${name}`, { user: name, ...this.userSettings });
  }

  /** Makes a room's actor (named `room-<name>`). */
  createRoom(name, settings = {}) {
    return this.spawn('room', `room-${name}`, { room: name, ...this.roomSettings, ...settings });
  }

  join(user, room) { this.input(`user-${user}`, 'join', { room }); }
  leave(user, room) { this.input(`user-${user}`, 'leave', { room }); }
  say(user, room, text) { this.input(`user-${user}`, 'say', { room, text }); }

  /** The user's client connected: `connection.send(frame)` gets each push,
   * the backlog first. */
  connect(user, connection) {
    this.connections.set(user, connection);
    this.input(`user-${user}`, 'connect');
  }

  /** The user's client goes away. The actor pushes `disconnected` last,
   * and the connection is dropped then: a message pushed before the actor
   * saw the disconnect still reaches it. */
  disconnect(user) {
    this.input(`user-${user}`, 'disconnect');
  }

  /** The room's members, sequence number and history, from the room
   * itself: a hibernated room is woken to answer. */
  history(room) {
    const request = this.nextRequest++;
    const answer = new Promise((resolve) => this.requests.set(request, resolve));
    this.input(`room-${room}`, 'history', { request });
    return answer;
  }

  spawn(chart, name, params) {
    const session = this.host.spawnChart(chart, { name, params });
    this.resident.set(session, true);
    return session;
  }

  /** An event from the application for a named actor, which may be
   * hibernated: the host keeps it in the actor's queue and asks the wake
   * handler for the actor. */
  input(name, event, data) {
    const session = this.host.actorByName(name);
    if (session === undefined) throw new Error(`no such actor: ${name}`);
    this.touch(session);
    this.host.send(session, event, data);
  }

  push(user, event, data) {
    this.connections.get(user)?.send({ event, ...data });
    if (event === 'disconnected') this.connections.delete(user);
  }

  touch(session) {
    if (this.resident.delete(session)) this.resident.set(session, true);
  }

  // --- hibernation -------------------------------------------------------

  /** The host's wake handler: an event (or a due digest) came for a
   * hibernated actor. The blob comes from memory while its write is on the
   * way, else from its file. The host asks once per hibernation; events
   * that come before the wake is done wait in the actor's queue. */
  wake(session) {
    this.wakes.set(session, (this.wakes.get(session) ?? 0) + 1);
    const blob = this.store.take(session);
    if (!(blob instanceof Promise)) {
      this.host.wake(session, blob);
      this.woke(session);
      return;
    }
    // The handler does not return the read's promise, which host.idle()
    // would wait for: the tests hold a read to look at the host while it
    // is on its way, and settle() tracks it.
    this.track(blob.then((bytes) => {
      this.host.wake(session, bytes);
      this.woke(session);
    }));
  }

  woke(session) {
    this.counts.woken++;
    this.resident.set(session, true);
  }

  /** Hibernates `session` into the store; answers whether it went. An actor
   * not at rest (events waiting, in a step) stays resident. */
  hibernate(session) {
    let blob;
    try {
      blob = this.host.hibernate(session);
    } catch (error) {
      if (error instanceof TinyactorsError && error.status === 'TA_ERROR_STATE') {
        this.counts.notAtRest++;
        return false;
      }
      throw error;
    }
    this.resident.delete(session);
    this.counts.hibernated++;
    this.track(this.store.put(session, blob).then((result) => {
      if (result.written || result.taken) return; // stored, or awake already
      // The write failed and nobody took the blob: this is its only copy.
      // Put the actor back in memory; the next eviction tries again.
      this.counts.writeFailures++;
      this.host.wake(session, blob);
      this.counts.wokenFromMemory++;
      this.resident.set(session, true);
    }));
    return true;
  }

  /** One eviction, when more than maxResident actors are in memory: first
   * the actors the sweep finds cold (they did not run since the last
   * sweep), then the least recently used, until maxResident are left. An
   * actor not at rest is skipped. Answers how many went. */
  evict({ maxScan = 1 << 20 } = {}) {
    let went = 0;
    const over = this.resident.size - this.maxResident;
    if (over <= 0) return 0;
    for (const session of this.host.sweep(maxScan, over)) went += this.hibernate(session) ? 1 : 0;
    for (const session of [...this.resident.keys()]) {
      if (this.resident.size <= this.maxResident) break;
      went += this.hibernate(session) ? 1 : 0;
    }
    return went;
  }

  track(promise) {
    const tracked = promise.catch((error) => { this.failure ??= error; })
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
    return tracked;
  }

  /** Waits until the host is idle and no wake or write is on the way:
   * the wake handler's file reads and the writes after a sweep are
   * promises this class starts and tracks itself. */
  async settle() {
    for (;;) {
      await this.host.idle();
      if (this.inflight.size === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        await this.host.idle();
        if (this.inflight.size === 0) break;
      }
      await Promise.all(this.inflight);
    }
    if (this.failure) throw this.failure;
  }

  /** Resident and hibernated actors, as the host counts them. */
  async counters() {
    const { host } = await this.host.hostStats();
    return { actors: host.actors, hibernated: host.hibernated, resident: host.actors - host.hibernated };
  }

  close() {
    this.host.close();
  }
}

/** A connection that keeps what it was sent: a stand-in for a WebSocket. */
export class Connection {
  constructor() {
    this.frames = [];
  }

  send(frame) {
    this.frames.push(frame);
  }

  of(event) {
    return this.frames.filter((frame) => frame.event === event);
  }
}
