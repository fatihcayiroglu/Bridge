'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('./audio-report.cjs');

const raw = () => ({
  round: 2, uiWorkMs: 300, idleDurationMs: 1200, stressDurationMs: 310,
  idleJitterMs: 0, stressJitterMs: 1.5,
  idleLossPercent: 0, stressLossPercent: 0,
  idlePacketsReceived: 40, stressPacketsReceived: 45,
  idlePacketsSent: 40, stressPacketsSent: 45, rendererTaskSeconds: 0.15,
  rendererWorkingSetMB: null, cpuIntervalPercent: 18.5, cpuIntervalSeconds: null,
});
const metric = () => ({ samples: 8, p50: 1, p95: 2 });
const candidate = () => ({
  samples: Array.from({ length: 8 }, raw),
  uiWorkMs: metric(), idleDurationMs: metric(), stressDurationMs: metric(),
  idleJitterMs: metric(), stressJitterMs: metric(),
  idleLossPercent: metric(), stressLossPercent: metric(), rendererTaskSeconds: metric(),
  cpuIntervalPercent: metric(),
  cpuDefinition: 'average over bounded sample interval; NOT whole desktop CPU',
  memoryDefinition: 'single renderer snapshot; NOT total app RAM',
});
const specimen = () => ({
  scope: 'synthetic 10000-message; NOT Bridge full voice parity',
  transport: 'two real RTCPeerConnections with generated audio',
  limitation: 'LOCAL LOOPBACK not internet or microphone',
  timingDefinition: 'renderer task time NOT OS CPU percent',
  platform: 'linux', electron: 'test', chromium: 'test', sampleSize: 10000,
  updates: 8, warmups: 2, iterations: 8,
  variants: { svelte: candidate(), react: candidate() },
});

test('real paired audio evidence passes with both frameworks and full samples', () => {
  assert.equal(verify(specimen()), true);
});
test('a missing React comparator cannot be green', () => {
  const r = specimen(); delete r.variants.react;
  assert.throws(() => verify(r), /FRAMEWORK_SAMPLES_MISSING/);
});
test('no received RTP packets must fail regardless of visible UI', () => {
  const r = specimen(); r.variants.svelte.samples[3].stressPacketsReceived = 0;
  assert.throws(() => verify(r), /RTP_NOT_VERIFIED/);
});
test('invalid jitter and packet loss cannot be reported as valid', () => {
  const r = specimen(); r.variants.react.samples[0].stressJitterMs = NaN;
  assert.throws(() => verify(r), /BAD_RAW_METRIC/);
  const a = specimen(); a.variants.react.samples[1].idleLossPercent = 200;
  assert.throws(() => verify(a), /INVALID_LOSS/);
});
test('missing scenario or missing summary fails', () => {
  const r = specimen(); r.iterations = 0;
  assert.throws(() => verify(r), /RUNTIME_OR_SCENARIO_MISSING/);
  const a = specimen(); delete a.variants.svelte.stressJitterMs;
  assert.throws(() => verify(a), /BAD_SUMMARY/);
});
test('local loopback must not be passed off as full Bridge or real network quality', () => {
  const r = specimen(); r.scope = 'React voice is better than Bridge';
  assert.throws(() => verify(r), /SCOPE_MISREPRESENTED/);
  const a = specimen(); a.limitation = 'real-world network quality verified';
  assert.throws(() => verify(a), /SCOPE_MISREPRESENTED/);
});
test('missing OS CPU evidence cannot silently count as a measured CPU comparison', () => {
  const r = specimen(); r.variants.react.samples[2].cpuIntervalPercent = null;
  assert.throws(() => verify(r), /BAD_RAW_METRIC/);
  const a = specimen(); delete a.variants.svelte.cpuIntervalPercent;
  assert.throws(() => verify(a), /BAD_SUMMARY/);
});
