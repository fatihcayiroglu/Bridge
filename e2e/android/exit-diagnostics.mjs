// Failure-only Android process exit diagnostics. Never log raw exit descriptions,
// stack traces, user text, provider arguments or tokens.
export function parseApplicationExits(raw, limit = 6) {
  const bounded = Number.isInteger(limit) ? Math.max(0, Math.min(10, limit)) : 6;
  return String(raw).split(/ApplicationExitInfo #\d+:/).slice(1, bounded + 1).map((record) => {
    const field = (re) => (re.exec(record) ?? [])[1] ?? null;
    const status = field(/\bstatus=(-?\d+)/);
    return {
      at: field(/timestamp=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/),
      pid: Number(field(/\bpid=(\d+)/)) || null,
      process: field(/process=([A-Za-z0-9_.:]+)/),
      reason: field(/reason=(\d+ \([A-Z_ ]+\))/),
      subreason: field(/subreason=(\d+ \([A-Z_ ]+\))/),
      status: status === null ? null : Number(status),
      importance: Number(field(/importance=(\d+)/)) || null,
    };
  });
}
/**
 * CS00 failure-only summary of a SAME-PID Android ApplicationExitInfo record.
 * No PID, process name, path, timestamp, user content, provider identity,
 * stack or raw exit description may enter logs / artifacts.
 *
 * This is attribution evidence, NOT a retry and NOT proof of a root cause.
 * A PID can be absent before Android records an exit, hence matching=false
 * must remain unknown rather than "no crash".
 */
/**
 * A01 failure-only safe projection of Android's am start -W output.
 * Never surface a raw launch response: it can include package names,
 * component paths and other diagnostic context.
 */
export function summarizeAndroidColdLaunch(raw) {
  const src = String(raw ?? '');
  const status = /(?:^|\n)\s*Status:\s*(ok|[A-Za-z0-9_-]{1,24})\s*(?:\r?\n|$)/.exec(src);
  const state = /(?:^|\n)\s*LaunchState:\s*(COLD|WARM|HOT)\s*(?:\r?\n|$)/.exec(src);
  const total = /(?:^|\n)\s*TotalTime:\s*([0-9]{1,7})\s*(?:\r?\n|$)/.exec(src);
  const ms = total ? Number(total[1]) : null;
  return {
    status: status ? (status[1] === 'ok' ? 'ok' : 'not-ok') : 'unknown',
    launchState: state?.[1] ?? 'unknown',
    totalTimeMs: ms !== null && Number.isSafeInteger(ms) && ms <= 120_000 ? ms : null,
  };
}

export function summarizeControlProcessExit(exits, expectedPid) {
  if (!/^[0-9]{1,8}$/.test(String(expectedPid)) || !Array.isArray(exits))
    return { evidenceValid: false, matchingExit: false, reasonCode: null, subreasonCode: null };
  const hit = exits.slice(0, 6).find(row =>
    row && Number.isInteger(row.pid) && String(row.pid) === String(Number(expectedPid)));
  const code = value => {
    const m = /^([0-9]{1,2}) \([A-Z_ ]+\)$/.exec(String(value ?? ''));
    return m ? Number(m[1]) : null;
  };
  return {
    evidenceValid: true,
    matchingExit: Boolean(hit),
    reasonCode: hit ? code(hit.reason) : null,
    subreasonCode: hit ? code(hit.subreason) : null,
  };
}

/**
 * A01 exit dependency attribution: ONLY fixed enums leave the process.
 *
 * ApplicationExitInfo reason 12 says a dependency died, but does not name
 * which dependency. The OS "Killing PID: depends on provider ..." line may
 * name it; absent/malformed lines MUST remain unknown.
 *
 * Classifications refer only to a verified SAME-PID exit record. This must
 * not claim that a font request directly caused that upstream process death.
 */
