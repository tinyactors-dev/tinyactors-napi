'use strict';
// The binding under test: the N-API addon (default) or the wasm/browser
// binding (TA_BINDING=web) — both expose the same API.
module.exports = process.env.TA_BINDING === 'web' ? require('../../web/node.mjs') : require('..');
