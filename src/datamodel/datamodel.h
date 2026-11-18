/* The native "ecmascript" datamodel's own declarations (AGENTS.md, "The
 * native "ecmascript" datamodel"): what its files share. Of core it calls
 * only ta_datamodel_environment_*, ta_image_*, ta_cbor_* and ta_table_*,
 * txml's txml_* for XML content, and the addon's own ta_napi_*
 * (tools/lint/rules/datamodel-calls-environment-and-node-api.yml).
 *
 * Where a chart evaluates (docs/plan.xml, decision d-declarations):
 *
 *   - a chart whose <script>s declare nothing at their top level runs in
 *     the host's one shared node:vm context: each session is a scope
 *     object made by the chart's constructor, and each expression is one
 *     function of the scope, compiled at its first evaluation, sloppy
 *     outside (`with (scope)`) and strict inside;
 *   - a chart whose scripts declare (var, function, let, const, class), as
 *     the engine says at chart_attach, gets a context per session, whose
 *     global object is the scope: a script runs there as global code, and
 *     closures over its names work.
 *
 * Every context runs the realm's script (realms.c, its "kit"): what is
 * made with that context's constructors (copies of values, scopes,
 * _event, XML nodes) is made by the kit's functions. */
#ifndef TA_NAPI_DATAMODEL_H
#define TA_NAPI_DATAMODEL_H

#include "../addon.h"

/* A chart's record, the JavaScript array its row references:
 *   [0] the constructor of its scopes (shared context), or undefined;
 *   [1] per expression: a shared chart's compiled function, a declaring
 *       chart's vm.Script (a script, or the function's source to run in
 *       each session's context); null when it did not compile;
 *   [2] per location: the same for its setter;
 *   [3] the strings of its events' names, by the image's name id;
 *   [4], [5] the invoke ids and origins of the events from its invokes, by
 *       the invoke's slot;
 *   [6] a declaring chart's scripts as the engine instantiates them without
 *       running a statement (`throw 0;` ahead), by expression: run in a
 *       woken session's new context, they make its function declarations
 *       again (undefined for a shared chart);
 *   [7] the names those scripts declare as functions (an array; undefined
 *       for a shared chart): hibernation leaves them out while they hold a
 *       function, since the wake makes them again. */
enum {
    TA_NAPI_CHART_SHAPE,
    TA_NAPI_CHART_GETTERS,
    TA_NAPI_CHART_SETTERS,
    TA_NAPI_CHART_NAMES,
    TA_NAPI_CHART_INVOKEIDS,
    TA_NAPI_CHART_ORIGINS,
    TA_NAPI_CHART_HOISTS,
    TA_NAPI_CHART_FUNCTIONS,
    TA_NAPI_CHART_RECORD
};

/* A session of a declaring chart: its row references the array
 * [context, kit, getters, setters], the functions made in its context.
 * A shared chart's session row references its scope itself. */
enum { TA_NAPI_OWN_CONTEXT, TA_NAPI_OWN_KIT, TA_NAPI_OWN_GETTERS, TA_NAPI_OWN_SETTERS, TA_NAPI_OWN_RECORD };

/* A chart row's flags: its scripts declare top-level names (a context per
 * session); some of them with let, const or class, which a new context
 * cannot be given again, so its sessions stay resident (serialize refuses). */
enum { TA_NAPI_CHART_DECLARES = 1u, TA_NAPI_CHART_LEXICAL = 2u };

/* ---- rows.c ------------------------------------------------------------------- */

/* The value of a reference (NULL when it is gone). */
napi_value ta_napi_native_get(ta_napi_native *native, napi_ref reference);
/* A row's reference dropped: deleted now while the host is freed, else its
 * value kept in the drops until the flush (dropping the last reference can
 * run JavaScript: AGENTS.md, "Rules the suite cannot see"). */
void ta_napi_native_drop(ta_napi_native *native, napi_ref reference);
/* A value held at a row's slot: element `handle`'s slot of the array
 * `*array` (one per table: `scopes`, `values`), made on first use. */
typedef struct ta_napi_slot {
    napi_ref *array;
    uint64_t handle;
} ta_napi_slot;
/* The value at the slot; NULL when there is none. */
napi_value ta_napi_slot_value(ta_napi_native *native, const ta_napi_slot *slot);
/* Holds `value` at the slot; false with an exception pending. */
bool ta_napi_slot_hold(ta_napi_native *native, const ta_napi_slot *slot, napi_value value);
/* The slot's value let go: kept in the drops until the flush, as a row's
 * reference is; nothing while the host is freed (the arrays go with the
 * datamodel). */
void ta_napi_slot_let_go(ta_napi_native *native, const ta_napi_slot *slot);
/* A new payload holding `value` (of the shared context) with one reference. */
ta_status ta_napi_native_add(ta_napi_native *native, napi_value value, ta_payload *out);
void ta_napi_native_retain(void *datamodel, ta_payload payload);
void ta_napi_native_release(void *datamodel, ta_payload payload);

