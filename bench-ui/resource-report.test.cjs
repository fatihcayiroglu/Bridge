'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('./resource-report.cjs');

const scenarioSpecs = {
  idle: [0, false, false], messages: [0, false, true],
  voice2: [1, false, false], voice5: [4, false, false],
  voice10: [9, false, false], video2: [1, true, false],
  screen2: [1, true, false], voice2_chat: [1, false, true],
};
const metric = (p50 = 2) => ({ samples: 5, p50, p95: p50 });
function candidate(mode) {
  const [links, video, chat] = scenarioSpecs[mode];
  const raw = () => ({
    mode, measuredMs: 1500, uiWorkMs: chat ? 300 : 0,
    rendererCpuIntervalPercent: 18.5, rendererWorkingSetMB: 260,
    rendererTaskSeconds: 0.35,
    audio: links ? { peerLinks: links, receivedPackets: links * 25, lostPackets: 0,
      jitterMs: 1, lossPercent: 0, localCandidateRttMs: null } : null,
    video: video ? { source: 'synthetic-canvas; not real OS screen',
      presentedFrames: 20, receivedVideoPackets: 40, presentedFps: 14 } : null,
  });
  return {
    samples: Array.from({ length: 5 }, raw),
    cpuPercent: metric(18.5), workingSetMB: metric(260),
    taskSeconds: metric(0.35), measuredMs: metric(1500), uiWorkMs: metric(chat ? 300 : 0),
  };
}
function specimen() {
  return {
    scope: 'synthetic Svelte/React desktop RTP; NOT a full feature-equivalent Bridge',
    mediaDefinition: 'local peer links, NOT a real multiuser SFU',
    videoDefinition: 'canvas, NOT physical camera/OS screen capture',
    cpuDefinition: 'interval CPU; NOT whole-app CPU',
    ramDefinition: 'renderer memory; NOT total application memory',
    latencyDefinition: 'loopback RTT; NOT acoustic end-to-end',
    platform: 'linux', electron: 'test', chromium: 'test', warmups: 1, iterations: 5,
    scenarios: Object.fromEntries(Object.keys(scenarioSpecs).map(mode =>
      [mode, { variants: { svelte: candidate(mode), react: candidate(mode) } }])),
  };
}
test('all eight real resource scenarios with paired samples pass validation', () => {
  assert.equal(verify(specimen()), true);
});
test('missing OS/media scenarios must not be reported as green', () => {
  const r = specimen(); delete r.scenarios.screen2;
  assert.throws(() => verify(r), /SCENARIOS_INCOMPLETE/);
  const a = specimen(); delete a.scenarios.voice10.variants.react;
  assert.throws(() => verify(a), /CANDIDATE_OR_SAMPLES_MISSING/);
});
test('a fake CPU percentage or missing renderer RAM is rejected', () => {
  const r = specimen(); r.scenarios.voice5.variants.svelte.samples[0].rendererCpuIntervalPercent = null;
  assert.throws(() => verify(r), /INVALID_MEASURED_INTERVAL/);
  const a = specimen(); a.scenarios.messages.variants.react.samples[0].rendererWorkingSetMB = 0;
  assert.throws(() => verify(a), /INVALID_MEASURED_INTERVAL/);
});
test('10-peer scenario cannot pass with no real RTP', () => {
  const r = specimen(); r.scenarios.voice10.variants.react.samples[3].audio.receivedPackets = 0;
  assert.throws(() => verify(r), /REAL_RTP_MISSING/);
});
test('video and synthetic screen must prove RTP AND genuinely presented frames', () => {
  const r = specimen(); r.scenarios.video2.variants.react.samples[1].video.presentedFrames = 0;
  assert.throws(() => verify(r), /REAL_VIDEO_FRAMES_MISSING/);
  const b = specimen(); b.scenarios.video2.variants.react.samples[1].video.receivedVideoPackets = 0;
  assert.throws(() => verify(b), /REAL_VIDEO_FRAMES_MISSING/);
  const a = specimen(); a.scenarios.screen2.variants.svelte.samples[0].video = null;
  assert.throws(() => verify(a), /REAL_VIDEO_FRAMES_MISSING/);
});
test('an invented p50 that does not match raw samples is refused', () => {
  const r = specimen(); r.scenarios.idle.variants.svelte.cpuPercent.p50 = 0;
  assert.throws(() => verify(r), /SUMMARY_NOT_BACKED_BY_SAMPLES/);
});
test('real-network or full-Bridge claims fail the evidence contract', () => {
  const r = specimen(); r.scope = 'React is faster at full Bridge media';
  assert.throws(() => verify(r), /SCOPE_CLAIM_INVALID/);
  const a = specimen(); a.videoDefinition = 'real OS screen capture verified';
  assert.throws(() => verify(a), /SCOPE_CLAIM_INVALID/);
});
