// The shared tests' cases that do not run against @tinyactors/wasm, each
// with its reason (docs/plan.xml, p5-api; docs/browser.md, "One API"):
// what a case needs that the wasm package or the runtime does not have.
export const REASONS = {
  memoryUsage: 'needs process.memoryUsage (the engine heap\'s size), which a page does not have',
  fs: 'needs node:fs',
  childProcess: 'needs node:child_process',
  workerThreads: 'needs node:worker_threads',
};

// file -> case -> reason, or [reason, runtimes...] for a case excluded in
// those runtimes only ('node', 'bun', 'browser'); '*' for every case of
// the file.
//
// The test task runs each file against @tinyactors/wasm on both
// datamodels, native and quickjs, as against @tinyactors/node; an entry
// excludes the case on both.
export const EXCLUDED = {
  'address.test.mjs': {
  },
  'compile.test.mjs': {
  },
  'convenience.test.mjs': {
  },
  'crossing.test.mjs': {
  },
  'datamodel.test.mjs': {
  },
  'docs.test.mjs': {
  },
  'effects.test.mjs': {
  },
  'growth.test.mjs': {
  },
  'hibernation.test.mjs': {
    "native: a hibernated actor holds nothing in the engine; its values come back with the blob": ['memoryUsage', 'browser'],
  },
  'host.test.mjs': {
  },
  'liveness.test.mjs': {
    "a process with only an open host exits": ['childProcess', 'browser'],
    "a process exits after an idle turn, the host still open": ['childProcess', 'browser'],
    "a process exits with a simulated clock moved": ['childProcess', 'browser'],
    "a process exits when a waiting idle() is rejected by close()": ['childProcess', 'browser'],
    "a pending deadline keeps the process alive until it comes": ['childProcess', 'browser'],
    "close() lets a process with a pending deadline exit": ['childProcess', 'browser'],
  },
  'loop.test.mjs': {
    "a handler's error, with no idle() waiting, is thrown from the turn's callback; the host goes on": ['childProcess', 'browser'],
  },
  'methods.test.mjs': {
  },
  'migration.test.mjs': {
  },
  'rules.test.mjs': {
    "a Host posted to a worker arrives as a plain object, which every method refuses": ['workerThreads', 'browser'],
    "a worker that ends with its hosts open frees them at its teardown, with no call of JavaScript": ['workerThreads', 'browser'],
    "every rule in AGENTS.md names tests that exist": ['fs', 'browser'],
    "the README says what no test can show: charts are trusted, deadlines keep a process alive, errors end it, using": ['fs', 'browser'],
    "the services guide says a handler returns the service, or a promise of it": ['fs', 'browser'],
  },
  'scale.test.mjs': {
  },
  'services.test.mjs': {
  },
  'shapes.test.mjs': {
    "directoryResolver reads source relative to base under its root": ['fs', 'browser'],
    "directoryResolver refuses what leaves its root: .., an absolute path, a symbolic link": ['fs', 'browser'],
    "directoryResolver: text is UTF-8 or refused; other errors of the file system pass; the root must exist": ['fs', 'browser'],
  },
  'snapshot.test.mjs': {
  },
  'telemetry.test.mjs': {
  },
};

// Whole files that do not load in a page: what they import at their top
// needs the runtime (a file is excluded where it would not load).
export const EXCLUDED_FILES = {
  'addon.test.mjs': ['fs', 'browser'], // copies the addon's loader into a temporary directory
  'crossing.test.mjs': ['childProcess', 'browser'], // the other package's snapshot is made by a process (browser.test.mjs crosses in a page)
  'docs.test.mjs': ['childProcess', 'browser'], // runs each example of the documentation as a process (wasm/test/documentation.mjs runs them in pages)
  'links.test.mjs': ['fs', 'browser'], // reads the package's documents
  'scale.test.mjs': ['childProcess', 'browser'], // runs each size as a process (tools/scale.mjs)
};

const applies = (entry, runtime) => {
  const [reason, ...where] = Array.isArray(entry) ? entry : [entry];
  return where.length === 0 || where.includes(runtime) ? REASONS[reason] ?? reason : undefined;
};

/** The cases of `file` excluded under `runtime`: name -> reason's text. */
export function exclusionsOf(file, runtime) {
  const out = new Map();
  for (const [name, entry] of Object.entries(EXCLUDED[file] ?? {})) {
    const reason = applies(entry, runtime);
    if (reason !== undefined) out.set(name, reason);
  }
  return out;
}

/** Why `file` is excluded whole under `runtime`, or undefined. */
export function fileExcluded(file, runtime) {
  return EXCLUDED_FILES[file] === undefined ? undefined : applies(EXCLUDED_FILES[file], runtime);
}

/** How many entries each reason has (a whole file counts once). */
export function counts() {
  const out = {};
  const add = (entry) => {
    const [reason] = Array.isArray(entry) ? entry : [entry];
    out[reason] = (out[reason] ?? 0) + 1;
  };
  for (const cases of Object.values(EXCLUDED)) for (const entry of Object.values(cases)) add(entry);
  for (const entry of Object.values(EXCLUDED_FILES)) add(entry);
  return out;
}
