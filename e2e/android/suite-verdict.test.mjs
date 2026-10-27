import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessSuiteEvidence, PRODUCT_CHECKS, PRODUCT_MEASUREMENTS } from './suite-verdict.mjs';
import { runLifecycleReproduction } from './lifecycle-reproduction.mjs';

const commit = 'a'.repeat(40);
const completeProduct = () => ({ suite: 'product', commit, evidenceCategory: 'AUTOMATED / EMULATOR',
  results: [...PRODUCT_CHECKS.map(id => ({ id, status: 'PASS' })),
    ...PRODUCT_MEASUREMENTS.map(id => ({ id, status: 'MEASURED' }))],
  totals: { pass: PRODUCT_CHECKS.length, fail: 0, skipped: 0, measured: PRODUCT_MEASUREMENTS.length } });

test('summary CLI rejects missing, malformed and structurally empty evidence with a nonzero exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-evidence-verdict-'));
  try {
    const path = join(dir, 'evidence.json');
    for (const body of [null, '{bad', '{}', 'null', '{"suite":"other","results":[]}']) {
      if (body !== null) writeFileSync(path, body);
      const run = spawnSync(process.execPath, [new URL('./suite-summary.mjs', import.meta.url).pathname, path], { encoding: 'utf8' });
      assert.equal(run.status, 1, 'invalid evidence returned success: ' + String(body));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verdict accepts the complete native inventory without converting measurements to PASS', () => {
  assert.deepEqual(assessSuiteEvidence(completeProduct(), { expectedCommit: commit }), { status: 'PASS', reason: null });
  assert.equal(PRODUCT_CHECKS.length, 36); assert.equal(PRODUCT_MEASUREMENTS.length, 12); // #209 adds SF01-SF05 (measurements only)
});

test('every omitted, failed, skipped or measurement-only mandatory check is rejected', () => {
  for (const id of PRODUCT_CHECKS) {
    for (const status of [null, 'FAIL', 'SKIPPED', 'MEASURED', 'typo']) {
      const evidence = completeProduct();
      evidence.results = evidence.results.flatMap(row => row.id !== id ? [row] : status ? [{ ...row, status }] : []);
      assert.equal(assessSuiteEvidence(evidence).status, 'FAIL', id + ':' + status);
    }
  }
  const omitted = completeProduct();
  omitted.results = omitted.results.filter(row => row.id !== 'ANR01');
  omitted.totals.pass--;
  assert.equal(assessSuiteEvidence(omitted).reason, 'incomplete-product');
});

