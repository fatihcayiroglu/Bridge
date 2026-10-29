// client/tests/channel-expiry.test.ts — P7 D2 (#321) client helpers for ephemeral channels.
import { describe, expect, it, vi } from 'vitest';
import {
  CLOCK_SKEW_MARGIN_MS, DAY_MS, EXPIRY_CHOICES, HOUR_MS, MAX_LIFETIME_MS, MIN_LIFETIME_MS,
  channelExpiresAt, channelExpiryVersion, formatChannelExpiry, requestedExpiresAt, saveChannelExpiry,
} from '../js/core/channel-list/channel-expiry.ts';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

describe('reading what the server sent', () => {
  it('accepts positive epoch-ms numbers and the BIGINT strings PostgreSQL returns', () => {
    expect(channelExpiresAt({ expiresAt: NOW + HOUR_MS })).toBe(NOW + HOUR_MS);
    expect(channelExpiresAt({ expiresAt: String(NOW + HOUR_MS) })).toBe(NOW + HOUR_MS);
  });
  it('treats absent, null, malformed or non-positive values as permanent', () => {
    for (const value of [undefined, null, 0, -5, 1.5, 'soon', '12abc', Number.NaN, {}, [], true]) {
      expect(channelExpiresAt({ expiresAt: value })).toBeNull();
    }
    expect(channelExpiresAt(null)).toBeNull();
    expect(channelExpiresAt('x')).toBeNull();
  });
  it('reads the optimistic version, defaulting to 0', () => {
    expect(channelExpiryVersion({ expiryVersion: 3 })).toBe(3);
    expect(channelExpiryVersion({ expiryVersion: '4' })).toBe(4);
    for (const value of [undefined, -1, 'x', 2.5, null]) expect(channelExpiryVersion({ expiryVersion: value })).toBe(0);
    expect(channelExpiryVersion(undefined)).toBe(0);
  });
});

describe('formatChannelExpiry', () => {
  it('is absolute, carries an ISO time for <time>, and warns within a day', () => {
    const far = formatChannelExpiry(NOW + 3 * DAY_MS, NOW, 'en-GB')!;
    expect(far.iso).toBe(new Date(NOW + 3 * DAY_MS).toISOString());
    expect(far.soon).toBe(false);
    expect(far.absolute).toMatch(/2026/);
    expect(formatChannelExpiry(NOW + 2 * HOUR_MS, NOW)!.soon).toBe(true);
    expect(formatChannelExpiry(null, NOW)).toBeNull();
  });
  it('falls back when the locale is unusable', () => {
    expect(formatChannelExpiry(NOW + DAY_MS * 2, NOW, 'not a locale!!')!.absolute.length).toBeGreaterThan(0);
  });
});

describe('requestedExpiresAt', () => {
  it('stays inside the server window despite clock skew', () => {
    expect(requestedExpiresAt(null, NOW)).toBeNull();
    expect(requestedExpiresAt(MIN_LIFETIME_MS, NOW)).toBe(NOW + MIN_LIFETIME_MS + CLOCK_SKEW_MARGIN_MS);
    expect(requestedExpiresAt(MAX_LIFETIME_MS, NOW)).toBe(NOW + MAX_LIFETIME_MS - CLOCK_SKEW_MARGIN_MS);
    expect(requestedExpiresAt(7 * DAY_MS, NOW)).toBe(NOW + 7 * DAY_MS);
  });
  it('offers exactly never, 1 h, 24 h, 7 d and 30 d', () => {
    expect(EXPIRY_CHOICES.map(c => c.key)).toEqual(['never', '1h', '24h', '7d', '30d']);
    for (const c of EXPIRY_CHOICES) {
      if (c.lifetimeMs !== null) {
        const at = requestedExpiresAt(c.lifetimeMs, NOW)! - NOW;
        expect(at).toBeGreaterThan(MIN_LIFETIME_MS);
        expect(at).toBeLessThan(MAX_LIFETIME_MS);
      }
    }
  });
});

describe('saveChannelExpiry', () => {
  const respond = (status: number, body: unknown) => vi.fn(async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);

  it('PUTs the expiry with the version the owner saw, to an encoded path', async () => {
    const fetchFn = respond(200, { channelId: 'c/1', expiresAt: NOW + DAY_MS, expiryVersion: 3 });
    const result = await saveChannelExpiry(fetchFn, 'http://api', 's 1', 'c/1', NOW + DAY_MS, 2);
    expect(result).toEqual({ ok: true, expiresAt: NOW + DAY_MS, expiryVersion: 3 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/api/servers/s%201/channels/c%2F1/expiry');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ expiresAt: NOW + DAY_MS, expectedVersion: 2 });
  });

  it('clears an expiry with null', async () => {
    const result = await saveChannelExpiry(respond(200, { expiresAt: null, expiryVersion: 4 }), '', 's', 'c', null, 3);
    expect(result).toEqual({ ok: true, expiresAt: null, expiryVersion: 4 });
  });

  it('maps every server refusal to a reason the dialog can explain', async () => {
    const cases: Array<[number, unknown, string]> = [
      [409, { code: 'LAST_PERMANENT_CHANNEL' }, 'last_permanent_channel'],
      [409, { code: 'VERSION_CONFLICT' }, 'version_conflict'],
      [422, { code: 'OUTSIDE_WINDOW' }, 'outside_window'],
      [422, {}, 'outside_window'],
      [403, { code: 'FORBIDDEN' }, 'forbidden'],
      [404, { code: 'NOT_FOUND' }, 'not_found'],
      [500, null, 'failed'],
      [200, { expiresAt: null }, 'failed'],   // asked for an expiry, server answered permanent
    ];
    for (const [status, body, reason] of cases) {
      expect(await saveChannelExpiry(respond(status, body), '', 's', 'c', NOW + DAY_MS, 0)).toEqual({ ok: false, reason });
    }
    const offline = vi.fn(async () => { throw new Error('offline'); });
    expect(await saveChannelExpiry(offline, '', 's', 'c', null, 0)).toEqual({ ok: false, reason: 'failed' });
  });
});
