import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDebuggerStoragePause } from './debugger-storage-pause.mjs';
import { runPausedPreferenceControl } from './paused-preference-control.mjs';

function transport({ emitPause = true, rejectMethod = null, resumeImmediately = false } = {}) {
  const session = new EventEmitter();
  const calls = [];
  let resolveTrigger;
  let rejectTrigger;
  session.send = async (method, params) => {
    calls.push(method);
    if (method === rejectMethod) throw new Error('private owner@example.test bearer token');
    if (method === 'Runtime.evaluate') {
      assert.deepEqual(params, { expression: 'void 0', returnByValue: true });
      const pending = new Promise((resolve, reject) => { resolveTrigger = resolve; rejectTrigger = reject; });
      if (emitPause) queueMicrotask(() => {
        session.emit('Debugger.paused', { callFrames: ['private owner@example.test'] });
        if (resumeImmediately) session.emit('Debugger.resumed');
      });
      return pending;
    }
    if (method === 'Debugger.resume' || method === 'Debugger.disable') {
      session.emit('Debugger.resumed');
      resolveTrigger?.({ result: { type: 'undefined' } });
    }
    return {};
  };
  session.closeTarget = () => rejectTrigger?.(new Error('private target closed'));
  return { session, calls };
}

const context = { step: async (_name, fn) => fn() };

test('debugger storage control requires an event, owns only its listeners and settles its trigger after resume', async () => {
  const { session, calls } = transport();
  let otherEvents = 0;
  const other = () => { otherEvents++; };
  session.on('Debugger.paused', other);
  const control = createDebuggerStoragePause(session);
  const result = await control.pause(context);
  assert.deepEqual(result, { method: 'debugger-pause', eventObserved: true });
  assert.equal(control.isPaused(), true);
  assert.equal(otherEvents, 1);
  assert.deepEqual(calls, ['Debugger.enable', 'Debugger.pause', 'Runtime.evaluate']);
  assert.doesNotMatch(JSON.stringify(result), /private|owner@|callFrames/);
  await control.release(context);
  await control.release(context);
  assert.equal(control.isPaused(), false);
  assert.deepEqual(calls.slice(3), ['Debugger.resume', 'Debugger.disable']);
  assert.equal(session.listenerCount('Debugger.paused'), 1);
  assert.equal(session.listenerCount('Debugger.resumed'), 0);
  await assert.rejects(control.pause(context), /already used/);
  assert.equal(calls.length, 5);
});

async function runControl(options = {}) {
  const { session, calls } = transport(options);
  const control = createDebuggerStoragePause(session);
  let launches = 0;
  const result = await runPausedPreferenceControl({ emulatorDebug: true, budgetMs: 10,
    select: async () => {},
    readBefore: async () => ({ available: true, preferenceMatches: true, activeChannelMatches: true }),
    pause: ctx => control.pause(ctx),
    readPaused: async () => ({ available: control.isPaused(), preferencePresent: true, preferenceMatches: true }),
    coldLaunch: async () => { launches++; return { status: 'ok', launchState: 'COLD' }; },
    readBoot: async () => ({ available: true, keyAtBoot: true, expectedAtBoot: true }),
    cleanup: ctx => control.release(ctx),
  });
  return { session, control, calls, launches, result };
}

test('a pause command ACK without a paused event cannot read storage or launch, including after deadline', async () => {
  const { session, control, calls, launches, result } = await runControl({ emitPause: false });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.stage, 'pause');
  assert.equal(result.substep, 'pause-event');
  assert.equal(result.deadlineExceeded, true);
  assert.equal(result.pauseEventObserved, null);
  assert.equal(result.paused, null);
  assert.equal(launches, 0);
  assert.equal(result.cleanup, 'PASS');
  assert.deepEqual(calls, ['Debugger.enable', 'Debugger.pause', 'Runtime.evaluate', 'Debugger.disable']);
  session.emit('Debugger.paused', { callFrames: ['private'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(control.isPaused(), false);
  assert.equal(session.listenerCount('Debugger.paused'), 0);
});

test('a renderer resumed before the browser snapshot cannot pass the control', async () => {
  const { result, launches } = await runControl({ resumeImmediately: true });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.stage, 'pause');
  assert.equal(result.pauseEventObserved, false);
  assert.equal(result.deadlineExceeded, false);
  assert.equal(launches, 0);
  assert.equal(result.cleanup, 'PASS');
});

test('debugger domain or pause request rejection stops the sequence with private errors excluded', async () => {
  for (const rejectMethod of ['Debugger.enable', 'Debugger.pause']) {
    const { result, launches, session } = await runControl({ rejectMethod });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.stage, 'pause');
    assert.equal(result.substep, rejectMethod === 'Debugger.enable' ? 'debugger-domain' : 'pause-request');
    assert.equal(result.deadlineExceeded, false);
    assert.equal(result.cleanup, 'PASS');
    assert.equal(launches, 0);
    assert.equal(session.listenerCount('Debugger.paused'), 0);
    assert.doesNotMatch(JSON.stringify(result), /private|owner@|bearer|token/);
  }
});

test('trigger rejection without target teardown cannot be reported as successful cleanup', async () => {
  const { result, launches } = await runControl({ rejectMethod: 'Runtime.evaluate', emitPause: false });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.deadlineExceeded, true);
  assert.equal(result.cleanup, 'FAIL');
  assert.equal(launches, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|owner@|bearer|token/);
});

test('target teardown settles the trigger without resuming a dead target or exporting its error', async () => {
  const { session, calls } = transport();
  const control = createDebuggerStoragePause(session);
  await control.pause(context);
  session.closeTarget();
  await control.release(context, true);
  assert.deepEqual(calls, ['Debugger.enable', 'Debugger.pause', 'Runtime.evaluate']);
  assert.equal(control.isPaused(), false);
  assert.equal(session.listenerCount('Debugger.paused'), 0);
});

test('verified old-target stop does not await an indefinitely pending debugger evaluation', async () => {
  const { session, calls } = transport();
  const control = createDebuggerStoragePause(session);
  await control.pause(context);
  // Chromium may never settle Runtime.evaluate after Android force-stops
  // its renderer. A confirmed dead target must not wait for that promise.
  await control.release(context, true);
  assert.equal(control.isPaused(), false);
  assert.deepEqual(calls, ['Debugger.enable', 'Debugger.pause', 'Runtime.evaluate']);
  assert.equal(session.listenerCount('Debugger.paused'), 0);
  assert.equal(session.listenerCount('Debugger.resumed'), 0);
});

test('EX02 retains a measured different-boot result after verified old-target teardown', async () => {
  const { session } = transport();
  const control = createDebuggerStoragePause(session);
  const result = await runPausedPreferenceControl({
    emulatorDebug: true,
    budgetMs: 1000,
    select: async () => {},
    readBefore: async () => ({ available: true, preferenceMatches: true, activeChannelMatches: true }),
    pause: ctx => control.pause(ctx),
    readPaused: async () => ({ available: control.isPaused(), preferencePresent: true, preferenceMatches: true }),
    coldLaunch: async () => ({ status: 'ok', launchState: 'COLD' }),
    readBoot: async () => ({ available: true, keyAtBoot: true, expectedAtBoot: false }),
    cleanup: ctx => control.release(ctx, true),
  });
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.outcome, 'different');
  assert.equal(result.cleanup, 'PASS');
  assert.equal(result.pauseEventObserved, true);
  assert.equal(session.listenerCount('Debugger.paused'), 0);
});
