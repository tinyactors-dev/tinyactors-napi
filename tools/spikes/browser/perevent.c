#define _POSIX_C_SOURCE 199309L
/* Core's cost per event, one actor, the null datamodel, natively and in wasm. */
#include "tinyactors_runtime.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }
static ta_string_view sv(const char *s) { ta_string_view v = { s, (uint32_t)strlen(s) }; return v; }
int main(void) {
  const char *chart = "<scxml xmlns='http://www.w3.org/2005/07/scxml' datamodel='null' initial='a'>"
    "<state id='a'><transition event='go' target='b'/></state><state id='b'><transition event='go' target='a'/></state></scxml>";
  ta_compile_options options; memset(&options, 0, sizeof options); options.size = sizeof options; options.alloc = ta_runtime_malloc();
  ta_source source = { sv("bench.scxml"), sv(chart) };
  ta_source_list sources = { &source, 1 };
  ta_compile_result *result; if (ta_compile_charts(&options, sources, &result)) return 1;
  ta_string_view image = ta_compile_image(result);
  ta_bytes bytes = { (const uint8_t *)image.pointer, image.length };
  ta_image opened; if (ta_image_open(bytes, &opened)) return 2;
  ta_system_config config; memset(&config, 0, sizeof config); config.size = sizeof config; config.ticks_per_second = 1000; config.max_actors = 4; config.max_events = 64;
  config.tracing = TA_TRACING_DISABLED;
  ta_system_setup setup; memset(&setup, 0, sizeof setup); setup.image = &opened; setup.config = &config;
  ta_system *system; if (ta_runtime_system_new(&setup, &system)) return 3;
  ta_spawn spawn; memset(&spawn, 0, sizeof spawn); spawn.name = sv("bench"); spawn.traceparent = sv("");
  uint32_t actor; if (ta_system_spawn(system, &spawn, &actor)) return 4;
  ta_runtime_run(&system, 1000);
  const ta_effect *effects; ta_system_effects_ack(system, ta_system_effects(system, &effects));
  ta_event_in event; memset(&event, 0, sizeof event); event.size = sizeof event; event.target = actor; event.name = sv("go");
  for (int round = 0; round < 8; round++) {
    int n = 1000000; double t0 = now();
    for (int i = 0; i < n; i++) {
      if (ta_system_send(system, &event)) return 5;
      ta_runtime_run(&system, 1000);
      uint32_t k = ta_system_effects(system, &effects); if (k) ta_system_effects_ack(system, k);
    }
    printf("ns per event (send + run + take): %.1f\n", (now() - t0) / n);
  }
  ta_runtime_system_free(system); ta_compile_free(result);
  return 0;
}
