#include "hooks.h"

ta_result tna_hook_actor_created(tna_system *system, ta_actor_id actor) {
    ta_result result = tna_sched_add(&system->sched, actor);
    if (result != TA_OK) {
        system->inside_core = true;
        (void)ta_actor_destroy(system->core, actor);
        system->inside_core = false;
        return result;
    }
    tna_system_want_turn(system);
    return TA_OK;
}

ta_result tna_hook_actor_removed(tna_system *system, ta_actor_id actor) {
    tna_sched_remove(&system->sched, actor, TNA_DEAD_DESTROYED);
    tna_system_want_turn(system); /* its mail is reported as dead letters */
    return TA_OK;
}

ta_result tna_hook_actor_unloaded(tna_system *system, ta_actor_id actor) {
    tna_sched_remove(&system->sched, actor, TNA_DEAD_UNLOADED);
    tna_system_want_turn(system);
    return TA_OK;
}

ta_result tna_hook_actor_activated(tna_system *system, const ta_actor_activate_replacement_params *params) {
    ta_result result = tna_sched_transfer(&system->sched, &(tna_sched_transfer_params){
                                                              .from = params->incumbent,
                                                              .to = params->replacement,
                                                          });
    if (result == TA_OK) {
        tna_system_want_turn(system);
    }
    return result;
}

ta_result tna_hook_actor_abandoned(tna_system *system, ta_actor_id actor) {
    /* Core abandoned the macrostep whatever the table knows; an actor the
     * table does not know has nothing to settle. */
    (void)tna_sched_abandoned(&system->sched, actor);
    tna_system_want_turn(system); /* the settlement, and mail it may take now */
    return TA_OK;
}
