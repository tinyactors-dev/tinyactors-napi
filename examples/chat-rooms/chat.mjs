// The application: a chat service whose workspaces, rooms and connections
// are actors of charts/. The charts hold the logic (who may make a room,
// who may post, what a client may ask); this file gives the host its I/O
// processors, one per external system, and its store, and does what only
// the application knows: which workspaces and rooms exist when it starts,
// and which socket is which connection.
import { compileDir, Host, Spawner } from '@tinyactors/node';
import { Database, Gateway, Inbox } from './processors.mjs';

/** The charts, compiled once per process: every *.scxml of charts/, each
 * <script src> read from beside it. Any number of hosts add them. */
export const charts = compileDir(new URL('./charts/', import.meta.url));

/**
 * A chat service: its host, the gateway of its sockets and its database.
 *
 * @param {object} [options]
 * @param {import('@tinyactors/node').Store} [options.store] where idle
 *   actors are hibernated to (store.mjs's FileStore in main.mjs)
 * @param {number} [options.resident] the most actors kept in memory
 * @param {Database} [options.database] the database, kept across restarts
 * @param {import('@tinyactors/node').SimulatedClock} [options.clock]
 * @param {'native' | 'quickjs'} [options.datamodel]
 */
export class Chat {
  constructor({ store, resident, database = new Database(), clock, datamodel } = {}) {
    this.gateway = new Gateway();
    this.database = database;
    this.host = new Host(charts, {
      system: 'chat',
      ioProcessors: {
        'chat:gateway': this.gateway,
        'chat:db': database,
        'chat:inbox': new Inbox(this.gateway, database),
        spawn: new Spawner(),
      },
      store,
      resident,
      clock,
      datamodel,
      // a connection that ended (a missed heartbeat, a closed socket) has
      // no socket any more
      onDone: (actor) => this.gateway.detach(actor.id),
    });
  }

  /** A new workspace: saved, and its actor spawned. */
  createWorkspace(id, owners) {
    this.database.workspaces.set(id, { id, owners });
    return this.host.spawn('workspace', { name: `workspace.${id}`, params: { id, owners } });
  }

  /** After a restart: every workspace and room the database holds, spawned
   * again. Each room announces itself to its workspace when it starts, as
   * one made by the workspace does, so the workspaces learn their rooms. */
  recover() {
    for (const { id, owners } of this.database.workspaces.values()) {
      this.host.spawn('workspace', { name: `workspace.${id}`, params: { id, owners } });
    }
    for (const { workspace, name } of this.database.rooms.values()) {
      this.host.spawn('room', {
        name: `room.${workspace}.${name}`,
        params: { workspace, name, history: this.database.history(workspace, name) },
      });
    }
  }

  /** A client's socket opened: a connection actor for it. */
  connect(user, workspace, socket) {
    const connection = this.host.spawn('connection', { params: { user, workspace } });
    this.gateway.attach(connection, user, socket);
    return connection;
  }

  /** A frame from a client, [event, data]: to its connection actor as
   * client.<event> (the chart drops what it does not know). */
  received(connection, frame) {
    const [event, data] = JSON.parse(frame);
    connection.send(`client.${event}`, data);
  }

  /** The client's socket closed. */
  closed(connection) {
    this.gateway.detach(connection.id);
    connection.send('socket.closed');
  }

  /** The names of a workspace's rooms, asked of the workspace itself (a
   * hibernated one is woken to answer). */
  async rooms(workspace) {
    const [, data] = await this.host.actor(`workspace.${workspace}`).ask('rooms.list');
    return data.rooms;
  }

  close() {
    this.host.close();
  }
}

/** A socket that keeps the frames it was sent: a stand-in for a WebSocket. */
export class Socket {
  frames = [];
  closedWith = undefined;

  send(text) {
    this.frames.push(JSON.parse(text));
  }

  close(code, reason) {
    this.closedWith = { code, reason };
  }

  /** The frames of `event`, their data. */
  of(event) {
    return this.frames.filter(([name]) => name === event).map(([, data]) => data);
  }
}
