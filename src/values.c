#include "values.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * One box: a strong reference (model A) or a handle-table index (model B),
 * and a native count (ADR 0011).
 */
typedef struct tna_box {
    tna_values *values;
#ifdef TNA_VALUES_TABLE
    uint32_t index;
#else
    napi_ref ref;
#endif
    uint32_t references;
    uint32_t text_length;
    char *text; /* value_text cache, from the values lane, or NULL */
} tna_box;

_Static_assert(sizeof(void *) >= sizeof(double), "inline numbers need 64-bit pointers");

/* ------------------------------------------------------------------------
 * Holding the JavaScript value: model A or model B.
 */

#ifdef TNA_VALUES_TABLE

static bool tna_hold(tna_values *values, napi_value value, tna_box *box) {
    napi_value table = NULL;
    uint32_t index = values->table_length;
    if (values->free_indices.count > 0) {
        index = *(uint32_t *)tna_vec_at(&values->free_indices, values->free_indices.count - 1u);
    }
    if (napi_get_reference_value(values->env, values->table, &table) != napi_ok ||
        napi_set_element(values->env, table, index, value) != napi_ok) {
        return false;
    }
    if (index == values->table_length) {
        values->table_length += 1u;
    } else {
        values->free_indices.count -= 1u;
    }
    box->index = index;
    return true;
}

static bool tna_held(const tna_box *box, napi_value *out) {
    napi_value table = NULL;
    napi_env env = box->values->env;
    return napi_get_reference_value(env, box->values->table, &table) == napi_ok &&
           napi_get_element(env, table, box->index, out) == napi_ok;
}

static void tna_unhold(tna_box *box) {
    tna_values *values = box->values;
    if (*values->torn_down) {
        return;
    }
    napi_value table = NULL;
    napi_value undefined = NULL;
    if (napi_get_reference_value(values->env, values->table, &table) == napi_ok && table != NULL &&
        napi_get_undefined(values->env, &undefined) == napi_ok) {
        napi_set_element(values->env, table, box->index, undefined);
    }
    (void)tna_vec_push(&values->free_indices, &box->index);
}

#else

static bool tna_hold(tna_values *values, napi_value value, tna_box *box) {
    return napi_create_reference(values->env, value, 1, &box->ref) == napi_ok;
}

static bool tna_held(const tna_box *box, napi_value *out) {
    return box->ref != NULL && napi_get_reference_value(box->values->env, box->ref, out) == napi_ok && *out != NULL;
}

static void tna_unhold(tna_box *box) {
    if (box->ref != NULL && !*box->values->torn_down) {
        napi_delete_reference(box->values->env, box->ref);
    }
    box->ref = NULL;
}

#endif

static void tna_box_retain(void *self) {
    ((tna_box *)self)->references += 1u;
}

static void tna_box_release(void *self) {
    tna_box *box = self;
    if (--box->references != 0) {
        return;
    }
    tna_values *values = box->values;
    tna_unhold(box);
    if (box->text != NULL) {
        tna_free(values->allocator, &(ta_allocator_free_params){
                                        .ptr = box->text, .size = (size_t)box->text_length + 1u, .alignment = 1 });
    }
    box->text = NULL;
    values->live -= 1u;
    *values->env_live -= 1u;
    tna_free_list_give(&values->boxes, box);
}

static const ta_value_vtable tna_box_vtable = { tna_box_retain, tna_box_release };

/* Inline primitives: no retain, no release. */
static const ta_value_vtable tna_undefined_vtable = { NULL, NULL };
static const ta_value_vtable tna_null_vtable = { NULL, NULL };
static const ta_value_vtable tna_true_vtable = { NULL, NULL };
static const ta_value_vtable tna_false_vtable = { NULL, NULL };
static const ta_value_vtable tna_number_vtable = { NULL, NULL };

bool tna_values_init(tna_values *values, napi_env env, tna_allocator *allocator) {
    *values = (tna_values){ .env = env, .allocator = tna_allocator_for(allocator, TNA_MEMORY_VALUES) };
    tna_free_list_init(&values->boxes, values->allocator, TNA_LAYOUT(tna_box));
#ifdef TNA_VALUES_TABLE
    tna_vec_init(&values->free_indices, values->allocator, TNA_LAYOUT(uint32_t));
    napi_value table = NULL;
    return napi_create_array(env, &table) == napi_ok && napi_create_reference(env, table, 1, &values->table) == napi_ok;
#else
    return true;
#endif
}

void tna_values_close(tna_values *values) {
    tna_free_list_destroy(&values->boxes);
#ifdef TNA_VALUES_TABLE
    tna_vec_destroy(&values->free_indices);
    if (values->table != NULL && !*values->torn_down) {
        napi_delete_reference(values->env, values->table);
    }
    values->table = NULL;
#endif
}

bool tna_value_ours(const ta_value *value) {
    const ta_value_vtable *v = value->v;
    return v == &tna_box_vtable || v == &tna_undefined_vtable || v == &tna_null_vtable || v == &tna_true_vtable ||
           v == &tna_false_vtable || v == &tna_number_vtable;
}

bool tna_value_absent(const ta_value *value) {
    return value == NULL || value->v == NULL;
}

