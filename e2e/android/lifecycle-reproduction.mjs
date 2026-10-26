// #209: a fixed experiment, separate from product journey totals. Callbacks
// drive the existing native harness; raw exceptions and process IDs stay here.
import { readAndroidCrashClock } from './java-crash-probe.mjs';
import { parseAnrEventTimeline, inspectAnrDialogWindows } from './exit-diagnostics.mjs';

export const LIFECYCLE_PHASES = Object.freeze(['cold-start', 'hot-resume', 'cold-deep-link']);
const validPid = value => typeof value === 'string' && /^[0-9]{1,8}$/.test(value);
const STAGES = new Set(['launch', 'background', 'resume', 'attach', 'restore', 'durable', 'session', 'channel', 'settle', 'focus']);

export function lifecycleObservationPasses(phase, observation, events) {
  return observation?.pidStable === true && observation.uiVisible === true &&
    observation.channelMatched === true && observation.focused === true &&
    observation.launchState === (phase === 'hot-resume' ? 'HOT' : 'COLD') &&
    events?.available === true && events.coverage === 'observed-only' && events.anrCount === 0 &&
    events.nativeWindowFocused === true && events.dialogs?.available === true && events.dialogs.anrDialogs === 0;
}

export async function boundedLifecycleAction(action, budgetMs) {
  const abort = new AbortController();
  let timer;
  const step = async (stage, fn) => {
    abort.signal.throwIfAborted();
    const value = await fn();
    abort.signal.throwIfAborted();
    return value;
  };
  try {
    return await Promise.race([action({ signal: abort.signal, step }), new Promise((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('experiment deadline')); }, budgetMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Same event/dialog parsers as ANR03/AN00, with a short device-clock window.
// A readable empty buffer is only observed-only coverage, never completeness.
export async function observeLifecycleWindow(shell, pkg, start) {
  const none = { available: false, coverage: 'unknown', anrCount: null, dialogs: null };
  if (!start || !/^[A-Za-z][A-Za-z0-9_.]{0,119}$/.test(pkg)) return none;
  try {
    const raw = await shell('logcat -b events -d -v epoch -t 2000 -s am_anr:I am_kill:I am_proc_died:I am_proc_start:I');
    // API34: DisplayContent.dump owns mCurrentFocus. The "windows" subcommand
    // only dumps WindowState records and cannot establish current focus.
    const windows = await shell('dumpsys window');
    const end = await readAndroidCrashClock(shell);
    if (!end || end.offsetMinutes !== start.offsetMinutes ||
        end.epochMs < start.epochMs || end.epochMs - start.epochMs > 120_000) return none;
    const truncated = raw.length > 262_144 || raw.split(/\r?\n/).length > 2000 || windows.length > 1_000_000;
    const timeline = parseAnrEventTimeline(raw.slice(0, 262_144), pkg,
      start.epochMs, 64, end.epochMs - start.epochMs);
    const boundedWindows = windows.slice(0, 1_000_000);
    // Bounded, privacy-safe focus ownership evidence. Keep the original
    // strict FIRST-focus equality gate; secondary displays do not turn FAIL
    // into PASS. Never expose a raw component/package/window string.
    const focusEntries = [...boundedWindows.matchAll(/\bmCurrentFocus=Window\{[0-9a-f]{1,16} u\d+ ([^}\r\n]{1,200})\}/g)].slice(0, 9);
    const focus = focusEntries[0] ?? null;
    const expectedMain = pkg + '/com.bridge.app.MainActivity';
    // AOSP dumps one mCurrentFocus per DisplayContent. Record which display
    // emitted each focus and the explicitly reported top-focused display.
    // Select ONLY the explicitly top-focused display when multiple windows exist.
    // An absent/ambiguous mapping cannot turn any secondary app window into PASS.
    const displayHeaders = [...boundedWindows.matchAll(/^\s*Display: mDisplayId=(0|[1-9]\d{0,4})\b/gm)].slice(0, 24);
    const focusDisplayIds = focusEntries.map(entry => {
      for (let i = displayHeaders.length - 1; i >= 0; i--) {
        if (displayHeaders[i].index < entry.index) return Number(displayHeaders[i][1]);
      }
      return null;
    });
    const topDisplayMatch = boundedWindows.match(/\bmTopFocusedDisplayId=(0|[1-9]\d{0,4})\b/);
    const topFocusedDisplayId = topDisplayMatch ? Number(topDisplayMatch[1]) : null;
    const topFocusIndex = topFocusedDisplayId === null ? -1
      : focusDisplayIds.findIndex(id => id === topFocusedDisplayId);
    const focusDisplayMappingComplete = topFocusedDisplayId !== null &&
      focusEntries.length > 0 && focusEntries.length <= 8 && focusDisplayIds.every(id => id !== null);
    const topFocusCount = focusDisplayMappingComplete
      ? focusDisplayIds.filter(id => id === topFocusedDisplayId).length : 0;
    const resolvedTopFocusIndex = topFocusCount === 1 ? topFocusIndex : -1;
    // Synthetic/older unscoped single-window output retains its original gate.
    // Real scoped dumps with missing top attribution fail closed, as do
    // duplicates, overflow and unscoped multi-display lists.
    const unscopedSingle = focusEntries.length === 1 &&
      topFocusedDisplayId === null && focusDisplayIds[0] === null;
    const focusDecisionSource = !focus ? 'unknown' : resolvedTopFocusIndex >= 0
      ? 'top-display' : unscopedSingle ? 'unscoped-single' : 'unresolved';
    const nativeWindowFocused = !focus ? null : resolvedTopFocusIndex >= 0
      ? focusEntries[resolvedTopFocusIndex][1] === expectedMain
      : unscopedSingle ? focus[1] === expectedMain : false;
    const defaultFocusIndex = focusDisplayIds.findIndex(id => id === 0);
    const ownMainIndex = focusEntries.findIndex(entry => entry[1] === expectedMain);
    const focusOwner = !focus ? 'unknown'
      : focus[1] === expectedMain ? 'bridge-main'
      : focus[1].startsWith(pkg + '/') ? 'bridge-other'
      : focus[1].startsWith('com.android.systemui/') ? 'system-ui'
      : /launcher/i.test(focus[1]) ? 'launcher'
      : 'other';
    return { available: !truncated && !timeline.truncated && timeline.unparsedLines === 0,
      coverage: truncated || timeline.truncated || timeline.unparsedLines ? 'partial' : 'observed-only',
      anrCount: timeline.anrs.length, events: timeline.events.length,
      truncated: truncated || timeline.truncated === true, unparsedLines: timeline.unparsedLines,
      nativeWindowFocused, focusDecisionSource,
      focusOwner, focusEntries: Math.min(focusEntries.length, 8),
      focusEntriesOverflow: focusEntries.length > 8,
      ownMainInSecondaryEntry: focusEntries.slice(1).some(entry => entry[1] === expectedMain),
      topFocusedDisplayId, firstFocusDisplayId: focusDisplayIds[0] ?? null,
      ownMainFocusDisplayId: ownMainIndex < 0 ? null : focusDisplayIds[ownMainIndex],
      focusDisplayMappingComplete,
      topFocusedWindowIsMain: resolvedTopFocusIndex < 0 ? null : focusEntries[resolvedTopFocusIndex][1] === expectedMain,
      defaultDisplayWindowIsMain: defaultFocusIndex < 0 ? null : focusEntries[defaultFocusIndex][1] === expectedMain,
      dialogs: inspectAnrDialogWindows(boundedWindows, pkg) };
  } catch { return none; }
}

export async function runLifecycleReproduction({ prepare, clock, run, observe, failureEvidence, pressure = async () => null, budgetMs = 100_000 }) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 100_000) throw new Error('invalid experiment budget');
  const result = { case: 'EX01', status: 'FAIL', cycles: 3, expectedPhases: 9,
    preparation: 'FAIL', preparationEvidence: null, stoppedAtFirstFailure: true, phases: [] };
  let preparationStart = null;
  try {
    preparationStart = await clock();
    if (!preparationStart) throw new Error('clock unavailable');
    await boundedLifecycleAction(prepare, budgetMs); result.preparation = 'PASS';
  } catch {
    try { result.preparationEvidence = await failureEvidence(preparationStart); } catch { /* unknown */ }
    return result;
  }
  for (let cycle = 1; cycle <= 3; cycle++) {
    for (const phase of LIFECYCLE_PHASES) {
      let start = null;
      const row = { cycle, phase, status: 'FAIL', stage: 'clock', clockAvailable: false,
        observation: null, events: null, pressureBefore: null, pressureAfter: null, failureEvidence: null };
      result.phases.push(row);
      try {
        row.pressureBefore = await pressure();
        start = await clock();
        row.clockAvailable = start !== null;
        // An experiment without a calibrated window cannot test attribution.
        if (!start) throw new Error('clock unavailable');
        row.stage = 'run';
        const raw = await boundedLifecycleAction(async ({ signal, step }) => run(phase, cycle, {
          signal, step: (stage, fn) => {
            signal.throwIfAborted();
            if (STAGES.has(stage)) row.stage = stage;
            return step(stage, fn);
          },
        }), budgetMs);
        row.observation = {
          pidStable: validPid(raw?.beforePid) && validPid(raw?.afterPid)
            ? raw.beforePid === raw.afterPid : null,
          launchState: ['HOT', 'COLD', 'WARM'].includes(raw?.launchState) ? raw.launchState : 'unknown',
          uiVisible: raw?.uiVisible === true, channelMatched: raw?.channelMatched === true,
          focused: raw?.focused === true,
        };
        row.stage = 'observe';
        row.events = await observe(start);
        row.pressureAfter = await pressure();
        row.stage = 'assert';
        if (!lifecycleObservationPasses(phase, row.observation, row.events)) {
          throw new Error('experiment assertion failed');
        }
        row.status = 'PASS'; row.stage = 'complete';
      } catch {
        // Preserve the FIRST failing phase before another cold launch can
        // replace its process. No retry or continuation of later phases.
        try { row.failureEvidence = await failureEvidence(start); }
        catch { row.failureEvidence = null; }
        try { row.pressureAfter = await pressure(); } catch { /* unknown */ }
        return result;
      }
    }
  }
  result.status = 'PASS';
  return result;
}
