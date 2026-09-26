process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';
import { createMockDb } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));

import { databaseAdminOnly, isDatabaseAdmin } from '../lib/adminAuthority';

beforeEach(() => mockDb._reset?.());

describe('canonical site-admin authority', () => {
  it('uses current DB state rather than stale token-style claims', async () => {
    await mockDb.users.insert({ _id: 'u1', username: 'u1', displayName: 'U1', isAdmin: false });
    expect(await isDatabaseAdmin('u1')).toBe(false);
    await mockDb.users.update({ _id: 'u1' }, { $set: { isAdmin: true } });
    expect(await isDatabaseAdmin('u1')).toBe(true);
    await mockDb.users.update({ _id: 'u1' }, { $set: { isAdmin: false } });
    expect(await isDatabaseAdmin('u1')).toBe(false);
  });

  it('rejects malformed/missing identities without touching DB', async () => {
    expect(await isDatabaseAdmin(undefined)).toBe(false);
    expect(await isDatabaseAdmin('   ')).toBe(false);
  });

  it('fails closed if current admin state cannot be read', async () => {
    const spy = jest.spyOn(mockDb.users, 'findOne').mockRejectedValueOnce(new Error('db unavailable'));
    await expect(isDatabaseAdmin('u1')).rejects.toThrow('db unavailable');
    spy.mockRestore();
  });

  it('middleware distinguishes missing authentication from non-admin authorization', async () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const next = jest.fn();
    await databaseAdminOnly({} as any, { status, json } as any, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('middleware rejects a stale admin claim when DB says non-admin', async () => {
    await mockDb.users.insert({ _id: 'u2', username: 'u2', displayName: 'U2', isAdmin: false });
    const req = { user: { id: 'u2', isAdmin: true, role: 'admin', flags: ['admin'] } } as any;
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const next = jest.fn();
    await databaseAdminOnly(req, { status, json } as any, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('admin-only route surface', () => {
  it('does not authorize the known admin surfaces directly from JWT admin claims', () => {
    const root = path.resolve(__dirname, '..');
    const files = [
      'routes/badges.ts',
      'routes/discover.ts',
      'routes/client-error.ts',
      'routes/bot-marketplace.ts',
      'routes/upload.ts',
    ];
    const forbidden = [
      /req\.user\?\.isAdmin/,
      /authedUser\.isAdmin/,
      /_u\?\.role\s*===\s*['"]admin['"]/,
      /_u\?\.flags.*admin/,
      /if\s*\(\s*!user\.isAdmin\s*\)/,
    ];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const pattern of forbidden) expect(source).not.toMatch(pattern);
    }
  });
});