/* ---- realms.c ----------------------------------------------------------------- */

/* A context's record, [context, kit]. */
enum { TA_NAPI_REALM_CONTEXT, TA_NAPI_REALM_KIT };

/* The shared context's record, made on first use; NULL with an exception
 * pending. */
napi_value ta_napi_realm_shared(ta_napi_native *native);
/* A new context and its kit: its record, or NULL with an exception
 * pending. Its Object.prototype joins the instance's `realms`. */
napi_value ta_napi_realm_new(ta_napi_native *native);
/* A kit's function `name` called with `argc` arguments; NULL with the
 * exception pending. */
typedef struct ta_napi_kit_call {
    const char *name;
    size_t argc;
    napi_value argv[3];
} ta_napi_kit_call;
napi_value ta_napi_kit(napi_env env, napi_value kit, const ta_napi_kit_call *call);
/* A vm.Script of `source`, named `<expr:index>`; NULL with the
 * SyntaxError pending. */
typedef struct ta_napi_script_of {
    ta_string_view prefix, source, suffix;
    uint32_t index;
} ta_napi_script_of;
napi_value ta_napi_script(ta_napi_native *native, const ta_napi_script_of *of);
/* script.runInContext(context): its value, or NULL with the exception
 * pending. */
napi_value ta_napi_run_in(napi_env env, napi_value script, napi_value context);
/* Whether a chart's scripts declare top-level names, asked of the engine
 * in a scratch context; false with an exception pending when it could not
 * be asked. For a declaring chart also: whether a declaration is lexical
 * (let, const, class: instantiating the script twice is a redeclaration),
 * the scripts that instantiate its declarations (`throw 0;` ahead, by
 * expression index), and the names they declare as functions. */
typedef struct ta_napi_chart_of {
    const ta_image *image;
    uint32_t chart;
    bool declares, lexical; /* out */
    napi_value hoists;      /* out: an array, or NULL */
    napi_value functions;   /* out: an array of names, or NULL */
} ta_napi_chart_of;
bool ta_napi_realm_declares(ta_napi_native *native, ta_napi_chart_of *chart);
/* A script whose source starts with a 'use strict' directive: a script in
 * executable content then runs as a strict block. */
bool ta_napi_strict_directive(ta_string_view source);
/* A declaring chart's declarations made in `context`, a woken session's
 * new one: each script of the chart's record (TA_NAPI_CHART_HOISTS) run
 * there, which instantiates it and runs no statement. False with an
 * exception pending when one did more. */
bool ta_napi_realm_hoist(ta_napi_native *native, napi_value record, napi_value context);

/* ---- expressions.c ------------------------------------------------------------- */

/* One evaluation of a session: its scope and the functions it compiles
 * into, held for the entry (a handle scope is open). */
typedef struct ta_napi_evaluation {
    ta_napi_native *native;
    napi_env env;
    const ta_napi_chart_row *chart; /* a copy: an add may move the table */
    ta_napi_chart_row row;
    napi_value scope;   /* the with object, or a declaring session's global */
    napi_value record;  /* the chart's record */
    napi_value own;     /* a declaring session's record, or NULL */
    napi_value kit;     /* the kit of the scope's context */
} ta_napi_evaluation;

/* The value of expression `e`, or NULL with its exception pending (a
 * syntax error included: that evaluation's error.execution). */
napi_value ta_napi_evaluate(ta_napi_evaluation *evaluation, ta_expression e);
/* `value` assigned to location `e`; false with an exception pending. The
 * location must start with one of the session's own names (SCXML: an
 * undeclared location, or a system variable, is error.execution). */
typedef struct ta_napi_assignment {
    ta_expression location;
    napi_value value;
} ta_napi_assignment;
bool ta_napi_assign(ta_napi_evaluation *evaluation, const ta_napi_assignment *assignment);
/* B.2's content: JSON if it parses, an XML document if it is XML, else
 * the text with its whitespace collapsed; made in the evaluation's context. */
napi_value ta_napi_content(ta_napi_evaluation *evaluation, ta_string_view text);
/* An expression's source, kind and position, from the chart's image. */
bool ta_napi_expression_of(const ta_napi_chart_row *chart, ta_expression e, ta_expression_info *info);

/* ---- dom.c --------------------------------------------------------------------- */

/* The XML document of `text`, made with the kit's XML nodes; NULL without
 * an exception when the text is not well-formed XML, NULL with one
 * pending when Node-API failed. */
typedef struct ta_napi_xml {
    ta_napi_native *native;
    napi_value kit;
    ta_string_view text;
} ta_napi_xml;
napi_value ta_napi_dom(const ta_napi_xml *xml);

#endif /* TA_NAPI_DATAMODEL_H */
