#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { loadCanonicalSpec } = require('./openapi-contract');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { spec, specPath, packageVersion, coverage } = loadCanonicalSpec(root);
  // SwaggerParser.validate() DEREFERENCES ITS ARGUMENT IN PLACE (every local
  // $ref is replaced by the resolved node, growing the document by ~30%).
  // Serialize the canonical document first and hand the validator a throwaway
  // clone, otherwise the snapshot comparison below would forever compare a
  // dereferenced object against the raw generated file and never pass.
  const canonicalJson = JSON.stringify(spec);
  await SwaggerParser.validate(structuredClone(spec));
  const runtimePath = path.join(root, 'server/generated/openapi.json');
  if (!fs.existsSync(runtimePath)) throw new Error('Runtime OpenAPI snapshot is missing; run npm run generate:openapi-runtime');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  if (JSON.stringify(runtime) !== canonicalJson) throw new Error('Runtime OpenAPI snapshot drift; run npm run generate:openapi-runtime');
  console.log(`✅ OpenAPI valid: ${path.relative(root, specPath)} v${packageVersion}; ${Object.keys(spec.paths || {}).length} paths / ${coverage.documentedOperations} operations / ${coverage.handlers} source handlers; local refs=0 broken`);
})().catch((err) => {
  console.error(`❌ OpenAPI validation failed: ${err?.message || err}`);
  process.exit(1);
});
