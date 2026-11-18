// The warehouse as a process of its own, for the demo (main.mjs): it
// listens on a port of 127.0.0.1 the system picks and writes it as the
// first line of its standard output, {"port": N}; then one JSON line per
// stock change and per <log> line of its SKUs. At SIGTERM it goes down for
// maintenance: it writes its inventory ({"stopped": ...}) and its snapshot
// to --snapshot, and exits. Started again with the same --snapshot, it is
// restored from it.
//
//   node warehouse-main.mjs --snapshot <file> [--catalog '{"tea": 10}'] [--hold-for 900s]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Warehouse } from './warehouse.mjs';

const { values } = parseArgs({
  options: {
    snapshot: { type: 'string' },
    catalog: { type: 'string', default: '{}' },
    'hold-for': { type: 'string', default: '900s' },
  },
});
const print = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

const restored = values.snapshot !== undefined && existsSync(values.snapshot);
const warehouse = new Warehouse({
  catalog: JSON.parse(values.catalog),
  holdFor: values['hold-for'],
  snapshot: restored ? readFileSync(values.snapshot) : undefined,
  onReport: (entry) => print({ report: entry }),
  onLog: (line) => print({ log: line }),
});
print({ port: await warehouse.listen(), restored });

process.once('SIGTERM', async () => {
  const inventory = await warehouse.inventory();
  const snapshot = await warehouse.stop();
  if (values.snapshot !== undefined) writeFileSync(values.snapshot, snapshot);
  print({ stopped: inventory });
  process.exit(0);
});
