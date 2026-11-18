// The documentation's examples: every ```js block of README.md and
// docs/guide/*.md, with the ```output block that follows it. Read by
// test/docs.test.mjs, which runs each in node and bun, wasm/test/documentation.mjs,
// which runs each that needs no Node.js built-in in Chromium, and
// tools/typecheck.mjs, which checks each against index.d.ts with tsc.
//
// A block opened as ```js browser needs a browser's API (IndexedDB, a
// Worker, a page's events): it runs in Chromium only. One whose first line
// is `// file: <name>.mjs` is a module another block loads by that name
// (a Worker's script): it is served, not run. An example that imports
// @tinyactors/wasm runs against the wasm package everywhere
// (`wasmPackage`).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The documents with examples, relative to the package's root. */
export function documents(root) {
  return ['README.md', ...readdirSync(join(root, 'docs/guide')).filter((name) => name.endsWith('.md')).sort().map((name) => `docs/guide/${name}`)];
}

/** The fenced blocks of `text`: {info, attributes, body, line}, a block's indentation removed. */
export function blocks(text) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```(\S*)(?:[ \t]+(\S[^`]*?))?\s*$/.exec(lines[i]);
    if (!open) continue;
    const [, indent, info, attributes = ''] = open;
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !/^\s*```\s*$/.test(lines[j]); j++) body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j]);
    if (j === lines.length) throw new Error(`an unclosed block at line ${i + 1}`);
    found.push({ info, attributes: attributes.split(/\s+/).filter(Boolean), body: body.join('\n'), line: i + 1 });
    i = j;
  }
  return found;
}

/** Each example: its document, line, program and the output it must print (or undefined). */
export function examples(root) {
  const found = [];
  for (const document of documents(root)) {
    const all = blocks(readFileSync(join(root, document), 'utf8'));
    all.forEach((block, i) => {
      if (block.info !== 'js') return;
      const next = all[i + 1];
      const file = /^\/\/ file: (\S+\.mjs)$/.exec(block.body.split('\n')[0])?.[1];
      found.push({
        document, line: block.line, program: block.body, output: next?.info === 'output' ? next.body : undefined,
        browser: block.attributes.includes('browser'), file,
        wasmPackage: /from '@tinyactors\/wasm(\/init)?'/.test(block.body),
      });
    });
  }
  return found;
}

/** The file name an example is written to: its document and line. */
export const fileName = (example) => `${example.document.replace(/[/.]/g, '-')}-${example.line}.mjs`;
