// server/tests/pg-integration/message-history-cursor.pgtest.ts
//
// Final21 Faz 19 (19-27) — GERÇEK PostgreSQL'de kanal geçmişinde GERİ SAYFALAMA.
//
// KAPATILAN KUSUR (Final20'de de vardı): `GET /api/channels/:cid/messages` imlecine `createdAt`
// yazıyor, sonraki istekte `Number.isSafeInteger(ts)` ile doğruluyordu. PostgreSQL'de `createdAt`
// BIGINT'tir ve node-pg onu METİN döndürür → imleç `ts: "1790…"` taşıdı ve AYNI uç onu 400
// "Invalid cursor" ile reddetti. İstemci (MessageLoader) eski mesajları `cursor=prevCursor` ile
// yüklediği için PostgreSQL'de ilk 50 mesajın ötesindeki geçmişe HİÇ ulaşılamıyordu. Birim
// testleri bellek-içi depoda (sayı) koştuğu, pg testleri ise depo katmanını sürdüğü için yakalanmadı.
// Bu süit, rotayı GERÇEK veritabanında uçtan uca sürer.

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'pgt-cur-owner' }; next(); },
}));

import express from 'express';
import request from 'supertest';

const db = require('../../db/loader').default;
const messagesRouter = require('../../routes/messages');

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const P = 'pgt-cur';
const OWNER = `${P}-owner`;
const SRV = `${P}-srv`;
const CH = `${P}-ch`;
const N = 7;
const T0 = 1_790_000_000_000;   // gerçekçi (13 hane) epoch-ms: metin olarak gelir

RUN('gerçek PostgreSQL — kanal geçmişi imleci', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const app = () => { const a = express(); a.use(express.json()); a.use('/api/channels', messagesRouter); return a; };
  const cleanup = async () => {
    await q(`DELETE FROM messages WHERE "channelId" = $1`, [CH]);
    await q(`DELETE FROM channel_read_positions WHERE "channelId" = $1`, [CH]).catch(() => undefined);
    await q(`DELETE FROM channels WHERE _id = $1`, [CH]);
    await q(`DELETE FROM members WHERE "serverId" = $1`, [SRV]);
    await q(`DELETE FROM servers WHERE _id = $1`, [SRV]);
    await q(`DELETE FROM users WHERE _id = $1`, [OWNER]);
  };

  beforeAll(async () => {
    await cleanup();
    await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [OWNER]);
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', $2, 1)`, [SRV, OWNER]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [OWNER, SRV]);
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'c', 1)`, [CH, SRV]);
    for (let i = 1; i <= N; i++) {
      await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
               VALUES ($1, $2, $3, $4, 'o', 'O', $5, $6)`, [`${P}-m${i}`, CH, SRV, OWNER, `mesaj ${i}`, T0 + i * 1000]);
    }
  });
  afterAll(cleanup);

  it('prevCursor zinciri TÜM geçmişi, çakışmasız ve eksiksiz, eskiden yeniye sırayla verir', async () => {
    const seen: string[] = [];
    let res = await request(app()).get(`/api/channels/${CH}/messages?limit=3`);
    expect(res.status).toBe(200);
    // Kök düzeltme (db/postgres/pool.ts INT8 ayrıştırıcısı): BIGINT sürücüden ve API'den SAYI gelir.
    expect(typeof (await q(`SELECT "createdAt" FROM messages WHERE _id = $1`, [`${P}-m1`]))[0].createdAt).toBe('number');
    expect(res.body.messages.every((m: { createdAt: unknown }) => typeof m.createdAt === 'number')).toBe(true);
    const decoded = JSON.parse(Buffer.from(res.body.prevCursor, 'base64').toString('utf8'));
    expect(typeof decoded.ts).toBe('number');                        // imleç HER ZAMAN sayısal
    seen.unshift(...res.body.messages.map((m: { _id: string }) => m._id));

    for (let hops = 0; res.body.hasMore && hops < 10; hops++) {
      res = await request(app()).get(`/api/channels/${CH}/messages?limit=3&cursor=${encodeURIComponent(res.body.prevCursor)}`);
      expect(res.status).toBe(200);                                   // KUSUR: burada 400 "Invalid cursor"
      seen.unshift(...res.body.messages.map((m: { _id: string }) => m._id));
    }
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => `${P}-m${i + 1}`));
  });

  it('eski sürümün METİN ts taşıyan imleçleri de kabul edilir; bozuk imleçler 400 kalır', async () => {
    const enc = (o: unknown) => encodeURIComponent(Buffer.from(JSON.stringify(o)).toString('base64'));
    const legacy = await request(app()).get(`/api/channels/${CH}/messages?limit=2&cursor=${enc({ ts: String(T0 + 4000), id: `${P}-m4`, dir: 'before' })}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.messages.map((m: { _id: string }) => m._id)).toEqual([`${P}-m2`, `${P}-m3`]);
    for (const bad of [
      { ts: '12a', id: 'x', dir: 'before' }, { ts: '-5', id: 'x', dir: 'before' }, { ts: '12345678901234567', id: 'x', dir: 'before' },
      { ts: -1, id: 'x', dir: 'before' }, { ts: 1.5, id: 'x', dir: 'before' }, { ts: 1, id: '', dir: 'before' }, { ts: 1, id: 'x', dir: 'sideways' },
    ]) {
      expect({ bad, status: (await request(app()).get(`/api/channels/${CH}/messages?cursor=${enc(bad)}`)).status }).toEqual({ bad, status: 400 });
    }
  });
});
