/* XML content as a document (SCXML B.2; docs/plan.xml, decision d-dom):
 * the text parsed with txml, the project's XML library, compiled into the
 * addon (Node and Bun have no DOMParser), allocating from the datamodel's
 * scratch arena for the parse; its tree read with cursors into arrays of
 * [nodeType, nodeName, text, attributes, children], which the kit makes
 * into XML nodes of its context (realm.js, `dom`). The document is the
 * parser's for the call only. */
#include "datamodel.h"

#include <string.h>
#include <txml.h>

/* ---- txml's allocator: the datamodel's scratch arena ------------------------------ */

/* A parse's blocks live until the parse ends: they come from the
 * datamodel's scratch arena above a mark taken for the parse and released
 * after it, so frees are nothing and a warmed parse calls no allocator
 * (txml asks for about 1.7 MB in 13 blocks for a small document, freed
 * block by block before). A block of `alignment` above 8, which the arena
 * does not give, is a larger block aligned by hand. */
static void *ta_napi_txml_alloc(void *self, size_t size, size_t alignment) {
    ta_growable_arena *arena = (ta_growable_arena *)self;
    if (alignment <= 8) return ta_growable_arena_alloc(arena, size, alignment ? alignment : 1);
    unsigned char *block = (unsigned char *)ta_growable_arena_alloc(arena, size + alignment, 8);
    if (block == NULL) return NULL;
    return (void *)(((uintptr_t)block + alignment - 1) & ~(uintptr_t)(alignment - 1));
}

static void ta_napi_txml_free(void *self, const txml_allocator_free_params *params) {
    (void)self; /* the parse's mark releases it */
    (void)params;
}

static const txml_allocator_vtable ta_napi_txml_vtable = {ta_napi_txml_alloc, ta_napi_txml_free};

/* ---- the tree ---------------------------------------------------------------- */

static napi_value ta_napi_txml_string(napi_env env, txml_str text) {
    napi_value value = NULL;
    if (napi_create_string_utf8(env, text.ptr != NULL ? text.ptr : "", text.length, &value) != napi_ok) return NULL;
    return value;
}

/* A qualified name as written: prefix:local, or local. */
typedef struct ta_napi_qualified {
    const txml_doc *doc;
    uint32_t name;
    txml_str prefix;
} ta_napi_qualified;

static napi_value ta_napi_txml_name(napi_env env, const ta_napi_qualified *qualified) {
    txml_qname name;
    if (txml_doc_name_at(qualified->doc, qualified->name, &name) != TXML_OK) return NULL;
    napi_value local = ta_napi_txml_string(env, name.local), prefix, colon, result;
    if (local == NULL || qualified->prefix.length == 0) return local;
    if ((prefix = ta_napi_txml_string(env, qualified->prefix)) == NULL ||
        napi_create_string_utf8(env, ":", 1, &colon) != napi_ok)
        return NULL;
    /* prefix + ":" + local, joined by the engine */
    napi_value parts, join, separator;
    if (napi_create_array_with_length(env, 3, &parts) != napi_ok || napi_set_element(env, parts, 0, prefix) != napi_ok ||
        napi_set_element(env, parts, 1, colon) != napi_ok || napi_set_element(env, parts, 2, local) != napi_ok ||
        napi_get_named_property(env, parts, "join", &join) != napi_ok ||
        napi_create_string_utf8(env, "", 0, &separator) != napi_ok ||
        napi_call_function(env, parts, join, 1, &separator, &result) != napi_ok)
        return NULL;
    return result;
}

static napi_value ta_napi_txml_children(napi_env env, txml_cursor parent);

/* One node as [nodeType, nodeName, text, attributes, children], or
 * undefined for what the document leaves out (the declaration, a DOCTYPE). */
static napi_value ta_napi_txml_node(napi_env env, txml_cursor cursor) {
    napi_value entry, type, name = NULL, text = NULL, attributes = NULL, children = NULL, undefined;
    if (napi_get_undefined(env, &undefined) != napi_ok) return NULL;
    uint32_t kind = 0;
    switch (txml_kind(cursor)) {
    case TXML_NODE_ELEMENT: {
        kind = 1;
        name = ta_napi_txml_name(env, &(ta_napi_qualified){cursor.doc, txml_node_name_id(cursor), txml_node_prefix(cursor)});
        if (name == NULL || napi_create_object(env, &attributes) != napi_ok) return NULL;
        txml_attr_cursor attribute;
        for (txml_move moved = txml_first_attribute(cursor, &attribute); moved == TXML_MOVED;
             moved = txml_next_attribute(&attribute)) {
            txml_attribute_view view;
            if (txml_attribute_read(attribute, &view) != TXML_OK) continue;
            napi_property_descriptor property = {NULL, NULL, NULL, NULL, NULL, NULL,
                                                 napi_writable | napi_enumerable | napi_configurable, NULL};
            property.name = ta_napi_txml_name(env, &(ta_napi_qualified){cursor.doc, view.name, view.prefix});
            property.value = ta_napi_txml_string(env, view.value);
            if (property.name == NULL || property.value == NULL ||
                napi_define_properties(env, attributes, 1, &property) != napi_ok)
                return NULL;
        }
        children = ta_napi_txml_children(env, cursor);
        if (children == NULL) return NULL;
        break;
    }
    case TXML_NODE_TEXT: {
        bool cdata = (txml_flags(cursor) & TXML_NODE_CDATA) != 0;
        kind = cdata ? 4 : 3;
        name = ta_napi_txml_string(env, (txml_str){cdata ? "#cdata-section" : "#text", cdata ? 14u : 5u});
        text = ta_napi_txml_string(env, txml_node_text(cursor));
        break;
    }
    case TXML_NODE_COMMENT:
        kind = 8;
        name = ta_napi_txml_string(env, (txml_str){"#comment", 8});
        text = ta_napi_txml_string(env, txml_node_text(cursor));
        break;
    case TXML_NODE_PI:
        kind = 7;
        name = ta_napi_txml_name(env, &(ta_napi_qualified){cursor.doc, txml_node_name_id(cursor), {NULL, 0}});
        text = ta_napi_txml_string(env, txml_node_text(cursor));
        break;
    default: return undefined;
    }
    if (name == NULL || (kind != 1 && text == NULL)) return NULL;
    if (children == NULL && napi_create_array(env, &children) != napi_ok) return NULL;
    if (napi_create_uint32(env, kind, &type) != napi_ok || napi_create_array_with_length(env, 5, &entry) != napi_ok ||
        napi_set_element(env, entry, 0, type) != napi_ok || napi_set_element(env, entry, 1, name) != napi_ok ||
        napi_set_element(env, entry, 2, text != NULL ? text : undefined) != napi_ok ||
        napi_set_element(env, entry, 3, attributes != NULL ? attributes : undefined) != napi_ok ||
        napi_set_element(env, entry, 4, children) != napi_ok)
        return NULL;
    return entry;
}

