// What the platform checks in a customer's upload before it compiles it,
// and how it fills the rule template. Nothing here runs the customer's
// code: the sandbox does that, later, with its limits.
//
// compileCharts checks an uploaded chart's XML, its structure and its
// JavaScript (with { warningsAsErrors: true } a syntax error refuses it).
// A template rule's `when` and `message` are checked here first, with the
// application's own engine (`new Function` parses a body and runs none of
// it), so that the customer reads an error about the field they wrote.

/** Escapes text for an XML attribute value or element content. */
export function escapeXML(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** The syntax error of `source` as JavaScript, or undefined: an
 * expression when `script` is false, a script's statements when true. */
export function syntaxError(source, script = false) {
  try {
    // Parsed, never called. The newline lets a trailing `//` comment end.
    new Function(script ? source : `return (${source}\n);`);
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return error.message;
    throw error;
  }
}

/** The `name` of the document's `<scxml>` element, or undefined. */
export function chartName(text) {
  const root = /<(?:[\w.-]+:)?scxml\b([^>]*)>/.exec(text);
  return root ? /\sname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(root[1])?.slice(1).find((v) => v !== undefined) : undefined;
}

/** The rule template with a customer's rule in it: `{{id}}`, `{{when}}`
 * and `{{message}}` replaced by the escaped text. The customer's text can
 * only ever be an attribute's value: it cannot close the attribute or add
 * markup. */
export function fillTemplate(template, { id, when, message }) {
  return template.replace(/\{\{(id|when|message)\}\}/g, (_, key) => escapeXML({ id, when, message }[key]));
}

/** A diagnostic as the compiler prints one. */
export const formatDiagnostic = ({ file, line, column, severity = 'error', message }) =>
  `${file}:${line}:${column}: ${severity}: ${message}`;
