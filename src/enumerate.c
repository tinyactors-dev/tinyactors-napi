#include "enumerate.h"

#include <stddef.h>

typedef struct {
    tna_id_page *page;
} tna_id_visit;

/* Copies the visited actor's ID; the inspection itself is borrowed. */
static ta_result tna_visit_id(void *self, const ta_actor_inspection *inspection) {
    tna_id_visit *visit = self;
    tna_id_page *page = visit->page;
    uint32_t at = page->count * 2u;
    page->pairs[at] = ta_actor_id_slot(inspection->actor);
    page->pairs[at + 1u] = ta_actor_id_generation(inspection->actor);
    page->count += 1u;
    return TA_OK;
}

ta_result tna_enumerate_ids(tna_system *system, tna_id_page *page) {
    if (system == NULL || page == NULL || page->limit == 0 || page->pairs == NULL) {
        return TA_ERR_INVALID;
    }
    page->count = 0;
    page->next = page->from;
    if (system->inside_core) {
        return TA_ERR_BUSY;
    }
    tna_id_visit visit = { .page = page };
    system->inside_core = true;
    ta_result result = ta_system_visit_actors(
        system->core, &(ta_actor_visit_params){
                          .inspector = { .self = &visit, .visit = tna_visit_id },
                          .from = page->from,
                          .limit = page->limit,
                          .next = &page->next,
                      });
    system->inside_core = false;
    return result;
}
