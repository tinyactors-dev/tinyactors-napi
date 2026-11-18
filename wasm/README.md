# @tinyactors/wasm

SCXML statecharts as actors, in the browser, a Worker, Node.js and Bun:
the tinyactors host compiled to WebAssembly, with the API of
[`@tinyactors/node`](https://www.npmjs.com/package/@tinyactors/node), the
same classes, methods, handlers, values, errors and types. Both packages
are one release: the same version and the same changelog.

```sh
npm install @tinyactors/wasm
```

```js
import { compileCharts, Host } from '@tinyactors/wasm';

const compiled = compileCharts([{ name: 'hello.scxml', text: `
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0"
       datamodel="ecmascript" name="hello" initial="s">
  <state id="s"><onentry><log expr="'hello from ' + _ioprocessors.scxml.location"/></onentry></state>
</scxml>` }]);
const host = new Host({ systemID: 'web' }, { log: (host, entry) => console.log(entry.text) });
host.addImage(compiled.image);
compiled.close();
host.spawn(host.chart('hello'));
await host.idle();
host.close();
```

The default entry loads the module with top-level `await`, so every name
works once the import settles. Where a module graph cannot hold
top-level `await` (a Service Worker), or a bundler does not place
`tinyactors.wasm`, import `@tinyactors/wasm/init` and `await init()`
first. No bundler is needed: a page imports the package's `index.mjs`
(through an import map, or by its path), and a module Worker by its
path.

## What it needs

- **Engines:** WebAssembly with `extended-const`, `multivalue`,
  `bulk-memory` and `nontrapping-fptoint`, top-level `await` and
  `String.prototype.isWellFormed`: by the engines' release notes Chrome
  and Edge 114, Firefox 119 and Safari 16.4 (only Chromium is tested);
  Node.js 22.3 and Bun 1.4.
- **A Content Security Policy** that allows the module and the charts'
  expressions: `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'`
  (on quickjs `'wasm-unsafe-eval'` is enough).
- **TypeScript:** the `es2022` and `dom` libs; the types declare
  `Symbol.dispose` and `Disposable` themselves, so no `esnext` lib is
  needed.
- **Size** (measured by `mise run pack:wasm`, 2026-10-18): the package
  is 534 KiB packed and 1434 KiB unpacked; the module, `tinyactors.wasm`
  (built for size, `-Oz`, quickjs in it), is 1150 KiB, 456 KiB with gzip
  and 378 KiB with brotli, as a server sends it; without quickjs it was
  137 KiB with brotli.
- **quickjs:** `datamodel: 'quickjs'`, the sandbox for charts you do
  not trust, is in the same module: a page whose policy forbids
  `'unsafe-eval'` uses it.

## Documentation

The guides are shared with `@tinyactors/node`:

- [In the browser](https://github.com/tinyactors-dev/tinyactors-napi/blob/main/docs/guide/browser.md):
  what differs here (loading, the CSP, bytes as `Uint8Array`, Workers,
  IndexedDB, memory) and what a browser asks of you.
- [@tinyactors/node's README](https://github.com/tinyactors-dev/tinyactors-napi#readme):
  the concepts, from a first chart to hosts, actors, I/O processors and
  errors.
- [The guides](https://github.com/tinyactors-dev/tinyactors-napi/tree/main/docs/guide):
  charts, I/O processors, services, other systems, hibernation,
  migration, snapshots, telemetry, inspection, capacity and testing.

Charts are trusted code: their expressions run as JavaScript in a realm
of their own, which is not a security boundary.

MIT licensed.
