// server/tests/pg-integration/account-erasure.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL: HESAP SİLİNİNCE KİŞİNİN ADI, AVATARI VE PROFİL GÖRSELLERİ GİDER
// ════════════════════════════════════════════════════════════════════════════
// Final21 Faz 19. Canlı uçlar üzerinden ÜRETİLEN kusur (tools/p19-account-delete-privacy-probe.mjs):
// silme yalnızca `userId`'yi `deleted-user` yapıyordu; mesajlardaki ad/avatar anlık
// görüntüleri, başkalarının yanıtlarındaki alıntı başlığı ve profil görsel dosyaları
// AYNEN kalıyordu.
//
// Bu süit GERÇEK hesap silme yönlendiricisini gerçek veritabanına karşı çalıştırır (yalnızca
// kimlik doğrulama, hız sınırı ve canlı soket kapatma ikizlenir) ve silmeden sonra her
// tablodaki satırları, dosya sistemini ve kontrol satırlarını okur. Ayrıca CANLI şemayı tarar:
// yeni bir tabloya yazar adı/avatarı sütunu eklenip silme politikasına yazılmazsa DÜŞER.
//
// Yalnızca PG_TEST_URL ile çalışır; kendi satırlarını ve geçici yükleme kökünü temizler.

import fs from 'fs';
import os from 'os';
import path from 'path';

const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-erasure-'));
process.env.BRIDGE_UPLOAD_ROOT = UPLOAD_ROOT;