export function classifyAndroidDependencyDeath(exits, expectedPid) {
  const unknown = { exitMatched: false, isDependencyDeath: null,
    providerClass: 'unknown', dyingProcessClass: 'unknown', attribution: 'unavailable' };
  if (!/^[0-9]{1,8}$/.test(String(expectedPid)) || !Array.isArray(exits))
    return unknown;
  const found = exits.slice(0, 6).find(row => row &&
    Number.isInteger(row.pid) && String(row.pid) === String(Number(expectedPid)));
  if (!found) return unknown;
  if (found.reason !== '12 (DEPENDENCY DIED)') {
    return { ...unknown, exitMatched: true, isDependencyDeath: false,
      attribution: 'not-dependency-death' };
  }
  const dep = found.dependency;
  if (!dep || typeof dep !== 'object') {
    return { ...unknown, exitMatched: true, isDependencyDeath: true };
  }
  const provider = typeof dep.provider === 'string' ? dep.provider : null;
  const processName = typeof dep.dyingProcess === 'string' ? dep.dyingProcess : null;
  return {
    exitMatched: true, isDependencyDeath: true,
    providerClass: provider === 'com.google.android.gms/.fonts.provider.FontsProvider'
      ? 'gms-fonts' : provider ? 'other-provider' : 'unknown',
    dyingProcessClass: processName === 'com.google.android.gms.persistent'
      ? 'gms-persistent' : processName ? 'other-process' : 'unknown',
    attribution: provider && processName ? 'matched-kill-line' : 'unavailable',
  };
}

/**
 * Attribute a provider-dependency kill to the EXACT exited app process and
 * Android event time, not just a PID (which Android may subsequently reuse).
 * When exitAt is supplied, only a timestamped ActivityManager threadtime
 * record within 30 seconds is eligible. No raw log content is returned.
 */
export function parseDependencyKillLine(raw, expectedPid, expectedProcess = 'com.bridge.app.debug', exitAt = null) {
  const absent = { provider: null, dyingProcess: null, killLineFound: false };
  if (!/^[0-9]{1,8}$/.test(String(expectedPid)) ||
      !/^[A-Za-z0-9_.:]{1,120}$/.test(String(expectedProcess))) return null;
  const pid = String(Number(expectedPid));
  const exitMatch = exitAt === null ? null :
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(String(exitAt));
  if (exitAt !== null && !exitMatch) return absent;
  const asUtc = (year, month, day, hour, min, sec, ms = '0') =>
    Date.UTC(Number(year), Number(month) - 1, Number(day),
      Number(hour), Number(min), Number(sec), Number(ms.padEnd(3, '0')));
  const exitTime = exitMatch ? asUtc(...exitMatch.slice(1)) : null;
  if (exitMatch && !Number.isFinite(exitTime)) return absent;
  let seen = false;
  let chosen = null;
  let closestMs = Infinity;
  for (const line of String(raw).split(/\r?\n/).slice(-200)) {
    const victim = /\bKilling ([0-9]{1,8}):([A-Za-z0-9_.:]{1,120})(?=[\s/(]|$)/.exec(line);
    if (!victim || String(Number(victim[1])) !== pid || victim[2] !== expectedProcess) continue;
    if (exitMatch) {
      const logTime = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})\s+/.exec(line);
      if (!logTime) continue;
      const eventTime = asUtc(exitMatch[1], ...logTime.slice(1));
      const delta = Math.abs(eventTime - exitTime);
      if (!Number.isFinite(delta) || delta > 30_000 || delta >= closestMs) continue;
      closestMs = delta;
    }
    seen = true;
    const m = /\bdepends on provider ([A-Za-z0-9_.$/]{1,200}) in dying proc ([A-Za-z0-9_.:]{1,120})(?=[\s;]|$)/.exec(line);
    chosen = m ? { provider: m[1], dyingProcess: m[2] } :
      { provider: null, dyingProcess: null, killLineFound: true };
  }
  return chosen ?? { ...absent, killLineFound: seen };
}


/**
 * Classify ActivityManager ANR headers using only pre-defined categories.
 * No raw Reason text, stack frames, intent data, window names, identities or
 * filesystem paths may cross this boundary into test logs/artifacts.
 *
 * Intended input is an ordered, already-filtered list of "ANR in " and
 * "Reason:" ActivityManager lines, including headers from other packages
 * so their reasons cannot be attributed to Bridge.
 */
export function parseActivityManagerAnrs(raw, expectedProcess, limit = 8) {
  if (!/^[A-Za-z0-9_.:]{1,120}$/.test(String(expectedProcess))) return [];
  const max = Number.isInteger(limit) ? Math.max(0, Math.min(10, limit)) : 8;
  const records = [];
  let current = null;
  for (const line of String(raw).split(/\r?\n/)) {
    const header = /\bANR in ([A-Za-z0-9_.:]{1,120})(?:\s|$)/.exec(line);
    if (header) {
      current = header[1] === expectedProcess && records.length < max
        ? { category: 'unknown', focusEvent: false }
        : null;
      if (current) records.push(current);
      continue;
    }
    if (!current) continue;
    const reason = /\bReason:\s*(.*)$/.exec(line);
    if (!reason) continue;
    const value = reason[1];
    if (/input dispatching timed out/i.test(value)) {
      current.category = 'input_dispatch_timeout';
      current.focusEvent = /\bFocusEvent\b/i.test(value);
    } else if (/broadcast of intent|broadcast.*timed out/i.test(value)) {
      current.category = 'broadcast_timeout';
    } else if (/executing service|service.*timed out/i.test(value)) {
      current.category = 'service_timeout';
    } else if (/contentprovider|content provider/i.test(value)) {
      current.category = 'provider_timeout';
    }
  }
  return records;
}