/* The children of `parent`, in document order (an element nests at most
 * txml's max_depth deep, so this recursion is bounded). */
static napi_value ta_napi_txml_children(napi_env env, txml_cursor parent) {
    napi_value children;
    uint32_t count = 0;
    if (napi_create_array(env, &children) != napi_ok) return NULL;
    txml_cursor cursor = parent;
    for (txml_move moved = txml_first_child(&cursor); moved == TXML_MOVED; moved = txml_next_sibling(&cursor)) {
        napi_value entry = ta_napi_txml_node(env, cursor);
        napi_valuetype type = napi_undefined;
        if (entry == NULL || napi_typeof(env, entry, &type) != napi_ok) return NULL;
        if (type != napi_undefined && napi_set_element(env, children, count++, entry) != napi_ok) return NULL;
    }
    return children;
}

/* ---- a parse ---------------------------------------------------------------- */

/* txml's input window, fitted to what a chart's XML content is (a <data>
 * or an <assign> of a few hundred bytes) rather than txml's 64 KiB: a
 * larger document streams through it, and no limit changes. Its arenas'
 * chunk stays txml's default: a smaller one made a parse's high-water
 * 787 KB less (1.7 MB to 884 KB at 4096 B) but each parse slower, 14 % on
 * node and 27 % on bun at 4096 B (3 % and 12 % at 8192), since txml's
 * string pool directory has max_document_bytes / chunk entries, each set
 * at every parse (tinyxml/src/doc.c:663-672); the window saves 66 KB for
 * nothing (docs/allocation.md, finding 8). */
enum { TA_NAPI_TXML_STAGING = 4096 };

napi_value ta_napi_dom(const ta_napi_xml *xml) {
    napi_env env = xml->native->host->env;
    ta_growable_arena *arena = &xml->native->scratch;
    ta_growable_arena_mark mark = ta_growable_arena_position(arena);
    txml_parser_config config = {{(void *)arena, &ta_napi_txml_vtable}, TXML_LIMITS_DEFAULT, TA_NAPI_TXML_STAGING, 0, 0};
    txml_parser *parser = NULL;
    if (txml_parser_init(&parser, &config) != TXML_OK) {
        ta_napi_arena_release(arena, mark, TA_NAPI_ARENA_UNCAPPED);
        return NULL;
    }
    const uint8_t *bytes = (const uint8_t *)xml->text.pointer;
    uint32_t fed = 0;
    txml_step step = TXML_STEP_NEED_INPUT;
    for (int rounds = 0; rounds < 1 << 20; rounds++) {
        if (step == TXML_STEP_NEED_INPUT) {
            uint32_t taken = txml_parse_feed(parser, (txml_bytes){bytes + fed, xml->text.length - fed}, true);
            fed += taken;
        }
        step = txml_parse_step(parser);
        if (step == TXML_STEP_DONE || step == TXML_STEP_FAILED || step == TXML_STEP_NEED_MEMORY) break;
        if (step == TXML_STEP_NEED_INPUT && fed == xml->text.length) {
            step = TXML_STEP_FAILED; /* everything was given: it cannot end */
            break;
        }
    }
    napi_value document = NULL;
    if (step == TXML_STEP_DONE) {
        napi_value children = ta_napi_txml_children(env, txml_doc_root(txml_parser_doc(parser)));
        napi_value text = NULL;
        if (children != NULL && napi_create_string_utf8(env, xml->text.pointer, xml->text.length, &text) == napi_ok)
            document = ta_napi_kit(env, xml->kit, &(ta_napi_kit_call){"dom", 2, {children, text}});
    }
    txml_parser_destroy(parser);
    ta_napi_arena_release(arena, mark, TA_NAPI_ARENA_UNCAPPED); /* the tree is read: the parse's blocks end; its high-water kept */
    return document;
}
