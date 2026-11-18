// The realm's script of the native "ecmascript" datamodel (AGENTS.md, "The
// native "ecmascript" datamodel"; src/datamodel/realms.c): run once in every
// node:vm context the datamodel makes, the host's shared one and each
// declaring session's own, with In() as its argument. It returns the
// context's kit, the functions that make what must be made with that
// context's constructors: copies of values crossing between actors, the
// scopes of a chart (one constructor per chart, over a frozen prototype of
// null prototype holding the system variables), the system variables of a
// session, _event, and XML documents. The build embeds it in the addon
// (mise/napi.rb); it is not shipped as a file and never runs in the
// application's realm.
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
  const names = Object.getOwnPropertyNames;
  // The global's own names before any chart's: what a context starts with,
  // and the system variables a declaring session's context gets (declare).
  const baseline = new Set(names(globalThis));
  const systemNames = new Set(['_sessionid', '_name', '_ioprocessors', 'In', '_event']);
  const indirect = eval; // global code of this context, whatever a chart puts on its global
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

  // A chart's constructor of scopes: the session's link, then every name the
  // chart declares, then _event, so every scope of the chart has one shape.
  function shape(names) {
    const declared = names.slice();
    function Scope(link) {
      this[LINK] = link;
      for (let i = 0; i < declared.length; i++) own(this, declared[i], undefined);
      defineProperty(this, '_event', { value: undefined, enumerable: true, configurable: true });
    }
    Scope.prototype = variables;
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

  // A context of its own session: the names on its global object.
  function declare(names, link) {
    const global = globalThis;
    global[LINK] = link;
    for (const name of names) if (!hasOwn(global, name)) own(global, name, undefined);
    defineProperty(global, '_sessionid', { get() { return link.sessionid; }, enumerable: true });
    defineProperty(global, '_name', { get() { return link.name; }, enumerable: true });
    defineProperty(global, '_ioprocessors', { get() { return ioprocessors(link); }, enumerable: true });
    defineProperty(global, 'In', { value: In, enumerable: true });
    defineProperty(global, '_event', { value: undefined, enumerable: true, configurable: true });
    return global;
  }

  function event(fields) {
    const [name, type, sendid, origin, origintype, invokeid, data, raw] = fields;
    const made = { name, type, sendid, origin, origintype, invokeid, data };
    if (raw !== undefined) made.raw = raw;
    return freeze(made);
  }

  // A session's variables, what hibernation writes: [names, values]. A
  // shared chart's scope: its own names but _event. A declaring session's
  // global: the names its chart and scripts put there (var, function, an
  // implicit global); one in `remade` (a function declaration of the
  // chart's scripts) is left out while it holds a function, since the
  // wake makes it again from the scripts.
  // A global's binding is read by its name, not as the global object's
  // property: bun's vm context leaves that property stale after a function
  // writes the var (spike, bun 1.4.1, 2026-10-16: `total += k` in a
  // function, globalThis.total still the old value, `total` the new one).
  function stored(target, remade) {
    const found = [];
    const values = [];
    const global = target === globalThis;
    for (const name of global ? names(target) : keys(target)) {
      if (name === '_event' || (global && (baseline.has(name) || systemNames.has(name)))) continue;
      const value = global && identifier.test(name) ? indirect(name) : target[name];
      if (global && typeof value === 'function' && remade.includes(name)) continue;
      found.push(name);
      values.push(value);
    }
    return [found, values];
  }

  // A woken session's variables, `vars` of a hibernation blob (made in
  // another realm), copied into this context: a shared scope keeps the
  // names its chart declares; a declaring session's global takes them all,
  // and its link keeps the names its chart did not declare, which upgrade
  // drops should the blob be of another version.
  function restore(target, vars) {
    const added = [];
    for (const name of keys(vars)) {
      if (hasOwn(target, name)) target[name] = copy(vars[name], 0);
      else if (target === globalThis) {
        own(target, name, copy(vars[name], 0));
        added.push(name);
      }
    }
    if (added.length) target[LINK].added = added;
  }

  // A woken session migrated to a new version of its chart: the old
  // bindings, the blob's variables its link kept since the wake, taken
  // from it; on a declaring session's global the names the new chart did
  // not declare go.
  function upgrade(target) {
    const link = target[LINK];
    const old = link.init;
    link.init = undefined;
    if (link.added !== undefined) {
      for (const name of link.added) delete target[name];
      link.added = undefined;
    }
    return old;
  }

  // A session's link as a host snapshot holds it: [sessionid, name, its I/O
  // processors as [type, location] pairs, init, added]. The processors are
  // the template's with this session's id, the pairs the link kept, or,
  // once _ioprocessors was read, its entries (an alias, `scxml` or
  // `basichttp`, is the same frozen entry as the type before it).
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
    return [link.sessionid, link.name, processors, link.init, link.added];
  }

  // A restored session's link gets the names a snapshot recorded as added
  // (restore computed its own), or none.
  function relink(target, added) {
    target[LINK].added = isArray(added) ? added.slice() : undefined;
  }

  // In a scratch context after a chart's scripts were instantiated: the
  // names they declared as functions.
  function functions() {
    const found = [];
    for (const name of names(globalThis)) if (!baseline.has(name) && typeof globalThis[name] === 'function') found.push(name);
    return found;
  }

  // The global's names a chart's scripts made (globals), and the names
  // made again from them on a wake (remade): the functions they declare,
  // and the names a strict scratch context's global (`strict`, its
  // globals()) lacks: a sloppy block's function declarations (Annex B),
  // whose var a script in executable content fills each time it runs.
  function globals() {
    return names(globalThis).filter((name) => !baseline.has(name));
  }
  function remade(strict) {
    const kept = new Set(strict);
    const found = functions();
    for (const name of globals()) if (!kept.has(name) && !found.includes(name)) found.push(name);
    return found;
  }

  function record(names, values) {
    const made = {};
    for (let i = 0; i < names.length; i++) own(made, names[i], copy(values[i], 1));
    return made;
  }

  return freeze({
    LINK,
    global: globalThis,
    objectPrototype: Object.prototype,
    copy: (value) => copy(value, 0),
    exported: (value) => exported(value, 0),
    refusal: (error) => refusals.get(error),
    shape,
    system,
    declare,
    event,
    record,
    stored,
    restore,
    upgrade,
    linked,
    relink,
    functions,
    globals,
    remade,
    dom,
    parse: (text) => JSON.parse(text),
  });
})
