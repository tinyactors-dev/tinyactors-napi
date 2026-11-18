/* XML content as a tree record (SCXML B.2; the addon's src/datamodel/dom.c
 * in words): the text parsed with txml, allocating from the host's XML
 * arena above a mark taken for the parse, its tree written as words in
 * the same arena, which JavaScript reads and makes into the kit's XML
 * nodes, then ends (ta_web_xml_end) so the parse's blocks go and the
 * high-water mark stays for the next one. */
#include "web.h"

#include <txml.h>

/* ---- txml's allocator: the host's XML arena ---------------------------------------- */

static void *ta_web_txml_alloc(void *self, size_t size, size_t alignment) {
    ta_growable_arena *arena = (ta_growable_arena *)self;
    if (alignment <= 8) return ta_growable_arena_alloc(arena, size, alignment ? alignment : 1);
    unsigned char *block = (unsigned char *)ta_growable_arena_alloc(arena, size + alignment, 8);
    if (block == NULL) return NULL;
    return (void *)(((uintptr_t)block + alignment - 1) & ~(uintptr_t)(alignment - 1));
}

static void ta_web_txml_free(void *self, const txml_allocator_free_params *params) {
    (void)self; /* the parse's mark releases it */
    (void)params;
}

static const txml_allocator_vtable ta_web_txml_vtable = {ta_web_txml_alloc, ta_web_txml_free};

/* txml's input window: the addon's (docs/allocation.md, finding 8). */
enum { TA_WEB_TXML_STAGING = 4096 };

/* ---- the record ------------------------------------------------------------------- */

/* The words of the tree, in document order:
 *
 *   the document  [children]
 *   a node        [kind, prefix (2), name (2), text (2), attributes, children],
 *                 its attributes, then its children
 *   an attribute  [prefix (2), name (2), value (2)]
 *
 * kind is the DOM's nodeType: 1 an element, 3 text, 4 CDATA, 7 a
 * processing instruction, 8 a comment; the declaration and a DOCTYPE are
 * left out. Texts are views of the parse's memory, valid until
 * ta_web_xml_end. `word` NULL counts the words only. */
enum { TA_WEB_XML_NODE = 9, TA_WEB_XML_ATTRIBUTE = 6 };

typedef struct ta_web_tree {
    uint32_t *word;
    uint32_t at;
    const txml_doc *doc;
} ta_web_tree;

static void ta_web_put(ta_web_tree *tree, uint32_t value) {
    if (tree->word != NULL) tree->word[tree->at] = value;
    tree->at++;
}

static void ta_web_put_text(ta_web_tree *tree, txml_str text) {
    ta_web_put(tree, ta_web_address(text.ptr));
    ta_web_put(tree, text.ptr != NULL ? (uint32_t)text.length : 0);
}

static txml_str ta_web_local(const txml_doc *doc, uint32_t name) {
    txml_qname qname;
    if (txml_doc_name_at(doc, name, &qname) != TXML_OK) return (txml_str){"", 0};
    return qname.local;
}

static uint32_t ta_web_node_kind(txml_cursor cursor) {
    switch (txml_kind(cursor)) {
    case TXML_NODE_ELEMENT: return 1;
    case TXML_NODE_TEXT: return (txml_flags(cursor) & TXML_NODE_CDATA) != 0 ? 4 : 3;
    case TXML_NODE_PI: return 7;
    case TXML_NODE_COMMENT: return 8;
    default: return 0;
    }
}

static uint32_t ta_web_child_count(txml_cursor parent) {
    uint32_t count = 0;
    txml_cursor cursor = parent;
    for (txml_move moved = txml_first_child(&cursor); moved == TXML_MOVED; moved = txml_next_sibling(&cursor))
        if (ta_web_node_kind(cursor) != 0) count++;
    return count;
}

static void ta_web_children(ta_web_tree *tree, txml_cursor parent);

/* One node and what it holds (an element nests at most txml's max_depth
 * deep, so the recursion is bounded). */
static void ta_web_node(ta_web_tree *tree, txml_cursor cursor) {
    uint32_t kind = ta_web_node_kind(cursor);
    txml_str none = {"", 0};
    ta_web_put(tree, kind);
    if (kind == 1) {
        ta_web_put_text(tree, txml_node_prefix(cursor));
        ta_web_put_text(tree, ta_web_local(tree->doc, txml_node_name_id(cursor)));
        ta_web_put_text(tree, none);
    } else {
        ta_web_put_text(tree, none);
        ta_web_put_text(tree, kind == 7 ? ta_web_local(tree->doc, txml_node_name_id(cursor)) : none);
        ta_web_put_text(tree, txml_node_text(cursor));
    }
    uint32_t attributes = 0;
    txml_attr_cursor attribute;
    if (kind == 1)
        for (txml_move moved = txml_first_attribute(cursor, &attribute); moved == TXML_MOVED; moved = txml_next_attribute(&attribute))
            attributes++;
    ta_web_put(tree, attributes);
    ta_web_put(tree, kind == 1 ? ta_web_child_count(cursor) : 0);
    if (kind != 1) return;
    for (txml_move moved = txml_first_attribute(cursor, &attribute); moved == TXML_MOVED; moved = txml_next_attribute(&attribute)) {
        txml_attribute_view view;
        if (txml_attribute_read(attribute, &view) != TXML_OK) view = (txml_attribute_view){0};
        ta_web_put_text(tree, view.prefix);
        ta_web_put_text(tree, ta_web_local(tree->doc, view.name));
        ta_web_put_text(tree, view.value);
    }
    ta_web_children(tree, cursor);
}