bool tna_value_make(tna_values *values, napi_value value, ta_value *out) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(values->env, value, &type) != napi_ok) {
        return false;
    }
    switch (type) {
    case napi_undefined:
        *out = (ta_value){ NULL, &tna_undefined_vtable };
        return true;
    case napi_null:
        *out = (ta_value){ NULL, &tna_null_vtable };
        return true;
    case napi_boolean: {
        bool flag = false;
        napi_get_value_bool(values->env, value, &flag);
        *out = (ta_value){ NULL, flag ? &tna_true_vtable : &tna_false_vtable };
        return true;
    }
    case napi_number: {
        double number = 0;
        uint64_t bits = 0;
        napi_get_value_double(values->env, value, &number);
        memcpy(&bits, &number, sizeof bits);
        *out = (ta_value){ (void *)(uintptr_t)bits, &tna_number_vtable };
        return true;
    }
    default:
        break;
    }
    tna_box *box = tna_free_list_take(&values->boxes);
    if (box == NULL) {
        return false;
    }
    *box = (tna_box){ .values = values, .references = 1u };
    if (!tna_hold(values, value, box)) {
        tna_free_list_give(&values->boxes, box);
        return false;
    }
    values->live += 1u;
    values->made += 1u;
    *values->env_live += 1u;
    *out = (ta_value){ box, &tna_box_vtable };
    return true;
}

bool tna_value_get(napi_env env, const ta_value *value, napi_value *out) {
    const ta_value_vtable *v = value == NULL ? NULL : value->v;
    if (v == NULL || v == &tna_undefined_vtable) {
        return napi_get_undefined(env, out) == napi_ok;
    }
    if (v == &tna_box_vtable) {
        (void)env;
        return tna_held(value->self, out);
    }
    if (v == &tna_null_vtable) {
        return napi_get_null(env, out) == napi_ok;
    }
    if (v == &tna_true_vtable || v == &tna_false_vtable) {
        return napi_get_boolean(env, v == &tna_true_vtable, out) == napi_ok;
    }
    if (v == &tna_number_vtable) {
        uint64_t bits = (uint64_t)(uintptr_t)value->self;
        double number = 0;
        memcpy(&number, &bits, sizeof number);
        return napi_create_double(env, number, out) == napi_ok;
    }
    return false;
}

static bool tna_static_text(const char *text, ta_str *out) {
    *out = (ta_str){ text, (uint32_t)strlen(text) };
    return true;
}

/* A number as JavaScript's String(number) writes it, for the common cases. */
static void tna_number_text(double number, char *buffer, size_t size) {
    if (isnan(number)) {
        snprintf(buffer, size, "NaN");
    } else if (isinf(number)) {
        snprintf(buffer, size, number < 0 ? "-Infinity" : "Infinity");
    } else if (number == 0) {
        snprintf(buffer, size, "0");
    } else if (floor(number) == number && fabs(number) < 1e21) {
        snprintf(buffer, size, "%.0f", number);
    } else {
        snprintf(buffer, size, "%.17g", number);
        /* Use the shortest text that reads back as the same number. */
        for (int precision = 1; precision <= 17; precision += 1) {
            char candidate[32];
            snprintf(candidate, sizeof candidate, "%.*g", precision, number);
            if (strtod(candidate, NULL) == number) {
                snprintf(buffer, size, "%s", candidate);
                break;
            }
        }
    }
}

ta_result tna_value_text(tna_values *values, const ta_value *value, ta_str *out) {
    const ta_value_vtable *v = value == NULL ? NULL : value->v;
    if (v == NULL || v == &tna_undefined_vtable) {
        return tna_static_text("undefined", out) ? TA_OK : TA_ERR_INVALID;
    }
    if (v == &tna_null_vtable) {
        return tna_static_text("null", out) ? TA_OK : TA_ERR_INVALID;
    }
    if (v == &tna_true_vtable || v == &tna_false_vtable) {
        return tna_static_text(v == &tna_true_vtable ? "true" : "false", out) ? TA_OK : TA_ERR_INVALID;
    }
    if (v == &tna_number_vtable) {
        uint64_t bits = (uint64_t)(uintptr_t)value->self;
        double number = 0;
        memcpy(&number, &bits, sizeof number);
        char *buffer = values->number_texts[values->number_next];
        values->number_next = (values->number_next + 1u) % TNA_NUMBER_TEXTS;
        tna_number_text(number, buffer, sizeof values->number_texts[0]);
        return tna_static_text(buffer, out) ? TA_OK : TA_ERR_INVALID;
    }
    if (v != &tna_box_vtable) {
        return TA_ERR_INVALID;
    }
    tna_box *box = value->self;
    if (box->text == NULL) {
        napi_env env = values->env;
        napi_value object = NULL;
        napi_value text = NULL;
        size_t length = 0;
        if (!tna_held(box, &object) || napi_coerce_to_string(env, object, &text) != napi_ok ||
            napi_get_value_string_utf8(env, text, NULL, 0, &length) != napi_ok || length > UINT32_MAX - 1u) {
            bool pending = false;
            napi_value ignored = NULL;
            if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
                napi_get_and_clear_last_exception(env, &ignored);
            }
            return TA_ERR_INVALID;
        }
        char *copy = tna_alloc(values->allocator, length + 1u, 1);
        if (copy == NULL) {
            return TA_ERR_NOMEM;
        }
        napi_get_value_string_utf8(env, text, copy, length + 1u, &length);
        box->text = copy;
        box->text_length = (uint32_t)length;
    }
    *out = (ta_str){ box->text, box->text_length };
    return TA_OK;
}
