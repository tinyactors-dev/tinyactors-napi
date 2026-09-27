'use strict';

const assert = require('node:assert/strict');
const addon = require('..');
const packageMetadata = require('../package.json');

assert.equal(addon.version, packageMetadata.version);
assert.deepEqual(Object.keys(addon).sort(), [
  'DAPReader',
  'TRACE_KINDS',
  'TinyactorsError',
  'content',
  'createDebugSession',
  'createSystem',
  'decodeTraces',
  'encodeDAPMessage',
  'formatTraceparent',
  'literal',
  'metricsToOTLP',
  'parseTraceparent',
  'statechart',
  'stepSpanID',
  'version',
]);
