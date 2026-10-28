'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const variants = ['svelte', 'react'];
const metrics = [
  'uiWorkMs', 'idleDurationMs', 'stressDurationMs',
  'idleJitterMs', 'stressJitterMs',
  'idleLossPercent', 'stressLossPercent', 'rendererTaskSeconds',
];

function verify(report) {
  if (!report || !String(report.scope).includes('synthetic 10000-message') ||
      !String(report.scope).includes('NOT Bridge full voice parity') ||
      !String(report.transport).includes('real RTCPeerConnections') ||
      !String(report.limitation).includes('LOCAL LOOPBACK') ||
      !String(report.timingDefinition).includes('NOT OS CPU percent')) {
    throw new Error('AUDIO_SCOPE_MISREPRESENTED');
  }
  if (!report.platform || !report.electron || !report.chromium ||
      report.sampleSize !== 10_000 || report.updates !== 8 ||
      report.warmups !== 2 || report.iterations !== 8) {
    throw new Error('AUDIO_RUNTIME_OR_SCENARIO_MISSING');
  }
  for (const name of variants) {
    const candidate = report.variants?.[name];
    if (!candidate || !Array.isArray(candidate.samples) ||
        candidate.samples.length !== report.iterations) {
      throw new Error('AUDIO_FRAMEWORK_SAMPLES_MISSING_' + name);
    }
    if (!String(candidate.cpuDefinition).includes('instantaneous poll') ||
        !String(candidate.memoryDefinition).includes('NOT total app RAM')) {
      throw new Error('AUDIO_RESOURCE_SCOPE_INVALID_' + name);
    }
    for (const entry of candidate.samples) {
      for (const field of metrics) {
        if (!Number.isFinite(entry[field]) || entry[field] < 0) {
          throw new Error('AUDIO_BAD_RAW_METRIC_' + field);
        }
      }
      if (entry.uiWorkMs <= 0 || entry.idleDurationMs < 1000 ||
          entry.stressDurationMs < entry.uiWorkMs ||
          entry.idlePacketsReceived < 12 ||
          entry.stressPacketsReceived < 12 || entry.idlePacketsSent < 12 ||
          entry.stressPacketsSent < 12) {
        throw new Error('AUDIO_RTP_NOT_VERIFIED');
      }
      if (entry.idleLossPercent > 100 || entry.stressLossPercent > 100) {
        throw new Error('AUDIO_INVALID_LOSS');
      }
      if (entry.rendererWorkingSetMB !== null &&
          (!Number.isFinite(entry.rendererWorkingSetMB) || entry.rendererWorkingSetMB <= 0)) {
        throw new Error('AUDIO_INVALID_MEMORY_SNAPSHOT');
      }
      if (entry.cpuInstantPercent !== null &&
          (!Number.isFinite(entry.cpuInstantPercent) || entry.cpuInstantPercent < 0)) {
        throw new Error('AUDIO_INVALID_CPU_SNAPSHOT');
      }
    }
    for (const key of metrics) {
      const summary = candidate[key];
      if (!summary || summary.samples !== report.iterations ||
          !Number.isFinite(summary.p50) || !Number.isFinite(summary.p95) ||
          summary.p50 < 0 || summary.p95 < summary.p50 ||
          (key === 'uiWorkMs' && summary.p50 <= 0)) {
        throw new Error('AUDIO_BAD_SUMMARY_' + key);
      }
    }
  }
  return true;
}

module.exports = { verify };
if (require.main === module) {
  const report = JSON.parse(readFileSync(join(__dirname, 'generated', 'audio-report.json'), 'utf8'));
  verify(report);
  console.log('AUDIO_AB_REPORT_VALIDATED');
}

