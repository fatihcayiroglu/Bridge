process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';

const serverRoot = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

describe('issuer-scoped SSO persistence contract', () => {
  test('clean installs and startup upgrades use the same triple binding', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const inline = read('db', 'postgres', 'migrations.ts');
    const collection = read('db', 'postgres', 'pgCollection.ts');
    const entity = read('db', 'repositories', 'types', 'entities.d.ts');
    for (const source of [schema, inline]) {
      expect(source).toContain('"ssoIssuer"');
      expect(source).toMatch(/ON users\("ssoProvider", "ssoIssuer", "ssoId"\)/);
      expect(source).toContain('char_length("ssoIssuer") BETWEEN 1 AND 2048');
    }
    expect(collection).toContain("'ssoIssuer'");
    expect(entity).toContain('ssoIssuer?: string | null;');
  });

  test('migration quarantines legacy rows and rollback refuses namespace collapse', () => {
    const up057 = read('db', 'migrations_pg', '057_authentication_security_state.sql');
    const down057 = read('db', 'migrations_pg', 'rollback', '057_authentication_security_state.down.sql');
    const up = read('db', 'migrations_pg', '058_sso_issuer_binding.sql');
    const down = read('db', 'migrations_pg', 'rollback', '058_sso_issuer_binding.down.sql');
    // 057's predecessor (provider, subject) index has a distinct name from
    // 058's issuer-scoped triple. That lets an isolated 058 down restore the
    // previous invariant without looking like a leftover 058-owned object.
    expect(up057).toContain('idx_users_sso_provider_subject_unique');
    expect(up057).toMatch(/ON users\("ssoProvider", "ssoIssuer", "ssoId"\)/);
    expect(down057).toContain('DROP INDEX IF EXISTS idx_users_sso_provider_subject_unique');
    expect(up).toContain("'legacy:' || \"ssoProvider\"");
    expect(up).toMatch(/GROUP BY "ssoProvider", "ssoIssuer", "ssoId"/);
    expect(up).toMatch(/ON users\("ssoProvider", "ssoIssuer", "ssoId"\)/);
    expect(up).toContain('DROP INDEX IF EXISTS idx_users_sso_provider_subject_unique');
    expect(down).toMatch(/GROUP BY "ssoProvider", "ssoId"/);
    expect(down).toContain('issuer namespaces contain duplicate provider/subject bindings');
    expect(down).toMatch(/CREATE UNIQUE INDEX idx_users_sso_provider_subject_unique\s+ON users\("ssoProvider", "ssoId"\)/);
  });
});
