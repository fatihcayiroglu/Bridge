// server/tests/pg-integration/admin-account-deletion.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL: YÖNETİCİ SİLMESİ KANONİK HESAP POLİTİKASINI UYGULAR (Final21 Faz 19)
// ════════════════════════════════════════════════════════════════════════════
// `DELETE /api/admin/users/:id` politikayı HİÇ uygulamıyordu: yalnızca kanal mesajlarını ve
// üyelikleri silip `users` satırını kaldırıyordu (işlemsiz). WebAuthn/push kayıtları,
// arkadaşlıklar, DM'lerdeki ad/avatar ve profil görselleri kalıyor; kişinin başka üyeleri
// olan sunucusu SAHİPSİZ kalıyordu. Gerçek yönetici yönlendiricisi gerçek veritabanına
// karşı çalışır; kimlik, yönetici denetimi, hız sınırı ve denetim kaydı ikizlenir.

import fs from 'fs';
import os from 'os';
import path from 'path';

const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-admin-del-'));
process.env.BRIDGE_UPLOAD_ROOT = UPLOAD_ROOT;

// Silme, tek düğümlü tokenVersion önbelleğini düşürür (P3); sahte modül aynı
// dışa aktarımı sunmazsa rota silmeden SONRA TypeError ile 500 döner.
const mockInvalidateTokenCache = jest.fn();
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'pgt-adm-admin' }; next(); },
  _invalidateTokenCache: (id: string) => mockInvalidateTokenCache(id),
}));
jest.mock('../../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../../routes/admin/middleware', () => ({
  adminOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
  logAction: jest.fn(async () => undefined),
}));
jest.mock('../../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn(async () => undefined) }));

import express from 'express';
import request from 'supertest';
import { TOMBSTONE_USER_ID } from '../../lib/accountLifecycle';

const db = require('../../db/loader').default;
const { usersRouter } = require('../../routes/admin/users');

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-adm';
const ADMIN = `${P}-admin`;
const SPAMMER = `${P}-spammer`;
const OWNER = `${P}-owner`;
const OTHER = `${P}-other`;

RUN('gerçek PostgreSQL — yönetici kullanıcı silmesi', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const app = () => { const a = express(); a.use(express.json()); a.use('/api/admin', usersRouter); return a; };
  const cleanup = async () => {
    const like = `${P}-%`;
    for (const t of ['messages', 'dm_messages', 'webauthn_credentials', 'push_subscriptions', 'friendships', 'channels']) {
      await q(`DELETE FROM ${t} WHERE _id LIKE $1`, [like]);
    }
    await q(`DELETE FROM members WHERE "serverId" LIKE $1`, [like]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [like]);
  };

  beforeAll(async () => {
    await cleanup();
    for (const id of [ADMIN, SPAMMER, OWNER, OTHER]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [id]);
    }
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', $2, 1)`, [`${P}-srv`, OTHER]);
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'c', 1)`, [`${P}-ch`, `${P}-srv`]);
    fs.mkdirSync(path.join(UPLOAD_ROOT, 'member-profiles'), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_ROOT, 'member-profiles', `mp_av_${P}.webp`), 'x');
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt", "serverProfile") VALUES ($1, $2, '[]', 1, $3)`,
      [SPAMMER, `${P}-srv`, JSON.stringify({ avatarUrl: `/uploads/member-profiles/mp_av_${P}.webp` })]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [OTHER, `${P}-srv`]);
    await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
             VALUES ($1, $2, $3, $4, 'spammer', 'Spam Person', 'buy now', 1)`, [`${P}-m1`, `${P}-ch`, `${P}-srv`, SPAMMER]);
    await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
             VALUES ($1, $2, $3, $4, 'other', 'Other', 'hello', 2)`, [`${P}-m2`, `${P}-ch`, `${P}-srv`, OTHER]);
    await q(`INSERT INTO dm_messages (_id, "dmId", "userId", "displayName", content, "createdAt") VALUES ($1, 'dm', $2, 'Spam Person', 'dm text', 1)`, [`${P}-dm`, SPAMMER]);
    await q(`INSERT INTO webauthn_credentials (_id, "userId", "credentialId", "publicKey", "createdAt") VALUES ($1, $2, 'cred', 'pk', 1)`, [`${P}-wa`, SPAMMER]);
    await q(`INSERT INTO push_subscriptions (_id, "userId", endpoint, "createdAt") VALUES ($1, $2, 'https://push.example/x', 1)`, [`${P}-push`, SPAMMER]);
    await q(`INSERT INTO friendships (_id, "userId", "friendId", "createdAt") VALUES ($1, $2, $3, 1)`, [`${P}-fr`, OTHER, SPAMMER]);

    // Başka üyeleri olan bir sunucunun sahibi.
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'Owned', $2, 1)`, [`${P}-owned`, OWNER]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1), ($3, $2, '[]', 1)`, [OWNER, `${P}-owned`, OTHER]);
  });
  afterAll(async () => {
    await cleanup();
    fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  });

  it('başka üyeleri olan sunucunun sahibi SİLİNMEZ: 409 ve hiçbir satır değişmez', async () => {
    const res = await request(app()).delete(`/api/admin/users/${OWNER}`);
    expect(res.status).toBe(409);
    expect(res.body.blockers).toEqual([expect.objectContaining({ kind: 'server', id: `${P}-owned`, memberCount: 2 })]);
    expect(await q(`SELECT 1 FROM users WHERE _id=$1`, [OWNER])).toHaveLength(1);
    expect((await q(`SELECT "ownerId" FROM servers WHERE _id=$1`, [`${P}-owned`]))[0].ownerId).toBe(OWNER);
  });

  it('silme politikanın TAMAMINI uygular', async () => {
    const res = await request(app()).delete(`/api/admin/users/${SPAMMER}`);
    expect(res.status).toBe(200);
    expect(await q(`SELECT 1 FROM users WHERE _id=$1`, [SPAMMER])).toHaveLength(0);
    // Silinen hesabın erişim jetonu önbellekten doğrulanmaya devam etmez.
    expect(mockInvalidateTokenCache).toHaveBeenCalledWith(SPAMMER);
    // Moderasyon niyeti (önceki davranış): kişinin KANAL mesajları silinir; başkasınınki kalır.
    expect(await q(`SELECT 1 FROM messages WHERE _id=$1`, [`${P}-m1`])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM messages WHERE _id=$1`, [`${P}-m2`])).toHaveLength(1);
    // Önceden KALANLAR: sırlar, sosyal graf, DM'deki ad, üyelik, profil görseli.
    expect(await q(`SELECT 1 FROM webauthn_credentials WHERE _id=$1`, [`${P}-wa`])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM push_subscriptions WHERE _id=$1`, [`${P}-push`])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM friendships WHERE _id=$1`, [`${P}-fr`])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM members WHERE "userId"=$1`, [SPAMMER])).toHaveLength(0);
    const dm = (await q(`SELECT "userId", "displayName", content FROM dm_messages WHERE _id=$1`, [`${P}-dm`]))[0];
    expect(dm).toEqual({ userId: TOMBSTONE_USER_ID, displayName: '', content: 'dm text' });
    expect(fs.existsSync(path.join(UPLOAD_ROOT, 'member-profiles', `mp_av_${P}.webp`))).toBe(false);
  });
});
