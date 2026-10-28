'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const scenarios = {
  idle: { links: 0, video: false, chat: false },
  messages: { links: 0, video: false, chat: true },
  voice2: { links: 1, video: false, chat: false },
  voice5: { links: 4, video: false, chat: false },
  voice10: { links: 9, video: false, chat: false },
  video2: { links: 1, video: true, chat: false },
  screen2: { links: 1, video: true, chat: false },
  voice2_chat: { links: 1, video: false, chat: true },
};
const fields = {
  cpuPercent: 'rendererCpuIntervalPercent',
  workingSetMB: 'rendererWorkingSetMB',
  taskSeconds: 'rendererTaskSeconds',
  measuredMs: 'measuredMs',
  uiWorkMs: 'uiWorkMs',
};

function validMetric(value, allowZero = true) {
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}
function percentile(samples, ratio) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(ratio * sorted.length) - 1].toFixed(3));
}
function verify(report) {
  if (!report || !String(report.scope).includes('synthetic Svelte/React') ||
      !String(report.scope).includes('NOT a full feature-equivalent Bridge') ||
      !String(report.mediaDefinition).includes('NOT a real multiuser SFU') ||
      !String(report.videoDefinition).includes('NOT physical camera') ||
      !String(report.cpuDefinition).includes('NOT whole-app CPU') ||
      !String(report.ramDefinition).includes('NOT total application memory') ||
      !String(report.latencyDefinition).includes('NOT acoustic end-to-end')) {
    throw new Error('RESOURCE_SCOPE_CLAIM_INVALID');
  }
  if (!report.platform || !report.electron || !report.chromium ||
      report.warmups !== 1 || report.iterations !== 5 ||
      !report.scenarios || Object.keys(report.scenarios).length !== Object.keys(scenarios).length) {
    throw new Error('RESOURCE_SCENARIOS_INCOMPLETE');
  }
  for (const [name, expected] of Object.entries(scenarios)) {
    const scenario = report.scenarios[name];
    for (const framework of ['svelte', 'react']) {
      const variant = scenario?.variants?.[framework];
      if (!variant || !Array.isArray(variant.samples) ||
          variant.samples.length !== report.iterations) {
        throw new Error('RESOURCE_CANDIDATE_OR_SAMPLES_MISSING_' + name + '_' + framework);
      }
      for (const s of variant.samples) {
        if (s.mode !== name || !validMetric(s.rendererCpuIntervalPercent) ||
            !validMetric(s.rendererWorkingSetMB, false) || !validMetric(s.rendererTaskSeconds) ||
            !validMetric(s.measuredMs, false) || s.measuredMs < 1200 ||
            !validMetric(s.uiWorkMs) ||
            (expected.chat ? s.uiWorkMs <= 0 : s.uiWorkMs !== 0)) {
          throw new Error('RESOURCE_INVALID_MEASURED_INTERVAL_' + name);
        }
        if (expected.links) {
          if (!s.audio || s.audio.peerLinks !== expected.links ||
              !Number.isFinite(s.audio.receivedPackets) ||
              s.audio.receivedPackets < expected.links * 12 ||
              !validMetric(s.audio.lostPackets) ||
              !validMetric(s.audio.jitterMs) ||
              !validMetric(s.audio.lossPercent) || s.audio.lossPercent > 100) {
            throw new Error('RESOURCE_REAL_RTP_MISSING_' + name);
          }
        } else if (s.audio !== null) {
          throw new Error('RESOURCE_UNEXPECTED_RTP_' + name);
        }
        if (expected.video) {
          if (!s.video || !String(s.video.source).includes('synthetic-canvas') ||
              !validMetric(s.video.framesDecoded, false) || s.video.framesDecoded < 5 ||
              !validMetric(s.video.decodedFps, false)) {
            throw new Error('RESOURCE_REAL_VIDEO_FRAMES_MISSING_' + name);
          }
        } else if (s.video !== null) {
          throw new Error('RESOURCE_UNEXPECTED_VIDEO_' + name);
        }
      }
      for (const [key, field] of Object.entries(fields)) {
        const m = variant[key];
        const raw = variant.samples.map(s => s[field]);
        if (!m || m.samples !== report.iterations ||
            !validMetric(m.p50) || !validMetric(m.p95) || m.p95 < m.p50 ||
            Math.abs(m.p50 - percentile(raw, 0.5)) > 0.001 ||
            Math.abs(m.p95 - percentile(raw, 0.95)) > 0.001) {
          throw new Error('RESOURCE_SUMMARY_NOT_BACKED_BY_SAMPLES_' + key);
        }
      }
    }
  }
  return true;
}

module.exports = { verify };
if (require.main === module) {
  const data = JSON.parse(readFileSync(join(__dirname, 'generated', 'resource-report.json'), 'utf8'));
  verify(data);
  console.log('RESOURCE_AB_REPORT_VALIDATED');
}
