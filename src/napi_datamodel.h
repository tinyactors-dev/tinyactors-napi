#pragma once
/*
 * The JavaScript data model (ADR 0011, docs/design.md), named "javascript".
 *
 * Expressions are JavaScript, not source text:
 * - a function is an expression: a condition, a value or a script. It is
 *   called with `this` bound to the actor's data root and one argument, the
 *   evaluation context;
 * - literal(value) is a constant (docs/design.md: a function in a value
 *   position is an expression, literal() stores one as data);
 * - an object with `get` and `set` functions is a location;
 * - source text is accepted in two forms only, so plain and exported specs
 *   stay readable: `In(state)` as a condition, and a data name (an
 *   identifier) as a value or a location. Anything else is refused when the
 *   chart is defined, naming the expression (core ADR 0058).
 *
 * Each JavaScript expression is a host expression (TA_EXPRESSION_HOST) whose
 * value is an expression record: one strong napi_ref and a count, retained
 * by the compiled definition and released with it.
 *
 * An actor's data is one JavaScript object, its root: the spawn binding when
 * one is given, otherwise a new object. <data> declarations and <foreach>
 * variables are its properties; assigning to a name the root does not have
 * is `error.execution`.
 *
 * The evaluation context is one object per system, built once. Its getters
 * read the core call in progress (data, event, sessionID, name,
 * ioProcessors, inState), and throw once that call has returned, so a
 * closure that keeps the context cannot read stale state.
 *
 * Every callback opens its own handle scope (ADR 0007), and an exception
 * becomes a fault whose data is the thrown value, which core turns into
 * error.execution. Callbacks run inside a core call, so JavaScript they
 * call cannot call core (the reentrancy guard, ADR 0013 point 4).
 */
#include <node_api.h>
#include <stdbool.h>

#include "tinyactors.h"

typedef struct tna_napi_system tna_napi_system;

typedef enum {
    TNA_EXPR_FUNCTION = 0, /* a condition, value or script */
    TNA_EXPR_LITERAL,      /* literal(value): a constant */
    TNA_EXPR_LOCATION      /* { get, set } */
} tna_expr_kind;

typedef struct tna_js_datamodel tna_js_datamodel;

/* At most this many data models registered per system (ADR 0019), and the
 * longest name one may have. */
#define TNA_DM_REGISTERED_MAX 8u
#define TNA_DM_NAME_MAX 32u

/*
 * One data model as core sees it: the built-in operations under a name. The
 * built-in model ("javascript") compiles nothing; a registered one (ADR 0019)
 * holds the user's compiler, and its prepare_definition turns every source
 * expression into a host expression by calling it. Every operation reaches
 * the one shared tna_js_datamodel through `dm`.
 */
typedef struct {
    tna_js_datamodel *dm;
    napi_ref compile; /* NULL for the built-in model */
    ta_datamodel_vtable vtable;
    char name[TNA_DM_NAME_MAX];
} tna_dm_adapter;

struct tna_js_datamodel {
    tna_napi_system *wrapper;
    napi_env env;
    napi_ref context;     /* the evaluation context object */
    napi_ref json_parse;  /* JSON.parse, for literal content */
    napi_ref array_from;  /* Array.from, for <foreach> snapshots */
    /* The call in progress: set around each callback, NULL between them. */
    const ta_dm_host *host;
    void *instance;
    napi_ref event;       /* the event object of the call, built on first use */
    /*
     * Core could not render a system variable during the call in progress.
     * The getter throws, and the call fails even if the chart's code
     * catches that exception, so no expression runs on a missing value.
     */
    bool text_failed;
    /* False while close runs from a finalizer, where no JavaScript may run. */
    bool js_usable;
    /*
     * The next compile uses this data model instead of core's null data
     * model; the compile resets it. The generated layer alone compiles
     * against the null data model.
     */
    bool select_javascript;
    tna_dm_adapter builtin;
    tna_dm_adapter registered[TNA_DM_REGISTERED_MAX];
    uint32_t registered_count;
    /* A compiler's refusal message, which core copies before it next calls
     * the data model (ta_expression_rejection). */
    char rejection[TA_COMPILE_ERROR_MESSAGE_MAX];
    /*
     * Offloading an unloaded actor (core ADR 0074): a value's bytes are its
     * serialization (`serialize`, v8.serialize) when it has one, or else a
     * handle to its value box, which stays alive with the offloaded actor.
     * `by_handle` keeps every value by handle. Handles are only taken while
     * an offload runs (`offloading`), into `handles`, which the offload
     * store then owns.
     */
    napi_ref serialize;
    napi_ref deserialize;
    bool by_handle;
    bool offloading;
    ta_value *handles;
    uint32_t handle_count;
    uint32_t handle_capacity;
};

/*
 * How values leave with an offloaded actor: `serialize` and `deserialize`
 * are v8.serialize and v8.deserialize (or the runtime's equivalent), and
 * `by_handle` keeps every value by handle instead.
 */
typedef struct {
    napi_value serialize;
    napi_value deserialize;
    bool by_handle;
} tna_offload_values;
bool tna_js_datamodel_set_offload(tna_js_datamodel *dm, const tna_offload_values *values);
/* Starts collecting the handles an offload keeps, and hands them over after. */
void tna_js_datamodel_offload_begin(tna_js_datamodel *dm);
typedef struct {
    ta_value *handles;
    uint32_t count;
} tna_offload_handles;
tna_offload_handles tna_js_datamodel_offload_end(tna_js_datamodel *dm);
/* Releases handles an offload collected and nobody took. */
void tna_js_datamodel_release_handles(tna_js_datamodel *dm, tna_offload_handles handles);

/* Builds the context object; false when it cannot be made. */
bool tna_js_datamodel_init(tna_js_datamodel *dm, tna_napi_system *wrapper, napi_env env);
void tna_js_datamodel_close(tna_js_datamodel *dm, bool refs_usable);
ta_datamodel tna_js_datamodel_adapter(tna_js_datamodel *dm);

/*
 * Registers `compile` as the compiler of a data model named `name` (ADR
 * 0019). TA_ERR_INVALID for "javascript", "null", a name already registered,
 * a name longer than TNA_DM_NAME_MAX - 1, or a full table.
 */
ta_result tna_js_datamodel_register(tna_js_datamodel *dm, ta_str name, napi_value compile);
/*
 * The data models an imported document may choose from, in the order
 * ta_definition_import takes them: "javascript" first (a document with no
 * `datamodel` attribute gets it), then core's null data model, which only
 * `datamodel="null"` opts into, then every registered one. `out` has room
 * for 2 + TNA_DM_REGISTERED_MAX.
 */
uint32_t tna_js_datamodel_choices(tna_js_datamodel *dm, ta_datamodel *out);

/*
 * A host expression for `value` of `kind`, with one reference the caller
 * owns: release it with tna_expression_release().
 */
bool tna_expression_make(tna_js_datamodel *dm, napi_value value, tna_expr_kind kind, ta_expression *out);
void tna_expression_release(ta_expression *expression);
/*
 * The JavaScript value of a host expression this module made (the function,
 * the literal() object or the location object), or NULL.
 */
napi_value tna_expression_value(napi_env env, const ta_expression *expression);
/* True for a literal() object: it carries the brand lib/statechart.js registers. */
bool tna_expression_is_literal(napi_env env, napi_value value);