const ANR_CPU_TOP_CLASSES = ['app', 'webview_renderer', 'system_server', 'surfaceflinger', 'other'];

function cpuClass(processName, expectedProcess) {
  if (processName === expectedProcess) return 'app';
  if (/^(?:com\.google\.android\.webview|com\.android\.chrome|com\.google\.android\.trichromelibrary)[A-Za-z0-9_.]*:sandboxed_process\d+/.test(processName)) {
    return 'webview_renderer';
  }
  if (processName === 'system_server') return 'system_server';
  if (processName === 'surfaceflinger' || processName === '/system/bin/surfaceflinger') return 'surfaceflinger';
  return 'other';
}

/**
 * CPU pressure around an ANR of `expectedProcess`, from ActivityManager's own
 * ANR record ("Load:" and the "CPU usage from ..." tables it logs). Only
 * numbers and a fixed set of categories cross this boundary: the load average,
 * the TOTAL CPU, the app's, the WebView renderers' and system_server's share,
 * and which category used the most. No process names of other apps, pids,
 * reason text, paths or identities are emitted.
 *
 * A window that ended before the ANR ("... ms ago") is `before`; one measured
 * after it ("... ms later") is `after`. This tells a starved device (high
 * TOTAL, load far above the core count, the app's own share small) from an app
 * that is busy itself.
 */
export function parseAnrCpuPressure(raw, expectedProcess, limit = 3) {
  if (!/^[A-Za-z0-9_.:]{1,120}$/.test(String(expectedProcess))) return [];
  const max = Number.isInteger(limit) ? Math.max(0, Math.min(5, limit)) : 3;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : null;
  };
  const records = [];
  let current = null;
  let window = null;
  for (const line of String(raw).split(/\r?\n/)) {
    const header = /\bANR in ([A-Za-z0-9_.:]{1,120})(?:\s|$)/.exec(line);
    if (header) {
      window = null;
      current = header[1] === expectedProcess && records.length < max ? { load: null, cpu: [] } : null;
      if (current) records.push(current);
      continue;
    }
    if (!current) continue;
    const load = /\bLoad:\s*([\d.]+)\s*\/\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(line);
    if (load) {
      const values = load.slice(1, 4).map(num);
      current.load = values.every((v) => v !== null) ? values : null;
      continue;
    }
    const section = /\bCPU usage from \d+ms to \d+ms (later|ago)\b/.exec(line);
    if (section) {
      if (current.cpu.length >= 2) { window = null; continue; }
      window = {
        window: section[1] === 'ago' ? 'before' : 'after',
        totalPct: null, appPct: 0, webviewRendererPct: 0, systemServerPct: 0, topPct: 0, topClass: null,
      };
      current.cpu.push(window);
      continue;
    }
    if (!window) continue;
    const total = /\b([\d.]+)% TOTAL:/.exec(line);
    if (total) { window.totalPct = num(total[1]); window = null; continue; }
    const proc = /\b([\d.]+)% \d{1,7}\/([A-Za-z0-9_.:/-]{1,160}): /.exec(line);
    if (!proc) continue;
    const pct = num(proc[1]);
    if (pct === null) continue;
    const klass = cpuClass(proc[2], expectedProcess);
    if (klass === 'app') window.appPct += pct;
    else if (klass === 'webview_renderer') window.webviewRendererPct += pct;
    else if (klass === 'system_server') window.systemServerPct += pct;
    if (pct > window.topPct) { window.topPct = pct; window.topClass = klass; }
  }
  for (const record of records) {
    for (const w of record.cpu) {
      if (!ANR_CPU_TOP_CLASSES.includes(w.topClass)) w.topClass = null;
    }
  }
  return records;
}

