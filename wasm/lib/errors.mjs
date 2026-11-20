// The errors, as the addon defines them (src/module.c, src/compile.c):
// TinyactorsError, an Error with read-only `code`, `reason`, `path` and
// `status` (core's name of a status, ta_status_name), each undefined when
// not given; CompileError and ResolveError, its subclasses. A poisoned
// module's error carries what poisoned it as its `cause`.
// One subclass per status an application branches on (StaleError,
// StateError, InvalidError, UnsupportedError): `new TinyactorsError(message,
// {status})` makes the subclass of that status itself, and a typed method's
// error the subclass of its code (-32001 stale, -32002 state, any other
// invalid), so no call that throws chooses a class.
let byStatus, byCode;

export class TinyactorsError extends Error {
  constructor(message, options) {
    const given = options ?? {};
    if (new.target === TinyactorsError) {
      const subclass = byStatus[given.status] ?? (given.code === undefined ? undefined : byCode(given.code));
      if (subclass !== undefined) return new subclass(message, options);
    }
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

const of = (name, status) => ({ [name]: class extends TinyactorsError {
  constructor(message, options) {
    const given = options ?? {};
    super(message, given.code === undefined ? { ...given, status: given.status ?? status } : given);
  }

  get name() { return name; }
} })[name];

export const StaleError = of('StaleError', 'TA_ERROR_STALE');
export const StateError = of('StateError', 'TA_ERROR_STATE');
export const InvalidError = of('InvalidError', 'TA_ERROR_INVALID');
export const UnsupportedError = of('UnsupportedError', 'TA_ERROR_UNSUPPORTED');
byStatus = { __proto__: null, TA_ERROR_STALE: StaleError, TA_ERROR_STATE: StateError,
  TA_ERROR_INVALID: InvalidError, TA_ERROR_UNSUPPORTED: UnsupportedError };
byCode = (code) => code === -32001 ? StaleError : code === -32002 ? StateError : InvalidError;

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
