import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertDesktopResults } = require('./assert-desktop-results.cjs');

function valid() {
  return { suites: [{ specs: [{ tests: ['desktop-chromium', 'desktop-firefox', 'desktop-webkit']
    .flatMap(projectName => Array.from({ length: 8 }, () => ({ projectName, status: 'expected', results: [{ status: 'passed' }] }))) }] }] };
}

test('exactly 24 real first-attempt browser cases are required', () => {
  assert.equal(assertDesktopResults(valid()).executed, 24);
  const noCases = valid(); noCases.suites[0].specs[0].tests = [];
  assert.throws(() => assertDesktopResults(noCases), /DESKTOP_TEST_COUNT_MISMATCH/);
});

test('one skipped result fails the entire matrix', () => {
  const bad = valid(); bad.suites[0].specs[0].tests[3].status = 'skipped'; bad.suites[0].specs[0].tests[3].results = [];
  assert.throws(() => assertDesktopResults(bad), /NOT_EXECUTED_OR_NOT_PASSED/);
});

test('a passing retry does not count as a first-attempt PASS', () => {
  const bad = valid(); bad.suites[0].specs[0].tests[0].results = [{ status: 'failed' }, { status: 'passed' }];
  assert.throws(() => assertDesktopResults(bad), /NOT_EXECUTED_OR_NOT_PASSED/);
});

test('one browser absent cannot be mislabeled as full cross-engine coverage', () => {
  const bad = valid(); bad.suites[0].specs[0].tests[8].projectName = 'desktop-chromium';
  assert.throws(() => assertDesktopResults(bad), /BROWSER_COVERAGE_MISSING/);
});
