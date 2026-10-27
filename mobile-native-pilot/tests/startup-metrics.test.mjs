import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStartupMetrics } from '../src/startup-metrics.mjs';

test('records bounded, ordered, first-occurrence-only JS milestones', () => {
  let now = 100;
  const tracker = createStartupMetrics(() => now);
  assert.equal(tracker.mark('js_entry'), true);
  now = 116.25;
  assert.equal(tracker.mark('first_layout'), true);
  now = 121;
  assert.equal(tracker.mark('first_layout'), false);
  assert.equal(tracker.mark('first_interaction'), true);
  assert.deepEqual(tracker.snapshot(), {
    js_entry: 0, first_layout: 16.3, first_interaction: 21,
  });
});

test('refuses arbitrary labels and backwards clocks; does not store sensitive values', () => {
  let now = 5;
  const tracker = createStartupMetrics(() => now);
  assert.throws(() => tracker.mark('token'), /unapproved/);
  assert.deepEqual(tracker.snapshot(), {});
  assert.equal(tracker.mark('js_entry'), true);
  now = 4;
  assert.throws(() => tracker.mark('first_layout'), /monotonic/);
  assert.deepEqual(tracker.snapshot(), { js_entry: 0 });
});
