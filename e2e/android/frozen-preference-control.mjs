// EX02: independent causal control after a retained EX01 storage failure.
// No expected data-retention outcome is counted as a PASS. App JavaScript is
// frozen before the browser storage read and Android stop; EX01 stays failed.
import { boundedLifecycleAction } from './lifecycle-reproduction.mjs';

export function summarizeFrozenPreferenceEntries(entries, key, expected) {
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

export function frozenPreferenceControlApplies(experiment) {
  const first = experiment?.phases?.[0];
  const evidence = first?.failureEvidence;
  return experiment?.status === 'FAIL' && experiment.preparation === 'PASS' &&
    first?.cycle === 1 && first.phase === 'cold-start' && first.stage === 'channel' &&
    evidence?.preStop?.available === true && evidence.preStop.preferenceMatches === true &&
    evidence.preStop.activeChannelMatches === true && evidence.ui?.bootNavigation?.available === true &&
    evidence.ui.bootNavigation.expectedAtBoot === false;
}

export async function runFrozenPreferenceControl({ emulatorDebug, select, readBefore,
  freeze, readFrozen, coldLaunch, readBoot, cleanup, budgetMs = 100_000 }) {
  const result = { case: 'EX02', status: 'FAIL', stage: 'guard', outcome: 'unverified',
    beforeFreeze: null, freezeEventObserved: null, frozen: null, boot: null, cleanup: 'not-needed' };
  if (emulatorDebug !== true || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 100_000) return result;
  let touched = false;
  try {
    await boundedLifecycleAction(async context => {
      const step = async (stage, fn) => { context.signal.throwIfAborted(); result.stage = stage; return context.step(stage, fn); };
      touched = true;
      await step('select', () => select(context));
      result.beforeFreeze = await step('before-read', () => readBefore(context));
      if (result.beforeFreeze?.available !== true || result.beforeFreeze.preferenceMatches !== true ||
          result.beforeFreeze.activeChannelMatches !== true) throw new Error('control baseline unavailable');
      const freezeResult = await step('freeze', () => freeze(context));
      result.freezeEventObserved = freezeResult?.eventObserved === true;
      if (!result.freezeEventObserved) throw new Error('page freeze not verified');
      result.frozen = await step('frozen-read', () => readFrozen(context));
      // The browser's storage area must still hold the desired value AFTER
      // freezing. No subsequent app task may write during this stop window.
      if (result.frozen?.available !== true || result.frozen.preferencePresent !== true ||
          result.frozen.preferenceMatches !== true) throw new Error('frozen baseline unavailable');
      const launch = await step('cold-launch', () => coldLaunch(context));
      if (launch?.status !== 'ok' || launch.launchState !== 'COLD') throw new Error('not a verified cold launch');
      result.boot = await step('boot-read', () => readBoot(context));
      if (result.boot?.available !== true) throw new Error('boot snapshot unavailable');
      result.outcome = result.boot.expectedAtBoot === true ? 'retained'
        : result.boot.keyAtBoot === false ? 'missing' : result.boot.keyAtBoot === true ? 'different' : 'unverified';
      if (result.outcome === 'unverified') throw new Error('invalid boot snapshot');
      result.status = 'MEASURED'; result.stage = 'complete';
    }, budgetMs);
  } catch { /* fixed stage and unknown outcome; no raw protocol/page error */ }
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
