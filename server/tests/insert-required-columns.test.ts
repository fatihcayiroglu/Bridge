// server/tests/insert-required-columns.test.ts — Final21 Phase 16.
//
// Every INSERT must write the columns PostgreSQL requires (NOT NULL, no DEFAULT). The unit-test
// store does not enforce NOT NULL, so a missing column is invisible until the endpoint is run
// against a real database and returns 500.
//
// Measured twice: webhook creation (Phase 15: `createdAt` never written) and
// `routes/voicemsg.ts` (`voice_messages."displayName"` never written, found by this audit).
//
// The check derives required columns from the schema sources, derives what each repository
// injects from its own insert literals, and reads the object literal at each call site.
// Call sites that spread (`...data`) cannot be judged statically and are skipped.

import fs from 'fs';
import path from 'path';

const SERVER = path.resolve(__dirname, '..');

function requiredColumns(): Map<string, Set<string>> {
  const required = new Map<string, Set<string>>();
  for (const file of ['db/postgres/schema.ts', 'db/postgres/migrations.ts']) {
    const src = fs.readFileSync(path.join(SERVER, file), 'utf8');
    for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+("?\w+"?)\s*\(([\s\S]*?)\n\s*\)\s*[;`]/gi)) {
      const table = m[1].replace(/"/g, '');
      const cols = required.get(table) ?? new Set<string>();
      for (const line of m[2].split('\n')) {
        const t = line.trim().replace(/,$/, '');
        const cm = t.match(/^("?)([A-Za-z_]\w*)\1\s+([A-Za-z].*)$/);
        if (!cm) continue;
        const [, , col, rest] = cm;
        if (/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK|EXCLUDE)\b/i.test(col)) continue;
        if (/PRIMARY KEY/i.test(rest) || !/NOT NULL/i.test(rest) || /DEFAULT/i.test(rest)) continue;
        cols.add(col);
      }
      required.set(table, cols);
    }
  }
  return required;
}

/** Balanced `{...}` starting at `open`; returns the inner source. */
function objectAt(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(open + 1, i); }
    else if (c === '`' || c === "'" || c === '"') {
      const quote = c; i += 1;
      while (i < src.length && src[i] !== quote) { if (src[i] === '\\') i += 1; i += 1; }
    }
  }
  return null;
}

function topLevelKeys(rawBody: string): { keys: Set<string>; spread: boolean } {
  const body = rawBody.split('\n').map((line) => {
    const i = line.indexOf('//');
    return i >= 0 && !/https?:$/.test(line.slice(0, i)) ? line.slice(0, i) : line;
  }).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const keys = new Set<string>();
  let depth = 0; let spread = false; let current = '';
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (c === '`' || c === "'" || c === '"') {
      const quote = c; current += c; i += 1;
      while (i < body.length && body[i] !== quote) { current += body[i]; if (body[i] === '\\') { i += 1; current += body[i]; } i += 1; }
    }
    if (c === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('...')) { spread = true; continue; }
    const named = t.match(/^["']?([A-Za-z_]\w*)["']?\s*:/);
    if (named) { keys.add(named[1]); continue; }
    const shorthand = t.match(/^([A-Za-z_]\w*)$/);
    if (shorthand) keys.add(shorthand[1]);
  }
  return { keys, spread };
}

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (/node_modules|[\\/]dist[\\/]|[\\/]tests[\\/]/.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  })(SERVER);
  return out;
}

