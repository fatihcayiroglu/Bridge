'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measure } = require('./audio-quality-math.js');

const signal = (amplitude = 0.06, noise = 0) => Float32Array.from({ length: 2048 }, (_, i) =>
  amplitude * Math.sin(2 * Math.PI * 440 * i / 48000) +
  noise * Math.sin(2 * Math.PI * 3333 * i / 48000));

test('a clean reference has better SNR than a polluted reference', () => {
  const clean = measure(signal(), 48000);
  const dirty = measure(signal(0.06, 0.02), 48000);
  assert.ok(clean.snrDb > 65, String(clean.snrDb));
  assert.ok(dirty.snrDb < 15, String(dirty.snrDb));
  assert.ok(clean.snrDb - dirty.snrDb > 45);
  assert.equal(clean.dropout, false);
});
test('silence is a dropout and never passes a real media assertion', () => {
  const result = measure(new Float32Array(2048), 48000);
  assert.equal(result.dropout, true);
  assert.equal(result.snrDb, 0);
});
test('clipping and invalid/missing PCM are detected', () => {
  assert.ok(measure(signal(1.0), 48000).clippingPercent > 0);
  assert.throws(() => measure(new Float32Array(10), 48000), /AUDIO_PCM_SAMPLES_MISSING/);
  const missing = signal(); missing[0] = NaN;
  assert.throws(() => measure(missing, 48000), /AUDIO_PCM_INVALID/);
});
