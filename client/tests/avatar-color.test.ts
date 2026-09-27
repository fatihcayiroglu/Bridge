// client/tests/avatar-color.test.ts — Final21 Phase 16: one owner for hex-color sanitising.
//
// Five components carried their own `safeColor`. Three were dead code; the two live ones
// (MembersTab, RolesTab) used `/^#[0-9a-fA-F]{3,8}$/`, which also accepts 5- and 7-digit
// values. Those are NOT valid CSS colors: the browser drops the whole declaration, so a role
// whose color was stored as `#12345` lost its swatch silently instead of falling back to the
// muted token. The shared helper applies the correct 3/4/6/8 rule.

import { describe, expect, it } from 'vitest';
import { avatarStyle, readableTextOn, safeAvatarColor, safeHexColor } from '../js/core/avatar-color.ts';

describe('safeHexColor — only valid CSS hex passes', () => {
  it.each([
    ['#fff', 3],
    ['#FFFF', 4],
    ['#0a1b2c', 6],
    ['#0A1B2C80', 8],
  ])('keeps %s (%i digits)', (value) => {
    expect(safeHexColor(value, 'var(--text-muted)')).toBe(value);
  });

  it.each([
    ['#12345', 'five digits are invalid CSS'],
    ['#1234567', 'seven digits are invalid CSS'],
    ['#12', 'too short'],
    ['#123456789', 'too long'],
    ['#ggg', 'not hexadecimal'],
    ['red', 'named colors are not accepted here'],
    ['var(--brand)', 'a token is not a hex value'],
    ['#fff;background:url(x)', 'no declaration smuggling'],
    ['', 'empty'],
  ])('falls back for %s (%s)', (value) => {
    expect(safeHexColor(value, 'var(--text-muted)')).toBe('var(--text-muted)');
  });

  it.each([null, undefined, 42, {}, [], true])('falls back for non-strings: %s', (value) => {
    expect(safeHexColor(value, 'var(--text-muted)')).toBe('var(--text-muted)');
  });

  it('uses the caller\'s fallback, not a fixed one', () => {
    expect(safeHexColor('nope', 'var(--brand)')).toBe('var(--brand)');
    expect(safeHexColor('nope', 'var(--text-muted)')).toBe('var(--text-muted)');
  });
});

describe('safeAvatarColor keeps its brand fallback after delegating', () => {
  it('passes a valid hex through', () => {
    expect(safeAvatarColor('#00aff4')).toBe('#00aff4');
  });

  it('falls back to the brand token', () => {
    expect(safeAvatarColor('javascript:alert(1)')).toBe('var(--brand)');
    expect(safeAvatarColor(undefined)).toBe('var(--brand)');
  });

  it('rejects the invalid lengths the old per-component regex allowed', () => {
    expect(safeAvatarColor('#12345')).toBe('var(--brand)');
    expect(safeAvatarColor('#1234567')).toBe('var(--brand)');
  });
});

describe('avatarStyle still pairs a background with readable ink', () => {
  it('writes ink for a resolved hex background', () => {
    const style = avatarStyle('#ffffff');
    expect(style).toContain('background:#ffffff');
    expect(style).toContain(`color:${readableTextOn('#ffffff')}`);
  });

  it('writes no ink when the color fell back to a token (luminance unknown)', () => {
    expect(avatarStyle('nope')).toBe('background:var(--brand)');
  });
});
