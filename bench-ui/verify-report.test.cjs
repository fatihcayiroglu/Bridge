'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('./verify-report.cjs');

const specimen = () => ({
  scope: 'synthetic message-list renderer benchmark; NOT full Bridge or WebRTC',
  timingDefinition: 'milliseconds until DOM mutation with expected count; excludes rAF',
  memoryDefinition: 'single renderer working-set snapshot; not total application RAM',
  platform: 'linux', electron: 'test', chromium: 'test',
  bundles: { svelte: { rawBytes: 100, gzipBytes: 80 }, react: { rawBytes: 200, gzipBytes: 120 } },
  scenarios: [1000, 10000].map((sampleSize, index) => ({
    sampleSize, iterations: index === 0 ? 30 : 12, warmups: index === 0 ? 5 : 3,
    variants: Object.fromEntries(['svelte', 'react'].map(name => [name, {
      rendererWorkingSetMB: 42,
      memoryStatus: 'renderer-working-set-1-snapshot',
      timings: Object.fromEntries(['reset', 'append', 'appendBatch100', 'filter', 'draftBurst8'].map(step => [step, {
        samples: index === 0 ? 30 : 12, p50Ms: 2, p95Ms: 4,
      }])),
    }])),
  })),
});

test('valid evidence report passes', () => assert.equal(verify(specimen()), true));
test('missing React result fails', () => {
  const result = specimen();
  delete result.scenarios[0].variants.react;
  assert.throws(() => verify(result), /Missing framework/);
});
test('incorrect sample count fails', () => {
  const result = specimen();
  result.scenarios[1].variants.react.timings.filter.samples = 0;
  assert.throws(() => verify(result), /Missing samples/);
});
test('fabricated nonpositive timings fail', () => {
  const result = specimen();
  result.scenarios[0].variants.svelte.timings.append.p50Ms = 0;
  assert.throws(() => verify(result), /Invalid p50/);
});
test('missing synthetic-scope warning fails', () => {
  const result = specimen();
  result.scope = 'Full Bridge is faster';
  assert.throws(() => verify(result), /synthetic/);
});
test('unlabelled timing definition fails', () => {
  const result = specimen();
  result.timingDefinition = 'two rAF';
  assert.throws(() => verify(result), /DOM commit/);
});
test('missing large-history scenario fails', () => {
  const result = specimen();
  result.scenarios.pop();
  assert.throws(() => verify(result), /Missing benchmark scenario/);
});
test('missing burst-append measurements fail', () => {
  const result = specimen();
  delete result.scenarios[1].variants.react.timings.appendBatch100;
  assert.throws(() => verify(result), /Missing samples/);
});
test('missing eight-update draft burst fails', () => {
  const result = specimen();
  delete result.scenarios[1].variants.svelte.timings.draftBurst8;
  assert.throws(() => verify(result), /Missing samples/);
});
test('clamped browser heap cannot be presented as physical RAM', () => {
  const result = specimen();
  result.scenarios[0].variants.react.heapMB = 9.54;
  assert.throws(() => verify(result), /clamped JS heap/);
});
test('unavailable renderer memory must be explicit', () => {
  const result = specimen();
  result.scenarios[0].variants.react.rendererWorkingSetMB = null;
  assert.throws(() => verify(result), /working-set evidence/);
  result.scenarios[0].variants.react.memoryStatus = 'not-measured';
  assert.equal(verify(result), true);
});
