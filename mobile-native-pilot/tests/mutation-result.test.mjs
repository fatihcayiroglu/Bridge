import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyNodeRun } from '../scripts/mutation-result.mjs';
const summary = (fail = 0, cancelled = 0) => `# tests 2\n# pass ${2 - fail - cancelled}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped 0\n# todo 0\n`;
test('failed and cancelled tests are counted, never called surviving mutants', () => {
  for (const [fail, cancelled] of [[1, 0], [0, 1], [0, 2]]) {
    const result = classifyNodeRun({ stdout: summary(fail, cancelled), status: 1 });
    assert.equal(result.outcome, 'DETECTED');
    assert.equal(result.counts.cancelled, cancelled);
  }
  assert.equal(classifyNodeRun({ stdout: summary(), status: 0 }).outcome, 'SURVIVED');
});
test('timeouts, crashes, missing summaries and skipped tests are not clean survivors', () => {
  assert.equal(classifyNodeRun({ stdout: summary(), status: null, error: { code: 'ETIMEDOUT' } }).outcome, 'TIMEOUT');
  assert.equal(classifyNodeRun({ stdout: '', status: 1 }).outcome, 'INVALID');
  assert.equal(classifyNodeRun({ stdout: summary().replace('# skipped 0', '# skipped 1'), status: 0 }).outcome, 'INVALID');
  assert.equal(classifyNodeRun({ stdout: summary(0, 1), status: 0 }).outcome, 'INVALID');
});
test('an actual unresolved Node test reports cancellation and is detected', () => {
  const fixture = join(mkdtempSync(join(tmpdir(), 'bridge-cancelled-test-')), 'cancelled.test.mjs');
  writeFileSync(fixture, "import { test } from 'node:test'; test('unresolved', { timeout: 50 }, () => new Promise(() => {}));");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { encoding: 'utf8', timeout: 5000, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = classifyNodeRun(run);
  assert.equal(result.outcome, 'DETECTED', JSON.stringify({ ...run, result }));
  assert.equal(result.counts.cancelled, 1);
});
