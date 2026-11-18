// node:test in a page (wasm/test/documentation.mjs's import map): `test`,
// `it` and `describe` as the example applications' tests use them
// (examples/*/test.mjs): each case registered at the file's import and run
// in order by run(), which the page calls; a case the page's exclusions
// name (globalThis.__tinyactors_example.excluded, name -> reason) is
// skipped with its reason. Each case prints ok, skip
// or FAIL, as test/harness.mjs does.
const cases = [];
const prefix = [];

export function test(name, options, body) {
  const fn = typeof options === 'function' ? options : body;
  const skip = typeof options === 'object' && options !== null && options.skip;
  cases.push({ name: [...prefix, name].join(' > '), fn, skip });
}

export const it = test;

export function describe(name, body) {
  prefix.push(name);
  try {
    body();
  } finally {
    prefix.pop();
  }
}

/** Runs every case; answers the number that failed. */
export async function run({ excluded = {} }) {
  let failures = 0;
  for (const { name, fn, skip } of cases) {
    const reason = excluded[name] ?? (skip ? 'skipped by the file' : undefined);
    if (reason !== undefined) {
      console.log(`skip ${name} (${reason})`);
      continue;
    }
    try {
      await fn({ name });
      console.log(`ok   ${name}`);
    } catch (error) {
      failures++;
      console.log(`FAIL ${name}`);
      console.log(String(error?.stack ?? error).replace(/^/gm, '     '));
    }
  }
  return { failures, names: cases.map((each) => each.name) };
}

export default test;
