import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChoreographerSkips, summarizeStartupSkips } from './frame-skip-evidence.mjs';

const line = (pid, frames) =>
  `I/Choreographer( ${pid}): Skipped ${frames} frames!  The application may be doing too much work on its main thread.`;

test('#209 counts Choreographer stalls for the exact app PID only', () => {
  const raw = [line(4321, 123), line(4321, 31), line(999, 400),
    'I/Choreographer( 4321): Frame time is 12.5 ms in the future!', 'garbage Choreographer line'].join('\n');
  assert.deepEqual(parseChoreographerSkips(raw, '4321'), {
    available: true, reports: 2, totalFrames: 154, maxFrames: 123, foreignPidLines: 1, unparsedLines: 1,
  });
});

test('#209 zero reports is "no stall at or above the limit", and bad input is unavailable', () => {
  assert.equal(parseChoreographerSkips('', '4321').reports, 0);
  assert.equal(parseChoreographerSkips('', '4321').available, true);
  assert.equal(parseChoreographerSkips(undefined, '4321').available, false);
  assert.equal(parseChoreographerSkips(line(1, 50), 'not-a-pid').available, false);
});

test('#209 the summary is measurement only and keeps unknown starts out of the counts', () => {
  const summary = summarizeStartupSkips([
    { skippedFrames: parseChoreographerSkips(line(1, 123), '1') },
    { skippedFrames: parseChoreographerSkips('', '2') },
    { skippedFrames: null },
  ]);
  assert.deepEqual({ ...summary, limitNote: undefined }, {
    coldStarts: 3, measured: 2, startsWithStall: 1, maxFrames: 123, totalReports: 1, unparsedLines: 0, limitNote: undefined,
  });
  assert.match(summary.limitNote, /SKIPPED_FRAME_WARNING_LIMIT/);
});

test('#209 CS01 records stalls without changing its assertions, and SF01 is a measurement', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const cs01 = source.slice(source.indexOf("await check('CS01'"), source.indexOf("await check('A02'"));
  assert.match(cs01, /skippedFrames: await startupSkips\(initialPid\)/);
  assert.match(cs01, /assert\(finalPid === initialPid,/);
  assert.match(cs01, /assert\(newAnrs === baselineAnrs,/);
  assert.doesNotMatch(cs01, /assert\([^)]*skippedFrames/);
  assert.match(source, /await measure\('SF01', /);
});

import { parseStallProbe, stallProbeCalibrated, summarizeStartupStallProbe } from './frame-skip-evidence.mjs';

const probe = (pid, msg) => `I/BridgeStallProbe( ${pid}): ${msg}`;

test('#209 stall probe lines become allowlisted category counts for the exact PID', () => {
  const raw = [
    probe(7, 'event=installed windowMs=90000 reportMs=250'),
    probe(7, 'event=stall ms=1800 msg=activity-thread where=webview via=capacitor samples=34'),
    probe(7, 'event=stall ms=400 msg=frame where=render via=none samples=6'),
    probe(8, 'event=stall ms=9000 msg=frame where=sleep via=none samples=9'),
    probe(7, 'event=stall ms=300 msg=frame where=com.secret.Class via=none samples=1'),
    probe(7, 'event=uninstalled stalls=2 maxMs=1800'),
  ].join('\n');
  const r = parseStallProbe(raw, 7);
  assert.deepEqual(r, { available: true, installed: true, stalls: 2, maxMs: 1800, totalMs: 2200,
    byWhere: { webview: 1, render: 1 }, byMsg: { 'activity-thread': 1, frame: 1 }, byVia: { capacitor: 1, none: 1 },
    malformed: 1 });
  assert.doesNotMatch(JSON.stringify(r), /secret/);
});

test('#209 calibration requires an installed probe that saw the control sleep', () => {
  const ok = parseStallProbe([probe(1, 'event=installed windowMs=90000 reportMs=250'),
    probe(1, 'event=stall ms=1510 msg=other where=sleep via=bridge samples=28')].join('\n'), 1);
  assert.equal(stallProbeCalibrated(ok, 1500), true);
  const short = parseStallProbe([probe(1, 'event=installed windowMs=90000 reportMs=250'),
    probe(1, 'event=stall ms=600 msg=other where=sleep via=bridge samples=9')].join('\n'), 1);
  assert.equal(stallProbeCalibrated(short, 1500), false);
  assert.equal(stallProbeCalibrated(parseStallProbe('', 1), 1500), false);
  const wrongWhere = parseStallProbe([probe(1, 'event=installed windowMs=90000 reportMs=250'),
    probe(1, 'event=stall ms=1600 msg=other where=other via=bridge samples=28')].join('\n'), 1);
  assert.equal(stallProbeCalibrated(wrongWhere, 1500), false);
});

test('#209 the cold-start probe aggregate merges categories and skips unavailable starts', () => {
  const a = parseStallProbe([probe(1, 'event=installed windowMs=90000 reportMs=250'),
    probe(1, 'event=stall ms=2000 msg=activity-thread where=webview via=capacitor samples=40')].join('\n'), 1);
  const b = parseStallProbe([probe(2, 'event=installed windowMs=90000 reportMs=250'),
    probe(2, 'event=stall ms=500 msg=frame where=webview via=none samples=8')].join('\n'), 2);
  assert.deepEqual(summarizeStartupStallProbe([{ mainThreadStalls: a }, { mainThreadStalls: b }, { mainThreadStalls: null }]), {
    measured: 2, installed: 2, stalls: 2, maxMs: 2000, byWhere: { webview: 2 },
    byMsg: { 'activity-thread': 1, frame: 1 }, byVia: { capacitor: 1, none: 1 }, malformed: 0 });
});

test('#209 SF02 is product measurement only; the probe is calibrated by AN00 in the controls suite', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const sf02 = source.slice(source.indexOf("await measure('SF02'"), source.indexOf('// EX01 runs AFTER'));
  assert.match(sf02, /calibratedInRun: false/);
  assert.doesNotMatch(sf02, /MainThreadStallControlActivity|am start/);
  const an00 = source.slice(source.indexOf('const measureAn00 ='), source.indexOf("await measureAn00('AN00', 7_000);"));
  assert.match(an00, /calibrated: stallProbeCalibrated\(stallProbe, stallMs\)/);
  const manifest = readFileSync(new URL('../../mobile/android/app/src/debug/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:name="com\.bridge\.app\.MainThreadStallProbeProvider"[\s\S]*?android:exported="false"/);
  const mainManifest = readFileSync(new URL('../../mobile/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.doesNotMatch(mainManifest, /StallProbe/);
});
