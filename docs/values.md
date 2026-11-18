# JavaScript values

`@tinyactors/node` exports `encode(value)` and `decode(bytes)`, the one
conversion between JavaScript values and the value table's CBOR
(`tinyactors-core/docs/protocol.md`, "Values"). The addon writes with
core's streaming CBOR writer and reads with its streaming reader
(`src/values.c`); nothing is converted in JavaScript.

```js
import { decode, encode } from '@tinyactors/node';

const bytes = encode({ name: 'ada', score: 2n ** 60n, tags: ['a'], blob: new Uint8Array([1, 2]) });
const value = decode(bytes); // { name: 'ada', score: 1152921504606846976n, tags: ['a'], blob: Uint8Array [1, 2] }
```

## The table

| JavaScript | CBOR | Back |
|---|---|---|
| `undefined` | undefined (`f7`) | `undefined` |
| `null` | null (`f6`) | `null` |
| `true`, `false` | true, false | `true`, `false` |
| a number for which `Number.isSafeInteger` holds, not `-0` | an integer | a number |
| any other number: a fraction, `-0`, `NaN`, the infinities, an integer past 2^53 | a float, in its shortest exact width | a number |
| a `bigint` from -2^64 to 2^64-1 | an integer | a number within ±(2^53-1), else a `bigint` |
| a string | text, valid UTF-8 | a string |
| a `Uint8Array` (a `Buffer` too; a view's own bytes) | bytes | a `Uint8Array` |
| an array | an array, a hole as undefined | an array |
| a plain object (its prototype `Object.prototype` or `null`) | a map of its own enumerable string keys, in `Object.keys` order | a plain object |
| an `Address` | tag 32 on its text (an actor reference) | an `Address` |

`undefined` and `null` stay distinct at every position: a key holding
`undefined` is kept, and an array's `undefined` is not `null`. Every
integer comes back as itself, as a number or a `bigint`; a float holding
an integer (`1.0` in CBOR) comes back as the number `1`, and goes out
again as an integer.

`encode` and `decode` keep an actor reference: an `Address` is tag 32 on
its text and comes back an `Address`, as in a Python host, so a
transport's `send.message` crosses a wire as it is. A chart has no
reference type: inside a value a chart reads (event data, params) an
`Address` is its text, and an actor reference a chart sends reaches you
as its address string.

## Refusals

What `encode` cannot write and `decode` cannot read throws a
`TinyactorsError`, never a value made up for it. Its `status` is core's
name for the reason:

- `TA_ERROR_UNSUPPORTED`: a value outside the table: a function, a
  symbol, a `Date`, a `Map`, an instance of a class, an `ArrayBuffer`, a
  `DataView` or a typed array other than `Uint8Array`;
- `TA_ERROR_INVALID`: a value the table cannot hold: a `bigint` past 64
  bits, a string with a lone surrogate (refused, never replaced by
  U+FFFD), nesting deeper than 64 (which a cycle reaches); and CBOR that
  is malformed, truncated, followed by more bytes, a map key that is not
  text, a tag other than 32, tag 32 on something but text, or a simple
  value other than false, true, null and undefined.

A getter that throws while `encode` reads an object passes its own
exception through. `decode` takes a `Uint8Array` (a `Buffer` too) or an
`ArrayBuffer`, holding exactly one CBOR item; any other argument is a
`TypeError`.

```js
import { encode, TinyactorsError } from '@tinyactors/node';

try {
  encode({ at: new Date() });
} catch (error) {
  if (error instanceof TinyactorsError) console.log(error.status); // "TA_ERROR_UNSUPPORTED"
}
```

A map key given twice keeps its last value. A key `"__proto__"` is an
own key of the object `decode` makes; no prototype is set and no setter
runs.

## Ownership and use

| What | Owner | Lifetime |
|---|---|---|
| the bytes given to `decode` | the caller | read during the call only; never held |
| the writer and the call's text | the environment's instance | an arena with a mark per call, released when the call returns; a getter that calls `encode` again allocates above the outer call and releases to its own mark |
| the `Uint8Array` `encode` returns, the value `decode` returns | the caller | independent of the input and of the addon |

Strings are copied once as UTF-8 for the writer (the copy Node-API
forces); only a string whose UTF-8 holds U+FFFD is read again as UTF-16,
to tell a lone surrogate from a real U+FFFD. Each array and object is
read as `encode` reaches it: do not change a value from a getter while it
is being encoded if you need a consistent whole. A subtree shared by two
keys is written twice. The module is initialized once per environment,
the main thread and each worker, each with its own instance.

## `encode` and a datamodel's `to_wire`

`encode` is the API's codec, for values the application holds. A chart's
data leaves an ECMAScript datamodel by its `to_wire`, whose rules are
JavaScript's for a value sent elsewhere: `undefined` at the top and in an
array is null, a key holding `undefined` is dropped, a `Date` is its JSON
form, a function is dropped, an `ArrayBuffer` or any view is its bytes
(the suite's `values.txt`, the `encode` cases). `encode` keeps
`undefined` apart from `null` and refuses the others instead, so a value
read back is the value written. `test/values.test.mjs` runs `values.txt`'s
`ecmascript` lines against `encode` and `decode`, with the cases where the
two differ listed and checked for what `encode` gives.
