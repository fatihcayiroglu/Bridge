'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const workflow = readFileSync(join(root, '.github/workflows/desktop-audio-ab-benchmark.yml'), 'utf8');
const runtime = readFileSync(join(__dirname, 'audio-runtime.js'), 'utf8');
const bench = readFileSync(join(__dirname, 'audio-electron-benchmark.cjs'), 'utf8');

test('audio A/B measures both variants in real Electron on three desktop OSes', () => {
  for (const os of ['ubuntu-24.04', 'windows-2025', 'macos-15']) assert.ok(workflow.includes(os));
  assert.match(bench, /const names = \['svelte', 'react'\]/);
  assert.match(workflow, /audio-electron-benchmark\.cjs/);
  assert.match(workflow, /--no-sandbox/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  assert.doesNotMatch(workflow, /--retries=[1-9]|\btest\.skip\b|\btest\.fixme\b/);
});

test('audio is real peer-to-peer RTP, not invented packet or jitter numbers', () => {
  assert.match(runtime, /new RTCPeerConnection\(\{ iceServers: \[\] \}\)/);
  assert.match(runtime, /createMediaStreamDestination\(\)/);
  assert.match(runtime, /createOscillator\(\)/);
  assert.match(runtime, /getStats\(\)/);
  assert.match(runtime, /packetsReceived/);
  assert.match(runtime, /AUDIO_RTP_NOT_DELIVERED/);
  assert.doesNotMatch(runtime, /Math\.random\(\)/);
});

test('test includes an idle audio control and heavy 10k UI load with true DOM assertions', () => {
  assert.match(runtime, /const IDLE_MS = 1_200/);
  assert.match(runtime, /window\.__bench\.reset\(size\)/);
  assert.match(runtime, /window\.__bench\.appendBatch\(100\)/);
  assert.match(runtime, /window\.__bench\.setDraft\(/);
  assert.match(runtime, /AUDIO_UI_RENDER_MISMATCH/);
  assert.match(bench, /WARMUPS = 2/);
  assert.match(bench, /ITERATIONS = 8/);
  assert.match(bench, /Performance\.getMetrics/);
});
test('CPU numbers come from real Electron process-interval measurements', () => {
  assert.match(bench, /process\?\.cpu\?\.percentCPUUsage/);
  assert.match(bench, /const metricsBefore = app\.getAppMetrics\(\)/);
  assert.match(bench, /const metricsAfter = app\.getAppMetrics\(\)/);
  assert.doesNotMatch(bench, /const cpu = process\?\.cpu\?\.percentCPU;/);
  assert.match(bench, /cpuIntervalPercent: summary/);
});
