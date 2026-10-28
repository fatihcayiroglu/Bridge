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
  return { ...pick(r, ['status', 'stage', 'runtimeVersion', 'driverDeadlineMs', 'failure', 'physicalDevice', 'signInMatches']),
    cases: (r?.cases ?? []).map((c) => pick(c, ['id', 'status'])),
    ...(ui ? { failureUi: ui } : {}),
    ...(typeof r?.failureApplication?.bundleId === 'string' ? { foregroundBundle: r.failureApplication.bundleId.slice(0, 80) } : {}),
    passed: (r?.cases ?? []).filter((c) => c.status === 'PASS').length, failed: (r?.cases ?? []).filter((c) => c.status === 'FAIL').length,
    notExecuted: Array.isArray(r?.notExecuted) ? r.notExecuted.length : null };
}
export function podCacheLines(text, max = 30) {
  return String(text ?? '').split('\n').filter((l) => POD_LINE.test(l)).map((l) => l.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 220)).slice(-max);
}
// The proxy logs only a closed `kind`, the HTTP status and two booleans per native-auth request (no URLs, codes,
// tokens or bodies). Print the ordered sequence, run-length compressed, so a stalled step shows which request
// happened and what the server answered.
export function wireSequence(text, max = 60) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('NATIVE_AUTH_HTTP ')) continue;
    let r; try { r = JSON.parse(line.slice(17)); } catch { continue; }
    if (typeof r?.kind !== 'string' || !/^[a-z][\w-]{0,40}$/.test(r.kind)) continue;
    const label = `${r.kind}:${Number.isInteger(r.status) ? r.status : '?'}`;
    const last = out[out.length - 1];
    if (last && last.label === label) last.n += 1; else out.push({ label, n: 1 });
  }
  return out.slice(-max).map((e) => (e.n > 1 ? `${e.label}x${e.n}` : e.label));
}
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  console.log('IOS_EVIDENCE_SUMMARY_BEGIN');
  console.log('prefetch ' + JSON.stringify(prefetchSummary(readJson(join(dir, 'prefetch-ios-prebuilt.json')))));
  console.log('journey ' + JSON.stringify(journeySummary(readJson(join(dir, 'ios-browser-auth.json')))));
  const proxy = join(dir, 'proxy.log');
  console.log('wire ' + JSON.stringify(existsSync(proxy) ? wireSequence(readFileSync(proxy, 'utf8')) : '(no proxy.log)'));
  const pods = join(dir, 'pods.log');
  for (const l of existsSync(pods) ? podCacheLines(readFileSync(pods, 'utf8')) : ['(no pods.log)']) console.log('pods| ' + l);
  console.log('IOS_EVIDENCE_SUMMARY_END');
}