test('independent acceptance inventory matches all declared product checks and measurements', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const product = source.slice(source.indexOf('async function main('), source.indexOf('  // EX01 runs AFTER'));
  // After EX01/EX02 only the declared #209 SF03-SF05 experiments may run, and never a check.
  const tail = source.slice(source.indexOf('  // EX01 runs AFTER'), source.indexOf('\nmain()\n'));
  assert.deepEqual([...tail.matchAll(/await check\('([A-Z0-9-]+)'/g)].map(m => m[1]), []);
  assert.deepEqual([...tail.matchAll(/await measure\('([A-Z0-9-]+)'/g)].map(m => m[1]), ['SF03', 'SF04', 'SF05']);
  assert.deepEqual([...product.matchAll(/await check\('([A-Z0-9-]+)'/g)].map(m => m[1]).sort(), [...PRODUCT_CHECKS].sort());
  assert.deepEqual([...`${product}${tail}`.matchAll(/await measure\('([A-Z0-9-]+)'/g)].map(m => m[1]).sort(),
    [...PRODUCT_MEASUREMENTS].sort());
});

test('measurements cannot be omitted, counted as PASS or renamed to hide an unknown check', () => {
  for (const id of PRODUCT_MEASUREMENTS) {
    for (const delta of [null, { status: 'PASS' }, { id: 'UNEXPECTED' }]) {
      const evidence = completeProduct();
      evidence.results = evidence.results.flatMap(row => row.id !== id ? [row] : delta ? [{ ...row, ...delta }] : []);
      assert.equal(assessSuiteEvidence(evidence).status, 'FAIL', id);
    }
  }
});

test('invalid/stale commit, wrong suite, dry-run category and inconsistent totals cannot pass', () => {
  const good = completeProduct();
  for (const delta of [{ commit: null }, { commit: 'bad' }, { suite: 'other' },
    { evidenceCategory: 'DRYRUN (harness debugging only — NOT evidence)' },
    { totals: { pass: 37, fail: 0, skipped: 0, measured: 6 } }, { totals: null },
    { results: [] }, { results: null }, { results: [...good.results, good.results[0]] },
    { results: [...good.results, { id: 'HARNESS', status: 'FAIL' }] },
    { results: [...good.results, null] }, { results: [...good.results, { id: 'secret owner@example.com', status: 'PASS' }] },
  ]) assert.equal(assessSuiteEvidence({ ...good, ...delta }).status, 'FAIL');
  assert.equal(assessSuiteEvidence(good, { expectedCommit: 'b'.repeat(40) }).reason, 'unexpected-commit');
});

test('upstream control profile is explicit and a control failure never becomes a passing measurement', () => {
  const evidence = { ...completeProduct(), suite: 'upstream-webview-controls', results: [{ id: 'CS00', status: 'MEASURED' }],
    totals: { pass: 0, fail: 0, skipped: 0, measured: 1 } };
  assert.equal(assessSuiteEvidence(evidence).status, 'FAIL');
  assert.equal(assessSuiteEvidence(evidence, { expectedSuite: evidence.suite }).status, 'PASS');
  evidence.results[0].status = 'FAIL'; evidence.totals = { pass: 0, fail: 1, skipped: 0, measured: 0 };
  assert.equal(assessSuiteEvidence(evidence, { expectedSuite: evidence.suite }).status, 'FAIL');
});

test('summary CLI enforces real verdict and expected head even with passing CR00 and EX01 fixtures', async () => {
  const experiment = await runLifecycleReproduction({ prepare: async () => {}, clock: async () => ({}),
    run: async phase => ({ beforePid: '123', afterPid: '123', launchState: phase === 'hot-resume' ? 'HOT' : 'COLD',
      uiVisible: true, channelMatched: true, focused: true }),
    observe: async () => ({ available: true, coverage: 'observed-only', anrCount: 0, nativeWindowFocused: true,
      dialogs: { available: true, anrDialogs: 0 } }), failureEvidence: async () => null });
  const dir = mkdtempSync(join(tmpdir(), 'bridge-native-verdict-'));
  try {
    writeFileSync(join(dir, 'java-crash-control.json'), JSON.stringify({ case: 'CR00', commit, status: 'PASS', evidenceCategory: 'AUTOMATED / EMULATOR' }));
    const path = join(dir, 'evidence.json');
    for (const [modify, expectedHead, status] of [
      [e => e, commit, 0], [e => e, 'b'.repeat(40), 1],
      [e => ({ ...e, results: e.results.slice(1) }), commit, 1],
      [e => ({ ...e, results: e.results.map((row, i) => i ? row : { ...row, status: 'FAIL' }) }), commit, 1],
      [e => ({ ...e, results: e.results.map((row, i) => i ? row : { ...row, status: 'SKIPPED' }) }), commit, 1],
    ]) {
      writeFileSync(path, JSON.stringify(modify({ ...completeProduct(), facts: { androidLifecycleExperiment: experiment } })));
      const run = spawnSync(process.execPath, [new URL('./suite-summary.mjs', import.meta.url).pathname, path], {
        encoding: 'utf8', env: { ...process.env, GITHUB_SHA: expectedHead, ANDROID_JOURNEY_SUITE: 'product' } });
      assert.equal(run.status, status, run.stdout + run.stderr);
      assert.match(run.stdout, /EX01 controlled lifecycle reproduction/);
      assert.match(run.stdout, /CR00 Java crash diagnostic calibration/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
