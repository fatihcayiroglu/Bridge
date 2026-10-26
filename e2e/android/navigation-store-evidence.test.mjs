import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { navigationStoreVerdict, parseNavigationStoreLog } from './navigation-store-evidence.mjs';

const ok = [
  'I/BridgeNavStore( 4321): event=requested seq=1 kind=channel op=put',
  'I/BridgeNavStore( 4321): event=committed seq=1 kind=channel op=put ms=3',
  'I/BridgeNavStore( 4999): event=boot-read entries=2',
].join('\n');

test('#490 counts acknowledged commits and boot reads', () => {
  const evidence = parseNavigationStoreLog(ok, { identifiers: ['user-123456', 'server-abcdef'] });
  assert.deepEqual(evidence, {
    available: true, requested: 1, committed: 1, failed: 0, bootReads: 1, readFailed: 0, malformed: 0, identifierLeak: false,
  });
  assert.equal(navigationStoreVerdict(evidence, { lifecyclePassed: true }), 'PASS');
});

test('#490 an identifier in a native log line fails closed and is never exported', () => {
  const raw = `${ok}\nI/BridgeNavStore( 4321): event=committed seq=2 kind=channel op=put ms=3 user-123456`;
  const evidence = parseNavigationStoreLog(raw, { identifiers: ['user-123456'] });
  assert.equal(evidence.identifierLeak, true);
  assert.equal(evidence.malformed, 1);
  assert.equal(navigationStoreVerdict(evidence, { lifecyclePassed: true }), 'FAIL');
  assert.ok(!JSON.stringify(evidence).includes('user-123456'));
});

test('#490 native commit or read failures are FAIL, never PASS', () => {
  for (const line of [
    'I/BridgeNavStore( 1): event=failed seq=3 kind=channel op=put code=commit_failed',
    'I/BridgeNavStore( 1): event=read-failed code=main_thread',
  ]) {
    assert.equal(navigationStoreVerdict(parseNavigationStoreLog(`${ok}\n${line}`), { lifecyclePassed: false }), 'FAIL');
  }
});

test('#490 missing evidence is UNVERIFIED, or FAIL once EX01 passed', () => {
  const requestOnly = parseNavigationStoreLog('I/BridgeNavStore( 1): event=requested seq=1 kind=channel op=put');
  assert.equal(navigationStoreVerdict(requestOnly, { lifecyclePassed: false }), 'UNVERIFIED');
  assert.equal(navigationStoreVerdict(requestOnly, { lifecyclePassed: true }), 'FAIL');
  assert.equal(navigationStoreVerdict(parseNavigationStoreLog(undefined), { lifecyclePassed: false }), 'UNVERIFIED');
  assert.equal(navigationStoreVerdict(parseNavigationStoreLog(''), { lifecyclePassed: true }), 'FAIL');
});

test('#490 EX01 requires a native commit acknowledgment before every force-stop and gates the exit code', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const prepareAck = source.indexOf("facts.ex01PreferenceDurableBeforeColdLaunch =");
  const firstRun = source.indexOf('run: async (phase, cycle');
  assert.ok(prepareAck > 0 && prepareAck < firstRun);
  const coldBranch = source.indexOf("} else if (phase === 'cold-start') {");
  const ack = source.indexOf("await step('durable'", coldBranch);
  const forceStop = source.indexOf("platform.coldLaunch('', { shell })", coldBranch);
  assert.ok(ack > coldBranch && forceStop > ack);
  assert.match(source, /const navigationStoreFailed = facts\.androidNavigationStoreEvidence\?\.status === 'FAIL';/);
  assert.match(source, /process\.exit\(summary\.totals\.fail > 0 \|\| navigationStoreFailed \|\| /);
  // EX01's own channel acceptance is unchanged: the visible restored channel must match.
  assert.match(source, /await step\('channel', \(\) => until\(async \(\) => \(await activeChannel\(\)\) === expectedChannel,/);
});
