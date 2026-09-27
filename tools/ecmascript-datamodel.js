'use strict';

// An example ECMAScript data model for SCXML documents (napi ADR 0019). It
// is not part of the package: it runs expression text with `new Function`,
// with the process's rights, which is a choice a user makes for documents
// they trust. For untrusted documents, compile with a sandbox instead (an
// interpreter compiled to WebAssembly, for example); `node:vm` is not a
// security boundary.
//
//   system.registerDatamodel('ecmascript', ecmascript);
//   system.define(xmlText, { format: 'scxml' });
//
// SCXML's ECMAScript data model (SCXML B.2) keeps data as variables, so an
// expression reads `count` for the data item `count`. Each compiled function
// runs its source inside `with (scope) with (this)`: `this` is the actor's
// data (napi's built-in model binds it), and `scope` holds SCXML's system
// variables, read from napi's evaluation context when first used:
//
//   _event        { name, type, sendid, origin, origintype, invokeid, data }
//   _sessionid    _name    _ioprocessors    In(stateID)

const ROLES = new Set(['value', 'condition', 'location', 'script']);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// SCXML's _event from napi's event: SCXML spells the fields in lowercase.
function scxmlEvent(event) {
  if (event === undefined) {
    return undefined;
  }
  return {
    name: event.name,
    type: event.type,
    sendid: event.sendID,
    origin: event.origin,
    origintype: event.originType,
    invokeid: event.invocationID,
    data: event.data,
  };
}

// SCXML compares system variables by identity (tests 326, 329: a copy taken
// earlier == the variable now), and napi builds a fresh object each call.
// So each actor's data keeps the last _event and _ioprocessors it saw, and
// hands out the same object while the event, or the processors, are the
// same.
const kept = new WeakMap(); // the actor's data -> { event, io }

function keptFor(data) {
  let entry = kept.get(data);
  if (entry === undefined) {
    entry = {};
    kept.set(data, entry);
  }
  return entry;
}

function sameEvent(data, event) {
  const key = [event.name, event.type, event.sendID, event.origin, event.originType, event.invocationID].join('\u0000');
  const entry = keptFor(data);
  if (entry.event === undefined || entry.event.key !== key || entry.event.data !== event.data) {
    entry.event = { key, data: event.data, value: scxmlEvent(event) };
  }
  return entry.event.value;
}

function sameProcessors(data, processors) {
  const key = JSON.stringify(processors);
  const entry = keptFor(data);
  if (entry.io === undefined || entry.io.key !== key) {
    entry.io = { key, value: processors };
  }
  return entry.io.value;
}

// The system variables of one call, each read only when an expression uses
// it. Assigning one is an error.execution (SCXML 5.10). Compiled code is
// not strict, where assigning to a getter is silently ignored, so each has
// a setter that throws.
function scope(context, data) {
  const readOnly = (name) => () => { throw new TypeError(`${name} is a system variable and cannot be assigned`); };
  return {
    get _event() {
      const event = context.event;
      return event === undefined ? undefined : sameEvent(data, event);
    },
    set _event(_) { readOnly('_event')(); },
    get _sessionid() { return String(context.sessionID); },
    set _sessionid(_) { readOnly('_sessionid')(); },
    get _name() { return context.name; },
    set _name(_) { readOnly('_name')(); },
    get _ioprocessors() { return sameProcessors(data, context.ioProcessors); },
    set _ioprocessors(_) { readOnly('_ioprocessors')(); },
    In(id) { return context.inState(id); },
  };
}

// `new Function` over `body`, run inside the scope and the data.
function scoped(body, ...names) {
  return new Function('__scope', ...names, `with (__scope) { with (this) { ${body} } }`);
}

// SCXML makes an expression that cannot be evaluated an error.execution
// when it runs (SCXML 5.9.2), not a refused document, so a syntax error is
// deferred to the call: the compiled function throws it.
function deferred(error, role) {
  const fail = () => { throw error; };
  return role === 'location' ? { get: fail, set: fail } : fail;
}

function compile(source, role) {
  if (!ROLES.has(role)) {
    throw new TypeError(`unknown role ${role}`);
  }
  try {
    return compileNow(source, role);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return deferred(error, role);
    }
    throw error;
  }
}

// The names a script declares at its top level with var, let, const or
// function. In SCXML they are the data model's variables (SCXML B.2), so
// they outlive the script; a `new Function` body keeps them local. This is
// a scan, not a parse: good enough for the example, not for every program.
const DECLARED = /(?:^|[;{}\n])\s*(?:(?:var|let|const)\s+([A-Za-z_$][\w$]*)|function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\()/g;

function declaredNames(source) {
  const names = new Set();
  for (const match of source.matchAll(DECLARED)) {
    names.add(match[1] ?? match[2]);
  }
  return [...names];
}

function compileNow(source, role) {
  if (role === 'script') {
    // After the script, each name it declared becomes data (this.name).
    const keep = declaredNames(source)
      .map((name) => `if (typeof ${name} !== 'undefined') this.${name} = ${name};`)
      .join('\n');
    const run = scoped(`${source}\n;${keep}`);
    return function script(context) { run.call(this, scope(context, this)); };
  }
  if (role !== 'location') {
    // An expression written as a statement (`new testobject();`) still is one.
    const expression = source.trim().replace(/;+$/, '');
    const run = scoped(`return (${expression}\n);`);
    return function expression(context) { return run.call(this, scope(context, this)); };
  }
  const location = source.trim();
  if (IDENTIFIER.test(location)) {
    // A data name: napi's own locations assign only declared names.
    return location;
  }
  const read = scoped(`return (${location});`);
  const write = scoped(`(${location}) = __value;`, '__value');
  return {
    get(context) { return read.call(this, scope(context, this)); },
    set(value, context) { write.call(this, scope(context, this), value); },
  };
}

module.exports = { ecmascript: { compile } };
