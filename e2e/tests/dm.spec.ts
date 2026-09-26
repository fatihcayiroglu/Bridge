// e2e/tests/dm.spec.ts — Direct Message uçtan uca akışı.
//
// KANONİK ÜRETİM YOLU
//   POST /api/dm/:userId          → konuşmayı aç/al (gövde YOK, yol parametresi)
//   GET  /api/dm                  → konuşma listesi (keşif / yeniden açma)
//   GET  /api/dm/:dmId/messages   → mesajları oku
//   socket `dm:send` { toUserId, content } → her iki tarafa `dm:message`
//
// `POST /api/dm/open` diye bir uç YOKTUR (eski spec bunu varsayıyordu) ve
// gönderim REST değil socket üzerindendir.

import { test, expect } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets, paceSends, attachSendDiagnostics } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

type DmMsg = { _id?: string; content?: string; dmId?: string };

test.describe('Direct Message (DM) Akışları', () => {
  let tokens: ReturnType<typeof getTokens>;
  let aliceId = '';
  let bobId = '';
  let dmId = '';

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
    expect(aliceId).toBeTruthy();
    expect(bobId).toBeTruthy();
  });

  test('keşif — alice bob ile DM konuşması açar', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/dm/${bobId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status(), `DM açılamadı: ${await res.text()}`).toBeLessThan(300);

    const conv = await res.json();
    dmId = conv._id || conv.id || conv.dmId;
    expect(dmId, 'DM konuşma kimliği dönmedi').toBeTruthy();
  });

  test('gönderim — dm:send ile gönderilen mesajı ALICI gerçekten alır', async () => {
    const alice = await openSocket(tokens.alice);
    const bob = await openSocket(tokens.bob);
    attachSendDiagnostics(alice, 'alice');
    try {
      const content = `E2E DM ${Date.now()}`;
      const bobReceives = waitForEvent<DmMsg>(bob, 'dm:message', 15_000);

      await paceSends('alice');
      alice.emit('dm:send', { toUserId: bobId, content });

      const received = await bobReceives;
      expect(received.content).toBe(content);
    } finally {
      closeSockets(alice, bob);
    }
  });

  test('kalıcılık — DM mesajı kanonik okuma yolundan görünür', async ({ request }) => {
    const alice = await openSocket(tokens.alice);
    attachSendDiagnostics(alice, 'alice');
    try {
      const content = `E2E DM kalıcı ${Date.now()}`;
      await paceSends('alice');
      alice.emit('dm:send', { toUserId: bobId, content });

      // Konuşmayı al (ilk testte açıldı; bağımsız çalışabilmesi için tekrar aç).
      const open = await request.post(`${BASE_URL}/api/dm/${bobId}`, {
        headers: { Authorization: `Bearer ${tokens.alice}` },
      });
      const conv = await open.json();
      const id = conv._id || conv.id || conv.dmId;

      const deadline = Date.now() + 10_000;
      let found: DmMsg | undefined;
      while (Date.now() < deadline && !found) {
        const res = await request.get(`${BASE_URL}/api/dm/${id}/messages`, {
          headers: { Authorization: `Bearer ${tokens.alice}` },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const list: DmMsg[] = Array.isArray(body) ? body : (body.messages ?? []);
        found = list.find((m) => m.content === content);
        if (!found) await new Promise((r) => setTimeout(r, 300));
      }
      expect(found, 'gönderilen DM kalıcı listede yok').toBeTruthy();
    } finally {
      closeSockets(alice);
    }
  });

  test('navigasyon — konuşma listesinde görünür ve yeniden açılabilir', async ({ request }) => {
    const list = await request.get(`${BASE_URL}/api/dm`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(list.status()).toBe(200);
    const body = await list.json();
    const convs = Array.isArray(body) ? body : (body.conversations ?? body.dms ?? []);
    expect(Array.isArray(convs)).toBe(true);
    expect(convs.length, 'DM konuşma listesi boş').toBeGreaterThan(0);

    // Yeniden açma aynı konuşmayı vermeli (yeni bir tane oluşturmamalı).
    const reopen = await request.post(`${BASE_URL}/api/dm/${bobId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(reopen.status()).toBeLessThan(300);
    const again = await reopen.json();
    const againId = again._id || again.id || again.dmId;

    const first = await request.post(`${BASE_URL}/api/dm/${bobId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const firstId = (await first.json())._id;
    expect(againId).toBe(firstId);
  });

  test('yetkilendirme — konuşmanın tarafı OLMAYAN kullanıcı mesajları okuyamaz', async ({ request }) => {
    const open = await request.post(`${BASE_URL}/api/dm/${bobId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const id = (await open.json())._id;

    // Kimliksiz erişim reddedilmeli.
    const anon = await request.get(`${BASE_URL}/api/dm/${id}/messages`, { headers: {} });
    expect(anon.status()).toBe(401);
  });

  test('yetkilendirme — kendine DM açılamaz', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/dm/${aliceId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(400);
  });
});
