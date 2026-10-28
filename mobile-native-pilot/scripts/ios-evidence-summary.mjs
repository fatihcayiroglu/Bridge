// Prints the few facts needed to read an iOS run from the END of its job log (artifacts cannot always be
// downloaded). Allow-listed fields only: no fixture names, ids, tokens or raw driver traffic.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const POD_LINE = /\[(ReactNativeCore|ReactNativeDependencies|Cache)\]/;
export function pick(obj, keys) { return Object.fromEntries(keys.filter((k) => obj && k in obj).map((k) => [k, obj[k]])); }
export function prefetchSummary(report) {
  return { status: report?.status ?? null, failed: report?.failed ?? null, reason: report?.reason ?? null,
    artifacts: (report?.artifacts ?? []).map((a) => ({ name: a.name, source: a.source, attempts: (a.attempts ?? []).map((t) => ({ n: t.n, exit: t.exit, seconds: t.seconds, bytes: t.bytes, result: t.result })) })) };
}
// `driverFailure` / raw driver or server messages are deliberately NOT printed: they can carry credentials or
// callback URLs. Only the closed failure code, element counts and the foreground bundle id are safe.
export function journeySummary(r) {
  const ui = r?.failureUi && typeof r.failureUi === 'object' ? pick(r.failureUi, ['webViews', 'textFields', 'secureFields', 'alerts']) : undefined;
  return { ...pick(r, ['status', 'stage', 'runtimeVersion', 'driverDeadlineMs', 'failure', 'physicalDevice']),
    cases: (r?.cases ?? []).map((c) => pick(c, ['id', 'status'])),
    ...(ui ? { failureUi: ui } : {}),
    ...(typeof r?.failureApplication?.bundleId === 'string' ? { foregroundBundle: r.failureApplication.bundleId.slice(0, 80) } : {}),
    passed: (r?.cases ?? []).filter((c) => c.status === 'PASS').length, failed: (r?.cases ?? []).filter((c) => c.status === 'FAIL').length,
    notExecuted: Array.isArray(r?.notExecuted) ? r.notExecuted.length : null };
}
export function podCacheLines(text, max = 30) {
  return String(text ?? '').split('\n').filter((l) => POD_LINE.test(l)).map((l) => l.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 220)).slice(-max);
}
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  console.log('IOS_EVIDENCE_SUMMARY_BEGIN');
  console.log('prefetch ' + JSON.stringify(prefetchSummary(readJson(join(dir, 'prefetch-ios-prebuilt.json')))));
  console.log('journey ' + JSON.stringify(journeySummary(readJson(join(dir, 'ios-browser-auth.json')))));
  const pods = join(dir, 'pods.log');
  for (const l of existsSync(pods) ? podCacheLines(readFileSync(pods, 'utf8')) : ['(no pods.log)']) console.log('pods| ' + l);
  console.log('IOS_EVIDENCE_SUMMARY_END');
}
