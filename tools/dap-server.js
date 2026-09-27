'use strict';

// A development transport for the debug adapter (lib/debug.js, napi ADR
// 0026): it runs a small example system and serves a debug session over
// stdio, or one per connection on a local port, so a DAP client can be
// tried against it. It is not part of the package: a production
// application puts createDebugSession() behind its own transport and
// authentication, and decides each user's permissions.
//
//   node tools/dap-server.js                  DAP on stdin and stdout
//   node tools/dap-server.js --port 4711      sessions on 127.0.0.1:4711
//   node tools/dap-server.js --watch          grant no permission: watch only
//
// Attach with { "address": "subscription/acct_1" } (acct_1 to acct_3), and
// an "allow" list to ask for fewer permissions. The example: each account
// renews every 20 seconds and, now and then, a payment fails and a webhook
// comes in, so a watched actor has something to show. Every permission is
// granted unless --watch, and the audit records go to stderr.

const net = require('node:net');
const { createSystem, statechart, createDebugSession, DAPReader, encodeDAPMessage } = require('..');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const port = option('port');
const allow = args.includes('--watch') ? [] : ['send', 'set', 'goto', 'evaluate'];

// Written one builder call per statement, so each element has its own line.
function subscription() {
  const chart = statechart({ family: 'subscription', revision: 'v1' });
  chart.data('failures', 0);
  chart.data('renewals', 0);
  chart.data('plan', { name: 'basic', seats: 2 });
  chart.state('active', (s) => {
    s.entry((e) => {
      e.send('billing.renew', (send) => send.id('renewal').after('20s'));
    });
    s.on('billing.renew', (t) => {
      t.target('renewing');
    });
    s.on('payment.failed', (t) => {
      t.target('past_due');
      t.assign('failures', function () { return this.failures + 1; });
    });
    s.on('ping', (t) => {
      t.send('pong', (send) => send.via(({ event }) => event.originType).to(({ event }) => event.origin));
    });
  });
  chart.state('renewing', (s) => {
    s.entry((e) => {
      e.assign('renewals', function () { return this.renewals + 1; });
      e.log('renewed', function () { return `renewal ${this.renewals}`; });
    });
    s.always((t) => {
      t.target('active');
    });
  });
  chart.state('past_due', (s) => {
    s.entry((e) => {
      e.log('past due', function () { return `${this.failures} failure(s)`; });
    });
    s.on('payment.succeeded', (t) => {
      t.target('active');
    });
    s.on('payment.failed', (t) => {
      t.assign('failures', function () { return this.failures + 1; });
    });
  });
  return chart;
}

const system = createSystem();
const definition = system.define(subscription());
const accounts = ['acct_1', 'acct_2', 'acct_3'].map((name) => system.spawn(definition, { name }));
// Traffic: a payment fails or succeeds, or a webhook pings, every few seconds.
const events = ['payment.failed', 'payment.succeeded', 'ping'];
const traffic = setInterval(() => {
  const actor = accounts[Math.floor(Math.random() * accounts.length)];
  if (system.exists(actor)) system.post(actor, events[Math.floor(Math.random() * events.length)]);
}, 4000);
traffic.unref();

function serve(input, write, onClose) {
  const session = createDebugSession(system, {
    allow,
    audit: (entry) => process.stderr.write(`dap-server audit: ${JSON.stringify(entry)}\n`),
    send: (message) => write(encodeDAPMessage(message)),
  });
  const reader = new DAPReader((message) => {
    session.receive(message).catch((error) => process.stderr.write(`dap-server: ${error.stack ?? error}\n`));
  });
  input.on('data', (chunk) => {
    try {
      reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (error) {
      process.stderr.write(`dap-server: ${error.message}\n`);
      session.close();
      onClose();
    }
  });
  input.on('end', () => {
    session.close();
    onClose();
  });
}

if (port === undefined) {
  serve(process.stdin, (bytes) => process.stdout.write(bytes), () => {
    system.close();
    process.exit(0);
  });
} else {
  const server = net.createServer((socket) => {
    serve(socket, (bytes) => socket.write(bytes), () => socket.destroy());
  });
  server.listen(Number(port), '127.0.0.1', () => {
    process.stderr.write(`dap-server: ${allow.length === 0 ? 'watch-only' : 'watch and poke'} sessions on 127.0.0.1:${server.address().port}\n`);
  });
}
