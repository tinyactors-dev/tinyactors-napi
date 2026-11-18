// One of the uploads (spin or hoard, argv[2]) on the native datamodel, in a
// process of its own: it prints `started`, and `stopped` if the rule's
// evaluation ever ends. measure.mjs runs it and kills it.
import { readFileSync } from 'node:fs';
import { Host } from '@tinyactors/node';

const name = process.argv[2];
const host = new Host({ systemID: 'native-rule' }, { datamodel: 'native' });
host.addCharts({ [`${name}.scxml`]: readFileSync(new URL(`./uploads/${name}.scxml`, import.meta.url), 'utf8') });
console.log('started');
host.send(host.spawnChart(name), 'reading', { device: 'd', metric: 'temp', value: 1, seq: 1 });
await host.idle();
console.log('stopped');
host.close();
