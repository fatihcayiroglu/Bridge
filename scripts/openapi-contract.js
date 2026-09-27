'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const METHODS = new Set(['get','post','put','patch','delete','options','head','trace']);

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function localRefErrors(spec) {
  const components = spec.components || {};
  const inventory = new Map(Object.entries(components).map(([kind, value]) => [kind, new Set(Object.keys(value || {}))]));
  const errors = [];
  const visit = (value, at = '#') => {
    if (Array.isArray(value)) return value.forEach((item, i) => visit(item, `${at}/${i}`));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/')) {
        const [, , kind, name] = child.split('/');
        if (!inventory.get(kind)?.has(name)) errors.push(`${at}: ${child}`);
      }
      visit(child, `${at}/${key}`);
    }
  };
  visit(spec);
  return errors;
}

// ── Structural contracts the OAS 3.1 meta-schema alone did not protect ──────
// Every class enumerated below was live in the shipped 1.125.0 tree:
//   · 16 component schemas leaked INTO a path item (/admin/marketplace/refresh)
//   · 29 response objects with no `description` (required by the Response Object)
//   · 3 responses whose unquoted flow-mapping description split on `,` into
//     null-valued garbage keys (`mesaj: null`)
//   · 24 paths documented with a redundant `/api` prefix even though every
//     servers[].url already ends in `/api`, so published URLs resolved to
//     `/api/api/...`; 9 of them duplicated a correctly named twin that
//     documented a response shape the handler never returns.
const PATH_ITEM_KEYS = new Set([...METHODS, 'summary', 'description', 'servers', 'parameters', '$ref']);
const RESPONSE_KEYS = new Set(['description', 'headers', 'content', 'links', 'summary', '$ref']);

function structuralErrors(spec) {
  const errors = [];
  // Swagger UI groups operations by tag. The shipped tree declared exactly one
  // root tag (an unused stub) while 53 tag names were in use, nine of which
  // were case-split duplicates (`auth` and `Auth`) that split one logical
  // group into two undocumented sections.
  const declaredTags = new Set((spec.tags || []).map((tag) => tag && tag.name).filter(Boolean));
  const usedTags = new Set();
  for (const item of Object.values(spec.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.has(method.toLowerCase())) continue;
      for (const tag of (op && op.tags) || []) usedTags.add(tag);
    }
  }
  for (const tag of usedTags) {
    if (!declaredTags.has(tag)) errors.push(`operation tag "${tag}" is not declared under the root tags list`);
  }
  for (const tag of declaredTags) {
    if (!usedTags.has(tag)) errors.push(`root tag "${tag}" is declared but no operation uses it`);
  }
  for (const [pathKey, item] of Object.entries(spec.paths || {})) {
    if (pathKey.startsWith('/api/')) {
      errors.push(`path "${pathKey}" repeats the /api prefix already present in servers[].url`);
    }
    if (!item || typeof item !== 'object') continue;
    for (const key of Object.keys(item)) {
      if (!PATH_ITEM_KEYS.has(key.toLowerCase())) {
        errors.push(`path "${pathKey}" carries non-path-item key "${key}"; component definitions belong under components`);
      }
    }
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.has(method.toLowerCase())) continue;
      if (!op || typeof op !== 'object') continue;
      const where = `${method.toUpperCase()} ${pathKey}`;
      if (!op.responses || typeof op.responses !== 'object' || !Object.keys(op.responses).length) {
        errors.push(`${where} declares no responses`);
        continue;
      }
      const seen = new Set();
      for (const [code, response] of Object.entries(op.responses)) {
        const normalized = String(code).trim();
        if (seen.has(normalized)) errors.push(`${where} declares status ${normalized} twice`);
        seen.add(normalized);
        if (!response || typeof response !== 'object') {
          errors.push(`${where} response ${normalized} is not an object`);
          continue;
        }
        if (response.$ref) continue;
        for (const field of Object.keys(response)) {
          if (!RESPONSE_KEYS.has(field)) {
            errors.push(`${where} response ${normalized} carries stray key "${field}" (unquoted flow mapping?)`);
          }
        }
        if (typeof response.description !== 'string' || !response.description.trim()) {
          errors.push(`${where} response ${normalized} has no description`);
        }
      }
    }
  }
  return errors;
}

