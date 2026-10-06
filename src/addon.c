/* Node's adapter: the shared binding uses the real synchronous Node-API. */
#include <node_api.h>

extern napi_value ta_js_init(napi_env environment, napi_value exports);
NAPI_MODULE(NODE_GYP_MODULE_NAME, ta_js_init)
