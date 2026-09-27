// e2e/tests/gdm.spec.ts — Group DM (GDM) uçtan uca akışı.
//
// KANONİK ÜRETİM YOLU
//   POST /api/gdm                 { name, memberIds[] } → atomik grup oluşturma
//   GET  /api/gdm                 → kullanıcının grupları
//   GET  /api/gdm/:gid            → grup detayı (yalnız üye)
//   GET  /api/gdm/:gid/messages   → mesajlar (yalnız üye)
//   socket `gdm:join` <groupId>   → `gdm:<id>` odasına katıl
//   socket `gdm:send` { groupId, content } → odaya `gdm:message`
//
// Üyelik sınırı testi geçirmek için GEVŞETİLMEZ: carol hiçbir gruba
// eklenmeyen üçüncü kimliktir ve reddedilmesi beklenir.

import { test, expect } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets, paceSends, attachSendDiagnostics } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

type GdmMsg = { _id?: string; content?: string; groupId?: string };

test.describe('Group DM (GDM) Akışları', () => {
  let tokens: ReturnType<typeof getTokens>;
  let aliceId = '';
  let bobId = '';
  let groupId = '';

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    const me = async (token: string) => {
      const res = await request.get(`${BASE_URL}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status()).toBe(200);
      const u = await res.json();
      return u._id || u.id;
    };
    aliceId = await me(tokens.alice);
    bobId = await me(tokens.bob);

    const res = await request.post(`${BASE_URL}/api/gdm`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `E2E Grup ${Date.now()}`, memberIds: [bobId] }),
    });
    expect(res.status(), `GDM oluşturulamadı: ${await res.text()}`).toBeLessThan(300);
    const group = await res.json();
    groupId = group._id || group.id;
    expect(groupId, 'grup kimliği dönmedi').toBeTruthy();
  });

  test('oluşturma — grup her iki üyenin listesinde görünür', async ({ request }) => {
    for (const [label, token] of [['alice', tokens.alice], ['bob', tokens.bob]] as const) {
      const res = await request.get(`${BASE_URL}/api/gdm`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      const groups = Array.isArray(body) ? body : (body.groups ?? []);
      expect(groups.some((g: { _id?: string; id?: string }) => (g._id || g.id) === groupId),
        `${label} grubu listesinde görmüyor`).toBe(true);
    }
  });

  test('erişim — üyeler grup detayına ve mesajlarına erişebilir', async ({ request }) => {
    for (const token of [tokens.alice, tokens.bob]) {
      const detail = await request.get(`${BASE_URL}/api/gdm/${groupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(detail.status()).toBe(200);

      const msgs = await request.get(`${BASE_URL}/api/gdm/${groupId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(msgs.status()).toBe(200);
    }
  });

  test('gönderim — gdm:send mesajı DİĞER ÜYEYE ulaşır', async () => {
    const alice = await openSocket(tokens.alice);
    const bob = await openSocket(tokens.bob);
    attachSendDiagnostics(alice, 'alice');
    try {
      // Her iki taraf da grup odasına katılır.
      alice.emit('gdm:join', groupId);
      bob.emit('gdm:join', groupId);
      await new Promise((r) => setTimeout(r, 800));

      const content = `E2E GDM ${Date.now()}`;
      const bobReceives = waitForEvent<GdmMsg>(bob, 'gdm:message', 15_000);

      await paceSends('alice');
      alice.emit('gdm:send', { groupId, content });

      const received = await bobReceives;
      expect(received.content).toBe(content);
    } finally {
      closeSockets(alice, bob);
    }
  });

  test('kalıcılık — gönderilen GDM mesajı okuma yolundan görünür', async ({ request }) => {
    const alice = await openSocket(tokens.alice);
    attachSendDiagnostics(alice, 'alice');
    try {
      alice.emit('gdm:join', groupId);
      await new Promise((r) => setTimeout(r, 500));

      const content = `E2E GDM kalıcı ${Date.now()}`;
      await paceSends('alice');
      alice.emit('gdm:send', { groupId, content });

      const deadline = Date.now() + 10_000;
      let found: GdmMsg | undefined;
      while (Date.now() < deadline && !found) {
        const res = await request.get(`${BASE_URL}/api/gdm/${groupId}/messages`, {
          headers: { Authorization: `Bearer ${tokens.alice}` },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const list: GdmMsg[] = Array.isArray(body) ? body : (body.messages ?? []);
        found = list.find((m) => m.content === content);
        if (!found) await new Promise((r) => setTimeout(r, 300));
      }
      expect(found, 'gönderilen GDM mesajı kalıcı listede yok').toBeTruthy();
    } finally {
      closeSockets(alice);
    }
  });

  test('yetkilendirme — ÜYE OLMAYAN kullanıcı gruba REST ile erişemez', async ({ request }) => {
    const detail = await request.get(`${BASE_URL}/api/gdm/${groupId}`, {
      headers: { Authorization: `Bearer ${tokens.carol}` },
    });
    expect([403, 404], `carol grup detayını ${detail.status()} ile aldı`).toContain(detail.status());

    const msgs = await request.get(`${BASE_URL}/api/gdm/${groupId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.carol}` },
    });
    expect([403, 404], `carol grup mesajlarını ${msgs.status()} ile aldı`).toContain(msgs.status());
  });

  test('yetkilendirme — ÜYE OLMAYAN kullanıcı gdm:join ile yayına giremez', async () => {
    const alice = await openSocket(tokens.alice);
    const carol = await openSocket(tokens.carol);
    try {
      carol.emit('gdm:join', groupId);
      await new Promise((r) => setTimeout(r, 1_000));

      let leaked = false;
      carol.on('gdm:message', () => { leaked = true; });

      alice.emit('gdm:join', groupId);
      await new Promise((r) => setTimeout(r, 500));
      await paceSends('alice');
      alice.emit('gdm:send', { groupId, content: `E2E GDM sızıntı ${Date.now()}` });
      await new Promise((r) => setTimeout(r, 1_500));

      expect(leaked, 'üye olmayan oturuma GDM mesajı sızdı').toBe(false);
    } finally {
      closeSockets(alice, carol);
    }
  });

  test('yetkilendirme — ÜYE OLMAYAN kullanıcı gdm:send ile mesaj yazamaz', async ({ request }) => {
    const carol = await openSocket(tokens.carol);
    try {
      const content = `E2E GDM yetkisiz yazma ${Date.now()}`;
      carol.emit('gdm:join', groupId);
      await new Promise((r) => setTimeout(r, 500));
      carol.emit('gdm:send', { groupId, content });
      await new Promise((r) => setTimeout(r, 1_500));

      const res = await request.get(`${BASE_URL}/api/gdm/${groupId}/messages`, {
        headers: { Authorization: `Bearer ${tokens.alice}` },
      });
      const body = await res.json();
      const list: GdmMsg[] = Array.isArray(body) ? body : (body.messages ?? []);
      expect(list.some((m) => m.content === content),
        'üye olmayan kullanıcı gruba mesaj yazabildi').toBe(false);
    } finally {
      closeSockets(carol);
    }
  });
});
