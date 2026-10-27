// #209: Bridge's own main-thread stalls at startup, from Choreographer.
//
// The original #209 evidence included "Choreographer: Skipped 123 frames! The
// application may be doing too much work on its main thread." two seconds
// after a cold start, before a FocusEvent ANR. Nothing measured this per run.
//
// Choreographer logs from inside the app process, only when one stall
// reaches SKIPPED_FRAME_WARNING_LIMIT (30 frames by default), so the lines
// for an exact PID belong to that process. Stalls below the limit are not
// reported: zero reports means "no stall >= the limit", not "no jank".
// Only counts leave this module.
const LINE = /^[VDIWEF]\/Choreographer\(\s*([0-9]{1,8})\):\s(.*)$/;
const SKIP = /^Skipped ([0-9]{1,6}) frames!/;

/** @param {string|undefined} raw `logcat -d -v brief --pid <pid> -s Choreographer:I` */
export function parseChoreographerSkips(raw, pid) {
  const appPid = /^[0-9]{1,8}$/.test(String(pid)) ? String(pid) : null;
  const result = { available: typeof raw === 'string' && appPid !== null,
    reports: 0, totalFrames: 0, maxFrames: 0, foreignPidLines: 0, unparsedLines: 0 };
  if (!result.available) return result;
  for (const line of raw.split(/\r?\n/).slice(0, 5000)) {
    if (!line.includes('Choreographer')) continue;
    const match = LINE.exec(line.trimEnd());
    if (!match) { result.unparsedLines++; continue; }
    if (match[1] !== appPid) { result.foreignPidLines++; continue; }
    const skip = SKIP.exec(match[2]);
    if (!skip) continue; // other Choreographer messages are not stalls
    const frames = Number(skip[1]);
    result.reports++;
    result.totalFrames += frames;
    result.maxFrames = Math.max(result.maxFrames, frames);
  }
  return result;
}

/** MEASURED summary over CS01's cold starts; never a PASS on its own. */
export function summarizeStartupSkips(samples) {
  const rows = (Array.isArray(samples) ? samples : []).map(s => s?.skippedFrames ?? null);
  const known = rows.filter(r => r && r.available);
  return {
    coldStarts: rows.length,
    measured: known.length,
    startsWithStall: known.filter(r => r.reports > 0).length,
    maxFrames: known.reduce((m, r) => Math.max(m, r.maxFrames), 0),
    totalReports: known.reduce((n, r) => n + r.reports, 0),
    unparsedLines: known.reduce((n, r) => n + r.unparsedLines, 0),
    limitNote: 'only stalls >= Choreographer SKIPPED_FRAME_WARNING_LIMIT (default 30 frames) are reported',
  };
}

// #209: debug-only MainThreadStallProbe (Looper dispatch timing + main-thread
// stack sampling). Lines: "event=installed ...", "event=stall ms=N msg=M
// where=W via=V samples=S", "event=uninstalled ...". Only allowlisted
// categories are accepted; anything else counts as malformed.
const PROBE_LINE = /^[VDIWEF]\/BridgeStallProbe\(\s*([0-9]{1,8})\):\s(.*)$/;
const STALL = /^event=stall ms=([0-9]{1,6}) msg=([a-z-]{1,20}) where=([a-z-]{1,20}) via=([a-z]{1,12}) samples=([0-9]{1,4})$/;
const WHERE = new Set(['sleep', 'binder', 'gc', 'io', 'font', 'classload', 'inflate', 'webview', 'capacitor',
  'bridge', 'render', 'layout', 'frame', 'lifecycle', 'other', 'idle', 'none', 'unsampled']);
const MSG = new Set(['activity-thread', 'frame', 'view-root', 'bridge', 'capacitor', 'webview', 'other', 'unknown']);
const VIA = new Set(['bridge', 'capacitor', 'webview', 'none', 'unsampled']);

