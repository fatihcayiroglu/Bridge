#!/usr/bin/env node
// scripts/measure-client-coupling.cjs
//
// Reproduces the coupling numbers in docs/ADR-0014-cross-platform-client-architecture.md
// and docs/P8_CLIENT_READINESS_PLAN.md. Read-only, dependency-free.
//
//   node scripts/measure-client-coupling.cjs [--json]
//
// Measures, over client/js (excluding .d.ts):
//   · module counts by kind;
//   · static (non-type) import cycles — Tarjan strongly-connected components;
//   · BridgeRegistry keys and call sites (runtime coupling an import graph does not show);
//   · `bridge:*` DOM CustomEvent names and dispatch sites;
//   · window./document. references in plain TypeScript under core/;
//   · per-module coupling for the components the P8 plan names.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'client', 'js');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '_legacy', 'dist'].includes(e.name)) walk(p); }
    else if (/\.(ts|svelte)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p);
  }
})(ROOT);
const source = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const count = (text, re) => (text.match(re) || []).length;

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.svelte`, base.replace(/\.js$/, '.svelte'), path.join(base, 'index.ts')];
  return candidates.find(c => source.has(c)) || null;
}

// Static, value-level imports only: `import type` lines and dynamic import() are excluded,
// because neither creates a load-order cycle.
const graph = new Map();
const IMPORT = /(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
for (const [file, text] of source) {
  const deps = new Set();
  for (const line of text.split('\n')) {
    if (/^\s*import\s+type\s/.test(line)) continue;
    IMPORT.lastIndex = 0;
    let m;
    while ((m = IMPORT.exec(line))) { const r = resolveImport(file, m[1]); if (r) deps.add(r); }
  }
  graph.set(file, deps);
}

let index = 0;
const stack = [], onStack = new Set(), idx = new Map(), low = new Map(), cycles = [];
function strongConnect(v) {
  idx.set(v, index); low.set(v, index); index += 1; stack.push(v); onStack.add(v);
  for (const w of graph.get(v)) {
    if (!idx.has(w)) { strongConnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const component = []; let w;
    do { w = stack.pop(); onStack.delete(w); component.push(rel(w)); } while (w !== v);
    if (component.length > 1) cycles.push(component.sort());
  }
}
for (const v of graph.keys()) if (!idx.has(v)) strongConnect(v);

const all = [...source.values()].join('\n');
const registryKeys = new Set();
for (const m of all.matchAll(/BridgeRegistry\.register\(\s*['"]([^'"]+)['"]/g)) registryKeys.add(m[1]);
for (const m of all.matchAll(/registerOwned\(\s*['"]([^'"]+)['"]/g)) registryKeys.add(m[1]);
const eventNames = new Set(all.match(/['"]bridge:[a-z0-9:_-]+['"]/g) || []);
const coreTs = files.filter(f => rel(f).startsWith('core/') && f.endsWith('.ts') && !f.endsWith('.svelte.ts'));
const domRefs = coreTs.reduce((n, f) => n + count(source.get(f), /\b(?:window|document)\./g), 0);
const domFiles = coreTs.filter(f => /\b(?:window|document)\./.test(source.get(f))).length;

function profile(relPath) {
  const text = source.get(path.join(ROOT, relPath));
  if (!text) return { file: relPath, missing: true };
  const markup = text.includes('</script>') ? text.slice(text.lastIndexOf('</script>') + 9) : '';
  return {
    file: relPath,
    lines: count(text, /\n/g),
    markupLines: markup.split('\n').filter(l => l.trim() && !/^\s*<\/?style/.test(l)).length,
    svelteImports: count(text, /from ['"]svelte(?:\/[^'"]*)?['"]/g),
    apiFetch: count(text, /\b(?:apiFetch|fetch)\s*(?:<[^>()]*>)?\(/g),
    socketHandlers: count(text, /\bsocket\??\.(?:on|once|off|emit)\(/g),
    windowDocument: count(text, /\b(?:window|document)\./g),
    registryCalls: count(text, /BridgeRegistry\.(?:call|has|get|register)\b/g),
  };
}

const report = {
  root: 'client/js',
  modules: {
    svelte: files.filter(f => f.endsWith('.svelte')).length,
    svelteTs: files.filter(f => f.endsWith('.svelte.ts')).length,
    ts: files.filter(f => f.endsWith('.ts') && !f.endsWith('.svelte.ts')).length,
  },
  staticImportEdges: [...graph.values()].reduce((n, d) => n + d.size, 0),
  importCycles: cycles,
  bridgeRegistry: {
    keys: registryKeys.size,
    callSites: count(all, /BridgeRegistry\.(?:call|has|get)\(/g),
    importingFiles: files.filter(f => /bridge-registry/.test(source.get(f)) && !f.endsWith('bridge-registry.ts')).length,
  },
  domEvents: { names: eventNames.size, dispatchSites: count(all, /dispatchEvent\(\s*new CustomEvent/g) },
  windowDocumentInCoreTs: { references: domRefs, files: domFiles },
  capacitorGlobalFiles: files.filter(f => /\bCapacitor\b/.test(source.get(f))).map(rel).sort(),
  components: [
    'core/AppState.svelte', 'core/SocketManager.svelte', 'core/MessageLoader.svelte',
    'core/MessageListPanel.svelte', 'core/MessageRenderer.svelte', 'webrtc-sfu.ts',
  ].map(profile),
  localFirst: files.filter(f => rel(f).startsWith('core/local-first/')).map(f => ({
    file: rel(f),
    svelteImports: count(source.get(f), /from ['"]svelte|\.svelte['"]/g),
    document: count(source.get(f), /\bdocument\b/g),
    registry: count(source.get(f), /BridgeRegistry/g),
  })),
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`modules: ${report.modules.svelte} .svelte, ${report.modules.ts} .ts, ${report.modules.svelteTs} .svelte.ts`);
  console.log(`static import edges: ${report.staticImportEdges}; import cycles: ${report.importCycles.length}`);
  for (const c of report.importCycles) console.log(`  cycle (${c.length}): ${c.join(', ')}`);
  console.log(`BridgeRegistry: ${report.bridgeRegistry.keys} keys, ${report.bridgeRegistry.callSites} call/has/get sites, imported by ${report.bridgeRegistry.importingFiles} files`);
  console.log(`bridge:* DOM events: ${report.domEvents.names} names, ${report.domEvents.dispatchSites} dispatch sites`);
  console.log(`window./document. in core/*.ts: ${report.windowDocumentInCoreTs.references} references in ${report.windowDocumentInCoreTs.files} files`);
  console.log(`window.Capacitor users: ${report.capacitorGlobalFiles.join(', ')}`);
  for (const c of report.components) {
    console.log(c.missing ? `  ${c.file}: missing` : `  ${c.file}: ${c.lines} lines, markup ${c.markupLines}, apiFetch ${c.apiFetch}, socket ${c.socketHandlers}, window/document ${c.windowDocument}, registry ${c.registryCalls}`);
  }
  const lf = report.localFirst;
  console.log(`local-first: ${lf.length} modules, svelte imports ${lf.reduce((n, m) => n + m.svelteImports, 0)}, document uses ${lf.reduce((n, m) => n + m.document, 0)}, registry uses ${lf.reduce((n, m) => n + m.registry, 0)}`);
}
