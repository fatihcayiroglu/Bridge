import express from 'express';
import request from 'supertest';

const unlinkSync = jest.fn();
const existsSync = jest.fn((..._args: unknown[]) => true);
const singleCalls = jest.fn();
const checkMagicBytes = jest.fn((..._args: unknown[]) => true);
const hasLiveUploadReference = jest.fn(async (..._args: unknown[]) => false);
const resolvePermissions = jest.fn(async (..._args: unknown[]) => 0n);
const hasPermission = jest.fn((...args: unknown[]) => args[0] === 1n);

const repos = {
  Members: {
    findOne: jest.fn(),
    findByUser: jest.fn(),
  },
  Servers: { findByIds: jest.fn() },
  ServerAssets: {
    findEmojisSorted: jest.fn(),
    findEmojiByServerAndName: jest.fn(),
    insertEmoji: jest.fn(),
    findEmojiByIdAndServer: jest.fn(),
    deleteEmoji: jest.fn(),
  },
};

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (...args: unknown[]) => existsSync(...args),
  mkdirSync: jest.fn(),
  unlinkSync: (...args: any[]) => unlinkSync(...args),
}));

jest.mock('multer', () => {
  const multer: any = () => ({
    single: () => (req: any, _res: any, next: any) => {
      singleCalls(req.headers['x-user']);
      if (req.headers['x-multer-error']) return next(new Error('multer rejected'));
      if (req.headers['x-file']) {
        req.file = {
          path: '/tmp/emoji_deep.bin', filename: 'emoji_safe.png', originalname: 'evil.html',
          mimetype: String(req.headers['x-mime'] || 'image/png'), size: 123,
        };
      }
      next();
    },
  });
  multer.diskStorage = (cfg: any) => cfg;
  return multer;
});

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const id = req.headers['x-user'];
    if (!id) return res.status(401).json({ error: 'unauthenticated' });
    req.user = { id: String(id) };
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { write: () => (_req: any, _res: any, next: any) => next() } }));
jest.mock('../lib/permissions', () => ({
  PERMS: { MANAGE_SERVER: 1n },
  resolvePermissions: (...args: unknown[]) => resolvePermissions(...args),
  hasPermission: (...args: unknown[]) => hasPermission(...args),
}));
jest.mock('../db/repositories', () => repos);
jest.mock('../db/loader', () => ({ __esModule: true, default: { _pool: { query: jest.fn() } } }));
jest.mock('../lib/uploadReferenceSafety', () => ({
  hasLiveUploadReference: (...args: unknown[]) => hasLiveUploadReference(...args),
}));
jest.mock('../lib/uploadFileSafety', () => ({
  canonicalExtensionForMime: (mime: string) => mime === 'image/png' ? '.png' : mime === 'image/gif' ? '.gif' : undefined,
  checkMagicBytes: (...args: unknown[]) => checkMagicBytes(...args),
}));
jest.mock('../lib/httpRequestDrain', () => ({
  respondDiscardingBody: (_req: any, res: any, status: number, body: any) => res.status(status).json(body),
}));

import emojiRouter from '../routes/customEmoji';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/servers/:sid/emojis', emojiRouter);
  // deterministic error surface for thrown repository/storage failures
  a.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
  return a;
}

const SID = 'server-a';

