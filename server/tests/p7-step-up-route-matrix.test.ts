// server/tests/p7-step-up-route-matrix.test.ts
//
// P7 B2 — the route matrix. Every always-protected route, mounted at its
// production path (app/setupRoutes.ts) with the real authMiddleware, is driven
// with: no grant, a grant for another scope, another account's grant, an
// expired grant, a revoked grant (tokenVersion moved on), a tampered grant, an
// access token in the grant header, a password-level grant on a 2FA account,
// and finally the right grant — which must get past the guard to the route's
// own behaviour. Burst-gated moderation routes are covered by
// p7-step-up-moderation-burst.test.ts; DELETE /api/account (which needs
// PostgreSQL before the proof is checked) by account-route-behavior.test.ts.
// Multi-node: grants are stateless — a grant minted by one process verifies in
// another that shares the secret, and in no process that does not.

process.env.RL_2FA_MAX = '1000';

import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));
jest.mock('../lib/mailer', () => ({ sendVerificationEmail: jest.fn().mockResolvedValue(true), sendPasswordResetEmail: jest.fn().mockResolvedValue(true) }));

const request = require('supertest');
import db from '../db/loader';
import { makeToken } from '../middleware/auth';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';
import emailRouter from '../routes/email';
import webauthnRouter from '../routes/webauthn';
import twoFactorRouter from '../routes/twoFactor';
import accountRouter from '../routes/account';
import serversRouter from '../routes/servers';
import adminRouter from '../routes/admin';
import { STEP_UP_HEADER, STEP_UP_SCOPES, mintStepUpGrant, type StepUpMethod, type StepUpScope } from '../lib/stepUp';

type Row = Record<string, unknown>;
const store = db as unknown as Record<string, { insert(d: Row): Promise<unknown>; update(q: Row, u: Row): Promise<unknown> }>;

