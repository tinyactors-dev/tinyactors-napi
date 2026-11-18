// The realms of the native "ecmascript" datamodel (docs/browser.md, "The
// native datamodel without node:vm"): where a host's charts evaluate, never
// the application's realm where the runtime gives another one.
//
//   node, bun   a node:vm context (process.getBuiltinModule), as the addon's;
//   a page      a hidden same-origin iframe, one per host, removed when the
//               host is freed (close(), or the FinalizationRegistry);
//   a Worker    the worker's own global: a Worker has no document, so an
//               application that wants its charts apart from its own code
//               gives tinyactors a worker of its own (the README says so).
//
// Every realm runs the realm's script (src/datamodel/realm.js, the addon's
// own, embedded as text by mise/wasm.rb into realm-script.mjs) for its
// kit: what must be made with that realm's constructors (copies of values,
// scopes, _event, XML nodes) is made by the kit's functions. The
// application's realm gets a kit of its own, for the values it reads.
//
// A realm is made at the host's first chart, not at its creation (an
// iframe costs about 600 KB and 3.6 ms in Chromium); the policy a page
// runs under is checked at the host's creation (policyRefusal), in this
// module's realm, whose policy an iframe inherits.
import { Address } from './address.mjs';
import realmScript from './realm-script.mjs';

const REALM_NAME = 'tinyactors:realm.js';

// The node:vm module where the runtime has one (node, bun), else null.
function nodeVM() {
  const getBuiltinModule = globalThis.process?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') return null;
  try {
    return getBuiltinModule('node:vm') ?? null;
  } catch {
    return null;
  }
}

// What kind of realm this runtime gives a host: 'vm', 'iframe' or 'global'.
export function realmKind() {
  if (nodeVM() !== null) return 'vm';
  if (typeof globalThis.document?.createElement === 'function') return 'iframe';
  return 'global';
}

// Why a host on the native datamodel cannot run here, or null: the native
// datamodel evaluates the charts' text, so it needs string evaluation
// (`'unsafe-eval'` in a Content Security Policy's script-src) and, on a
// page, an iframe of the page's own origin (a CSP or iframe `sandbox`
// without allow-same-origin gives the page an opaque origin); Trusted
// Types enforced (`require-trusted-types-for 'script'`) refuse a string to
// evaluate even with 'unsafe-eval'. In node and bun there is no policy.
export function policyRefusal() {
  if (nodeVM() !== null) return null;
  try {
    // eslint-disable-next-line no-new-func
    new Function('');
  } catch (error) {
    const text = String(error?.message ?? error);
    if (/trusted/i.test(text)) {
      return 'the page enforces Trusted Types (require-trusted-types-for \'script\'), which refuse the chart text ' +
        'the native datamodel evaluates: use datamodel "quickjs"';
    }
    return 'the page\'s Content Security Policy refuses string evaluation (its script-src has no \'unsafe-eval\'), ' +
      'which the native datamodel needs to evaluate the charts\' text: allow it, or use datamodel "quickjs"';
  }
  // a sandboxed page's opaque origin: its iframes are cross-origin to it
  // (spike, Chromium 141: reading the iframe's eval is a SecurityError)
  if (realmKind() === 'iframe' && globalThis.origin === 'null' && globalThis.location?.protocol !== 'file:') {
    return 'the page runs under a sandbox (CSP or iframe) without allow-same-origin: its opaque origin gives the ' +
      'native datamodel no realm of its own; use datamodel "quickjs"';
  }
  return null;
}

// The kit of this module's realm, the application's: made once.
let applicationKit = null;
export function application() {
  if (applicationKit === null) applicationKit = (0, eval)(realmScript)(() => false, Address);
  return applicationKit;
}

// A new realm for a host, with `In` (the evaluating session's In()) given to
// its kit: {kind, global, evaluate(source, name), Function, kit, free()}.
// `evaluate` runs `source` as the realm's global code and answers its
// value; `Function` is the realm's own constructor.
export function makeRealm(In) {
  const vm = nodeVM();
  let realm;
  if (vm !== null) {
    const context = vm.createContext();
    realm = {
      kind: 'vm',
      evaluate: (source, name) => vm.runInContext(source, context, { filename: name }),
      free() {},
    };
    realm.global = realm.evaluate('globalThis', REALM_NAME);
  } else if (realmKind() === 'iframe') {
    const frame = globalThis.document.createElement('iframe');
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('data-tinyactors', 'realm');
    (globalThis.document.body ?? globalThis.document.documentElement).appendChild(frame);
    const window = frame.contentWindow;
    realm = {
      kind: 'iframe',
      global: window,
      // the iframe's eval called as its method: indirect, its global code
      evaluate: (source) => window.eval(source),
      free() { frame.remove(); },
    };
  } else {
    realm = {
      kind: 'global',
      global: globalThis,
      evaluate: (source) => (0, eval)(source),
      free() {},
    };
  }
  realm.Function = realm.evaluate('Function', REALM_NAME);
  realm.kit = realm.evaluate(realmScript, REALM_NAME)(In, Address);
  return realm;
}