export function parseStallProbe(raw, pid) {
  const appPid = /^[0-9]{1,8}$/.test(String(pid)) ? String(pid) : null;
  const result = { available: typeof raw === 'string' && appPid !== null, installed: false,
    stalls: 0, maxMs: 0, totalMs: 0, byWhere: {}, byMsg: {}, byVia: {}, malformed: 0 };
  if (!result.available) return result;
  const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  for (const line of raw.split(/\r?\n/).slice(0, 5000)) {
    if (!line.includes('BridgeStallProbe')) continue;
    const match = PROBE_LINE.exec(line.trimEnd());
    if (!match) { result.malformed++; continue; }
    if (match[1] !== appPid) continue;
    const message = match[2];
    if (/^event=installed windowMs=[0-9]{1,7} reportMs=[0-9]{1,6}$/.test(message)) { result.installed = true; continue; }
    if (/^event=uninstalled stalls=[0-9]{1,6} maxMs=[0-9]{1,6}$/.test(message)) continue;
    const stall = STALL.exec(message);
    if (!stall || !MSG.has(stall[2]) || !WHERE.has(stall[3]) || !VIA.has(stall[4])) { result.malformed++; continue; }
    const ms = Number(stall[1]);
    result.stalls++;
    result.totalMs += ms;
    result.maxMs = Math.max(result.maxMs, ms);
    bump(result.byWhere, stall[3]); bump(result.byMsg, stall[2]); bump(result.byVia, stall[4]);
  }
  return result;
}

/** The control blocks its main thread with SystemClock.sleep for stallMs. */
export function stallProbeCalibrated(probe, stallMs) {
  return Boolean(probe?.available && probe.installed && (probe.byWhere.sleep ?? 0) >= 1
    && probe.maxMs >= Math.floor(stallMs * 0.9));
}

/** MEASURED aggregate of the probe over CS01's cold starts. */
export function summarizeStartupStallProbe(samples) {
  const rows = (Array.isArray(samples) ? samples : []).map(s => s?.mainThreadStalls ?? null).filter(r => r?.available);
  const merge = key => rows.reduce((acc, r) => {
    for (const [k, n] of Object.entries(r[key])) acc[k] = (acc[k] ?? 0) + n;
    return acc;
  }, {});
  return {
    measured: rows.length,
    installed: rows.filter(r => r.installed).length,
    stalls: rows.reduce((n, r) => n + r.stalls, 0),
    maxMs: rows.reduce((m, r) => Math.max(m, r.maxMs), 0),
    byWhere: merge('byWhere'), byMsg: merge('byMsg'), byVia: merge('byVia'),
    malformed: rows.reduce((n, r) => n + r.malformed, 0),
  };
}

// `logcat -v epoch` line: "<sec>.<ms> <pid> <tid> <prio> BridgeStallProbe: <message>".
const EPOCH_PROBE_LINE = /^\s*([0-9]{9,11})\.([0-9]{3})\s+([0-9]{1,8})\s+[0-9]{1,8}\s+[VDIWEF]\s+BridgeStallProbe\s*:\s(.*)$/;
const MAX_TIMELINE = 200;

/**
 * #209 phase attribution: the probe's stall reports with their device log
 * time (logged when the dispatch ENDS). Categories and numbers only.
 */
export function parseStallProbeTimeline(raw, pid) {
  const appPid = /^[0-9]{1,8}$/.test(String(pid)) ? String(pid) : null;
  const result = { available: typeof raw === 'string' && appPid !== null, stalls: [], malformed: 0, truncated: false,
    installedEpochMs: null, uninstalledEpochMs: null };
  if (!result.available) return result;
  for (const line of raw.split(/\r?\n/).slice(0, 5000)) {
    if (!line.includes('BridgeStallProbe')) continue;
    const match = EPOCH_PROBE_LINE.exec(line.trimEnd());
    if (!match) { result.malformed++; continue; }
    if (match[3] !== appPid) continue;
    const atMs = Number(match[1]) * 1000 + Number(match[2]);
    if (/^event=installed /.test(match[4])) { result.installedEpochMs ??= atMs; continue; }
    if (/^event=uninstalled /.test(match[4])) { result.uninstalledEpochMs ??= atMs; continue; }
    if (!match[4].startsWith('event=stall ')) continue;
    const stall = STALL.exec(match[4]);
    if (!stall || !MSG.has(stall[2]) || !WHERE.has(stall[3])) { result.malformed++; continue; }
    if (result.stalls.length >= MAX_TIMELINE) { result.truncated = true; break; }
    const endEpochMs = Number(match[1]) * 1000 + Number(match[2]);
    const ms = Number(stall[1]);
    result.stalls.push({ startEpochMs: endEpochMs - ms, endEpochMs, ms, msg: stall[2], where: stall[3] });
  }
  return result;
}

