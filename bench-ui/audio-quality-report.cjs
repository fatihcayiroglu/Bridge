'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const modes = { voice2: 1, voice10: 9, voice2_chat: 1 };
const summaries = ['snrDb', 'dropoutPercent', 'clippingPercent', 'maxSampleGapMs',
  'receivedPackets', 'maxJitterMs'];
function finite(n, nonnegative = false) {
  return Number.isFinite(n) && (!nonnegative || n >= 0);
}
function percentile(values, ratio) {
  const v = [...values].sort((a, b) => a - b);
  return Number(v[Math.ceil(v.length * ratio) - 1].toFixed(3));
}
function metric(sample, field) {
  return ['receivedPackets', 'maxJitterMs'].includes(field) ? sample.rtp?.[field] : sample[field];
}
function verify(report) {
  if (!report || !String(report.scope).includes('synthetic PCM') ||
      !String(report.scope).includes('NOT subjective speech quality') ||
      !String(report.scope).includes('NOT actual Bridge media') ||
      report.warmups !== 1 || report.iterations !== 5 ||
      !report.platform || !report.electron || !report.scenarios ||
      Object.keys(report.scenarios).length !== Object.keys(modes).length) {
    throw new Error('AUDIO_QUALITY_SCOPE_OR_MATRIX_INVALID');
  }
  for (const [mode, links] of Object.entries(modes)) {
    for (const name of ['svelte', 'react']) {
      const item = report.scenarios[mode]?.variants?.[name];
      if (item?.samples?.length !== 5) throw new Error('AUDIO_QUALITY_SAMPLES_MISSING');
      for (const s of item.samples) {
        if (s.mode !== mode || s.sampleWindows !== 20 || s.measuredMs < 2000 ||
            !finite(s.measuredMs) || !finite(s.snrDb) ||
            !finite(s.rms) || s.rms <= 0.003 || s.rms > 1 ||
            !finite(s.dropoutPercent, true) || s.dropoutPercent > 40 ||
            !finite(s.clippingPercent, true) || s.clippingPercent > 100 ||
            !finite(s.maxSampleGapMs, true) || !finite(s.uiWorkMs, true) ||
            (mode === 'voice2_chat' ? s.uiWorkMs <= 0 : s.uiWorkMs !== 0) ||
            s.rtp?.peerLinks !== links ||
            !finite(s.rtp.receivedPackets) || s.rtp.receivedPackets < links * 35 ||
            !finite(s.rtp.lostPackets, true) || !finite(s.rtp.lossPercent, true) ||
            s.rtp.lossPercent > 100 || !finite(s.rtp.maxJitterMs, true)) {
          throw new Error('AUDIO_QUALITY_REAL_PCM_OR_RTP_MISSING_' + mode);
        }
      }
      for (const field of summaries) {
        const raw = item.samples.map(s => metric(s, field));
        const summary = item[field];
        if (!summary || summary.samples !== 5 ||
            !finite(summary.p50) || !finite(summary.p95) ||
            Math.abs(summary.p50 - percentile(raw, 0.5)) > 0.001 ||
            Math.abs(summary.p95 - percentile(raw, 0.95)) > 0.001) {
          throw new Error('AUDIO_QUALITY_UNBACKED_SUMMARY_' + field);
        }
      }
    }
  }
  return true;
}
module.exports = { verify };
if (require.main === module) {
  const report = JSON.parse(readFileSync(join(__dirname, 'generated/audio-quality-report.json'), 'utf8'));
  verify(report);
  console.log('AUDIO_QUALITY_AB_REPORT_VALIDATED');
}
