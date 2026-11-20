// The "ecmascript" datamodel (docs/plan.xml, p1-datamodel; AGENTS.md, "The
// native "ecmascript" datamodel" and "Rules the suite cannot see"): what a
// chart sees, on the datamodel the test task names (both pass the same
// cases), and what only the native one has (its contexts, its realm, its
// copies). A chart reports through <log>, which the log handler collects.
import { Host, TinyactorsError } from '@tinyactors/node';
import { DATAMODEL, equal, hostWith, image, processor, scxml, status, throws } from './charts.mjs';
import { run, test } from './harness.mjs';

const NATIVE = { datamodel: 'native' };

/** A host on the datamodel under test running `charts`, its <log> lines
 * as `label: text`. */
function logging(charts, options = {}) {
  const lines = [];
  const host = hostWith(charts, { ...options, log: (entry) => lines.push(`${entry.label}: ${entry.text}`) });
  return { host, lines };
}

/** The lines of one actor of `chart` (named `c`), after `events`. */
async function lines(chart, events = [], { params, ...options } = {}) {
  const { host, lines: logged } = logging({ c: chart }, options);
  try {
    const session = host.spawn(host.chart('c'), params !== undefined ? { params } : undefined);
    await host.idle();
    for (const [event, data] of events) {
      host.send(session, event, data);
      await host.idle();
    }
    return logged;
  } finally {
    host.close();
  }
}

function same(actual, expected, what) {
  equal(JSON.stringify(actual), JSON.stringify(expected), what);
}

test('the scope refuses an undeclared assignment, a system variable and _event', async () => {
  const chart = scxml('c', `
    <datamodel><data id="v" expr="1"/></datamodel>
    <state id="s">
      <onentry>
        <raise event="bound"/>
      </onentry>
      <transition event="bound" target="t"/>
    </state>
    <state id="t">
      <onentry>
        <assign location="undeclared" expr="1"/>
        <log label="not here" expr="1"/>
      </onentry>
      <transition event="error.execution" target="u"><log label="undeclared" expr="typeof undeclared"/></transition>
    </state>
    <state id="u">
      <onentry><assign location="_sessionid" expr="'x'"/></onentry>
      <transition event="error.execution" target="w"><log label="sessionid" expr="_sessionid !== 'x'"/></transition>
    </state>
    <state id="w">
      <onentry><assign location="_event" expr="1"/></onentry>
      <transition event="error.execution" target="x"><log label="event" expr="_event.name"/></transition>
    </state>
    <state id="x">
      <onentry><script>undeclaredToo = 2</script></onentry>
      <transition event="error.execution" target="y"><log label="script" expr="typeof undeclaredToo"/></transition>
    </state>
    <state id="y">
      <onentry><script>_name = 'y'</script><assign location="v" expr="v + 1"/></onentry>
      <transition event="error.execution" target="z"><log label="name" expr="v"/></transition>
    </state>
    <final id="z"/>`);
  same(await lines(chart), ['undeclared: undefined', 'sessionid: true', 'event: error.execution', 'script: undefined', 'name: 1'],
    'each refusal an error.execution, the rest of its block skipped');
});

test('a syntax error is its own evaluation\'s error.execution: the chart\'s other expressions run', async () => {
  const chart = scxml('c', `
    <datamodel><data id="v" expr="2"/></datamodel>
    <state id="s">
      <transition cond="v ===" target="bad"/>
      <transition cond="v === 2" target="t"/>
    </state>
    <state id="t"><onentry><log label="v" expr="v * 21"/></onentry></state>
    <state id="bad"/>`);
  same(await lines(chart), ['v: 42'], 'the malformed condition false, the next one taken');
});

test('In() reads the session\'s configuration', async () => {
  const chart = scxml('c', `
    <parallel id="p">
      <state id="a"><state id="a1"><onentry><log label="in" expr="[In('a1'), In('b1'), In('nowhere'), In('p')].join()"/></onentry></state></state>
      <state id="b"><state id="b1"/></state>
    </parallel>`, { initial: 'p' });
  same(await lines(chart), ['in: true,false,false,true'], 'In()');
});

test('<foreach> declares its item and index, and walks the items it began with', async () => {
  const chart = scxml('c', `
    <datamodel><data id="list" expr="[1, 2, 3]"/><data id="sum" expr="0"/></datamodel>
    <state id="s">
      <onentry>
        <foreach array="list" item="item" index="index">
          <assign location="sum" expr="sum + item * 10 + index"/>
          <script>list.push(0)</script>
        </foreach>
        <log label="sum" expr="sum"/>
        <log label="declared" expr="[item, index, list.length].join()"/>
      </onentry>
    </state>`);
  same(await lines(chart), ['sum: 63', 'declared: 3,2,6'], 'three items, the pushed ones not walked');
});

