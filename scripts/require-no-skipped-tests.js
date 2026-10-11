#!/usr/bin/env node
/**
 * scripts/require-no-skipped-tests.js
 *
 * A RUN THAT SKIPPED TESTS IS NOT A PASS
 *
 * Several suites decide at load time whether they can run and otherwise fall back
 * to `describe.skip`:
 *   - server/tests/pg-integration: 20 suites need PG_TEST_URL (test:pg already
 *     fails closed without it), 4 need REDIS_TEST_URL and 1 MINIO_TEST_ENDPOINT
 *     (nothing checked those);
 *   - mobile/tests: the packaged-shell suites need a built client bundle — at the
 *     B2 head the mobile step reported 105 passed / 22 skipped and stayed green.
 * If CI ever loses one of those env variables or build steps, Jest still exits 0.
 *
 * This reads a Jest `--json` result and fails when it reports any skipped
 * (pending) or todo test, or no test at all, naming each skipped test so the
 * missing prerequisite is obvious. It does not decide what may skip: a step that
 * legitimately skips (e.g. the Windows-only Electron test on Linux) simply does
 * not use it.
 *
 * Usage:
 *   node scripts/require-no-skipped-tests.js <jest-results.json> [--label <name>]
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Returns the problems found in a parsed Jest JSON result (empty = clean). */
function skippedTestProblems(result, rootDir = process.cwd()) {
  const problems = [];
  if (!result || typeof result !== 'object' || !Array.isArray(result.testResults)) {
    return ['not a Jest --json result (no testResults array)'];
  }
  const total = Number(result.numTotalTests) || 0;
  if (total === 0) problems.push('the run collected 0 tests');
  const skipped = [];
  for (const file of result.testResults) {
    const rel = path.relative(rootDir, String(file.name || file.testFilePath || '?'));
    for (const t of file.assertionResults || []) {
      if (t.status === 'pending' || t.status === 'skipped' || t.status === 'todo' || t.status === 'disabled') {
        skipped.push(`${rel} › ${t.fullName || t.title} (${t.status})`);
      }
    }
  }
  const counted = (Number(result.numPendingTests) || 0) + (Number(result.numTodoTests) || 0);
  if (skipped.length || counted) {
    problems.push(`${Math.max(skipped.length, counted)} test(s) skipped or todo:`);
    for (const s of skipped) problems.push(`  - ${s}`);
  }
  return problems;
}

function main(argv) {
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--label');
  const labelAt = argv.indexOf('--label');
  const label = labelAt >= 0 ? argv[labelAt + 1] : file;
  if (!file) {
    console.error('usage: require-no-skipped-tests.js <jest-results.json> [--label <name>]');
    return 2;
  }
  let result;
  try {
    result = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✖ ${label}: cannot read ${file}: ${err.message}`);
    return 1;
  }
  const problems = skippedTestProblems(result);
  if (problems.length) {
    console.error(`✖ ${label}: a run that skipped tests is not a pass`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('  A skipped suite here means its prerequisite (env variable, service or build step) is missing.');
    return 1;
  }
  console.log(`✅ ${label}: ${result.numPassedTests}/${result.numTotalTests} tests executed, 0 skipped`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { skippedTestProblems, main };
