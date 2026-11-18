// What a page and a Worker run (browser.test.mjs): both entries, then the
// scenarios, answered as plain data for the test to check.
export async function everything() {
  const index = await import('../index.mjs');
  const state = await import('../lib/state.mjs');
  const init = await import('../init.mjs');
  await init.init(); // the instance index.mjs loaded
  const { load } = await import('../lib/module.mjs');
  const scenario = await import('./scenario.mjs');
  const module = state.instance();
  const before = await import('../lib/state.mjs?before');
  let refused = null;
  try {
    before.instance();
  } catch (error) {
    refused = error.status;
  }
  const out = {
    entries: [typeof index.TinyactorsError, typeof init.init, refused],
    nullChart: scenario.nullChart(module),
    throwing: scenario.throwingImports(module, 200),
    forwarding: scenario.forwarding(module),
    trap: scenario.trap(await load()),
    afterTrap: scenario.nullChart(module).sends.length,
  };
  return JSON.parse(JSON.stringify(out, (key, value) => (typeof value === 'bigint' ? `${value}n` : value)));
}
