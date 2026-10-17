import fs from 'fs';
import path from 'path';
import {
  channelExpiryStatus, validateChannelExpiryCandidate,
  MIN_CHANNEL_LIFETIME_MS, MAX_CHANNEL_LIFETIME_MS,
} from '../lib/channelExpiry';

describe('P7 D2 schema groundwork is inert until lifecycle enforcement is shipped', () => {
  it('never schedules existing permanent channels, preserving NULL and version zero', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../db/postgres/schema.ts'), 'utf8');
    const migration = fs.readFileSync(path.join(__dirname, '../db/migrations_pg/084_channel_expiry_foundation.sql'), 'utf8');
    for (const source of [schema, migration]) {
      expect(source).toContain('"expiresAt" BIGINT');
      expect(source).toContain('"expiryVersion" BIGINT NOT NULL DEFAULT 0');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS channel_expiry_tombstones');
      expect(source).toContain('"channelId" TEXT PRIMARY KEY');
      expect(source).toContain('CHECK ("cleanupState" IN');
      expect(source).not.toMatch(/REFERENCES channels\s*\(/);
    }
    expect(migration).not.toMatch(/UPDATE\s+channels\s+SET/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+channels/i);
    expect(migration).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i);
  });

  it('distinguishes permanent, live and expired without client clocks or coercion', () => {
    const now = 1_800_000_000_000;
    expect(channelExpiryStatus(null, now)).toBe('permanent');
    expect(channelExpiryStatus(undefined, now)).toBe('permanent');
    expect(channelExpiryStatus(now + 1, now)).toBe('active');
    expect(channelExpiryStatus(String(now + 1), now)).toBe('active');
    expect(channelExpiryStatus(now, now)).toBe('expired');
    expect(channelExpiryStatus(now - 1, now)).toBe('expired');
    for (const corrupt of ['', '0', 0, -1, '01', '1e3', ' 123', 1.5, Number.MAX_SAFE_INTEGER + 1, {}, false]) {
      expect(() => channelExpiryStatus(corrupt, now)).toThrow();
    }
    expect(() => channelExpiryStatus(null, NaN)).toThrow();
  });

  it('bounds candidate lifetime and forbids arbitrary or unsafe API input', () => {
    const now = 1_800_000_000_000;
    expect(validateChannelExpiryCandidate(null, now)).toBeNull();
    expect(validateChannelExpiryCandidate(undefined, now)).toBeNull();
    expect(validateChannelExpiryCandidate(now + MIN_CHANNEL_LIFETIME_MS, now))
      .toBe(now + MIN_CHANNEL_LIFETIME_MS);
    expect(validateChannelExpiryCandidate(now + MAX_CHANNEL_LIFETIME_MS, now))
      .toBe(now + MAX_CHANNEL_LIFETIME_MS);
    for (const bad of [
      now, now + MIN_CHANNEL_LIFETIME_MS - 1, now + MAX_CHANNEL_LIFETIME_MS + 1,
      String(now + MIN_CHANNEL_LIFETIME_MS), 1.5, Infinity, NaN, {}, true,
    ]) {
      expect(() => validateChannelExpiryCandidate(bad, now)).toThrow();
    }
    expect(() => validateChannelExpiryCandidate(now + MIN_CHANNEL_LIFETIME_MS, Number.MAX_SAFE_INTEGER))
      .toThrow();
  });
});
