'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const workflow = readFileSync(join(root, '.github/workflows/desktop-product-baseline.yml'), 'utf8');
const responsive = readFileSync(join(root, 'e2e/tests/desktop-responsive-viewport.spec.ts'), 'utf8');
const runtime = readFileSync(join(root, 'e2e/tests/desktop-cdp-runtime.spec.ts'), 'utf8');
const soak = readFileSync(join(root, 'e2e/tests/desktop-bounded-soak.spec.ts'), 'utf8');

test('every real product axis runs on an isolated PostgreSQL backend and cannot be fake green', () => {
  for (const name of ['startup-interactions', 'responsive-a11y', 'authenticated-upload', 'real-webrtc', 'bounded-soak']) {
    assert.match(workflow, new RegExp(name));
  }
  assert.match(workflow, /postgres:18-alpine/);
  assert.match(workflow, /redis:7-alpine/);
  assert.match(workflow, /fail-fast: false/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  assert.doesNotMatch(workflow, /\b--retries=[1-9]/);
  assert.equal((workflow.match(/--retries=0/g) || []).length, 7);
});

test('performance, upload, actual WebRTC and a11y suites must remain named explicitly', () => {
  for (const file of ['perf-benchmark.spec.ts', 'upload.spec.ts', 'voice-media.spec.ts',
    'media-automation.spec.ts', 'desktop-responsive-viewport.spec.ts', 'desktop-cdp-runtime.spec.ts',
    'desktop-bounded-soak.spec.ts', 'a11y.smoke.spec.ts']) {
    assert.ok(workflow.includes(file), `required suite missing: ${file}`);
  }
  assert.match(workflow, /--project=voice-media/);
  assert.match(workflow, /--project=a11y-mobile/);
  assert.match(workflow, /--project=perf/);
});

test('resource diagnostic reads actual CDP data and cannot claim total application RAM', () => {
  assert.match(runtime, /Performance\.getMetrics/);
  assert.match(runtime, /JSHeapUsedSize/);
  assert.match(runtime, /TaskDuration/);
  assert.match(runtime, /not total app RAM/);
  assert.doesNotMatch(runtime, /performance\.memory/);
  assert.doesNotMatch(runtime, /test\.(skip|fixme)\(/);
});

test('bounded soak verifies real keyboard interactions without a time-skipping mock', () => {
  assert.match(soak, /DURATION_MS = 120_000/);
  assert.match(soak, /page\.keyboard\.press\('Control\+k'\)/);
  assert.match(soak, /page\.keyboard\.press\('Escape'\)/);
  assert.match(soak, /toBeGreaterThanOrEqual\(DURATION_MS\)/);
  assert.match(soak, /HeapProfiler\.collectGarbage/);
  assert.doesNotMatch(soak, /test\.(skip|fixme)\(/);
});

test('responsive check asserts the real app at the native desktop minimum through QHD', () => {
  for (const width of [900, 1024, 1280, 1440, 1920, 2560]) {
    assert.match(responsive, new RegExp(`width: ${width},`));
  }
  assert.match(responsive, /documentElement\.scrollWidth/);
  assert.match(responsive, /expect\.poll\(/);
  assert.match(responsive, /Math\.abs\(dimensions\.appHeight - size\.height\)/);
  assert.match(responsive, /toBeLessThanOrEqual\(size\.width \+ 1\)/);
  assert.doesNotMatch(responsive, /test\.(skip|fixme)\(/);
});
