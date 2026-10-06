'use strict';
/**
 * A minimal WebSocket server (RFC 6455) for links: text frames, ping/pong,
 * close, fragmentation, no extensions. Each accepted connection is a
 * WebSocket-like object { send, close, onopen, onmessage, onclose } — the
 * transport serveLinks() expects. No dependencies.
 */
const crypto = require('crypto');
const http = require('http');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (n < 126) head[1] = n;
  else if (n < 65536) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

function accept(socket, head) {
  const conn = { onopen: null, onmessage: null, onclose: null, onerror: null, readyState: 1 };
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [];
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    conn.readyState = 3;
    if (conn.onclose) conn.onclose({});
  };
  conn.send = (text) => {
    if (!closed) socket.write(frame(0x1, Buffer.from(String(text))));
  };
  conn.close = () => {
    if (closed) return;
    try {
      socket.end(frame(0x8, Buffer.alloc(0)));
    } catch {}
    finish();
  };
  function parse() {
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskOff + (i & 3)];
      }
      buf = buf.subarray(off + len);
      if (op === 0x8) return conn.close();
      if (op === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (op === 0xa) continue;
      parts.push(payload);
      if (fin) {
        const data = Buffer.concat(parts).toString('utf8');
        parts = [];
        if (conn.onmessage) conn.onmessage({ data });
      }
    }
  }
  socket.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    parse();
  });
  socket.on('close', finish);
  socket.on('error', finish);
  socket.setNoDelay(true);
  if (buf.length) setImmediate(parse);
  return conn;
}

/**
 * Accept WebSocket upgrades on `server` (or a new server on `port`) at `path`.
 * Returns { accept(onConnection) -> stop, port } for serveLinks().
 */
function webSocketSource({ server, port, path = '/link' } = {}) {
  let own = null;
  if (!server) {
    own = http.createServer((req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('links only\n');
    });
    own.listen(port || 0);
    server = own;
  }
  let handler = null;
  const source = {
    server,
    get port() {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : undefined;
    },
    accept(onConnection) {
      handler = (req, socket, head) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname !== path) return; /* someone else's upgrade */
        const key = req.headers['sec-websocket-key'];
        if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
        );
        onConnection(accept(socket, head));
      };
      server.on('upgrade', handler);
      return () =>
        new Promise((resolve) => {
          server.off('upgrade', handler);
          if (own) {
            if (own.closeAllConnections) own.closeAllConnections();
            own.close(() => resolve());
          }
          else resolve();
        });
    },
  };
  return source;
}

module.exports = { webSocketSource };
