'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const workflow = readFileSync(join(root, '.github/workflows/desktop-audio-quality-ab.yml'), 'utf8');
const runner = readFileSync(join(__dirname, 'audio-quality-electron.cjs'), 'utf8');
const runtime = readFileSync(join(__dirname, 'audio-quality-runtime.js'), 'utf8');

test('three platforms execute same Svelte/React Electron PCM contract without retries/skips', () => {
  for (const os of ['ubuntu-24.04', 'windows-2025', 'macos-15']) {
    assert.ok(workflow.includes(os));
  }
  assert.match(runner, /const variants = \['svelte', 'react'\]/);
  for (const mode of ['voice2', 'voice10', 'voice2_chat']) assert.ok(runner.includes("'" + mode + "'"));
  assert.match(workflow, /audio-quality-report\.cjs/);
  assert.match(workflow, /set -euo pipefail/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true|--retries=[1-9]/);
});
test('actual received PCM is analyzed, not inferred solely from RTP packet counters', () => {
  assert.match(runtime, /createMediaStreamSource/);
  assert.match(runtime, /getFloatTimeDomainData/);
  assert.match(runtime, /sourceRms: Number\(sourceRms\.toFixed\(5\)\)/);
  assert.match(runtime, /receivedRms: Number\(receivedRms\.toFixed\(5\)\)/);
  assert.match(runtime, /silentOutput\.gain\.value = 0\.001/);
  assert.match(runtime, /const receiveContext = new AudioContext/);
  assert.match(runtime, /receiveContext\.createMediaStreamSource/);
  assert.match(runtime, /audioElement\.play\(\)/);
  assert.match(runtime, /__audioQualityMath\.measure/);
  assert.match(runtime, /RTCPeerConnection/);
  assert.match(runtime, /getStats\(\)/);
  assert.match(runtime, /valid\.length < 12/);
  assert.match(runtime, /packets < group\.count \* 35/);
  assert.match(runtime, /measuredMs < MEASURE_MS/);
  assert.match(runtime, /setDraft\(draft\(i\)\)/);
  assert.match(runtime, /textContent !== draft\(7\)/);
  assert.doesNotMatch(runtime, /Math\.random/);
});
test('one warmup + five paired recorded samples with fresh renderer per workload', () => {
  assert.match(runner, /const WARMUPS = 1/);
  assert.match(runner, /const ITERATIONS = 5/);
  assert.match(runner, /for \(const mode of scenarios\) \{[\s\S]*for \(const name of variants\) windows\[name\] = await start\(name\)/);
  assert.match(runner, /if \(round >= WARMUPS\) samples\[name\]\.push\(sample\)/);
  assert.match(runner, /win\.destroy\(\)/);
});