export const STALL_PHASES = ['before-displayed', 'displayed-to-attached', 'attached-to-visible', 'after-visible'];

/**
 * Assigns each stall to the cold-start phase its dispatch BEGAN in. marks are
 * device-epoch ms: { displayed (am start -W returned), attached (WebView page
 * reachable over CDP), visible (auth or app UI visible) }. Marks come from a
 * host clock mapped onto the device clock, so `precision` is carried through.
 */
export function attributeStallPhases(timeline, marks, precision) {
  const empty = () => ({ stalls: 0, totalMs: 0, maxMs: 0, byWhere: {} });
  const ordered = ['displayed', 'attached', 'visible'].every(k => Number.isFinite(marks?.[k]))
    && marks.displayed <= marks.attached && marks.attached <= marks.visible;
  const result = { available: Boolean(timeline?.available && ordered), precision: precision ?? null,
    phases: Object.fromEntries(STALL_PHASES.map(p => [p, empty()])), straddling: 0,
    phaseMs: ordered ? { displayedToAttached: marks.attached - marks.displayed,
      attachedToVisible: marks.visible - marks.attached } : null };
  if (!result.available) return result;
  const bounds = [marks.displayed, marks.attached, marks.visible];
  const phaseOf = t => STALL_PHASES[bounds.filter(b => t >= b).length];
  for (const stall of timeline.stalls) {
    const phase = result.phases[phaseOf(stall.startEpochMs)];
    phase.stalls++;
    phase.totalMs += stall.ms;
    phase.maxMs = Math.max(phase.maxMs, stall.ms);
    phase.byWhere[stall.where] = (phase.byWhere[stall.where] ?? 0) + 1;
    if (phaseOf(stall.startEpochMs) !== phaseOf(stall.endEpochMs)) result.straddling++;
  }
  return result;
}

/** MEASURED aggregate of attributeStallPhases over CS01's cold starts. */
export function summarizeStallPhases(samples) {
  const rows = (Array.isArray(samples) ? samples : []).map(s => s?.stallPhases ?? null).filter(r => r?.available);
  const phases = Object.fromEntries(STALL_PHASES.map(name => {
    const own = rows.map(r => r.phases[name]);
    const byWhere = {};
    for (const p of own) for (const [k, n] of Object.entries(p.byWhere)) byWhere[k] = (byWhere[k] ?? 0) + n;
    return [name, { stalls: own.reduce((n, p) => n + p.stalls, 0), totalMs: own.reduce((n, p) => n + p.totalMs, 0),
      maxMs: own.reduce((m, p) => Math.max(m, p.maxMs), 0), byWhere }];
  }));
  return { measured: rows.length, precisions: [...new Set(rows.map(r => r.precision))],
    straddling: rows.reduce((n, r) => n + r.straddling, 0), phases,
    attribution: 'by dispatch start; marks are host instants mapped to the device clock' };
}

/**
 * #209: runs IN the page (page.evaluate). Renderer-side timing as numbers
 * only: no URLs, names or script attribution leave the page. Long tasks and
 * long animation frames are read through buffered PerformanceObservers, so
 * entries from before the harness attached are included (the browser keeps
 * up to 200 of each).
 */
