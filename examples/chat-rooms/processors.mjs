// The chat's I/O processors: one per external system, each an object whose
// receive(send) switches on send.event. A chart reaches them with
// <send type="chat:gateway">, <send type="chat:db"> and <send
// type="chat:inbox">; the fourth type the host serves, "spawn", is the
// package's Spawner.
import { Address } from '@tinyactors/node';

/** chat:gateway: the open sockets, one per connection actor. A socket is
 * anything with send(text) and close(code, reason): a WebSocket in a
 * server, a recorder in a test. */
export class Gateway {
  /** String(connection session) -> its socket */
  sockets = new Map();
  /** user -> the sessions of their connections (as strings) */
  users = new Map();

  /** The socket of a new connection actor. */
  attach(connection, user, socket) {
    const key = String(connection.id);
    this.sockets.set(key, socket);
    if (!this.users.has(user)) this.users.set(user, new Set());
    this.users.get(user).add(key);
  }

  /** The socket went away. */
  detach(session) {
    const key = String(session);
    this.sockets.delete(key);
    for (const sessions of this.users.values()) sessions.delete(key);
  }

  /** The sessions of `user`'s open connections. */
  online(user) {
    return [...(this.users.get(user) ?? [])].filter((key) => this.sockets.has(key));
  }

  receive(send) {
    switch (send.event) {
      case 'deliver': { // to the sending connection's own socket
        const socket = this.sockets.get(String(send.session));
        if (socket === undefined) return send.fail();
        socket.send(JSON.stringify([send.data.event, send.data.data]));
        return;
      }
      case 'broadcast': { // a room's message: one send, every member's socket
        // a member is its connection's address from the "#" on (#_scxml_<session>)
        const text = JSON.stringify([send.data.event, send.data.data]);
        const gone = [];
        for (const member of send.data.to) {
          const socket = this.sockets.get(String(new Address(`tinyactors://${send.host.system}/${member}`).session));
          if (socket === undefined) gone.push(member);
          else socket.send(text);
        }
        if (gone.length > 0) send.answer('members.gone', { members: gone });
        return;
      }
      case 'close': {
        const socket = this.sockets.get(String(send.session));
        this.detach(send.session);
        socket?.close(1000, send.data.reason);
        return;
      }
      default:
        send.fail();
    }
  }
}

/** chat:db: the database, here a few tables in memory standing in for
 * PostgreSQL. Its receive is async, as a database client's is; the host
 * fills the view before the handler's first await. */
export class Database {
  /** id -> {id, owners} */
  workspaces = new Map();
  /** `${workspace}.${name}` -> {workspace, name} */
  rooms = new Map();
  /** every message, in the order inserted: {workspace, room, user, text} */
  messages = [];
  /** user -> direct messages that came while they were offline */
  unread = new Map();

  async receive(send) {
    const data = send.data;
    await null; // a query's round trip
    switch (send.event) {
      case 'room.save':
        this.rooms.set(`${data.workspace}.${data.name}`, { workspace: data.workspace, name: data.name });
        return;
      case 'message.insert':
        this.messages.push({ workspace: data.workspace, room: data.room, user: data.user, text: data.text });
        return;
      default:
        send.fail();
    }
  }

  /** The last `n` messages of a room, for a room spawned again at a restart. */
  history(workspace, room, n = 50) {
    return this.messages.filter((m) => m.workspace === workspace && m.room === room).slice(-n)
      .map(({ room: name, user, text }) => ({ room: name, user, text }));
  }
}

/** chat:inbox: direct messages between users. A user is not an actor: the
 * inbox looks up the user's connection actors and forwards the message to
 * each, and keeps it in the database when the user has none (the
 * application routes a send whose actor may not be there). */
export class Inbox {
  constructor(gateway, database) {
    this.gateway = gateway;
    this.database = database;
  }

  receive(send) {
    if (send.event !== 'dm') return send.fail();
    const { from, to, text } = send.data;
    const sessions = this.gateway.online(to);
    for (const session of sessions) send.host.send(BigInt(session), 'dm', { from, text });
    if (sessions.length === 0) {
      if (!this.database.unread.has(to)) this.database.unread.set(to, []);
      this.database.unread.get(to).push({ from, text });
    }
  }
}
