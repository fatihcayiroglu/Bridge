import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frozenPreferenceControlApplies, runFrozenPreferenceControl, summarizeFrozenPreferenceEntries } from './frozen-preference-control.mjs';

const fixture = () => ({ emulatorDebug: true, select: async () => {},
  readBefore: async () => ({ available: true, preferenceMatches: true, activeChannelMatches: true }),
  freeze: async () => ({ eventObserved: true }), readFrozen: async () => ({ available: true, preferencePresent: true, preferenceMatches: true }),
  coldLaunch: async () => ({ status: 'ok', launchState: 'COLD' }),
  readBoot: async () => ({ available: true, keyAtBoot: true, expectedAtBoot: false }), cleanup: async () => {} });

test('EX02 applies only to the retained first cold-start preference mismatch, never an unrelated focus failure', () => {
  const first = { cycle: 1, phase: 'cold-start', stage: 'channel', failureEvidence: {
    preStop: { available: true, preferenceMatches: true, activeChannelMatches: true },
    ui: { bootNavigation: { available: true, expectedAtBoot: false } } } };
  const exp = { status: 'FAIL', preparation: 'PASS', phases: [first] };
  assert.equal(frozenPreferenceControlApplies(exp), true);
  for (const altered of [{ ...exp, status: 'PASS' }, { ...exp, preparation: 'FAIL' },
    { ...exp, phases: [{ ...first, stage: 'assert' }] }, { ...exp, phases: [{ ...first, cycle: 2 }] },
    { ...exp, phases: [{ ...first, failureEvidence: null }] }, null]) {
    assert.equal(frozenPreferenceControlApplies(altered), false);
  }
});

for (const [keyAtBoot, expectedAtBoot, outcome] of [[true, true, 'retained'], [false, false, 'missing'], [true, false, 'different']]) {
  test(`EX02 records ${outcome} as a measurement with strict freeze/read/stop ordering`, async () => {
    const calls = []; const options = fixture();
    for (const name of ['select', 'readBefore', 'freeze', 'readFrozen', 'coldLaunch', 'readBoot', 'cleanup']) {
      const original = options[name]; options[name] = async context => {
        calls.push(name); return name === 'readBoot' ? { available: true, keyAtBoot, expectedAtBoot } : original(context);
      };
    }
    const result = await runFrozenPreferenceControl(options);
    assert.equal(result.status, 'MEASURED'); assert.equal(result.outcome, outcome); assert.equal(result.cleanup, 'PASS');
    assert.equal(result.freezeEventObserved, true);
    assert.deepEqual(calls, ['select', 'readBefore', 'freeze', 'readFrozen', 'coldLaunch', 'readBoot', 'cleanup']);
  });
}

test('EX02 refuses physical/production scope before any mutation', async () => {
  let calls = 0; const options = fixture();
  options.select = async () => { calls++; }; options.cleanup = async () => { calls++; };
  const result = await runFrozenPreferenceControl({ ...options, emulatorDebug: false });
  assert.equal(result.status, 'FAIL'); assert.equal(result.stage, 'guard'); assert.equal(calls, 0);
});

