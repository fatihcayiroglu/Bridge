'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('./audio-quality-report.cjs');
const modes = { voice2: 1, voice10: 9, voice2_chat: 1 };
const constant = v => ({ samples: 5, p50: v, p95: v });
function specimen() {
  const scenarios = {};
  for (const [mode, links] of Object.entries(modes)) {
    const sample = () => ({
      mode, measuredMs: 2200, uiWorkMs: mode === 'voice2_chat' ? 250 : 0,
      sampleWindows: 20, dropoutPercent: 0, clippingPercent: 0,
      snrDb: 35, rms: 0.03, maxSampleGapMs: 108,
      rtp: { peerLinks: links, receivedPackets: 100 * links,
        lostPackets: 0, lossPercent: 0, maxJitterMs: 1 },
    });
    const candidate = () => ({
      samples: Array.from({ length: 5 }, sample),
      snrDb: constant(35), dropoutPercent: constant(0), clippingPercent: constant(0),
      maxSampleGapMs: constant(108), receivedPackets: constant(100 * links),
      maxJitterMs: constant(1),
    });
    scenarios[mode] = { variants: { svelte: candidate(), react: candidate() } };
  }
  return { scope: 'synthetic PCM over local WebRTC, NOT subjective speech quality, NOT actual Bridge media',
    platform: 'linux', electron: 'test', warmups: 1, iterations: 5, scenarios };
}
test('three quality workloads and both candidates require real PCM and RTP evidence', () => {
  assert.equal(verify(specimen()), true);
});
test('missing windows, RTP or a candidate cannot produce fake green', () => {
  const a = specimen(); a.scenarios.voice2_chat.variants.react.samples[0].sampleWindows = 0;
  assert.throws(() => verify(a), /REAL_PCM_OR_RTP_MISSING/);
  const b = specimen(); b.scenarios.voice10.variants.svelte.samples[2].rtp.receivedPackets = 0;
  assert.throws(() => verify(b), /REAL_PCM_OR_RTP_MISSING/);
  const c = specimen(); delete c.scenarios.voice2.variants.react;
  assert.throws(() => verify(c), /SAMPLES_MISSING/);
});
test('faked SNR and a false actual-device claim are refused', () => {
  const a = specimen(); a.scenarios.voice2.variants.svelte.snrDb.p50 = 96;
  assert.throws(() => verify(a), /UNBACKED_SUMMARY/);
  const b = specimen(); b.scope = 'perfect live human Bridge speech quality';
  assert.throws(() => verify(b), /SCOPE_OR_MATRIX_INVALID/);
});
test('silence, missing time and chat not executed fail closed', () => {
  const a = specimen(); a.scenarios.voice2.variants.react.samples[0].rms = 0;
  assert.throws(() => verify(a), /REAL_PCM_OR_RTP_MISSING/);
  const b = specimen(); b.scenarios.voice2.variants.react.samples[0].measuredMs = 100;
  assert.throws(() => verify(b), /REAL_PCM_OR_RTP_MISSING/);
  const c = specimen(); c.scenarios.voice2_chat.variants.react.samples[0].uiWorkMs = 0;
  assert.throws(() => verify(c), /REAL_PCM_OR_RTP_MISSING/);
});
