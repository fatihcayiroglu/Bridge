'use strict';
// node --test scripts/require-no-skipped-tests.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { skippedTestProblems } = require('./require-no-skipped-tests');

const SCRIPT = path.join(__dirname, 'require-no-skipped-tests.js');

function result(statuses, extra = {}) {
  const assertionResults = statuses.map((status, i) => ({ status, title: `t${i}`, fullName: `suite t${i}` }));
  const count = (s) => statuses.filter((x) => x === s).length;
  return {
    numTotalTests: statuses.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('pending'),
    numTodoTests: count('todo'),
    testResults: [{ name: path.join(process.cwd(), 'tests', 'a.test.ts'), assertionResults }],
    ...extra,
  };
}

function run(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-skip-'));
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, file, '--label', 'x'], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { code: err.status, out: String(err.stderr) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a run where every collected test executed is clean', () => {
  assert.deepEqual(skippedTestProblems(result(['passed', 'passed'])), []);
  assert.equal(run(result(['passed'])).code, 0);
});

test('a skipped test fails the step and is named', () => {
  const r = run(result(['passed', 'pending']));
  assert.equal(r.code, 1);
  assert.match(r.out, /1 test\(s\) skipped or todo/);
  assert.match(r.out, /tests\/a\.test\.ts › suite t1 \(pending\)/);
});

test('a todo test fails the step', () => {
  assert.equal(run(result(['passed', 'todo'])).code, 1);
});

test('a run that collected nothing fails the step', () => {
  const r = run(result([]));
  assert.equal(r.code, 1);
  assert.match(r.out, /collected 0 tests/);
});

test('a describe.skip suite counted only in the totals still fails', () => {
  // Jest may report a whole skipped file in numPendingTests without per-test rows.
  const r = run({ ...result(['passed']), numPendingTests: 3 });
  assert.equal(r.code, 1);
  assert.match(r.out, /3 test\(s\) skipped or todo/);
});

test('an unreadable or foreign file fails instead of passing', () => {
  assert.equal(run('not json').code, 1);
  assert.equal(run({ ok: true }).code, 1);
});
