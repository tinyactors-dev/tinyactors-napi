'use strict';
/**
 * Node.js transports for links, added to createLink/serveLinks of both the
 * addon (index.js) and the wasm binding in Node (../web/node.mjs):
 *
 *   serveLinks(system, { port | server, path })  WebSocket (ws.js)
 *   serveLinks(system, { tcp: { port, host } })   TCP, length-prefixed frames
 *   createLink(system, { tcp: { host, port } })   TCP client
 *
 * Any other byte stream (a child process's stdio, a serial port) goes through
 * the runtime-independent `transport` / `accept` options: core.mjs frames
 * streams itself (docs/protocol.md, "Framing").
 */
const net = require('net');
const { webSocketSource } = require('./ws');

/* accepted TCP connections for serveLinks({ accept }) */
function tcpSource({ port = 0, host } = {}) {
  const server = net.createServer();
  const sockets = new Set();
  server.listen(port, host);
  return {
    get port() {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : undefined;
    },
    accept(onConnection) {
      server.on('connection', (socket) => {
        socket.setNoDelay(true);
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        onConnection(socket);
      });
      return () =>
        new Promise((resolve) => {
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        });
    },
  };
}

function withNodeTransports(api) {
  const serveAny = api.serveLinks;
  const linkAny = api.createLink;
  api.serveLinks = function serveLinks(system, options = {}) {
    if (options.accept) return serveAny(system, options);
    const source = options.tcp ? tcpSource(options.tcp) : webSocketSource(options);
    const served = serveAny(system, { ...options, accept: source.accept });
    return Object.defineProperty(served, 'port', { get: () => source.port, enumerable: true });
  };
  api.createLink = function createLink(system, options = {}) {
    if (!options.tcp) return linkAny(system, options);
    const { host = '127.0.0.1', port } = options.tcp;
    return linkAny(system, { ...options, transport: () => net.connect({ host, port }).setNoDelay(true) });
  };
  return api;
}

module.exports = { withNodeTransports, tcpSource };