test('EX02 preserves the failed inner CDP step without exporting raw errors or unknown step names', async () => {
  for (const name of ['session', 'storage-domain', 'freeze-listener', 'freeze', 'freeze-event', 'private owner@example.com']) {
    let launches = 0;
    const result = await runFrozenPreferenceControl({ ...fixture(),
      freeze: async ({ step }) => step(name, async () => { throw new Error('private bearer secret'); }),
      coldLaunch: async () => { launches++; },
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.stage, 'freeze');
    assert.equal(result.substep, name.startsWith('private') ? 'other' : name);
    assert.equal(result.deadlineExceeded, false);
    assert.equal(result.cleanup, 'PASS');
    assert.equal(launches, 0);
    assert.doesNotMatch(JSON.stringify(result), /private|owner@|bearer|secret/);
  }
});

test('EX02 reports a stalled CDP substep deadline and cannot advance after late completion', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const result = await runFrozenPreferenceControl({ ...fixture(), budgetMs: 10,
    freeze: async ({ step }) => {
      await step('freeze', () => pending);
      return step('freeze-event', async () => { calls.push('freeze-event'); return { eventObserved: true }; });
    },
    coldLaunch: async () => { calls.push('launch'); },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.stage, 'freeze');
  assert.equal(result.substep, 'freeze');
  assert.equal(result.deadlineExceeded, true);
  assert.equal(result.freezeEventObserved, null);
  assert.equal(result.cleanup, 'PASS');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(result.substep, 'freeze');
});

test('EX02 stops at every first operation error, keeps a fixed stage and attempts cleanup once', async () => {
  const names = ['select', 'readBefore', 'freeze', 'readFrozen', 'coldLaunch', 'readBoot'];
  const stages = ['select', 'before-read', 'freeze', 'frozen-read', 'cold-launch', 'boot-read'];
  for (let i = 0; i < names.length; i++) {
    const calls = []; const options = fixture();
    for (const name of [...names, 'cleanup']) {
      const original = options[name]; options[name] = async context => {
        calls.push(name); if (name === names[i]) throw new Error('private owner@example.com bearer token');
        return original(context);
      };
    }
    const result = await runFrozenPreferenceControl(options);
    assert.equal(result.status, 'FAIL'); assert.equal(result.stage, stages[i]);
    assert.deepEqual(calls, [...names.slice(0, i + 1), 'cleanup']);
    assert.doesNotMatch(JSON.stringify(result), /private|owner@|bearer|token/);
  }
});

test('EX02 never stops the process unless both unfrozen and frozen storage snapshots match', async () => {
  for (const [name, delta] of [['readBefore', { activeChannelMatches: false }], ['readBefore', { available: false }],
    ['freeze', { eventObserved: false }], ['readFrozen', { preferenceMatches: false }],
    ['readFrozen', { preferencePresent: false }], ['readFrozen', { available: false }]]) {
    const options = fixture(); const original = options[name];
    options[name] = async () => ({ ...await original(), ...delta });
    let launches = 0; options.coldLaunch = async () => { launches++; };
    const result = await runFrozenPreferenceControl(options);
    assert.equal(result.status, 'FAIL'); assert.equal(launches, 0); assert.equal(result.cleanup, 'PASS');
  }
});

test('EX02 rejects warm/unverified launches, missing boot evidence and cleanup failure', async () => {
  for (const overrides of [{ coldLaunch: async () => ({ status: 'ok', launchState: 'WARM' }) },
    { coldLaunch: async () => ({ status: 'unknown', launchState: 'COLD' }) },
    { readBoot: async () => ({ available: false }) },
    { cleanup: async () => { throw new Error('private'); } }]) {
    const result = await runFrozenPreferenceControl({ ...fixture(), ...overrides });
    assert.equal(result.status, 'FAIL'); assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('EX02 action deadline prevents a late frozen read from launching the app after failure', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; }); let launches = 0;
  const result = await runFrozenPreferenceControl({ ...fixture(), budgetMs: 10,
    readFrozen: async () => { await blocked; return { available: true, preferencePresent: true, preferenceMatches: true }; },
    coldLaunch: async () => { launches++; } });
  assert.equal(result.status, 'FAIL'); assert.equal(result.stage, 'frozen-read');
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(launches, 0);
});

test('frozen browser storage projection keeps all other values private and fails closed on malformed/bounded input', () => {
  const key = 'bridge:last-navigation:v1:channel:private-user:private-server';
  const rows = [['token', 'private bearer secret'], [key, 'private-channel']];
  const out = summarizeFrozenPreferenceEntries(rows, key, 'private-channel');
  assert.deepEqual(out, { available: true, preferencePresent: true, preferenceMatches: true });
  assert.doesNotMatch(JSON.stringify(out), /private|bearer|secret|token/);
  assert.deepEqual(summarizeFrozenPreferenceEntries([], key, 'private-channel'),
    { available: true, preferencePresent: false, preferenceMatches: false });
  for (const entries of [null, [[key]], [[key, 3]], [...rows, rows[1]], Array(513).fill(['k', 'v']), [['k', 'x'.repeat(262_145)]]]) {
    assert.deepEqual(summarizeFrozenPreferenceEntries(entries, key, 'private-channel'), { available: false });
  }
  assert.deepEqual(summarizeFrozenPreferenceEntries(rows, 'token', 'secret'), { available: false });
});

test('EX02 is separate, uses real CDP freezing and keeps the EX01 failure gate and original native-focus assertion', () => {
  const code = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.ok(code.indexOf('facts.androidFrozenPreferenceControl =') > code.indexOf("log('EX01 separate lifecycle experiment'"));
  assert.match(code, /controlPage\.context\(\)\.newCDPSession\(controlPage\)/);
  assert.match(code, /session\.send\('Page\.setWebLifecycleState', \{ state: 'frozen' \}\)/);
  assert.match(code, /session\.send\('DOMStorage\.getDOMStorageItems'/);
  assert.match(code, /document\.addEventListener\('freeze'/);
  assert.match(code, /expression: 'globalThis\.__bridgeEx02FreezeReady', awaitPromise: true/);
  assert.match(code, /emulatorDebug: facts\.device\?\.qemu === '1' && PKG === 'com\.bridge\.app\.debug'/);
  assert.match(code, /facts\.androidLifecycleExperiment\?\.status === 'FAIL' \? 1 : 0/);
  const lifecycle = readFileSync(new URL('./lifecycle-reproduction.mjs', import.meta.url), 'utf8');
  assert.match(lifecycle, /events\.nativeWindowFocused === true/);
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-android.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[main, develop\]/);
  assert.doesNotMatch(workflow, /branches:.*codex\/p7-d2-expiry-read-deadline/);
});
