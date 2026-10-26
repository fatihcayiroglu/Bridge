// CR00 — real emulator calibration, NOT a Bridge product acceptance journey.
// Trigger once after product tests; require the same production diagnostic
// parser/probe to correlate the known Java crash with Android's own exit row.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { readAndroidCrashClock, collectAndroidJavaCrashEvidence } from './java-crash-probe.mjs';

const exec = promisify(execFile);
const pkg = process.env.ANDROID_PKG || 'com.bridge.app.debug';
const result = { case: 'CR00', evidenceCategory: 'UNKNOWN', status: 'FAIL',
  commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null,
  evidence: null, failure: null, failureStage: null };
let stage = 'configuration';
class ControlFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const shell = async command => (await exec('adb', ['shell', command],
  { timeout: 6000, maxBuffer: 1 << 20, encoding: 'utf8' })).stdout.trim();

try {
  if (!/^[A-Za-z][A-Za-z0-9_.]{0,112}\.debug$/.test(pkg)) throw new ControlFailure('invalid-debug-package');
  stage = 'emulator';
  const qemu = await shell('getprop ro.kernel.qemu');
  const bootQemu = await shell('getprop ro.boot.qemu');
  if (qemu !== '1' && bootQemu !== '1') throw new ControlFailure('not-emulator');
  result.evidenceCategory = 'AUTOMATED / EMULATOR';
  stage = 'prepare';
  await shell(`am force-stop ${pkg}`);
  stage = 'clock';
  const start = await readAndroidCrashClock(shell);
  if (!start) throw new ControlFailure('clock-unavailable');
  // One launch only. Polling below waits for asynchronous OS exit recording;
  // it never relaunches the app, retries the crash, clears logs or injects data.
  stage = 'launch';
  const launched = await shell(`am start -n ${pkg}/com.bridge.app.JavaCrashControlActivity`);
  if (!/^Starting: Intent/m.test(launched) || /Error:/m.test(launched)) throw new ControlFailure('launch-failed');
  const deadline = performance.now() + 20000;
  stage = 'observe';
  while (performance.now() < deadline) {
    const raw = await shell('logcat -d -b crash -v epoch -t 200');
    result.evidence = await collectAndroidJavaCrashEvidence(shell, pkg, start, raw);
    if (result.evidence.crashes.length) break;
    await sleep(250);
  }
  if (result.evidence?.crashes.length !== 1) throw new ControlFailure('correlation-unavailable');
  stage = 'verify';
  const actual = result.evidence.crashes[0];
  if (!result.evidence.windowValid || !result.evidence.exitInfoAvailable ||
      result.evidence.coverage !== 'observed-only' || result.evidence.truncated ||
      actual.thread !== 'main' || actual.exception !== 'illegal-state' || actual.context !== 'other' ||
      actual.lastObservedCause !== 'none' || actual.causeDepth !== 0) throw new ControlFailure('unexpected-category');
  result.status = 'PASS';
} catch (error) {
  // adb/Android errors may carry paths, device IDs, intents or raw log lines.
  // Export only this closed failure vocabulary, never their messages/stacks.
  result.failure = error instanceof ControlFailure ? error.code : 'probe-unavailable';
  result.failureStage = stage;
} finally {
  try {
    if (result.evidenceCategory === 'AUTOMATED / EMULATOR') await shell(`am force-stop ${pkg}`);
  } catch {
    result.status = 'FAIL';
    result.failure = 'cleanup-failed';
    result.failureStage = 'cleanup';
  }
  const out = new URL('./results/java-crash-control.json', import.meta.url);
  fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log('CR00 ' + result.status + ' ' + JSON.stringify(result));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
