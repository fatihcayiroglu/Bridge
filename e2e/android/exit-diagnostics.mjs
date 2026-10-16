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
export function parseDependencyKillLine(raw, expectedPid) {
  if (!/^[0-9]{1,7}$/.test(String(expectedPid))) return null;
  const prefix = new RegExp('\\bKilling ' + expectedPid + ':');
  const line = String(raw).split('\n').find((item) => prefix.test(item)) ?? '';
  const m = /depends on provider ([A-Za-z0-9_.$/]{1,200}) in dying proc ([A-Za-z0-9_.:]{1,120})/.exec(line);
  return m ? { provider: m[1], dyingProcess: m[2] } : { provider: null, dyingProcess: null, killLineFound: Boolean(line) };
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
