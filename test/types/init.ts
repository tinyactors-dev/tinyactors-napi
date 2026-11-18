// @tinyactors/wasm/init (wasm/init.d.ts): the package's names and init(),
// which takes where the module is and settles when it is loaded.
import { Host, init, TinyactorsError } from '@tinyactors/wasm/init';

await init();
await init(new URL('https://example.com/tinyactors.wasm'));
await init('./tinyactors.wasm');
await init(fetch('/tinyactors.wasm'));
await init(new Uint8Array(8));
// @ts-expect-error: null is no module (WebAssembly.Module is an empty interface, so any object is one to tsc)
await init(null);
const host: Host = new Host({ systemID: 'init' });
host.close();
export const refused = (error: unknown): boolean => error instanceof TinyactorsError && error.status === 'TA_ERROR_STATE';
