// The realm's script of the native "ecmascript" datamodel (AGENTS.md, "The
// native "ecmascript" datamodel"; src/datamodel/realms.c): run once in every
// node:vm context the datamodel makes (the host's one shared context), with
// In() as its argument. It returns the context's kit, the functions that
// make what must be made with that context's constructors: copies of values
// crossing between actors, the scopes of a chart (one constructor per
// chart, over a frozen prototype of null prototype holding the system
// variables and the chart's helpers), the system variables of a session,
// _event, and XML documents; and what a chart's scripts declare, asked of
// the engine (the binding parses no JavaScript). It runs in the
// application's realm too, once, for the copies the application reads and
// the compile call's advice. The build embeds it in the addon
// (mise/napi.rb); it is not shipped as a file.
(function tinyactorsRealm(In, Address) {
  'use strict';
  const LINK = Symbol('tinyactors.session');
  const XML = Symbol.for('tinyactors.xml');
  const SOURCE = Symbol.for('tinyactors.xml.source');
  const { create, defineProperty, freeze, getPrototypeOf, hasOwn, keys } = Object;
  const tag = Object.prototype.toString;
  const source = Function.prototype.toString;
  const isArray = Array.isArray;
  const isView = ArrayBuffer.isView;
  const Code = Function; // this context's: what it compiles is this context's

  // The errors copy throws for a value that cannot cross, by status: an
  // input refused with them throws a TinyactorsError of that status.
  const refusals = new WeakMap();
  function refuse(status, error) {
    refusals.set(error, status);
    return error;
  }

  function own(object, key, value) {
    defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
  }

  function plain(prototype) {
    if (prototype === null) return true;
    if (getPrototypeOf(prototype) !== null || !hasOwn(prototype, 'constructor')) return false;
    const made = prototype.constructor;
    return typeof made === 'function' && made.prototype === prototype && made.name === 'Object' &&
      source.call(made).includes('[native code]');
  }

  class XMLNode {
    constructor(nodeType, nodeName) {
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.childNodes = [];
      defineProperty(this, 'parentNode', { value: null, writable: true, configurable: true });
    }
    get firstChild() { return this.childNodes.length ? this.childNodes[0] : null; }
    get lastChild() { return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null; }
    get documentElement() {
      if (this.nodeType !== 9) return undefined;
      for (const child of this.childNodes) if (child.nodeType === 1) return child;
      return null;
    }
    get textContent() {
      if (this.nodeType === 3 || this.nodeType === 4) return this.nodeValue;
      let text = '';
      for (const child of this.childNodes) if (child.nodeType !== 8 && child.nodeType !== 7) text += child.textContent;
      return text;
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    getElementsByTagName(name) {
      const found = [];
      const pending = this.childNodes.slice().reverse();
      while (pending.length) {
        const node = pending.pop();
        if (node.nodeType !== 1) continue;
        if (name === '*' || node.nodeName === name || node.localName === name) found.push(node);
        for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
      }
      return found;
    }
    getAttribute(name) {
      return this.attributes !== undefined && hasOwn(this.attributes, name) ? this.attributes[name] : null;
    }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    // A document's text is the XML it was read from: what an <invoke>'s
    // content expression gives the system as the document to run.
    toString() { return this[SOURCE] !== undefined ? this[SOURCE] : Object.prototype.toString.call(this); }
    // As a neutral value (to_wire, JSON.stringify), a node is its XML text.
    toJSON() { return xmlText(this); }
  }
  defineProperty(XMLNode.prototype, XML, { value: true });

  // A node's XML: a document's the text it was read from, any other node's
  // written out.
  const escaped = (text, quote) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll(quote ? '"' : '\0', quote ? '&quot;' : '\0');
  function xmlText(node) {
    if (node[SOURCE] !== undefined) return node[SOURCE];
    const inner = () => node.childNodes.map(xmlText).join('');
    switch (node.nodeType) {
      case 1: {
        let text = '<' + node.nodeName;
        for (const key of keys(node.attributes ?? {})) text += ' ' + key + '="' + escaped(node.attributes[key], true) + '"';
        return node.childNodes.length ? text + '>' + inner() + '</' + node.nodeName + '>' : text + '/>';
      }
      case 3: return escaped(node.nodeValue ?? '', false);
      case 4: return '<![CDATA[' + node.nodeValue + ']]>';
      case 7: return '<?' + node.nodeName + ' ' + (node.nodeValue ?? '') + '?>';
      case 8: return '<!--' + (node.nodeValue ?? '') + '-->';
      default: return inner();
    }
  }

  // A node of the tree C read with txml: [nodeType, nodeName, text, attributes, children].
  function node(entry) {
    const [type, name, text, attributes, children] = entry;
    const made = new XMLNode(type, name);
    if (type === 1) {
      made.tagName = name;
      const colon = name.indexOf(':');
      made.localName = colon < 0 ? name : name.slice(colon + 1);
      made.attributes = {};
      for (const key of keys(attributes)) own(made.attributes, key, attributes[key]);
    } else if (text !== undefined) made.nodeValue = text;
    for (const child of children) made.appendChild(node(child));
    return made;
  }

  function dom(children, text) {
    const document = new XMLNode(9, '#document');
    defineProperty(document, SOURCE, { value: text });
    for (const child of children) document.appendChild(node(child));
    return document;
  }

  function copy(value, depth) {
    if (typeof value === 'symbol')
      throw refuse('unsupported', new TypeError('a value crossing between actors is a primitive, a plain object, ' +
        'an array, a Uint8Array or an XML node, not a symbol'));
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (depth >= 64) throw refuse('invalid', new RangeError('a value nested deeper than 64 (or a cycle) does not cross between actors'));
    if (isArray(value)) {
      const made = [];
      for (let i = 0; i < value.length; i++) made.push(copy(value[i], depth + 1));
      return made;
    }
    if (typeof value === 'object') {
      if (isView(value) && tag.call(value) === '[object Uint8Array]') return new Uint8Array(value);
      // an application's Address (decode gives them): a chart has no reference type, so its text
      if (Address !== undefined && value instanceof Address) return value.text;
      if (value[XML] === true) {
        const made = new XMLNode(value.nodeType, value.nodeName);
        if (value[SOURCE] !== undefined) defineProperty(made, SOURCE, { value: value[SOURCE] });
        for (const key of keys(value)) if (key !== 'childNodes') own(made, key, copy(value[key], depth + 1));
        for (const child of value.childNodes) made.appendChild(copy(child, depth + 1));
        return made;
      }
      if (plain(getPrototypeOf(value))) {
        const made = {};
        for (const key of keys(value)) own(made, key, copy(value[key], depth + 1));
        return made;
      }
    }
    throw refuse('unsupported', new TypeError('a value crossing between actors is a primitive, a plain object, ' +
      'an array, a Uint8Array or an XML node, not ' + tag.call(value)));
  }

  // A payload's value copied out to the application, in the realm this
  // script runs in (the application's own, for this): as copy, but an XML
  // node is its XML text.
  function exported(value, depth) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (depth >= 64) throw new RangeError('a value nested deeper than 64 (or a cycle)');
    if (isArray(value)) {
      const made = [];
      for (let i = 0; i < value.length; i++) made.push(exported(value[i], depth + 1));
      return made;
    }
    if (typeof value === 'object') {
      if (isView(value) && tag.call(value) === '[object Uint8Array]') return new Uint8Array(value);
      if (value[XML] === true) return xmlText(value);
      const made = {};
      for (const key of keys(value)) own(made, key, exported(value[key], depth + 1));
      return made;
    }
    return value; // a function: kept as it is, as the payload held it
  }

  // _ioprocessors, made at its first read and kept in the link: {type:
  // {location}}, with the short names the W3C tests use. The link holds
  // the processors core gave ([type, location] pairs), or undefined when
  // they are the context's template with this session's id (system below).
  let template; // [prefix of the first location, the processors of the session that made it]
  function ioprocessors(link) {
    if (link.io !== undefined && !isArray(link.io)) return link.io;
    let processors = link.io;
    if (processors === undefined) {
      processors = template[1].slice();
      processors[0] = [processors[0][0], template[0] + link.sessionid];
    }
    const io = {};
    for (const [type, location] of processors) {
      const entry = freeze({ location });
      own(io, type, entry);
      if (type.endsWith('#SCXMLEventProcessor')) own(io, 'scxml', entry);
      if (type.endsWith('#BasicHTTPEventProcessor')) own(io, 'basichttp', entry);
    }
    link.io = freeze(io);
    return link.io;
  }

  // The system variables of the scopes, read through the session's link.
  const variables = freeze(create(null, {
    _sessionid: { get() { return this[LINK].sessionid; }, enumerable: true },
    _name: { get() { return this[LINK].name; }, enumerable: true },
    _ioprocessors: { get() { return ioprocessors(this[LINK]); }, enumerable: true },
    In: { value: In, enumerable: true },
  }));

  // ---- what a script declares ----------------------------------------------

  // Whether `body` parses as a function body of this context, nothing run.
  function parses(body) {
    try {
      Code(body); // eslint-disable-line no-new-func
      return true;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }

  // What may be an identifier in a script's text: the candidates the
  // engine is asked about.
  const candidates = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/gu;
  const declaring = /\b(?:var|let|const|class|function)\b/;

  // The names a script declares at its top level, asked of the engine:
  // [functions, vars, lexicals] (let, const and class), each in the order
  // of the text; null when the script does not parse as the strict
  // function body the datamodel runs it as. A candidate is declared when
  // the script followed by `let <name>` does not parse, lexically when the
  // script followed by `var <name>` does not either; a declared var holds
  // a function before any statement runs when it is a function
  // declaration.
  function declarations(source) {
    const body = "'use strict';\n" + source;
    if (!parses(body)) return null;
    const functions = [], vars = [], lexicals = [];
    if (!declaring.test(source)) return [functions, vars, lexicals];
    const seen = new Set(), hoisted = [];
    for (const [name] of source.matchAll(candidates)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!parses("'use strict';let " + name + ';') || parses(body + '\n;let ' + name + ';')) continue;
      if (!parses(body + '\n;var ' + name + ';')) lexicals.push(name);
      else hoisted.push(name);
    }
    if (hoisted.length) {
      const kinds = Code("'use strict';return [" + hoisted.map((name) => 'typeof ' + name).join(',') + '];\n' + source)();
      for (let i = 0; i < hoisted.length; i++) (kinds[i] === 'function' ? functions : vars).push(hoisted[i]);
    }
    return [functions, vars, lexicals];
  }

  const advised = (name) => 'declare it with <data id="' + name + '"/> instead';

  // Why the native datamodel refuses a script: its first top-level let,
  // const or class declaration; undefined when it refuses none.
  function refusal(found) {
    if (found === null || !found[2].length) return undefined;
    return 'a <script> declares ' + found[2][0] + ' with let, const or class at its top level, which the native ' +
      '"ecmascript" datamodel refuses (the script is error.execution): ' + advised(found[2][0]);
  }

  // What the compile call warns of in a script: a refusal, or its first
  // top-level var, which the native datamodel makes a variable of the
  // session; null for neither.
  function advice(source) {
    const found = declarations(source);
    const refused = refusal(found);
    if (refused !== undefined) return refused;
    if (found === null || !found[1].length) return null;
    return 'a <script> declares var ' + found[1][0] + ' at its top level, which the native "ecmascript" datamodel ' +
      'makes a variable of the session: ' + advised(found[1][0]);
  }

  // A script as the datamodel runs it, a function of the session's scope:
  // [functions, vars, refusal, head, tail], the head and tail around its
  // source; null when it does not parse (its evaluation's SyntaxError). Its
  // top-level vars are the session's variables: read from the scope before
  // it runs and written back after, as global code would keep them.
  function script(source) {
    const found = declarations(source);
    if (found === null) return null;
    const [functions, vars] = found;
    let head = "(function(__s){with(__s){(function(){'use strict';", tail = '\n';
    if (vars.length) {
      head += vars.map((name) => name + '=__s.' + name + ';').join('') + 'try{';
      tail += '}finally{' + vars.map((name) => '__s.' + name + '=' + name + ';').join('') + '}';
    }
    return [functions, vars, refusal(found), head + '\n', tail + '})();}})'];
  }

  // A chart's constructor of scopes: the session's link, then every name the
  // chart declares, then _event, so every scope of the chart has one shape.
  // Its prototype holds the system variables and, when its chart-level
  // scripts declare functions, those: made once per chart from each
  // script's text ([source, function names] in `scripts`), no statement of
  // it run, so they close over this context's globals and nothing of a
  // session's.
  function shape(names, scripts) {
    const declared = [...new Set(names)];
    let prototype = variables;
    if (scripts.length) {
      const helpers = {};
      for (const [source, functions] of scripts) {
        const made = Code("'use strict';return {" + functions.join(',') + '};\n' + source)();
        for (const name of functions) helpers[name] = { value: made[name], enumerable: true };
      }
      prototype = freeze(create(variables, helpers));
    }
    function Scope(link) {
      this[LINK] = link;
      for (let i = 0; i < declared.length; i++) own(this, declared[i], undefined);
      defineProperty(this, '_event', { value: undefined, enumerable: true, configurable: true });
    }
    Scope.prototype = prototype;
    return Scope;
  }

  // A session's link: its system variables and its params until its first
  // event. What sessions of a context have in common is kept once: the name
  // of the session made before (a chart's sessions mostly share one), and
  // the processors as a template whose first location ends with the
  // session's id, so a session whose processors match it, text for text,
  // keeps nothing of them until it reads _ioprocessors.
  let lastName;
  function same(processors, sessionid) {
    if (template === undefined) {
      const first = processors.length ? processors[0][1] : undefined;
      if (typeof first !== 'string' || !first.endsWith(sessionid)) return false;
      template = [first.slice(0, first.length - sessionid.length), processors];
      return true;
    }
    const kept = template[1];
    if (kept.length !== processors.length || processors[0][1] !== template[0] + sessionid) return false;
    for (let i = 0; i < kept.length; i++)
      if (kept[i][0] !== processors[i][0] || (i > 0 && kept[i][1] !== processors[i][1])) return false;
    return true;
  }
  function system(sessionid, name, processors) {
    if (name === lastName) name = lastName;
    else lastName = name;
    return { sessionid, name, io: same(processors, sessionid) ? undefined : processors, init: undefined };
  }

  function event(fields) {
    const [name, type, sendid, origin, origintype, invokeid, data, raw] = fields;
    const made = { name, type, sendid, origin, origintype, invokeid, data };
    if (raw !== undefined) made.raw = raw;
    return freeze(made);
  }

  // A session's variables, what hibernation writes: [names, values], its
  // scope's own names but _event.
  function stored(target) {
    const found = [];
    const values = [];
    for (const name of keys(target)) {
      if (name === '_event') continue;
      found.push(name);
      values.push(target[name]);
    }
    return [found, values];
  }

  // A woken session's variables, `vars` of a hibernation blob (made in
  // another realm), copied into this context: the scope keeps the names its
  // chart declares.
  function restore(target, vars) {
    for (const name of keys(vars)) if (hasOwn(target, name)) target[name] = copy(vars[name], 0);
  }

  // A woken session migrated to a new version of its chart: the old
  // bindings, the blob's variables its link kept since the wake, taken
  // from it.
  function upgrade(target) {
    const link = target[LINK];
    const old = link.init;
    link.init = undefined;
    return old;
  }

  // A session's link as a host snapshot holds it: [sessionid, name, its I/O
  // processors as [type, location] pairs, init]. The processors are the
  // template's with this session's id, the pairs the link kept, or, once
  // _ioprocessors was read, its entries (an alias, `scxml` or `basichttp`,
  // is the same frozen entry as the type before it).
  function linked(target) {
    const link = target[LINK];
    let processors = link.io;
    if (processors === undefined) {
      processors = template[1].slice();
      processors[0] = [processors[0][0], template[0] + link.sessionid];
    } else if (!isArray(processors)) {
      const seen = new Set();
      const pairs = [];
      for (const type of keys(processors)) {
        const entry = processors[type];
        if (seen.has(entry)) continue;
        seen.add(entry);
        pairs.push([type, entry.location]);
      }
      processors = pairs;
    }
    return [link.sessionid, link.name, processors, link.init];
  }

  function record(names, values) {
    const made = {};
    for (let i = 0; i < names.length; i++) own(made, names[i], copy(values[i], 1));
    return made;
  }

  return freeze({
    LINK,
    objectPrototype: Object.prototype,
    copy: (value) => copy(value, 0),
    exported: (value) => exported(value, 0),
    refusal: (error) => refusals.get(error),
    shape,
    script,
    advice,
    system,
    event,
    record,
    stored,
    restore,
    upgrade,
    linked,
    dom,
    parse: (text) => JSON.parse(text),
  });
})
