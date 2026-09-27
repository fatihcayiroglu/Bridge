// server/tests/voiceMessages.test.ts
// Tests for POST /api/voice-messages (upload, validation, membership check)
import type { Request, Response, NextFunction } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import path from 'path';
const os   = require('os');
const fs   = require('fs');

// Fixture dosyasi icin gecici dizin. ROTA buraya YAZMAZ; rota kendi
// `server/uploads` dizinine yazar (asagiya bak).
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vm-test-'));

// ── KALDIRILAN MULTER MOCK'U ───────────────────────────────────────────────
// Burada eskiden `jest.mock('multer', ...)` vardi ve multer'i diskStorage'a
// ZORLUYORDU. Iki ayri sekilde YANLISTI:
//
//  1) `memoryStorage` FORWARD EDILMIYORDU. Rota guvenlik gerekcesiyle
//     `multer.memoryStorage()` kullanmaya gecince mock'ta o alan olmadigi
//     icin sadece "TypeError: multer_1.default.memoryStorage is not a
//     function" firlatiyordu ve SUIT HIC CALISMIYORDU. Yani bu dosyadaki 14
//     testin tamami sessizce OLU idi.
//
//  2) Duzeltilmis olsa bile `{...opts, storage}` rotanin secimini EZIYORDU.
//     Rotanin bellek depolamayi secme NEDENI bir guvenlik ozelligi:
//     "kanal yetkisi dogrulanmadan diske dosya YAZILMAZ". diskStorage'a
//     zorlamak, test edilmesi gereken ozelligi tam olarak ORTADAN
//     KALDIRIYORDU.
//
// Gercek multer kullanilir; rotanin yazdigi dosyalar afterAll'da temizlenir.
const ROUTE_UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
function voiceFilesOnDisk() {
  try { return fs.readdirSync(ROUTE_UPLOAD_DIR).filter((f: string) => /^vm_\d+_/.test(f)); }
  catch { return []; }
}

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try {
      const decoded = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!');
      req.user = { id: decoded.id, username: decoded.username, displayName: decoded.displayName, avatarColor: decoded.avatarColor };
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
const router  = require('../routes/voicemsg');

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!');
      req.user = { id: decoded.id, username: decoded.username, displayName: decoded.displayName, avatarColor: decoded.avatarColor, v: 0 };
    } catch {}
  }
  next();
});
app.use('/api/voice-messages', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

function token(id: string, extra = {}) {
  return jwt.sign({ id, username: 'speaker', displayName: 'Speaker', avatarColor: '#abc', v: 0, ...extra }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

const USER_ID   = 'vmu1';
const SERVER_ID = 'vsrv1';
const CHAN_ID   = 'vch1';

// Create a tiny valid webm-like file (not a real webm, but passes multer's size check)
const FAKE_AUDIO = path.join(UPLOAD_DIR, 'fake.webm');

beforeAll(async () => {
  fs.writeFileSync(FAKE_AUDIO, Buffer.alloc(512, 0));
  // ── EKSIK FIXTURE: `servers` SATIRI ───────────────────────────────────────
  // `resolvePermissionResolution` ILK IS olarak `Servers.findById(serverId)`
  // yapar ve satir yoksa `missing_server` -> 0 izin doner. Bu fixture'da sunucu
  // satiri HIC yoktu; rota kanonik izin denetimine baglandiginda (VIEW_CHANNELS
  // + SEND_MESSAGES + ATTACH_FILES) mutlu yol da 403 olacakti. Suit zaten
  // multer mock'u yuzunden hic calismadigi icin bu gorunmedi.
  //
  // NOT: sahiplik VERILMEZ (ownerId baskasi). Boylece testler `ownerId ===
  // userId` kestirmesini degil, GERCEK uye izin cozumunu (DEFAULT_PERMISSIONS)
  // olcer.
  await mockDb.servers.insert({
    _id: SERVER_ID, name: 'Voice Test Server', icon: '🎙️',
    ownerId: 'baska-sahip', createdAt: Date.now(),
  });
  // `roles` PostgreSQL'de JSONB'dir; `pg` surucusu GERCEK DIZI dondurur.
  // Burada string ('[]') yazmak `resolvePermissionResolution` icinde
  // `roleIds.length === 2` (stringin uzunlugu!) yapar, kod rol dalina girer,
  // hicbir rol bulunamaz ve izinler DEFAULT_PERMISSIONS yerine 0 cikar.
  // Yani uye, sessizce IZINSIZ bir kullaniciya donusur.
  await mockDb.members.insert({ userId: USER_ID, serverId: SERVER_ID, roles: [], joinedAt: Date.now() });
  await mockDb.channels.insert({ _id: CHAN_ID, serverId: SERVER_ID, name: 'general', type: 'text', createdAt: Date.now() });
});

afterAll(() => {
  // Fixture temp dizini
  try { fs.rmSync(UPLOAD_DIR, { recursive: true }); } catch {}
  // Rotanin GERCEKTEN yazdigi dosyalar (yalniz bu testin urettigi ad kalibi).
  for (const f of voiceFilesOnDisk()) {
    try { fs.unlinkSync(path.join(ROUTE_UPLOAD_DIR, f)); } catch {}
  }
});

describe('POST /api/voice-messages', () => {
  it('uploads a voice message and creates a chat message', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID)
      .field('duration', '5');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.msg).toBeDefined();
    expect(res.body.msg.type).toBe('voice_message');
    expect(res.body.msg.fileUrl).toMatch(/\/uploads\//);
    expect(res.body.vmId).toBeDefined();
  });

  it('stores the voice message in db.voiceMessages', async () => {
    const vms = await mockDb.voiceMessages.find({ channelId: CHAN_ID });
    expect(vms.length).toBeGreaterThanOrEqual(1);
    expect(vms[0].userId).toBe(USER_ID);
  });

  it('stores a corresponding message in db.messages', async () => {
    const msgs = await mockDb.messages.find({ channelId: CHAN_ID, type: 'voice_message' });
    expect(msgs.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects upload without audio file', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no audio/i);
  });

  it('rejects missing channelId', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channelId/i);
  });

  it('rejects missing serverId', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID);
    expect(res.status).toBe(400);
  });

  it('rejects non-members', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token('outsider')}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(403);
    // Rota UYELIK ile IZIN arasinda ayrim yapmaz: her iki durumda da ayni
    // 'Missing channel permissions' doner. Bu KASITLI — farkli mesaj, cagirana
    // "bu sunucuda uye var mi" oraculu verirdi. Iddia buna hizalandi.
    expect(res.body.error).toMatch(/missing channel permissions/i);
  });

  it('accepts duration=0 (default)', async () => {
    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);
    expect(res.status).toBe(200);
    const vms = await mockDb.voiceMessages.find({ channelId: CHAN_ID, userId: USER_ID });
    const latest = vms[vms.length - 1];
    expect(latest.duration).toBe(0);
  });

  it.each(['-1', '1.5', '5x', '9007199254740992'])('rejects malformed duration=%s before writing bytes', async (duration) => {
    const before = voiceFilesOnDisk().length;
    const res = await request(app).post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID).field('serverId', SERVER_ID).field('duration', duration);
    expect(res.status).toBe(400);
    expect(voiceFilesOnDisk().length).toBe(before);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/voice-messages');
    expect(res.status).toBe(401);
  });

  // ── ROTANIN ILAN ETTIGI GUVENLIK OZELLIGI ────────────────────────────────
  // routes/voicemsg.ts: "diskStorage kullanilirsa channel/server yetkisi
  // dogrulanmadan once saldirgan diske dosya yazdirabilir." Bu iddia simdiye
  // kadar HIC olculmemisti (suit calismiyordu). Olculur hale getiriliyor.
  it('yetkisiz yukleme DISKE HIC dosya yazmaz', async () => {
    const before = voiceFilesOnDisk().length;

    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token('outsider')}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);

    expect(res.status).toBe(403);
    expect(voiceFilesOnDisk().length).toBe(before);
  });

  it('kanal baska bir sunucuya aitken reddeder (locator karistirma)', async () => {
    // channelId gercek ama serverId BASKA bir sunucu: canonical resolver
    // `findByIdAndServer` bunu cozmeli, cagiranin eslestirmesine guvenmemeli.
    const before = voiceFilesOnDisk().length;

    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { contentType: 'audio/webm' })
      .field('channelId', CHAN_ID)
      .field('serverId', 'baska-sunucu');

    expect(res.status).toBe(403);
    expect(voiceFilesOnDisk().length).toBe(before);
  });

  it('izin verilmeyen MIME turu 415 doner ve diske yazmaz', async () => {
    const before = voiceFilesOnDisk().length;

    const res = await request(app)
      .post('/api/voice-messages')
      .set('Authorization', `Bearer ${token(USER_ID)}`)
      .attach('audio', FAKE_AUDIO, { filename: 'evil.exe', contentType: 'application/x-msdownload' })
      .field('channelId', CHAN_ID)
      .field('serverId', SERVER_ID);

    expect(res.status).toBe(415);
    expect(voiceFilesOnDisk().length).toBe(before);
  });
});

