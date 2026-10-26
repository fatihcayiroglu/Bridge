import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseChoreographerSkips, summarizeStartupSkips, parseStallProbeTimeline, attributeStallPhases, summarizeStallPhases,
  collectPageTiming, compactPageTiming, rendererOverlap, summarizeRendererOverlap,
} from './frame-skip-evidence.mjs';

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

test('#209 CS00 records the same non-asserting stall evidence per control kind', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const cs00 = source.slice(source.indexOf("await measure('CS00'"), source.indexOf('const measureAn00 ='));
  assert.match(cs00, /skippedFrames: parseChoreographerSkips\(await startupLog\('Choreographer'\), firstPid\)/);
  assert.match(cs00, /mainThreadStalls: parseStallProbe\(await startupLog\('BridgeStallProbe'\), firstPid\)/);
  assert.match(cs00, /stallsByKind: byKind/);
  assert.doesNotMatch(cs00, /assert\([^)]*(skippedFrames|mainThreadStalls)/);
});

const epochLine = (sec, ms, pid, message) =>
  `${sec}.${String(ms).padStart(3, '0')}  ${pid}  ${pid} I BridgeStallProbe: ${message}`;
const stallMsg = (ms, where) => `event=stall ms=${ms} msg=frame where=${where} via=none samples=3`;

test('#209 stall timeline keeps only this PID, categories and times', () => {
  const raw = [
    epochLine(1793052300, 0, 4321, 'event=installed windowMs=90000 reportMs=250'),
    epochLine(1793052301, 500, 4321, stallMsg(500, 'render')),
    epochLine(1793052302, 0, 999, stallMsg(900, 'render')),
    epochLine(1793052303, 0, 4321, 'event=stall ms=300 msg=frame where=SomeClass via=none samples=1'),
    'BridgeStallProbe garbage',
  ].join('\n');
  const timeline = parseStallProbeTimeline(raw, 4321);
  assert.equal(timeline.available, true);
  assert.equal(timeline.malformed, 2);
  assert.deepEqual(timeline.stalls, [{ startEpochMs: 1793052301000, endEpochMs: 1793052301500, ms: 500,
    msg: 'frame', where: 'render' }]);
  assert.equal(parseStallProbeTimeline(undefined, 4321).available, false);
});

test('#209 stalls are attributed to the phase their dispatch began in', () => {
  const t0 = 1793052300000;
  const raw = [
    epochLine(1793052300, 400, 4321, stallMsg(300, 'classload')), // starts t0+100: before displayed
    epochLine(1793052306, 0, 4321, stallMsg(5000, 'render')), // starts t0+1000: displayed->attached, ends after attached
    epochLine(1793052309, 0, 4321, stallMsg(400, 'render')), // starts t0+8600: attached->visible
    epochLine(1793052311, 0, 4321, stallMsg(300, 'binder')), // starts t0+10700: after visible
  ].join('\n');
  const marks = { displayed: t0 + 500, attached: t0 + 3000, visible: t0 + 10000 };
  const result = attributeStallPhases(parseStallProbeTimeline(raw, 4321), marks, 'ms');
  assert.equal(result.available, true);
  assert.deepEqual(Object.fromEntries(Object.entries(result.phases).map(([k, v]) => [k, v.stalls])),
    { 'before-displayed': 1, 'displayed-to-attached': 1, 'attached-to-visible': 1, 'after-visible': 1 });
  assert.equal(result.phases['displayed-to-attached'].maxMs, 5000);
  assert.equal(result.straddling, 1);
  assert.deepEqual(result.phaseMs, { displayedToAttached: 2500, attachedToVisible: 7000 });
  assert.equal(attributeStallPhases(parseStallProbeTimeline(raw, 4321),
    { displayed: t0 + 3000, attached: t0 + 500, visible: t0 + 10000 }, 'ms').available, false);

  const summary = summarizeStallPhases([{ stallPhases: result }, { stallPhases: result }, { stallPhases: null }]);
  assert.equal(summary.measured, 2);
  assert.deepEqual(summary.precisions, ['ms']);
  assert.equal(summary.straddling, 2);
  assert.deepEqual(summary.phases['displayed-to-attached'], { stalls: 2, totalMs: 10000, maxMs: 5000, byWhere: { render: 2 } });
});

test('#209 CS01 records phase attribution without asserting on it; SF02 reports it', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const cs01 = source.slice(source.indexOf('const startupStallTimeline ='), source.indexOf("await measure('SF01'"));
  assert.match(cs01, /stallPhases = startupStallPhases\(stallTimeline, origin, hostMarks\)/);
  assert.match(cs01, /hostMarks\.attached = Date\.now\(\)/);
  assert.match(cs01, /hostMarks\.visible = Date\.now\(\)/);
  assert.doesNotMatch(cs01, /assert\([^)]*(stallPhases|hostMarks)/);
  assert.match(source, /phases: summarizeStallPhases\(facts\.androidColdStartSamples\)/);
});

