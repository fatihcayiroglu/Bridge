// e2e/tests/attachments.spec.ts — Ek (attachment) uçtan uca akışı.
//
// KANONİK ÜRETİM YOLU
//   1) POST /api/upload            (multipart, alan adı "file") → { url, fileName, fileType }
//   2) socket `file:send`          { channelId, serverId, fileName, fileUrl, fileType }
//      → kanal odasına `message:new` (type: 'file')
//   3) GET  /api/channels/:cid/messages   → kalıcı mesajda fileUrl/fileName
//   4) GET  /uploads/<dosya>       → uploadAuthz: sahibi/yetkilisi 200,
//                                    kimliksiz 401, yetkisiz 403
//
// Sunucu yetkilendirmesi testi geçirmek için GEVŞETİLMEZ; test yalnızca
// mevcut kanonik davranışı doğrular.

import { test, expect } from '../helpers/apiTest';
// Cerez TASIMAYAN temiz istek baglami icin — kimliksiz erisim testleri.
import { request as playwrightRequest } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, closeSockets, paceSends, attachSendDiagnostics } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

type Msg = {
  _id: string; type?: string; content?: string;
  fileName?: string; fileUrl?: string; fileType?: string;
};

// Geçerli, minik bir PNG (1×1). Gerçek bir görsel — MIME/sniff kontrollerinden geçer.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('Ekler — yükleme, gönderim, görüntüleme, yetkilendirme', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let channelId = '';
  let alice: Socket;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const server = await createTestServer(request, tokens.alice, `Ekler ${Date.now()}`);
    expect(server, 'test sunucusu oluşturulamadı').toBeTruthy();
    serverId = server._id || server.id;

    const channel = await createTestChannel(request, tokens.alice, serverId, 'ekler');
    expect(channel, 'test kanalı oluşturulamadı').toBeTruthy();
    channelId = channel._id || channel.id;

    alice = await openSocket(tokens.alice);
    attachSendDiagnostics(alice, 'alice');
  });

  test.afterAll(() => closeSockets(alice));

  async function readMessages(
    request: import('@playwright/test').APIRequestContext,
  ): Promise<Msg[]> {
    const res = await request.get(`${BASE_URL}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return Array.isArray(body) ? body : (body.messages ?? []);
  }

  // Tam sınır çalışmasında (300+ test) sunucu yükü altında kalıcılık
  // görünürlüğü gecikebiliyor; bekleme penceresi buna göre genişletildi.
  async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await fn();
      if (v) return v as T;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Koşul zaman aşımına uğradı');
  }

  /** Kanonik multipart yükleme. */
  async function uploadPng(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    name = `e2e-ek-${Date.now()}.png`,
  ) {
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name, mimeType: 'image/png', buffer: TINY_PNG },
      },
    });
    return res;
  }

  test('yükleme — gerçek PNG kabul edilir ve kalıcı bir URL döner', async ({ request }) => {
    const res = await uploadPng(request, tokens.alice);
    expect(res.status(), `yükleme reddedildi: ${await res.text()}`).toBe(200);

    const body = await res.json() as { url?: string; fileName?: string; fileType?: string };
    expect(body.url, 'yükleme url döndürmedi').toBeTruthy();
    expect(body.fileType).toContain('image');
  });

  test('uçtan uca — yüklenen ek file:send ile gönderilir ve mesajda görünür', async ({ request }) => {
    const up = await uploadPng(request, tokens.alice);
    expect(up.status()).toBe(200);
    const { url, fileName, fileType } = await up.json() as
      { url: string; fileName: string; fileType: string };

    await paceSends('alice');
    alice.emit('file:send', { channelId, serverId, fileName, fileUrl: url, fileType });

    // Kalıcı mesaj kanonik okuma yolundan doğrulanır.
    const msg = await waitFor(async () =>
      (await readMessages(request)).find((m) => m.type === 'file' && m.fileUrl === url));
    expect(msg.fileName).toBe(fileName);
    expect(msg.fileType).toBe(fileType);

    // Yetkili sahibi eki GERÇEKTEN indirebilmeli.
    const fetched = await request.get(`${BASE_URL}${url}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(fetched.status(), 'sahibi kendi ekini indiremedi').toBe(200);
    expect((await fetched.body()).length).toBeGreaterThan(0);
  });

  test('yetkilendirme — kimliksiz istek özel eke erişemez', async ({ request }) => {
    const up = await uploadPng(request, tokens.alice);
    expect(up.status()).toBe(200);
    const { url, fileName, fileType } = await up.json() as
      { url: string; fileName: string; fileType: string };

    await paceSends('alice');
    alice.emit('file:send', { channelId, serverId, fileName, fileUrl: url, fileType });
    await waitFor(async () =>
      (await readMessages(request)).find((m) => m.fileUrl === url));

    // ════════════════════════════════════════════════════════════════════
    // GERÇEKTEN KİMLİKSİZ İSTEK — `headers: {}` YETMEZ
    // ════════════════════════════════════════════════════════════════════
    // Bu test önce `request.get(url, { headers: {} })` kullanıyordu ve
    // 200 alıp DÜŞÜYORDU. Sebep bir ürün açığı DEĞİLDİ: paylaşılan
    // `request` fixture'ı `storageState` taşır ve orada httpOnly refresh
    // ÇEREZİ vardır. `headers: {}` yalnızca BAŞLIKLARI temizler, ÇEREZİ
    // DEĞİL — yani "kimliksiz" istek aslında kimlik doğrulanmış istekti.
    //
    // Bu, düşen bir testten DAHA KÖTÜDÜR: iddia ettiği güvenlik kontrolünü
    // hiç yapmayan bir testti (yanlış negatif). Doğrudan ölçüm:
    //   çerezsiz + başlıksız GET /uploads/<dosya>  →  401
    // Ürün DOĞRU davranıyor; test yanlış kurulmuştu.
    //
    // ÖLÇÜM (aynı dosya, üç yol):
    //   paylaşılan fixture  (çerezli)          → 200   ← YANLIŞ NEGATİF
    //   newContext()        (çerez DEVRALIR)   → 200
    //   newContext({ storageState: BOŞ })      → 401   ← GERÇEK sonuç
    //   düz Node fetch      (çerezsiz)         → 401
    //
    // `newContext()` tek başına YETMEZ: yapılandırmadaki storageState'i
    // devralır ve `bridge_media` (imzalı medya erişim çerezi) ile
    // `bridge_refresh` taşır. Çerez listesi AÇIKÇA boşaltılmalıdır.
    const anonCtx = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const anon = await anonCtx.get(url);
      expect([401, 403], `kimliksiz erişim ${anon.status()} döndü`).toContain(anon.status());
    } finally {
      await anonCtx.dispose();
    }
  });

  test('yetkilendirme — üye olmayan kullanıcı ekin TAM URL’sine erişemez', async ({ request }) => {
    const up = await uploadPng(request, tokens.alice);
    expect(up.status()).toBe(200);
    const { url, fileName, fileType } = await up.json() as
      { url: string; fileName: string; fileType: string };

    await paceSends('alice');
    alice.emit('file:send', { channelId, serverId, fileName, fileUrl: url, fileType });
    await waitFor(async () =>
      (await readMessages(request)).find((m) => m.fileUrl === url));

    // bob bu sunucunun üyesi DEĞİL — tam URL'yi bilse bile reddedilmeli.
    const foreign = await request.get(`${BASE_URL}${url}`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect(foreign.status(), 'üye olmayan kullanıcı eki indirebildi').toBe(403);
  });

  test('reddetme — çalıştırılabilir dosya yüklemesi kabul edilmez', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: `zararli-${Date.now()}.exe`,
          mimeType: 'application/x-msdownload',
          buffer: Buffer.from('MZ\x90\x00\x03bu bir exe taklidi'),
        },
      },
    });
    expect(res.status(), 'exe yüklemesi kabul edildi').toBeGreaterThanOrEqual(400);
  });

  test('sahtecilik — kayıtlı olmayan bir fileUrl ile file:send mesaj oluşturmaz', async ({ request }) => {
    const before = (await readMessages(request)).length;

    await paceSends('alice');
    alice.emit('file:send', {
      channelId, serverId,
      fileName: 'uydurma.png',
      fileUrl: '/uploads/bu-dosya-hic-yuklenmedi-e2e.png',
      fileType: 'image/png',
    });
    await new Promise((r) => setTimeout(r, 1_500));

    const after = await readMessages(request);
    expect(after.some((m) => m.fileUrl === '/uploads/bu-dosya-hic-yuklenmedi-e2e.png'),
      'kayıtsız dosya başvurusu mesaj oluşturdu').toBe(false);
    expect(after.length).toBe(before);
  });
});