test('a chart-level script\'s functions are the chart\'s helpers (W3C 452), its top-level var the session\'s', async () => {
  const chart = scxml('c', `
    <datamodel><data id="foo" expr="0"/></datamodel>
    <script>
      var count = 0;
      count = count + 5;
      function Thing() { this.bar = 0; }
      function twice(x) { return 2 * x; }
    </script>
    <state id="s">
      <onentry>
        <assign location="foo" expr="new Thing()"/>
        <assign location="foo.bar" expr="twice(3)"/>
        <script>count = twice(count + 1)</script>
        <log label="helpers" expr="[count, foo.bar, typeof Thing].join()"/>
      </onentry>
      <transition event="again"><script>count = twice(count)</script><log label="again" expr="count"/></transition>
    </state>`);
  same(await lines(chart, [['again']]), ['helpers: 12,6,function', 'again: 24'], 'one session');
  // the statements of a chart-level script run for each session; the helpers are the chart's
  const { host, lines: logged } = logging({ c: chart });
  const first = host.spawn(host.chart('c'));
  const second = host.spawn(host.chart('c'));
  await host.idle();
  host.send(first, 'again');
  await host.idle();
  host.send(second, 'again');
  await host.idle();
  host.close();
  same(logged, ['helpers: 12,6,function', 'helpers: 12,6,function', 'again: 24', 'again: 24'], 'two sessions, two counts');
});

test('a script\'s top-level var is a variable of the session, kept between its runs (W3C 303)', async () => {
  const chart = scxml('c', `
    <datamodel><data id="n" expr="0"/></datamodel>
    <state id="s">
      <transition event="go"><script>var n = n + 1;
        var seen = (typeof seen === 'number' ? seen : 0) + 1;</script><log label="n" expr="n + ' ' + seen"/></transition>
    </state>`);
  same(await lines(chart, [['go'], ['go'], ['go']]), ['n: 1 1', 'n: 2 2', 'n: 3 3'], 'three runs');
});

test('the native datamodel refuses a script\'s top-level let, const and class: error.execution, naming <data>', async () => {
  const chart = scxml('c', `
    <datamodel><data id="n" expr="0"/></datamodel>
    <script>const LIMIT = 2;</script>
    <state id="s">
      <transition event="go"><script>let k = n + 1; n = k;</script><log label="n" expr="n"/></transition>
      <transition event="class"><script>class K {}</script></transition>
      <transition event="block"><script>{ let k = n + 1; n = k; } for (const i of [1]) n += i;</script><log label="n" expr="n"/></transition>
      <transition event="error.execution"><log label="error" expr="_event.data.message.replace(/^Error: /, '')"/></transition>
    </state>`);
  const refusal = (name) => `error: a <script> declares ${name} with let, const or class at its top level, which the native ` +
    `"ecmascript" datamodel refuses (the script is error.execution): declare it with <data id="${name}"/> instead`;
  same(await lines(chart, [['go'], ['class'], ['block'], ['go']], NATIVE),
    [refusal('LIMIT'), refusal('k'), refusal('K'), 'n: 2', refusal('k')], 'each refused, a block\'s own declarations not');
});

test('the native datamodel: helpers see no session variable, and are their chart\'s alone', async () => {
  const one = scxml('one', `
    <datamodel><data id="n" expr="1"/></datamodel>
    <script>function whose() { return 'one'; } function reads() { return n; }</script>
    <state id="s">
      <onentry><log label="one" expr="whose() + ' ' + Object.keys(this ?? {}).length"/></onentry>
      <transition event="read"><log label="read" expr="reads()"/></transition>
      <transition event="error.execution"><log label="error" expr="_event.data.message"/></transition>
    </state>`);
  const two = scxml('two', `
    <script>function whose() { return 'two'; }</script>
    <state id="s"><onentry><log label="two" expr="whose()"/></onentry></state>`);
  const three = scxml('three', `
    <state id="s"><onentry><log label="three" expr="typeof whose"/></onentry></state>`);
  const { host, lines: logged } = logging({ one, two, three }, NATIVE);
  const session = host.spawn(host.chart('one'));
  host.spawn(host.chart('two'));
  host.spawn(host.chart('three'));
  await host.idle();
  host.send(session, 'read');
  await host.idle();
  host.close();
  same(logged, ['one: one 0', 'two: two', 'three: undefined', 'error: ReferenceError: n is not defined'], 'three charts');
});

