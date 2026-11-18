// chartgen.mjs in a node:vm context, under node or bun.
import { chartgen } from './chartgen.mjs';
const vm = process.getBuiltinModule('node:vm');
const realm = vm.runInContext('globalThis', vm.createContext({}));
console.log(typeof Bun !== 'undefined' ? 'bun' : 'node', JSON.stringify(chartgen(realm)));
