#!/usr/bin/env node
'use strict';

/**
 * Ratcheted TypeScript strictness gate.
 *
 * Two strictness projects in this tree were declared as gates but had never
 * been green, so they protected nothing:
 *
 *   · `tsconfig.hardening.json`   — 158 errors. Only one of them was in a
 *     declared owner (`routes/sso.ts`); the rest were in production modules the
 *     owners transitively import, which the include list never claimed.
 *   · `tsconfig.test-strict.json` — 6701 errors. It also dropped `types/**`
 *     from `include`, so the Express `Request.user` augmentation was absent and
 *     hundreds of *production* files failed inside a *test* gate.
 *
 * `npm test` chains the second one, so `cd server && npm test` could not run at
 * all. A gate that is red 100% of the time is indistinguishable from no gate.
 *
 * This runner keeps the strict compiler settings and turns the remaining
 * errors into an explicit, monotone debt ledger (`server/TYPE_DEBT.json`),
 * exactly like `COVERAGE_DEBT.json` and the migration rollback classification.
 * It fails when:
 *
 *   · a file that is NOT in the ledger reports an error  (new regression)
 *   · a ledger file reports MORE errors than recorded    (regression in debt)
 *   · a ledger file reports zero errors                  (ledger must shrink)
 *   · a ledger file no longer exists                     (stale entry)
 *
 * Debt can only go down. Fixing a file and forgetting to drop its ledger entry
 * is itself a failure, so the list cannot rot.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(SERVER_ROOT, 'TYPE_DEBT.json');
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

function parseArgs(argv) {
  const args = { project: null, bucket: null, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--project') args.project = argv[i + 1];
    else if (flag === '--bucket') args.bucket = argv[i + 1];
    else if (flag === '--write') args.write = true;
  }
  if (!args.project || !args.bucket) {
    throw new Error('usage: check-typescript-debt.cjs --project <tsconfig> --bucket <ledgerKey> [--write]');
  }
  return args;
}

// Resolve the compiler entry point directly and drive it with the current Node
// binary: no shell, so the ledger cannot be skewed by shell quoting, and the
// gate behaves identically on Windows and POSIX CI runners.
const TSC_ENTRY = require.resolve('typescript/bin/tsc', { paths: [SERVER_ROOT] });

function runTsc(extraArgs) {
  const result = spawnSync(process.execPath, [TSC_ENTRY, ...extraArgs], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function bucketErrors(output) {
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    const file = match[1].split(path.sep).join('/').replace(/^\.\//, '');
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return counts;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) throw new Error(`Missing type debt ledger: ${LEDGER_PATH}`);
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = runTsc(['-p', args.project, '--noEmit']);
  const counts = bucketErrors(output);
  const ledger = loadLedger();

  if (args.write) {
    const section = ledger[args.bucket] || {};
    section.files = Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    ledger[args.bucket] = section;
    fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    console.log(`[type-debt] ledger "${args.bucket}" rewritten with ${counts.size} file(s).`);
    return;
  }

  const declared = (ledger[args.bucket] && ledger[args.bucket].files) || {};
  const problems = [];
  let debtErrors = 0;

  for (const [file, count] of counts) {
    if (!Object.prototype.hasOwnProperty.call(declared, file)) {
      problems.push(`NEW: ${file} reports ${count} strict error(s) but is not declared debt`);
      continue;
    }
    if (count > declared[file]) {
      problems.push(`GREW: ${file} reports ${count} strict error(s), ledger allows ${declared[file]}`);
    }
    debtErrors += count;
  }

  for (const [file, allowed] of Object.entries(declared)) {
    if (!fs.existsSync(path.join(SERVER_ROOT, file))) {
      problems.push(`STALE: ${file} no longer exists but is still in the ledger`);
      continue;
    }
    if (!counts.has(file)) {
      problems.push(`FIXED: ${file} is now clean (${allowed} recorded) — remove it from the ledger`);
    }
  }

  const enforcedClean = countCheckedFiles(args.project) - Object.keys(declared).length;
  if (problems.length) {
    console.error(`❌ TypeScript strictness ratchet "${args.bucket}" failed (${problems.length} issue(s)):`);
    for (const problem of problems.slice(0, 40)) console.error(`   ${problem}`);
    if (problems.length > 40) console.error(`   … ${problems.length - 40} more`);
    console.error('   Re-baseline deliberately with --write only when the ledger legitimately shrinks.');
    process.exit(1);
  }
  console.log(
    `✅ TypeScript strictness ratchet "${args.bucket}": ${Object.keys(declared).length} declared debt file(s) / `
    + `${debtErrors} declared error(s); every other checked file is strict-clean`
    + (Number.isFinite(enforcedClean) ? ` (~${Math.max(enforcedClean, 0)} enforced).` : '.'),
  );
}

function countCheckedFiles(project) {
  try {
    return runTsc(['-p', project, '--noEmit', '--listFilesOnly'])
      .split(/\r?\n/)
      .filter((line) => line && !line.includes('node_modules'))
      .length;
  } catch {
    return Number.NaN;
  }
}

try {
  main();
} catch (err) {
  console.error(`❌ TypeScript debt gate error: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
