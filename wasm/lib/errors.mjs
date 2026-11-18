// The errors, as the addon defines them (src/module.c, src/compile.c):
// TinyactorsError, an Error with read-only `code`, `reason`, `path` and
// `status` (core's name of a status, ta_status_name), each undefined when
// not given; CompileError and ResolveError, its subclasses. A poisoned
// module's error carries what poisoned it as its `cause`.
export class TinyactorsError extends Error {
  constructor(message, options) {
    const given = options ?? {};
    super(message, given.cause !== undefined ? { cause: given.cause } : undefined);
    Object.defineProperties(this, {
      code: { value: given.code, enumerable: true },
      reason: { value: given.reason, enumerable: true },
      path: { value: given.path, enumerable: true },
      status: { value: given.status, enumerable: true },
    });
  }

  get name() { return 'TinyactorsError'; }
}

// A compilation with an error: every diagnostic, the message the first
// error's as a compiler prints it.
export class CompileError extends TinyactorsError {
  constructor(message, options) {
    const given = options ?? {};
    super(message, { status: given.status ?? 'TA_ERROR_INVALID' });
    Object.defineProperty(this, 'diagnostics', { value: Object.freeze([...(given.diagnostics ?? [])]), enumerable: true });
  }

  get name() { return 'CompileError'; }
}

// A resolver's refusal: a diagnostic of the resolved file at its line and
// column.
export class ResolveError extends TinyactorsError {
  constructor(message, options) {
    super(message, { status: 'TA_ERROR_INVALID' });
    const given = options ?? {};
    Object.defineProperties(this, {
      line: { value: given.line, enumerable: true },
      column: { value: given.column, enumerable: true },
    });
  }

  get name() { return 'ResolveError'; }
}

// A refusal of a call: core's status by its name.
export function refusal(status, message) {
  return new TinyactorsError(message, { status });
}

// A reply's error (core wrote it: {code, message, data: {reason, path}}),
// or a refused config's: a TinyactorsError with `status` only when it is
// a call's (`status` given).
export function coreError(error, status) {
  const options = {};
  if (status !== undefined) options.status = status;
  if (error === null || typeof error !== 'object') return new TinyactorsError(status ?? 'TA_ERROR_INVALID', options);
  options.code = error.code;
  if (error.data !== null && typeof error.data === 'object') {
    options.reason = error.data.reason;
    options.path = error.data.path;
  }
  return new TinyactorsError(error.message, options);
}
