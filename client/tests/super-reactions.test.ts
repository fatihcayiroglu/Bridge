// client/tests/super-reactions.test.ts
// Sprint 82: Super Reactions unit testleri

'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    toBe:          (e: unknown) => { if (val !== e)  throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
    toBeTruthy:    () => { if (!val) throw new Error(`Expected truthy`); },
    toBeFalsy:     () => { if (val)  throw new Error(`Expected falsy`); },
    toBeGreaterThan: (n: number) => { if (typeof val !== 'number' || val <= n) throw new Error(`Expected ${val} > ${n}`); },
    toBeLessThanOrEqual: (n: number) => { if (typeof val !== 'number' || val > n) throw new Error(`Expected ${val} <= ${n}`); },
    toMatch:       (re: RegExp) => { if (typeof val !== 'string' || !re.test(val)) throw new Error(`Expected ${val} to match ${re}`); },
  };
}

// ── Pure logic re-implementations ────────────────────────────────────────────

const BURST_COLORS: Record<string, string[]> = {
  '❤️':  ['#FF0000', '#FF6B6B', '#FF1493'],
  '🔥':  ['#FF4500', '#FF8C00', '#FFD700'],
  '⭐':  ['#FFD700', '#FFA500', '#FFEC8B'],
  '💯':  ['#00C851', '#00FF7F', '#ADFF2F'],
  '🎉':  ['#9B59B6', '#3498DB', '#E74C3C'],
  '👍':  ['#3498DB', '#1ABC9C', '#2ECC71'],
};

const DEFAULT_BURST_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];

function getBurstColors(emoji: string): string[] {
  return BURST_COLORS[emoji] ?? DEFAULT_BURST_COLORS;
}

function isValidEmoji(emoji: unknown): boolean {
  return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 8;
}

// Cooldown logic
const COOLDOWN_MS = 5_000;
const _cooldowns = new Map<string, number>();

function checkCooldown(userId: string, messageId: string): boolean {
  const key     = `${userId}:${messageId}`;
  const lastUse = _cooldowns.get(key) ?? 0;
  return Date.now() - lastUse >= COOLDOWN_MS;
}

function setCooldown(userId: string, messageId: string, timestamp = Date.now()): void {
  _cooldowns.set(`${userId}:${messageId}`, timestamp);
}

// Long press detection
const LONG_PRESS_MS = 600;

function isLongPress(downTime: number, upTime: number): boolean {
  return upTime - downTime >= LONG_PRESS_MS;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Super Reactions Unit Tests ===\n');

// 1. Burst Colors
test('getBurstColors returns known colors for ❤️', () => {
  const colors = getBurstColors('❤️');
  expect(colors.length).toBeGreaterThan(0);
  expect(colors[0]).toBe('#FF0000');
});

test('getBurstColors returns defaults for unknown emoji', () => {
  const colors = getBurstColors('🦄');
  expect(colors).toBe(DEFAULT_BURST_COLORS);
});

test('getBurstColors returns defaults for empty string', () => {
  const colors = getBurstColors('');
  expect(colors).toBe(DEFAULT_BURST_COLORS);
});

test('all burst colors are valid hex codes', () => {
  const hexRegex = /^#[0-9A-F]{6}$/i;
  for (const [emoji, colors] of Object.entries(BURST_COLORS)) {
    for (const c of colors) {
      if (!hexRegex.test(c)) throw new Error(`Invalid hex ${c} for emoji ${emoji}`);
    }
  }
});

// 2. Emoji validation
test('isValidEmoji true for normal emoji', () => {
  expect(isValidEmoji('❤️')).toBeTruthy();
  expect(isValidEmoji('🔥')).toBeTruthy();
  expect(isValidEmoji('👍')).toBeTruthy();
});

test('isValidEmoji false for empty string', () => {
  expect(isValidEmoji('')).toBeFalsy();
});

test('isValidEmoji false for too-long string', () => {
  expect(isValidEmoji('a'.repeat(9))).toBeFalsy();
});

test('isValidEmoji false for non-string', () => {
  expect(isValidEmoji(null)).toBeFalsy();
  expect(isValidEmoji(123)).toBeFalsy();
  expect(isValidEmoji(undefined)).toBeFalsy();
});

// 3. Cooldown logic
test('checkCooldown returns true when no previous use', () => {
  expect(checkCooldown('user-new-1', 'msg-new-1')).toBeTruthy();
});

test('checkCooldown returns false immediately after use', () => {
  setCooldown('user-1', 'msg-1', Date.now());
  expect(checkCooldown('user-1', 'msg-1')).toBeFalsy();
});

test('checkCooldown returns true after cooldown expires', () => {
  const past = Date.now() - (COOLDOWN_MS + 100);
  setCooldown('user-2', 'msg-2', past);
  expect(checkCooldown('user-2', 'msg-2')).toBeTruthy();
});

test('cooldown is per user+message combo', () => {
  setCooldown('user-3', 'msg-3', Date.now());
  // Farklı mesaj → cooldown etkilememeli
  expect(checkCooldown('user-3', 'msg-3-other')).toBeTruthy();
  // Farklı kullanıcı → cooldown etkilememeli
  expect(checkCooldown('user-3-other', 'msg-3')).toBeTruthy();
  // Aynı combo → etkilenmeli
  expect(checkCooldown('user-3', 'msg-3')).toBeFalsy();
});

// 4. Long press detection
test('isLongPress true when held >= 600ms', () => {
  expect(isLongPress(0, 600)).toBeTruthy();
  expect(isLongPress(0, 700)).toBeTruthy();
  expect(isLongPress(1000, 1700)).toBeTruthy();
});

test('isLongPress false when held < 600ms', () => {
  expect(isLongPress(0, 599)).toBeFalsy();
  expect(isLongPress(0, 0)).toBeFalsy();
  expect(isLongPress(0, 300)).toBeFalsy();
});

test('LONG_PRESS_MS constant is 600', () => {
  expect(LONG_PRESS_MS).toBe(600);
});

// 5. COOLDOWN_MS
test('COOLDOWN_MS is 5 seconds', () => {
  expect(COOLDOWN_MS).toBe(5000);
});

// 6. Particle count validation
test('particle count is reasonable', () => {
  const PARTICLE_COUNT = 24;
  expect(PARTICLE_COUNT).toBeGreaterThan(0);
  expect(PARTICLE_COUNT).toBeLessThanOrEqual(50);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) {
  console.error('FAILED TESTS:\n' + _errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
