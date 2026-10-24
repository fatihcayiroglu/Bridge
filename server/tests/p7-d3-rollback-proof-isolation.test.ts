// The ordered-rollback proof replayer must never become a way around the
// production legacy-upgrade rejection on a real operator database.
import { assertRollbackProofTarget } from '../scripts/reapply-rollback-proof';

describe('P7-D3 migration rollback proof isolation', () => {
  const proof = 'postgresql://proof:proof@localhost:5432/bridge_rollback_proof_mnid42';

  it('permits only a reserved disposable PostgreSQL proof database in test mode', () => {
    expect(assertRollbackProofTarget(proof, 'test')).toBe(proof);
    expect(assertRollbackProofTarget(proof.replace('postgresql:', 'postgres:'), 'test')).toMatch(/^postgres:/);
  });

  it.each([
    ['production environment', proof, 'production'],
    ['development environment', proof, 'development'],
    ['missing URL', undefined, 'test'],
    ['application database', 'postgresql://localhost/bridge_prod', 'test'],
    ['postgres maintenance database', 'postgresql://localhost/postgres', 'test'],
    ['similar prefix', 'postgresql://localhost/bridge_rollback_proof', 'test'],
    ['trailing path', 'postgresql://localhost/bridge_rollback_proof_demo/extra', 'test'],
    ['unrelated protocol', 'https://example.test/bridge_rollback_proof_demo', 'test'],
  ])('refuses %s without ever connecting to a database', (_label, url, env) => {
    expect(() => assertRollbackProofTarget(url, env)).toThrow(/ROLLBACK_PROOF_ONLY/);
  });
});
