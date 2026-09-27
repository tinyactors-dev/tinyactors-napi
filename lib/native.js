'use strict';

// The compiled addon. Every other lib/ module reaches native code through
// this one, so the addon is loaded, and its error class registered, once.
// lib/loader.js finds it: the installed platform package, else the
// repository build.

module.exports = require('./loader').loadAddon();
