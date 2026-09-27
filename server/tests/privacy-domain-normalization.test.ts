// server/tests/privacy-domain-normalization.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ALAN DIŞI GİZLİLİK DEĞERLERİ — FAIL-OPEN GERİLEME TESTİ
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN KUSUR (canlı PostgreSQL üzerinde doğrulandı):
//
//   TAZE KURULUM ve TAM DAĞITIM sonrası `users` tablosunda CHECK kısıtı YOKTU.
//   `INSERT "dmPrivacy"='nobody'`          -> KABUL EDİLDİ
//   `INSERT "presenceVisibility"='Hidden'` -> KABUL EDİLDİ
//
// `migrations_pg/017` ve `026` kısıtı tanımlıyordu, ama sütunları
// `db/postgres/schema.ts` daha önce oluşturduğu için `ADD COLUMN IF NOT EXISTS`
// dalı hiç çalışmıyordu. Her iki migration da "uygulandı" sayılıyordu.
//
// ── ASIL ÜRÜN ETKİSİ: SESSİZ FAIL-OPEN ──────────────────────────────────────
// DM kontrolleri ham dizgeyi kullanıyordu:
//
//     if (p && p !== 'everyone') {
//       if (p === 'none')    deny;
//       if (p === 'friends') requireFriendship;
//     }
//     // baska HERHANGI bir deger -> hicbir dala girmez -> IZIN VERILIR
//
// Yani `'None'`, `'nobody'`, `'NONE'` gibi bir değer kullanıcının koyduğu
// gizlilik kısıtını FARK EDİLMEDEN kaldırıyordu. Aynı sınıf
// `presenceVisibility !== 'hidden'` karşılaştırmasında da vardı: `'Hidden'`
// değeri kullanıcının varlığını SIZDIRIYORDU.
//
// Bu dosya iki katmanı da kilitler: normalleştiricinin kendisi ve onu kullanan
// REST DM yolu. Veritabanı katmanı ayrıca
// `tests/pg-integration/privacy-constraints.pgtest.ts` ile kanıtlanır.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

jest.mock('../middleware/rateLimit', () => ({
  limits: { dm: () => (_q: unknown, _s: unknown, n: () => void) => n() },
}));

const store = {
  users: new Map<string, Record<string, unknown>>(),
  convs: new Map<string, unknown>(),
  friendships: [] as Array<{ a: string; b: string; status: string }>,
};

jest.mock('../db/repositories', () => ({
  Users: {
    findById:  async (id: string) => store.users.get(id) ?? null,
    findByIds: async (ids: string[]) => ids.map(i => store.users.get(i)).filter(Boolean),
  },
  Dms: {
    findConversationsByUser: async () => [],
    findConversationByParticipants: async (a: string, b: string) =>
      store.convs.get([a, b].sort().join(':')) ?? null,
    findOrCreateConversation: async (a: string, b: string) => {
      const dmId = [a, b].sort().join(':');
      const conv = { _id: dmId, participants: [a, b] };
      store.convs.set(dmId, conv);
      return { conv, dmId };
    },
    findMessages: async () => [],
    countUnread:  async () => 0,
  },
  Social: {
    findBlock: async () => null,
    findFriendship: async (a: string, b: string) =>
      store.friendships.find(f => (f.a === a && f.b === b) || (f.a === b && f.b === a)) ?? null,
  },
}));

