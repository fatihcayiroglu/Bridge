'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const workflow = readFileSync(join(root, '.github/workflows/desktop-resource-media-ab.yml'), 'utf8');
const runner = readFileSync(join(__dirname, 'resource-electron-benchmark.cjs'), 'utf8');
const media = readFileSync(join(__dirname, 'resource-media-runtime.js'), 'utf8');

test('matrix runs all 8 named workload classes on real Electron in three OSes', () => {
  for (const os of ['ubuntu-24.04', 'windows-2025', 'macos-15']) assert.ok(workflow.includes(os));
  for (const task of ['idle', 'messages', 'voice2', 'voice5', 'voice10',
    'video2', 'screen2', 'voice2_chat']) assert.ok(runner.includes("'" + task + "'"));
  assert.match(runner, /const variants = \['svelte', 'react'\]/);
  assert.match(workflow, /resource-electron-benchmark\.cjs/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
test('CPU and RAM come from measured Electron renderer process IDs, not hardcoded values', () => {
  assert.match(runner, /webContents\.getOSProcessId\(\)/);
  assert.match(runner, /const cpuPercent = after\?\.cpu\?\.percentCPUUsage/);
  assert.match(runner, /const metricsBefore = app\.getAppMetrics\(\)/);
  assert.match(runner, /const metricsAfter = app\.getAppMetrics\(\)/);
  assert.match(runner, /workingSetSize/);
  assert.match(runner, /RESOURCE_OS_CPU_OR_RAM_NOT_MEASURED/);
  assert.match(runner, /round === 0 \? \{\} : cpuAndMemory/);
  assert.match(runner, /if \(round >= WARMUPS\) samples\[name\]\.push\(sample\)/);
  assert.doesNotMatch(runner, /cpu\.percentCPU\b/);
});
test('media uses actual RTP and presented HTML video frames with no fake metrics', () => {
  assert.match(media, /RTCPeerConnection/);
  assert.match(media, /getStats\(\)/);
  assert.match(media, /getVideoPlaybackQuality/);
  assert.match(media, /totalVideoFrames - quality\.droppedVideoFrames/);
  assert.match(media, /canvas\.captureStream\(15\)/);
  assert.match(media, /RESOURCE_AUDIO_RTP_NOT_MEASURED/);
  assert.match(media, /RESOURCE_VIDEO_RTP_OR_PRESENTED_FRAMES_MISSING/);
  assert.match(media, /receivedVideoPackets < 10/);
  assert.doesNotMatch(media, /Math\.random\(\)/);
  assert.doesNotMatch(media, /test\.(skip|fixme)\(/);
});
test('media setup lies outside the bounded CPU interval and cannot hide a failed journey', () => {
  assert.match(runner, /__resourceBench\.prepare/);
  assert.match(runner, /const metricsBefore = app\.getAppMetrics/);
  assert.match(runner, /__resourceBench\.execute/);
  assert.match(runner, /const metricsAfter = app\.getAppMetrics/);
  assert.match(runner, /__resourceBench\.teardown/);
  assert.match(workflow, /set -euo pipefail/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(media, /while \(performance\.now\(\) - started < DURATION_MS\)/);
  assert.match(runner, /result\.measuredMs < 1200/);
  assert.match(runner, /RESOURCE_SCENARIO_START/);
});
