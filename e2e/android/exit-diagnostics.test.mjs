import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicationExits, parseDependencyKillLine } from './exit-diagnostics.mjs';

test('keeps only allow-listed exit fields and redacts descriptions and credentials', () => {
  const raw = [
    'ApplicationExitInfo #0:',
    ' timestamp=2026-10-15 13:51:53.377',
    ' pid=6654 process=com.bridge.app.debug reason=12 (DEPENDENCY DIED)',
    ' subreason=0 (UNKNOWN) status=0 importance=100',
    ' description=secret token=do-not-publish owner@example.com',
    'ApplicationExitInfo #1:',
    ' pid=1426 process=com.google.android.gms.persistent reason=2 (SIGNALED)',
    ' subreason=0 (UNKNOWN) status=9 importance=100',
  ].join('\n');
  const parsed = parseApplicationExits(raw);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    at: '2026-10-15 13:51:53.377',
    pid: 6654, process: 'com.bridge.app.debug',
    reason: '12 (DEPENDENCY DIED)', subreason: '0 (UNKNOWN)',
    status: 0, importance: 100,
  });
  assert.equal(parsed[1].reason, '2 (SIGNALED)');
  assert.equal(parsed[1].status, 9);
  assert.doesNotMatch(JSON.stringify(parsed), /secret|token|example\.com/);
  assert.equal(parseApplicationExits(raw, 1).length, 1);
  assert.equal(parseApplicationExits(raw, 100).length, 2);
});

test('only reports provider and process names from ActivityManager kill logs', () => {
  const log = 'Killing 6654:com.bridge.app.debug (adj 0): depends on provider com.google.android.gms/.fonts.provider.FontsProvider in dying proc com.google.android.gms.persistent; uid=private-id';
  assert.deepEqual(parseDependencyKillLine(log, 6654), {
    provider: 'com.google.android.gms/.fonts.provider.FontsProvider',
    dyingProcess: 'com.google.android.gms.persistent',
  });
  assert.equal(parseDependencyKillLine(log, '6654;id'), null);
  assert.deepEqual(parseDependencyKillLine('other line', 6654), {
    provider: null, dyingProcess: null, killLineFound: false,
  });
  assert.doesNotMatch(JSON.stringify(parseDependencyKillLine(log, 6654)), /private-id/);
});