export async function collectPageTiming() {
  const supported = (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
  const origin = performance.timeOrigin;
  const epoch = t => Math.round(origin + t);
  const buffered = type => new Promise(resolve => {
    if (!supported.includes(type)) { resolve(null); return; }
    const entries = [];
    let observer;
    try {
      observer = new PerformanceObserver(list => { entries.push(...list.getEntries()); });
      observer.observe({ type, buffered: true });
    } catch { resolve(null); return; }
    setTimeout(() => { observer.disconnect(); resolve(entries); }, 300);
  });
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, epoch(e.startTime)]));
  const longTasks = await buffered('longtask');
  const frames = await buffered('long-animation-frame');
  return {
    available: Number.isFinite(origin),
    supported: { longtask: longTasks !== null, longAnimationFrame: frames !== null },
    timeOriginEpochMs: Math.round(origin),
    navigation: nav ? { responseEndEpochMs: epoch(nav.responseEnd), domContentLoadedEpochMs: epoch(nav.domContentLoadedEventEnd),
      loadEpochMs: epoch(nav.loadEventEnd) } : null,
    firstPaintEpochMs: paint['first-paint'] ?? null,
    firstContentfulPaintEpochMs: paint['first-contentful-paint'] ?? null,
    longTasks: (longTasks ?? []).slice(0, 200).map(e => ({ startEpochMs: epoch(e.startTime), ms: Math.round(e.duration) })),
    longAnimationFrames: (frames ?? []).slice(0, 200).map(e => ({
      startEpochMs: epoch(e.startTime), ms: Math.round(e.duration),
      // Where the frame's time went, renderer side; numbers only.
      blockingMs: Math.round(e.blockingDuration ?? 0),
      scriptMs: Math.round((e.scripts ?? []).reduce((n, s) => n + (s.duration ?? 0), 0)),
      styleLayoutMs: Math.round(e.styleAndLayoutStart ? (e.startTime + e.duration) - e.styleAndLayoutStart : 0),
    })),
  };
}

const overlapMs = (a0, a1, intervals) => intervals.reduce((n, [b0, b1]) => n + Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)), 0);

/**
 * For each Android main-thread stall: how much of it the renderer's main
 * thread was itself busy in a long task. High overlap points at page work
 * (JS / style / layout); low overlap at compositing / rasterisation or
 * native work while the page was idle.
 */
export function rendererOverlap(timeline, pageTiming) {
  const result = { available: Boolean(timeline?.available && pageTiming?.available && pageTiming.supported?.longtask),
    stalls: 0, stallMs: 0, rendererBusyMs: 0, longFrameMs: null, stallsMostlyBusy: 0, stallsMostlyIdle: 0,
    beforeFirstContentfulPaint: 0 };
  if (!result.available) return result;
  const busy = pageTiming.longTasks.map(t => [t.startEpochMs, t.startEpochMs + t.ms]);
  const frames = pageTiming.supported.longAnimationFrame
    ? pageTiming.longAnimationFrames.map(f => [f.startEpochMs, f.startEpochMs + f.ms]) : null;
  if (frames) result.longFrameMs = 0;
  for (const stall of timeline.stalls) {
    const ms = overlapMs(stall.startEpochMs, stall.endEpochMs, busy);
    result.stalls++;
    result.stallMs += stall.ms;
    result.rendererBusyMs += ms;
    if (frames) result.longFrameMs += overlapMs(stall.startEpochMs, stall.endEpochMs, frames);
    if (ms >= stall.ms / 2) result.stallsMostlyBusy++; else result.stallsMostlyIdle++;
    if (Number.isFinite(pageTiming.firstContentfulPaintEpochMs) && stall.startEpochMs < pageTiming.firstContentfulPaintEpochMs) {
      result.beforeFirstContentfulPaint++;
    }
  }
  return result;
}