test('#209 page timing leaves the page as numbers only, from buffered observers', async () => {
  const saved = { performance: globalThis.performance, PerformanceObserver: globalThis.PerformanceObserver };
  const entries = {
    longtask: [{ startTime: 100, duration: 80.4, name: 'self', attribution: [{ containerSrc: 'https://secret.example/x' }] }],
    'long-animation-frame': [{ startTime: 90, duration: 120, blockingDuration: 70, styleAndLayoutStart: 190,
      scripts: [{ duration: 60, sourceURL: 'https://secret.example/app.js', invoker: 'secret' }] }],
  };
  class FakeObserver {
    static supportedEntryTypes = ['longtask', 'long-animation-frame', 'paint'];
    constructor(callback) { this.callback = callback; }
    observe({ type, buffered }) { assert.equal(buffered, true); queueMicrotask(() => this.callback({ getEntries: () => entries[type] })); }
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: {
    timeOrigin: 1793052300000.5,
    getEntriesByType: type => type === 'navigation'
      ? [{ name: 'https://secret.example/', responseEnd: 50, domContentLoadedEventEnd: 400, loadEventEnd: 900 }]
      : type === 'paint' ? [{ name: 'first-paint', startTime: 300 }, { name: 'first-contentful-paint', startTime: 350 }] : [],
  } });
  globalThis.PerformanceObserver = FakeObserver;
  try {
    const timing = await collectPageTiming();
    assert.doesNotMatch(JSON.stringify(timing), /secret|https?:/);
    assert.deepEqual(timing.longTasks, [{ startEpochMs: 1793052300101, ms: 80 }]);
    assert.deepEqual(timing.longAnimationFrames, [{ startEpochMs: 1793052300091, ms: 120, blockingMs: 70, scriptMs: 60,
      styleLayoutMs: 20 }]);
    assert.equal(timing.firstContentfulPaintEpochMs, 1793052300351);
    assert.deepEqual(compactPageTiming(timing).longAnimationFrames,
      { count: 1, totalMs: 120, maxMs: 120, scriptMs: 60, styleLayoutMs: 20, blockingMs: 70 });
  } finally {
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: saved.performance });
    globalThis.PerformanceObserver = saved.PerformanceObserver;
  }
});

test('#209 renderer overlap separates busy-page stalls from idle-page stalls', () => {
  const t0 = 1793052300000;
  const timeline = { available: true, stalls: [
    { startEpochMs: t0, endEpochMs: t0 + 1000, ms: 1000, msg: 'frame', where: 'render' }, // page busy 800 ms
    { startEpochMs: t0 + 5000, endEpochMs: t0 + 6000, ms: 1000, msg: 'frame', where: 'render' }, // page idle
  ] };
  const pageTiming = { available: true, supported: { longtask: true, longAnimationFrame: false },
    firstContentfulPaintEpochMs: t0 + 2000,
    longTasks: [{ startEpochMs: t0 + 100, ms: 500 }, { startEpochMs: t0 + 700, ms: 1000 }], longAnimationFrames: [] };
  const overlap = rendererOverlap(timeline, pageTiming);
  assert.deepEqual(overlap, { available: true, stalls: 2, stallMs: 2000, rendererBusyMs: 800, longFrameMs: null,
    stallsMostlyBusy: 1, stallsMostlyIdle: 1, beforeFirstContentfulPaint: 1 });
  assert.equal(rendererOverlap(timeline, { ...pageTiming, supported: { longtask: false } }).available, false);
  const summary = summarizeRendererOverlap([
    { rendererOverlap: overlap, pageTiming: compactPageTiming(pageTiming) },
    { rendererOverlap: null, pageTiming: null },
  ]);
  assert.equal(summary.measured, 1);
  assert.equal(summary.rendererBusyMs, 800);
  assert.equal(summary.longFrameMs, null);
  assert.deepEqual(summary.longTasks, { count: 2, totalMs: 1500, maxMs: 1000 });
});

test('#209 CS01 reads page timing without asserting on it; SF02 reports it', () => {
  const source = readFileSync(new URL('./android-journeys.mjs', import.meta.url), 'utf8');
  const cs01 = source.slice(source.indexOf('const startupStallTimeline ='), source.indexOf("await measure('SF01'"));
  assert.match(cs01, /page\.evaluate\(collectPageTiming\)/);
  assert.match(cs01, /rendererOverlap = rendererOverlap\(stallTimeline, pageTiming\)/);
  assert.doesNotMatch(cs01, /assert\([^)]*(pageTiming|rendererOverlap)/);
  assert.match(source, /renderer: summarizeRendererOverlap\(facts\.androidColdStartSamples\)/);
});
