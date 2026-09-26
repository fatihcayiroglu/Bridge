#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadCanonicalSpec } = require('./openapi-contract');
const root = path.resolve(__dirname, '..');
const { spec, coverage } = loadCanonicalSpec(root);
const jsonPath = path.join(root, 'server/generated/openapi.json');
fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
console.log(`✅ Runtime OpenAPI snapshot generated: ${path.relative(root, jsonPath)} (${Object.keys(spec.paths || {}).length} paths / ${coverage.documentedOperations} operations / ${coverage.handlers} source handlers)`);
