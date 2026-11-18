const r = {};
try { const b = await (await fetch('/calls.wasm')).arrayBuffer(); await WebAssembly.instantiate(b, { env: { tick: (x) => x } }); r.wasm = 'ok'; } catch (e) { r.wasm = e.name + ': ' + e.message; }
try { new Function('return 1')(); r.newFunction = 'ok'; } catch (e) { r.newFunction = e.name; }
const f = document.createElement('iframe'); document.body.appendChild(f);
try { f.contentWindow.eval('1'); r.iframeEval = 'ok'; } catch (e) { r.iframeEval = e.name; }
try { new f.contentWindow.Function('return 1')(); r.iframeFunction = 'ok'; } catch (e) { r.iframeFunction = e.name; }
window.cspResult = r;
