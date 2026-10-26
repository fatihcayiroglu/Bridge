import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runLifecycleReproduction, observeLifecycleWindow, LIFECYCLE_PHASES } from './lifecycle-reproduction.mjs';
import { collectKernelPressure } from './pressure-evidence.mjs';
import { formatLifecycleExperimentSummary } from './suite-summary.mjs';

const start = { epochMs: Date.UTC(2026, 9, 26, 12), offsetMinutes: 0 };
const goodEvents = { available: true, coverage: 'observed-only', anrCount: 0,
  nativeWindowFocused: true, dialogs: { available: true, anrDialogs: 0 } };
const observation = phase => ({ beforePid: '32109', afterPid: '32109',
  launchState: phase === 'hot-resume' ? 'HOT' : 'COLD', uiVisible: true, channelMatched: true, focused: true });
const options = () => ({ prepare: async () => {}, clock: async () => start,
  run: async phase => observation(phase), observe: async () => goodEvents,
  failureEvidence: async () => ({ available: false }) });

test('EX01 executes exactly three fixed cycles and never exports raw process IDs or extra callback data', async () => {
  const calls = [];
  const result = await runLifecycleReproduction({ ...options(), run: async (phase, cycle) => {
    calls.push([cycle, phase]); return { ...observation(phase), secret: 'owner@example.com' };
  } });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, [1, 2, 3].flatMap(n => LIFECYCLE_PHASES.map(p => [n, p])));
  assert.doesNotMatch(JSON.stringify(result), /32109|owner@|secret|beforePid|afterPid/);
  assert.equal(formatLifecycleExperimentSummary({ facts: { androidLifecycleExperiment: result } }).status, 'PASS');
});

for (let failing = 1; failing <= 9; failing++) {
  test(`EX01 stops at first failing phase ${failing}, preserving evidence before any later launch`, async () => {
    const calls = []; let count = 0;
    const result = await runLifecycleReproduction({ ...options(), run: async phase => {
      calls.push('launch');
      if (++count === failing) throw new Error('private path https://owner@example.com/token');
      return observation(phase);
    }, failureEvidence: async origin => { assert.equal(origin, start); calls.push('evidence'); return { available: false }; } });
    assert.equal(result.status, 'FAIL'); assert.equal(result.phases.length, failing);
    assert.equal(result.phases.at(-1).stage, 'run');
    assert.deepEqual(calls, [...Array(failing).fill('launch'), 'evidence']);
    assert.doesNotMatch(JSON.stringify(result), /private|https|owner@|token/);
  });
}

test('EX01 preparation, missing clock and unreadable failure diagnostics cannot pass', async () => {
  let calls = 0;
  for (const overrides of [
    { prepare: async () => { throw new Error('private'); } },
    { clock: async () => null },
  ]) {
    const result = await runLifecycleReproduction({ ...options(), ...overrides,
      run: async () => { calls++; }, failureEvidence: async () => { throw new Error('secret'); } });
    assert.equal(result.status, 'FAIL'); assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  }
  assert.equal(calls, 0);
});

test('EX01 rejects process replacement, unknown PIDs, stale UI/channel, lost focus and non-COLD cold starts', async () => {
  for (const delta of [{ afterPid: '999' }, { beforePid: null, afterPid: null }, { beforePid: '1 2' },
    { uiVisible: false }, { channelMatched: false }, { focused: false }, { launchState: 'HOT' }]) {
    const result = await runLifecycleReproduction({ ...options(), run: async phase => ({ ...observation(phase), ...delta }) });
    assert.equal(result.status, 'FAIL', JSON.stringify(delta)); assert.equal(result.phases.length, 1);
  }
});

test('EX01 never relabels a COLD resume as HOT', async () => {
  const result = await runLifecycleReproduction({ ...options(), run: async phase => ({ ...observation(phase), launchState: 'COLD' }) });
  assert.equal(result.status, 'FAIL'); assert.equal(result.phases.length, 2);
  assert.equal(result.phases[1].phase, 'hot-resume');
});

