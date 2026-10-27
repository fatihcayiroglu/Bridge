// #209: CPU contention on the CI HOST while the emulator cold-starts the app.
//
// With `-gpu swiftshader_indirect` the emulator renders GL on the host, so the
// guest's 2 vCPUs, SwiftShader's raster threads, the Bridge server, PostgreSQL,
// mediasoup and this harness all share the runner's cores. The guest's own
// ANR record cannot see that competition. This sampler reads only /proc (no
// subprocess, so it adds almost no load itself) and reports numbers per fixed
// category. No command lines, pids, paths or user names leave this module.
import fs from 'node:fs';

export const HOST_CPU_CLASSES = ['emulator', 'harness', 'node_other', 'postgres', 'redis', 'mediasoup', 'other'];

/** Category of a host process from its `comm` name; `selfPid` is this harness. */
export function hostCpuClass(comm, pid, selfPid) {
  if (pid === selfPid) return 'harness';
  const c = String(comm);
  if (/^(?:qemu-system|emulator|crashpad_handle|netsimd)/.test(c)) return 'emulator';
  if (c === 'node' || c === 'MainThread') return 'node_other';
  if (c === 'postgres') return 'postgres';
  if (c.startsWith('redis')) return 'redis';
  if (c.startsWith('mediasoup')) return 'mediasoup';
  return 'other';
}

/** Total jiffies and idle jiffies from the first line of /proc/stat. */
export function parseProcStatTotals(raw) {
  const line = String(raw).split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 4 || v.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const idle = v[3] + (v[4] ?? 0);
  const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
  return { total, idle };
}

/** utime+stime (jiffies) and comm of one /proc/<pid>/stat line. */
export function parsePidStat(raw) {
  const s = String(raw);
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const comm = s.slice(open + 1, close).slice(0, 32);
  const rest = s.slice(close + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { comm, cpu: utime + stime };
}

/** Load averages from /proc/loadavg. */
export function parseLoadavg(raw) {
  const m = /^\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(String(raw));
  return m ? m.slice(1, 4).map(Number) : null;
}

function readHostSnapshot(selfPid, procRoot) {
  const totals = parseProcStatTotals(fs.readFileSync(`${procRoot}/stat`, 'utf8'));
  const perClass = Object.fromEntries(HOST_CPU_CLASSES.map((k) => [k, 0]));
  const perPid = new Map();
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^\d{1,8}$/.test(name)) continue;
    let st;
    try { st = parsePidStat(fs.readFileSync(`${procRoot}/${name}/stat`, 'utf8')); } catch { continue; }
    if (!st) continue;
    perPid.set(name, { klass: hostCpuClass(st.comm, Number(name), selfPid), cpu: st.cpu });
  }
  let load = null;
  try { load = parseLoadavg(fs.readFileSync(`${procRoot}/loadavg`, 'utf8')); } catch { load = null; }
  return { totals, perPid, perClass, load };
}

/** Pure: per-interval CPU shares (0-100 of ALL host cores) from two snapshots. */
export function intervalShares(a, b) {
  if (!a?.totals || !b?.totals) return null;
  const dt = b.totals.total - a.totals.total;
  if (!(dt > 0)) return null;
  const busyPct = Math.max(0, Math.min(100, 100 * (dt - (b.totals.idle - a.totals.idle)) / dt));
  const byClass = Object.fromEntries(HOST_CPU_CLASSES.map((k) => [k, 0]));
  for (const [pid, now] of b.perPid) {
    const before = a.perPid.get(pid);
    const used = now.cpu - (before ? before.cpu : now.cpu); // a new process counts from first sight
    if (used > 0) byClass[now.klass] += 100 * used / dt;
  }
  for (const k of HOST_CPU_CLASSES) byClass[k] = Math.round(Math.min(100, byClass[k]) * 10) / 10;
  return { busyPct: Math.round(busyPct * 10) / 10, byClass };
}

/** Pure: summary of interval shares. */
export function summarizeHostCpu(intervals, cores, loadEnd) {
  const rows = intervals.filter(Boolean);
  const stat = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((x, y) => x - y);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    return { avg: Math.round(avg * 10) / 10, max: sorted.at(-1), p90: sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))] };
  };
  return {
    intervals: rows.length,
    cores,
    busyPct: stat(rows.map((r) => r.busyPct)),
    saturatedIntervals: rows.filter((r) => r.busyPct >= 95).length,
    byClassAvgPct: Object.fromEntries(HOST_CPU_CLASSES.map((k) => [k, stat(rows.map((r) => r.byClass[k]))?.avg ?? null])),
    loadEnd,
  };
}

/** Samples host CPU every `intervalMs` until stop(); never throws into the caller. */
export function startHostCpuSampler({ intervalMs = 500, selfPid = process.pid, procRoot = '/proc', cores = null } = {}) {
  const intervals = [];
  let previous = null;
  let failed = false;
  const tick = () => {
    try {
      const snap = readHostSnapshot(selfPid, procRoot);
      if (previous) intervals.push(intervalShares(previous, snap));
      previous = snap;
    } catch { failed = true; }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never keeps the harness process alive
  let result = null;
  return {
    /** Idempotent: the first call ends sampling; later calls return the same summary. */
    stop() {
      if (result) return result;
      clearInterval(timer);
      tick();
      result = failed && intervals.length === 0
        ? { available: false }
        : { available: true, ...summarizeHostCpu(intervals, cores, previous?.load ?? null) };
      return result;
    },
  };
}
