// server/tests/server-create-join.test.ts
// Faz 10.11 — Sunucu oluşturma / katılma sözleşmesi.
//
// KAYNAKTAN DOĞRULANMIŞ SÖZLEŞME (routes/servers/core.ts):
//
//   POST /api/servers
//     auth · name zorunlu (trim, max 50) · MAX_SERVERS_PER_USER (vars. 100)
//     icon sanitize (max 10 char; <, >, javascript:, on…= reddedilir; vars. 🌐)
//     ownerId = kimliği doğrulanmış aktör
//     VARSAYILAN KANALLAR: 'general' (text/GENERAL/0) + 'General Voice' (voice/VOICE/1)
//     Members.insert(actor, serverId)
//
//   POST /api/servers/:sid/join
//     auth · sunucu yoksa 404 · zaten üye 400
//     mfaLevel >= 1 ise kayıtlı passkey yoksa 403 MFA_REQUIRED
//     DAVET GEREKTİRMEZ; public/private bayrağı YOKTUR (doğrudan katılım)
//
//   GET /api/servers
//     Members.findByUser(actor) → Servers.find({_id: {$in: …}}) — üyelik kapsamlı
//
// Bu süit repository katmanını MOCK'LAMAZ; yalnız `db/loader` mock DB'dir.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

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
import serversRouter from '../routes/servers';
// Ban senaryolari icin kanonik repository sahibi (mock DB uzerinde calisir).
import { Members } from '../db/repositories';
import type { MockDb, UserFixture } from './helpers/mockDb';
import { requireDoc } from './helpers/mockDb';

let app: express.Express;
let alice: UserFixture;
let bob: UserFixture;

const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

const createServer = (actor: string, body: Record<string, unknown>) =>
  request(app).post('/api/servers').set('Authorization', `Bearer ${tok(actor)}`).send(body);

const listServers = (actor: string) =>
  request(app).get('/api/servers').set('Authorization', `Bearer ${tok(actor)}`);

