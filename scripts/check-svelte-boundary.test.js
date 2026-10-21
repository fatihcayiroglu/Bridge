'use strict';
// node --test scripts/check-svelte-boundary.test.js
//
// check-svelte-boundary.sh must not pass vacuously: a listed path that is
// missing, or a guarded file that imports Svelte, has to fail it, and the real
// tree has to pass with every guarded module actually checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join('scripts', 'check-svelte-boundary.sh');
const DOC = path.join(ROOT, 'docs', 'FRONTEND_ARCHITECTURE.md');
const LOCAL_FIRST = 'client/js/core/local-first/';
const CODE_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;

function run(root, args = []) {
  const r = spawnSync('bash', [path.join(root, SCRIPT), ...args], { cwd: root, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const listing = run(ROOT, ['--list']);
const GUARDED = listing.out.split('\n').filter(Boolean);

function codeFilesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((f) => CODE_EXT.test(f));
}

// A temp copy holding only the script and the paths it guards.
function copyTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of [SCRIPT, ...GUARDED]) {
    fs.cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  return dir;
}

function append(root, rel, text) {
  fs.appendFileSync(path.join(root, rel), `\n${text}\n`);
}

function named(out, rel) {
  return out.split('\n').some((l) => l === `  ${rel}` || l.startsWith(`  ${rel}: `));
}

test('the real tree passes and every guarded module is checked', () => {
  assert.equal(listing.code, 0, listing.out);
  assert.ok(GUARDED.includes(LOCAL_FIRST));
  assert.ok(GUARDED.includes('client/js/core/messages/message-format.ts'));
  assert.deepEqual(GUARDED.filter((p) => /\.svelte(\.|$)/.test(p)), []);
  assert.ok(codeFilesUnder(path.join(ROOT, LOCAL_FIRST)).length >= 15);

  const expected = GUARDED.reduce(
    (n, p) => n + (p.endsWith('/') ? codeFilesUnder(path.join(ROOT, p)).length : 1),
    0,
  );
  const r = run(ROOT);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`\\(${expected} dosya denetlendi\\)`));
});

// Every failure test below starts from such a copy, so this proves the
// failure comes from the one change each test makes.
test('an untouched copy of the guarded tree passes', (t) => {
  const r = run(copyTree(t));
  assert.equal(r.code, 0, r.out);
});

test('a listed file that does not exist fails the check and is named', (t) => {
  const dir = copyTree(t);
  const gone = ['client/js/core/auth-compat.ts', 'client/js/core/messages/message-format.ts'];
  for (const rel of gone) fs.rmSync(path.join(dir, rel));
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  for (const rel of gone) assert.ok(named(r.out, rel), `${rel} not named:\n${r.out}`);
  assert.match(r.out, /listede ama dosya yok/);
});

test('a missing or empty guarded directory fails the check', (t) => {
  const missing = copyTree(t);
  fs.rmSync(path.join(missing, LOCAL_FIRST), { recursive: true });
  let r = run(missing);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /client\/js\/core\/local-first\/: listede ama dizin yok/);

  const empty = copyTree(t);
  const lf = path.join(empty, LOCAL_FIRST);
  for (const f of fs.readdirSync(lf)) fs.rmSync(path.join(lf, f), { recursive: true });
  r = run(empty);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /local-first\/: dizinde denetlenecek kaynak dosya yok/);
});

const SVELTE_IMPORTS = [
  "import { mount } from 'svelte';",
  'import { writable } from "svelte/store";',
  "import SocketManager from '../SocketManager.svelte';",
  "import { t } from '../i18n/reactive.svelte.ts';",
  "import 'svelte/internal/client';",
  "const loader = await import('../MessageLoader.svelte');",
  "export { onMount } from 'svelte';",
  "import {\n  mount,\n} from 'svelte';",
  "import { mount } from 'svelte'; // a trailing comment does not hide the import",
];

// Each form goes in its own new module, which also proves that files added to
// the guarded directory later are checked.
test('every form of Svelte import fails the check and names its file', (t) => {
  const dir = copyTree(t);
  const probes = SVELTE_IMPORTS.map((line, i) => {
    const rel = `${LOCAL_FIRST}probe-${i}.ts`;
    fs.writeFileSync(path.join(dir, rel), `export const ok = true;\n${line}\n`);
    return rel;
  });
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ADR-0008 İHLALİ/);
  probes.forEach((rel, i) => assert.ok(named(r.out, rel), `not caught: ${SVELTE_IMPORTS[i]}\n${r.out}`));
});

test('a Svelte import in a listed service file fails the check and is named', (t) => {
  const dir = copyTree(t);
  append(dir, 'client/js/app.ts', "import { mount } from 'svelte'; // lazy mount");
  append(dir, 'client/js/core/messages/message-format.ts', "import Row from '../MessageRenderer.svelte';");
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  assert.ok(named(r.out, 'client/js/app.ts'), r.out);
  assert.ok(named(r.out, 'client/js/core/messages/message-format.ts'), r.out);
});

test('a Svelte module inside the framework-independent directory fails the check', (t) => {
  const dir = copyTree(t);
  const modules = ['Widget.svelte', 'store.svelte.ts'].map((name) => `${LOCAL_FIRST}${name}`);
  for (const rel of modules) fs.writeFileSync(path.join(dir, rel), 'export const x = $state(0);\n');
  const r = run(dir);
  assert.equal(r.code, 1, r.out);
  for (const rel of modules) assert.ok(named(r.out, rel), `${rel} not named:\n${r.out}`);
});

test('commented-out imports are not violations', (t) => {
  const dir = copyTree(t);
  append(dir, 'client/js/core/globals.ts', "// import { mount } from 'svelte';");
  append(dir, `${LOCAL_FIRST}store.ts`, "/*\n * import X from './X.svelte';\n */");
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
});

test('the documented boundary lists exactly what the script guards', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const start = doc.indexOf('## Kesin Sınır: Servis Katmanı');
  assert.notEqual(start, -1, 'section "Kesin Sınır: Servis Katmanı" is missing');
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const documented = [...section.matchAll(/^- `(client\/[^`]+)`/gm)].map((m) => m[1]);
  assert.deepEqual([...documented].sort(), [...GUARDED].sort());
});
