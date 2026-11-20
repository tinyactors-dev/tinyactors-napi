// @tinyactors/wasm: the package's names, its module loaded with top-level
// await (the bundled tinyactors.wasm, beside this file), so
// `import { Host } from '@tinyactors/wasm'` is the line it is in Node: what
// the application layer (../lib/convenience.mjs) exports, over the direct
// layer (lib/direct.mjs), which it imports as `#direct`.
import { init } from './lib/state.mjs';

await init();

export * from '../lib/convenience.mjs';
