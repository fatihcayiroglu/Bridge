#!/usr/bin/env node
// server/scripts/build-plugins.js
// plugins/*/index.ts → index.js (production npm ci --omit=dev için)
//
// Kullanım: node server/scripts/build-plugins.js
// package.json: "build:plugins"

'use strict';

const fs   = require('fs');
const path = require('path');

let ts;
try {
  ts = require('typescript');
} catch {
  console.error('[build-plugins] typescript paketi gerekli (devDependency).');
  process.exit(1);
}

const pluginsDir = path.resolve(__dirname, '../../plugins');
if (!fs.existsSync(pluginsDir)) {
  console.log('[build-plugins] plugins/ yok, atlanıyor.');
  process.exit(0);
}

const dirs = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter(d => d.isDirectory());
let built = 0;

for (const ent of dirs) {
  const dir      = path.join(pluginsDir, ent.name);
  const tsPath   = path.join(dir, 'index.ts');
  const jsPath   = path.join(dir, 'index.js');
  const metaPath = path.join(dir, 'plugin.json');

  if (!fs.existsSync(tsPath) || !fs.existsSync(metaPath)) continue;

  const source = fs.readFileSync(tsPath, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module:          ts.ModuleKind.CommonJS,
      target:          ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: tsPath,
  });

  fs.writeFileSync(jsPath, out.outputText, 'utf8');
  built++;
  console.log(`[build-plugins] ${ent.name}/index.js`);
}

console.log(`[build-plugins] Tamamlandı: ${built} plugin derlendi.`);