const joinServer = (actor: string, sid: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/servers/${sid}/join`).set('Authorization', `Bearer ${tok(actor)}`).send(body);

const membershipRows = (userId: string, serverId: string) =>
  db.members.find({ userId, serverId });

beforeEach(async () => {
  const { createMockDb, makeUser } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);

  alice = makeUser({ _id: 'user-alice', username: 'alice' });
  bob   = makeUser({ _id: 'user-bob',   username: 'bob' });
  await db.users.insert(alice);
  await db.users.insert(bob);

  app = express();
  app.use(express.json());
  app.use('/api/servers', serversRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
});

// ─────────────────────────────────────────────────────────────
// 7.2  OLUŞTURMA
// ─────────────────────────────────────────────────────────────
describe('POST /api/servers — oluşturma', () => {
  it('kimliksiz istek reddedilir ve sunucu OLUŞMAZ', async () => {
    const res = await request(app).post('/api/servers').send({ name: 'Gizli' });

    expect(res.status).toBe(401);
    expect(await db.servers.find({})).toHaveLength(0);
  });

  it('geçerli oluşturma başarılı; aktör SAHİP ve ÜYE olur', async () => {
    const res = await createServer(alice._id, { name: 'Bridge HQ' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Bridge HQ');
    expect(res.body.ownerId).toBe(alice._id);
    expect(await membershipRows(alice._id, res.body._id)).toHaveLength(1);
  });

  it('VARSAYILAN KANALLAR oluşturulur (general + General Voice)', async () => {
    const res = await createServer(alice._id, { name: 'Kanallı' });

    const channels = await db.channels.find({ serverId: res.body._id });
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => stringOf(c.name, 'kanal adi')).sort()).toEqual(['General Voice', 'general']);
    expect(channels.find((c) => c.type === 'voice')).toBeTruthy();
    expect(channels.find((c) => c.type === 'text')).toBeTruthy();
  });

  it('yeni sunucu SAHİBİNİN listesinde görünür', async () => {
    const created = await createServer(alice._id, { name: 'Listede' });

    const list = await listServers(alice._id);

    expect(list.status).toBe(200);
    expect(list.body.map((s: { _id: string }) => s._id)).toContain(created.body._id);
  });

  it('BAŞKA kullanıcının listesinde GÖRÜNMEZ (üyelik kapsamı)', async () => {
    await createServer(alice._id, { name: 'AliceOzel' });

    const list = await listServers(bob._id);

    expect(list.body).toHaveLength(0);
    expect(JSON.stringify(list.body)).not.toContain('AliceOzel');
  });

  it('body\'deki sahte ownerId YETKİ KAYNAĞI değildir', async () => {
    const res = await createServer(alice._id, {
      name: 'Sahte', ownerId: bob._id, userId: bob._id, _id: 'secilmis-id',
    });

    expect(res.status).toBe(200);
    expect(res.body.ownerId).toBe(alice._id);
    expect(res.body.ownerId).not.toBe(bob._id);
    // Üyelik de daima aktöre yazılır.
    expect(await membershipRows(bob._id, res.body._id)).toHaveLength(0);
  });

  it('geçersiz isim güvenle reddedilir (asla 500)', async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['eksik',   {}],
      ['boş',     { name: '' }],
      ['boşluk',  { name: '   ' }],
      ['null',    { name: null }],
      ['uzun',    { name: 'x'.repeat(51) }],
      ['sayı',    { name: 12345 }],
      ['nesne',   { name: { $ne: null } }],
      ['dizi',    { name: ['a'] }],
    ];

    for (const [label, body] of bodies) {
      const res = await createServer(alice._id, body);

      expect([label, res.status < 500]).toEqual([label, true]);
      expect([label, res.status]).toEqual([label, 400]);
    }
    expect(await db.servers.find({})).toHaveLength(0);
  });

  it('isim kırpılır ve 50 karakter sınırı kırpma SONRASI uygulanır', async () => {
    const res = await createServer(alice._id, { name: '  Kırpılmış  ' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Kırpılmış');
  });

  it('icon HTML/script içeriyorsa reddedilir', async () => {
    for (const icon of ['<script>', '<img src=x onerror=1>', 'onload=x']) {
      const res = await createServer(alice._id, { name: 'IconTest', icon });

      expect(res.status).toBe(400);
    }
  });

  // Kaynak `icon`u ÖNCE 10 karaktere kırpıp SONRA doğruluyor (core.ts).
  // Bu yüzden 'javascript:alert(1)' → 'javascript' olur ve `javascript:`
  // kontrolüne yakalanmaz. SÖMÜRÜLEBİLİR DEĞİLDİR: `<` ve `>` hâlâ reddedilir,
  // sonuç 10 karakterlik zararsız bir metindir. Güvenlik değişmezi burada
  // kilitlenir; kırpma sırası kozmetik tutarsızlık olarak Faz 13'e taşınır.
  it('icon her durumda 10 karakteri aşmaz ve HTML sınırlayıcısı İÇERMEZ', async () => {
    const res = await createServer(alice._id, { name: 'IconKirp', icon: 'javascript:alert(1)' });

    expect(res.status).toBe(200);
    expect(res.body.icon.length).toBeLessThanOrEqual(10);
    expect(res.body.icon).not.toMatch(/[<>]/);
  });

  it('icon string DEĞİLSE varsayılana düşer (500 değil)', async () => {
    for (const icon of [123, { $ne: null }, ['x']]) {
      const res = await createServer(alice._id, { name: `IconTip${Math.random()}`, icon });

      expect(res.status).toBe(200);
      expect(res.body.icon).toBe('🌐');
    }
  });

  it('icon verilmezse varsayılan atanır', async () => {
    const res = await createServer(alice._id, { name: 'Varsayilan' });

    expect(res.body.icon).toBe('🌐');
  });


  it('concurrent creates cannot exceed MAX_SERVERS_PER_USER', async () => {
    const previous = process.env.MAX_SERVERS_PER_USER;
    process.env.MAX_SERVERS_PER_USER = '1';
    try {
      const [a, b] = await Promise.all([
        createServer(alice._id, { name: 'Race A' }),
        createServer(alice._id, { name: 'Race B' }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 400]);
      const owned = await db.servers.find({ ownerId: alice._id });
      expect(owned).toHaveLength(1);
      expect(await db.channels.find({ serverId: owned[0]._id })).toHaveLength(2);
      expect(await membershipRows(alice._id, owned[0]._id)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.MAX_SERVERS_PER_USER;
      else process.env.MAX_SERVERS_PER_USER = previous;
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 7.4  KATILMA
// ─────────────────────────────────────────────────────────────
describe('POST /api/servers/:sid/join — katılma', () => {
  let sid: string;

  beforeEach(async () => {
    const created = await createServer(alice._id, { name: 'Ortak Sunucu' });
    sid = created.body._id;
    // ── POLITIKA DEGISTI: DOGRUDAN KATILIM ARTIK KESFEDILEBILIRLIK ISTER ────
    // `routes/servers/core.ts:486` artik `server.discoverable` false ise
    // 403 INVITE_REQUIRED dondurur. Sunucu olusturma `discoverable` ALANINI
    // HIC SET ETMEDIGI icin yeni sunucular varsayilan olarak OZELDIR.
    //
    // Bu bloktaki testler ACIK katilim akisini olcer, bu yuzden sunucu acikca
    // kesfedilebilir yapilir. Yeni politikanin KENDISI asagida ayri bir
    // testle kilitlenir — yani koruma kaldirilirsa bir test duser.
    await db.servers.update({ _id: sid }, { $set: { discoverable: true } });
  });

  it('kimliksiz katılım reddedilir', async () => {
    const res = await request(app).post(`/api/servers/${sid}/join`);

    expect(res.status).toBe(401);
    expect(await membershipRows(bob._id, sid)).toHaveLength(0);
  });

  it('uygun kullanıcı katılır ve sunucu LİSTESİNDE görünür', async () => {
    const res = await joinServer(bob._id, sid);

    expect(res.status).toBe(200);
    expect(await membershipRows(bob._id, sid)).toHaveLength(1);

    const list = await listServers(bob._id);
    expect(list.body.map((s: { _id: string }) => s._id)).toContain(sid);
  });

  it('KEŞFEDİLEBİLİR sunucuya doğrudan katılım serbesttir', async () => {
    // Kaynaktaki gerçek politikanın kilidi (güvenlik iddiası değil).
    expect((await joinServer(bob._id, sid)).status).toBe(200);
  });

  it('ÖZEL sunucuya doğrudan katılım 403 INVITE_REQUIRED', async () => {
    // ── YENİ POLİTİKANIN KİLİDİ ──────────────────────────────────────────
    // Eskiden bu suite "DAVET GEREKTİRMEZ — id bilen katılabilir" diyordu:
    // sunucu kimliğini ele geçiren herkes özel bir sunucuya girebiliyordu.
    // Koruma eklendi; bu test onu ölçer, aksi hâlde koruma sessizce
    // kaldırılabilirdi (yukarıdaki testler artık `discoverable: true`
    // kullandığı için tek başlarına düşmezlerdi).
    await db.servers.update({ _id: sid }, { $set: { discoverable: false } });

    const res = await joinServer(bob._id, sid);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('INVITE_REQUIRED');
    expect(await membershipRows(bob._id, sid)).toHaveLength(0);
  });

  it('discoverable alanı HİÇ yoksa da özel kabul edilir (fail-closed)', async () => {
    // Eski satırlarda kolon boş olabilir; belirsizlik ERİŞİM VERMEMELİ.
    await db.servers.update({ _id: sid }, { $set: { discoverable: undefined } });

    expect((await joinServer(bob._id, sid)).status).toBe(403);
    expect(await membershipRows(bob._id, sid)).toHaveLength(0);
  });

  it('var olmayan sunucu 404; üyelik oluşmaz', async () => {
    const res = await joinServer(bob._id, 'yok-boyle-sunucu');

    expect(res.status).toBe(404);
    expect(await db.members.find({ userId: bob._id })).toHaveLength(0);
  });

  it('bozuk sid güvenle reddedilir (asla 500)', async () => {
    for (const raw of ['%00', 'a'.repeat(300), '..%2f..%2fetc']) {
      const res = await request(app).post(`/api/servers/${raw}/join`)
        .set('Authorization', `Bearer ${tok(bob._id)}`);

      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(404);
    }
  });

  it('ZATEN ÜYE 400; KOPYA üyelik oluşmaz', async () => {
    expect((await joinServer(bob._id, sid)).status).toBe(200);

    const second = await joinServer(bob._id, sid);

    expect(second.status).toBe(400);
    expect(await membershipRows(bob._id, sid)).toHaveLength(1);
  });

  it('body\'deki sahte userId başkasını sunucuya SOKAMAZ', async () => {
    const res = await joinServer(bob._id, sid, { userId: alice._id, memberId: alice._id });

    expect(res.status).toBe(200);
    expect(await membershipRows(bob._id, sid)).toHaveLength(1);   // aktörün kendisi katıldı
    expect(await membershipRows(alice._id, sid)).toHaveLength(1); // alice'in tek satırı (kurucu) — artmadı
  });

  it('mfaLevel >= 1 iken passkey yoksa 403 MFA_REQUIRED', async () => {
    await db.servers.update({ _id: sid }, { $set: { mfaLevel: 2 } });

    const res = await joinServer(bob._id, sid);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_REQUIRED');
    expect(await membershipRows(bob._id, sid)).toHaveLength(0);
  });

  it('persisted malformed mfaLevel fails closed instead of disabling MFA', async () => {
    // Real PostgreSQL migration 053 repairs this to 2. The runtime guard is a
    // second line of defence for partially-migrated/legacy rows.
    await db.servers.update({ _id: sid }, { $set: { mfaLevel: 99 } });

    const res = await joinServer(bob._id, sid);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_REQUIRED');
    expect(res.body.mfaLevel).toBe(2);
    expect(await membershipRows(bob._id, sid)).toHaveLength(0);
  });

  it('concurrent duplicate joins have one durable winner and one loser', async () => {
    const [a, b] = await Promise.all([
      joinServer(bob._id, sid),
      joinServer(bob._id, sid),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(await membershipRows(bob._id, sid)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 7.4  BAN — SUNUCU BANI ÜRETİM ŞEMASINDA DEPOLANAMAZ
// ─────────────────────────────────────────────────────────────
//
// ── BU BLOK ESKİYDİ; DÜZELTİLDİ ────────────────────────────────────────────
// Burada eskiden "ban özelliği üretim şemasında ÇALIŞAMAZ, `banned` kolonu
// YOKTUR, bu yüzden ban test EDİLMEZ" yazıyordu ve İŞLEVSİZ olarak
// sınıflandırılmıştı. Bu artık DOĞRU DEĞİL — doğrudan kaynaktan kontrol edildi:
//
//   • `db/migrations_pg/029_member_ban_column.sql`
//       ALTER TABLE members ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL
//       DEFAULT FALSE;  (+ idx_members_banned)
//   • `db/postgres/schema.ts:162` — taze kurulumda da `banned` kolonu var.
//   • `MemberRepository.banMember` mevcut satırı GÜNCELLER
//     (`findIncludingBanned` → update), artık INSERT etmez; bileşik PRIMARY
//     KEY ihlali oluşmaz.
//   • `routes/servers/core.ts:484` katılımda `existing?.banned` denetler ve
//     403 BANNED döner — yani "join ban kontrolü yapmaz" iddiası da eskimiş.
//
// Eski not yerinde bırakılsaydı gelecekteki bir bakımcı çalışan bir güvenlik
// kontrolünü "bozuk" sanacaktı. Ban semantigi artık UYDURMA değil; aşağıda
// gerçekten ölçülüyor.
describe('üyelik tekilliği (7.5)', () => {
  it('tekrarlanan katılım tek mantıksal üyelik bırakır', async () => {
    const created = await createServer(alice._id, { name: 'Tekillik' });
    const sid = created.body._id;
    // Doğrudan katılım artık keşfedilebilirlik ister (core.ts:486).
    await db.servers.update({ _id: sid }, { $set: { discoverable: true } });

    await joinServer(bob._id, sid);
    await joinServer(bob._id, sid);
    await joinServer(bob._id, sid);

    expect(await membershipRows(bob._id, sid)).toHaveLength(1);
  });

  it('sahip oluşturmada tek üyelik satırı alır', async () => {
    const created = await createServer(alice._id, { name: 'SahipTek' });

    expect(await membershipRows(alice._id, created.body._id)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// SUNUCU BANI — ARTIK GERÇEKTEN ÖLÇÜLÜYOR
// ─────────────────────────────────────────────────────────────
// Yukarıdaki blok bu senaryonun "üretimde oluşamayacağını" söylüyordu.
// migration 029 + `banMember` düzeltmesi + join'deki ban denetimi sonrası
// senaryo GERÇEK. Test edilmezse ban denetimi sessizce kaldırılabilirdi.
describe('sunucu banı — katılım engellenir', () => {
  let sid: string;

  beforeEach(async () => {
    const created = await createServer(alice._id, { name: 'Banli Sunucu' });
    sid = created.body._id;
    await db.servers.update({ _id: sid }, { $set: { discoverable: true } });
  });

  it('banlı kullanıcı KEŞFEDİLEBİLİR sunucuya bile katılamaz (403 BANNED)', async () => {
    await Members.banMember(sid, bob._id, 'spam');

    const res = await joinServer(bob._id, sid);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('BANNED');
  });

  it('ban KOPYA üyelik satırı üretmez (bileşik PK güvenli)', async () => {
    // Önce meşru üye olsun, SONRA banlansın: eski kod burada INSERT edip
    // PRIMARY KEY("userId","serverId") kısıtını ihlal ediyordu.
    expect((await joinServer(bob._id, sid)).status).toBe(200);

    await Members.banMember(sid, bob._id, 'kural ihlali');

    const rows = await db.members.find({ userId: bob._id, serverId: sid });
    expect(rows).toHaveLength(1);
    expect(rows[0].banned).toBe(true);
  });

  it('ban kaldırılınca yeniden katılabilir (yanlış pozitif kontrolü)', async () => {
    await Members.banMember(sid, bob._id, 'gecici');
    expect((await joinServer(bob._id, sid)).status).toBe(403);

    await Members.unbanMember(sid, bob._id);

    const res = await joinServer(bob._id, sid);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────
// SERVER LIFECYCLE — update / leave / delete / member surfaces
// ─────────────────────────────────────────────────────────────
describe('server lifecycle authority and input safety', () => {
  it('PATCH rejects missing server, non-owner, and malformed typed fields without 500', async () => {
    let res = await request(app)
      .patch('/api/servers/missing')
      .set('Authorization', `Bearer ${tok(alice._id)}`)
      .send({ name: 'x' });
    expect(res.status).toBe(404);

    const created = await createServer(alice._id, { name: 'Lifecycle' });
    res = await request(app)
      .patch(`/api/servers/${created.body._id}`)
      .set('Authorization', `Bearer ${tok(bob._id)}`)
      .send({ name: 'stolen' });
    expect(res.status).toBe(403);

    for (const body of [{ name: 42 }, { name: { $ne: null } }, { icon: 42 }, { icon: ['x'] }]) {
      res = await request(app)
        .patch(`/api/servers/${created.body._id}`)
        .set('Authorization', `Bearer ${tok(alice._id)}`)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it('PATCH validates XSS/mfa and persists canonical name/icon/mfa updates', async () => {
    const created = await createServer(alice._id, { name: 'Before' });
    const sid = created.body._id;

    let res = await request(app).patch(`/api/servers/${sid}`)
      .set('Authorization', `Bearer ${tok(alice._id)}`).send({ icon: '<img>' });
    expect(res.status).toBe(400);

    res = await request(app).patch(`/api/servers/${sid}`)
      .set('Authorization', `Bearer ${tok(alice._id)}`).send({ mfaLevel: 9 });
    expect(res.status).toBe(400);

    res = await request(app).patch(`/api/servers/${sid}`)
      .set('Authorization', `Bearer ${tok(alice._id)}`).send({ mfaLevel: '2' });
    expect(res.status).toBe(400);

    res = await request(app).patch(`/api/servers/${sid}`)
      .set('Authorization', `Bearer ${tok(alice._id)}`)
      .send({ name: '  After  ', icon: '✅safe-long-icon', mfaLevel: 2 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('After');
    expect(res.body.mfaLevel).toBe(2);
    expect(String(res.body.icon).length).toBeLessThanOrEqual(10);

    res = await request(app).patch(`/api/servers/${sid}`)
      .set('Authorization', `Bearer ${tok(alice._id)}`).send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('leave rejects owner/nonmember and removes a real member', async () => {
    let res = await request(app).post('/api/servers/missing/leave')
      .set('Authorization', `Bearer ${tok(bob._id)}`).send({});
    expect(res.status).toBe(404);

    const created = await createServer(alice._id, { name: 'Leave' });
    const sid = created.body._id;
    res = await request(app).post(`/api/servers/${sid}/leave`)
      .set('Authorization', `Bearer ${tok(alice._id)}`).send({});
    expect(res.status).toBe(400);

    res = await request(app).post(`/api/servers/${sid}/leave`)
      .set('Authorization', `Bearer ${tok(bob._id)}`).send({});
    expect(res.status).toBe(400);

    await Members.insert(bob._id, sid);
    res = await request(app).post(`/api/servers/${sid}/leave`)
      .set('Authorization', `Bearer ${tok(bob._id)}`).send({});
    expect(res.status).toBe(200);
    expect(await membershipRows(bob._id, sid)).toHaveLength(0);
  });

  it('member list is membership-scoped and strips user secrets', async () => {
    const created = await createServer(alice._id, { name: 'Members' });
    const sid = created.body._id;
    let res = await request(app).get(`/api/servers/${sid}/members`)
      .set('Authorization', `Bearer ${tok(bob._id)}`);
    expect(res.status).toBe(403);

    await Members.insert(bob._id, sid);
    await db.users.update({ _id: bob._id }, { $set: { passwordHash: 'secret', email: 'bob@example.test' } });
    res = await request(app).get(`/api/servers/${sid}/members`)
      .set('Authorization', `Bearer ${tok(alice._id)}`);
    expect(res.status).toBe(200);
    const exposed = res.body.find((u: { _id: string }) => u._id === bob._id);
    expect(exposed).toBeTruthy();
    expect(exposed.passwordHash).toBeUndefined();
  });

  it('self nickname update trims to 32 chars and broadcasts when io is available', async () => {
    const created = await createServer(alice._id, { name: 'Nick' });
    const sid = created.body._id;
    await Members.insert(bob._id, sid);
    const emit = jest.fn();
    app.set('io', { to: jest.fn(() => ({ emit })) });

    const res = await request(app)
      .patch(`/api/servers/${sid}/members/${bob._id}/nickname`)
      .set('Authorization', `Bearer ${tok(bob._id)}`)
      .send({ nickname: `  ${'x'.repeat(40)}  ` });
    expect(res.status).toBe(200);
    expect(res.body.nickname).toHaveLength(32);
    expect(emit).toHaveBeenCalledWith('member:nicknameUpdate', expect.objectContaining({ userId: bob._id, serverId: sid }));
  });

  it('DELETE is owner-only and removes the canonical server graph', async () => {
    const created = await createServer(alice._id, { name: 'Delete' });
    const sid = created.body._id;
    const channels = await db.channels.find({ serverId: sid });
    await db.messages.insert({ _id: 'delete-msg', channelId: channels[0]._id, serverId: sid, userId: alice._id, content: 'gone', createdAt: Date.now() });

    let res = await request(app).delete(`/api/servers/${sid}`)
      .set('Authorization', `Bearer ${tok(bob._id)}`);
    expect(res.status).toBe(403);

    res = await request(app).delete(`/api/servers/${sid}`)
      .set('Authorization', `Bearer ${tok(alice._id)}`);
    expect(res.status).toBe(200);
    expect(await db.servers.findOne({ _id: sid })).toBeNull();
    expect(await db.channels.find({ serverId: sid })).toHaveLength(0);
    expect(await db.members.find({ serverId: sid })).toHaveLength(0);
    expect(await db.messages.find({ serverId: sid })).toHaveLength(0);
  });
});
