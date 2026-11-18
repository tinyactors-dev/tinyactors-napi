// The documents the package ships, and their links (docs/plan.xml,
// p3-shapes): package.json's `files` is what `npm pack` puts in the main
// package (mise/pack.rb stages exactly those), and every relative link of
// every Markdown file in it, the README's first, names a file that is in
// the package too, and a heading of it when it names one: a README read
// after an install, on npm's page or in node_modules, has no link that
// leads nowhere.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { equal } from './charts.mjs';
import { run, test } from './harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { files } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Every file the package holds, relative to its root, with `/`. */
function shipped() {
  const found = new Set(['package.json']);
  const walk = (path) => {
    if (statSync(join(ROOT, path)).isDirectory()) for (const name of readdirSync(join(ROOT, path))) walk(`${path}/${name}`);
    else found.add(path);
  };
  // LICENSE is the repository's (../LICENSE), copied in when the package is staged
  for (const entry of files) if (entry === 'LICENSE') found.add(entry); else walk(entry);
  return found;
}

/** GitHub's anchor of a heading: lowercase, punctuation dropped, spaces as `-`. */
const anchor = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

/** The anchors of a Markdown file's headings (outside its code blocks). */
function anchors(text) {
  const found = new Set();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6} /.test(line)) found.add(anchor(line.replace(/^#+ /, '').replace(/`/g, '')));
  }
  return found;
}

/** The link targets of a Markdown file, outside its code blocks and code spans. */
function links(text) {
  const found = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const match of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) found.push({ target: match[1], line: i + 1 });
  });
  return found;
}

test('package.json lists the files the package ships: the code, the types, the README and the guides', () => {
  for (const entry of ['index.mjs', 'lib', 'index.d.ts', 'README.md', 'LICENSE', 'docs/guide', 'docs/values.md'])
    if (!files.includes(entry)) throw new Error(`files lacks ${entry}`);
  for (const entry of files) if (entry !== 'LICENSE' && !existsSync(join(ROOT, entry))) throw new Error(`files names ${entry}, which does not exist`);
});

test('every relative link of the shipped documents resolves inside the package', () => {
  const inPackage = shipped();
  const documents = [...inPackage].filter((path) => path.endsWith('.md'));
  equal(documents.includes('README.md'), true, 'the README is shipped');
  const broken = [];
  let checked = 0;
  for (const document of documents) {
    for (const { target, line } of links(readFileSync(join(ROOT, document), 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:: not the package's
      checked++;
      const [path, fragment] = target.split('#');
      const file = path === '' ? document : relative(ROOT, join(ROOT, dirname(document), path)).split(sep).join('/');
      if (file.startsWith('..') || !inPackage.has(file)) {
        broken.push(`${document}:${line}: ${target}: ${file} is not in the package`);
        continue;
      }
      if (fragment !== undefined && file.endsWith('.md') && !anchors(readFileSync(join(ROOT, file), 'utf8')).has(fragment))
        broken.push(`${document}:${line}: ${target}: ${file} has no heading #${fragment}`);
    }
  }
  if (broken.length) throw new Error(`links that lead nowhere after an install:\n${broken.join('\n')}`);
  if (checked < 20) throw new Error(`only ${checked} links checked`);
});

await run();
