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
