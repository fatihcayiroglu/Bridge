// server/tests/invite-security.test.ts
// Faz 10.10 — Davet (invite) sözleşmesinin güvenlik ve yan etki kilidi.
//
// MİMARİ KARAR: repository katmanı MOCK'LANMAZ. Test edilen davranış zaten
// repository'de yaşıyor (`Invites.isValid` sıralaması, `incrementUses`,
// `Members.insert` tekilliği). Bu yüzden yalnız EN ALT katman — `db/loader` —
// mock DB ile değiştirilir; InviteRepository/MemberRepository/ServerRepository
// GERÇEK kodla çalışır.
//
// KAYNAKTAN DOĞRULANMIŞ SÖZLEŞME (routes/servers/invites.ts):
//   POST /            → auth + ÜYELİK yeterli (sahiplik DEĞİL) + sunucu var mı
//   POST /:code/use   → auth + assertInvite + "zaten üye" koruması
//   GET  /:code/qr*   → auth + aynı assertInvite yolu
//
//   assertInvite → Invites.isValid sırası: (1) var mı (2) süre (3) maxUses
//                  yok → 404 · geçersiz ama var → 410
//
// DESTEKLENMEYEN (Faz 10.10'da UYDURULMAZ):
//   davet iptali/silme ucu YOK · davet listeleme ucu YOK

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