// ══════════════════════════════════════════════════════════════
// GET /api/voice-messages/:vmId/transcript
// ══════════════════════════════════════════════════════════════
describe('GET /api/voice-messages/:vmId/transcript', () => {
  let vmId: string;

  beforeAll(async () => {
    // Insert a voice message directly to test transcript endpoint
    const vm = await mockDb.voiceMessages.insert({
      _id: 'vm-test-1',
      channelId: CHAN_ID,
      serverId: SERVER_ID,
      userId: USER_ID,
      url: '/uploads/vm_test.webm',
      duration: 10,
      createdAt: Date.now(),
    });
    vmId = vm._id;
  });

  it('transcript yokken pending döner', async () => {
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`)
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBeNull();
    expect(res.body.status).toBe('pending');
  });

  it('transcript varken done döner', async () => {
    await mockDb.voiceMessages.update({ _id: vmId }, { $set: { transcript: 'Merhaba dünya' } });
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`)
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBe('Merhaba dünya');
    expect(res.body.status).toBe('done');
  });

  it('mevcut olmayan vmId 404 döner', async () => {
    const res = await request(app)
      .get('/api/voice-messages/nonexistent/transcript')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(404);
  });

  it('üye olmayan kullanıcı 403 alır', async () => {
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`)
      .set('Authorization', `Bearer ${token('outsider-user')}`);
    expect(res.status).toBe(403);
  });

  it('token olmadan 401 döner', async () => {
    const res = await request(app)
      .get(`/api/voice-messages/${vmId}/transcript`);
    expect(res.status).toBe(401);
  });
});
