// @tinyactors/wasm: the package's names, its module loaded with top-level
// await (the bundled tinyactors.wasm, beside this file), so
// `import { Host } from '@tinyactors/wasm'` is the line it is in Node: the
// direct layer (lib/direct.mjs) and the convenience layer over it
// (../lib/convenience.mjs, which imports `#direct`).
import { init } from './lib/state.mjs';

await init();

export * from './lib/direct.mjs';
export * from '../lib/convenience.mjs';