describe('every insert writes the columns PostgreSQL requires', () => {
  const required = requiredColumns();

  const loaderSrc = fs.readFileSync(path.join(SERVER, 'db/postgres/index.ts'), 'utf8');
  const mapStart = loaderSrc.indexOf('const TABLE_MAP');
  const mapBody = loaderSrc.slice(mapStart, loaderSrc.indexOf('};', mapStart));
  const collectionTable = new Map([...mapBody.matchAll(/(\w+)\s*:\s*'([\w]+)'/g)].map((m) => [m[1], m[2]] as const));

  const repoIndex = fs.readFileSync(path.join(SERVER, 'db/repositories/index.ts'), 'utf8');
  const exported = new Map([...repoIndex.matchAll(/import\s+(\w+)\s+from\s+'\.\/(\w+)'/g)].map((m) => [m[1], m[2]] as const));

  it('the audit actually sees the schema and the repositories', () => {
    expect([...required.values()].filter((s) => s.size).length).toBeGreaterThan(50);
    expect(collectionTable.size).toBeGreaterThan(50);
    expect(exported.size).toBeGreaterThan(20);
  });

  it('no repository call site omits a required column', () => {
    type PassThrough = { exportName: string; method: string; table: string; injected: Set<string> };
    const passThrough: PassThrough[] = [];
    for (const file of fs.readdirSync(path.join(SERVER, 'db/repositories')).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(SERVER, 'db/repositories', file), 'utf8');
      const exportName = [...exported.entries()].find(([, mod]) => mod === file.replace(/\.ts$/, ''))?.[0];
      if (!exportName) continue;

      // What this repository injects per collection, from every insert literal in the file.
      const injectedPerCollection = new Map<string, Set<string>>();
      const addInjected = (coll: string, body: string) => {
        const set = injectedPerCollection.get(coll) ?? new Set<string>();
        for (const k of topLevelKeys(body).keys) set.add(k);
        injectedPerCollection.set(coll, set);
      };
      for (const ins of src.matchAll(/db\.(\w+)\.insert\(\s*([{\w])/g)) {
        const coll = ins[1];
        if (ins[2] === '{') {
          const body = objectAt(src, src.indexOf('{', ins.index! + ins[0].length - 1));
          if (body !== null) addInjected(coll, body);
          continue;
        }
        // `const row = { createdAt: …, ...data }; return db.X.insert(row)` — follow the variable.
        const identifier = src.slice(ins.index! + ins[0].length - 1).match(/^\w+/)?.[0];
        if (!identifier) continue;
        const declared = src.lastIndexOf(`const ${identifier} = {`, ins.index!);
        if (declared < 0) continue;
        const body = objectAt(src, src.indexOf('{', declared));
        if (body !== null) addInjected(coll, body);
      }

      for (const m of src.matchAll(/async\s+(\w+)\s*\(/g)) {
        // The insert must be inside THIS method's body: a fixed look-ahead window attributed
        // inserts to unrelated query methods defined just above them.
        const bodyStart = src.indexOf('{', src.indexOf(')', m.index!));
        if (bodyStart < 0) continue;
        const body = objectAt(src, bodyStart);
        if (body === null) continue;
        const ins = body.match(/db\.(\w+)\.insert\(/);
        if (!ins) continue;
        const table = collectionTable.get(ins[1]);
        if (!table) continue;
        passThrough.push({ exportName, method: m[1], table, injected: injectedPerCollection.get(ins[1]) ?? new Set() });
      }
    }
    expect(passThrough.length).toBeGreaterThan(20);

    const findings: string[] = [];
    const files = sourceFiles();
    for (const { exportName, method, table, injected } of passThrough) {
      const req = required.get(table);
      if (!req || req.size === 0) continue;
      const call = new RegExp(`\\b${exportName}\\.${method}\\(`, 'g');
      for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(call)) {
          const braceAt = src.indexOf('{', m.index! + m[0].length - 1);
          if (braceAt < 0 || braceAt > m.index! + m[0].length + 3) continue;
          const body = objectAt(src, braceAt);
          if (body === null) continue;
          const { keys, spread } = topLevelKeys(body);
          if (spread) continue;
          const missing = [...req].filter((c) => !keys.has(c) && !injected.has(c));
          if (missing.length) {
            const line = src.slice(0, m.index!).split('\n').length;
            findings.push(`${path.relative(SERVER, file)}:${line} ${exportName}.${method} -> ${table} missing ${missing.join(', ')}`);
          }
        }
      }
    }
    expect([...new Set(findings)]).toEqual([]);
  });
});