test('the native datamodel: a function a script of executable content declares is that run\'s', async () => {
  const chart = scxml('c', `
    <datamodel><data id="n" expr="0"/></datamodel>
    <state id="s">
      <transition event="go"><script>function f() { return n + 1; } n = f();</script><log label="n" expr="n + ' ' + typeof f"/></transition>
    </state>`);
  same(await lines(chart, [['go'], ['go']], NATIVE), ['n: 1 undefined', 'n: 2 undefined'], 'sees the session, kept by none');
});

test('error.execution says why: the exception\'s text, or no data for a failure the host decides', async () => {
  const chart = scxml('c', `
    <state id="s">
      <transition event="go"><script>throw new Error('boom')</script></transition>
      <transition event="type"><send event="x" type="urn:nosuch"/></transition>
      <transition event="error.execution"><log label="why" expr="_event.data === undefined ? 'none' : _event.data.reason + ': ' + _event.data.message"/></transition>
    </state>`);
  same(await lines(chart, [['go'], ['type']]), ['why: exception: Error: boom', 'why: none'], 'a throw, an unknown type');
});

test('a chart that declares nothing: its sessions\' variables are their own', async () => {
  const chart = scxml('c', `
    <datamodel><data id="n" expr="0"/></datamodel>
    <state id="s"><transition event="inc"><assign location="n" expr="n + 1"/><log label="n" expr="_sessionid + ':' + n"/></transition></state>`);
  const { host, lines: logged } = logging({ c: chart });
  const a = host.spawn(host.chart('c'));
  const b = host.spawn(host.chart('c'));
  for (const session of [a, a, b]) host.send(session, 'inc');
  await host.idle();
  host.close();
  same(logged.sort(), [`n: ${a.id}:1`, `n: ${a.id}:2`, `n: ${b.id}:1`].sort(), 'counts per session');
});

test('the system variables are each session\'s own, _ioprocessors one object per session', async () => {
  const chart = scxml('c', `
    <state id="s"><onentry>
      <log label="sv" expr="JSON.stringify([_sessionid, _name, _ioprocessors, _ioprocessors === _ioprocessors, Object.isFrozen(_ioprocessors)])"/>
    </onentry></state>`);
  const { host, lines: logged } = logging({ c: chart }, { ioProcessors: { 'urn:out': processor(() => {}) } });
  const a = host.spawn(host.chart('c'));
  const b = host.spawn(host.chart('c'), { name: 'named' });
  const c = host.spawn(host.chart('c'));
  await host.idle();
  host.close();
  const seen = logged.map((line) => JSON.parse(line.slice('sv: '.length)));
  equal(seen.length, 3, 'three sessions');
  for (const [i, session] of [a, b, c].entries()) {
    const [sessionid, , processors, same, frozen] = seen.find(([id]) => id === String(session.id));
    equal(sessionid, String(session.id), `session ${i}: _sessionid`);
    const scxmlType = Object.keys(processors).find((type) => type.endsWith('#SCXMLEventProcessor'));
    equal(processors[scxmlType].location.endsWith(`#_scxml_${session.id}`), true, `session ${i}: its own location`);
    equal(processors.scxml.location, processors[scxmlType].location, `session ${i}: the short name`);
    equal('urn:out' in processors, true, `session ${i}: the config's processor`);
    equal(same, true, `session ${i}: one object`);
    if (DATAMODEL === 'native') equal(frozen, true, `session ${i}: frozen`); // quickjs's is not
  }
  equal(seen.find(([id]) => id === String(b.id))[1], 'named', 'the spawn\'s name');
});

test('XML content is a document: elements, attributes, text, and a copy of it in a send', async () => {
  const chart = scxml('c', `
    <datamodel>
      <data id="books"><books xmlns=""><book title="one"/><book title="two">Two &amp; more</book></books></data>
      <data id="json">{"a": [1, 2]}</data>
      <data id="text">  some   spaced
        text  </data>
    </datamodel>
    <state id="s">
      <onentry>
        <log label="titles" expr="books.getElementsByTagName('book').map(function (b) { return b.getAttribute('title'); }).join()"/>
        <log label="root" expr="books.documentElement.nodeName + ' ' + books.documentElement.childNodes.length"/>
        <log label="text" expr="books.getElementsByTagName('book')[1].textContent"/>
        <log label="missing" expr="books.getElementsByTagName('book')[0].getAttribute('nope')"/>
        <log label="json" expr="json.a[1]"/>
        <log label="string" expr="'[' + text + ']'"/>
        <send event="echo"><content expr="books"/></send>
      </onentry>
      <transition event="echo">
        <log label="copied" expr="_event.data !== books"/>
        <log label="received" expr="_event.data.getElementsByTagName('book')[1].getAttribute('title')"/>
      </transition>
    </state>`);
  same(await lines(chart), [
    'titles: one,two',
    'root: books 2',
    'text: Two & more',
    'missing: null',
    'json: 2',
    'string: [some spaced text]',
    `copied: ${DATAMODEL === 'native'}`, // quickjs shares values within its runtime; the native one copies
    'received: two',
  ], 'the document');
});

