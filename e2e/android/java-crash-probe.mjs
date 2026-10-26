// Shared by attachment-failure diagnostics and the real-emulator control.
// Raw shell output stays in memory; callers receive fixed categories only.
import { parseAndroidCrashClock, parseApplicationExits, summarizeAndroidJavaCrashes } from './exit-diagnostics.mjs';

export async function readAndroidCrashClock(shell) {
  try {
    return parseAndroidCrashClock(await shell('date +%s.%N,%Y-%m-%dT%H:%M:%S,%z'));
  } catch { return null; }
}

export async function collectAndroidJavaCrashEvidence(shell, pkg, start, rawCrashLog) {
  let exits = null;
  let end = null;
  if (start && /^[A-Za-z][A-Za-z0-9_.]{0,119}$/.test(pkg)) {
    try {
      exits = parseApplicationExits(await shell(`dumpsys activity exit-info ${pkg}`), 32);
    } catch { /* missing OS corroboration stays unknown */ }
    end = await readAndroidCrashClock(shell);
  }
  return summarizeAndroidJavaCrashes(rawCrashLog, pkg, start, end, exits);
}
