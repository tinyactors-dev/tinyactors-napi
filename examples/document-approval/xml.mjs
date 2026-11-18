// A small XML reader for the archive's records: elements, attributes and
// text, the five predefined entities and numeric references. Enough for
// the metadata the document chart writes (charts/document.scxml,
// metadataXML()); not a general parser: no DTD, no namespaces, no
// processing instructions but the declaration, no CDATA.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name) => {
    if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    if (!(name in ENTITIES)) throw new SyntaxError(`unknown entity ${whole}`);
    return ENTITIES[name];
  });
}

/**
 * @typedef {{ name: string, attributes: Record<string, string>, children: XMLElement[], text: string }} XMLElement
 */

/** Parses `source` into its root element; throws a `SyntaxError` naming
 * the offset of what it cannot read. */
export function parseXML(source) {
  let at = 0;
  const fail = (what) => { throw new SyntaxError(`${what} at offset ${at}`); };
  const skipSpace = () => { while (at < source.length && /\s/.test(source[at])) at++; };
  const name = () => {
    const match = /^[A-Za-z_][\w.-]*/.exec(source.slice(at, at + 256));
    if (!match) fail('expected a name');
    at += match[0].length;
    return match[0];
  };

  const element = () => {
    if (source[at] !== '<') fail('expected <');
    at++;
    const node = { name: name(), attributes: {}, children: [], text: '' };
    for (;;) {
      skipSpace();
      if (source.startsWith('/>', at)) { at += 2; return node; }
      if (source[at] === '>') { at++; break; }
      const key = name();
      skipSpace();
      if (source[at] !== '=') fail('expected =');
      at++;
      skipSpace();
      const quote = source[at];
      if (quote !== '"' && quote !== "'") fail('expected a quoted value');
      const end = source.indexOf(quote, at + 1);
      if (end < 0) fail('unterminated attribute');
      if (key in node.attributes) fail(`attribute ${key} twice`);
      node.attributes[key] = unescape(source.slice(at + 1, end));
      at = end + 1;
    }
    for (;;) {
      const next = source.indexOf('<', at);
      if (next < 0) fail(`unclosed <${node.name}>`);
      node.text += unescape(source.slice(at, next));
      at = next;
      if (source.startsWith('</', at)) {
        at += 2;
        if (name() !== node.name) fail(`mismatched </...> for <${node.name}>`);
        skipSpace();
        if (source[at] !== '>') fail('expected >');
        at++;
        return node;
      }
      if (source.startsWith('<!--', at)) {
        const end = source.indexOf('-->', at);
        if (end < 0) fail('unterminated comment');
        at = end + 3;
        continue;
      }
      node.children.push(element());
    }
  };

  skipSpace();
  if (source.startsWith('<?xml', at)) {
    const end = source.indexOf('?>', at);
    if (end < 0) fail('unterminated declaration');
    at = end + 2;
    skipSpace();
  }
  const root = element();
  skipSpace();
  if (at !== source.length) fail('text after the root element');
  return root;
}

/** The archive's record of one approved document, read from its XML. */
export function readRecord(source) {
  const root = parseXML(source);
  if (root.name !== 'document') throw new SyntaxError(`expected <document>, got <${root.name}>`);
  const child = (name) => root.children.find((c) => c.name === name);
  const all = (name) => root.children.filter((c) => c.name === name);
  const amount = child('amount');
  return {
    docID: root.attributes.id,
    version: Number(root.attributes.version),
    title: child('title')?.text ?? '',
    author: child('author')?.text ?? '',
    amount: amount ? Number(amount.text) : 0,
    currency: amount?.attributes.currency,
    approvals: Object.fromEntries(all('approval').map((a) => [a.attributes.stage, { by: a.attributes.by, note: a.text }])),
    changes: all('changes').map((c) => ({ stage: c.attributes.stage, by: c.attributes.by, version: Number(c.attributes.version), note: c.text })),
    escalations: all('escalation').map((e) => ({ stage: e.attributes.stage, version: Number(e.attributes.version) })),
  };
}
