# node-api-headers

The Node-API C headers the addon compiles against, from the npm package
[node-api-headers](https://www.npmjs.com/package/node-api-headers) 1.9.0
(`sha512-2oNILP4jXwRB4ywnYKjVk1YyJ96n2D4EOVJO6S3oYZ5PtbJrw3Yt9TpAuX3nBLMuzn74rnfGQrv13pS9vC+YiA==`),
unchanged. Only `include/`, `symbols.js` and `LICENSE` are kept.

The build no longer reads the headers of the Node that mise installed, so
every release target compiles against the same declarations
(docs/adr/0001-packaging-and-releases.md). The addon targets Node-API 10
(`-DNAPI_VERSION=10`: Node 22.14 and later, and Bun): the headers declare
nothing newer at that version, and `mise run symbols` checks each built
addon imports only functions `symbols.js` lists for version 10.

To update: `npm pack node-api-headers@<version>`, unpack it, replace
`include/`, `symbols.js` and `LICENSE` here with the package's, and change
the version and integrity above (`npm view node-api-headers@<version>
dist.integrity`).
