// #209: a fixed experiment, separate from product journey totals. Callbacks
// drive the existing native harness; raw exceptions and process IDs stay here.
import { readAndroidCrashClock } from './java-crash-probe.mjs';
import { parseAnrEventTimeline, inspectAnrDialogWindows } from './exit-diagnostics.mjs';

export const LIFECYCLE_PHASES = Object.freeze(['cold-start', 'hot-resume', 'cold-deep-link']);
const validPid = value => typeof value === 'string' && /^[0-9]{1,8}$/.test(value);
const STAGES = new Set(['launch', 'background', 'resume', 'attach', 'restore', 'session', 'channel', 'settle', 'focus']);

export function lifecycleObservationPasses(phase, observation, events) {
  return observation?.pidStable === true && observation.uiVisible === true &&
    observation.channelMatched === true && observation.focused === true &&
    observation.launchState === (phase === 'hot-resume' ? 'HOT' : 'COLD') &&
    events?.available === true && events.coverage === 'observed-only' && events.anrCount === 0 &&
    events.nativeWindowFocused === true && events.dialogs?.available === true && events.dialogs.anrDialogs === 0;
}

async function bounded(action, budgetMs) {
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
    const focus = /\bmCurrentFocus=Window\{[0-9a-f]{1,16} u\d+ ([^}\r\n]{1,200})\}/.exec(boundedWindows);
    return { available: !truncated && !timeline.truncated && timeline.unparsedLines === 0,
      coverage: truncated || timeline.truncated || timeline.unparsedLines ? 'partial' : 'observed-only',
      anrCount: timeline.anrs.length, events: timeline.events.length,
      truncated: truncated || timeline.truncated === true, unparsedLines: timeline.unparsedLines,
      nativeWindowFocused: focus ? focus[1] === pkg + '/com.bridge.app.MainActivity' : null,
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
    await bounded(prepare, budgetMs); result.preparation = 'PASS';
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
        const raw = await bounded(async ({ signal, step }) => run(phase, cycle, {
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
