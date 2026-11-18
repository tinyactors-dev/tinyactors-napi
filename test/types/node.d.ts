// The Node.js built-ins the documentation's examples use, typed `any`:
// tools/typecheck.mjs checks this package's types, and the package has no
// @types/node. A module or global an example needs joins this list.
declare module 'node:*';
declare var process: any;
declare var Buffer: any;
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): any;
