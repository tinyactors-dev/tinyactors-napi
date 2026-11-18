let fn = 'ok'; try { new Function('return 1')(); } catch (e) { fn = e.name; }
postMessage({ DOMParser: typeof DOMParser, document: typeof document, WebAssembly: typeof WebAssembly, setImmediate: typeof setImmediate, MessageChannel: typeof MessageChannel, newFunction: fn, ShadowRealm: typeof ShadowRealm });
