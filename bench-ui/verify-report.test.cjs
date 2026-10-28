'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verify } = require('./verify-report.cjs');

const specimen = () => ({
  scope: 'synthetic message-list renderer benchmark; NOT full Bridge or WebRTC',
  platform: 'linux', electron: 'test', chromium: 'test',
  iterations: 30, warmups: 5, sampleSize: 1000,
  variants: Object.fromEntries(['svelte', 'react'].map(name => [name, {
    rawBytes: 100, gzipBytes: 80,
    timings: Object.fromEntries(['reset', 'append', 'filter'].map(step => [step, {
      samples: 30, p50Ms: 2, p95Ms: 4,
    }])),
  }])),
});

test('valid evidence report passes', () => assert.equal(verify(specimen()), true));
test('missing React result fails', () => {
  const result = specimen();
  delete result.variants.react;
  assert.throws(() => verify(result), /Missing framework/);
});
test('incorrect sample count fails', () => {
  const result = specimen();
  result.variants.react.timings.filter.samples = 0;
  assert.throws(() => verify(result), /Missing samples/);
});
test('fabricated nonpositive timings fail', () => {
  const result = specimen();
  result.variants.svelte.timings.append.p50Ms = 0;
  assert.throws(() => verify(result), /Invalid p50/);
});
test('missing synthetic-scope warning fails', () => {
  const result = specimen();
  result.scope = 'Full Bridge is faster';
  assert.throws(() => verify(result), /synthetic/);
});
