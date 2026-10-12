// P7 C4 source-side signed export HTTP boundaries. The actual issuer's
// PostgreSQL MVCC/signature semantics are covered by #213's live PG test.
process.env.JWT_SECRET = 'signed-source-export-test-jwt-32chars!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../lib/portableSourceExportConfig', () => ({
  readPortableSourceSigningConfig: jest.fn(),
}));
jest.mock('../lib/portableSourceSnapshotIssuer', () => ({
  issueAtomicPortableSourceAttestation: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import serversRouter from '../routes/servers';
import { stepUpHeader } from './helpers/stepUp';
import { readPortableSourceSigningConfig } from '../lib/portableSourceExportConfig';
import { issueAtomicPortableSourceAttestation } from '../lib/portableSourceSnapshotIssuer';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const config = readPortableSourceSigningConfig as jest.Mock;
const issue = issueAtomicPortableSourceAttestation as jest.Mock;
const SOURCE = 'signed-source-community';
const OWNER = 'signed-source-owner';
const OTHER = 'signed-source-other';
const TOKEN = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const POOL = { connect: jest.fn() };
const PRIVATE = 'private-signing-key-value-test-only';
function app() {
  const a = express();
  a.use(express.json({ limit: '512kb' }));
  a.use('/api/servers', serversRouter);
  return a;
}
function get(user: string | null, scope: 'sensitive-export' | 'account-security' | null = null) {
  let q = request(app()).get(`/api/servers/${SOURCE}/portable-export/attested-pair`)
    .set('Host', 'forged-untrusted-domain.example');
  if (user) q = q.set('Authorization', `Bearer ${TOKEN(user)}`);
  if (scope && user) q = q.set(stepUpHeader(user, scope));
  return q;
}

beforeEach(async () => {
  db._reset();
  config.mockReset();
  issue.mockReset();
  (db as unknown as { _pool?: typeof POOL })._pool = POOL;
  for (const id of [OWNER, OTHER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SOURCE, name: 'Source', ownerId: OWNER });
  await db.members.insert({ _id: 'other-member', serverId: SOURCE, userId: OTHER, roles: [] });
  config.mockReturnValue({
    sourceOrigin: 'https://operator-pinned-source.example',
    signingPrivateKeyPem: PRIVATE,
  });
  issue.mockResolvedValue({
    mode: 'read-only', writesPerformed: false, importSupported: false,
    mappingApproved: false, approvalReusable: false,
    sourceReadIsolation: 'single-client-repeatable-read',
    remotelyVerifiedAtomicity: false,
    signingPrivateKeyPem: PRIVATE, // MUST NOT be returned via HTTP
    backendDebug: 'internal-only-canary',
    structure: { integrity: { digest: 'a'.repeat(64) } },
    permissions: { integrity: { digest: 'b'.repeat(64) } },
    attestation: { signature: 'test-ed25519-signature', sourceOrigin: 'https://operator-pinned-source.example' },
  });
});

describe('GET /api/servers/:sid/portable-export/attested-pair', () => {
  it('refuses unauthenticated, missing, non-owner and missing/wrong step-up before any signing or pool query', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get(OTHER, 'sensitive-export')).status).toBe(403);
    expect((await get(OWNER)).status).toBe(403);
    expect((await get(OWNER, 'account-security')).status).toBe(403);
    const missing = await request(app()).get('/api/servers/no-such-source/portable-export/attested-pair')
      .set('Authorization', `Bearer ${TOKEN(OWNER)}`)
      .set(stepUpHeader(OWNER, 'sensitive-export'));
    expect(missing.status).toBe(404);
    expect(config).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(POOL.connect).not.toHaveBeenCalled();
  });

  it('uses the operator-pinned origin/key and same PG pool, never request Host or client-selected inputs', async () => {
    const before = {
      servers: await db.servers.find({}),
      channels: await db.channels.find({}),
      roles: await db.roles.find({}),
      permissions: await db.channelPermissions.find({}),
    };
    const result = await get(OWNER, 'sensitive-export');
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-disposition']).toContain('attested-pair');
    expect(result.body).toMatchObject({
      mode: 'read-only', importSupported: false, writesPerformed: false,
      mappingApproved: false, remotelyVerifiedAtomicity: false,
    });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue).toHaveBeenCalledWith({
      pool: POOL, sourceServerId: SOURCE, ownerUserId: OWNER,
      sourceOrigin: 'https://operator-pinned-source.example',
      signingPrivateKeyPem: PRIVATE,
    });
    expect(JSON.stringify(result.body)).not.toContain(PRIVATE);
    expect(JSON.stringify(result.body)).not.toContain('internal-only-canary');
    expect(JSON.stringify(result.body)).not.toContain('forged-untrusted-domain.example');
    expect(await db.servers.find({})).toEqual(before.servers);
    expect(await db.channels.find({})).toEqual(before.channels);
    expect(await db.roles.find({})).toEqual(before.roles);
    expect(await db.channelPermissions.find({})).toEqual(before.permissions);
  });

  it('fails closed if signer suddenly claims imports, writes or a foreign origin', async () => {
    for (const alteration of [
      { importSupported: true }, { writesPerformed: true },
      { mappingApproved: true }, { approvalReusable: true },
      { sourceReadIsolation: 'non-transactional' },
      { attestation: { signature: 'signed', sourceOrigin: 'https://untrusted.example' } },
    ]) {
      issue.mockResolvedValueOnce({
        mode: 'read-only', writesPerformed: false, importSupported: false,
        mappingApproved: false, approvalReusable: false,
        sourceReadIsolation: 'single-client-repeatable-read',
        remotelyVerifiedAtomicity: false,
        attestation: { signature: 'signed', sourceOrigin: 'https://operator-pinned-source.example' },
        structure: {}, permissions: {},
        ...alteration,
      });
      const response = await get(OWNER, 'sensitive-export');
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('PORTABLE_SOURCE_ATTESTED_EXPORT_UNAVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain('signed');
    }
  });

  it('fails closed if key is not provisioned, no real PG pool exists, or snapshot issuer fails', async () => {
    config.mockImplementationOnce(() => { throw new Error('signing secret material'); });
    const unconfigured = await get(OWNER, 'sensitive-export');
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.code).toBe('PORTABLE_SOURCE_ATTESTED_EXPORT_UNAVAILABLE');
    expect(JSON.stringify(unconfigured.body)).not.toContain('signing secret material');
    expect(issue).not.toHaveBeenCalled();

    (db as unknown as { _pool?: unknown })._pool = undefined;
    const noPool = await get(OWNER, 'sensitive-export');
    expect(noPool.status).toBe(503);
    expect(issue).not.toHaveBeenCalled();
    (db as unknown as { _pool?: typeof POOL })._pool = POOL;

    issue.mockRejectedValueOnce(new Error('database password must never be echoed'));
    const failed = await get(OWNER, 'sensitive-export');
    expect(failed.status).toBe(503);
    expect(failed.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(failed.body)).not.toContain('database password');
  });

  it('fails closed when a VALID read-only issuer response exceeds the fixed size limit', async () => {
    issue.mockResolvedValueOnce({
      mode: 'read-only', importSupported: false, writesPerformed: false,
      mappingApproved: false, approvalReusable: false,
      sourceReadIsolation: 'single-client-repeatable-read',
      remotelyVerifiedAtomicity: false,
      structure: { oversizedCanary: 'x'.repeat(1152 * 1024 + 1) },
      permissions: {},
      attestation: { sourceOrigin: 'https://operator-pinned-source.example' },
    });
    const res = await get(OWNER, 'sensitive-export');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PORTABLE_SOURCE_ATTESTED_EXPORT_UNAVAILABLE');
    expect(res.body).not.toHaveProperty('structure');
    expect(JSON.stringify(res.body)).not.toContain('oversizedCanary');
  });
});