static void ta_web_children(ta_web_tree *tree, txml_cursor parent) {
    txml_cursor cursor = parent;
    for (txml_move moved = txml_first_child(&cursor); moved == TXML_MOVED; moved = txml_next_sibling(&cursor))
        if (ta_web_node_kind(cursor) != 0) ta_web_node(tree, cursor);
}

/* ---- a parse ------------------------------------------------------------------------ */

/* Parses the record's words 0-1 as an XML document: answers the tree's
 * words (above), 0 when it is not one or the allocator refused; the
 * record's word 0 is the status (TA_ERROR_INVALID: not a document;
 * TA_ERROR_STATE: a parse is open), word 1 the number of words. The tree
 * lives until ta_web_xml_end. */
TA_WEB_EXPORT uint32_t ta_web_xml_parse(ta_web_host *host) {
    uint32_t *word = host->env->record.word;
    ta_bytes text = ta_web_bytes_at(word, 0);
    word[1] = 0;
    if (host->xml_open) {
        word[0] = (uint32_t)TA_ERROR_STATE;
        return 0;
    }
    ta_growable_arena *arena = &host->xml;
    host->xml_mark = ta_growable_arena_position(arena);
    host->xml_open = true;
    txml_parser_config config = {{(void *)arena, &ta_web_txml_vtable}, TXML_LIMITS_DEFAULT, TA_WEB_TXML_STAGING, 0, 0};
    txml_parser *parser = NULL;
    if (txml_parser_init(&parser, &config) != TXML_OK) {
        ta_growable_arena_release(arena, host->xml_mark);
        host->xml_open = false;
        word[0] = (uint32_t)TA_ERROR_NO_MEMORY;
        return 0;
    }
    host->xml_parser = parser;
    uint32_t fed = 0;
    txml_step step = TXML_STEP_NEED_INPUT;
    for (int rounds = 0; rounds < 1 << 20; rounds++) {
        if (step == TXML_STEP_NEED_INPUT) fed += txml_parse_feed(parser, (txml_bytes){(const uint8_t *)text.pointer + fed, (uint32_t)text.length - fed}, true);
        step = txml_parse_step(parser);
        if (step == TXML_STEP_DONE || step == TXML_STEP_FAILED || step == TXML_STEP_NEED_MEMORY) break;
        if (step == TXML_STEP_NEED_INPUT && fed == text.length) {
            step = TXML_STEP_FAILED; /* everything was given: it cannot end */
            break;
        }
    }
    uint32_t *words = NULL;
    word[0] = (uint32_t)(step == TXML_STEP_DONE ? TA_OK : step == TXML_STEP_NEED_MEMORY ? TA_ERROR_NO_MEMORY : TA_ERROR_INVALID);
    if (step == TXML_STEP_DONE) {
        const txml_doc *doc = txml_parser_doc(parser);
        txml_cursor root = txml_doc_root(doc);
        ta_web_tree tree = {NULL, 0, doc};
        ta_web_put(&tree, ta_web_child_count(root));
        ta_web_children(&tree, root);
        uint32_t count = tree.at;
        words = (uint32_t *)ta_growable_arena_alloc(arena, sizeof(uint32_t) * count, 8);
        if (words == NULL) {
            word[0] = (uint32_t)TA_ERROR_NO_MEMORY;
        } else {
            tree = (ta_web_tree){words, 0, doc};
            ta_web_put(&tree, ta_web_child_count(root));
            ta_web_children(&tree, root);
            word[1] = count;
        }
    }
    return ta_web_address(words); /* the tree's texts are the document's: the parser keeps it until the end */
}

/* The parse ends: the parser and its blocks go, the arena's high-water
 * mark stays (a warmed parse calls no allocator). */
TA_WEB_EXPORT void ta_web_xml_end(ta_web_host *host) {
    if (!host->xml_open) return;
    txml_parser_destroy((txml_parser *)host->xml_parser);
    host->xml_parser = NULL;
    ta_growable_arena_release(&host->xml, host->xml_mark);
    host->xml_open = false;
}
