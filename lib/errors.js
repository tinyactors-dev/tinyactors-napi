'use strict';

// TinyactorsError (ADR 0008). API calls throw it synchronously for misuse,
// such as wrong argument types or a closed system; the pump never throws.
//
// `code` is a TinyactorsErrorCode string. Native code derives codes from core
// results; step 3 generates that table from the API description.

const native = require('./native');

class TinyactorsError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'TinyactorsError';
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

native.setup(TinyactorsError);

module.exports = { TinyactorsError };
