#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const runtime = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
const builtins = new Set([...Module.builtinModules, ...Module.builtinModules.map((x) => `node:${x}`)]);
const roots = ['index.ts', 'app', 'middleware', 'routes', 'lib', 'db', 'jobs', 'socket', 'plugins'];
const skip = /(?:^|\/)(?:tests?|__tests__|dist|node_modules)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const optionalRuntime = new Map([
  ['typescript', 'plugin loader explicitly probes TypeScript and falls back to prebuilt JavaScript'],
  ['@opentelemetry/api', 'observability integration is optional and guarded by tryRequire'],
  ['@opentelemetry/sdk-node', 'observability integration is optional and guarded by tryRequire'],
  ['@opentelemetry/auto-instrumentations-node', 'observability integration is optional and guarded by tryRequire'],
  ['@opentelemetry/exporter-trace-otlp-http', 'observability integration is optional and guarded by tryRequire'],
  ['@sentry/node', 'Sentry integration is optional and guarded by tryRequire'],
]);

function packageName(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#') || builtins.has(spec)) return null;
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}
function walk(p, out=[]) {
  if (!fs.existsSync(p)) return out;
  const st=fs.statSync(p);
  if (st.isFile()) { out.push(p); return out; }
  for (const e of fs.readdirSync(p,{withFileTypes:true})) {
    const f=path.join(p,e.name); const rel=path.relative(ROOT,f).replaceAll('\\','/');
    if (skip.test(rel)) continue;
    if (e.isDirectory()) walk(f,out); else if (/\.[cm]?[jt]sx?$/.test(e.name) || e.name.endsWith('.d.ts')) out.push(f);
  }
  return out;
}
const files=[]; for (const root of roots) walk(path.join(ROOT,root),files);
const findings=[]; const used=new Map();
for (const file of files) {
  const src=fs.readFileSync(file,'utf8');
  // Remove type-only imports because they are compile-time dependencies, not runtime image requirements.
  const runtimeSrc=src.replace(/\bimport\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?/g,'');
  const specs=[];
  for (const re of [
    /\bimport\s+(?!type\b)[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) { let m; while ((m=re.exec(runtimeSrc))) specs.push(m[1]); }
  for (const spec of specs) {
    const name=packageName(spec); if (!name) continue;
    const rel=path.relative(ROOT,file).replaceAll('\\','/');
    if (!used.has(name)) used.set(name,new Set()); used.get(name).add(rel);
    if (!runtime.has(name) && !optionalRuntime.has(name)) findings.push({name,spec,file:rel});
  }
}
if (findings.length) {
  console.error('❌ Production runtime imports undeclared packages:');
  for (const f of findings) console.error(`  ${f.name} <- ${f.file} (${f.spec})`);
  process.exit(1);
}
for (const [name, reason] of optionalRuntime) {
  if (used.has(name) && !runtime.has(name)) console.log(`ℹ️ optional runtime package: ${name} — ${reason}`);
}
console.log(`✅ Production dependency contract PASS (${files.length} source files, ${used.size} external packages)`);
