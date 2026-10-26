// EX02: independent causal control after a retained EX01 storage failure.
// No expected data-retention outcome is counted as a PASS. App JavaScript is
// paused before the browser storage read and Android stop; EX01 stays failed.
import { boundedLifecycleAction } from './lifecycle-reproduction.mjs';

// Internal callbacks name protocol steps, but only these fixed values may
// enter the public evidence. Never serialize a protocol error or method text.
const CONTROL_SUBSTEPS = new Set(['server', 'channel', 'read', 'session', 'storage-domain',
  'debugger-domain', 'pause-request', 'pause-event', 'attach', 'probe-ready', 'probe']);

export function summarizePausedPreferenceEntries(entries, key, expected) {
  const unknown = { available: false };
  if (!Array.isArray(entries) || entries.length > 512 || typeof key !== 'string' ||
      !key.startsWith('bridge:last-navigation:v1:channel:') || key.length > 1024 ||
      typeof expected !== 'string' || !expected || expected.length > 256) return unknown;
  let characters = 0;
  let matching = null;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== 'string')) return unknown;
    characters += entry[0].length + entry[1].length;
    if (characters > 262_144) return unknown;
    if (entry[0] === key) {
      if (matching !== null) return unknown;
      matching = entry;
    }
  }
  return { available: true, preferencePresent: matching !== null, preferenceMatches: matching?.[1] === expected };
}

export async function readPausedPreference(control, readEntries, key, expected) {
  if (control?.isPaused() !== true) return { available: false };
  const entries = await readEntries();
  // Resuming while a browser read is in flight invalidates that baseline.
  if (control.isPaused() !== true) return { available: false };
  return summarizePausedPreferenceEntries(entries, key, expected);
}

export function pausedPreferenceControlApplies(experiment) {
  const first = experiment?.phases?.[0];
  const evidence = first?.failureEvidence;
  return experiment?.status === 'FAIL' && experiment.preparation === 'PASS' &&
    first?.cycle === 1 && first.phase === 'cold-start' && first.stage === 'channel' &&
    evidence?.preStop?.available === true && evidence.preStop.preferenceMatches === true &&
    evidence.preStop.activeChannelMatches === true && evidence.ui?.bootNavigation?.available === true &&
    evidence.ui.bootNavigation.expectedAtBoot === false;
}

export async function runPausedPreferenceControl({ emulatorDebug, select, readBefore,
  pause, readPaused, coldLaunch, readBoot, cleanup, budgetMs = 100_000 }) {
  const result = { case: 'EX02', status: 'FAIL', stage: 'guard', outcome: 'unverified', method: 'debugger-pause',
    substep: null, deadlineExceeded: false, beforePause: null,
    pauseEventObserved: null, paused: null, boot: null, cleanup: 'not-needed' };
  if (emulatorDebug !== true || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 100_000) return result;
  let touched = false;
  let actionSignal = null;
  try {
    await boundedLifecycleAction(async context => {
      actionSignal = context.signal;
      const diagnosticContext = { ...context, step: async (name, fn) => {
        context.signal.throwIfAborted();
        result.substep = CONTROL_SUBSTEPS.has(name) ? name : 'other';
        return context.step(name, fn);
      } };
      const step = async (stage, fn) => {
        context.signal.throwIfAborted();
        result.stage = stage; result.substep = null;
        return context.step(stage, fn);
      };
      touched = true;
      await step('select', () => select(diagnosticContext));
      result.beforePause = await step('before-read', () => readBefore(diagnosticContext));
      if (result.beforePause?.available !== true || result.beforePause.preferenceMatches !== true ||
          result.beforePause.activeChannelMatches !== true) throw new Error('control baseline unavailable');
      const pauseResult = await step('pause', () => pause(diagnosticContext));
      result.pauseEventObserved = pauseResult?.method === 'debugger-pause' && pauseResult.eventObserved === true;
      if (pauseResult?.method !== 'debugger-pause' || !result.pauseEventObserved) throw new Error('debugger pause not verified');
      result.paused = await step('paused-read', () => readPaused(diagnosticContext));
      // The browser's storage area must still hold the desired value AFTER
      // pausing. No subsequent app task may write during this stop window.
      if (result.paused?.available !== true || result.paused.preferencePresent !== true ||
          result.paused.preferenceMatches !== true) throw new Error('paused baseline unavailable');
      const launch = await step('cold-launch', () => coldLaunch(diagnosticContext));
      if (launch?.status !== 'ok' || launch.launchState !== 'COLD') throw new Error('not a verified cold launch');
      result.boot = await step('boot-read', () => readBoot(diagnosticContext));
      if (result.boot?.available !== true) throw new Error('boot snapshot unavailable');
      result.outcome = result.boot.expectedAtBoot === true ? 'retained'
        : result.boot.keyAtBoot === false ? 'missing' : result.boot.keyAtBoot === true ? 'different' : 'unverified';
      if (result.outcome === 'unverified') throw new Error('invalid boot snapshot');
      result.status = 'MEASURED'; result.stage = 'complete';
    }, budgetMs);
  } catch {
    // Read the controller's actual abort signal, not an error-message guess.
    result.deadlineExceeded = actionSignal?.aborted === true;
  }
  finally {
    if (touched) {
      try {
        await boundedLifecycleAction(context => cleanup(context), 5000);
        result.cleanup = 'PASS';
      } catch {
        result.cleanup = 'FAIL';
        if (result.status === 'MEASURED') result.stage = 'cleanup';
        result.status = 'FAIL';
      }
    }
  }
  return result;
}
