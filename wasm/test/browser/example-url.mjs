// node:url for an example application in a page (wasm/test/documentation.mjs's
// import map): fileURLToPath of a URL is its path, so an example's module
// that names a file beside it at its top loads; a case that runs the file
// as a process is excluded (wasm/test/exclusions.mjs, EXAMPLES).
export const fileURLToPath = (url) => new URL(url).pathname;
export const pathToFileURL = (path) => new URL(path, 'file:///');
export default { fileURLToPath, pathToFileURL };