const P = 'pgt-erase';
const X = `${P}-x`;          // hesabını silen kişi
const A = `${P}-a`;          // kalan üye
const PASSWORD = 'Erasure-Test-Pass-1!';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'pgt-erase-x' }; next(); },
}));
jest.mock('../../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn(async () => undefined) }));

import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { AUTHOR_SNAPSHOTS, SNAPSHOT_COLUMN_NAMES, TOMBSTONE_AVATAR_COLOR } from '../../lib/accountErasure';
import { LIFECYCLE, TOMBSTONE_USER_ID } from '../../lib/accountLifecycle';

const db = require('../../db/loader').default;
const accountRouter = require('../../routes/account').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const file = (sub: string, name: string) => path.join(UPLOAD_ROOT, sub, name);
const url = (sub: string, name: string) => `/uploads/${sub}/${name}`;
// X'in görselleri: eski avatar (yalnızca geçmiş mesajda), güncel avatar, afiş, sunucu profili.
const X_OLD_AVATAR = ['avatars', `avatar_${P}-old.png`];
const X_AVATAR = ['avatars', `avatar_${P}-now.png`];
const X_BANNER = ['banners', `banner_${P}.png`];
const X_MP_AVATAR = ['member-profiles', `mp_av_${P}.webp`];
const X_MP_BANNER = ['member-profiles', `mp_bn_${P}.webp`];
// KONTROL: X'in eski bir avatarını sunucu simgesi de kullanıyor → başvuru sürer, SİLİNMEZ.
const SHARED = ['avatars', `avatar_${P}-shared.png`];
const A_AVATAR = ['avatars', `avatar_${P}-alice.png`];
const ALL_FILES = [X_OLD_AVATAR, X_AVATAR, X_BANNER, X_MP_AVATAR, X_MP_BANNER, SHARED, A_AVATAR];

RUN('gerçek PostgreSQL — hesap silmede kişisel görünüm silinir', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  let response: request.Response;

  const cleanup = async () => {
    const like = `${P}-%`;
    for (const t of ['messages', 'thread_messages', 'dm_messages', 'group_dm_messages', 'voice_messages', 'notifications', 'threads']) {
      await q(`DELETE FROM ${t} WHERE _id LIKE $1`, [like]);
    }
    await q(`DELETE FROM group_dm_conversations WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM channels WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM members WHERE "serverId" LIKE $1`, [like]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [like]);
  };

  beforeAll(async () => {
    await cleanup();
    for (const [sub, name] of ALL_FILES) {
      fs.mkdirSync(path.join(UPLOAD_ROOT, sub), { recursive: true });
      fs.writeFileSync(file(sub, name), 'img');
    }
    const hash = await bcrypt.hash(PASSWORD, 4);
    await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt", "avatarUrl", "bannerUrl", "avatarColor")
             VALUES ($1, 'erase_x', 'Leaving Person', $2, 1, $3, $4, '#ff00aa')`, [X, hash, url(X_AVATAR[0], X_AVATAR[1]), url(X_BANNER[0], X_BANNER[1])]);
    await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt", "avatarUrl")
             VALUES ($1, 'erase_a', 'Staying Person', 'x', 1, $2)`, [A, url(A_AVATAR[0], A_AVATAR[1])]);
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt", "iconUrl") VALUES ($1, 'S', $2, 1, $3)`,
      [`${P}-srv`, A, url(SHARED[0], SHARED[1])]);
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'c', 1)`, [`${P}-ch`, `${P}-srv`]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt", "serverProfile") VALUES ($1, $2, '[]', 1, $3)`,
      [X, `${P}-srv`, JSON.stringify({ avatarUrl: url(X_MP_AVATAR[0], X_MP_AVATAR[1]), bannerUrl: url(X_MP_BANNER[0], X_MP_BANNER[1]) })]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [A, `${P}-srv`]);

    const msg = (id: string, userId: string, username: string, displayName: string, avatarUrl: string | null, content: string, replyTo: unknown = null) =>
      q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", "avatarColor", "avatarUrl", content, "replyTo", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, '#ff00aa', $7, $8, $9, $10)`,
        [`${P}-${id}`, `${P}-ch`, `${P}-srv`, userId, username, displayName, avatarUrl, content, replyTo === null ? null : JSON.stringify(replyTo), Number(id.replace(/\D/g, '')) || 1]);
    await msg('m1', X, 'erase_x', 'Leaving Person', url(X_OLD_AVATAR[0], X_OLD_AVATAR[1]), 'first words');
    await msg('m2', X, 'erase_x', 'Nick In Server', url(X_AVATAR[0], X_AVATAR[1]), 'second words');
    await msg('m3', A, 'erase_a', 'Staying Person', url(A_AVATAR[0], A_AVATAR[1]), 'reply by A',
      { _id: `${P}-m1`, displayName: 'Leaving Person', content: 'first words', contentFormat: 1 });
    await msg('m4', A, 'erase_a', 'Staying Person', url(A_AVATAR[0], A_AVATAR[1]), 'reply to A',
      { _id: `${P}-m3`, displayName: 'Staying Person', content: 'reply by A', contentFormat: 1 });
    await msg('m5', X, 'erase_x', 'Leaving Person', url(SHARED[0], SHARED[1]), 'self reply',
      { _id: `${P}-m2`, displayName: 'Nick In Server', content: 'second words', contentFormat: 1 });

    await q(`INSERT INTO threads (_id, "channelId", "serverId", "createdBy", "createdAt", "lastMessageAt") VALUES ($1, $2, $3, $4, 1, 1)`,
      [`${P}-th`, `${P}-ch`, `${P}-srv`, A]);
    await q(`INSERT INTO thread_messages (_id, "threadId", "channelId", "serverId", "userId", username, "displayName", "avatarColor", content, "createdAt")
             VALUES ($1, $2, $3, $4, $5, 'erase_x', 'Leaving Person', '#ff00aa', 'in thread', 1)`, [`${P}-tm`, `${P}-th`, `${P}-ch`, `${P}-srv`, X]);
    await q(`INSERT INTO dm_messages (_id, "dmId", "userId", "displayName", "avatarColor", content, "createdAt")
             VALUES ($1, $2, $3, 'Leaving Person', '#ff00aa', 'private words', 1)`, [`${P}-dm`, `${P}-dmconv`, X]);
    await q(`INSERT INTO group_dm_conversations (_id, "ownerId", "createdAt", "lastMessageAt") VALUES ($1, $2, 1, 1)`, [`${P}-g`, A]);
    await q(`INSERT INTO group_dm_messages (_id, "groupId", "userId", "displayName", "avatarColor", content, "createdAt")
             VALUES ($1, $2, $3, 'Leaving Person', '#ff00aa', 'group words', 1)`, [`${P}-gm`, `${P}-g`, X]);
    await q(`INSERT INTO voice_messages (_id, "channelId", "serverId", "userId", "displayName", url, "createdAt")
             VALUES ($1, $2, $3, $4, 'Leaving Person', '/uploads/voice/v.webm', 1)`, [`${P}-vm`, `${P}-ch`, `${P}-srv`, X]);
    await q(`INSERT INTO notifications (_id, "userId", "actorId", type, "createdAt") VALUES ($1, $2, $3, 'mention', 1)`, [`${P}-n-to-x`, X, A]);
    await q(`INSERT INTO notifications (_id, "userId", "actorId", type, "createdAt") VALUES ($1, $2, $3, 'mention', 1)`, [`${P}-n-by-x`, A, X]);

    const app = express();
    app.use(express.json());
    app.use('/api/account', accountRouter);
    response = await request(app).delete('/api/account').send({ confirm: 'DELETE', password: PASSWORD });
  });

  afterAll(async () => {
    await cleanup();
    fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  });

  const row = async (table: string, id: string) => (await q(`SELECT * FROM ${table} WHERE _id = $1`, [`${P}-${id}`]))[0];

  it('silme başarılı ve kişinin kimlik satırı yok', async () => {
    expect(response.status).toBe(200);
    expect(await q(`SELECT 1 FROM users WHERE _id = $1`, [X])).toHaveLength(0);
  });

  it('kişinin kanal mesajları: içerik KALIR, ad/avatar/renk GİDER', async () => {
    for (const [id, content] of [['m1', 'first words'], ['m2', 'second words'], ['m5', 'self reply']]) {
      const m = await row('messages', id);
      expect({ id, userId: m.userId, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl, avatarColor: m.avatarColor, content: m.content })
        .toEqual({ id, userId: TOMBSTONE_USER_ID, username: '', displayName: '', avatarUrl: null, avatarColor: TOMBSTONE_AVATAR_COLOR, content });
    }
  });

  it('BAŞKASININ yanıtındaki alıntı başlığından kişinin adı silinir, alıntı bağlamı kalır', async () => {
    const m3 = await row('messages', 'm3');
    expect(m3.replyTo).toEqual({ _id: `${P}-m1`, content: 'first words', contentFormat: 1 });
    // Kişinin KENDİ mesajına yanıtı da (aynı satır iki adımda güncellenir).
    expect((await row('messages', 'm5')).replyTo).toEqual({ _id: `${P}-m2`, content: 'second words', contentFormat: 1 });
  });

  it('KONTROL: kalan üyenin mesajı ve kalan üyeye verilen yanıtın başlığı DOKUNULMADAN kalır', async () => {
    const m3 = await row('messages', 'm3');
    expect({ userId: m3.userId, username: m3.username, displayName: m3.displayName, avatarUrl: m3.avatarUrl, avatarColor: m3.avatarColor })
      .toEqual({ userId: A, username: 'erase_a', displayName: 'Staying Person', avatarUrl: url(A_AVATAR[0], A_AVATAR[1]), avatarColor: '#ff00aa' });
    expect((await row('messages', 'm4')).replyTo).toEqual({ _id: `${P}-m3`, displayName: 'Staying Person', content: 'reply by A', contentFormat: 1 });
  });

  it('konu, DM, grup DM ve sesli mesaj anlık görüntüleri de boşaltılır', async () => {
    const tm = await row('thread_messages', 'tm');
    expect({ u: tm.userId, n: tm.username, d: tm.displayName, c: tm.avatarColor, body: tm.content })
      .toEqual({ u: TOMBSTONE_USER_ID, n: '', d: '', c: TOMBSTONE_AVATAR_COLOR, body: 'in thread' });
    for (const [t, id, body] of [['dm_messages', 'dm', 'private words'], ['group_dm_messages', 'gm', 'group words']]) {
      const r = await row(t, id);
      expect({ t, u: r.userId, d: r.displayName, c: r.avatarColor, body: r.content })
        .toEqual({ t, u: TOMBSTONE_USER_ID, d: '', c: TOMBSTONE_AVATAR_COLOR, body });
    }
    const vm = await row('voice_messages', 'vm');
    expect({ u: vm.userId, d: vm.displayName }).toEqual({ u: TOMBSTONE_USER_ID, d: '' });
  });

  it('kişiye GELEN bildirim silinir; kişinin tetiklediği bildirim alıcıda kalır, bağ kopar', async () => {
    expect(await row('notifications', 'n-to-x')).toBeUndefined();
    const byX = await row('notifications', 'n-by-x');
    expect({ userId: byX.userId, actorId: byX.actorId }).toEqual({ userId: A, actorId: TOMBSTONE_USER_ID });
  });

  it('profil görselleri (eski/güncel avatar, afiş, sunucu profili) diskten silinir', () => {
    for (const [sub, name] of [X_OLD_AVATAR, X_AVATAR, X_BANNER, X_MP_AVATAR, X_MP_BANNER]) {
      expect({ file: name, exists: fs.existsSync(file(sub, name)) }).toEqual({ file: name, exists: false });
    }
    expect(response.body.profileAssets).toEqual({ removed: 5, alreadyAbsent: 0, stillReferenced: 1, failed: 0 });
  });

  it('KONTROL: başka bir kaydın hâlâ başvurduğu görsel ve kalan üyenin avatarı SİLİNMEZ', () => {
    expect(fs.existsSync(file(SHARED[0], SHARED[1]))).toBe(true);
    expect(fs.existsSync(file(A_AVATAR[0], A_AVATAR[1]))).toBe(true);
  });

  it('CANLI ŞEMA: kimliği ANONİMLEŞTİRİLEN her tablonun yazar ad/avatar sütunu silme politikasında', async () => {
    // Yeni bir sohbet tablosu yazarın adını/avatarını kopyalayıp buraya yazılmazsa, hesap
    // silindikten sonra o tabloda kişi görünür kalır. Canlı (tüm migrasyonları görmüş) şemadan okunur.
    const anonymizedByUserId = new Set(LIFECYCLE.filter(r => r.disposition === 'ANONYMIZE' && r.columns.includes('userId')).map(r => r.table));
    const cols = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = ANY($1)`, [SNAPSHOT_COLUMN_NAMES]);
    const uncovered = cols
      .filter((c: { table_name: string; column_name: string }) => anonymizedByUserId.has(c.table_name))
      .filter((c: { table_name: string; column_name: string }) => !(c.column_name in (AUTHOR_SNAPSHOTS[c.table_name] ?? {})))
      .map((c: { table_name: string; column_name: string }) => `${c.table_name}.${c.column_name}`)
      .sort();
    expect(anonymizedByUserId.size).toBeGreaterThan(4);
    expect(uncovered).toEqual([]);
  });
});