// Android's devtools socket is a different capability from the Activity being
// resumed. A running native PID with NO WebView devtools socket indicates a
// WebView/renderer/inspection failure, not an assertion that Bridge is healthy.
// Keep only the count and exact running-app-PID match; do not publish raw
// /proc/net/unix lines, which can name unrelated apps or user identifiers.
export function parseWebViewDevToolsSockets(raw, appPid) {
  const pid = /^[0-9]{1,8}$/.test(String(appPid)) ? String(appPid) : null;
  const socketPids = new Set();
  for (const line of String(raw).split(/\r?\n/).slice(0, 20_000)) {
    const found = /(?:^|[\s@/])webview_devtools_remote_([0-9]{1,8})(?=\s|$)/.exec(line);
    if (found) socketPids.add(found[1]);
  }
  return {
    socketCount: Math.min(socketPids.size, 100),
    appPidHasSocket: Boolean(pid && socketPids.has(pid)),
  };
}


/**
 * Pure, allowlisted Android WebView-attachment failure evidence. dumpsys,
 * logcat and /proc/net/unix can contain paths, user identifiers, intents and
 * arbitrary app data. Never print those inputs or exception messages.
 *
 * An app-owned Unix socket is not proof that Chrome DevTools Protocol works.
 * Preserve uncertainty instead of labelling an L03 failure as healthy.
 */