function buildApp() {
  const app = express();
  app.use(express.json());
  // Production mount points (app/setupRoutes.ts mountApi).
  app.use('/api/email', emailRouter);
  app.use('/api/webauthn', webauthnRouter);
  app.use('/api/2fa', twoFactorRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/servers', serversRouter);
  app.use('/api/admin', adminRouter);
  return app;
}

interface Account { id: string; token: string; tokenVersion: number }
async function account(extra: Row = {}): Promise<Account> {
  const id = uuidv4();
  const tokenVersion = Number(extra.tokenVersion ?? 0);
  await store.users.insert({ _id: id, username: `m-${id.slice(0, 8)}`, displayName: 'M', password: '$2b$04$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyz01234', tokenVersion, twoFactorEnabled: false, ...extra });
  return { id, token: makeToken({ _id: id, username: 'm', tokenVersion }), tokenVersion };
}

interface Row403 { method: 'get' | 'post' | 'delete'; path: (ctx: Ctx) => string; body?: Row; action: string; scope: StepUpScope; admin?: boolean }
interface Ctx { serverId: string }

const MATRIX: Row403[] = [
  { method: 'post', path: () => '/api/email/add', body: { email: 'new@example.com' }, action: 'email.change', scope: 'account-security' },
  { method: 'post', path: () => '/api/webauthn/register/begin', body: {}, action: 'passkey.add', scope: 'account-security' },
  { method: 'post', path: () => '/api/webauthn/register/complete', body: {}, action: 'passkey.add', scope: 'account-security' },
  { method: 'delete', path: () => '/api/webauthn/credentials/some-credential', action: 'passkey.remove', scope: 'account-security' },
  { method: 'post', path: () => '/api/2fa/setup', body: {}, action: 'two_factor.enable', scope: 'account-security' },
  { method: 'post', path: () => '/api/2fa/verify', body: { code: '123456' }, action: 'two_factor.enable', scope: 'account-security' },
  { method: 'post', path: () => '/api/2fa/disable', body: { password: 'pw' }, action: 'two_factor.disable', scope: 'account-security' },
  { method: 'post', path: () => '/api/2fa/backup-codes/regenerate', body: { password: 'pw' }, action: 'backup_codes.regenerate', scope: 'account-security' },
  { method: 'get', path: () => '/api/account/export', action: 'account.export', scope: 'sensitive-export' },
  { method: 'delete', path: (c) => `/api/servers/${c.serverId}`, action: 'server.delete', scope: 'destructive-admin' },
  { method: 'delete', path: () => `/api/admin/users/${uuidv4()}`, action: 'admin.user.delete', scope: 'destructive-admin', admin: true },
  { method: 'delete', path: () => `/api/admin/servers/${uuidv4()}`, action: 'admin.server.delete', scope: 'destructive-admin', admin: true },
];

let app: ReturnType<typeof buildApp>;
beforeAll(() => { delete process.env.REDIS_URL; });
beforeEach(() => { _resetRateLimitStoreForTest(); app = buildApp(); });

async function fixture(row: Row403, extra: Row = {}): Promise<{ me: Account; ctx: Ctx }> {
  const me = await account({ ...(row.admin ? { isAdmin: true } : {}), ...extra });
  const serverId = uuidv4();
  await store.servers.insert({ _id: serverId, name: 'Mine', ownerId: me.id, createdAt: Date.now() });
  await store.members.insert({ userId: me.id, serverId, roles: '[]', joinedAt: Date.now() });
  return { me, ctx: { serverId } };
}

function send(row: Row403, ctx: Ctx, me: Account, grant?: string) {
  let req = request(app)[row.method](row.path(ctx)).set('Authorization', `Bearer ${me.token}`);
  if (grant !== undefined) req = req.set(STEP_UP_HEADER, grant);
  return row.body ? req.send(row.body) : req;
}

const grantFor = (me: Pick<Account, 'id' | 'tokenVersion'>, scope: StepUpScope, method: StepUpMethod = 'totp', now = Date.now()) =>
  mintStepUpGrant({ _id: me.id, tokenVersion: me.tokenVersion }, method, scope, now).token;

describe.each(MATRIX)('$method $action', (row) => {
  it('without a grant: 403 STEP_UP_REQUIRED naming the action, its scope and the ways to prove', async () => {
    const { me, ctx } = await fixture(row);
    const r = await send(row, ctx, me);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'STEP_UP_REQUIRED', action: row.action, scope: row.scope, reasons: ['step_up_missing'], level: 1, methods: ['password', 'sign_in'], ttlMs: 600_000 });
    expect(typeof r.body.why).toBe('string');
  });

  it('a grant for any OTHER scope is refused as a scope mismatch', async () => {
    const { me, ctx } = await fixture(row);
    for (const other of STEP_UP_SCOPES.filter((s) => s !== row.scope)) {
      const r = await send(row, ctx, me, grantFor(me, other));
      expect(r.status).toBe(403);
      expect(r.body.reasons).toEqual(['step_up_scope_mismatch']);
    }
  });

  it("another account's grant, an expired, tampered or wrong-type token are refused with the named reason", async () => {
    const { me, ctx } = await fixture(row);
    const someoneElse = await account();
    const cases: Array<[string, string]> = [
      [grantFor(someoneElse, row.scope), 'step_up_other_account'],
      [grantFor(me, row.scope, 'totp', Date.now() - 11 * 60_000), 'step_up_expired'],
      [`${grantFor(me, row.scope).slice(0, -3)}AAA`, 'step_up_invalid'],
      [me.token, 'step_up_invalid'],
      [jwt.sign({ sub: me.id, v: 0, level: 2, method: 'totp', scope: row.scope, typ: 'stepup' }, process.env.JWT_SECRET as string, { audience: 'bridge-step-up', expiresIn: 600 }), 'step_up_invalid'],
    ];
    for (const [grant, reason] of cases) {
      const r = await send(row, ctx, me, grant);
      expect(r.status).toBe(403);
      expect(r.body.reasons).toEqual([reason]);
    }
  });

  it('a grant from before tokenVersion moved on (sign-out everywhere, password or 2FA change) is revoked', async () => {
    const { me, ctx } = await fixture(row, { tokenVersion: 1 });
    const r = await send(row, ctx, me, grantFor({ id: me.id, tokenVersion: 0 }, row.scope));
    expect(r.status).toBe(403);
    expect(r.body.reasons).toEqual(['step_up_revoked']);
  });

  it('an account with 2FA needs a level-2 grant: a password-level grant is refused', async () => {
    const { me, ctx } = await fixture(row, { twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP', twoFactorBackup: '[]' });
    const none = await send(row, ctx, me);
    expect(none.body).toMatchObject({ level: 2, methods: ['totp', 'backup_code', 'sign_in'] });
    for (const method of ['password', 'sso'] as const) {
      const r = await send(row, ctx, me, grantFor(me, row.scope, method));
      expect(r.status).toBe(403);
      expect(r.body.reasons).toEqual(['step_up_level']);
    }
    const ok = await send(row, ctx, me, grantFor(me, row.scope, 'passkey'));
    expect(ok.body?.error).not.toBe('STEP_UP_REQUIRED');
  });

  it('the right grant gets past the guard to the route itself', async () => {
    const { me, ctx } = await fixture(row);
    const r = await send(row, ctx, me, grantFor(me, row.scope, 'password'));
    expect(r.body?.error).not.toBe('STEP_UP_REQUIRED');
    expect(r.status).not.toBe(401);
  });
});

describe('multi-node: grants are stateless', () => {
  function loadNode(secret?: string) {
    let mod!: typeof import('../lib/stepUp');
    const saved = process.env.STEP_UP_SECRET;
    if (secret === undefined) delete process.env.STEP_UP_SECRET; else process.env.STEP_UP_SECRET = secret;
    jest.isolateModules(() => { mod = require('../lib/stepUp'); });
    const restore = () => { if (saved === undefined) delete process.env.STEP_UP_SECRET; else process.env.STEP_UP_SECRET = saved; };
    return { mod, restore };
  }

  it('a grant minted by node A verifies on node B (separate module instance, same secret)', () => {
    const factors = { password: true, twoFactor: false, tokenVersion: 0 };
    const a = loadNode();
    const grant = a.mod.mintStepUpGrant({ _id: 'u-mn' }, 'password', 'sensitive-export').token;
    a.restore();
    const b = loadNode();
    expect(b.mod).not.toBe(a.mod);
    expect(b.mod.checkStepUpGrant(grant, 'u-mn', factors, 'sensitive-export')).toEqual({ ok: true, claims: expect.objectContaining({ sub: 'u-mn' }) });
    b.restore();
  });

  it('a node with a different STEP_UP_SECRET rejects it (all nodes must share the secret)', () => {
    const factors = { password: true, twoFactor: false, tokenVersion: 0 };
    const a = loadNode('node-a-step-up-secret-0123456789abcdef0123');
    const grant = a.mod.mintStepUpGrant({ _id: 'u-mn' }, 'password', 'sensitive-export').token;
    a.restore();
    process.env.STEP_UP_SECRET = 'node-b-step-up-secret-0123456789abcdef0123';
    try {
      const b = loadNode('node-b-step-up-secret-0123456789abcdef0123');
      expect(b.mod.checkStepUpGrant(grant, 'u-mn', factors, 'sensitive-export')).toEqual({ ok: false, reason: 'step_up_invalid' });
      b.restore();
    } finally {
      delete process.env.STEP_UP_SECRET;
    }
  });
});