test('EX01 rejects ANRs, incomplete event observation, unavailable dialogs and wrong native focus', async () => {
  for (const delta of [{ available: false }, { coverage: 'partial' }, { anrCount: 1 },
    { nativeWindowFocused: false }, { nativeWindowFocused: null }, { dialogs: { available: false, anrDialogs: 0 } },
    { dialogs: { available: true, anrDialogs: 1 } }]) {
    const result = await runLifecycleReproduction({ ...options(), observe: async () => ({ ...goodEvents, ...delta }) });
    assert.equal(result.status, 'FAIL', JSON.stringify(delta)); assert.equal(result.phases.length, 1);
  }
});

test('EX01 phase deadline aborts pending shell sequencing before a delayed second mutation', async () => {
  let release; let mutations = 0; const blocked = new Promise(resolve => { release = resolve; });
  const result = await runLifecycleReproduction({ ...options(), budgetMs: 10,
    run: async (_phase, _cycle, { step }) => {
      await step('launch', () => blocked);
      await step('resume', async () => { mutations++; });
    } });
  assert.equal(result.status, 'FAIL'); assert.equal(result.phases[0].stage, 'launch');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutations, 0);
});

test('EX01 summary refuses missing, partial, reordered or internally inconsistent results', async () => {
  const good = await runLifecycleReproduction(options());
  for (const change of [null, { ...good, status: 'FAIL' }, { ...good, phases: good.phases.slice(0, 8) },
    { ...good, phases: [...good.phases].reverse() },
    { ...good, phases: good.phases.map((row, i) => i ? row : { ...row, clockAvailable: false }) },
    { ...good, phases: good.phases.map((row, i) => i ? row : { ...row, observation: { ...row.observation, pidStable: false } }) },
  ]) assert.equal(formatLifecycleExperimentSummary({ facts: { androidLifecycleExperiment: change } }).status, 'FAIL');
});

const pkg = 'com.bridge.app.debug';
const endClock = offset => `${(start.epochMs + offset) / 1000}.000000000,2026-10-26T12:00:${String(offset / 1000).padStart(2, '0')},+0000`;
const window = `mCurrentFocus=Window{abc u0 ${pkg}/com.bridge.app.MainActivity}`;
const event = (offset, name = pkg) => `${((start.epochMs + offset) / 1000).toFixed(3)} 123 123 I am_anr: [0,456,${name},0,FocusEvent private owner@example.com]`;
const shell = (raw = '', windows = window, clock = endClock(10_000)) => async command =>
  command.startsWith('logcat ') ? raw : command === 'dumpsys window' || command === 'dumpsys window windows' ? windows : clock;

test('EX01 reads display focus and window/dialog records from the full API34 window dump', async () => {
  const io = async command => command === 'dumpsys window windows'
    ? `Window #0 Window{abc u0 ${pkg}/com.bridge.app.MainActivity}`
    : shell()(command);
  assert.equal((await observeLifecycleWindow(io, pkg, start)).nativeWindowFocused, true);
});

test('EX01 reuses the actual ANR parser and scopes events to exact package and device-clock window', async () => {
  const result = await observeLifecycleWindow(shell([event(-1), event(5000, pkg + '.other'), event(8000), event(10_001)].join('\n')), pkg, start);
  assert.equal(result.available, true); assert.equal(result.anrCount, 1);
  assert.equal(result.nativeWindowFocused, true); assert.equal(result.coverage, 'observed-only');
  assert.doesNotMatch(JSON.stringify(result), /456|owner@|private|FocusEvent|com.bridge|epochMs/);
});

test('EX01 empty readable event buffer stays observed-only, not complete', async () => {
  const result = await observeLifecycleWindow(shell(), pkg, start);
  assert.equal(result.available, true); assert.equal(result.anrCount, 0); assert.equal(result.coverage, 'observed-only');
});

test('EX01 rejects unknown/overlong clocks, malformed or truncated events, foreign native focus', async () => {
  for (const command of [shell('', window, 'bad'), shell('garbage am_anr'), shell('x'.repeat(262_145)),
    shell('', window, '1793016121.000000000,2026-10-26T12:02:01,+0000')]) {
    assert.equal((await observeLifecycleWindow(command, pkg, start)).available, false);
  }
  assert.equal((await observeLifecycleWindow(shell('', window.replace(pkg, pkg + '.other')), pkg, start)).nativeWindowFocused, false);
  assert.equal((await observeLifecycleWindow(shell('', 'mCurrentFocus=null'), pkg, start)).nativeWindowFocused, null);
  assert.equal((await observeLifecycleWindow(async () => { throw new Error('secret'); }, pkg, start)).available, false);
});

