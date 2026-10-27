// Fail closed: an incomplete Node test run is never a successful survivor.
export function classifyNodeRun({ stdout = '', stderr = '', status, signal, error }) {
  const text = `${stdout}\n${stderr}`;
  if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(text)) return { outcome: 'INVALID', counts: {} };
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    if (matches.length !== 1) return { outcome: error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'INVALID', counts };
    counts[name] = Number(matches[0][1]);
  }
  if (error?.code === 'ETIMEDOUT' || signal) return { outcome: 'TIMEOUT', counts };
  if (!counts.tests || counts.skipped || counts.todo || counts.tests !== counts.pass + counts.fail + counts.cancelled) return { outcome: 'INVALID', counts };
  if (counts.fail || counts.cancelled) return { outcome: status !== 0 ? 'DETECTED' : 'INVALID', counts };
  return { outcome: status === 0 ? 'SURVIVED' : 'INVALID', counts };
}
