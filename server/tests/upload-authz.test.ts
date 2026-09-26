// server/tests/upload-authz.test.ts
// ÖZEL EK BAYTLARININ YETKİLENDİRMESİ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (canlı üründe ölçüldü)
// ════════════════════════════════════════════════════════════════════════════
// A ÖZEL bir kanala dosya yükledi; B o kanalı göremeyen bir sunucu üyesi:
//     GET /api/channels/<özel>/messages -> 403   (doğru)
import type { Request, Response, NextFunction } from 'express';
//     GET /api/channels/<özel>/files    -> 403   (doğru)
//     GET /uploads/<uuid>.txt           -> 200   <-- SIZINTI
//
// LİSTELEME yetkilendiriliyordu ama BAYTLAR yetkilendirilmiyordu. Tek koruma
// URL'nin tahmin edilemezliğiydi; bu bir gizlilik modeli DEĞİLDİR (URL
// paylaşılır, loglanır, Referer ile sızar).
//
// YAPISAL SINIR: mesaj ekleri `uploads/` KÖKÜNE yazılır; avatar/emoji/sticker
// gibi HERKESE AÇIK varlıklar ALT DİZİNLERDEDİR. Guard yalnız kökü korur.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

const mockQuery = jest.fn();
// `pool.query` PROMISE dondurmelidir: middleware yetim sorgusunda `.catch()`
// zincirler. Duz nesne donen bir mock `.catch is not a function` firlatir ve
// fail-closed yola dusurur — bu bir TEST kusuru olurdu, urun kusuru degil.
jest.mock('../db/postgres/pool', () => ({ pool: { query: async (...a: unknown[]) => mockQuery(...a) } }));

const mockTokenVersion = jest.fn();
jest.mock('./..\/middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  getTokenVersion: (...a: unknown[]) => mockTokenVersion(...a),
}));

const mockCanView = jest.fn();
jest.mock('../lib/permissions', () => ({
  ...jest.requireActual('../lib/permissions'),
  canViewChannel: (...a: unknown[]) => mockCanView(...a),
}));

