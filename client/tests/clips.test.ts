// client/tests/clips.test.ts
// Sprint 82: Clips sistemi unit testleri

'use strict';

let _passed = 0;
let _failed = 0;
const _errors: string[] = [];

function test(name: string, fn: () => void): void {
  try { fn(); _passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    _failed++;
    const msg = err instanceof Error ? err.message : String(err);
    _errors.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

function expect(val: unknown) {
  return {
    toBe:             (e: unknown) => { if (val !== e)  throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
    toBeTruthy:       () => { if (!val) throw new Error(`Expected truthy`); },
    toBeFalsy:        () => { if (val)  throw new Error(`Expected falsy`); },
    toBeGreaterThan:  (n: number) => { if (typeof val !== 'number' || val <= n) throw new Error(`Expected ${val} > ${n}`); },
    toBeLessThanOrEqual: (n: number) => { if (typeof val !== 'number' || val > n) throw new Error(`Expected ${val} <= ${n}`); },
    toEqual:          (e: unknown) => { if (JSON.stringify(val) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const BUFFER_DURATION_MS = 30_000;
const CLIP_MIN_MS        = 5_000;
const CLIP_MAX_MS        = 60_000;
const CHUNK_INTERVAL_MS  = 500;

// ── Pure logic ────────────────────────────────────────────────────────────────

function clampClipDuration(durationMs: number): number {
  return Math.min(Math.max(durationMs, CLIP_MIN_MS), CLIP_MAX_MS);
}

interface BufferChunk { blob: { size: number }; timestamp: number }

function pruneBuffer(buffer: BufferChunk[], now = Date.now()): BufferChunk[] {
  const cutoff = now - BUFFER_DURATION_MS;
  return buffer.filter(c => c.timestamp >= cutoff);
}

function getBufferDurationMs(buffer: BufferChunk[]): number {
  if (buffer.length < 2) return 0;
  return buffer[buffer.length - 1]!.timestamp - buffer[0]!.timestamp;
}

function sliceBufferForClip(buffer: BufferChunk[], durationMs: number, now = Date.now()): BufferChunk[] {
  const cutoff = now - durationMs;
  return buffer.filter(c => c.timestamp >= cutoff);
}

function getBestMimeType(supported: string[]): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'audio/webm;codecs=opus',
    'audio/webm',
  ];
  return candidates.find(m => supported.includes(m)) ?? '';
}

function buildFilename(mimeType: string, timestamp: number): string {
  const ext = mimeType.startsWith('audio') ? 'weba' : 'webm';
  return `bridge-clip-${timestamp}.${ext}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Clips Unit Tests ===\n');

// 1. Constants
test('BUFFER_DURATION_MS is 30 seconds', () => {
  expect(BUFFER_DURATION_MS).toBe(30_000);
});

test('CLIP_MIN_MS is 5 seconds', () => {
  expect(CLIP_MIN_MS).toBe(5_000);
});

test('CLIP_MAX_MS is 60 seconds', () => {
  expect(CLIP_MAX_MS).toBe(60_000);
});

test('CHUNK_INTERVAL_MS is 500ms', () => {
  expect(CHUNK_INTERVAL_MS).toBe(500);
});

// 2. clampClipDuration
test('clampClipDuration clamps below minimum', () => {
  expect(clampClipDuration(1000)).toBe(CLIP_MIN_MS);
  expect(clampClipDuration(0)).toBe(CLIP_MIN_MS);
});

test('clampClipDuration clamps above maximum', () => {
  expect(clampClipDuration(120_000)).toBe(CLIP_MAX_MS);
  expect(clampClipDuration(999_999)).toBe(CLIP_MAX_MS);
});

test('clampClipDuration keeps valid duration unchanged', () => {
  expect(clampClipDuration(10_000)).toBe(10_000);
  expect(clampClipDuration(30_000)).toBe(30_000);
  expect(clampClipDuration(CLIP_MAX_MS)).toBe(CLIP_MAX_MS);
});

// 3. pruneBuffer
test('pruneBuffer removes old chunks', () => {
  const now  = Date.now();
  const old  = now - 40_000;
  const fresh= now - 5_000;
  const buf: BufferChunk[] = [
    { blob: { size: 100 }, timestamp: old   },
    { blob: { size: 200 }, timestamp: fresh },
  ];
  const pruned = pruneBuffer(buf, now);
  expect(pruned.length).toBe(1);
  expect(pruned[0]!.timestamp).toBe(fresh);
});

test('pruneBuffer keeps all chunks if all within window', () => {
  const now = Date.now();
  const buf: BufferChunk[] = [
    { blob: { size: 100 }, timestamp: now - 1000 },
    { blob: { size: 200 }, timestamp: now - 2000 },
    { blob: { size: 300 }, timestamp: now - 3000 },
  ];
  expect(pruneBuffer(buf, now).length).toBe(3);
});

test('pruneBuffer returns empty for fully expired buffer', () => {
  const now = Date.now();
  const buf: BufferChunk[] = [
    { blob: { size: 100 }, timestamp: now - 60_000 },
    { blob: { size: 200 }, timestamp: now - 50_000 },
  ];
  expect(pruneBuffer(buf, now).length).toBe(0);
});

// 4. getBufferDurationMs
test('getBufferDurationMs returns 0 for empty buffer', () => {
  expect(getBufferDurationMs([])).toBe(0);
});

test('getBufferDurationMs returns 0 for single chunk', () => {
  expect(getBufferDurationMs([{ blob: { size: 100 }, timestamp: 1000 }])).toBe(0);
});

test('getBufferDurationMs calculates span correctly', () => {
  const buf: BufferChunk[] = [
    { blob: { size: 100 }, timestamp: 1000 },
    { blob: { size: 200 }, timestamp: 5000 },
    { blob: { size: 300 }, timestamp: 10000 },
  ];
  expect(getBufferDurationMs(buf)).toBe(9000);
});

// 5. sliceBufferForClip
test('sliceBufferForClip returns only recent chunks', () => {
  const now  = Date.now();
  const buf: BufferChunk[] = [
    { blob: { size: 100 }, timestamp: now - 25_000 },
    { blob: { size: 200 }, timestamp: now - 15_000 },
    { blob: { size: 300 }, timestamp: now - 5_000  },
  ];
  const slice = sliceBufferForClip(buf, 20_000, now);
  expect(slice.length).toBe(2);
});

test('sliceBufferForClip returns all when duration covers all', () => {
  const now = Date.now();
  const buf: BufferChunk[] = [
    { blob: { size: 100 }, timestamp: now - 5_000 },
    { blob: { size: 200 }, timestamp: now - 3_000 },
  ];
  const slice = sliceBufferForClip(buf, 30_000, now);
  expect(slice.length).toBe(2);
});

// 6. getBestMimeType
test('getBestMimeType prefers vp9+opus', () => {
  const supported = ['video/webm;codecs=vp9,opus', 'video/webm', 'audio/webm'];
  expect(getBestMimeType(supported)).toBe('video/webm;codecs=vp9,opus');
});

test('getBestMimeType falls back to plain webm', () => {
  const supported = ['video/webm'];
  expect(getBestMimeType(supported)).toBe('video/webm');
});

test('getBestMimeType returns empty string if nothing supported', () => {
  expect(getBestMimeType([])).toBe('');
});

// 7. buildFilename
test('buildFilename uses webm extension for video', () => {
  const name = buildFilename('video/webm', 1234567890);
  if (!name.endsWith('.webm')) throw new Error(`Expected .webm, got ${name}`);
});

test('buildFilename uses weba extension for audio', () => {
  const name = buildFilename('audio/webm', 1234567890);
  if (!name.endsWith('.weba')) throw new Error(`Expected .weba, got ${name}`);
});

test('buildFilename includes timestamp', () => {
  const name = buildFilename('video/webm', 9876543210);
  if (!name.includes('9876543210')) throw new Error(`Expected timestamp in filename: ${name}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) {
  console.error('FAILED TESTS:\n' + _errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