/** The per-sample record keeps aggregates, not the entry lists. */
export function compactPageTiming(pageTiming) {
  if (!pageTiming?.available) return pageTiming ?? null;
  const { longTasks, longAnimationFrames, ...rest } = pageTiming;
  const total = (list, key) => list.reduce((n, e) => n + (e[key] ?? 0), 0);
  return { ...rest,
    longTasks: { count: longTasks.length, totalMs: total(longTasks, 'ms'), maxMs: Math.max(0, ...longTasks.map(e => e.ms)) },
    longAnimationFrames: { count: longAnimationFrames.length, totalMs: total(longAnimationFrames, 'ms'),
      maxMs: Math.max(0, ...longAnimationFrames.map(e => e.ms)), scriptMs: total(longAnimationFrames, 'scriptMs'),
      styleLayoutMs: total(longAnimationFrames, 'styleLayoutMs'), blockingMs: total(longAnimationFrames, 'blockingMs') } };
}

/** MEASURED aggregate of rendererOverlap over CS01's cold starts. */
export function summarizeRendererOverlap(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const rows = list.map(s => s?.rendererOverlap ?? null).filter(r => r?.available);
  const sum = key => rows.reduce((n, r) => n + r[key], 0);
  const timing = list.map(s => s?.pageTiming ?? null).filter(t => t?.available);
  const frameRows = rows.filter(r => r.longFrameMs !== null);
  const sumTiming = (group, key) => timing.reduce((n, t) => n + t[group][key], 0);
  return { measured: rows.length, stalls: sum('stalls'), stallMs: sum('stallMs'), rendererBusyMs: sum('rendererBusyMs'),
    longFrameMs: frameRows.length ? frameRows.reduce((n, r) => n + r.longFrameMs, 0) : null,
    stallsMostlyBusy: sum('stallsMostlyBusy'), stallsMostlyIdle: sum('stallsMostlyIdle'),
    beforeFirstContentfulPaint: sum('beforeFirstContentfulPaint'),
    pageTimingRead: timing.length,
    longTaskSupported: timing.filter(t => t.supported.longtask).length,
    longAnimationFrameSupported: timing.filter(t => t.supported.longAnimationFrame).length,
    longTasks: { count: sumTiming('longTasks', 'count'), totalMs: sumTiming('longTasks', 'totalMs'),
      maxMs: timing.reduce((m, t) => Math.max(m, t.longTasks.maxMs), 0) },
    longAnimationFrames: { count: sumTiming('longAnimationFrames', 'count'), totalMs: sumTiming('longAnimationFrames', 'totalMs'),
      maxMs: timing.reduce((m, t) => Math.max(m, t.longAnimationFrames.maxMs), 0),
      scriptMs: sumTiming('longAnimationFrames', 'scriptMs'), styleLayoutMs: sumTiming('longAnimationFrames', 'styleLayoutMs') },
    clock: 'device wall clock on both sides (performance.timeOrigin, logcat -v epoch)' };
}

/**
 * #209 SF03: probe stalls whose dispatch began inside [fromEpochMs, toEpochMs).
 * `covered` is false when the probe was not installed for the whole window
 * (it uninstalls itself 90 s after process start), so an empty window is
 * never mistaken for a stall-free one.
 */
export function stallsInWindow(timeline, fromEpochMs, toEpochMs) {
  const result = { available: Boolean(timeline?.available) && Number.isFinite(fromEpochMs) && Number.isFinite(toEpochMs)
    && fromEpochMs < toEpochMs, covered: false, windowMs: null, stalls: 0, totalMs: 0, maxMs: 0, byWhere: {} };
  if (!result.available) return result;
  result.windowMs = toEpochMs - fromEpochMs;
  result.covered = Number.isFinite(timeline.installedEpochMs) && timeline.installedEpochMs <= fromEpochMs
    && (timeline.uninstalledEpochMs === null || timeline.uninstalledEpochMs >= toEpochMs);
  for (const stall of timeline.stalls) {
    if (stall.startEpochMs < fromEpochMs || stall.startEpochMs >= toEpochMs) continue;
    result.stalls++;
    result.totalMs += stall.ms;
    result.maxMs = Math.max(result.maxMs, stall.ms);
    result.byWhere[stall.where] = (result.byWhere[stall.where] ?? 0) + 1;
  }
  return result;
}
