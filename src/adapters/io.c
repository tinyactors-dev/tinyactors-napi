#include "io.h"

#include <string.h>

#include "../system.h"

struct tna_io_processor {
    tna_system *system;
    ta_atom type;
    uint32_t index;
    char *location;
    uint32_t location_length;
    char *origin;
    uint32_t origin_length;
};

static ta_op_status tna_io_send(void *self, const ta_send *send, ta_fault *fault) {
    tna_system *system = ((tna_io_processor *)self)->system;
    tna_effect effect = {
        .kind = TNA_EFFECT_IO,
        .source = send->source,
        .send_id = send->send_id,
        .event = send->event,
        .type = send->io_type,
        .value = send->data,
        .target = send->target,
        .target_text = send->target_text,
        .content_type = send->content_type,
        .content = send->content,
        .trace = send->trace,
    };
    if (effect.source.kind == TA_ACTOR_REF_NAMED) {
        ta_address_retain(effect.source.as.named);
    }
    ta_value_retain(&effect.value);
    ta_value_retain(&effect.target);
    if (!tna_system_effect(system, &effect)) {
        static const char message[] = "the I/O processor could not queue the send";
        *fault = (ta_fault){ .code = TA_ERR_NOMEM, .message = { .ptr = message, .len = sizeof message - 1u } };
        tna_system_wake_sender(system, &send->source);
        return TA_OP_ERROR;
    }
    if (system->dispatching_due) {
        tna_system_record_lateness(system, send->due, &send->trace); /* a timer to a processor fired */
    }
    return TA_OP_OK;
}

/* Decimal digits of `value` into `out` (at least 20 bytes); returns the count. */
static uint32_t tna_io_digits(uint64_t value, char *out) {
    char reversed[20];
    uint32_t count = 0;
    do {
        reversed[count++] = (char)('0' + value % 10u);
        value /= 10u;
    } while (value != 0);
    for (uint32_t index = 0; index < count; index += 1) {
        out[index] = reversed[count - 1u - index];
    }
    return count;
}

typedef struct {
    const ta_io_text_params *params;
    ta_actor_address address;
    bool named;
} tna_io_fill;

/* The value of one placeholder; false when the session has none. */
static bool tna_io_placeholder(const tna_io_fill *fill, const char *name, size_t length, ta_str *out, char *digits) {
    if (length == 7 && memcmp(name, "session", 7) == 0) {
        *out = (ta_str){ .ptr = digits, .len = tna_io_digits(fill->params->session_id, digits) };
        return true;
    }
    if (length == 5 && memcmp(name, "token", 5) == 0) {
        *out = (ta_str){ .ptr = digits, .len = tna_io_digits(fill->params->token, digits) };
        return true;
    }
    if (length == 6 && memcmp(name, "family", 6) == 0 && fill->named) {
        *out = fill->address.family.name;
        return true;
    }
    if (length == 4 && memcmp(name, "name", 4) == 0 && fill->named) {
        *out = fill->address.name;
        return true;
    }
    return false;
}

/* Writes the template into `out` (when not null) and returns its length; UINT32_MAX when unfillable. */
static uint32_t tna_io_expand(const tna_io_fill *fill, const char *template, uint32_t length, char *out) {
    uint32_t written = 0;
    for (uint32_t at = 0; at < length;) {
        const char *close = template[at] == '{' ? memchr(template + at, '}', length - at) : NULL;
        if (close == NULL) {
            if (out != NULL) {
                out[written] = template[at];
            }
            written += 1;
            at += 1;
            continue;
        }
        char digits[20];
        ta_str value = { 0 };
        if (!tna_io_placeholder(fill, template + at + 1, (size_t)(close - template - at - 1), &value, digits)) {
            return UINT32_MAX;
        }
        if (out != NULL && value.len != 0) {
            memcpy(out + written, value.ptr, value.len);
        }
        written += value.len;
        at = (uint32_t)(close - template) + 1u;
    }
    return written;
}

static ta_result tna_io_text(void *self, const ta_io_text_params *params) {
    const tna_io_processor *processor = self;
    const char *template = params->kind == TA_IO_TEXT_ORIGIN ? processor->origin : processor->location;
    uint32_t length = params->kind == TA_IO_TEXT_ORIGIN ? processor->origin_length : processor->location_length;
    if (template == NULL) {
        return TA_ERR_NOT_FOUND;
    }
    tna_io_fill fill = { .params = params, .named = params->address != NULL };
    if (fill.named) {
        fill.address = ta_address_view(params->address);
    }
    uint32_t size = tna_io_expand(&fill, template, length, NULL);
    if (size == UINT32_MAX) {
        return TA_ERR_NOT_FOUND;
    }
    char *text = params->arena.v->alloc(params->arena.self, size == 0 ? 1u : size, 1);
    if (text == NULL) {
        return TA_ERR_NOMEM;
    }
    (void)tna_io_expand(&fill, template, length, text);
    *params->out = (ta_str){ .ptr = text, .len = size };
    return TA_OK;
}

