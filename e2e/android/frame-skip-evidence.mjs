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
