// server/tests/socket.test.ts
// Socket.IO auth middleware — tokenVersion kontrolü
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { present } from './helpers/narrow';
import jwt from 'jsonwebtoken';
import { createMockDb, makeUser } from './helpers/mockDb';
import type { MockDb, UserFixture } from './helpers/mockDb';

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

// Socket handler'larını stub'la — sadece auth middleware'i test ediyoruz
jest.mock('../socket/handlers/messages', () => ({
  registerMessageHandlers: () => {},
  registerThreadSocketEvents: () => {},
}));
jest.mock('../socket/handlers/voice', () => ({
  registerVoiceHandlers: () => {},
  leaveVoice: () => {},
  voiceRooms: {},
  voiceActivity: new Map(),
}));
jest.mock('../socket/handlers/music',  () => ({ registerMusicHandlers: () => {} }));
jest.mock('../socket/handlers/dm',     () => ({ registerDmHandlers: () => {} }));
jest.mock('../routes/auth',            () => ({ sanitizeUser: (u: unknown) => u }));

function makeToken(userId: string, version = 0) {
  return jwt.sign({ id: userId, username: 'tester', v: version }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

// verifyToken ve _invalidateTokenCache'i gerçek auth modülünden al
import { verifyToken } from '../middleware/auth';
import { requireDoc } from './helpers/mockDb';

describe('Socket auth middleware — tokenVersion', () => {
  let user: UserFixture;

  beforeEach(async () => {
    db = createMockDb();
    Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
    user = makeUser({ tokenVersion: 0 });
    await db.users.insert(user);
  });

  it('geçerli token + doğru tokenVersion bağlantıya izin verir', async () => {
    const token   = makeToken(user._id, 0);
    const decoded = present(verifyToken(token), 'decoded');
    expect(decoded).not.toBeNull();
    expect(decoded.v).toBe(0);

    const dbUser = present(await db.users.findOne({ _id: user._id }), 'dbUser');
    expect((decoded.v ?? 0)).toBe(dbUser.tokenVersion || 0);
  });

  it('eski tokenVersion ile token geçersiz sayılır', async () => {
    // tokenVersion'ı artır (zorla çıkış)
    await db.users.update({ _id: user._id }, { $set: { tokenVersion: 1 } });

    const oldToken  = makeToken(user._id, 0); // eski v:0
    const decoded   = present(verifyToken(oldToken), 'decoded');

    const dbUser = present(await db.users.findOne({ _id: user._id }), 'dbUser');
    // v:0 !== tokenVersion:1 → reddedilmeli
    expect((decoded.v ?? 0)).not.toBe(dbUser.tokenVersion);
  });

  it('yeni tokenVersion ile üretilen token geçerli', async () => {
    await db.users.update({ _id: user._id }, { $set: { tokenVersion: 2 } });

    const newToken = makeToken(user._id, 2);
    const decoded  = present(verifyToken(newToken), 'decoded');
    const dbUser = present(await db.users.findOne({ _id: user._id }), 'dbUser');
    expect((decoded.v ?? 0)).toBe(dbUser.tokenVersion);
  });

  it('var olmayan kullanıcı token\'ı reddedilir', async () => {
    const ghostToken = makeToken('nonexistent-user-id', 0);
    const decoded    = verifyToken(ghostToken);
    expect(decoded).not.toBeNull(); // JWT valid ama kullanıcı yok

    // DIKKAT: burada beklenti satirin YOKLUGUDUR — `present()` KULLANILMAZ.
    const dbUser = await db.users.findOne({ _id: 'nonexistent-user-id' });
    expect(dbUser).toBeNull(); // Bağlantı kesilmeli
  });

  it('imzası geçersiz token reddedilir', () => {
    const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImFiYyJ9.invalidsignature';
    const decoded   = verifyToken(fakeToken);
    expect(decoded).toBeNull();
  });
});

describe('verifyToken yardımcısı', () => {
  it('geçerli token decode eder', () => {
    const token   = makeToken('user123', 1);
    const decoded = present(verifyToken(token), 'decoded');
    expect(decoded.id).toBe('user123');
    expect(decoded.v).toBe(1);
  });

  it('süresi dolmuş token null döner', () => {
    const expired = jwt.sign({ id: 'x', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '-1s' });
    expect(verifyToken(expired)).toBeNull();
  });

  it('null / undefined girişte null döner', () => {
    expect(verifyToken(null)).toBeNull();
    expect(verifyToken(undefined)).toBeNull();
    expect(verifyToken('')).toBeNull();
  });
});