static const ta_io_vtable tna_io_vtable = { .send = tna_io_send, .text = tna_io_text };

static ta_allocator tna_io_allocator(tna_system *system) {
    return tna_allocator_for(&system->allocator, TNA_MEMORY_OTHER);
}

static void tna_io_free_text(tna_system *system, char *text, uint32_t length) {
    if (text != NULL) {
        tna_free(tna_io_allocator(system), &(ta_allocator_free_params){ .ptr = text, .size = length + 1u, .alignment = 1 });
    }
}

static bool tna_io_copy_text(tna_system *system, ta_str text, char **out, uint32_t *length) {
    *out = NULL;
    *length = 0;
    if (text.len == 0) {
        return true;
    }
    char *copy = tna_alloc(tna_io_allocator(system), text.len + 1u, 1);
    if (copy == NULL) {
        return false;
    }
    memcpy(copy, text.ptr, text.len);
    copy[text.len] = '\0';
    *out = copy;
    *length = text.len;
    return true;
}

static tna_io_processor *tna_io_find(const tna_system *system, ta_atom type) {
    for (uint32_t index = 0; index < system->io_processors.count; index += 1) {
        tna_io_processor *processor = *(tna_io_processor **)tna_vec_at(&system->io_processors, index);
        if (processor->type == type) {
            return processor;
        }
    }
    return NULL;
}

ta_result tna_io_register(tna_system *system, const tna_io_registration *registration) {
    tna_io_processor *processor = tna_io_find(system, registration->type);
    bool created = processor == NULL;
    if (created) {
        processor = tna_alloc(tna_io_allocator(system), sizeof *processor, _Alignof(tna_io_processor));
        if (processor == NULL) {
            return TA_ERR_NOMEM;
        }
        *processor = (tna_io_processor){ .system = system, .type = registration->type };
        if (tna_vec_push(&system->io_processors, &processor) != TA_OK) {
            tna_free(tna_io_allocator(system), &(ta_allocator_free_params){ .ptr = processor, .size = sizeof *processor,
                                                                           .alignment = _Alignof(tna_io_processor) });
            return TA_ERR_NOMEM;
        }
    }
    char *location = NULL;
    char *origin = NULL;
    uint32_t location_length = 0;
    uint32_t origin_length = 0;
    if (!tna_io_copy_text(system, registration->location, &location, &location_length) ||
        !tna_io_copy_text(system, registration->origin, &origin, &origin_length)) {
        tna_io_free_text(system, location, location_length);
        return TA_ERR_NOMEM;
    }
    ta_result result = ta_system_register_io(system->core, &(ta_io_registration_params){
                                                               .type = registration->type,
                                                               .io = { .self = processor, .v = &tna_io_vtable },
                                                               .index = &processor->index,
                                                           });
    if (result != TA_OK) {
        tna_io_free_text(system, location, location_length);
        tna_io_free_text(system, origin, origin_length);
        return result;
    }
    tna_io_free_text(system, processor->location, processor->location_length);
    tna_io_free_text(system, processor->origin, processor->origin_length);
    processor->location = location;
    processor->location_length = location_length;
    processor->origin = origin;
    processor->origin_length = origin_length;
    if (registration->index != NULL) {
        *registration->index = processor->index;
    }
    return TA_OK;
}

bool tna_io_renders_origins(const tna_system *system, uint32_t index) {
    for (uint32_t at = 0; at < system->io_processors.count; at += 1) {
        const tna_io_processor *processor = *(tna_io_processor **)tna_vec_at(&system->io_processors, at);
        if (processor->index == index) {
            return processor->origin != NULL;
        }
    }
    return false;
}

void tna_io_close(tna_system *system) {
    for (uint32_t index = 0; index < system->io_processors.count; index += 1) {
        tna_io_processor *processor = *(tna_io_processor **)tna_vec_at(&system->io_processors, index);
        tna_io_free_text(system, processor->location, processor->location_length);
        tna_io_free_text(system, processor->origin, processor->origin_length);
        tna_free(tna_io_allocator(system), &(ta_allocator_free_params){ .ptr = processor, .size = sizeof *processor,
                                                                       .alignment = _Alignof(tna_io_processor) });
    }
    tna_vec_destroy(&system->io_processors);
}