test('shared pressure probes export only bounded kernel values and never process identifiers or errors', async () => {
  const commands = [];
  const out = await collectKernelPressure(async command => {
    commands.push(command);
    if (command.endsWith('/loadavg')) return '1.23 2.34 3.45 3/999 12345';
    if (command.endsWith('/meminfo')) return 'MemTotal: 123456 kB\nMemAvailable: 65432 kB\nprivate owner@example.com';
    if (command.endsWith('/cpu')) return 'some avg10=1.00 avg60=2.00 avg300=3.00 total=999\nprivate token';
    throw new Error('secret');
  });
  assert.deepEqual(out.kernelLoadavg, [1.23, 2.34, 3.45]);
  assert.equal(out.kernelMemTotalKb, 123456); assert.equal(out.kernelMemAvailableKb, 65432);
  assert.equal(out.memory, 'unavailable');
  assert.doesNotMatch(JSON.stringify(out), /12345[^6]|private|owner@|secret|token/);
  assert.equal(commands.length, 5); assert.ok(commands.every(c => !c.includes('pid')));
});

test('EX01 is after all product checkpoints, separate from totals, with original deadlines and debug calibration order', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('facts.androidLifecycleExperiment =') > source.indexOf("await measure('ANR02'"));
  assert.ok(source.indexOf('facts.androidLifecycleExperiment =') > source.indexOf("await check('PD01'"));
  assert.match(source, /await step\('background', \(\) => sleep\(20_000\)\)/);
  assert.match(source, /cycle % 2 \? otherId : channelId/);
  assert.match(source, /facts\.androidLifecycleExperiment\?\.status === 'FAIL' \? 1 : 0/);
  assert.match(source, /observeLifecycleWindow\(androidFailureShell, PKG, start\)/);
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-android.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node --test e2e\/android\/\*\.test\.mjs/);
});

test('EX01 records pre-force-stop preference and channel equality before cold start', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const coldBranch = source.indexOf("} else if (phase === 'cold-start') {");
  const preStop = source.indexOf('facts.ex01ColdStartPreStop =', coldBranch);
  const forceStop = source.indexOf("platform.coldLaunch('', { shell })", coldBranch);
  assert.ok(coldBranch >= 0 && preStop > coldBranch && forceStop > preStop);
  assert.ok(source.includes('preStop: facts.ex01ColdStartPreStop ?? { available: false }'));
});

test('EX01 classifies foreign/system/own focus without leaking components or weakening the focus gate', async () => {
  for (const [owner, windowText] of [
    ['bridge-main', window],
    ['bridge-other', `mCurrentFocus=Window{abc u0 ${pkg}/com.bridge.app.OtherActivity}`],
    ['system-ui', 'mCurrentFocus=Window{abc u0 com.android.systemui/com.android.systemui.SomePanel}'],
    ['launcher', 'mCurrentFocus=Window{abc u0 com.android.launcher3/.Launcher}'],
    ['other', 'mCurrentFocus=Window{abc u0 private.example/.SecretActivity}'],
    ['unknown', 'mCurrentFocus=null'],
  ]) {
    const row = await observeLifecycleWindow(shell('', windowText), pkg, start);
    assert.equal(row.focusOwner, owner);
    assert.equal(row.nativeWindowFocused, owner === 'unknown' ? null : owner === 'bridge-main');
    assert.doesNotMatch(JSON.stringify(row), /SecretActivity|SomePanel|Launcher|OtherActivity|private\.example/);
  }
  const many = await observeLifecycleWindow(shell('', [
    'mCurrentFocus=Window{abc u0 private.example/.OtherActivity}', window,
  ].join('\n')), pkg, start);
  assert.equal(many.focusEntries, 2);
  assert.equal(many.focusOwner, 'other');
  assert.equal(many.ownMainInSecondaryEntry, true);
  assert.equal(many.nativeWindowFocused, false);
});
