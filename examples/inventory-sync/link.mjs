// The link between two systems: what the warehouse and the storefront
// share. One TCP connection carries frames in remote-python's framing (a
// 4-byte big-endian length, then one CBOR item: ../remote-python/remote.mjs,
// README.md "The wire" there), each a JSON-RPC 2.0 notification without its
// "jsonrpc" member:
//   message.send  params: a transport's send.message, its addresses as text
//   message.fail  params: {sender, sendid}: the receiver could not deliver
//                 the message whose origin and sendid these are
//
// A Link is one side's end. Its `transport` is the host's transport
// handler; `attach(socket)` gives it the connection, and a link with none
// (down, or not yet connected) fails every send at once, so the sending
// actor gets error.communication.
import { Address, decode, encode } from '@tinyactors/node';
import { Frames, frame } from '../remote-python/remote.mjs';


export class Link {
  /** frames written on the current connection, and frames read from it */
  sent = 0;
  received = 0;
  #socket;

  /**
   * @param {object} options
   * @param {string} options.system this side's systemID
   * @param {string} options.peer the other side's systemID
   * @param {(method: string, params: object) => 'send' | 'drop' | 'duplicate' | 'disconnect'} [options.fault]
   *   a fault to inject before a frame is written (tests and the demo):
   *   lose it, write it twice, or lose the connection instead
   * @param {(line: string) => void} [options.trace] one line per frame, for the demo
   */
  constructor({ system, peer, fault = () => 'send', trace = () => {} }) {
    this.system = system;
    this.peer = peer;
    this.fault = fault;
    this.trace = trace;
    this.host = undefined; // set by the side that owns the host
  }

  get connected() {
    return this.#socket !== undefined;
  }

  /** The host's `transport` handler: every send to another system. */
  transport = (host, send) => {
    if (send.target.system !== this.peer || !this.#write('message.send', send.message)) {
      send.fail(); // no route, or no connection: the sender gets error.communication
    }
  };

  /** Takes `socket` as the connection to the peer. Resolves when it closes. */
  attach(socket) {
    this.#socket?.destroy();
    this.#socket = socket;
    this.sent = 0;
    this.received = 0;
    socket.setNoDelay(true); // small frames, each answered: no waiting for Nagle's algorithm
    const frames = new Frames();
    socket.on('data', (chunk) => {
      if (this.#socket !== socket) return;
      for (const body of frames.push(chunk)) {
        this.received++;
        this.#receive(decode(body));
      }
    });
    socket.on('error', () => {}); // a peer that went away: 'close' follows
    return new Promise((resolve) => socket.on('close', () => {
      if (this.#socket === socket) this.#socket = undefined;
      resolve();
    }));
  }

  /** Drops the connection, as a crash or a network failure would. */
  disconnect() {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();
  }

  /** Writes one frame; false when there is no connection to write on. */
  #write(method, params) {
    const socket = this.#socket;
    if (socket === undefined || !socket.writable) return false;
    const fault = this.fault(method, params);
    this.trace(`${fault === 'send' ? '' : `[${fault}] `}${method} ${params.event ?? ''} ${JSON.stringify(params.data ?? { sender: params.sender })}`);
    if (fault === 'disconnect') {
      this.disconnect();
      return false;
    }
    if (fault === 'drop') return true; // lost on the way: nobody knows
    const bytes = frame(method, params);
    for (let copy = fault === 'duplicate' ? 2 : 1; copy > 0; copy--) {
      this.sent++;
      socket.write(bytes, (error) => {
        // written to a connection that broke: the sender is told
        if (error && method === 'message.send') this.host?.fail(params.origin, params.sendid ?? undefined);
      });
    }
    return true;
  }

  #receive(notification) {
    const params = notification?.params;
    if (params === null || typeof params !== 'object') return;
    if (notification.method === 'message.send') {
      try {
        this.host.send(params); // the message as the other side's transport gave it
      } catch {
        // no such actor here (an unknown SKU, a cart that ended): tell the sender
        this.#write('message.fail', { sender: params.origin, sendid: params.sendid });
      }
    } else if (notification.method === 'message.fail' && params.sender instanceof Address) {
      const sender = params.sender;
      if (sender.system === this.system) {
        try {
          this.host.fail(sender, params.sendid ?? undefined); // only a send of ours
        } catch {
          // the sender ended meanwhile: nobody to tell
        }
      }
    }
  }
}
