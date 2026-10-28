// Integrity-pinned acquisition of React Native's prebuilt iOS tarballs.
// CocoaPods otherwise downloads them with a bare curl and "verifies" them against a SHA-1 fetched
// from the same host (skipped when absent). Here every byte is checked against a committed SHA-512
// before it is placed in the cache CocoaPods reads, so a corrupt, truncated or substituted file can
// never be used. Transfers are bounded and each attempt is recorded; the first failure is kept.
// TLS verification is never relaxed. An integrity mismatch is final (never retried).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_ATTEMPTS = 3;
const SHA512 = /^[0-9a-f]{128}$/;

export function curlArgs(url, out) {
  return ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '20', '--speed-limit', '51200', '--speed-time', '30', '--max-time', '900',
    '--retry', '0', '--output', out, url];
}

export function validatePins(pins, rnVersion, hermesVersion) {
  if (pins?.reactNativeVersion !== rnVersion) throw new Error(`PINS_VERSION_MISMATCH pinned=${pins?.reactNativeVersion} installed=${rnVersion}`);
  if (hermesVersion !== undefined && !hermesVersion.includes(pins.hermesVersion)) throw new Error(`PINS_HERMES_MISMATCH pinned=${pins?.hermesVersion} installed=${hermesVersion}`);
  const entries = Object.entries(pins.artifacts ?? {});
  if (!entries.length) throw new Error('PINS_EMPTY');
  for (const [name, a] of entries) {
    if (!SHA512.test(a?.sha512 ?? '')) throw new Error(`PIN_INVALID ${name}`);
    if (!/^[a-z0-9.-]+\.tar\.gz$/.test(name) || !(name.includes(rnVersion) || name.includes(pins.hermesVersion))) throw new Error(`PIN_NAME_INVALID ${name}`);
    if (!/^[\w./-]+\.tar\.gz$/.test(a.path ?? '') || a.path.includes('..') || !String(a.defaultBase).startsWith('https://')) throw new Error(`PIN_SOURCE_INVALID ${name}`);
  }
  return entries;
}

export function sha512File(path) { return createHash('sha512').update(readFileSync(path)).digest('hex'); }

export function artifactUrl(base, path) {
  const root = String(base).replace(/\/+$/, '');
  if (!root.startsWith('https://')) throw new Error('HTTPS_REQUIRED');
  return `${root}/${path}`;
}

function curlDownload(url, out) {
  const t = Date.now();
  const r = spawnSync('curl', curlArgs(url, out), { encoding: 'utf8', timeout: 960000 });
  return { exit: r.status, signal: r.signal, stderr: String(r.stderr || '').trim().slice(0, 300), seconds: Math.round((Date.now() - t) / 100) / 10 };
}

export function prefetch({ pins, rnVersion, hermesVersion, cacheDir, base, download = curlDownload, maxAttempts = MAX_ATTEMPTS }) {
  const entries = validatePins(pins, rnVersion, hermesVersion);
  mkdirSync(cacheDir, { recursive: true });
  const report = { rnVersion, hermesVersion: hermesVersion ?? null, status: 'PASS', artifacts: [] };
  for (const [name, pin] of entries) {
    const dest = join(cacheDir, name);
    const item = { name, expectedSha512: pin.sha512, source: 'download', attempts: [] };
    report.artifacts.push(item);
    if (existsSync(dest) && sha512File(dest) === pin.sha512) { item.source = 'cache-verified'; continue; }
    rmSync(dest, { force: true });
    const url = artifactUrl(base || pin.defaultBase, pin.path);
    item.host = new URL(url).host;
    for (let n = 1; n <= maxAttempts && !item.verified; n++) {
      const tmp = `${dest}.part`;
      rmSync(tmp, { force: true });
      const a = { n, ...download(url, tmp) };
      item.attempts.push(a);
      if (a.exit !== 0 || !existsSync(tmp)) { a.result = 'TRANSFER_FAILED'; continue; }
      a.bytes = statSync(tmp).size;
      a.sha512 = sha512File(tmp);
      if (a.sha512 !== pin.sha512) { a.result = 'INTEGRITY_MISMATCH'; rmSync(tmp, { force: true }); break; }
      renameSync(tmp, dest);
      a.result = 'VERIFIED';
      item.verified = true;
    }
    if (!item.verified) { report.status = 'FAIL'; report.failed = name; report.reason = item.attempts.at(-1).result; break; }
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pins = JSON.parse(readFileSync(join(root, 'ios-prebuilt-pins.json'), 'utf8'));
  const rnVersion = JSON.parse(readFileSync(join(root, 'node_modules/react-native/package.json'), 'utf8')).version;
  const base = process.env.ENTERPRISE_REPOSITORY || '';
  const hermesVersion = Object.fromEntries(readFileSync(join(root, 'node_modules/react-native/sdks/hermes-engine/version.properties'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')))['HERMES_V1_VERSION_NAME'];
  const evidence = process.env.PREFETCH_EVIDENCE || join(root, '..', 'mobile-auth-evidence', 'prefetch-ios-prebuilt.json');
  let report;
  try {
    report = prefetch({ pins, rnVersion, hermesVersion, cacheDir: join(homedir(), 'Library', 'Caches', 'ReactNative'), base });
  } catch (e) { report = { rnVersion, status: 'FAIL', reason: String(e.message).slice(0, 200), artifacts: [] }; }
  mkdirSync(dirname(evidence), { recursive: true });
  writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`IOS_PREBUILT_PREFETCH ${report.status} ${JSON.stringify(report.artifacts.map(a => [a.name, a.source, a.attempts.length]))}`);
  if (report.status !== 'PASS') { console.error(`IOS_PREBUILT_PREFETCH_FAILED ${report.failed ?? ''} ${report.reason}`); process.exit(1); }
}
