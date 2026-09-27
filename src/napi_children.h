#pragma once
/*
 * Child charts of the in-system SCXML invoker (napi ADRs 0021 and 0024,
 * core ADR 0077).
 *
 * A child chart is a definition like any other:
 * - when a chart is defined from SCXML, each <invoke> with an inline
 *   <scxml> in <content>, or a literal src its resolve(src) fetches, is
 *   compiled then and nested in the parent (tna_children_nest). The
 *   parent holds it; every invocation spawns it without compiling.
 * - at invoke time the invoker asks which definition to start: the nested
 *   one; a definition ID in `<content expr>` or `src` (builder charts); or
 *   chart text from `<content expr>` or `srcexpr`, compiled then. Text
 *   whose identity is live is answered by it (core ADR 0077), and a
 *   definition compiled for an invoke lives as long as its children.
 *
 * An unnamed child's family is its parent's family with "/invoke" added.
 * A definition keeps define()'s resolve(src) for its children, which
 * inherit it. JavaScript runs only in resolve(src) and a registered data
 * model's compile; neither may call core (ADR 0013).
 */
#include <node_api.h>
#include <stdint.h>

#include "containers.h"
#include "import.h"
#include "tinyactors.h"

typedef struct tna_napi_system tna_napi_system;

typedef struct {
    tna_vec resolvers; /* tna_child_resolver: define()'s resolve, per definition, until core frees it */
    /* The message of the last refused child chart, for the invoke's fault. */
    char failure[1024];
} tna_children;

void tna_children_init(tna_napi_system *wrapper);
/* Keeps `resolve` (a function) with `definition`, for its children's src. */
ta_result tna_children_keep_resolver(tna_napi_system *wrapper, ta_definition_id definition, napi_value resolve);
/*
 * Releases the resolve kept for `definition`, which core has freed (core ADR
 * 0079): a definition defined again by identity keeps one per define().
 */
void tna_children_forget(tna_napi_system *wrapper, ta_definition_id definition);
/*
 * After core's teardown: every kept resolve was released when core told of
 * its definition being freed.
 */
void tna_children_close(tna_napi_system *wrapper);

/*
 * Compiles and nests the child charts of `definition` and, in turn, of
 * theirs (core ADR 0077): each <invoke> of the SCXML type with a literal
 * <content>, or with a literal src when `resolve` is given. TA_OK, or
 * TA_ERR_INVALID or TA_ERR_UNSUPPORTED with `failure` saying which child
 * and why, TA_ERR_NOMEM. A JavaScript exception from resolve or a compiler
 * stays pending. On failure the caller retires `definition`, which frees
 * what was nested.
 */
ta_result tna_children_nest(tna_napi_system *wrapper, ta_definition_id definition, napi_value resolve,
                            tna_import_failure *failure);

/*
 * A ta_chart_src_resolver over a JavaScript resolve(src) function (core ADR
 * 0053). What resolve throws stays pending for the caller.
 */
typedef struct {
    napi_env env;
    napi_value resolve;
} tna_src_resolver;
ta_chart_src_resolver tna_src_resolver_adapter(tna_src_resolver *resolver);