export function summarizeWebViewAttachEvidence(
  { pid = '', activity = '', processes = '', sockets = '', crash = '' } = {},
  pkg = 'com.bridge.app.debug',
) {
  const validPackage = /^[A-Za-z][A-Za-z0-9_.]{0,119}$/.test(String(pkg));
  const validPid = /^[0-9]{1,8}$/.test(String(pid));
  const activityLines = String(activity).split(/\r?\n/).slice(0, 1000);
  const processLines = String(processes).split(/\r?\n/).slice(0, 2000);
  const activityRecordAvailable = activityLines.some(line =>
    /(?:topResumedActivity|mResumedActivity)\s*=/.test(line));
  const processRecordAvailable = processLines.some(line => /ProcessRecord\{/.test(line));
  const packageNeedle = validPackage ? String(pkg) : '';
  const mainActivityResumed = validPackage && activityLines.some(line =>
    /(?:topResumedActivity|mResumedActivity)\s*=/.test(line) &&
    line.includes(packageNeedle + '/com.bridge.app.MainActivity'));
  const pidAndPackageNeedle = validPid && validPackage ? String(pid) + ':' + packageNeedle + '/' : '';
  const appProcessMatched = Boolean(pidAndPackageNeedle &&
    processLines.some(line => line.includes(pidAndPackageNeedle)));
  const devtools = parseWebViewDevToolsSockets(sockets, pid);
  return {
    appPidValid: validPid,
    activityRecordAvailable,
    mainActivityResumed,
    processRecordAvailable,
    appProcessMatched,
    devtools,
    // These are only category flags, NOT evidence of a Bridge-specific crash.
    crashBufferHasFatalMarker: /\b(?:FATAL EXCEPTION|Fatal signal)\b/.test(String(crash)),
    cdpPageResponsive: 'unverified',
  };
}


/**
 * Summarize a localhost DevTools /json/list response. The raw response holds
 * page titles, app URLs and debugging websocket addresses: NEVER log it.
 * A responding endpoint is different from one usable WebView page target.
 */
export function classifyWebViewDevToolsTargets(raw) {
  const listValid = Array.isArray(raw);
  const rows = listValid ? raw.slice(0, 100) : [];
  const pageTargetCount = rows.filter(row =>
    row !== null && typeof row === 'object' && !Array.isArray(row) &&
    row.type === 'page').length;
  return { listValid, targetCount: rows.length, pageTargetCount };
}


/**
 * Privacy-safe observation of the Android app's live provider dependencies.
 * Keep only counts and a boolean; never publish raw ActivityManager output.
 */
export function inspectBridgeEmojiFontProvider(raw, appPid) {
  const validPid = /^[0-9]{1,8}$/.test(String(appPid));
  const pid = validPid ? Number(appPid) : null;
  let sections = 0;
  let parsedConnections = 0;
  let unparsedConnections = 0;
  let active = false;
  let fontProviderConnected = false;
  let fontProviderConnections = 0;
  let fontProviderStableRefs = 0;
  let fontProviderUnstableRefs = 0;
  let fontProviderRefCountsKnown = true;
  let fontProviderWaiting = false;
  let fontProviderDead = false;
  for (const line of String(raw).split(/\r?\n/).slice(0, 20000)) {
    if (/^\s*Connected Providers:\s*$/.test(line)) {
      active = true;
      sections++;
      continue;
    }
    if (!active) continue;
    if (!/^\s+- /.test(line)) {
      active = false;
      continue;
    }
    const m = /^\s+- [0-9a-f]+\/([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)->(\d{1,8}):/.exec(line);
    if (!m) {
      unparsedConnections++;
      continue;
    }
    parsedConnections++;
    if (pid !== null && Number(m[2]) === pid &&
        m[1] === 'com.google.android.gms/.fonts.provider.FontsProvider') {
      fontProviderConnected = true;
      fontProviderConnections = Math.min(fontProviderConnections + 1, 100);
      // A live connection alone does not identify its caller. In particular,
      // AndroidX EmojiCompat, WebView and other components could establish a
      // provider reference. Stable refs matter to Android process dependency
      // handling; don't classify an unstable-only connection as equivalent.
      const refs = /\s+s(\d{1,8})\/\d{1,8}\s+u(\d{1,8})\/\d{1,8}(?=\s|$)/.exec(line);
      if (refs) {
        fontProviderStableRefs = Math.min(100_000, fontProviderStableRefs + Number(refs[1]));
        fontProviderUnstableRefs = Math.min(100_000, fontProviderUnstableRefs + Number(refs[2]));
      } else {
        fontProviderRefCountsKnown = false;
      }
      fontProviderWaiting ||= /\sWAITING(?:\s|$)/.test(line);
      fontProviderDead ||= /\sDEAD(?:\s|$)/.test(line);
    }
  }
  return {
    appPidValid: validPid,
    providerSections: Math.min(sections, 100),
    parsedConnections: Math.min(parsedConnections, 100),
    unparsedConnections: Math.min(unparsedConnections, 100),
    fontProviderConnected,
    fontProviderConnections,
    fontProviderStableRefs,
    fontProviderUnstableRefs,
    fontProviderRefCountsKnown,
    fontProviderWaiting,
    fontProviderDead,
  };
}


/**
 * Parse only a fixed-shape, debug-only native EmojiCompat state marker from a
 * PID-filtered (or tag-filtered with exact PID verification) Android
 * logcat. No free-text log data, PID or device identity is emitted to CI.
 * Native debug reflection may initialize EmojiCompat; neither presence nor
 * configuration status attributes the observed provider connection.
 */
export function parseNativeEmojiStartupProbe(raw, appPid = null) {
  // A tag-only fallback can contain markers from another app process.
  // Require an exact Android logcat PID when a target process is supplied.
  const targetPid = /^[0-9]{1,8}$/.test(String(appPid)) ? String(Number(appPid)) : null;
  if (appPid !== null && targetPid === null) return parseNativeEmojiStartupProbe('');
  const allowed = new Set(['before-super', 'after-super', 'resumed']);
  const samples = [];
  for (const line of String(raw).split(/\r?\n/).slice(-1500)) {
    if (!line.includes('BridgeEmojiStartupProbe')) continue;
    if (targetPid !== null) {
      // Support both Android's brief and threadtime logcat formats.
      // Never treat a PID-less free-text imitation as trusted evidence.
      const brief = /\b[A-Z]\/BridgeEmojiStartupProbe\(\s*([0-9]{1,8})\)/.exec(line);
      const threadtime = /\b[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+\s+([0-9]{1,8})\s+[0-9]{1,8}\s+[A-Z]\s+BridgeEmojiStartupProbe:/.exec(line);
      const observedPid = brief?.[1] ?? threadtime?.[1];
      if (!observedPid || String(Number(observedPid)) !== targetPid) continue;
    }
    const m = /\bstage=(before-super|after-super|resumed) classPresent=(true|false) configured=(true|false|unknown)\b/.exec(line);
    if (!m || !allowed.has(m[1])) continue;
    if (samples.length < 20) {
      samples.push({
        stage: m[1],
        classPresent: m[2] === 'true',
        configured: m[3] === 'unknown' ? null : m[3] === 'true',
      });
    }
  }
  return {
    available: samples.length > 0,
    samples: samples.length,
    anyClassPresent: samples.some((s) => s.classPresent),
    anyConfigured: samples.some((s) => s.configured === true),
    beforeSuper: samples.find((s) => s.stage === 'before-super')?.configured ?? null,
    afterSuper: samples.find((s) => s.stage === 'after-super')?.configured ?? null,
    lastResume: [...samples].reverse().find((s) => s.stage === 'resumed')?.configured ?? null,
    unknownConfigured: samples.filter((s) => s.configured === null).length,
  };
}
