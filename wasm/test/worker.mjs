// A module Worker: the same as the page (browser.mjs), its answer posted.
import { everything } from './browser.mjs';

everything().then((out) => postMessage({ out }), (error) => postMessage({ error: String(error?.stack ?? error) }));
