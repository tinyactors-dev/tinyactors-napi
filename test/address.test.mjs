// Address (docs/plan.xml, decision d-address): immutable, its text, and
// its parts read by core's parser on each access; made from parts by
// core's formatter; taken by the inputs wherever an address is.
import { Address, TinyactorsError } from '@tinyactors/node';
import { ENDER, equal, hostWith, scxml, status, throws, typeError, until } from './charts.mjs';
import { run, test } from './harness.mjs';

const invalid = status('TA_ERROR_INVALID');

test('a session address: its text and parts', () => {
  const address = new Address('tinyactors://sys.example/#_scxml_18446744073709551615');
  equal(address.text, 'tinyactors://sys.example/#_scxml_18446744073709551615', 'text');
  equal(address.system, 'sys.example', 'system');
  equal(address.session, 18446744073709551615n, 'session, a bigint to 2^64-1');
  equal(address.name, undefined, 'no name');
  equal(String(address), address.text, 'toString');
  equal(`${address}`, address.text, 'in a template');
});

test('a name address: the name decoded', () => {
  const address = new Address('tinyactors://sys/@h%C3%A9llo%20w%C3%B6rld');
  equal(address.system, 'sys', 'system');
  equal(address.name, 'héllo wörld', 'name');
  equal(address.session, undefined, 'no session');
  throws(() => new Address('tinyactors://sys/@%FF').name, invalid, 'a name that is not UTF-8 is refused, not replaced');
});

test('text that is no address has no parts', () => {
  for (const text of ['', 'nope', 'http://x/y', 'tinyactors://Sys/#_scxml_1', 'tinyactors://sys/#_scxml_0']) {
    const address = new Address(text);
    equal(address.text, text, `text of ${text}`);
    equal(address.system, undefined, `system of ${text}`);
    equal(address.session, undefined, `session of ${text}`);
    equal(address.name, undefined, `name of ${text}`);
  }
});

test('immutable', () => {
  const address = new Address('tinyactors://sys/#_scxml_1');
  equal(Object.isFrozen(address), true, 'frozen');
  throws(() => { 'use strict'; address.text = 'x'; }, typeError, 'text is read-only');
  throws(() => { 'use strict'; address.session = 2n; }, typeError, 'session is read-only');
  equal(address.session, 1n, 'unchanged');
});

test('made from parts by core\'s formatter', () => {
  equal(Address.fromSession('sys', 7n).text, 'tinyactors://sys/#_scxml_7', 'fromSession');
  equal(Address.fromSession('sys', 7n).session, 7n, 'its session');
  const named = Address.fromName('sys', 'a b/é');
  equal(named.text, 'tinyactors://sys/@a%20b%2F%C3%A9', 'fromName percent-encodes');
  equal(named.name, 'a b/é', 'and decodes back');
  if (!(named instanceof Address)) throw new Error('an Address');
  throws(() => Address.fromSession('Bad System', 1n), invalid, 'an invalid system id');
  throws(() => Address.fromSession('sys', 0n), typeError, 'session 0');
  throws(() => Address.fromSession('sys', 1.5), typeError, 'a session that is not an integer');
  equal(Address.fromSession('sys', 7).text, 'tinyactors://sys/#_scxml_7', 'a safe integer is a session');
  throws(() => Address.fromName('sys', ''), invalid, 'an empty name');
  throws(() => Address.fromName('sys'), typeError, 'no name');
});

test('refusals: not a string, not called with new, a getter on another object', () => {
  throws(() => new Address(5), typeError, 'a number');
  throws(() => new Address(), typeError, 'nothing');
  throws(() => Address('tinyactors://sys/#_scxml_1'), typeError, 'without new');
  const getter = Object.getOwnPropertyDescriptor(Address.prototype, 'session').get;
  throws(() => getter.call({ text: 'tinyactors://sys/#_scxml_1' }), typeError, 'a look-alike');
  throws(() => Address.prototype.toString.call({}), typeError, 'toString on another object');
  void TinyactorsError;
});

test('send and fail take an Address as target, send an Address as origin', async () => {
  const sender = scxml('sender', `
    <state id="s"><transition event="error.communication" cond="_event.sendid === 'o-1'" target="done"/></state>
    <final id="done"/>`);
  const origins = [];
  const watcher = scxml('watcher', `
    <state id="s"><transition event="go" target="done"><log expr="_event.origin"/></transition></state>
    <final id="done"/>`);
  const host = hostWith({ ender: ENDER, sender, watcher }, { log: (h, entry) => origins.push(entry.text) });
  const ender = host.spawn(host.chart('ender'), { name: 'e' });
  host.send(Address.fromSession('t', ender), 'go');
  if (!(await until(() => host.actorByName('e') === undefined))) throw new Error('send to an Address');
  host.spawn(host.chart('sender'), { name: 'sender' });
  host.fail(Address.fromName('t', 'sender'), 'o-1');
  if (!(await until(() => host.actorByName('sender') === undefined))) throw new Error('fail to an Address');
  const watching = host.spawn(host.chart('watcher'));
  host.send(watching, 'go', undefined, { origin: new Address('tinyactors://far/#_scxml_3') });
  await host.idle();
  equal(origins.join(), 'tinyactors://far/#_scxml_3', 'the origin\'s text');
  throws(() => host.send(new Address('nope'), 'go'), invalid, 'an Address that names no local session');
  host.close();
});

test('an Address inside a value a chart takes is its text there', async () => {
  const chart = scxml('reader', `
    <state id="s"><transition event="who"><log label="who" expr="typeof _event.data.who + ' ' + _event.data.who + ' ' + _event.data.list[0]"/></transition></state>`);
  const seen = [];
  const host = hostWith({ reader: chart }, { log: (h, entry) => seen.push(entry.text) });
  const session = host.spawn(host.chart('reader'));
  const who = new Address('tinyactors://shop/@ada');
  host.send(session, 'who', { who, list: [who] });
  await host.idle();
  host.close();
  equal(seen.join(), 'string tinyactors://shop/@ada tinyactors://shop/@ada', 'the text');
});

await run();
