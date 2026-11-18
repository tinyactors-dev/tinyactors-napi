/* The boundary spike's module (docs/browser.md, "Measurements"). Build it beside
 * the spikes, not committed:
 *   zig cc -target wasm32-freestanding -O2 -nostdlib -Wl,--no-entry calls.c -o calls.wasm
 * with the root's pinned zig (mise which zig). perevent.c builds natively and
 * for wasm32-wasi against tinyactors-core/dist (the commands are in browser.md). */
#include <stdint.h>
__attribute__((import_module("env"), import_name("tick"))) extern uint32_t tick(uint32_t x);
__attribute__((export_name("add"))) uint32_t add(uint32_t a, uint32_t b) { return a + b; }
__attribute__((export_name("calls"))) uint32_t calls(uint32_t n) { uint32_t s = 0; for (uint32_t i = 0; i < n; i++) s += tick(i); return s; }
static unsigned char heap[1 << 16];
__attribute__((export_name("buf"))) unsigned char *buf(void) { return heap; }
__attribute__((export_name("grow"))) int grow(int pages) { return __builtin_wasm_memory_grow(0, pages); }
__attribute__((export_name("sum"))) uint32_t sum(uint32_t len) { uint32_t s = 0; for (uint32_t i = 0; i < len; i++) s += heap[i]; return s; }
