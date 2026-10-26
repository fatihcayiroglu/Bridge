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