let mockPrivateProvider = 'local';
const mockStorageReadFile = jest.fn();
jest.mock('../lib/storageAdapter', () => ({
  ...jest.requireActual('../lib/storageAdapter'),
  getPrivateStorageProvider: () => mockPrivateProvider,
  getPrivateStorageAdapter: () => ({ readFile: (...a: unknown[]) => mockStorageReadFile(...a) }),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import { uploadAuthz, _resetUploadAuthzCache } from '../middleware/uploadAuthz';

const tok      = (id: string, v = 0) => jwt.sign({ id, username: id, v }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
const mediaTok = (id: string, v = 0) => jwt.sign({ id, username: id, v, purpose: 'media' }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '7d' });

const PRIVATE_FILE = '/uploads/gizli-ek.txt';
const PUBLIC_ASSET = '/uploads/emojis/parti.png';

function app() {
  const a = express();
  // Gercek uygulama cookieParser kullanir (app/createApp.ts); medya cerezi
  // yolunun testte de calismasi icin ayni katman kurulur.
  a.use(cookieParser());
  a.use('/uploads', uploadAuthz());
  // Guard'i GECEN istek "servis edildi" sayilir.
  a.use('/uploads', (_req: Request, res: Response) => res.status(200).send('BAYTLAR'));
  return a;
}

/** `messages` -> `dm_messages` -> `group_dm_messages` -> `uploads` sirasi. */
function ownerIsChannel() {
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM messages/.test(sql)) return { rows: [{ serverId: 'srv-1', channelId: 'ch-gizli' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}
function ownerIsNone() {
  mockQuery.mockReset();
  mockQuery.mockImplementation(() => ({ rows: [], rowCount: 0 }));
}
function ownerIsGdm(memberIds: string[]) {
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: string, params: unknown[]) => {
    if (/FROM group_dm_messages/.test(sql)) return { rows: [{ groupId: 'g-1' }], rowCount: 1 };
    if (/FROM group_dm_members/.test(sql)) {
      const uid = String(params[1]);
      return memberIds.includes(uid) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  _resetUploadAuthzCache();
  mockCanView.mockReset();
  mockTokenVersion.mockReset();
  mockTokenVersion.mockResolvedValue(0);   // varsayilan: iptal edilmemis
  mockPrivateProvider = 'local';
  mockStorageReadFile.mockReset();
});

// ════════════════════════════════════════════════════════════════════════════
describe('ÖZEL KANAL EKİ — tam URL bilinse bile', () => {
  it('YETKİLİ kullanıcı baytları ALIR (pozitif kontrol)', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);

    const res = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-a')}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe('BAYTLAR');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('attachment');
  });

  it('YETKİSİZ üye TAM URL ile bile REDDEDİLİR', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(false);

    const res = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-b')}`);

    expect(res.status).toBe(403);
    expect(res.text).not.toContain('BAYTLAR');
  });

  it('aynı fiziksel dosyanın birden fazla canlı referansında herhangi bir erişilebilir owner yeterlidir', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM messages/.test(sql)) return {
        rows: [
          { serverId: 'srv-1', channelId: 'ch-gizli' },
          { serverId: 'srv-1', channelId: 'ch-erisimli' },
        ],
        rowCount: 2,
      };
      return { rows: [], rowCount: 0 };
    });
    mockCanView.mockImplementation(async (_uid: string, _sid: string, channelId: string) => channelId === 'ch-erisimli');

    const res = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-a')}`);

    expect(res.status).toBe(200);
    expect(mockCanView).toHaveBeenCalledWith('user-a', 'srv-1', 'ch-gizli');
    expect(mockCanView).toHaveBeenCalledWith('user-a', 'srv-1', 'ch-erisimli');
  });

  it('KİMLİKSİZ istek reddedilir', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);

    const res = await request(app()).get(PRIVATE_FILE);

    expect(res.status).toBe(401);
    expect(res.text).not.toContain('BAYTLAR');
  });

  it('MEDYA ÇEREZİ ile de yetkilendirilir (<img> yolu çalışır)', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);

    const res = await request(app()).get(PRIVATE_FILE).set('Cookie', `bridge_media=${mediaTok('user-a')}`);

    expect(res.status).toBe(200);
  });

  it('GEÇERSİZ çerez kimlik SAYILMAZ', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);

    const res = await request(app()).get(PRIVATE_FILE).set('Cookie', 'bridge_media=sahte-jeton');

    expect(res.status).toBe(401);
  });

  it('SÜRESİ DOLMUŞ medya çerezi 401 döner (yenileme için tetikleyici)', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    const expired = jwt.sign(
      { id: 'user-a', username: 'user-a', v: 0, purpose: 'media' },
      'test-jwt-secret-long-enough-32chars!!',
      { expiresIn: -1 },
    );

    const res = await request(app()).get(PRIVATE_FILE).set('Cookie', `bridge_media=${expired}`);

    expect(res.status).toBe(401);
    expect(res.text).not.toContain('BAYTLAR');
  });

  it('yetki çözümlenemezse FAIL-CLOSED (dosya servis EDİLMEZ)', async () => {
    ownerIsChannel();
    mockCanView.mockRejectedValue(new Error('izin altyapısı çöktü'));

    const res = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-a')}`);

    expect(res.status).toBe(403);
    expect(res.text).not.toContain('BAYTLAR');
  });
});

describe('GRUP DM EKİ — konuşma üyeliğine bağlıdır', () => {
  it('ÜYE alır', async () => {
    ownerIsGdm(['user-a']);
    const res = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-a')}`);
    expect(res.status).toBe(200);
  });

  it('ÜYE OLMAYAN reddedilir', async () => {
    ownerIsGdm(['user-a']);
    const res = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('yabanci')}`);
    expect(res.status).toBe(403);
  });
});

describe('HERKESE AÇIK VARLIKLAR bozulmaz', () => {
  it('alt dizindeki varlık kimliksiz servis edilir (emoji/avatar/sticker)', async () => {
    ownerIsNone();
    const res = await request(app()).get(PUBLIC_ASSET);

    expect(res.status).toBe(200);
    // Guard alt dizinlere HIC bakmaz: veritabanina bile gitmez.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('hiçbir mesaja bağlı OLMAYAN kök dosya yalnız YÜKLEYENE açıktır', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM uploads/.test(sql)) return { rows: [{ userId: 'user-a' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const mine = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-a')}`);
    expect(mine.status).toBe(200);
    const uploadLookup = mockQuery.mock.calls.find(([sql]) => /FROM uploads/.test(String(sql)));
    expect(String(uploadLookup?.[0])).toContain('"userId"');

    _resetUploadAuthzCache();
    const other = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-b')}`);
    expect(other.status).toBe(403);
  });

  it('authority ilişkisi cachelenmez: orphan -> kanal bağlanması anında görünür', async () => {
    let linked = false;
    mockQuery.mockReset();
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM messages/.test(sql) && linked) return { rows: [{ serverId: 'srv-1', channelId: 'ch-gizli' }], rowCount: 1 };
      if (/FROM uploads/.test(sql)) return { rows: [{ userId: 'user-a' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    mockCanView.mockResolvedValue(true);

    const before = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-b')}`);
    expect(before.status).toBe(403);

    linked = true;
    const after = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-b')}`);
    expect(after.status).toBe(200);
  });
});

