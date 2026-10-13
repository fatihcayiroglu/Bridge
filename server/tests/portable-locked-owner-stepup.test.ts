import { mintStepUpGrant } from '../lib/stepUp';
import { LockedPortableOwnerStepUpError, requireLockedPortableOwnerStepUp } from '../lib/portableLockedOwnerStepUp';

const NOW = Date.parse('2026-10-13T15:00:00.000Z');
const OWNER = 'target-owner';
const previousSecret = process.env.STEP_UP_SECRET;
const previousDisabled = process.env.STEP_UP_DISABLED_SCOPES;
beforeAll(() => { process.env.STEP_UP_SECRET = 'bridge-c4-test-only-stepup-secret-2026'; });
afterAll(() => {
  if (previousSecret === undefined) delete process.env.STEP_UP_SECRET;
  else process.env.STEP_UP_SECRET = previousSecret;
  if (previousDisabled === undefined) delete process.env.STEP_UP_DISABLED_SCOPES;
  else process.env.STEP_UP_DISABLED_SCOPES = previousDisabled;
});
function fixture(config: {
  isolation?: string; readOnly?: string; owner?: string; version?: number;
  twoFactor?: boolean; missing?: boolean;
} = {}) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    queries,
    client: {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        if (sql.includes('transaction_isolation')) return { rows: [{
          isolation: config.isolation ?? 'serializable',
          readonly: config.readOnly ?? 'off',
        }] };
        if (sql.includes('FROM users')) return { rows: config.missing ? [] : [{
          _id: config.owner ?? OWNER,
          tokenVersion: config.version ?? 7,
          twoFactorEnabled: config.twoFactor ?? false,
        }] };
        throw Error('Unexpected query');
      },
    },
  };
}
function grant(method: 'password' | 'totp' = 'password', scope: 'account-security' | 'sensitive-export' = 'account-security', at = NOW) {
  return mintStepUpGrant({ _id: OWNER, tokenVersion: 7 }, method, scope, at).token;
}
function verify(config: Parameters<typeof fixture>[0] = {}, token: unknown = grant(), now = NOW) {
  return requireLockedPortableOwnerStepUp({ client: fixture(config).client, ownerId: OWNER, stepUpGrant: token, now });
}
describe('P7 C4 locked owner step-up (never an approval)', () => {
  it('verifies fresh scope against the same SQL client and returns no bearer credential', async () => {
    const f = fixture();
    const result = await requireLockedPortableOwnerStepUp({
      client: f.client, ownerId: OWNER, stepUpGrant: grant(), now: NOW,
    });
    expect(result).toEqual({
      mode: 'transaction-check-only', action: 'account.import',
      stepUpVerified: true, consentVerified: false, tokenIssued: false,
      writesPerformed: false, importSupported: false,
    });
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1]?.sql).toContain('FROM users WHERE _id=$1 FOR SHARE');
    expect(f.queries[1]?.params).toEqual([OWNER]);
    expect(JSON.stringify(result)).not.toContain('grant');
  });

  it.each([
    { isolation: 'read committed' },
    { isolation: 'repeatable read' },
    { readOnly: 'on' },
    { owner: 'different-owner' },
    { missing: true },
    { version: 8 },
    { twoFactor: true },
  ])('refuses stale/foreign/unsafe destination credential factors %#', async config => {
    await expect(verify(config)).rejects.toBeInstanceOf(LockedPortableOwnerStepUpError);
  });

  it('requires a matching credential level for a 2FA account', async () => {
    expect((await verify({ twoFactor: true }, grant('totp'))).stepUpVerified).toBe(true);
    await expect(verify({ twoFactor: true }, grant('password')))
      .rejects.toBeInstanceOf(LockedPortableOwnerStepUpError);
  });

  it('denies expired, too old, future, altered and mismatched-scope tokens', async () => {
    for (const token of [
      '',
      'garbage',
      grant('password', 'sensitive-export'),
      grant('password', 'account-security', NOW - 130_000),
      grant('password', 'account-security', NOW + 60_000),
      grant().slice(0, -3) + 'bad',
    ]) {
      await expect(verify({}, token)).rejects.toBeInstanceOf(LockedPortableOwnerStepUpError);
    }
  });

  it('never honors the general scope enforcement rollback switch', async () => {
    process.env.STEP_UP_DISABLED_SCOPES = 'account-security';
    await expect(verify({}, null)).rejects.toBeInstanceOf(LockedPortableOwnerStepUpError);
    expect((await verify({}, grant())).stepUpVerified).toBe(true);
    delete process.env.STEP_UP_DISABLED_SCOPES;
  });
});
