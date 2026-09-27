// e2e/tests/permission-matrix-actions.spec.ts
//
// İZİN MATRİSİ — İÇERİK EYLEMLERİ (mesaj, yükleme, ses, davet, ban)
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI DOSYA
// ════════════════════════════════════════════════════════════════════════════
// `permission-matrix.spec.ts` YÖNETİM yüzeylerini sürer (rol, kanal, sunucu,
// denetim günlüğü). Bu dosya GÜNLÜK EYLEMLERİ sürer: mesaj gönderme/düzenleme/
// silme, dosya yükleme, sesli kanala katılma, davet üretme ve BANLANMIŞ
// kullanıcının durumu.
//
// Bridge'de mesaj YAZMA yolu REST değil Socket.IO'dur; bu yüzden mesaj
// iddiaları kanonik `message:send` / `message:edit` / `message:delete`
// olaylarıyla sürülür. Okuma tarafı REST'tir.
//
// HER TESTTE: KANITLAR / KANITLAMAZ ayrımı yazılır.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import { getCsrf } from '../helpers/csrf';
import type { Socket } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

const uid = (t: string): string => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(Buffer.from(b, 'base64').toString('utf8')).id ?? '');
  } catch { return ''; }
};

/** 1x1 PNG — gerçek bir yükleme için yeterli. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('izin matrisi — içerik eylemleri', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let channelId = '';
  let voiceChannelId = '';
  let aliceSock: Socket;
  let bobSock: Socket;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const stamp = Date.now().toString(36);

    const srv = await createTestServer(request, tokens.alice, `Actions ${Date.now()}`);
    serverId = String((srv as { _id?: string })?._id ?? '');
    expect(serverId, 'sunucu oluşturulamadı').toBeTruthy();

    const ch = await createTestChannel(request, tokens.alice, serverId, `act-${stamp}`, 'text');
    channelId = String((ch as { _id?: string })?._id ?? '');
    const vc = await createTestChannel(request, tokens.alice, serverId, `vc-${stamp}`, 'voice');
    voiceChannelId = String((vc as { _id?: string })?._id ?? '');
    expect(channelId && voiceChannelId, 'kanallar oluşturulamadı').toBeTruthy();

    expect(await joinServer(request, tokens.alice, tokens.bob, serverId), 'bob katılamadı').toBe(true);

    aliceSock = await openSocket(tokens.alice);
    bobSock   = await openSocket(tokens.bob);
    aliceSock.emit('channel:join', { channelId, serverId });
    bobSock.emit('channel:join', { channelId, serverId });
  });

  test.afterAll(() => { closeSockets(aliceSock, bobSock); });

  /** Kanonik gönderim; ack gelmezse null döner (engellenmiş demektir). */
  async function trySend(sock: Socket, who: string, content: string): Promise<string | null> {
    await paceSends(who);
    const ackId = `pm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ messageId: string }>(sock, 'message:ack', 6_000)
      .catch(() => null);
    sock.emit('message:send', { channelId, serverId, content, ackId });
    const got = await ack;
    return got?.messageId ?? null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESAJ GÖNDERME
  // ══════════════════════════════════════════════════════════════════════════

  test('ÜYE mesaj gönderebilir — pozitif kontrol', async () => {
    // KANITLAR    : temel yazma yolu üyeler için açık.
    const id = await trySend(bobSock, 'bob', `uye-mesaj-${Date.now().toString(36)}`);
    expect(id, 'üye mesaj gönderemedi').toBeTruthy();
  });

  test('ÜYE OLMAYAN kanala mesaj GÖNDEREMEZ', async () => {
    // KANITLAR    : socket yazma yolu üyelik denetimi yapıyor.
    // KANITLAMAZ  : kanal düzeyi SEND_MESSAGES reddini (ayrı senaryo).
    const carolSock = await openSocket(tokens.carol);
    try {
      carolSock.emit('channel:join', { channelId, serverId });
      await paceSends('carol');
      const ackId = `pm-c-${Date.now()}`;
      const ack = waitForEvent<{ messageId: string }>(carolSock, 'message:ack', 5_000)
        .catch(() => null);
      const needle = `carol-sizinti-${Date.now().toString(36)}`;
      carolSock.emit('message:send', { channelId, serverId, content: needle, ackId });
      const got = await ack;
      expect(got, 'üye olmayan mesaj gönderebildi').toBeNull();
    } finally { closeSockets(carolSock); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MESAJ DÜZENLEME / SİLME — sahiplik
  // ══════════════════════════════════════════════════════════════════════════

  test('ÜYE BAŞKASININ mesajını DÜZENLEYEMEZ', async ({ request }) => {
    // KANITLAR    : düzenleme sahipliğe bağlı; içerik değişmiyor.
    const original = `alice-ozgun-${Date.now().toString(36)}`;
    const msgId = await trySend(aliceSock, 'alice', original);
    expect(msgId, 'fikstür mesajı oluşturulamadı').toBeTruthy();

    await paceSends('bob');
    bobSock.emit('message:edit', { messageId: msgId, channelId, serverId, content: 'ELE-GECIRILDI' });
    await new Promise(r => setTimeout(r, 1_200));

    const res = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const raw = JSON.stringify(await res.json().catch(() => ({})));
    expect(raw, 'başkasının mesajı düzenlenebildi').not.toContain('ELE-GECIRILDI');
    expect(raw, 'özgün içerik kayboldu').toContain(original);
  });

  test('ÜYE BAŞKASININ mesajını SİLEMEZ', async ({ request }) => {
    const needle = `alice-silinmez-${Date.now().toString(36)}`;
    const msgId = await trySend(aliceSock, 'alice', needle);
    expect(msgId).toBeTruthy();

    await paceSends('bob');
    bobSock.emit('message:delete', { messageId: msgId, channelId, serverId });
    await new Promise(r => setTimeout(r, 1_200));

    const res = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const raw = JSON.stringify(await res.json().catch(() => ({})));
    expect(raw, 'başkasının mesajı silinebildi').toContain(needle);
  });

  test('ÜYE KENDİ mesajını silebilir — pozitif kontrol', async ({ request }) => {
    // Bu olmadan yukarıdaki testler "silme hiç çalışmıyor" ile de geçerdi.
    const needle = `bob-kendi-${Date.now().toString(36)}`;
    const msgId = await trySend(bobSock, 'bob', needle);
    expect(msgId).toBeTruthy();

    await paceSends('bob');
    bobSock.emit('message:delete', { messageId: msgId, channelId, serverId });
    await new Promise(r => setTimeout(r, 1_500));

    const res = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    const raw = JSON.stringify(await res.json().catch(() => ({})));
    expect(raw, 'kendi mesajını silemedi').not.toContain(needle);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // YÜKLEME
  // ══════════════════════════════════════════════════════════════════════════

  test('kimliksiz istek DOSYA YÜKLEYEMEZ', async ({ request }) => {
    // KANITLAR    : yükleme ucu kimlik doğrulaması istiyor.
    const res = await request.post(`${BASE}/api/upload`, {
      headers: {},
      multipart: { file: { name: 'x.png', mimeType: 'image/png', buffer: TINY_PNG } },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE dosya yükleyebilir — pozitif kontrol', async ({ request }) => {
    const res = await request.post(`${BASE}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
      multipart: { file: { name: `ok-${Date.now()}.png`, mimeType: 'image/png', buffer: TINY_PNG } },
    });
    expect(res.status()).toBe(200);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DAVET
  // ══════════════════════════════════════════════════════════════════════════

  test('ÜYE OLMAYAN davet ÜRETEMEZ', async ({ request }) => {
    // KANITLAR    : davet üretimi üyelik istiyor.
    // NOT (kusur DEĞİL): Bridge'de ayrı bir CREATE_INVITE izni yoktur; her
    // ÜYE davet üretebilir. Bu Discord'un @everyone varsayılanıyla aynıdır.
    const res = await request.post(`${BASE}/api/servers/invites`, {
      headers: {
        Authorization: `Bearer ${tokens.carol}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.carol),
      },
      data: JSON.stringify({ serverId }),
    });
    expect([401, 403, 404]).toContain(res.status());
  });

  test('davet ucu SORGU OPERATÖRÜ enjeksiyonunu reddeder', async ({ request }) => {
    // KANITLAR    : `serverId` yalnız düz string kabul ediliyor.
    // Kaynak notu, `{ "$ne": "yok" }` yükünün üyelik kontrolünü geçip
    // rastgele bir sunucu adını sızdırdığı bir dönemi belgeliyor.
    const res = await request.post(`${BASE}/api/servers/invites`, {
      headers: {
        Authorization: `Bearer ${tokens.carol}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.carol),
      },
      data: JSON.stringify({ serverId: { $ne: 'yok' } }),
    });
    expect([400, 403]).toContain(res.status());
    const raw = JSON.stringify(await res.json().catch(() => ({})));
    expect(raw, 'sunucu adı sızdı').not.toContain('Actions ');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // BANLANMIŞ KULLANICI
  // ══════════════════════════════════════════════════════════════════════════

  test('BANLANMIŞ kullanıcı sunucuya erişemez', async ({ request }) => {
    // KANITLAR    : ban gerçekten erişimi kesiyor — yalnız bir bayrak değil.
    // KANITLAMAZ  : açık soket oturumlarının anında düşürüldüğünü.
    const banRes = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.alice),
      },
      data: JSON.stringify({ userId: uid(tokens.media1), reason: 'matris testi' }),
    });
    // ════════════════════════════════════════════════════════════════════
    // GERİLEME: BAN TAMAMEN ÇÖKÜYORDU
    // ════════════════════════════════════════════════════════════════════
    // Ölçüldü — çekirdek moderasyon işlevi HER ÇAĞRIDA 500 veriyordu:
    //     sebepsiz ban → Unknown column name: "actorName"   (denetim günlüğü)
    //     sebepli ban  → Unknown column name: "banReason"   (üye kaydı)
    // `members.banReason` ve `audit_logs.actorName/targetId/targetName`
    // kanonik şemada TANIMLI DEĞİLDİ ama kod bunları yazıyordu.
    expect(banRes.status(), 'ban ucu başarısız').toBeLessThan(300);

    // Ban GERÇEKTEN erişimi kesmeli.
    const after = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.media1}` },
    });
    expect([401, 403, 404]).toContain(after.status());
  });

  test('ban SEBEBİ kalıcı olur ve denetim günlüğü AD kaydeder', async ({ request }) => {
    // KANITLAR    : moderasyon geçmişi okunabilir — yalnız kimliklerden ibaret değil.
    // KANITLAMAZ  : günlüğün değiştirilemezliğini (ayrı bir konu).
    const srv = await createTestServer(request, tokens.alice, `BanAudit ${Date.now()}`);
    const sid = String((srv as { _id?: string })?._id ?? '');
    expect(sid).toBeTruthy();

    const headers = {
      Authorization: `Bearer ${tokens.alice}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': await getCsrf(request, tokens.alice),
    };
    const reason = `sebep-${Date.now().toString(36)}`;
    const ban = await request.post(`${BASE}/api/servers/${sid}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.media2), reason }),
    });
    expect(ban.status()).toBeLessThan(300);

    const bans = await request.get(`${BASE}/api/servers/${sid}/bans`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(JSON.stringify(await bans.json().catch(() => [])),
      'ban sebebi kaydedilmedi').toContain(reason);

    const audit = await request.get(`${BASE}/api/servers/${sid}/audit-log`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const raw = JSON.stringify(await audit.json().catch(() => ({})));
    expect(raw, 'denetim günlüğü aktör adını kaydetmedi').toContain('actorName');
    expect(raw, 'ban eylemi günlüğe düşmedi').toContain('"action":"ban"');
  });
});
