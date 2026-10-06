'use strict';
/**
 * tinyactors for Node.js — the xstate-style API (bindings/shared/core.mjs)
 * over the native addon written against the N-API C API (src/addon.c).
 */
const path = require('path');
const { createRuntime } = require('../shared/core.mjs');

/* The addon: an override, then this tree's build (mise run node:build),
 * then the platform package an install of @tinyactors/node brings
 * (@tinyactors/node-<platform>-<arch>, an optional dependency npm, pnpm and
 * Bun install only where it matches). The platform package is tried last,
 * so its error is the one an install without a matching addon reports. */
function loadNative() {
  const candidates = [
    process.env.TINYACTORS_NATIVE,
    path.join(__dirname, 'build', 'tinyactors.node'),
    `@tinyactors/node-${process.platform}-${process.arch}`,
  ].filter(Boolean);
  let lastError;
  for (const p of candidates) {
    try {
      return require(p);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

const platform = {
  now: () => performance.now(),
  defer: (fn) => setImmediate(fn),
  cancelDefer: (h) => clearImmediate(h),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
  log: (...args) => console.log(...args),
};

/* links in Node also over WebSocket servers ({ server, path } or { port })
 * and TCP ({ tcp }): transports.js */
const api = require('./transports').withNodeTransports(createRuntime({ native: loadNative(), platform }));

module.exports = api;
