/* The native "ecmascript" datamodel's own declarations (AGENTS.md, "The
 * native "ecmascript" datamodel"): what its files share. Of core it calls
 * only ta_datamodel_environment_*, ta_image_*, ta_cbor_* and ta_table_*,
 * txml's txml_* for XML content, and the addon's own ta_napi_*
 * (tools/lint/rules/datamodel-calls-environment-and-node-api.yml).
 *
 * Where a chart evaluates: in the host's one shared node:vm context. Each
 * session is a scope object made by its chart's constructor, and each
 * expression is one function of the scope, compiled at its first
 * evaluation, sloppy outside (`with (scope)`) and strict inside. The
 * functions a chart-level <script> declares are the chart's helpers, made
 * once per chart on its scopes' prototype; a script's top-level vars are
 * the session's variables, and its let, const and class are refused (the
 * script's error.execution).
 *
 * The context runs the realm's script (realms.c, its "kit"): what is made
 * with the context's constructors (copies of values, scopes, _event, XML
 * nodes) and what a script declares are the kit's. */
#ifndef TA_NAPI_DATAMODEL_H
#define TA_NAPI_DATAMODEL_H

#include "../addon.h"

/* A chart's record, the JavaScript array its row references:
 *   [0] the constructor of its scopes;
 *   [1] per expression: its compiled function; null when it did not
 *       compile, a string (the refusal) for a script the datamodel refuses;
 *   [2] per location: the same for its setter;
 *   [3] the strings of its events' names, by the image's name id;
 *   [4], [5] the invoke ids and origins of the events from its invokes, by
 *       the invoke's slot;
 *   [6] per script: the head and tail its source is compiled between (the
 *       kit's `script`), or a string, the refusal; undefined for a script
 *       that does not parse. */
enum {
    TA_NAPI_CHART_SHAPE,
    TA_NAPI_CHART_GETTERS,
    TA_NAPI_CHART_SETTERS,
    TA_NAPI_CHART_NAMES,
    TA_NAPI_CHART_INVOKEIDS,
    TA_NAPI_CHART_ORIGINS,
    TA_NAPI_CHART_SCRIPTS,
    TA_NAPI_CHART_RECORD
};

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
/* ---- expressions.c ------------------------------------------------------------- */

/* One evaluation of a session: its scope and the functions it compiles
 * into, held for the entry (a handle scope is open). */
typedef struct ta_napi_evaluation {
    ta_napi_native *native;
    napi_env env;
    const ta_napi_chart_row *chart; /* a copy: an add may move the table */
    ta_napi_chart_row row;
    napi_value scope;   /* the with object */
    napi_value record;  /* the chart's record */
    napi_value kit;     /* the kit of the shared context */
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
