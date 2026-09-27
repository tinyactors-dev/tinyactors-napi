#pragma once
/*
 * JavaScript values as core's ta_value (ADR 0011).
 *
 * Core keeps values long after the call that produced them, but a
 * napi_value lives only in its handle scope. So each value core keeps is a
 * ta_value that this module can turn back into JavaScript:
 *
 * - Model A (ADR 0011 point 2): a box holds one strong napi_ref and a native
 *   reference count. retain and release touch only the count; the last
 *   release deletes the reference and gives the record back to the system's
 *   box free list (ADR 0014). Box records count against the "values" memory
 *   category.
 * - Primitives ride inline (ADR 0011 point 5): a number is its IEEE bits in
 *   `self`, and undefined, null, true and false are vtables with a null
 *   `self`. Their retain and release do nothing.
 * - Strings are boxed, and a box caches the UTF-8 text core borrows through
 *   the data model's value_text.
 *
 * Every access goes through make, get and the vtable's retain and release,
 * so a handle table (model B) can replace boxes without changing a caller.
 * Building with TNA_VALUES_TABLE defined (TNA_VALUES_MODEL=table in the
 * build's environment) selects model B, for the measurement ADR 0011 asks
 * for: a box is then an index into one JavaScript array per system, held by
 * one napi_ref, and freed indices are reused.
 *
 * All boxes die before their system (ADR 0011 point 7): close() releases
 * every value core or a mailbox still holds, then frees the free list. A box
 * released after the environment was torn down only forgets its reference,
 * because the environment already freed it.
 */
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>

#include "allocator.h"
#include "containers.h"
#include "tinyactors.h"

typedef struct tna_values {
    napi_env env;
    ta_allocator allocator;  /* the system allocator's "values" lane */
    tna_free_list boxes;
    const bool *torn_down;   /* the environment's cleanup hook has run */
    uint64_t *env_live;      /* boxes live in the whole environment */
    uint64_t live;           /* boxes live in this system */
    uint64_t made;           /* boxes made, for tests */
#ifdef TNA_VALUES_TABLE
    napi_ref table;          /* model B: the handle table, a JavaScript array */
    tna_vec free_indices;    /* model B: indices to reuse */
    uint32_t table_length;
#endif
    uint32_t number_next;    /* the next number-text buffer */
    char number_texts[16][32];
} tna_values;

#define TNA_NUMBER_TEXTS 16u

/* False when model B cannot make its table. */
bool tna_values_init(tna_values *values, napi_env env, tna_allocator *allocator);
/* Frees the free list. Boxes still live are leaks, and stay counted. */
void tna_values_close(tna_values *values);

/*
 * A ta_value holding `value`, with one reference the caller owns. A
 * primitive rides inline; anything else is boxed. False when the box cannot
 * be allocated or the reference cannot be made.
 */
bool tna_value_make(tna_values *values, napi_value value, ta_value *out);
/*
 * The JavaScript value of `value`. An absent value (null vtable) is
 * undefined. False for a value this module did not make (a foreign
 * ta_value).
 */
bool tna_value_get(napi_env env, const ta_value *value, napi_value *out);
/* True when this module made `value` (box or inline primitive). */
bool tna_value_ours(const ta_value *value);
/* True when `value` is absent: no data at all. */
bool tna_value_absent(const ta_value *value);
/*
 * The value as text, String(value), borrowed while `value` is retained
 * (the data model's value_text). A box caches its text. An inline
 * primitive's text is static, except a number's, which lives in a small
 * ring of buffers in `values`: it stays valid for the next
 * TNA_NUMBER_TEXTS - 1 calls, which covers core's use of it inside one
 * operation. TA_ERR_NOMEM when the text could not be copied, which changes
 * nothing but a box's cache, so the caller may answer TA_OP_NOMEM (core ADR
 * 0070); TA_ERR_INVALID when the value has no text (String() threw).
 */
ta_result tna_value_text(tna_values *values, const ta_value *value, ta_str *out);
