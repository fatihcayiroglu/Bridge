'use strict';

const fs = require('fs');
const path = require('path');

const sourceRoot = path.resolve(__dirname, '..', 'db', 'migrations_pg');
const targetRoot = path.resolve(__dirname, '..', 'dist', 'db', 'migrations_pg');
const runtimeExtensions = new Set(['.sql', '.json']);

function fail(message) {
  process.stderr.write(`[copy-runtime-assets] ${message}\n`);
  process.exit(1);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return [full];
    });
}

if (!fs.existsSync(sourceRoot)) fail(`missing source directory: ${sourceRoot}`);

fs.mkdirSync(targetRoot, { recursive: true });

// Remove only generated runtime assets. Compiled JS files produced by tsc in the
// same directory must remain untouched.
if (fs.existsSync(targetRoot)) {
  for (const file of walk(targetRoot)) {
    if (runtimeExtensions.has(path.extname(file))) fs.rmSync(file);
  }
}

let copied = 0;
for (const source of walk(sourceRoot)) {
  if (!runtimeExtensions.has(path.extname(source))) continue;
  const relative = path.relative(sourceRoot, source);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied += 1;
}

const upCount = fs.readdirSync(sourceRoot).filter((name) => name.endsWith('.sql')).length;
const downRoot = path.join(sourceRoot, 'rollback');
const downCount = fs.existsSync(downRoot)
  ? fs.readdirSync(downRoot).filter((name) => name.endsWith('.down.sql')).length
  : 0;

if (upCount === 0 || downCount === 0) fail('migration chain is empty');
if (upCount !== downCount) fail(`up/down count mismatch: ${upCount}/${downCount}`);

const copiedUp = fs.readdirSync(targetRoot).filter((name) => name.endsWith('.sql')).length;
const copiedDownRoot = path.join(targetRoot, 'rollback');
const copiedDown = fs.existsSync(copiedDownRoot)
  ? fs.readdirSync(copiedDownRoot).filter((name) => name.endsWith('.down.sql')).length
  : 0;

if (copiedUp !== upCount || copiedDown !== downCount) {
  fail(`copy verification failed: source ${upCount}/${downCount}, dist ${copiedUp}/${copiedDown}`);
}

process.stdout.write(`[copy-runtime-assets] copied ${copied} runtime migration assets (${upCount} up, ${downCount} down)\n`);
