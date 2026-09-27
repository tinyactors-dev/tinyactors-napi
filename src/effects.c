#include "effects.h"

#include <string.h>

void tna_effects_init(tna_effects *effects, ta_arena *arena) {
    *effects = (tna_effects){ .arena = arena };
}

void tna_effect_release(tna_effect *effect) {
    if (effect->source.kind == TA_ACTOR_REF_NAMED) {
        ta_address_release(effect->source.as.named);
        effect->source = (ta_actor_ref){0};
    }
    ta_value_release(&effect->value);
    ta_value_release(&effect->target);
    ta_value_release(&effect->params);
    effect->value = (ta_value){0};
    effect->target = (ta_value){0};
    effect->params = (ta_value){0};
    if (effect->kind == TNA_EFFECT_INVOKE_FORWARD) {
        ta_event_release(&effect->forwarded);
        effect->forwarded = (ta_event){0};
    }
}

static bool tna_copy_bytes(ta_arena *arena, const uint8_t *ptr, uint32_t len, const uint8_t **out) {
    if (ptr == NULL || len == 0) {
        *out = ptr;
        return true;
    }
    uint8_t *copy = ta_arena_alloc(arena, len, 1);
    if (copy == NULL) {
        return false;
    }
    memcpy(copy, ptr, len);
    *out = copy;
    return true;
}

bool tna_effects_push(tna_effects *effects, const tna_effect *effect) {
    tna_effect *copy = effects->closed ? NULL : ta_arena_alloc(effects->arena, sizeof *copy, _Alignof(tna_effect));
    if (copy != NULL) {
        *copy = *effect;
        copy->next = NULL;
        const uint8_t *label = NULL;
        const uint8_t *content_type = NULL;
        const uint8_t *content = NULL;
        const uint8_t *target_text = NULL;
        bool copied =
            tna_copy_bytes(effects->arena, (const uint8_t *)effect->label.ptr, effect->label.len, &label) &&
            tna_copy_bytes(effects->arena, (const uint8_t *)effect->content_type.ptr, effect->content_type.len,
                           &content_type) &&
            tna_copy_bytes(effects->arena, effect->content.ptr, effect->content.len, &content) &&
            tna_copy_bytes(effects->arena, (const uint8_t *)effect->target_text.ptr, effect->target_text.len,
                           &target_text);
        if (copied) {
            copy->label.ptr = (const char *)label;
            copy->content_type.ptr = (const char *)content_type;
            copy->content.ptr = content;
            copy->target_text.ptr = (const char *)target_text;
            if (effects->last != NULL) {
                effects->last->next = copy;
            } else {
                effects->first = copy;
            }
            effects->last = copy;
            effects->count += 1u;
            return true;
        }
    }
    tna_effect dropped = *effect;
    tna_effect_release(&dropped);
    effects->dropped += 1u;
    return false;
}

tna_effect *tna_effects_pop(tna_effects *effects) {
    tna_effect *effect = effects->first;
    if (effect == NULL) {
        return NULL;
    }
    effects->first = effect->next;
    if (effects->first == NULL) {
        effects->last = NULL;
    }
    effects->count -= 1u;
    effect->next = NULL;
    return effect;
}

void tna_effects_close(tna_effects *effects) {
    effects->closed = true;
    tna_effect *effect = NULL;
    while ((effect = tna_effects_pop(effects)) != NULL) {
        tna_effect_release(effect);
    }
}
