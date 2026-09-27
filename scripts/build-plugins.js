#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, 'plugins');

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

let built = 0;
for (const entry of fs.readdirSync(PLUGINS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(PLUGINS, entry.name);
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) continue;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const declared = typeof manifest.main === 'string' ? manifest.main : 'index.ts';
  const sourcePath = path.resolve(dir, declared);
  if (!isWithin(dir, sourcePath)) throw new Error(`Plugin main escapes plugin directory: ${entry.name}`);
  if (path.extname(sourcePath) !== '.ts') throw new Error(`Bundled plugin main must be TypeScript: ${entry.name}`);
  if (!fs.existsSync(sourcePath)) throw new Error(`Plugin TypeScript main missing: ${sourcePath}`);

  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      strict: true,
    },
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(`${entry.name}: ${errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
  }

  const outputPath = sourcePath.replace(/\.ts$/, '.js');
  const header = `// GENERATED FROM ${path.basename(sourcePath)} BY scripts/build-plugins.js — DO NOT EDIT.\n`;
  fs.writeFileSync(outputPath, header + result.outputText, 'utf8');
  built++;
}

console.log(`[plugins] built ${built} TypeScript plugin artifact(s)`);