test('XML content larger than the parser\'s 4 KB input window is read whole', async () => {
  // txml reads a document through an input window (src/datamodel/dom.c:
  // 4096 B) that a larger one streams through
  const items = Array.from({ length: 600 }, (_, i) => `<b i="${i}">item ${i}</b>`).join('');
  const chart = scxml('c', `
    <datamodel><data id="big"><a xmlns="">${items}</a></data></datamodel>
    <state id="s">
      <onentry>
        <log label="count" expr="big.getElementsByTagName('b').length"/>
        <log label="last" expr="big.getElementsByTagName('b')[599].getAttribute('i') + ' ' + big.getElementsByTagName('b')[599].textContent"/>
      </onentry>
    </state>`);
  if (items.length < 3 * 4096) throw new Error(`the content is ${items.length} B`);
  same(await lines(chart), ['count: 600', 'last: 599 item 599'], 'the document');
});

test('the native datamodel: data from the application is the chart\'s own, of its realm, and a copy', async () => {
  const chart = scxml('c', `
    <state id="s">
      <transition event="go">
        <log label="realm" expr="[_event.data.list instanceof Array, _event.data instanceof Object, _event.data.bytes instanceof Uint8Array].join()"/>
        <script>_event.data.list.push(4)</script>
        <log label="pushed" expr="_event.data.list.length"/>
      </transition>
      <transition event="params"><log label="params" expr="[p instanceof Array, p.length].join()"/></transition>
    </state>`);
  const data = { list: [1, 2, 3], bytes: new Uint8Array([1]) };
  same(await lines(chart, [['go', data]], NATIVE), ['realm: true,true,true', 'pushed: 4'], 'arrays and objects of the chart\'s realm');
  equal(data.list.length, 3, 'the application\'s array untouched');
  const withParams = scxml('c', `
    <datamodel><data id="p" expr="null"/></datamodel>
    <state id="s"><onentry><log label="params" expr="[p instanceof Array, p.length].join()"/></onentry></state>`);
  same(await lines(withParams, [], { ...NATIVE, params: { p: [1, 2] } }), ['params: true,2'], 'spawn params override <data>');
});

test('the native datamodel: _event is frozen, kept until the next event, its data the payload\'s value', async () => {
  const chart = scxml('c', `
    <datamodel><data id="first" expr="null"/></datamodel>
    <state id="s">
      <transition event="one">
        <assign location="first" expr="_event"/>
        <script>_event.data.k = 2</script>
        <log label="frozen" expr="Object.isFrozen(_event) + ' ' + _event.data.k"/>
      </transition>
      <transition event="two"><log label="kept" expr="[first.name, _event.name, first === _event, _event.type, _event.sendid].join()"/></transition>
    </state>`);
  same(await lines(chart, [['one', { k: 1 }], ['two']], NATIVE), ['frozen: true 2', 'kept: one,two,false,external,'], '_event');
});

test('<log> of an object is its JSON; eval_string of a symbol is error.execution', async () => {
  const chart = scxml('c', `
    <datamodel><data id="o" expr="({a: 1, b: [true, null]})"/></datamodel>
    <state id="s">
      <onentry>
        <log label="json" expr="o"/>
        <log label="function" expr="(function named() {}).name"/>
        <send eventexpr="Symbol('x')" target="#_internal"/>
      </onentry>
      <transition event="error.execution"><log label="error" expr="_event.name"/></transition>
    </state>`);
  same(await lines(chart), ['json: {"a":1,"b":[true,null]}', 'function: named', 'error: error.execution'], 'log');
});