// Route-source @openapi blocks are the in-code mirror of the canonical spec.
// A block that no longer parses as YAML (duplicated path keys left behind by
// an appended legacy copy) is stale documentation nobody can consume.
function annotationErrors(root) {
  const errors = [];
  const blockPattern = /\/\*\*([\s\S]*?)\*\//g;
  for (const file of walkFiles(path.join(root, 'server/routes'))) {
    const source = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = blockPattern.exec(source)) !== null) {
      const body = match[1];
      if (!/@(?:openapi|swagger)\b/.test(body)) continue;
      const text = body
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, ''))
        .filter((line) => !/^@(?:openapi|swagger)\s*$/.test(line.trim()))
        .join('\n');
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const where = `${rel}:${source.slice(0, match.index).split('\n').length}`;
      let doc;
      try {
        doc = yaml.load(text);
      } catch (err) {
        errors.push(`${where}: @openapi block is not valid YAML (${String(err.message).split('\n')[0]})`);
        continue;
      }
      if (!doc || typeof doc !== 'object') continue;
      for (const key of Object.keys(doc)) {
        if (key.startsWith('/api/')) errors.push(`${where}: annotated path "${key}" repeats the /api prefix`);
      }
    }
  }
  return errors;
}

function sourceCoverage(root, spec) {
  const routeRoot = path.join(root, 'server/routes');
  let routeFiles = 0;
  let handlers = 0;
  const undocumentedFiles = [];
  const handlerPattern = /\brouter\.(get|post|put|patch|delete)\s*\(/g;
  for (const file of walkFiles(routeRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const count = [...source.matchAll(handlerPattern)].length;
    if (!count) continue;
    routeFiles += 1;
    handlers += count;
    if (!source.includes('@openapi') && !source.includes('@swagger')) {
      undocumentedFiles.push(path.relative(root, file).replace(/\\/g, '/'));
    }
  }
  const documentedOperations = Object.values(spec.paths || {}).reduce((sum, item) => {
    if (!item || typeof item !== 'object') return sum;
    return sum + Object.keys(item).filter((method) => METHODS.has(method.toLowerCase())).length;
  }, 0);
  return { routeFiles, handlers, documentedOperations, undocumentedFiles };
}

function loadCanonicalSpec(root = path.resolve(__dirname, '..')) {
  const specPath = path.join(root, 'docs/api/openapi.yaml');
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
  if (!spec || typeof spec !== 'object') throw new Error('OpenAPI YAML did not produce an object');
  if (spec.openapi !== '3.1.0') throw new Error(`OpenAPI version must be 3.1.0, got ${spec.openapi}`);
  const packageVersion = require(path.join(root, 'package.json')).version;
  if (spec.info?.version !== packageVersion) throw new Error(`OpenAPI info.version drift: ${spec.info?.version} != ${packageVersion}`);
  if (!spec.paths || typeof spec.paths !== 'object') throw new Error('OpenAPI paths missing');
  const refErrors = localRefErrors(spec);
  if (refErrors.length) throw new Error(`Missing local $ref pointers (${refErrors.length}):\n${refErrors.slice(0, 12).join('\n')}`);
  const structural = structuralErrors(spec);
  if (structural.length) throw new Error(`OpenAPI structural contract violations (${structural.length}):\n${structural.slice(0, 15).join('\n')}`);
  const annotations = annotationErrors(root);
  if (annotations.length) throw new Error(`Route @openapi annotation violations (${annotations.length}):\n${annotations.slice(0, 15).join('\n')}`);
  const coverage = sourceCoverage(root, spec);
  if (coverage.undocumentedFiles.length) throw new Error(`Route source missing @openapi metadata: ${coverage.undocumentedFiles.join(', ')}`);
  if (coverage.documentedOperations < coverage.handlers) {
    throw new Error(`OpenAPI operation coverage regressed: ${coverage.documentedOperations} documented < ${coverage.handlers} route handlers`);
  }
  return { spec, specPath, packageVersion, coverage };
}

module.exports = { loadCanonicalSpec, localRefErrors, sourceCoverage, structuralErrors, annotationErrors };