// Normalleştiriciler GERÇEK kalır — ölçtüğümüz şey tam olarak onlar.
jest.mock('../lib/userUtils', () => ({
  ...jest.requireActual('../lib/userUtils'),
  sanitizeUser: (u: Record<string, unknown>) => ({ _id: u._id }),
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middleware/auth';
import dmRouter from '../routes/dm';
import {
  normalizeDmPrivacy,
  normalizePresenceVisibility,
  sanitizeOwnUser,
  DM_PRIVACY_VALUES,
  PRESENCE_VISIBILITY_VALUES,
} from '../lib/userUtils';

const SENDER = 'user-sender';
const TARGET = 'user-target';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dm', authMiddleware, dmRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });
let app: express.Express;

function setTargetPrivacy(dmPrivacy: unknown): void {
  store.users.set(TARGET, { _id: TARGET, username: 'target', tokenVersion: 0, dmPrivacy });
}

beforeEach(() => {
  store.users.clear(); store.convs.clear(); store.friendships = [];
  store.users.set(SENDER, { _id: SENDER, username: 'sender', tokenVersion: 0, dmPrivacy: 'everyone' });
  setTargetPrivacy('everyone');
  app = buildApp();
});

const openDm = () =>
  request(app).post(`/api/dm/${TARGET}`).set('Authorization', `Bearer ${tok(SENDER)}`);

// ════════════════════════════════════════════════════════════════════════════
describe('normalizeDmPrivacy', () => {
  it.each(DM_PRIVACY_VALUES)('kanonik değer %s korunur', (v) => {
    expect(normalizeDmPrivacy(v)).toBe(v);
  });

  it.each([
    'None', 'NONE', 'nobody', 'Friends', 'FRIENDS', 'contacts', '', ' none',
    'none ', 'everyone;', 'null',
  ])('alan dışı %p erişimi genişletmez; fail-closed none olur', (v) => {
    expect(normalizeDmPrivacy(v)).toBe('none');
  });

  it.each([undefined, null, 0, 1, {}, [], true, NaN])(
    'dizge olmayan %p çökmez ve varsayılana düşer', (v) => {
      expect(normalizeDmPrivacy(v)).toBe('none');
    });
});

describe('normalizePresenceVisibility', () => {
  it.each(PRESENCE_VISIBILITY_VALUES)('kanonik değer %s korunur', (v) => {
    expect(normalizePresenceVisibility(v)).toBe(v);
  });

  it.each(['Hidden', 'HIDDEN', 'hide', 'invisible', '', ' hidden'])(
    'alan dışı %p fail-closed gizli sayılır', (v) => {
      expect(normalizePresenceVisibility(v)).toBe('hidden');
    });

  it.each([undefined, null, 0, {}, [], true, NaN])('dizge olmayan %p fail-closed gizli kalır', (v) => {
    expect(normalizePresenceVisibility(v)).toBe('hidden');
  });
});

describe('sanitizeOwnUser alan dışı değeri sızdırmaz', () => {
  it('depolanan çöp API yanıtına GEÇMEZ', () => {
    // İstemci `dmPrivacy` alanını bir seçim listesine bağlar; bilinmeyen bir
    // değer arayüzü tanımsız bir duruma sokardı.
    const out = sanitizeOwnUser({ _id: 'u1', username: 'u', dmPrivacy: 'nobody', presenceVisibility: 'Hidden' });
    expect(DM_PRIVACY_VALUES).toContain(out.dmPrivacy);
    expect(PRESENCE_VISIBILITY_VALUES).toContain(out.presenceVisibility);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('REST DM — alan dışı dmPrivacy fail-open OLMAZ', () => {
  it('POZİTİF KONTROL: everyone konuşma açılmasına izin verir', async () => {
    setTargetPrivacy('everyone');
    expect((await openDm()).status).toBe(200);
  });

  it('none reddeder', async () => {
    setTargetPrivacy('none');
    expect((await openDm()).status).toBe(403);
  });

  it('friends, arkadaş olmayanı reddeder', async () => {
    setTargetPrivacy('friends');
    expect((await openDm()).status).toBe(403);
  });

  it('friends, karşılıklı arkadaşa izin verir', async () => {
    setTargetPrivacy('friends');
    store.friendships.push({ a: SENDER, b: TARGET, status: 'accepted' });
    expect((await openDm()).status).toBe(200);
  });

  it.each(['None', 'NONE', 'nobody', 'Friends', 'contacts', 'garbage'])(
    'alan dışı %p erişimi genişletmez; yeni DM fail-closed reddedilir', async (bad) => {
      // Eski kod bu değerlerde hiçbir dala girmiyordu ve yeni konuşmayı açıyordu.
      // Kalıcı gizlilik verisi bozuksa runtime yorumu EN DAR kanonik değere düşer;
      // DB satırı tahmin edilerek yeniden yazılmaz.
      setTargetPrivacy(bad);
      expect((await openDm()).status).toBe(403);
    });

  it('alan dışı değer meşru bir kısıt seçimini tahmin etmez; güvenli none uygular', async () => {
    setTargetPrivacy('nonsense');
    const r = await openDm();
    expect(r.status).toBe(403);
    expect(r.body?.error).toContain('DM almıyor');
  });

  it('dmPrivacy alanı HİÇ YOKSA fail-closed davranır', async () => {
    store.users.set(TARGET, { _id: TARGET, username: 'target', tokenVersion: 0 });
    expect((await openDm()).status).toBe(403);
  });
});