describe('REMOTE protected attachment proxy', () => {
  it('yetkili kullanıcıya provider public URL yerine Bridge üzerinden byte stream verir', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockPrivateProvider = 'r2';
    mockStorageReadFile.mockResolvedValue({
      body: Readable.from(Buffer.from('REMOTE-BYTES')),
      contentType: 'text/plain',
      contentLength: 12,
      acceptRanges: 'bytes',
    });

    const res = await request(app()).get(PRIVATE_FILE).set('Authorization', `Bearer ${tok('user-a')}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe('REMOTE-BYTES');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(mockStorageReadFile).toHaveBeenCalledWith('uploads/gizli-ek.txt', undefined);
  });

  it('Range isteğini remote adaptera sınırlandırılmış biçimde iletir', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockPrivateProvider = 's3';
    mockStorageReadFile.mockResolvedValue({
      body: Readable.from(Buffer.from('BYTES')),
      contentType: 'video/mp4',
      contentLength: 5,
      contentRange: 'bytes 5-9/10',
      acceptRanges: 'bytes',
    });

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Authorization', `Bearer ${tok('user-a')}`)
      .set('Range', 'bytes=5-9');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 5-9/10');
    expect(mockStorageReadFile).toHaveBeenCalledWith('uploads/gizli-ek.txt', { range: 'bytes=5-9' });
  });

  it('çoklu/geçersiz Range providera gönderilmeden 416 olur', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockPrivateProvider = 'r2';

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Authorization', `Bearer ${tok('user-a')}`)
      .set('Range', 'bytes=0-1,4-5');

    expect(res.status).toBe(416);
    expect(mockStorageReadFile).not.toHaveBeenCalled();
  });

  it('provider geçerli biçimli fakat karşılanamayan Range için 416 döndürür', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockPrivateProvider = 's3';
    mockStorageReadFile.mockRejectedValue({
      name: 'InvalidRange',
      $metadata: { httpStatusCode: 416 },
    });

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Authorization', `Bearer ${tok('user-a')}`)
      .set('Range', 'bytes=999999-');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */*');
    expect(mockStorageReadFile).toHaveBeenCalledWith('uploads/gizli-ek.txt', { range: 'bytes=999999-' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MEDYA JETONU KAPSAM AYRIMI', () => {
  // CANLI OLCUM: `makeMediaToken` eklendiginde `verifyToken` YALNIZCA imzayi
  // dogruluyordu. Medya jetonu ayni sirla imzalandigi ve 7 GUN yasadigi icin
  // API'ye tam erisim saglayan uzun omurlu bir kimlige donusmustu
  // (/api/servers, /api/me, /api/friends hepsi 200 donuyordu).
  //
  // Artik ayrim IKI YONLUDUR ve bu testler onu sabitler.

  it('MEDYA jetonu Authorization basligi olarak KABUL EDILMEZ', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Authorization', `Bearer ${mediaTok('user-a')}`);

    expect(res.status).toBe(401);
    expect(res.text).not.toContain('BAYTLAR');
  });

  it('NORMAL erisim jetonu medya CEREZI yerine gecemez', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Cookie', `bridge_media=${tok('user-a')}`);   // purpose YOK

    expect(res.status).toBe(401);
  });

  it('IPTAL (tokenVersion) medya yolunda da uygulanir', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockTokenVersion.mockResolvedValue(3);               // sunucu surumu 3

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Cookie', `bridge_media=${mediaTok('user-a', 0)}`);   // jeton surumu 0

    expect(res.status).toBe(401);
  });

  it.each(['3', '03', '3e0', ' 3 '])('canonical olmayan tokenVersion claimini REDDEDER: %s', async (v) => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockTokenVersion.mockResolvedValue(3);
    const malformed = jwt.sign({ id: 'user-a', username: 'user-a', v, purpose: 'media' }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '7d' });
    const res = await request(app()).get(PRIVATE_FILE).set('Cookie', `bridge_media=${malformed}`);
    expect(res.status).toBe(401);
  });

  it('POZITIF: dogru surumlu medya jetonu calisir', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockTokenVersion.mockResolvedValue(3);

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Cookie', `bridge_media=${mediaTok('user-a', 3)}`);

    expect(res.status).toBe(200);
  });

  it('kullanici SILINMISSE erisim reddedilir (fail-closed)', async () => {
    ownerIsChannel(); mockCanView.mockResolvedValue(true);
    mockTokenVersion.mockResolvedValue(null);

    const res = await request(app()).get(PRIVATE_FILE)
      .set('Cookie', `bridge_media=${mediaTok('user-a')}`);

    expect(res.status).toBe(401);
  });
});