jest.mock('../middleware/rateLimit', () => ({
  limits: { servers: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

// Üye sayısı cache invalidasyonu davet sözleşmesinin parçası değil.
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import { stringOf } from './helpers/narrow';
import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');
import invitesRouter from '../routes/servers/invites';
import { Invites, Members } from '../db/repositories';
import type { MockDb, UserFixture } from './helpers/mockDb';
import { requireDoc } from './helpers/mockDb';

const SERVER_ID = 'srv-1';
const OTHER_SERVER_ID = 'srv-2';
const DAY_MS = 24 * 60 * 60 * 1000;

let app: express.Express;
let owner: UserFixture;
let member: UserFixture;
let outsider: UserFixture;
let joiner: UserFixture;

const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createInvite = (actor: string, body: Record<string, unknown>) =>
  request(app).post('/api/servers/invites').set('Authorization', `Bearer ${tok(actor)}`).send(body);

const useInvite = (actor: string, code: string) =>
  request(app).post(`/api/servers/invites/${code}/use`).set('Authorization', `Bearer ${tok(actor)}`);

/** Davet satırını doğrudan tohumlar — süre/kullanım durumlarını kurmak için. */
async function seedInvite(over: Record<string, unknown> = {}) {
  const row = {
    _id: 'inv-seed', code: 'seedcode', serverId: SERVER_ID, createdBy: owner._id,
    expiresAt: Date.now() + 7 * DAY_MS, maxUses: 0, uses: 0, ...over,
  };
  await db.invites.insert(row);
  return row;
}

const memberCount = async (userId: string, serverId: string) =>
  (await db.members.find({ userId, serverId })).length;

const usesOf = async (id: string) => (await db.invites.findOne({ _id: id }))?.uses;

beforeEach(async () => {
  const { createMockDb, makeUser } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  owner    = makeUser({ _id: 'user-owner',    username: 'owner' });
  member   = makeUser({ _id: 'user-member',   username: 'member' });
  outsider = makeUser({ _id: 'user-outsider', username: 'outsider' });
  joiner   = makeUser({ _id: 'user-joiner',   username: 'joiner' });
  for (const u of [owner, member, outsider, joiner]) await db.users.insert(u);

  await db.servers.insert({ _id: SERVER_ID, name: 'Test Sunucu', ownerId: owner._id, createdAt: Date.now() });
  await db.servers.insert({ _id: OTHER_SERVER_ID, name: 'Diger Sunucu', ownerId: outsider._id, createdAt: Date.now() });
  await Members.insert(owner._id, SERVER_ID);
  await Members.insert(member._id, SERVER_ID);
  await Members.insert(outsider._id, OTHER_SERVER_ID);

  app = express();
  app.use(express.json());
  app.use('/api/servers/invites', invitesRouter);
  // Beklenmeyen fırlatmalar 500 olarak görünsün — sessizce yutulmasın.
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
});

// ─────────────────────────────────────────────────────────────
// 10.1–10.5  OLUŞTURMA
// ─────────────────────────────────────────────────────────────
describe('davet oluşturma — yetki', () => {
  it('kimliksiz istek reddedilir ve davet OLUŞMAZ', async () => {
    const res = await request(app).post('/api/servers/invites').send({ serverId: SERVER_ID });

    expect(res.status).toBe(401);
    expect(await db.invites.find({})).toHaveLength(0);
  });

  it('ÜYE davet oluşturabilir (sahiplik GEREKMEZ)', async () => {
    const res = await createInvite(member._id, { serverId: SERVER_ID });

    expect(res.status).toBe(200);
    expect(typeof res.body.code).toBe('string');
    expect(res.body.serverName).toBe('Test Sunucu');

    const row = await requireDoc(db.invites, { code: res.body.code });
    expect(row.serverId).toBe(SERVER_ID);
    expect(row.createdBy).toBe(member._id);   // üye, sahip değil
    expect(row.uses).toBe(0);
    expect(row.maxUses).toBe(0);
    expect(row.expiresAt).toBeGreaterThan(Date.now());
  });

  it('ÜYE OLMAYAN davet oluşturamaz (403) ve satır yazılmaz', async () => {
    const res = await createInvite(outsider._id, { serverId: SERVER_ID });

    expect(res.status).toBe(403);
    expect(await db.invites.find({})).toHaveLength(0);
  });

  it('BAŞKA sunucunun üyesi olmak bu sunucuda yetki vermez', async () => {
    // outsider yalnız srv-2 üyesi; srv-1 için davet üretemez.
    expect((await createInvite(outsider._id, { serverId: SERVER_ID })).status).toBe(403);
    // Kendi sunucusunda ise üretebilir — kontrol sunucuya özgüdür.
    expect((await createInvite(outsider._id, { serverId: OTHER_SERVER_ID })).status).toBe(200);
  });

  it('maxUses yalnız non-negative safe integer kabul eder; coercion ile sınırsız davet üretilemez', async () => {
    // JSON cannot represent NaN/Infinity (they arrive as null); null is intentionally
    // equivalent to omitted because the OpenAPI field is nullable.
    const invalid: unknown[] = [-1, -0.5, 1.5, Number.MAX_SAFE_INTEGER + 1,
      '3', '3x', [2], { value: 2 }, true];

    for (const maxUses of invalid) {
      const res = await createInvite(member._id, { serverId: SERVER_ID, maxUses });
      expect([String(maxUses), res.status]).toEqual([String(maxUses), 400]);
    }
    expect(await db.invites.find({})).toHaveLength(0);

    const zero = await createInvite(member._id, { serverId: SERVER_ID, maxUses: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body.maxUses).toBe(0);

    const bounded = await createInvite(member._id, { serverId: SERVER_ID, maxUses: 3 });
    expect(bounded.status).toBe(200);
    expect(bounded.body.maxUses).toBe(3);
  });

  it('body\'deki sahte createdBy YETKİ KAYNAĞI değildir', async () => {
    const res = await createInvite(member._id, {
      serverId: SERVER_ID, createdBy: owner._id, userId: owner._id,
    });

    expect(res.status).toBe(200);
    const row = await requireDoc(db.invites, { code: res.body.code });
    expect(row.createdBy).toBe(member._id);      // daima kimliği doğrulanmış aktör
    expect(row.createdBy).not.toBe(owner._id);
  });

  it('bozuk/eksik serverId güvenle reddedilir (asla 500)', async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['eksik',    {}],
      ['boş',      { serverId: '' }],
      ['null',     { serverId: null }],
      ['yok',      { serverId: 'yok-boyle-sunucu' }],
      ['sayı',     { serverId: 123 }],
      ['dizi',     { serverId: ['a', 'b'] }],
    ];

    for (const [label, body] of bodies) {
      const res = await createInvite(member._id, body);

      expect([label, res.status]).toEqual([label, expect.any(Number)]);
      expect(res.status).toBeLessThan(500);
      expect([400, 403, 404]).toContain(res.status);
    }
    expect(await db.invites.find({})).toHaveLength(0);   // hiçbir yan etki yok
  });

  // ── Faz 10.10 BULGU (MEDIUM) — SORGU OPERATÖRÜ ENJEKSİYONU ──────────────
  //
  // `serverId` gövdeden HAM olarak `Members.findOne(userId, serverId)`e
  // geçiyordu. Depo katmanı Mongo tarzı sorgu nesnelerini kabul eder ve
  // Postgres adaptörü bunları GERÇEK SQL operatörlerine çevirir
  // (db/postgres/pgCollection.ts — $in/$ne/$gt/$regex/$exists ...).
  // Uygulamada `$`-anahtarlarını temizleyen global bir katman YOKTUR.
  //
  // Sonuç: `{ $ne: '<var-olmayan>' }` yükü, saldırganın HERHANGİ bir
  // sunucudaki üyelik satırıyla eşleşir → hedef sunucuya üye olmasa da
  // üyelik kontrolünü geçer, ardından `Servers.findById` rastgele bir
  // sunucu döndürür ve yanıt o sunucunun ADINI sızdırır.
  //
  // NOT: `{ $ne: null }` özellikle seçilmedi — SQL'de `!= NULL` hiçbir zaman
  // doğru olmadığı için üretimde kapalı biçimde başarısız olurdu. Aşağıdaki
  // yükler hem mock hem gerçek Postgres'te sömürülebilir.
  it('serverId içine gömülen SORGU OPERATÖRÜ üyelik kontrolünü geçemez', async () => {
    const payloads: Array<[string, unknown]> = [
      ['$ne',     { $ne: 'yok-boyle-sunucu' }],
      ['$exists', { $exists: true }],
      ['$regex',  { $regex: '.*' }],
      ['$in',     { $in: [SERVER_ID, OTHER_SERVER_ID] }],
    ];

    for (const [label, serverId] of payloads) {
      const res = await createInvite(member._id, { serverId });

      expect([label, res.status < 500]).toEqual([label, true]);
      expect([label, [400, 403, 404].includes(res.status)]).toEqual([label, true]);
    }
    expect(await db.invites.find({})).toHaveLength(0);
  });

  it('operatör enjeksiyonu ÜYE OLMADIĞI sunucunun adını sızdıramaz', async () => {
    // outsider yalnız srv-2 üyesi. Enjeksiyon, üyelik kontrolünü kendi
    // srv-2 satırıyla geçip başka bir sunucunun adını döndürmemelidir.
    const res = await createInvite(outsider._id, { serverId: { $ne: OTHER_SERVER_ID } });

    // Nesne yük artık üyelik kontrolüne VARMADAN reddedilir (400); üyelik
    // kontrolüne varan meşru-ama-yetkisiz string ise 403 alır.
    expect([400, 403]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('Test Sunucu');
    expect(await db.invites.find({})).toHaveLength(0);
  });

  it('enjeksiyon nesnesi serverId olarak KAYDEDİLEMEZ', async () => {
    await createInvite(member._id, { serverId: { $ne: 'yok' } });

    // Bozuk (nesne/JSON) serverId taşıyan davet satırı oluşmamalı.
    for (const row of await db.invites.find({})) {
      expect(typeof row.serverId).toBe('string');
      expect(row.serverId).not.toMatch(/\$ne|\{/);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 10.15  TTL
// ─────────────────────────────────────────────────────────────
describe('varsayılan süre (TTL)', () => {
  it('expiresAt oluşturma anı + 7 gün civarındadır', async () => {
    const before = Date.now();
    const res = await createInvite(member._id, { serverId: SERVER_ID });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(res.body.expiresAt).toBeLessThanOrEqual(after + 7 * DAY_MS);
  });

  it('istemci ttl/expiresAt göndererek süreyi UZATAMAZ', async () => {
    const res = await createInvite(member._id, {
      serverId: SERVER_ID, ttlMs: 3650 * DAY_MS, expiresAt: Date.now() + 3650 * DAY_MS,
    });

    // Rota bu alanları okumaz; sunucu varsayılanı otoritedir.
    expect(res.body.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 5000);
  });
});

// ─────────────────────────────────────────────────────────────
// 10.6–10.9, 10.11–10.12  KULLANMA
// ─────────────────────────────────────────────────────────────
describe('davet kullanma — geçerli yol', () => {
  it('üye olmayan katılır: tam bir üyelik + uses tam bir artar', async () => {
    const inv = await seedInvite();

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(SERVER_ID);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(1);
    expect(await usesOf(inv._id)).toBe(1);
  });

  it('maxUses=0 SINIRSIZ demektir', async () => {
    const inv = await seedInvite({ maxUses: 0 });

    expect((await useInvite(joiner._id, inv.code)).status).toBe(200);
    expect((await useInvite(outsider._id, inv.code)).status).toBe(200);
    expect(await usesOf(inv._id)).toBe(2);
  });

  it('kimliksiz kullanım reddedilir ve üyelik oluşmaz', async () => {
    const inv = await seedInvite();

    const res = await request(app).post(`/api/servers/invites/${inv.code}/use`);

    expect(res.status).toBe(401);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
    expect(await usesOf(inv._id)).toBe(0);
  });
});

describe('davet kullanma — reddedilen yollar YAN ETKİSİZDİR', () => {

  it('BANLI kullanıcı davet ile geri dönemez; kullanım hakkı yanmaz', async () => {
    const inv = await seedInvite({ maxUses: 1, uses: 0 });
    await db.members.insert({ _id: 'ban-row', userId: joiner._id, serverId: SERVER_ID, banned: true, joinedAt: Date.now() });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(403);
    expect(await usesOf(inv._id)).toBe(0);
    expect((await db.members.find({ userId: joiner._id, serverId: SERVER_ID }))).toHaveLength(1);
  });

  it('davetin canonical sunucusu silinmişse 404; üyelik ve uses değişmez', async () => {
    const inv = await seedInvite({ maxUses: 1, uses: 0 });
    await db.servers.remove({ _id: SERVER_ID });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(404);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
    expect(await usesOf(inv._id)).toBe(0);
  });

  it('sunucu MFA/passkey zorunluluğu davet yolundan atlanamaz ve kullanım yakılmaz', async () => {
    const inv = await seedInvite({ maxUses: 1, uses: 0 });
    await db.servers.update({ _id: SERVER_ID }, { $set: { mfaLevel: 2 } });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_REQUIRED');
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
    expect(await usesOf(inv._id)).toBe(0);
  });

  it('bozuk persisted mfaLevel davet yolunda fail-closed level 2 olur', async () => {
    const inv = await seedInvite({ maxUses: 1, uses: 0 });
    await db.servers.update({ _id: SERVER_ID }, { $set: { mfaLevel: 'corrupt' } });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_REQUIRED');
    expect(res.body.mfaLevel).toBe(2);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
    expect(await usesOf(inv._id)).toBe(0);
  });

  it('passkey DEPOSU ERİŞİLEMEZKEN de FAIL-CLOSED: 403, 500 DEĞİL', async () => {
    // ── ÖLÇÜLEN ARIZA ──────────────────────────────────────────────────────
    // `AuthRepository.webauthnCollection()` koleksiyon yoksa
    // "WebAuthn credential store is unavailable" FIRLATIR. Kardeş yol
    // (`routes/servers/core.ts:495`, doğrudan katılım) bunu `.catch(() => [])`
    // ile yakalıyordu; DAVET yolu YAKALAMIYORDU ve 500 dönüyordu.
    //
    // Belirsizlik ERİŞİM VERMEMELİ ve iki katılım yolu aynı politikayı
    // uygulamalı. 500, hem yanlış sınıflandırma hem de kötü bir hata
    // yüzeyidir — istemci "sunucu bozuk" sanır, "passkey gerekiyor" değil.
    const inv = await seedInvite({ maxUses: 1, uses: 0 });
    await db.servers.update({ _id: SERVER_ID }, { $set: { mfaLevel: 2 } });

    const saved = db.webauthnCredentials;
    // @ts-expect-error — depo yokluğu KASITLI olarak simüle ediliyor.
    db.webauthnCredentials = undefined;
    try {
      const res = await useInvite(joiner._id, inv.code);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('MFA_REQUIRED');
      expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
      expect(await usesOf(inv._id)).toBe(0);   // reddedilen yol yan etkisiz
    } finally {
      db.webauthnCredentials = saved;
    }
  });

  it('KAYITLI passkey varsa davet MFA kapısını GEÇER (yanlış pozitif kontrolü)', async () => {
    // Ayrım: yukarıdaki iki iddia, kapı HER ZAMAN reddetse de geçerdi.
    const inv = await seedInvite({ maxUses: 1, uses: 0 });
    await db.servers.update({ _id: SERVER_ID }, { $set: { mfaLevel: 2 } });
    await db.webauthnCredentials.insert({
      _id: 'cred-1', userId: joiner._id, credentialId: 'c1',
      publicKey: 'k', counter: 0, createdAt: Date.now(),
    });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(200);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(1);
    expect(await usesOf(inv._id)).toBe(1);
  });

  it('SÜRESİ DOLMUŞ davet 410; üyelik yok, uses değişmez', async () => {
    const inv = await seedInvite({ expiresAt: Date.now() - 1000 });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(410);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
    expect(await usesOf(inv._id)).toBe(0);
  });

  it('maxUses DOLMUŞ davet 410; üyelik yok, uses değişmez', async () => {
    const inv = await seedInvite({ maxUses: 1, uses: 1 });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(410);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
    expect(await usesOf(inv._id)).toBe(1);
  });

  it('süre kontrolü maxUses kontrolünden ÖNCE gelir (sıralama sözleşmesi)', async () => {
    const inv = await seedInvite({ expiresAt: Date.now() - 1000, maxUses: 1, uses: 1 });

    const res = await useInvite(joiner._id, inv.code);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);   // süre mesajı, kullanım değil
  });

  it('BİLİNMEYEN kod 404; hiçbir yan etki yok', async () => {
    await seedInvite();

    const res = await useInvite(joiner._id, 'yokboyle');

    expect(res.status).toBe(404);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
    expect(await db.members.find({ serverId: SERVER_ID })).toHaveLength(2);   // owner + member
  });

  it('ZATEN ÜYE 400; kopya üyelik YOK, uses ARTMAZ', async () => {
    const inv = await seedInvite();

    const res = await useInvite(member._id, inv.code);

    expect(res.status).toBe(400);
    expect(await memberCount(member._id, SERVER_ID)).toBe(1);   // kopya yok
    expect(await usesOf(inv._id)).toBe(0);                      // kullanım tüketilmedi
  });

  it('aynı kullanıcı daveti İKİ KEZ kullanamaz (ikinci kez 400)', async () => {
    const inv = await seedInvite({ maxUses: 5 });

    expect((await useInvite(joiner._id, inv.code)).status).toBe(200);
    const second = await useInvite(joiner._id, inv.code);

    expect(second.status).toBe(400);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(1);
    expect(await usesOf(inv._id)).toBe(1);   // ikinci deneme kullanım yakmadı
  });
});

// ─────────────────────────────────────────────────────────────
// 10.10  KOD SANİTİZASYONU
// ─────────────────────────────────────────────────────────────
describe('atomic consume race sonuçlarının HTTP sözleşmesi', () => {
  const cases: Array<[string, number, string]> = [
    ['not_found', 404, 'Invalid invite code'],
    ['expired', 410, 'Invite has expired'],
    ['max_uses', 410, 'Invite has reached its maximum uses'],
    ['banned', 403, 'Bu sunucudan yasaklandınız'],
    ['already_member', 400, 'Already a member'],
    ['scope_mismatch', 409, 'Invite scope mismatch'],
  ];

  test.each(cases)('%s race sonucu %i ve yan etkisizdir', async (status, expectedStatus, error) => {
    const inv = await seedInvite({ maxUses: 5, uses: 0 });
    const spy = jest.spyOn(Invites, 'consumeForMemberAtomic').mockResolvedValue({ status } as never);
    try {
      const res = await useInvite(joiner._id, inv.code);
      expect(res.status).toBe(expectedStatus);
      expect(res.body.error).toBe(error);
      expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
      expect(await usesOf(inv._id)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('kod girdisi güvenliği', () => {
  it('bozuk karakterler 500 tetiklemez', async () => {
    await seedInvite();

    for (const raw of ['%2e%2e%2f', "';DROP--", '<script>', '....', '$ne', '%00']) {
      const res = await useInvite(joiner._id, encodeURIComponent(raw));

      expect(res.status).toBeLessThan(500);
      expect([404, 410]).toContain(res.status);
    }
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
  });

  it('sanitizasyon BİLİNMEYEN bir kodu geçerli koda dönüştüremez', async () => {
    // Saldırgan kodu bilmiyorsa temizleme ona kod kazandırmaz.
    await seedInvite({ code: 'gizlikod' });

    const res = await useInvite(joiner._id, encodeURIComponent('!!!!!!!!'));

    expect(res.status).toBe(404);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
  });

  it('aşırı uzun girdi 64 karakterde kesilir ve eşleşmez', async () => {
    await seedInvite({ code: 'seedcode' });

    const res = await useInvite(joiner._id, 'seedcode' + '_'.repeat(200));

    expect(res.status).toBe(404);
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
  });

  it('boş kod 404 döner', async () => {
    const res = await request(app).post('/api/servers/invites/%20/use')
      .set('Authorization', `Bearer ${tok(joiner._id)}`);

    expect([404, 400]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────
// 10.13  SUNUCU OTORİTESİ
// ─────────────────────────────────────────────────────────────
describe('sunucu otoritesi — çapraz sunucu ikamesi', () => {
  it('katılım YALNIZ davetin kayıtlı serverId\'sini kullanır', async () => {
    const inv = await seedInvite({ serverId: SERVER_ID });

    // İstemci başka sunucuya yönlendirmeyi deniyor.
    const res = await request(app).post(`/api/servers/invites/${inv.code}/use`)
      .set('Authorization', `Bearer ${tok(joiner._id)}`)
      .query({ serverId: OTHER_SERVER_ID })
      .send({ serverId: OTHER_SERVER_ID });

    expect(res.status).toBe(200);
    expect(res.body._id).toBe(SERVER_ID);                          // davetin sunucusu
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(1);
    expect(await memberCount(joiner._id, OTHER_SERVER_ID)).toBe(0); // ikame olmadı
  });
});

// ─────────────────────────────────────────────────────────────
// 10.14  QR YOLU DOĞRULAMAYI ATLAMAZ
// ─────────────────────────────────────────────────────────────
describe('QR uçları aynı doğrulamayı uygular', () => {
  const qrPaths = (code: string) => [
    `/api/servers/invites/${code}/qr`,
    `/api/servers/invites/${code}/qr/data`,
  ];

  it('geçerli davet için QR üretilir (pozitif kontrol)', async () => {
    const inv = await seedInvite();

    for (const p of qrPaths(inv.code)) {
      const res = await request(app).get(p).set('Authorization', `Bearer ${tok(joiner._id)}`);
      expect(res.status).toBe(200);
    }
  });

  it('SÜRESİ DOLMUŞ davet QR ile de açılamaz (410)', async () => {
    const inv = await seedInvite({ expiresAt: Date.now() - 1000 });

    for (const p of qrPaths(inv.code)) {
      const res = await request(app).get(p).set('Authorization', `Bearer ${tok(joiner._id)}`);
      expect(res.status).toBe(410);
    }
  });

  it('maxUses DOLMUŞ davet QR ile de açılamaz (410)', async () => {
    const inv = await seedInvite({ maxUses: 1, uses: 1 });

    for (const p of qrPaths(inv.code)) {
      const res = await request(app).get(p).set('Authorization', `Bearer ${tok(joiner._id)}`);
      expect(res.status).toBe(410);
    }
  });

  it('bilinmeyen kod QR ile 404 döner', async () => {
    for (const p of qrPaths('yokboyle')) {
      const res = await request(app).get(p).set('Authorization', `Bearer ${tok(joiner._id)}`);
      expect(res.status).toBe(404);
    }
  });

  it('QR uçları kimlik doğrulaması ister', async () => {
    const inv = await seedInvite();

    for (const p of qrPaths(inv.code)) {
      expect((await request(app).get(p)).status).toBe(401);
    }
  });

  it('PNG QR endpoint gerçek PNG üretir ve auth gerektirir', async () => {
    const inv = await seedInvite();
    expect((await request(app).get(`/api/servers/invites/${inv.code}/qr/png`)).status).toBe(401);

    const res = await request(app).get(`/api/servers/invites/${inv.code}/qr/png`)
      .set('Authorization', `Bearer ${tok(joiner._id)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('QR ÜYELİK GEREKTİRMEZ ama davet geçerliliğine bağlıdır (mevcut sözleşme)', async () => {
    // Bu kasıtlı: davet linkini alan kişi QR'ı görebilmelidir.
    const inv = await seedInvite();

    const res = await request(app).get(`/api/servers/invites/${inv.code}/qr/data`)
      .set('Authorization', `Bearer ${tok(outsider._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(inv.code);
  });
});

// ─────────────────────────────────────────────────────────────
// 10.16  SIRALAMA — başarısız üyelik daveti TÜKETMEZ
// ─────────────────────────────────────────────────────────────
describe('kullanım sayacı sıralaması', () => {
  it('üyelik yazımı BAŞARISIZ olursa uses artmaz', async () => {
    const inv = await seedInvite({ maxUses: 3 });
    const realInsert = db.members.insert;
    db.members.insert = jest.fn(async () => { throw new Error('db yazma hatası'); });

    const res = await useInvite(joiner._id, inv.code);

    db.members.insert = realInsert;
    expect(res.status).toBe(500);              // hata gizlenmiyor
    expect(await usesOf(inv._id)).toBe(0);     // davet hakkı yanmadı
    expect(await memberCount(joiner._id, SERVER_ID)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// DESTEKLENMEYEN ÖZELLİKLER — sözleşme kilidi
// ─────────────────────────────────────────────────────────────
describe('desteklenmeyen özellikler (N/A — uydurulmaz)', () => {
  it('davet iptal/silme ucu YOKTUR', async () => {
    const inv = await seedInvite();

    const res = await request(app).delete(`/api/servers/invites/${inv.code}`)
      .set('Authorization', `Bearer ${tok(owner._id)}`);

    expect(res.status).toBe(404);                 // rota tanımlı değil
    expect(await db.invites.findOne({ _id: inv._id })).toBeTruthy();
  });

  it('davet listeleme ucu YOKTUR', async () => {
    await seedInvite();

    const res = await request(app).get('/api/servers/invites')
      .set('Authorization', `Bearer ${tok(owner._id)}`);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────
// 10.17  EŞZAMANLILIK — maxUses "kontrol et sonra yaz" yarışı
// ─────────────────────────────────────────────────────────────
describe('eşzamanlı kullanım ve maxUses', () => {
  it('maxUses=1 iken iki eşzamanlı katılım sınırı AŞAMAZ', async () => {
    const inv = await seedInvite({ maxUses: 1, uses: 0 });

    // Fixture sayısı VARSAYILMAZ: öncesi/sonrası farkı ölçülür.
    const before = new Set(
      (await db.members.find({ serverId: SERVER_ID })).map((m) => stringOf(m.userId, 'userId')),
    );

    const [r1, r2] = await Promise.all([
      useInvite(joiner._id, inv.code),
      useInvite(outsider._id, inv.code),
    ]);

    const after = (await db.members.find({ serverId: SERVER_ID })).map((m) => stringOf(m.userId, 'userId'));
    const added = after.filter(u => !before.has(u));

    expect([r1.status, r2.status].filter(s => s === 200)).toHaveLength(1);   // tam bir başarı
    expect(added).toHaveLength(1);                                           // tam bir yeni üye
    expect([joiner._id, outsider._id]).toContain(added[0]);
    expect(await usesOf(inv._id)).toBe(1);                                   // sınır korundu
  });
});

// ─────────────────────────────────────────────────────────────
// 10.18  KOD ÇAKIŞMASI (UNIQUE ihlali)
// ─────────────────────────────────────────────────────────────
describe('davet kodu çakışması', () => {
  it('UNIQUE ihlali istemciye 500 olarak SIZMAZ (sınırlı yeniden deneme)', async () => {
    const realInsert = db.invites.insert.bind(db.invites);
    let calls = 0;
    db.invites.insert = jest.fn(async (row: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) {
        const e: Error & { code?: string } = new Error('duplicate key value violates unique constraint "invites_code_key"');
        e.code = '23505';
        throw e;
      }
      return realInsert(row);
    });

    try {
      const res = await createInvite(member._id, { serverId: SERVER_ID });

      expect(res.status).toBe(200);
      expect(calls).toBeGreaterThan(1);        // yeni kod üretilip yeniden denendi
    } finally {
      db.invites.insert = realInsert;
    }
  });

  it('ALAKASIZ veritabanı hatası YUTULMAZ', async () => {
    const realInsert = db.invites.insert.bind(db.invites);
    db.invites.insert = jest.fn(async () => { throw new Error('bağlantı koptu'); });

    try {
      const res = await createInvite(member._id, { serverId: SERVER_ID });

      expect(res.status).toBe(500);            // sessizce başarı taklidi YOK
    } finally {
      db.invites.insert = realInsert;
    }
  });
});