describe('custom emoji production authority/storage behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    existsSync.mockReturnValue(true);
    checkMagicBytes.mockReturnValue(true);
    hasLiveUploadReference.mockResolvedValue(false);
    resolvePermissions.mockImplementation(async (...args: unknown[]) => args[0] === 'owner' ? 1n : 0n);
    hasPermission.mockImplementation((...args: unknown[]) => args[0] === 1n);
    repos.Members.findOne.mockImplementation(async (uid: string, sid: string) => uid === 'member' && sid === SID ? { userId: uid, serverId: sid } : null);
    repos.Members.findByUser.mockResolvedValue([]);
    repos.Servers.findByIds.mockResolvedValue([]);
    repos.ServerAssets.findEmojisSorted.mockResolvedValue([]);
    repos.ServerAssets.findEmojiByServerAndName.mockResolvedValue(null);
    repos.ServerAssets.insertEmoji.mockImplementation(async (row: any) => row);
    repos.ServerAssets.findEmojiByIdAndServer.mockResolvedValue(null);
    repos.ServerAssets.deleteEmoji.mockResolvedValue(undefined);
  });

  it('GET requires current server membership', async () => {
    expect((await request(app()).get(`/api/servers/${SID}/emojis`).set('x-user', 'stranger')).status).toBe(403);
    const ok = await request(app()).get(`/api/servers/${SID}/emojis`).set('x-user', 'member');
    expect(ok.status).toBe(200);
    expect(repos.ServerAssets.findEmojisSorted).toHaveBeenCalledWith(SID);
  });

  it('/all returns empty without memberships and enriches multiple servers without N+1 server lookup', async () => {
    let r = await request(app()).get(`/api/servers/${SID}/emojis/all`).set('x-user', 'member');
    expect(r.status).toBe(200); expect(r.body).toEqual([]);

    repos.Members.findByUser.mockResolvedValue([{ serverId: 's1' }, { serverId: 's2' }] as any);
    repos.Servers.findByIds.mockResolvedValue([{ _id: 's1', name: 'One', icon: '1' }] as any);
    repos.ServerAssets.findEmojisSorted.mockImplementation(async (sid: string) => [{ _id: sid, name: sid }]);
    r = await request(app()).get(`/api/servers/${SID}/emojis/all`).set('x-user', 'member');
    expect(repos.Servers.findByIds).toHaveBeenCalledTimes(1);
    expect(repos.Servers.findByIds).toHaveBeenCalledWith(['s1', 's2']);
    expect(r.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: 's1', serverName: 'One', serverIcon: '1' }),
      expect.objectContaining({ _id: 's2', serverName: 'Unknown', serverIcon: '🌐' }),
    ]));
  });

  it('rejects upload authorization before Multer consumes the body', async () => {
    const r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'member').set('x-file', '1').send({ name: 'x' });
    expect(r.status).toBe(403);
    expect(singleCalls).not.toHaveBeenCalled();
  });

  it('maps Multer rejection and missing file to 400', async () => {
    let r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').set('x-multer-error', '1').send({ name: 'x' });
    expect(r.status).toBe(400); expect(r.body.error).toContain('multer rejected');
    r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').send({ name: 'x' });
    expect(r.status).toBe(400); expect(r.body.error).toContain('No file');
  });

  it('rejects magic-byte mismatch and invalid normalized names while cleaning disk', async () => {
    checkMagicBytes.mockReturnValueOnce(false);
    let r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').set('x-file', '1').send({ name: 'safe' });
    expect(r.status).toBe(400); expect(unlinkSync).toHaveBeenCalledWith('/tmp/emoji_deep.bin');

    unlinkSync.mockClear();
    r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').set('x-file', '1').send({ name: '   ' });
    expect(r.status).toBe(400); expect(unlinkSync).toHaveBeenCalledWith('/tmp/emoji_deep.bin');
  });

  it('normalizes names, rejects duplicate, and rolls file back when duplicate lookup fails', async () => {
    repos.ServerAssets.findEmojiByServerAndName.mockResolvedValueOnce({ _id: 'dup' } as any);
    let r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').set('x-file', '1').send({ name: '  Cool Face!! ' });
    expect(r.status).toBe(409);
    expect(repos.ServerAssets.findEmojiByServerAndName).toHaveBeenCalledWith(SID, 'cool_face__');
    expect(unlinkSync).toHaveBeenCalled();

    unlinkSync.mockClear();
    repos.ServerAssets.findEmojiByServerAndName.mockRejectedValueOnce(new Error('db lookup down'));
    r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').set('x-file', '1').send({ name: 'good' });
    expect(r.status).toBe(500);
    expect(unlinkSync).toHaveBeenCalledWith('/tmp/emoji_deep.bin');
  });

  it('successful upload persists canonical server/url/uploader rather than original extension', async () => {
    const r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').set('x-file', '1').send({ name: 'Good Emoji' });
    expect(r.status).toBe(200);
    expect(repos.ServerAssets.insertEmoji).toHaveBeenCalledWith(expect.objectContaining({
      serverId: SID, name: 'good_emoji', url: '/uploads/emojis/emoji_safe.png', uploadedBy: 'owner',
    }));
    expect(String((repos.ServerAssets.insertEmoji as jest.Mock).mock.calls[0][0].url)).not.toContain('.html');
  });

  it('DB insert failure rolls back unowned file; cleanup failure does not mask original DB failure', async () => {
    repos.ServerAssets.insertEmoji.mockRejectedValueOnce(new Error('insert failed'));
    unlinkSync.mockImplementationOnce(() => { throw new Error('cleanup denied'); });
    const r = await request(app()).post(`/api/servers/${SID}/emojis`).set('x-user', 'owner').set('x-file', '1').send({ name: 'good' });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('insert failed');
  });

  it('delete resolves canonical server-scoped row before mutation', async () => {
    let r = await request(app()).delete(`/api/servers/${SID}/emojis/e1`).set('x-user', 'owner');
    expect(r.status).toBe(404);
    expect(repos.ServerAssets.findEmojiByIdAndServer).toHaveBeenCalledWith('e1', SID);
    expect(repos.ServerAssets.deleteEmoji).not.toHaveBeenCalled();

    repos.ServerAssets.findEmojiByIdAndServer.mockResolvedValueOnce({ _id: 'e1', serverId: SID, url: '/uploads/emojis/e1.png' } as any);
    repos.ServerAssets.deleteEmoji.mockRejectedValueOnce(new Error('delete failed'));
    r = await request(app()).delete(`/api/servers/${SID}/emojis/e1`).set('x-user', 'owner');
    expect(r.status).toBe(500);
    expect(hasLiveUploadReference).not.toHaveBeenCalled();
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('delete preserves shared physical object and deletes only when last live reference is gone', async () => {
    repos.ServerAssets.findEmojiByIdAndServer.mockResolvedValue({ _id: 'e1', serverId: SID, url: '/uploads/emojis/e1.png' } as any);
    hasLiveUploadReference.mockResolvedValueOnce(true);
    let r = await request(app()).delete(`/api/servers/${SID}/emojis/e1`).set('x-user', 'owner');
    expect(r.status).toBe(200); expect(unlinkSync).not.toHaveBeenCalled();
    expect(hasLiveUploadReference).toHaveBeenCalledWith(expect.anything(), 'uploads/emojis/e1.png');

    hasLiveUploadReference.mockResolvedValueOnce(false);
    r = await request(app()).delete(`/api/servers/${SID}/emojis/e1`).set('x-user', 'owner');
    expect(r.status).toBe(200); expect(unlinkSync).toHaveBeenCalled();
  });

  it('reference lookup uncertainty fails closed for physical deletion but DB delete still succeeds', async () => {
    repos.ServerAssets.findEmojiByIdAndServer.mockResolvedValue({ _id: 'e1', serverId: SID, url: '/uploads/emojis/../../secret.txt' } as any);
    hasLiveUploadReference.mockRejectedValueOnce(new Error('reference DB down'));
    const r = await request(app()).delete(`/api/servers/${SID}/emojis/e1`).set('x-user', 'owner');
    expect(r.status).toBe(200);
    expect(unlinkSync).not.toHaveBeenCalled();
    expect(hasLiveUploadReference).toHaveBeenCalledWith(expect.anything(), 'uploads/emojis/secret.txt');
  });
});