test('actor.context: each variable as a neutral value (to_wire)', async () => {
  const chart = scxml('c', `
    <datamodel>
      <data id="n" expr="2"/>
      <data id="nothing"/>
      <data id="mixed" expr="({a: undefined, b: [undefined, 1], f: function () {}, d: new Date(0)})"/>
    </datamodel>
    <state id="s"/>`);
  const host = hostWith({ c: chart });
  const session = host.spawn(host.chart('c'), { params: { n: 7 } });
  // asked before the first turn: no <data> is initialized, the params neither
  const before = await host.actorContext({ session });
  same(Object.keys(before.variables), ['n', 'nothing', 'mixed'], 'keys');
  equal(Object.values(before.variables).every((v) => v === undefined), true, 'every variable undefined before the first turn');
  let result;
  host.actorContext({ session }, (answer) => { result = answer; });
  await host.idle();
  host.close();
  same(result, { variables: { n: 7, mixed: { b: [null, 1], d: '1970-01-01T00:00:00.000Z' } } }, 'variables');
  equal('nothing' in result.variables && result.variables.nothing === undefined, true, 'undefined stays undefined, apart from null');
});

test('the native datamodel: a value that cannot cross is refused at the input, the Host included', async () => {
  const host = hostWith({ c: scxml('c', '<state id="s"/>') }, NATIVE);
  const session = host.spawn(host.chart('c'));
  for (const [value, name] of [[() => 1, 'a function'], [new Map(), 'a Map'], [new Date(0), 'a Date'], [host, 'the Host'],
    [{ deep: { f: Symbol.iterator, g: () => 1 } }, 'a function inside']]) {
    throws(() => host.send(session, 'go', value), status('TA_ERROR_UNSUPPORTED'), name);
  }
  let deep = 0;
  for (let i = 0; i < 70; i++) deep = [deep];
  throws(() => host.send(session, 'go', deep), status('TA_ERROR_INVALID'), 'nested deeper than 64');
  const cycle = {};
  cycle.self = cycle;
  throws(() => host.send(session, 'go', cycle), status('TA_ERROR_INVALID'), 'a cycle');
  const getter = { get x() { throw new RangeError('from a getter'); } };
  throws(() => host.send(session, 'go', getter), (error) => {
    if (!(error instanceof RangeError) || error instanceof TinyactorsError) throw error;
  }, 'a getter\'s own error');
  host.send(session, 'go', { fine: [1, 'two', null, undefined, 3n, new Uint8Array([4])] });
  await host.idle();
  host.close();
});

test('the native datamodel: charts run in a context of their own, never the application\'s realm', async () => {
  globalThis.tinyactorsProbe = 'the application\'s';
  try {
    const chart = scxml('c', `
      <state id="s">
        <onentry>
          <log label="global" expr="typeof tinyactorsProbe + ' ' + typeof process + ' ' + typeof require"/>
          <script>Array.prototype.chartOwn = 1</script>
        </onentry>
      </state>`);
    same(await lines(chart, [], NATIVE), ['global: undefined undefined undefined'], 'no application globals');
    equal([].chartOwn, undefined, 'the application\'s builtins untouched');
  } finally {
    delete globalThis.tinyactorsProbe;
  }
});

test('the native datamodel: a send\'s data is the payload\'s value copied into the application\'s realm, once', async () => {
  const chart = scxml('c', `
    <datamodel><data id="o" expr="({list: [1, 2]})"/></datamodel>
    <state id="s"><onentry><send event="out" type="urn:out" target="x" namelist="o"/></onentry></state>`);
  let seen;
  const host = new Host([], {
    system: 't',
    ...NATIVE,
    ioProcessors: { 'urn:out': processor((send) => { seen = [send.data === send.data, Array.isArray(send.data.o.list), send.data.o.list instanceof Array]; }) },
  });
  host.addImage(image({ c: chart }));
  host.spawn(host.chart('c'));
  await host.idle();
  host.close();
  same(seen, [true, true, true], 'the same object each read; an array of the application\'s realm');
});

test('the native datamodel: a typed method is never called from a chart, which cannot reach the Host', () => {
  // A run is the only place core refuses ta_host_post with TA_ERROR_STATE,
  // and on the native datamodel no application code runs inside one: the
  // Host, like every function and class instance, does not cross into a
  // chart (above), and copies made at the inputs run getters there, not in
  // the run. So that refusal stays core's, unreachable from JavaScript.
  const host = hostWith({ c: scxml('c', '<state id="s"/>') }, NATIVE);
  const session = host.spawn(host.chart('c'));
  throws(() => host.send(session, 'go', { host }), status('TA_ERROR_UNSUPPORTED'), 'the Host as data');
  throws(() => host.send(session, 'go', { call: () => host.hostStats(undefined, () => {}) }), status('TA_ERROR_UNSUPPORTED'),
    'a function that would call it');
  host.close();
});

await run();
