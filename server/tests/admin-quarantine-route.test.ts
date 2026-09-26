process.env.NODE_ENV = 'test';

const listQuarantinedFiles = jest.fn();
const deleteQuarantinedFile = jest.fn();
const logAction = jest.fn();

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'admin1', isAdmin: true }; next(); },
}));
jest.mock('../lib/authSafe', () => ({ safeCastAuthed: (req: any) => ({ user: req.user }) }));
jest.mock('../middleware/rateLimit', () => ({ limits: { moderation: () => (_req: any, _res: any, next: any) => next() } }));
jest.mock('../routes/admin/middleware', () => ({
  adminOnly: (_req: any, _res: any, next: any) => next(),
  logAction,
}));
jest.mock('../middleware/ipBan', () => ({
  banIp: jest.fn(), unbanIp: jest.fn(), listBans: jest.fn(async () => []), getClientIp: jest.fn(() => '127.0.0.1'),
}));
jest.mock('../lib/contentScanner', () => ({ listQuarantinedFiles, deleteQuarantinedFile }));

import express from 'express';
import request from 'supertest';
import { moderationRouter } from '../routes/admin/moderation';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', moderationRouter);
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status || 500).json({ error: err?.message || 'error' }));
  return a;
}

beforeEach(() => jest.clearAllMocks());

describe('canonical admin quarantine routes', () => {
  it('lists mapped quarantine metadata without inventing fields', async () => {
    listQuarantinedFiles.mockReturnValue([
      { filename: 'bad.bin', size: 42, reason: 'malware', severity: 'high', quarantinedAt: 123, userId: 'u1', username: 'U', hash: 'abc' },
    ]);
    const res = await request(app()).get('/api/admin/quarantine');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1, files: [{
      filename: 'bad.bin', size: 42, reason: 'malware', severity: 'high', quarantinedAt: 123,
      userId: 'u1', username: 'U', originalName: 'bad.bin', hash: 'abc',
    }] });
  });

  it('handles an empty quarantine list', async () => {
    listQuarantinedFiles.mockReturnValue([]);
    const res = await request(app()).get('/api/admin/quarantine');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, files: [] });
  });

  it.each(['..evil', 'a..b'])('rejects traversal-like quarantine filename %s', async (name) => {
    const res = await request(app()).delete(`/api/admin/quarantine/${encodeURIComponent(name)}`);
    expect(res.status).toBe(400);
    expect(deleteQuarantinedFile).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('deletes a basename and writes the audit action', async () => {
    deleteQuarantinedFile.mockReturnValue(true);
    const res = await request(app()).delete('/api/admin/quarantine/bad.bin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteQuarantinedFile).toHaveBeenCalledWith('bad.bin');
    expect(logAction).toHaveBeenCalledWith('admin1', 'quarantine_delete', 'bad.bin');
  });

  it('propagates scanner deletion uncertainty instead of claiming success', async () => {
    deleteQuarantinedFile.mockImplementation(() => { throw new Error('quarantine fs unavailable'); });
    const res = await request(app()).delete('/api/admin/quarantine/bad.bin');
    expect(res.status).toBe(500);
    expect(logAction).not.toHaveBeenCalled();
  });
});
